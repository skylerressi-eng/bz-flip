import { analyzeAll, analyzeCrafts, planFlips, mayorEffects, rank, buildMeta, RANKINGS, DEFAULT_SETTINGS, historyStats } from "./analysis.js";
import { appendSnapshot, mergedSeries, isHistory, trim, EMPTY_HISTORY } from "./history.js";
import * as f from "./format.js";
import { renderPriceChart, sparkline } from "./chart.js";

const API = "https://api.hypixel.net/v2";
const ICON = (id) => `https://sky.coflnet.com/static/icon/${encodeURIComponent(id)}`;
const PAGE = 50;
const SETTINGS_VERSION = 2;
const STALE_MS = 3 * 60e3;
const LS = {
  settings: "bzflip.settings",
  view: "bzflip.view",
  watch: "bzflip.watch",
  meta: "bzflip.meta.v1",
  history: "bzflip.history.v1",
  theme: "bzflip.theme",
};
// order slots per Bazaar Flipper level (the tax rate identifies the level)
const ORDER_SLOTS = { 0.0125: 14, 0.01125: 21, 0.01: 28 };

// ---------- storage (always guarded: private mode / blocked storage) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

const defaultSettings = () => ({ ...DEFAULT_SETTINGS, interval: 60, purse: 50_000_000, planSlots: null, planShare: 0.35, alertPct: null, v: SETTINGS_VERSION });

function loadSettings() {
  const saved = store.get(LS.settings, {});
  const s = { ...defaultSettings(), ...saved };
  if ((saved.v || 1) < SETTINGS_VERSION) s.interval = 60; // v1 defaulted to hourly; live is the new default
  s.v = SETTINGS_VERSION;
  return s;
}

// ---------- state ----------
const state = {
  settings: loadSettings(),
  view: { tab: "best", category: "", hideRisky: true, sort: null, ...store.get(LS.view, {}) },
  watch: new Set(store.get(LS.watch, [])),
  search: "",
  limit: PAGE,
  bazaar: null,
  meta: {},
  recipes: null,
  mayor: mayorEffects(null),
  electionAt: 0,
  serverHistory: null,
  localHistory: store.get(LS.history, null),
  results: [],
  crafts: [],
  byId: new Map(),
  craftById: new Map(),
  plan: null,
  prevPrices: new Map(),
  prevRanks: {},
  lastRanks: {},
  alerted: new Map(),
  badIcons: new Set(),
  fetchedAt: 0,
  nextAt: 0,
  loading: false,
  openId: null,
};
if (!isHistory(state.localHistory)) state.localHistory = EMPTY_HISTORY();

const TABS = [
  { key: "best", label: "Best flips", kind: "flip" },
  { key: "margin", label: "Highest margin", kind: "flip" },
  { key: "volume", label: "Highest volume", kind: "flip" },
  { key: "combo", label: "Margin × volume", kind: "flip" },
  { key: "npc", label: "NPC flips", kind: "npc" },
  { key: "craft", label: "Craft flips", kind: "craft" },
  { key: "watch", label: "★ Watchlist", kind: "flip" },
];
const tabDef = () => TABS.find((t) => t.key === state.view.tab) || TABS[0];
const BLURBS = {
  ...Object.fromEntries(Object.entries(RANKINGS).map(([k, v]) => [k, v.blurb])),
  craft: "Buy the ingredients with buy orders, craft, then sell the result with a sell offer. “Instant” is the profit if you insta-buy and insta-sell everything instead. Green means it's free money right now.",
  watch: "Items you've starred. Click ☆ on any row to add it here, and set a margin alert in settings.",
};

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- data loading ----------
async function getJson(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw err.name === "AbortError" ? new Error("timed out") : err;
  } finally {
    clearTimeout(timer);
  }
}

async function loadMeta() {
  const cached = store.get(LS.meta, null);
  if (cached && Date.now() - cached.at < 24 * 3600e3 && cached.meta) return cached.meta;
  try {
    const items = await getJson(`${API}/resources/skyblock/items`, 30000);
    const meta = buildMeta(items);
    // Only keep bazaar products so localStorage stays small.
    if (state.bazaar) for (const id of Object.keys(meta)) if (!state.bazaar.products[id]) delete meta[id];
    store.set(LS.meta, { at: Date.now(), meta });
    return meta;
  } catch {
    return cached?.meta || {};
  }
}

async function loadOptional(urls) {
  for (const url of urls) {
    try { return await getJson(url, 20000); } catch { /* try the next one */ }
  }
  return null;
}

async function loadElection() {
  try {
    const e = await getJson(`${API}/resources/skyblock/election`, 15000);
    if (e?.success) {
      state.mayor = mayorEffects(e);
      state.electionAt = Date.now();
    }
  } catch { /* keep the previous value */ }
}

// Background data: none of it blocks the first render.
function loadExtras() {
  loadOptional(["data/history.json"]).then((h) => {
    if (isHistory(h)) { state.serverHistory = h; recomputeAndRender(); }
  });
  // Fresh recipes from the hourly job, falling back to the copy shipped in the repo.
  loadOptional(["data/recipes.json", "assets/data/recipes.json"]).then((r) => {
    state.recipes = r?.recipes ? r : { recipes: {}, reqs: {} };
    recomputeAndRender();
  });
}

function seriesFor(id) {
  return mergedSeries([state.serverHistory, state.localHistory].filter(Boolean), id);
}

function recordLocalSnapshot() {
  state.localHistory = appendSnapshot(state.localHistory, state.bazaar, { maxPoints: 72, minFlow: 1 });
  // out of quota: keep the most recent half and try once more
  if (!store.set(LS.history, state.localHistory)) store.set(LS.history, trim(state.localHistory, Math.floor(state.localHistory.t.length / 2)));
}

async function refresh({ manual = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!state.bazaar) setStatus("loading", "Scanning the bazaar…");
  $("#refresh-btn").classList.add("spinning");
  try {
    const first = !state.bazaar;
    const electionDue = Date.now() - state.electionAt > 30 * 60e3;
    const [bz] = await Promise.all([getJson(`${API}/skyblock/bazaar`), electionDue ? loadElection() : null]);
    if (!bz.success) throw new Error(bz.cause || "API error");
    state.prevPrices = new Map(state.results.map((r) => [r.id, { buyAt: r.buyAt, sellAt: r.sellAt }]));
    state.bazaar = bz;
    if (first) {
      state.meta = await loadMeta();
      loadExtras();
    }
    recordLocalSnapshot();
    state.fetchedAt = Date.now();
    state.prevRanks = state.lastRanks;
    compute();
    renderAll();
    if (!first) announceChanges(manual);
    checkAlerts();
    setTimeout(() => state.prevPrices.clear(), 4000); // price flashes are one-shot
    state.nextAt = state.fetchedAt + state.settings.interval * 1000;
    state.loading = false;
    updateStatus();
  } catch (err) {
    setStatus("error", `Couldn't reach the Hypixel API (${err.message}). Retrying in 30s…`);
    if (!state.bazaar) $("#rows").innerHTML = `<tr><td colspan="12"><div class="empty">Couldn't load bazaar data. Check your connection; it'll retry automatically.</div></td></tr>`;
    state.nextAt = Date.now() + 30e3;
  } finally {
    state.loading = false;
    $("#refresh-btn").classList.remove("spinning");
  }
}

function effectiveSettings() {
  return { ...state.settings, tax: state.settings.tax * state.mayor.taxMult };
}

function compute() {
  const s = effectiveSettings();
  state.results = analyzeAll(state.bazaar, s, state.meta, seriesFor);
  for (const r of state.results) r.trend24 = r.history?.askChange24 ?? 0;
  state.byId = new Map(state.results.map((r) => [r.id, r]));
  state.crafts = state.recipes ? analyzeCrafts(state.bazaar, state.recipes, s, state.meta) : [];
  state.craftById = new Map(state.crafts.map((c) => [c.id, c]));
  const ranks = {};
  for (const key of Object.keys(RANKINGS)) {
    const m = new Map();
    rank(state.results, key, s, { hideRisky: state.view.hideRisky }).slice(0, 200).forEach((r, i) => m.set(r.id, i + 1));
    ranks[key] = m;
  }
  const cm = new Map();
  craftRows(state.view.hideRisky).slice(0, 200).forEach((r, i) => cm.set(r.id, i + 1));
  ranks.craft = cm;
  state.lastRanks = ranks;
  state.plan = planFlips(rank(state.results, "best", s), { purse: state.settings.purse, slots: planSlots(), maxShare: state.settings.planShare, capture: s.capture });
}

function recomputeAndRender() {
  if (!state.bazaar) return;
  compute();
  renderAll();
}

function craftRows(hideRisky) {
  return state.crafts.filter((r) => r.margin > 0 && r.marketCraftsHr >= 1 && (!hideRisky || !r.risky)).sort((a, b) => b.adjProfitHr - a.adjProfitHr);
}

function planSlots() {
  return state.settings.planSlots || Math.floor((ORDER_SLOTS[state.settings.tax] || 14) / 2);
}

function announceChanges(manual) {
  const prev = state.prevRanks.best, cur = state.lastRanks.best;
  if (!prev || !cur) return;
  let fresh = 0;
  for (const [id, r] of cur) if (r <= 10 && !(prev.get(id) <= 10)) fresh++;
  if (manual || fresh) toast(fresh ? `Updated: ${fresh} new item${fresh > 1 ? "s" : ""} in the top 10` : "Updated: prices are current");
}

function checkAlerts() {
  const pct = state.settings.alertPct;
  if (!(pct > 0)) return;
  for (const id of state.watch) {
    const r = state.byId.get(id);
    if (!r || r.marginPct * 100 < pct || r.flowHr < 1) continue;
    if (Date.now() - (state.alerted.get(id) || 0) < 30 * 60e3) continue;
    state.alerted.set(id, Date.now());
    const body = `${r.name}: ${f.pct(r.marginPct)} margin (+${f.coins(r.margin)} each). Buy ${f.price(r.buyAt)}, sell ${f.price(r.sellAt)}.`;
    toast(`🔔 ${body}`);
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification("BZ Flip alert", { body, tag: `bzflip-${id}` });
        n.onclick = () => { window.focus(); openDrawer(id); };
      }
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
}

// ---------- status ----------
function setStatus(kind, text) {
  $("#status").className = `status ${kind}`;
  $("#status-text").textContent = text;
}

function updateStatus() {
  if (!state.bazaar || state.loading) return;
  if ($("#status").classList.contains("error") && Date.now() < state.nextAt) return;
  const n = Object.keys(state.bazaar.products).length.toLocaleString();
  if (document.hidden) return setStatus("paused", `Paused while hidden · prices ${f.ago(state.bazaar.lastUpdated)}`);
  if (Date.now() - state.bazaar.lastUpdated > STALE_MS) return setStatus("stale", `Hypixel's bazaar data is ${f.ago(state.bazaar.lastUpdated).replace(" ago", "")} old (API delay) · ${n} products`);
  setStatus("live", `Live · prices from ${f.ago(state.bazaar.lastUpdated)} · ${n} products`);
}

// ---------- rendering helpers ----------
const TIER_COLORS = { COMMON: "#8b95a5", UNCOMMON: "#3fbf5f", RARE: "#4a7dff", EPIC: "#a347ff", LEGENDARY: "#f0a500", MYTHIC: "#ff4fc7", DIVINE: "#38d6ff", SPECIAL: "#ff5555", VERY_SPECIAL: "#ff5555" };
const CAT_COLORS = { Enchantments: "#a347ff", Essence: "#38b2ac", Shards: "#e67e22", Gemstones: "#ff4fc7", "Reforge Stones": "#4a7dff", Garden: "#3fbf5f", Factions: "#e84393" };

function icon(r, cls = "") {
  const color = TIER_COLORS[r.tier] || CAT_COLORS[r.category] || "#5f7086";
  const words = r.name.replace(/[^A-Za-z0-9 ]/g, "").split(" ").filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
  const img = state.badIcons.has(r.id) ? "" : `<img src="${ICON(r.id)}" alt="" loading="lazy" decoding="async" data-icon="${f.esc(r.id)}">`;
  return `<span class="item-icon ${cls}" style="--tc:${color}"><b>${f.esc(initials)}</b>${img}</span>`;
}

function meter(v) {
  const on = Math.max(1, Math.round(v * 5));
  const cls = v < 0.35 ? "low" : v < 0.7 ? "mid" : "high";
  return `<span class="meter ${cls}" title="${Math.round(v * 100)}/100">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= on ? "on" : ""}"></i>`).join("")}</span>`;
}

function scoreRing(s) {
  const color = s >= 70 ? "var(--green)" : s >= 40 ? "var(--gold)" : s >= 15 ? "var(--amber)" : "var(--faint)";
  return `<span class="score"><span class="ring-s" style="--p:${s};--sc:${color}">${s}</span></span>`;
}

const flagHtml = (fl) => `<span class="flag ${fl.level}" title="${f.esc(fl.tip)}">${f.esc(fl.label)}</span>`;

function tickCls(id, key, value) {
  const prev = state.prevPrices.get(id)?.[key];
  if (prev == null || prev === value) return "";
  return value > prev ? " tick-up" : " tick-down";
}

function rankDelta(id, pos) {
  const tab = state.view.tab;
  if (tab === "watch" || state.view.sort || !state.prevRanks[tab]) return "";
  const prev = state.prevRanks[tab].get(id);
  if (!prev) return `<span class="rank-delta new">new</span>`;
  const d = prev - pos;
  if (d > 0) return `<span class="rank-delta up">▲${d}</span>`;
  if (d < 0) return `<span class="rank-delta down">▼${-d}</span>`;
  return "";
}

function itemCell(r, extra = "") {
  const trend = r.history?.askChange24;
  const trendHtml = Number.isFinite(trend) && Math.abs(trend) >= 0.005 ? `<span class="${trend > 0 ? "pos" : "neg"}">${trend > 0 ? "▲" : "▼"}${f.pct(Math.abs(trend))} 24h</span>` : "";
  const flags = (r.flags || []).slice(0, 2).map(flagHtml).join("");
  return `<div class="item-cell">${icon(r)}<div><div class="item-name">${f.esc(r.name)}</div><div class="item-sub">${f.esc(r.category)}${trendHtml ? " · " + trendHtml : ""}${extra} ${flags}</div></div></div>`;
}

function marginHtml(margin, pctVal) {
  const cls = margin > 0 ? "pos" : "neg";
  return `<span class="price ${cls}">${margin > 0 ? "+" : ""}${f.coins(margin)}</span><br><span class="pct ${cls}">${f.pct(pctVal)}</span>`;
}

function volHtml(r) {
  const total = r.instaBuysHr + r.instaSellsHr || 1;
  return `<span class="volbar"><span class="price">${f.rate(r.flowHr)}</span><span class="bars" title="Instant-buys ${f.rate(r.instaBuysHr)}/h · instant-sells ${f.rate(r.instaSellsHr)}/h"><i class="b" style="width:${(r.instaBuysHr / total) * 100}%"></i><i class="s" style="width:${(r.instaSellsHr / total) * 100}%"></i></span></span>`;
}

function sparkCell(id) {
  const day = Date.now() - 24 * 3600e3;
  const pts = seriesFor(id).filter((p) => p.t >= day);
  return pts.length >= 3 ? sparkline(pts.map((p) => p.ask)) : `<span class="muted">–</span>`;
}

function ingredientsText(r) {
  const full = r.inputs.map((i) => `${i.qty}× ${i.name}`).join(", ");
  return { full, short: full.length > 34 ? `${full.slice(0, 33)}…` : full };
}

const star = (r) => `<button class="star ${state.watch.has(r.id) ? "on" : ""}" data-star="${r.id}" aria-label="Watch ${f.esc(r.name)}" aria-pressed="${state.watch.has(r.id)}">${state.watch.has(r.id) ? "★" : "☆"}</button>`;
const rankCol = { label: "#", cls: "c-rank", cell: (r, i) => `${i + 1}${rankDelta(r.id, i + 1)}` };
const starCol = { label: "", cls: "c-star", cell: star };
const sparkCol = { label: "24h", key: "trend24", num: true, cls: "c-spark", title: "Lowest sell offer over the last 24h", cell: (r) => sparkCell(r.id) };
const scoreCol = { label: "Score", key: "score", num: true, cls: "c-score", title: "0–100: risk-adjusted profit/hr relative to the best one right now", cell: (r) => scoreRing(r.score) };
const buyCol = { label: "Buy order", key: "buyAt", num: true, title: "Place your buy order here (best bid + 0.1)", cell: (r) => `<span class="price${tickCls(r.id, "buyAt", r.buyAt)}">${f.price(r.buyAt)}</span><span class="price-sub">bid ${f.coins(r.bestBid)}</span>` };

// Column sets per tab kind; `key` makes a column sortable.
const COLS = {
  flip: [
    rankCol,
    { label: "Item", cls: "c-item", cell: (r) => itemCell(r) },
    buyCol,
    { label: "Sell offer", key: "sellAt", num: true, title: "List your sell offer here (best ask − 0.1)", cell: (r) => `<span class="price${tickCls(r.id, "sellAt", r.sellAt)}">${f.price(r.sellAt)}</span><span class="price-sub">ask ${f.coins(r.bestAsk)}</span>` },
    { label: "Margin", key: "margin", num: true, title: "Profit per item after tax", cell: (r) => marginHtml(r.margin, r.marginPct) },
    { label: "Volume/hr", key: "flowHr", num: true, title: "Units/hour that can be both bought and sold (slower side, 7-day average)", cell: volHtml },
    sparkCol,
    { label: "Competition", key: "competition", num: true, title: "Orders on the book relative to volume. Higher means more undercutting.", cell: (r) => `${meter(r.competition)}<span class="price-sub">${f.int(r.totalOrders)} orders</span>` },
    { label: "Profit/hr", key: "profitHr", num: true, title: "Estimated coins/hour for your budget and volume share", cell: (r) => (r.orderQty === 0 ? `<span class="flag info">Over budget</span>` : `<span class="profit">${f.coins(r.profitHr)}</span>`) + `<span class="price-sub">${f.coins(r.marketProfitHr)} mkt</span>` },
    scoreCol,
    starCol,
  ],
  npc: [
    rankCol,
    { label: "Item", cls: "c-item", cell: (r) => itemCell(r) },
    buyCol,
    { label: "NPC pays", key: "npcSell", num: true, title: "What any NPC shop pays per item (no tax)", cell: (r) => `<span class="price">${f.price(r.npcSell)}</span><span class="price-sub">no tax</span>` },
    { label: "Profit/item", key: "npcProfit", num: true, cell: (r) => marginHtml(r.npcProfit, r.npcProfit / r.buyAt) },
    { label: "Insta-sells/hr", key: "instaSellsHr", num: true, title: "How fast buy orders fill", cell: (r) => `<span class="price">${f.rate(r.instaSellsHr)}</span>` },
    sparkCol,
    { label: "Competition", key: "competition", num: true, cell: (r) => `${meter(r.competition)}<span class="price-sub">${f.int(r.buyOrders)} buy orders</span>` },
    { label: "Profit/hr", key: "npcProfitHr", num: true, cell: (r) => `<span class="profit">${f.coins(r.npcProfitHr)}</span>` },
    starCol,
  ],
  craft: [
    rankCol,
    { label: "Item", cls: "c-item", cell: (r) => itemCell(r, r.count > 1 ? ` · ×${r.count}` : "") },
    { label: "Ingredients", key: "cost", num: true, title: "Cost per craft using buy orders on every ingredient", cell: (r) => { const t = ingredientsText(r); return `<span class="price">${f.coins(r.cost)}</span><span class="price-sub" title="${f.esc(t.full)}">${f.esc(t.short)}</span>`; } },
    { label: "Sells for", key: "revenue", num: true, title: "Sell offer on the result, after tax", cell: (r) => `<span class="price">${f.coins(r.revenue)}</span><span class="price-sub">offer ${f.coins(r.sellAt)}</span>` },
    { label: "Profit/craft", key: "margin", num: true, cell: (r) => marginHtml(r.margin, r.marginPct) },
    { label: "Crafts/hr", key: "marketCraftsHr", num: true, title: "Limited by both the result's buyers and each ingredient's sellers", cell: (r) => `<span class="price">${f.rate(r.marketCraftsHr)}</span>` },
    { label: "Instant", key: "instantProfit", num: true, title: "Insta-buy ingredients → insta-sell result", cell: (r) => `<span class="price ${r.instantProfit > 0 ? "pos" : "muted"}">${r.instantProfit > 0 ? "+" : ""}${f.coins(r.instantProfit)}</span>` },
    { label: "Profit/hr", key: "profitHr", num: true, cell: (r) => (r.affordable === 0 ? `<span class="flag info">Over budget</span>` : `<span class="profit">${f.coins(r.profitHr)}</span>`) },
    scoreCol,
    starCol,
  ],
};

// ---------- rendering ----------
function renderAll() {
  renderCategories();
  renderTabs();
  renderMayor();
  renderKpis();
  renderPlanner();
  renderTable();
  renderHistoryInfo();
  updateTitle();
  if (state.openId) openDrawer(state.openId, { keepScroll: true });
}

function renderTabs() {
  $("#tabs").innerHTML = TABS.map((t, i) => {
    const badge = t.key === "watch" && state.watch.size ? `<span class="badge">${state.watch.size}</span>` : t.key === "craft" && !state.recipes ? `<span class="spinner tiny"></span>` : "";
    return `<button class="tab" role="tab" data-tab="${t.key}" aria-selected="${state.view.tab === t.key}" title="${t.label} (${i + 1})">${t.label}${badge}</button>`;
  }).join("");
  $("#blurb").textContent = BLURBS[state.view.tab] || "";
}

function renderCategories() {
  const cats = [...new Set(state.results.map((r) => r.category))].sort();
  const cur = state.view.category;
  $("#category").innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option ${c === cur ? "selected" : ""}>${f.esc(c)}</option>`).join("");
}

function renderMayor() {
  const m = state.mayor;
  const el = $("#mayor");
  if (!m.mayor) { el.hidden = true; return; }
  el.hidden = false;
  const tax = effectiveSettings().tax;
  const effects = m.notes.length
    ? m.notes.map((n) => `<div class="mayor-note"><b>${f.esc(n.who)} · ${f.esc(n.name)}:</b> ${f.esc(n.text)}${n.applied ? ` <span class="flag warn">Applied: tax ×${m.taxMult}</span>` : ""}</div>`).join("")
    : `<span class="muted">No active mayor or minister perk changes bazaar tax right now.</span>`;
  el.className = `mayor card ${m.taxMult !== 1 ? "alert" : ""}`;
  el.innerHTML = `<div class="mayor-who"><span><span class="label">Mayor</span><b>${f.esc(m.mayor)}</b></span>${m.minister ? `<span><span class="label">Minister</span><b>${f.esc(m.minister)}</b></span>` : ""}<span><span class="label">Your tax</span><b>${f.pct(tax, 3)}</b></span></div><div class="mayor-effects">${effects}</div>`;
}

function currentRows() {
  const { tab, category, hideRisky, sort } = state.view;
  let rows;
  if (tab === "watch") rows = state.results.filter((r) => state.watch.has(r.id)).sort((a, b) => b.adjProfitHr - a.adjProfitHr);
  else if (tab === "craft") rows = craftRows(hideRisky);
  else rows = rank(state.results, tab, effectiveSettings(), { hideRisky });
  if (category) rows = rows.filter((r) => r.category === category);
  const q = state.search.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  if (sort && rows.length && sort in rows[0]) rows = [...rows].sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0));
  return rows;
}

function renderTable() {
  const cols = COLS[tabDef().kind];
  $("#thead").innerHTML = `<tr>${cols.map((c) => {
    const cls = [c.cls, c.num && "num", c.key && "sortable", c.key && c.key === state.view.sort && "sorted"].filter(Boolean).join(" ");
    return `<th class="${cls}" ${c.key ? `data-sort="${c.key}"` : ""} ${c.title ? `title="${f.esc(c.title)}"` : ""}>${c.label || '<span class="sr-only">Watch</span>'}</th>`;
  }).join("")}</tr>`;
  if (!state.bazaar) return;
  const rows = currentRows();
  const shown = rows.slice(0, state.limit);
  let empty = "No items match. Try lowering the minimum volume, turning off “Hide risky”, or clearing the search.";
  if (state.view.tab === "watch") empty = "Your watchlist is empty. Star items with ☆ to track them here.";
  if (state.view.tab === "craft" && !state.recipes) empty = `<span class="spinner"></span> Loading recipes…`;
  $("#rows").innerHTML = shown.length
    ? shown.map((r, i) => `<tr data-id="${r.id}">${cols.map((c) => {
        const label = c.label && c.cls !== "c-item" && c.cls !== "c-rank" ? ` data-label="${c.label}"` : "";
        return `<td class="${[c.cls, c.num && "num"].filter(Boolean).join(" ")}"${label}>${c.cell(r, i)}</td>`;
      }).join("")}</tr>`).join("")
    : `<tr><td colspan="12"><div class="empty">${empty}</div></td></tr>`;
  $("#count").textContent = `Showing ${Math.min(rows.length, state.limit)} of ${rows.length} ${state.view.tab === "craft" ? "crafts" : "items"}`;
  $("#more-btn").hidden = rows.length <= state.limit;
}

function kpi(label, value, sub, id) {
  return `<div class="kpi card ${id ? "highlight" : ""}" ${id ? `data-open="${id}" role="button" tabindex="0"` : ""}><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function renderKpis() {
  const s = effectiveSettings();
  const best = rank(state.results, "best", s);
  const margin = rank(state.results, "margin", s).filter((r) => r.flowHr >= Math.max(20, s.minFlow) && !r.flags.some((x) => x.key === "fat"));
  const vol = rank(state.results, "volume", s).filter((r) => r.marginPct >= 0.01);
  const craft = craftRows(true)[0];
  const b = best[0], m = margin[0], v = vol[0];
  const hr = `<small class="muted">/hr</small>`;
  $("#kpis").innerHTML = [
    b ? kpi("Best flip right now", `<span class="pos">${f.coins(b.profitHr)}</span>${hr}`, `${f.esc(b.name)} · ${best.length} profitable flips`, b.id) : kpi("Best flip right now", "–", "No profitable flips match your filters"),
    craft ? kpi("Best craft flip", `<span class="pos">${f.coins(craft.profitHr)}</span>${hr}`, `${f.esc(craft.name)} · +${f.coins(craft.margin)}/craft`, craft.id) : kpi("Best craft flip", state.recipes ? "–" : `<span class="spinner"></span>`, state.recipes ? "No profitable crafts right now" : "Loading recipes…"),
    m ? kpi("Best liquid margin", `${f.pct(m.marginPct)}`, `${f.esc(m.name)} · ${f.rate(m.flowHr)}/hr`, m.id) : kpi("Best liquid margin", "–", "–"),
    v ? kpi("Fastest mover", `${f.rate(v.flowHr)}${hr}`, `${f.esc(v.name)} · ${f.pct(v.marginPct)} margin`, v.id) : kpi("Fastest mover", "–", "–"),
  ].join("");
}

function renderPlanner() {
  const p = state.plan;
  if (!p) return;
  if (!p.picks.length) {
    $("#plan-body").innerHTML = `<div class="empty">No flips fit that budget. Try more coins or a higher “max per item”.</div>`;
    return;
  }
  const rows = p.picks.map((x, i) => {
    const r = x.r;
    return `<tr data-id="${r.id}">
      <td class="c-rank">${i + 1}</td>
      <td class="c-item"><div class="item-cell">${icon(r, "sm")}<div><div class="item-name">${f.esc(r.name)}</div><div class="item-sub">${f.pct(r.marginPct)} margin · ${f.rate(r.flowHr)}/hr volume</div></div></div></td>
      <td class="num" data-label="Buy order"><span class="price">${f.int(x.qty)} × ${f.price(r.buyAt)}</span></td>
      <td class="num" data-label="Cost"><span class="price">${f.coins(x.cost)}</span></td>
      <td class="num" data-label="Sell offer"><span class="price">${f.price(r.sellAt)}</span></td>
      <td class="num" data-label="Profit"><span class="profit">+${f.coins(x.profit)}</span></td>
      <td class="num" data-label="Fills"><span class="price">${f.duration(x.hours)}</span></td>
    </tr>`;
  }).join("");
  $("#plan-body").innerHTML = `
    <div class="plan-summary">
      <div><span class="label">Invest</span><b>${f.coins(p.invested)}</b><small>of ${f.coins(state.settings.purse)}</small></div>
      <div><span class="label">Expected profit / round</span><b class="pos">+${f.coins(p.profit)}</b><small>a round is about 1–2h</small></div>
      <div><span class="label">Return</span><b>${f.pct(p.roi)}</b><small>per round, after tax</small></div>
      <div><span class="label">Order slots</span><b>${p.picks.length * 2} / ${ORDER_SLOTS[state.settings.tax] || 14}</b><small>buy + sell per flip</small></div>
    </div>
    <div class="table-wrap"><table class="flips plan-table"><thead><tr><th class="c-rank">#</th><th>Item</th><th class="num">Buy order</th><th class="num">Cost</th><th class="num">Sell offer</th><th class="num">Profit</th><th class="num">Fills</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function planText() {
  const p = state.plan;
  if (!p?.picks.length) return "";
  return [`BZ Flip plan (${new Date().toLocaleString()}): invest ${f.coins(p.invested)} → +${f.coins(p.profit)}`,
    ...p.picks.map((x, i) => `${i + 1}. ${x.r.name}: buy ${f.int(x.qty)} @ ${f.price(x.r.buyAt)}, sell @ ${f.price(x.r.sellAt)} → +${f.coins(x.profit)}`)].join("\n");
}

function renderHistoryInfo() {
  const srv = state.serverHistory?.t.length || 0;
  const loc = state.localHistory?.t.length || 0;
  $("#history-info").textContent = srv
    ? `Price history: ${srv} hourly snapshots from the server, plus ${loc} recorded locally.`
    : `Price history: ${loc} snapshot${loc === 1 ? "" : "s"} saved in this browser (one every 20 min while open).`;
}

function updateTitle() {
  const b = rank(state.results, "best", effectiveSettings())[0];
  document.title = b ? `${f.coins(b.profitHr)}/hr · ${b.name} | BZ Flip` : "BZ Flip · Hypixel SkyBlock Bazaar Flipper";
}

// ---------- drawer ----------
function craftSection(c) {
  const rows = c.inputs.map((i) => `<tr data-goto="${i.id}" title="Open ${f.esc(i.name)}"><td><span class="ing">${icon({ id: i.id, name: i.name, category: "", tier: state.meta[i.id]?.tier }, "xs")}${f.esc(i.name)}</span></td><td>${f.int(i.qty)}</td><td>${f.price(i.orderPrice)}</td><td>${f.coins(i.orderPrice * i.qty)}</td><td>${f.rate(i.instaSellsHr)}</td></tr>`).join("");
  const signed = (v) => `<b class="${v > 0 ? "pos" : "neg"}">${v > 0 ? "+" : ""}${f.coins(v)}</b>`;
  return `<div class="d-section"><h3>Craft it <span>${c.req ? f.esc(c.req) : "no collection requirement listed"}</span></h3>
    <div class="recipe"><table>
      <thead><tr><th>Ingredient</th><th>Qty</th><th>Buy order</th><th>Total</th><th>Sells/hr</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="craft-modes">
      <div><span class="label">Patient · buy orders → sell offer</span><span>${f.coins(c.cost)} → ${f.coins(c.revenue)}${c.count > 1 ? ` (×${c.count})` : ""}</span>${signed(c.margin)}</div>
      <div><span class="label">Instant · insta-buy → insta-sell</span><span>${f.coins(c.instantCost)} → ${f.coins(c.instantRevenue)}</span>${signed(c.instantProfit)}</div>
    </div>
    <div class="d-note">About ${f.rate(c.marketCraftsHr)} crafts/hr can trade on the market; at your share that's ~${f.coins(c.profitHr)}/hr. Click an ingredient to see its own order book.</div>
  </div>`;
}

function openDrawer(id, { keepScroll = false } = {}) {
  const r = state.byId.get(id);
  if (!r) return;
  state.openId = id;
  const s = effectiveSettings();
  const series = seriesFor(id);
  const hs = historyStats(series);
  const qty = r.orderQty;
  const craft = state.craftById.get(id);
  const npcLine = r.npcProfit > 0 && qty > 0
    ? `<div class="step">Or skip the sell offer and <b>sell to any NPC</b> for <b class="mono">${f.price(r.npcSell)}</b> each: <b class="pos">+${f.coins(r.npcProfit * qty)}</b> with no tax and no waiting.</div>`
    : "";
  const steps = qty > 0
    ? `<div class="steps">
        <div class="step">Create a <b>Buy Order</b> for <b class="mono">${f.int(qty)}</b> at <b class="mono">${f.price(r.buyAt)}</b> each <button class="copy" data-copy="${r.buyAt.toFixed(1)}">copy</button><br><span class="muted">Costs ${f.coins(qty * r.buyAt)} · fills in ${f.duration(r.buyFillHrs)} at your volume share</span></div>
        <div class="step">When it fills, create a <b>Sell Offer</b> at <b class="mono">${f.price(r.sellAt)}</b> each <button class="copy" data-copy="${r.sellAt.toFixed(1)}">copy</button><br><span class="muted">Sells in ${f.duration(r.sellFillHrs)} · relist if you get undercut</span></div>
        <div class="step">You get <b class="mono">${f.coins(qty * r.netSell)}</b> after ${f.pct(s.tax, 3)} tax (${f.coins(r.taxPerUnit * qty)}). <b class="${r.margin > 0 ? "pos" : "neg"}">Profit: ${r.margin > 0 ? "+" : ""}${f.coins(r.margin * qty)}</b> (${f.pct(r.marginPct)})</div>
        ${npcLine}
      </div>`
    : `<div class="step" style="padding-left:12px">One unit costs ${f.coins(r.buyAt)}, which is more than your budget of ${f.coins(s.budget)}. Raise your budget in settings to plan this flip.</div>`;

  const maxAmt = Math.max(...r.bids.slice(0, 10).map((l) => l.amount), ...r.asks.slice(0, 10).map((l) => l.amount), 1);
  const book = (levels, cls) => `<table class="${cls}"><thead><tr><th>${cls === "bid" ? "Buy orders" : "Sell offers"}</th><th>Amount</th><th>Orders</th></tr></thead><tbody>${
    levels.slice(0, 10).map((l) => `<tr><td><span>${f.price(l.pricePerUnit)}</span></td><td><div class="bg" style="width:${(l.amount / maxAmt) * 100}%"></div><span>${f.coins(l.amount)}</span></td><td><span>${l.orders}</span></td></tr>`).join("")
  }</tbody></table>`;

  const trend = hs && Number.isFinite(hs.askChange24) ? `<span class="${hs.askChange24 >= 0 ? "pos" : "neg"}">${hs.askChange24 >= 0 ? "▲" : "▼"} ${f.pct(Math.abs(hs.askChange24))} ask, 24h</span>` : "";
  const stat = (l, v, cls = "") => `<div class="d-stat"><div class="l">${l}</div><div class="v ${cls}">${v}</div></div>`;
  const watched = state.watch.has(id);
  const bzCmd = `/bz ${r.name}`;

  $("#drawer-body").innerHTML = `
    <div class="d-head">
      ${icon(r, "lg")}
      <div><h2 id="d-title">${f.esc(r.name)}</h2><div class="id">${r.id} · ${f.esc(r.category)}${r.tier ? " · " + r.tier.replace("_", " ").toLowerCase() : ""}</div></div>
      <button class="btn btn-icon d-star" data-star="${id}" title="${watched ? "Remove from" : "Add to"} watchlist" aria-pressed="${watched}"><span style="color:var(--gold);font-size:18px">${watched ? "★" : "☆"}</span></button>
      <button class="btn btn-icon" id="d-close" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="d-flags">${scoreRing(r.score)} ${r.flags.map(flagHtml).join("")} <button class="copy" data-copy="${f.esc(bzCmd)}" title="Copy the in-game bazaar search command">${f.esc(bzCmd)}</button></div>
    ${r.flags.length ? `<div class="d-note">${r.flags.map((fl) => `<div>• <b>${f.esc(fl.label)}:</b> ${f.esc(fl.tip)}</div>`).join("")}</div>` : ""}

    <div class="d-section"><h3>Numbers <span>prices ${f.ago(state.bazaar.lastUpdated)}</span></h3>
      <div class="d-stats">
        ${stat("Buy order at", f.price(r.buyAt))}
        ${stat("Sell offer at", f.price(r.sellAt))}
        ${stat("Margin / item", `${r.margin > 0 ? "+" : ""}${f.coins(r.margin)}`, r.margin > 0 ? "pos" : "neg")}
        ${stat("Your profit / hr", f.coins(r.profitHr), "pos")}
        ${stat("Market profit / hr", f.coins(r.marketProfitHr))}
        ${stat("Confidence", f.pct(r.confidence, 0))}
        ${stat("Insta-sells / hr", f.rate(r.instaSellsHr))}
        ${stat("Insta-buys / hr", f.rate(r.instaBuysHr))}
        ${stat("Orders on book", `${f.int(r.buyOrders)} / ${f.int(r.sellOrders)}`)}
      </div>
    </div>

    <div class="d-section"><h3>How to flip it <span>budget ${f.coins(s.budget)}</span></h3>${steps}</div>
    ${craft ? craftSection(craft) : ""}

    <div class="d-section"><h3>Price history <span>${trend}</span></h3><div class="chart-box" id="chart"></div></div>

    <div class="d-section"><h3>Order book <span>top 10 levels</span></h3><div class="book">${book(r.bids, "bid")}${book(r.asks, "ask")}</div>
      <div class="d-note">7-day volume: ${f.int(r.weekly.sell)} instant-sold, ${f.int(r.weekly.buy)} instant-bought. Waiting in orders: ${f.coins(r.depth.bids)} in buy orders, ${f.coins(r.depth.asks)} in sell offers.${r.npcSell ? ` NPC sell price: ${f.price(r.npcSell)}.` : ""}</div>
      <div class="d-note"><a href="https://sky.coflnet.com/item/${encodeURIComponent(r.id)}" target="_blank" rel="noopener">Long-term price chart on Coflnet ↗</a></div>
    </div>`;

  const drawer = $("#drawer");
  if (!keepScroll) drawer.scrollTop = 0;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  $("#backdrop").hidden = false;
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => renderPriceChart($("#chart"), series));
  if (!keepScroll) $("#d-close").focus({ preventScroll: true });
  if (location.hash !== `#${encodeURIComponent(id)}`) history.replaceState(null, "", `#${encodeURIComponent(id)}`);
}

function closeDrawer() {
  state.openId = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#backdrop").hidden = true;
  document.body.style.overflow = "";
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}

// ---------- misc UI ----------
let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(text.includes("\n") ? "Plan copied" : `Copied ${text}`);
}

function toggleWatch(id) {
  state.watch.has(id) ? state.watch.delete(id) : state.watch.add(id);
  store.set(LS.watch, [...state.watch]);
  renderTabs();
  renderTable();
  if (state.openId === id) openDrawer(id, { keepScroll: true });
}

function setTab(key) {
  if (!TABS.some((t) => t.key === key)) return;
  state.view.tab = key;
  state.view.sort = null;
  state.limit = PAGE;
  saveView();
  renderTabs();
  renderTable();
}

function saveView() {
  const { tab, category, hideRisky, sort } = state.view;
  store.set(LS.view, { tab, category, hideRisky, sort });
}

function saveSettings({ recompute = true } = {}) {
  store.set(LS.settings, state.settings);
  if (recompute) recomputeAndRender();
}

function syncSettingsForm() {
  const s = state.settings;
  $("#set-budget").value = f.coins(s.budget);
  $("#set-tax").value = String(s.tax);
  $("#set-capture").value = Math.round(s.capture * 100);
  $("#capture-out").textContent = `${Math.round(s.capture * 100)}%`;
  $("#set-minflow").value = s.minFlow;
  $("#set-interval").value = String(s.interval);
  $("#set-alert").value = s.alertPct ?? "";
  $("#plan-purse").value = f.coins(s.purse);
  $("#plan-slots").value = planSlots();
  $("#plan-share").value = String(s.planShare);
}

function tick() {
  const total = state.settings.interval * 1000;
  const left = Math.max(0, state.nextAt - Date.now());
  const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
  $("#countdown").textContent = document.hidden ? "paused" : state.nextAt ? (m ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`) : "--";
  $("#ring-progress").style.strokeDashoffset = state.nextAt ? String(94.25 * (1 - Math.min(1, left / total))) : "0";
  // Don't poll the API from a hidden tab; catch up as soon as it's visible again.
  if (state.nextAt && left <= 0 && !state.loading && !document.hidden) refresh();
  updateStatus();
}

// ---------- events ----------
function bind() {
  $("#refresh-btn").addEventListener("click", () => refresh({ manual: true }));
  $("#theme-btn").addEventListener("click", () => {
    const root = document.documentElement;
    const isLight = root.dataset.theme ? root.dataset.theme === "light" : matchMedia("(prefers-color-scheme: light)").matches;
    root.dataset.theme = isLight ? "dark" : "light";
    try { localStorage.setItem(LS.theme, root.dataset.theme); } catch {}
    if (state.openId) renderPriceChart($("#chart"), seriesFor(state.openId));
  });
  $("#settings-btn").addEventListener("click", (e) => {
    const panel = $("#settings");
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
  });

  $("#tabs").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t) setTab(t.dataset.tab); });
  let searchTimer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value; state.limit = PAGE; renderTable(); }, 120);
  });
  $("#category").addEventListener("change", (e) => { state.view.category = e.target.value; state.limit = PAGE; saveView(); renderTable(); });
  $("#hide-risky").checked = state.view.hideRisky;
  $("#hide-risky").addEventListener("change", (e) => { state.view.hideRisky = e.target.checked; saveView(); recomputeAndRender(); });
  $("#more-btn").addEventListener("click", () => { state.limit += PAGE; renderTable(); });

  $("#thead").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    state.view.sort = state.view.sort === th.dataset.sort ? null : th.dataset.sort;
    saveView();
    renderTable();
  });

  const openFromRow = (e) => {
    const s = e.target.closest("[data-star]");
    if (s) { e.stopPropagation(); toggleWatch(s.dataset.star); return; }
    const tr = e.target.closest("tr[data-id]");
    if (tr) openDrawer(tr.dataset.id);
  };
  $("#rows").addEventListener("click", openFromRow);
  $("#plan-body").addEventListener("click", openFromRow);
  $("#kpis").addEventListener("click", (e) => { const k = e.target.closest("[data-open]"); if (k) openDrawer(k.dataset.open); });
  $("#kpis").addEventListener("keydown", (e) => { const k = e.target.closest("[data-open]"); if (k && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDrawer(k.dataset.open); } });

  $("#drawer").addEventListener("click", (e) => {
    if (e.target.closest("#d-close")) return closeDrawer();
    const c = e.target.closest("[data-copy]");
    if (c) return copy(c.dataset.copy);
    const s = e.target.closest("[data-star]");
    if (s) return toggleWatch(s.dataset.star);
    const g = e.target.closest("[data-goto]");
    if (g && state.byId.has(g.dataset.goto)) openDrawer(g.dataset.goto);
  });
  $("#backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
    if (e.key === "Escape" && state.openId) return closeDrawer();
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
    else if (e.key === "r" || e.key === "R") refresh({ manual: true });
    else if (/^[1-7]$/.test(e.key) && !state.openId) setTab(TABS[Number(e.key) - 1].key);
  });

  // Icons: fall back to initials when Coflnet has no image for an item.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img?.tagName === "IMG" && img.dataset.icon) { state.badIcons.add(img.dataset.icon); img.remove(); }
  }, true);

  // settings
  $("#set-budget").addEventListener("change", (e) => {
    const v = f.parseCoins(e.target.value);
    if (v > 0) { state.settings.budget = v; saveSettings(); } else toast("Enter a budget like 5m, 250k or 1.5b");
    syncSettingsForm();
  });
  $("#set-tax").addEventListener("change", (e) => { state.settings.tax = Number(e.target.value); saveSettings(); syncSettingsForm(); });
  $("#set-capture").addEventListener("input", (e) => { $("#capture-out").textContent = `${e.target.value}%`; });
  $("#set-capture").addEventListener("change", (e) => { state.settings.capture = Number(e.target.value) / 100; saveSettings(); });
  $("#set-minflow").addEventListener("change", (e) => { state.settings.minFlow = Math.max(0, Number(e.target.value) || 0); saveSettings(); });
  $("#set-interval").addEventListener("change", (e) => {
    state.settings.interval = Number(e.target.value);
    state.nextAt = (state.fetchedAt || Date.now()) + state.settings.interval * 1000;
    saveSettings({ recompute: false });
    toast(`Auto recheck every ${e.target.selectedOptions[0].textContent}`);
  });
  $("#set-alert").addEventListener("change", async (e) => {
    const v = parseFloat(e.target.value);
    state.settings.alertPct = v > 0 ? v : null;
    saveSettings({ recompute: false });
    if (v > 0 && "Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch {}
    }
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    $("#alert-hint").textContent = v > 0
      ? `Alerting at ${v}% for ${state.watch.size} starred item${state.watch.size === 1 ? "" : "s"}${perm === "granted" ? " (with notifications)" : " (in-page only; allow notifications for pop-ups)"}.`
      : "Pops a notification for starred items. Leave empty to turn off.";
    state.alerted.clear();
    checkAlerts();
  });
  $("#reset-btn").addEventListener("click", () => {
    state.settings = defaultSettings();
    state.nextAt = (state.fetchedAt || Date.now()) + state.settings.interval * 1000;
    syncSettingsForm();
    saveSettings();
    toast("Settings reset");
  });

  // planner
  $("#plan-purse").addEventListener("change", (e) => {
    const v = f.parseCoins(e.target.value);
    if (v > 0) { state.settings.purse = v; saveSettings(); } else toast("Enter coins like 50m or 1.2b");
    syncSettingsForm();
  });
  $("#plan-slots").addEventListener("change", (e) => {
    const v = Math.round(Number(e.target.value));
    state.settings.planSlots = v >= 1 ? Math.min(v, 28) : null;
    saveSettings();
    syncSettingsForm();
  });
  $("#plan-share").addEventListener("change", (e) => { state.settings.planShare = Number(e.target.value); saveSettings(); });
  $("#plan-copy").addEventListener("click", () => { const t = planText(); if (t) copy(t); });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.nextAt && Date.now() >= state.nextAt) refresh();
    updateStatus();
  });
  window.addEventListener("resize", () => { if (state.openId) renderPriceChart($("#chart"), seriesFor(state.openId)); });
}

// ---------- boot ----------
bind();
syncSettingsForm();
renderTabs();
renderTable();
setInterval(tick, 1000);
refresh().then(() => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && state.byId.has(id)) openDrawer(id);
});

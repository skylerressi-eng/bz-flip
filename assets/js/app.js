import { analyzeAll, rank, buildMeta, RANKINGS, DEFAULT_SETTINGS, historyStats } from "./analysis.js";
import { appendSnapshot, mergedSeries, isHistory, trim, EMPTY_HISTORY } from "./history.js";
import * as f from "./format.js";
import { renderPriceChart } from "./chart.js";

const API = "https://api.hypixel.net/v2";
const PAGE = 50;
const LS = {
  settings: "bzflip.settings",
  view: "bzflip.view",
  watch: "bzflip.watch",
  meta: "bzflip.meta.v1",
  history: "bzflip.history.v1",
  theme: "bzflip.theme",
};

// ---------- storage (always guarded: private mode / blocked storage) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

// ---------- state ----------
const state = {
  settings: { ...DEFAULT_SETTINGS, interval: 3600, ...store.get(LS.settings, {}) },
  view: { tab: "best", category: "", hideRisky: true, sort: null, ...store.get(LS.view, {}) },
  watch: new Set(store.get(LS.watch, [])),
  search: "",
  limit: PAGE,
  bazaar: null,
  meta: {},
  serverHistory: null,
  localHistory: store.get(LS.history, null),
  results: [],
  byId: new Map(),
  rows: [],
  prevRanks: {}, // tab -> Map(id -> rank) from the previous refresh
  lastRanks: {},
  fetchedAt: 0,
  nextAt: 0,
  loading: false,
  openId: null,
};
if (!isHistory(state.localHistory)) state.localHistory = EMPTY_HISTORY();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- data loading ----------
async function getJson(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
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
    // Only keep entries for bazaar products so localStorage stays small.
    if (state.bazaar) for (const id of Object.keys(meta)) if (!state.bazaar.products[id]) delete meta[id];
    store.set(LS.meta, { at: Date.now(), meta });
    return meta;
  } catch {
    return cached?.meta || {};
  }
}

async function loadServerHistory() {
  try {
    const h = await getJson("data/history.json", 15000);
    return isHistory(h) ? h : null;
  } catch {
    return null;
  }
}

function seriesFor(id) {
  const sources = [state.serverHistory, state.localHistory].filter(Boolean);
  return mergedSeries(sources, id);
}

function recordLocalSnapshot() {
  if (!state.bazaar) return;
  state.localHistory = appendSnapshot(state.localHistory, state.bazaar, { maxPoints: 72, minFlow: 1 });
  // out of quota: keep the most recent half and try once more
  if (!store.set(LS.history, state.localHistory)) store.set(LS.history, trim(state.localHistory, Math.floor(state.localHistory.t.length / 2)));
}

async function refresh({ manual = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  setStatus("loading", "Scanning the bazaar…");
  $("#refresh-btn").classList.add("spinning");
  try {
    const first = !state.bazaar;
    const bz = await getJson(`${API}/skyblock/bazaar`);
    if (!bz.success) throw new Error(bz.cause || "API error");
    state.bazaar = bz;
    if (first) {
      state.meta = await loadMeta();
      // history is a few MB, so fetch it after the first render
      loadServerHistory().then((hist) => {
        if (!hist) return;
        state.serverHistory = hist;
        compute();
        renderAll();
      });
    }
    recordLocalSnapshot();
    state.fetchedAt = Date.now();
    state.prevRanks = state.lastRanks;
    compute();
    renderAll();
    if (!first) announceChanges(manual);
    setStatus("live", `Live · ${Object.keys(bz.products).length.toLocaleString()} products · API data from ${f.clock(bz.lastUpdated)}`);
  } catch (err) {
    setStatus("error", `Couldn't reach the Hypixel API (${err.message}). Retrying soon.`);
    if (!state.bazaar) $("#rows").innerHTML = `<tr><td colspan="10"><div class="empty">Couldn't load bazaar data. Check your connection; it'll retry automatically.</div></td></tr>`;
    state.nextAt = Date.now() + 30e3; // quick retry on failure
    state.loading = false;
    $("#refresh-btn").classList.remove("spinning");
    return;
  }
  state.nextAt = state.fetchedAt + state.settings.interval * 1000;
  state.loading = false;
  $("#refresh-btn").classList.remove("spinning");
}

function compute() {
  state.results = analyzeAll(state.bazaar, state.settings, state.meta, seriesFor);
  state.byId = new Map(state.results.map((r) => [r.id, r]));
  // remember ranks per tab to show movement after the next refresh
  const ranks = {};
  for (const key of Object.keys(RANKINGS)) {
    const m = new Map();
    rank(state.results, key, state.settings, { hideRisky: state.view.hideRisky }).slice(0, 200).forEach((r, i) => m.set(r.id, i + 1));
    ranks[key] = m;
  }
  state.lastRanks = ranks;
}

function announceChanges(manual) {
  const prev = state.prevRanks.best, cur = state.lastRanks.best;
  if (!prev || !cur) return;
  let fresh = 0;
  for (const [id, r] of cur) if (r <= 10 && !(prev.get(id) <= 10)) fresh++;
  if (manual || fresh) toast(fresh ? `Rechecked: ${fresh} new item${fresh > 1 ? "s" : ""} in the top 10` : "Rechecked: rankings are up to date");
}

// ---------- rendering ----------
function setStatus(kind, text) {
  const el = $("#status");
  el.className = `status ${kind}`;
  $("#status-text").textContent = text;
}

function renderAll() {
  renderCategories();
  renderTabs();
  renderKpis();
  renderTable();
  renderHistoryInfo();
  if (state.openId) openDrawer(state.openId, { keepScroll: true });
}

function renderTabs() {
  const tabs = { ...Object.fromEntries(Object.entries(RANKINGS).map(([k, v]) => [k, v.label])), watch: "★ Watchlist" };
  $("#tabs").innerHTML = Object.entries(tabs)
    .map(([k, label]) => {
      const badge = k === "watch" && state.watch.size ? `<span class="badge">${state.watch.size}</span>` : "";
      return `<button class="tab" role="tab" data-tab="${k}" aria-selected="${state.view.tab === k}">${label}${badge}</button>`;
    })
    .join("");
  $("#blurb").textContent = state.view.tab === "watch" ? "Items you've starred. Click ☆ on any row to add it here." : RANKINGS[state.view.tab].blurb;
}

function renderCategories() {
  const sel = $("#category");
  const cats = [...new Set(state.results.map((r) => r.category))].sort();
  const cur = state.view.category;
  sel.innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option ${c === cur ? "selected" : ""}>${f.esc(c)}</option>`).join("");
}

function currentRows() {
  const { tab, category, hideRisky, sort } = state.view;
  let rows;
  if (tab === "watch") rows = state.results.filter((r) => state.watch.has(r.id)).sort((a, b) => b.adjProfitHr - a.adjProfitHr);
  else rows = rank(state.results, tab, state.settings, { hideRisky });
  if (category) rows = rows.filter((r) => r.category === category);
  const q = state.search.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  if (sort) rows = [...rows].sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0));
  return rows;
}

const TIER_COLORS = { COMMON: "#8b95a5", UNCOMMON: "#3fbf5f", RARE: "#4a7dff", EPIC: "#a347ff", LEGENDARY: "#f0a500", MYTHIC: "#ff4fc7", DIVINE: "#38d6ff", SPECIAL: "#ff5555", VERY_SPECIAL: "#ff5555" };
const CAT_COLORS = { Enchantments: "#a347ff", Essence: "#38b2ac", Shards: "#e67e22", Gemstones: "#ff4fc7", "Reforge Stones": "#4a7dff", Garden: "#3fbf5f", Factions: "#e84393" };
function icon(r) {
  const color = TIER_COLORS[r.tier] || CAT_COLORS[r.category] || "#5f7086";
  const words = r.name.replace(/[^A-Za-z0-9 ]/g, "").split(" ").filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
  return `<span class="item-icon" style="background:linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 55%, #000))">${f.esc(initials)}</span>`;
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

function flagsHtml(r, max = 2) {
  return r.flags.slice(0, max).map((fl) => `<span class="flag ${fl.level}" title="${f.esc(fl.tip)}">${f.esc(fl.label)}</span>`).join("");
}

function rankDelta(id, pos) {
  if (state.view.tab === "watch" || state.view.sort || !state.prevRanks[state.view.tab]) return "";
  const prev = state.prevRanks[state.view.tab].get(id);
  if (!prev) return `<span class="rank-delta new">new</span>`;
  const d = prev - pos;
  if (d > 0) return `<span class="rank-delta up">▲${d}</span>`;
  if (d < 0) return `<span class="rank-delta down">▼${-d}</span>`;
  return "";
}

function rowHtml(r, i) {
  const npcTab = state.view.tab === "npc";
  const pos = i + 1;
  const marginCls = r.margin > 0 ? "pos" : "neg";
  const profit = npcTab ? r.npcProfitHr : r.profitHr;
  const overBudget = r.orderQty === 0;
  const totalVol = r.instaBuysHr + r.instaSellsHr || 1;
  const sellCol = npcTab
    ? `<span class="price">${f.price(r.npcSell)}</span><span class="price-sub">NPC sell</span>`
    : `<span class="price">${f.price(r.sellAt)}</span><span class="price-sub">ask ${f.coins(r.bestAsk)}</span>`;
  const marginCol = npcTab
    ? `<span class="price pos">+${f.coins(r.npcProfit)}</span><br><span class="pct pos">${f.pct(r.npcProfit / r.buyAt)}</span>`
    : `<span class="price ${marginCls}">${r.margin > 0 ? "+" : ""}${f.coins(r.margin)}</span><br><span class="pct ${marginCls}">${f.pct(r.marginPct)}</span>`;
  const trend = r.history?.askChange24;
  const trendHtml = Number.isFinite(trend) && Math.abs(trend) >= 0.005 ? `<span class="${trend > 0 ? "pos" : "neg"}">${trend > 0 ? "▲" : "▼"}${f.pct(Math.abs(trend))} 24h</span>` : "";
  return `<tr data-id="${r.id}">
    <td class="c-rank">${pos}${rankDelta(r.id, pos)}</td>
    <td class="c-item"><div class="item-cell">${icon(r)}<div><div class="item-name">${f.esc(r.name)}</div><div class="item-sub">${f.esc(r.category)}${trendHtml ? " · " + trendHtml : ""} ${flagsHtml(r)}</div></div></div></td>
    <td class="num" data-label="Buy order"><span class="price">${f.price(r.buyAt)}</span><span class="price-sub">bid ${f.coins(r.bestBid)}</span></td>
    <td class="num" data-label="${npcTab ? "NPC sell" : "Sell offer"}">${sellCol}</td>
    <td class="num" data-label="${npcTab ? "NPC profit" : "Margin"}">${marginCol}</td>
    <td class="num" data-label="Volume/hr"><span class="volbar"><span class="price">${f.rate(r.flowHr)}</span><span class="bars" title="Instant-buys ${f.rate(r.instaBuysHr)}/h · instant-sells ${f.rate(r.instaSellsHr)}/h"><i class="b" style="width:${(r.instaBuysHr / totalVol) * 100}%"></i><i class="s" style="width:${(r.instaSellsHr / totalVol) * 100}%"></i></span></span></td>
    <td class="num" data-label="Competition">${meter(r.competition)}<span class="price-sub">${f.int(r.totalOrders)} orders</span></td>
    <td class="num" data-label="Profit/hr">${overBudget ? `<span class="flag info">Over budget</span>` : `<span class="profit">${f.coins(profit)}</span>`}<span class="price-sub">${f.coins(r.marketProfitHr)} mkt</span></td>
    <td class="num c-score">${scoreRing(r.score)}</td>
    <td class="c-star"><button class="star ${state.watch.has(r.id) ? "on" : ""}" data-star="${r.id}" aria-label="Watch ${f.esc(r.name)}" aria-pressed="${state.watch.has(r.id)}">${state.watch.has(r.id) ? "★" : "☆"}</button></td>
  </tr>`;
}

function renderTable() {
  if (!state.bazaar) return;
  const rows = (state.rows = currentRows());
  const shown = rows.slice(0, state.limit);
  $$("#flips th.sortable").forEach((th) => th.classList.toggle("sorted", th.dataset.sort === state.view.sort));
  if (!shown.length) {
    const msg = state.view.tab === "watch" ? "Your watchlist is empty. Star items with ☆ to track them here." : "No items match. Try lowering the minimum volume, turning off “Hide risky”, or clearing the search.";
    $("#rows").innerHTML = `<tr><td colspan="10"><div class="empty">${msg}</div></td></tr>`;
  } else {
    $("#rows").innerHTML = shown.map(rowHtml).join("");
  }
  $("#count").textContent = `Showing ${Math.min(rows.length, state.limit)} of ${rows.length} items`;
  $("#more-btn").hidden = rows.length <= state.limit;
}

function kpi(label, value, sub, id) {
  return `<div class="kpi card ${id ? "highlight" : ""}" ${id ? `data-open="${id}" role="button" tabindex="0"` : ""}><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function renderKpis() {
  const s = state.settings;
  const best = rank(state.results, "best", s);
  const margin = rank(state.results, "margin", s).filter((r) => r.flowHr >= Math.max(20, s.minFlow) && !r.flags.some((x) => x.key === "fat"));
  const vol = rank(state.results, "volume", s).filter((r) => r.marginPct >= 0.01);
  const top5 = best.slice(0, 5).reduce((a, r) => a + r.profitHr, 0);
  const b = best[0], m = margin[0], v = vol[0];
  $("#kpis").innerHTML = [
    b ? kpi("Best flip right now", `<span class="pos">${f.coins(b.profitHr)}</span><small class="muted">/hr</small>`, `${f.esc(b.name)} · score ${b.score}`, b.id) : kpi("Best flip right now", "–", "No profitable flips match your filters"),
    kpi("Top 5 in parallel", `<span class="pos">${f.coins(top5)}</span><small class="muted">/hr</small>`, `Needs ~${f.coins(s.budget * Math.min(5, best.length))} in coins · ${best.length} profitable flips`),
    m ? kpi("Best liquid margin", `${f.pct(m.marginPct)}`, `${f.esc(m.name)} · ${f.rate(m.flowHr)}/hr`, m.id) : kpi("Best liquid margin", "–", "–"),
    v ? kpi("Fastest mover", `${f.rate(v.flowHr)}<small class="muted">/hr</small>`, `${f.esc(v.name)} · ${f.pct(v.marginPct)} margin`, v.id) : kpi("Fastest mover", "–", "–"),
  ].join("");
}

function renderHistoryInfo() {
  const srv = state.serverHistory?.t.length || 0;
  const loc = state.localHistory?.t.length || 0;
  $("#history-info").textContent = srv
    ? `Price history: ${srv} hourly snapshots from the server, plus ${loc} recorded locally.`
    : `Price history: ${loc} snapshot${loc === 1 ? "" : "s"} recorded in this browser (one per auto-check while the page is open).`;
}

// ---------- drawer ----------
function openDrawer(id, { keepScroll = false } = {}) {
  const r = state.byId.get(id);
  if (!r) return;
  state.openId = id;
  const s = state.settings;
  const series = seriesFor(id);
  const hs = historyStats(series);
  const qty = r.orderQty;
  const cost = qty * r.buyAt;
  const revenue = qty * r.netSell;
  const npcLine = r.npcProfit > 0
    ? `<div class="step">Or skip the sell offer and <b>sell to any NPC</b> for <b class="mono">${f.price(r.npcSell)}</b> each: <b class="pos">+${f.coins(r.npcProfit * qty)}</b> with no tax and no waiting.</div>`
    : "";
  const steps = qty > 0
    ? `<div class="steps">
        <div class="step">Create a <b>Buy Order</b> for <b class="mono">${f.int(qty)}</b> at <b class="mono">${f.price(r.buyAt)}</b> each <button class="copy" data-copy="${r.buyAt.toFixed(1)}">copy</button><br><span class="muted">Costs ${f.coins(cost)} · fills in ${f.duration(r.buyFillHrs)} at your volume share</span></div>
        <div class="step">When it fills, create a <b>Sell Offer</b> at <b class="mono">${f.price(r.sellAt)}</b> each <button class="copy" data-copy="${r.sellAt.toFixed(1)}">copy</button><br><span class="muted">Sells in ${f.duration(r.sellFillHrs)} · relist if you get undercut</span></div>
        <div class="step">You get <b class="mono">${f.coins(revenue)}</b> after ${f.pct(s.tax, 3)} tax (${f.coins(r.taxPerUnit * qty)}). <b class="${r.margin > 0 ? "pos" : "neg"}">Profit: ${r.margin > 0 ? "+" : ""}${f.coins(r.margin * qty)}</b> (${f.pct(r.marginPct)})</div>
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

  $("#drawer-body").innerHTML = `
    <div class="d-head">
      ${icon(r)}
      <div><h2 id="d-title">${f.esc(r.name)}</h2><div class="id">${r.id} · ${f.esc(r.category)}${r.tier ? " · " + r.tier.replace("_", " ").toLowerCase() : ""}</div></div>
      <button class="btn btn-icon d-close" data-star="${id}" title="${watched ? "Remove from" : "Add to"} watchlist" aria-pressed="${watched}"><span style="color:var(--gold);font-size:18px">${watched ? "★" : "☆"}</span></button>
      <button class="btn btn-icon" id="d-close" title="Close (Esc)" style="flex:none"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="d-flags">${scoreRing(r.score)} ${r.flags.map((fl) => `<span class="flag ${fl.level}" title="${f.esc(fl.tip)}">${f.esc(fl.label)}</span>`).join("")}</div>
    ${r.flags.length ? `<div class="d-note">${r.flags.map((fl) => `<div>• <b>${f.esc(fl.label)}:</b> ${f.esc(fl.tip)}</div>`).join("")}</div>` : ""}

    <div class="d-section"><h3>Numbers</h3>
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
  if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
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
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
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
  toast(`Copied ${text}`);
}

function toggleWatch(id) {
  state.watch.has(id) ? state.watch.delete(id) : state.watch.add(id);
  store.set(LS.watch, [...state.watch]);
  renderTabs();
  renderTable();
  if (state.openId === id) openDrawer(id, { keepScroll: true });
}

function saveView() {
  const { tab, category, hideRisky, sort } = state.view;
  store.set(LS.view, { tab, category, hideRisky, sort });
}

function saveSettings({ recompute = true } = {}) {
  store.set(LS.settings, state.settings);
  if (recompute && state.bazaar) {
    compute();
    renderAll();
  }
}

function syncSettingsForm() {
  const s = state.settings;
  $("#set-budget").value = f.coins(s.budget);
  $("#set-tax").value = String(s.tax);
  $("#set-capture").value = Math.round(s.capture * 100);
  $("#capture-out").textContent = `${Math.round(s.capture * 100)}%`;
  $("#set-minflow").value = s.minFlow;
  $("#set-interval").value = String(s.interval);
}

function tick() {
  const total = state.settings.interval * 1000;
  const left = Math.max(0, state.nextAt - Date.now());
  const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
  $("#countdown").textContent = state.nextAt ? `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : "--:--";
  $("#ring-progress").style.strokeDashoffset = state.nextAt ? String(94.25 * (1 - left / total)) : "0";
  if (state.nextAt && left <= 0 && !state.loading) refresh();
  if (state.bazaar && !state.loading && $("#status").classList.contains("live")) {
    setStatus("live", `Live · ${Object.keys(state.bazaar.products).length.toLocaleString()} products · checked ${f.ago(state.fetchedAt)}`);
  }
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

  $("#tabs").addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (!t) return;
    state.view.tab = t.dataset.tab;
    state.view.sort = null;
    state.limit = PAGE;
    saveView();
    renderTabs();
    renderTable();
  });
  let searchTimer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value; state.limit = PAGE; renderTable(); }, 120);
  });
  $("#category").addEventListener("change", (e) => { state.view.category = e.target.value; state.limit = PAGE; saveView(); renderTable(); });
  $("#hide-risky").checked = state.view.hideRisky;
  $("#hide-risky").addEventListener("change", (e) => { state.view.hideRisky = e.target.checked; saveView(); compute(); renderKpis(); renderTable(); });
  $("#more-btn").addEventListener("click", () => { state.limit += PAGE; renderTable(); });

  $("#flips thead").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    state.view.sort = state.view.sort === th.dataset.sort ? null : th.dataset.sort;
    saveView();
    renderTable();
  });

  $("#rows").addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (star) { e.stopPropagation(); toggleWatch(star.dataset.star); return; }
    const tr = e.target.closest("tr[data-id]");
    if (tr) openDrawer(tr.dataset.id);
  });
  $("#kpis").addEventListener("click", (e) => { const k = e.target.closest("[data-open]"); if (k) openDrawer(k.dataset.open); });
  $("#kpis").addEventListener("keydown", (e) => { const k = e.target.closest("[data-open]"); if (k && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDrawer(k.dataset.open); } });

  $("#drawer").addEventListener("click", (e) => {
    if (e.target.closest("#d-close")) return closeDrawer();
    const c = e.target.closest("[data-copy]");
    if (c) return copy(c.dataset.copy);
    const star = e.target.closest("[data-star]");
    if (star) toggleWatch(star.dataset.star);
  });
  $("#backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.openId) closeDrawer();
    if (e.key === "/" && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); $("#search").focus(); }
  });

  // settings
  $("#set-budget").addEventListener("change", (e) => {
    const v = f.parseCoins(e.target.value);
    if (v > 0) { state.settings.budget = v; saveSettings(); }
    else toast("Enter a budget like 5m, 250k or 1.5b");
    syncSettingsForm();
  });
  $("#set-tax").addEventListener("change", (e) => { state.settings.tax = Number(e.target.value); saveSettings(); });
  $("#set-capture").addEventListener("input", (e) => { $("#capture-out").textContent = `${e.target.value}%`; });
  $("#set-capture").addEventListener("change", (e) => { state.settings.capture = Number(e.target.value) / 100; saveSettings(); });
  $("#set-minflow").addEventListener("change", (e) => { state.settings.minFlow = Math.max(0, Number(e.target.value) || 0); saveSettings(); });
  $("#set-interval").addEventListener("change", (e) => {
    state.settings.interval = Number(e.target.value);
    state.nextAt = (state.fetchedAt || Date.now()) + state.settings.interval * 1000;
    saveSettings({ recompute: false });
    toast(`Auto recheck every ${e.target.selectedOptions[0].textContent}`);
  });
  $("#reset-btn").addEventListener("click", () => {
    state.settings = { ...DEFAULT_SETTINGS, interval: 3600 };
    state.nextAt = (state.fetchedAt || Date.now()) + 3600e3;
    syncSettingsForm();
    saveSettings();
    toast("Settings reset");
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.nextAt && Date.now() >= state.nextAt) refresh();
  });
  window.addEventListener("resize", () => { if (state.openId) renderPriceChart($("#chart"), seriesFor(state.openId)); });
}

// ---------- boot ----------
bind();
syncSettingsForm();
renderTabs();
setInterval(tick, 1000);
refresh().then(() => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && state.byId.has(id)) openDrawer(id);
});

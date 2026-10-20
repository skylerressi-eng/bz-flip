// Core bazaar flip math. Pure functions only, so this module runs unchanged in
// the browser and in Node (tests + the hourly snapshot script).
//
// Hypixel naming is inverted from what most people expect:
//   product.sell_summary = BUY ORDERS  (what instant-sellers hit; sorted high -> low)
//   product.buy_summary  = SELL OFFERS (what instant-buyers hit; sorted low -> high)
//   quick_status.sellMovingWeek = items instant-SOLD in the last 7 days  -> fills buy orders
//   quick_status.buyMovingWeek  = items instant-BOUGHT in the last 7 days -> fills sell offers
// A flip = place a buy order just above the best bid, then a sell offer just
// below the best ask. Tax is only charged on the sell side.

export const ORDER_CAP = 71680; // max items in a single bazaar order
export const SELL_OFFER_COIN_CAP = 1e9; // max coins of items in sell offers at once
export const TICK = 0.1; // smallest bazaar price increment
export const HOURS_PER_WEEK = 168;
export const CYCLE_OVERHEAD_HRS = 0.1; // ~6 min per flip to claim, relist and re-undercut
export const TARGET_FILL_HRS = 2; // size orders so the buy leg fills in about this long

export const DEFAULT_SETTINGS = Object.freeze({
  budget: 10_000_000, // coins you are willing to tie up in one item
  tax: 0.0125, // 1.25% base; 1.125% / 1% with the Bazaar Flipper community upgrade
  capture: "auto", // share of volume you win; "auto" estimates it from the order book
  minFlow: 5, // ignore items moving fewer than this many units per hour
});

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Sum order count sitting within `pct` of the best price: how crowded the top
// of the book is, i.e. how many flippers you will be trading places with.
export function crowdNearTop(levels, best, pct, side) {
  let orders = 0;
  for (const l of levels) {
    const within = side === "bid" ? l.pricePerUnit >= best * (1 - pct) : l.pricePerUnit <= best * (1 + pct);
    if (!within) break;
    orders += l.orders;
  }
  return orders;
}

// Your share of one side's volume. When you hold the top order you get every
// fill until someone undercuts you, so with N competing orders near the top
// you hold the spot roughly 1/(N+1) of the time.
export function shareOf(capture, crowd) {
  if (capture === "auto" || capture == null) return clamp(1 / (1 + crowd), 0.03, 0.5);
  return capture;
}

// history: array of { t, bid, ask } (oldest first), may be empty.
export function historyStats(history, { now = Date.now(), tax = DEFAULT_SETTINGS.tax } = {}) {
  if (!history || history.length < 2) return null;
  const dayAgo = now - 24 * 3600e3;
  const lastDay = history.filter((h) => h.t >= dayAgo);
  const base = history.find((h) => h.t >= dayAgo) || history[0];
  const last = history[history.length - 1];
  return {
    points: history.length,
    medianAsk: median(history.map((h) => h.ask)),
    medianBid: median(history.map((h) => h.bid)),
    medianAsk24: median(lastDay.map((h) => h.ask)),
    medianBid24: median(lastDay.map((h) => h.bid)),
    // what a flip normally makes on this item, after tax
    typicalMarginPct: median(history.map((h) => ((h.ask - TICK) * (1 - tax) - (h.bid + TICK)) / (h.bid + TICK))),
    askChange24: base.ask && last.ask ? (last.ask - base.ask) / base.ask : null,
    bidChange24: base.bid && last.bid ? (last.bid - base.bid) / base.bid : null,
    spanHours: (last.t - history[0].t) / 3600e3,
  };
}

// Size and time one flip cycle: buy order fills at `buyRate` units/hr, then the
// sell offer fills at `sellRate`. The same coins can't be reused until both
// legs finish, so profit/hr = profit per cycle ÷ cycle time.
export function flipCycle({ affordable, targetQty, buyRate, sellRate, margin }) {
  const qty = Math.max(0, Math.min(affordable, targetQty));
  if (qty < 1 || !(buyRate > 0) || !(sellRate > 0)) {
    return { qty, buyHrs: Infinity, sellHrs: Infinity, cycleHrs: Infinity, unitsHr: 0, profitHr: 0 };
  }
  const buyHrs = qty / buyRate;
  const sellHrs = qty / sellRate;
  const cycleHrs = buyHrs + sellHrs + CYCLE_OVERHEAD_HRS;
  const unitsHr = qty / cycleHrs;
  return { qty, buyHrs, sellHrs, cycleHrs, unitsHr, profitHr: Math.max(0, margin) * unitsHr };
}

export function analyzeProduct(id, product, settings = DEFAULT_SETTINGS, meta = {}, history = null) {
  const bids = product.sell_summary || [];
  const asks = product.buy_summary || [];
  const q = product.quick_status || {};
  if (!bids.length || !asks.length) return null;

  const { budget, tax, capture } = { ...DEFAULT_SETTINGS, ...settings };
  const bestBid = bids[0].pricePerUnit;
  const bestAsk = asks[0].pricePerUnit;
  const buyAt = round1(bestBid + TICK);
  const sellAt = round1(bestAsk - TICK);
  if (!(buyAt > 0)) return null;

  const netSell = sellAt * (1 - tax);
  const margin = netSell - buyAt;
  const marginPct = margin / buyAt;
  const taxPerUnit = sellAt * tax;
  const breakEven = buyAt / (1 - tax); // lowest sell price that doesn't lose coins
  const dumpLoss = buyAt - bestBid * (1 - tax); // per unit, if you had to insta-sell right after buying

  const instaSellsHr = (q.sellMovingWeek || 0) / HOURS_PER_WEEK; // fills your buy order
  const instaBuysHr = (q.buyMovingWeek || 0) / HOURS_PER_WEEK; // fills your sell offer
  const flowHr = Math.min(instaSellsHr, instaBuysHr);
  const marketProfitHr = Math.max(0, margin) * flowHr;

  const totalOrders = (q.buyOrders || 0) + (q.sellOrders || 0);
  const crowdBid = crowdNearTop(bids, bestBid, 0.01, "bid");
  const crowdAsk = crowdNearTop(asks, bestAsk, 0.01, "ask");
  // orders per unit of hourly volume, log-mapped to 0..1
  const competition = clamp(Math.log10(1 + totalOrders / Math.max(flowHr, 0.1)) / 3, 0, 1);

  const shareBuy = shareOf(capture, crowdBid);
  const shareSell = shareOf(capture, crowdAsk);
  const buyRate = instaSellsHr * shareBuy;
  const sellRate = instaBuysHr * shareSell;
  const affordable = Math.floor(budget / buyAt);
  const targetQty = Math.min(ORDER_CAP, Math.floor(SELL_OFFER_COIN_CAP / sellAt), Math.max(1, Math.ceil(buyRate * TARGET_FILL_HRS)));
  const cycle = flipCycle({ affordable, targetQty, buyRate, sellRate, margin });
  const orderQty = cycle.qty;

  const hs = historyStats(history, { tax });
  const flags = [];
  const spreadRatio = bestAsk / bestBid;
  if (spreadRatio > 4) flags.push({ key: "wide", level: "bad", label: "Dead spread", tip: "The ask is over 4x the bid. Usually lowball buy orders nobody fills, or a manipulated ask." });
  else if (marginPct > 0.5) flags.push({ key: "fat", level: "warn", label: "Suspicious margin", tip: "Margin over 50% rarely lasts. Check the order book before committing." });
  if (flowHr < 1) flags.push({ key: "dead", level: "bad", label: "Illiquid", tip: "Less than 1 unit trades per hour. You may wait days for fills." });
  const balance = Math.min(instaSellsHr, instaBuysHr) / Math.max(instaSellsHr, instaBuysHr, 1e-9);
  if (balance < 0.25 && flowHr >= 1) {
    const heavier = instaBuysHr > instaSellsHr ? "buyers" : "sellers";
    flags.push({ key: "skew", level: "warn", label: `One-sided (${heavier})`, tip: `Instant ${heavier} outnumber the other side 4:1+. The price is probably trending, so one leg of the flip will be slow.` });
  }

  // Compare against recorded history (7-day Coflnet data and/or our own snapshots).
  let stability = 1;
  let normalcy = 1;
  const verified = !!(hs && hs.points >= 12 && hs.spanHours >= 12);
  if (hs && hs.medianAsk && hs.medianBid) {
    const devAsk = Math.abs(bestAsk - hs.medianAsk) / hs.medianAsk;
    const devBid = Math.abs(bestBid - hs.medianBid) / hs.medianBid;
    const dev = Math.max(devAsk, devBid);
    stability = dev <= 0.1 ? 1 : clamp(1 - (dev - 0.1) * 1.5, 0.25, 1);
    if (bestAsk > hs.medianAsk * 1.3) flags.push({ key: "spike", level: "bad", label: "Price spike", tip: `Ask is ${pct(bestAsk / hs.medianAsk - 1)} above its recent median. Likely manipulation; it may crash before you sell.` });
    else if (bestBid < hs.medianBid * 0.7) flags.push({ key: "crash", level: "warn", label: "Price crash", tip: `Bid is ${pct(1 - bestBid / hs.medianBid)} below its recent median.` });
  }
  if (verified && margin > 0) {
    const typ = hs.typicalMarginPct;
    if (typ <= 0) {
      normalcy = 0.4;
      flags.push({ key: "unusual", level: "warn", label: "Unusual spread", tip: `Over the last ${Math.round(hs.spanHours)}h this item is normally not profitable to flip (median margin ${pct(typ)}). Today's gap will probably close fast.` });
    } else if (marginPct > typ * 2 && marginPct - typ > 0.03) {
      normalcy = clamp((typ * 2) / marginPct, 0.4, 1);
      flags.push({ key: "abnormal", level: "warn", label: "Above normal", tip: `Margin is ${pct(marginPct)} now vs a typical ${pct(typ)} over the last ${Math.round(hs.spanHours)}h. Expect it to shrink back.` });
    } else if (marginPct >= typ * 0.5) {
      flags.push({ key: "steady", level: "good", label: "Steady margin", tip: `Matches its typical ${pct(typ)} margin over the last ${Math.round(hs.spanHours)}h. This flip is consistent, not a one-off.` });
    }
  }
  if (totalOrders > 0 && competition > 0.75) flags.push({ key: "crowded", level: "warn", label: "Crowded", tip: "Lots of orders for the volume. Expect to be undercut constantly." });
  const npc = meta.npcSell || 0;
  if (npc > 0 && npc >= buyAt * 0.98) flags.push({ key: "floor", level: "good", label: "NPC floor", tip: `NPCs buy this for ${npc}, close to or above your buy price, which limits your downside.` });

  // Confidence 0..1: how much we trust the paper profit to be real.
  const volConf = clamp(Math.sqrt(flowHr / 30), 0.05, 1);
  const spreadConf = spreadRatio > 4 ? 0.05 : marginPct <= 0.3 ? 1 : clamp(0.3 / marginPct, 0.1, 1);
  const compConf = 1 - 0.5 * competition;
  const balanceConf = 0.6 + 0.4 * Math.sqrt(balance);
  const historyConf = verified ? 1 : 0.85; // unverified margins get a small haircut
  const confidence = volConf * spreadConf * compConf * balanceConf * stability * normalcy * historyConf;
  const adjProfitHr = cycle.profitHr * confidence;

  const npcProfit = npc > 0 ? npc - buyAt : 0;
  // NPC exit is instant, so the cycle is just the buy leg
  const npcCycle = flipCycle({ affordable, targetQty, buyRate, sellRate: Infinity, margin: npcProfit });
  const npcProfitHr = npcProfit > 0 && Number.isFinite(npcCycle.buyHrs) ? (npcProfit * npcCycle.qty) / (npcCycle.buyHrs + CYCLE_OVERHEAD_HRS) : 0;

  return {
    id,
    name: meta.name || prettyId(id),
    category: meta.category || categoryOf(id),
    tier: meta.tier || null,
    bestBid, bestAsk, buyAt, sellAt, netSell, taxPerUnit, breakEven, dumpLoss,
    margin, marginPct, spreadRatio,
    instaSellsHr, instaBuysHr, flowHr, marketProfitHr,
    shareBuy, shareSell, buyRate, sellRate, targetQty,
    orderQty, affordable, unitsHr: cycle.unitsHr, profitHr: cycle.profitHr, profitPerOrder: Math.max(0, margin) * orderQty,
    buyFillHrs: cycle.buyHrs, sellFillHrs: cycle.sellHrs, cycleHrs: cycle.cycleHrs,
    buyOrders: q.buyOrders || 0, sellOrders: q.sellOrders || 0, totalOrders,
    crowdBid, crowdAsk, competition, balance,
    confidence, adjProfitHr, flags, verified,
    risky: flags.some((f) => f.level === "bad"),
    npcSell: npc, npcProfit, npcProfitHr,
    history: hs,
    typicalMarginPct: hs?.typicalMarginPct ?? null,
    bids: bids.slice(0, 15),
    asks: asks.slice(0, 15),
    weekly: { sell: q.sellMovingWeek || 0, buy: q.buyMovingWeek || 0 },
    depth: { bids: q.sellVolume || 0, asks: q.buyVolume || 0 },
  };
}

export function analyzeAll(bazaar, settings, metaById = {}, historyById = () => null) {
  const out = [];
  for (const [id, p] of Object.entries(bazaar.products || {})) {
    const r = analyzeProduct(id, p, settings, metaById[id] || {}, historyById(id));
    if (r) out.push(r);
  }
  const top = Math.max(1, ...out.map((r) => r.adjProfitHr));
  for (const r of out) r.score = Math.round(100 * Math.sqrt(r.adjProfitHr / top));
  return out;
}

// Each ranking: a predicate (what qualifies) and a sort key (descending).
export const RANKINGS = {
  best: {
    label: "Best flips",
    blurb: "Realistic coins/hour for your budget, discounted by liquidity, competition, spread sanity and price stability.",
    filter: (r, s) => r.margin > 0 && r.flowHr >= s.minFlow,
    key: (r) => r.adjProfitHr,
  },
  margin: {
    label: "Highest margin",
    blurb: "Biggest % return per flip after tax. Dead spreads are excluded; check the flags.",
    filter: (r, s) => r.margin > 0 && r.flowHr >= s.minFlow && r.spreadRatio <= 4,
    key: (r) => r.marginPct,
  },
  volume: {
    label: "Highest volume",
    blurb: "Fastest-moving items that still have a profitable spread. Low risk, quick fills.",
    filter: (r, s) => r.margin > 0 && r.flowHr >= s.minFlow,
    key: (r) => r.flowHr,
  },
  combo: {
    label: "Margin × volume",
    blurb: "Total profit the whole market could take per hour (margin × tradable volume), ignoring your budget.",
    filter: (r, s) => r.margin > 0 && r.flowHr >= s.minFlow && r.spreadRatio <= 4,
    key: (r) => r.marketProfitHr,
  },
  npc: {
    label: "NPC flips",
    blurb: "Buy-order on the bazaar, sell straight to an NPC. No bazaar tax and no undercutting on the sell side.",
    filter: (r) => r.npcProfit > 0 && r.instaSellsHr >= 1,
    key: (r) => r.npcProfitHr,
  },
};

export function rank(results, rankingKey, settings, { hideRisky = true } = {}) {
  const def = RANKINGS[rankingKey] || RANKINGS.best;
  return results
    .filter((r) => def.filter(r, settings) && (!hideRisky || !r.risky))
    .sort((a, b) => def.key(b) - def.key(a));
}

// ---- naming ---------------------------------------------------------------

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

export function titleCase(s) {
  return s.toLowerCase().split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export function prettyId(id) {
  let m = id.match(/^ENCHANTMENT_(ULTIMATE_)?(.+)_(\d+)$/);
  if (m) {
    const lvl = Number(m[3]);
    const name = titleCase(m[2].replace(/^WISE$/, "ULTIMATE_WISE"));
    return `${name} ${ROMAN[lvl] || lvl}`;
  }
  if ((m = id.match(/^ESSENCE_(.+)$/))) return `${titleCase(m[1])} Essence`;
  if ((m = id.match(/^SHARD_(.+)$/))) return `${titleCase(m[1])} Shard`;
  return titleCase(id);
}

export function categoryOf(id) {
  if (id.startsWith("ENCHANTMENT_")) return "Enchantments";
  if (id.startsWith("ESSENCE_")) return "Essence";
  if (id.startsWith("SHARD_")) return "Shards";
  if (id.startsWith("FACTION_") || id.includes("RABBIT")) return "Factions";
  if (/GEM$|_GEM_|GEMSTONE/.test(id)) return "Gemstones";
  return "Materials";
}

const CATEGORY_MAP = {
  REFORGE_STONE: "Reforge Stones",
  BAIT: "Fishing",
  CONSUMABLE: "Consumables",
  BOOSTER: "Boosters",
  GARDEN_CHIP: "Garden",
  MUTATION: "Garden",
  SALT: "Fishing",
  PET_ITEM: "Pet Items",
  ABILITY_SCROLL: "Ability Scrolls",
  ARROW_POISON: "Arrows",
  COSMETIC: "Cosmetic",
};

// Build { id: { name, category, tier, npcSell } } from /v2/resources/skyblock/items.
export function buildMeta(itemsResponse) {
  const meta = {};
  for (const it of itemsResponse?.items || []) {
    meta[it.id] = {
      name: (it.name || "").replace(/§./g, "").trim() || prettyId(it.id),
      category: CATEGORY_MAP[it.category] || categoryOf(it.id),
      tier: it.tier || null,
      npcSell: it.npc_sell_price || 0,
    };
  }
  return meta;
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

// ---- craft flips ----------------------------------------------------------
// recipesData: { recipes: { OUT_ID: [{ in: { ID: qty }, out: count }] }, reqs: { OUT_ID: "Requires: ..." } }
// Two ways to run each craft:
//   patient: buy orders on every ingredient -> sell offer on the output (most profit, slower)
//   instant: insta-buy ingredients -> insta-sell output (no waiting, rarely profitable)
// The patient cycle is timed like a flip: ingredient orders fill in parallel
// (the slowest one decides), then the crafted items sell.
export function analyzeCrafts(bazaar, recipesData, settings = DEFAULT_SETTINGS, metaById = {}, { kind = "craft" } = {}) {
  const { budget, tax, capture } = { ...DEFAULT_SETTINGS, ...settings };
  const P = bazaar.products || {};
  const cache = new Map();
  const top = (id) => {
    if (cache.has(id)) return cache.get(id);
    const p = P[id];
    const bids = p?.sell_summary || [], asks = p?.buy_summary || [];
    const bid = bids[0]?.pricePerUnit, ask = asks[0]?.pricePerUnit;
    const q = p?.quick_status || {};
    const t = {
      bid, ask,
      instaSellsHr: (q.sellMovingWeek || 0) / HOURS_PER_WEEK,
      instaBuysHr: (q.buyMovingWeek || 0) / HOURS_PER_WEEK,
      crowdBid: bid ? crowdNearTop(bids, bid, 0.01, "bid") : 0,
      crowdAsk: ask ? crowdNearTop(asks, ask, 0.01, "ask") : 0,
    };
    cache.set(id, t);
    return t;
  };
  const out = [];
  for (const [id, recipes] of Object.entries(recipesData?.recipes || {})) {
    const o = top(id);
    if (!o.bid || !o.ask) continue;
    let best = null;
    const all = [];
    for (const rec of recipes) {
      let patientCost = 0, instantCost = 0, ingredientCrafts = Infinity, targetCrafts = Infinity, ok = true;
      const inputs = [];
      for (const [ing, qty] of Object.entries(rec.in)) {
        const t = top(ing);
        if (!t.bid || !t.ask) { ok = false; break; }
        const orderPrice = round1(t.bid + TICK);
        const rate = t.instaSellsHr * shareOf(capture, t.crowdBid);
        patientCost += orderPrice * qty;
        instantCost += t.ask * qty;
        ingredientCrafts = Math.min(ingredientCrafts, t.instaSellsHr / qty);
        targetCrafts = Math.min(targetCrafts, (rate * TARGET_FILL_HRS) / qty, ORDER_CAP / qty);
        inputs.push({ id: ing, name: metaById[ing]?.name || prettyId(ing), qty, orderPrice, ask: t.ask, instaSellsHr: t.instaSellsHr, rate });
      }
      if (!ok) continue;
      const n = rec.out || 1;
      const sellAt = round1(o.ask - TICK);
      const patientRevenue = sellAt * (1 - tax) * n;
      const instantRevenue = o.bid * (1 - tax) * n;
      const profit = patientRevenue - patientCost;
      const instantProfit = instantRevenue - instantCost;
      const marketCraftsHr = Math.min(o.instaBuysHr / n, ingredientCrafts);
      const affordable = Math.floor(budget / patientCost);
      const sellRate = o.instaBuysHr * shareOf(capture, o.crowdAsk);
      const crafts = Math.min(affordable, Math.max(1, Math.floor(targetCrafts)), Math.floor(SELL_OFFER_COIN_CAP / (sellAt * n)));
      let craftsHr = 0, cycleHrs = Infinity;
      if (crafts >= 1 && sellRate > 0 && inputs.every((i) => i.rate > 0)) {
        const buyHrs = Math.max(...inputs.map((i) => (crafts * i.qty) / i.rate));
        cycleHrs = buyHrs + (crafts * n) / sellRate + 2 * CYCLE_OVERHEAD_HRS; // extra overhead for crafting
        craftsHr = crafts / cycleHrs;
      }
      const r = {
        id, kind, pair: rec.pair || null,
        name: metaById[id]?.name || prettyId(id),
        category: metaById[id]?.category || categoryOf(id),
        tier: metaById[id]?.tier || null,
        count: n, inputs, sellAt, bestBid: o.bid, bestAsk: o.ask,
        cost: patientCost, instantCost, revenue: patientRevenue, instantRevenue,
        margin: profit, marginPct: profit / patientCost,
        instantProfit, instantPct: instantProfit / instantCost,
        marketCraftsHr, craftsHr, crafts, cycleHrs, affordable,
        profitHr: Math.max(0, profit) * craftsHr,
        req: recipesData.reqs?.[id] || null,
        outputFlowHr: o.instaBuysHr,
      };
      all.push(r);
      if (!best || r.profitHr > best.profitHr || (r.profitHr === best.profitHr && r.margin > best.margin)) best = r;
    }
    if (!best) continue;
    best.alts = all.sort((a, b) => b.profitHr - a.profitHr || b.margin - a.margin).slice(0, 6);
    const flags = [];
    if (best.instantProfit > 0) flags.push({ key: "instant", level: "good", label: "Instant profit", tip: "Profitable even when you insta-buy every ingredient and insta-sell the result. No waiting on orders." });
    if (o.ask / o.bid > 4) flags.push({ key: "wide", level: "bad", label: "Dead spread", tip: "The result's ask is over 4x its bid, so the sell price is not reliable." });
    else if (best.marginPct > 1) flags.push({ key: "fat", level: "warn", label: "Suspicious margin", tip: "Over 100% profit per craft usually means lowball ingredient buy orders that will not fill quickly. Check the ingredient order books." });
    if (best.marketCraftsHr < 1) flags.push({ key: "dead", level: "bad", label: "Illiquid", tip: "Less than one craft's worth trades per hour." });
    if (best.req) flags.push({ key: "req", level: "info", label: best.req.replace(/^Requires:?\s*/i, "Needs "), tip: `${best.req}. You must unlock this recipe first.` });
    best.flags = flags;
    best.risky = flags.some((f) => f.level === "bad");
    best.confidence = clamp(Math.sqrt(best.marketCraftsHr / 10), 0.05, 1) * (best.marginPct > 1 ? clamp(1 / best.marginPct, 0.2, 1) : 1);
    best.adjProfitHr = best.profitHr * best.confidence;
    out.push(best);
  }
  const topAdj = Math.max(1, ...out.map((r) => r.adjProfitHr));
  for (const r of out) r.score = Math.round(100 * Math.sqrt(r.adjProfitHr / topAdj));
  return out;
}

// ---- flip planner ---------------------------------------------------------
// Greedy portfolio: repeatedly take the flip with the highest risk-adjusted
// coins/hour for the coins still available. Each order is sized to what fills
// in about TARGET_FILL_HRS at your share of volume, and money is spread across
// items (maxShare) as every flipping guide recommends.
export function planFlips(results, { purse, slots = 7, maxShare = 0.35, minProfit = Math.max(10_000, purse * 0.001) } = {}) {
  let left = purse;
  const picks = [];
  const pool = results.filter((r) => r.margin > 0 && !r.risky && r.buyRate > 0 && r.sellRate > 0);
  const used = new Set();
  while (picks.length < slots && left > 0) {
    let best = null;
    for (const r of pool) {
      if (used.has(r.id)) continue;
      const cap = Math.min(left, purse * maxShare);
      const qty = Math.floor(Math.min(cap / r.buyAt, r.targetQty));
      if (qty < 1 || qty * r.margin < minProfit) continue;
      const c = flipCycle({ affordable: qty, targetQty: qty, buyRate: r.buyRate, sellRate: r.sellRate, margin: r.margin });
      const value = c.profitHr * r.confidence;
      if (!best || value > best.value) best = { r, qty, value, cycle: c };
    }
    if (!best) break;
    used.add(best.r.id);
    const cost = best.qty * best.r.buyAt;
    left -= cost;
    picks.push({ r: best.r, qty: best.qty, cost, profit: best.qty * best.r.margin, hours: best.cycle.cycleHrs, profitHr: best.cycle.profitHr });
  }
  const invested = purse - left;
  const profit = picks.reduce((a, p) => a + p.profit, 0);
  const profitHr = picks.reduce((a, p) => a + p.profitHr, 0);
  return { picks, invested, left, profit, profitHr, roi: invested ? profit / invested : 0 };
}

// ---- mayor effects ----------------------------------------------------------
// Reads /v2/resources/skyblock/election and reports anything that changes
// bazaar taxes. Derpy's "QUAD TAXES!!!" quadruples them; other perks that
// mention bazaar tax are surfaced so the user can see them.
export function mayorEffects(election) {
  const mayor = election?.mayor;
  if (!mayor) return { taxMult: 1, mayor: null, minister: null, notes: [] };
  const perks = [...(mayor.perks || []).map((p) => ({ ...p, who: mayor.name })), ...(mayor.minister?.perk ? [{ ...mayor.minister.perk, who: mayor.minister.name }] : [])];
  let taxMult = 1;
  const notes = [];
  for (const p of perks) {
    const desc = (p.description || "").replace(/§./g, "");
    if (/quad\s*tax/i.test(p.name || "")) {
      taxMult = 4;
      notes.push({ who: p.who, name: p.name, text: desc, applied: true });
    } else if (/tax/i.test(desc) && /bazaar/i.test(desc)) {
      notes.push({ who: p.who, name: p.name, text: desc, applied: false });
    }
  }
  return { taxMult, mayor: mayor.name, minister: mayor.minister?.name || null, notes };
}

// ---- shard fusion ----------------------------------------------------------
// fusionData (scripts/fusions.mjs): { shards: { C1: { id, name, rarity, family, type, fuse } },
//                                     recipes: { C1: { "2": "C4,U1;C4,U2" } } }
// A fusion consumes `fuse` of each input shard and makes `qty` of the output,
// times the Crocodile bonus (+2% per level) when either input is a Reptile.
// 131k recipe pairs is too many to analyze fully each refresh, so for every
// output we keep only the few cheapest pairs at current prices.

const parsedFusions = new WeakMap();
function parseFusions(fusionData) {
  if (parsedFusions.has(fusionData)) return parsedFusions.get(fusionData);
  const out = [];
  for (const [code, byQty] of Object.entries(fusionData.recipes || {})) {
    const pairs = [];
    for (const [qty, list] of Object.entries(byQty)) {
      for (const p of list.split(";")) {
        const [a, b] = p.split(",");
        pairs.push({ a, b, qty: Number(qty) });
      }
    }
    out.push({ code, pairs });
  }
  parsedFusions.set(fusionData, out);
  return out;
}

export function fusionRecipes(fusionData, bazaar, { crocodileLevel = 0, keep = 4 } = {}) {
  const S = fusionData?.shards || {};
  const P = bazaar.products || {};
  const croc = 1 + 0.02 * clamp(crocodileLevel, 0, 10);
  const order = (code) => { const b = P[S[code]?.id]?.sell_summary?.[0]?.pricePerUnit; return b ? b + TICK : Infinity; };
  const insta = (code) => P[S[code]?.id]?.buy_summary?.[0]?.pricePerUnit || Infinity;
  const recipes = {};
  for (const { code, pairs } of parseFusions(fusionData)) {
    const outId = S[code]?.id;
    if (!outId || !P[outId]) continue;
    const scored = [];
    for (const p of pairs) {
      const A = S[p.a], B = S[p.b];
      if (!A || !B) continue;
      const n = p.qty * (A.family.includes("Reptile") || B.family.includes("Reptile") ? croc : 1);
      const patient = (A.fuse * order(p.a) + B.fuse * order(p.b)) / n;
      if (!Number.isFinite(patient)) continue;
      scored.push({ p, n, patient, instant: (A.fuse * insta(p.a) + B.fuse * insta(p.b)) / n });
    }
    const pick = new Set([
      ...scored.sort((x, y) => x.patient - y.patient).slice(0, keep),
      ...scored.sort((x, y) => x.instant - y.instant).slice(0, keep),
    ]);
    recipes[outId] = [...pick].map(({ p, n }) => {
      const A = S[p.a], B = S[p.b];
      const inputs = { [A.id]: A.fuse };
      inputs[B.id] = (inputs[B.id] || 0) + B.fuse;
      return { in: inputs, out: n, pair: [p.a, p.b] };
    });
  }
  return recipes;
}

export function analyzeFusions(bazaar, fusionData, settings = DEFAULT_SETTINGS, metaById = {}) {
  const recipes = fusionRecipes(fusionData, bazaar, { crocodileLevel: settings.crocodileLevel || 0 });
  const byId = {};
  for (const s of Object.values(fusionData?.shards || {})) byId[s.id] = s;
  const named = (id) => metaById[id] || (byId[id] ? { name: `${byId[id].name} Shard`, category: "Shards" } : {});
  const meta = new Proxy({}, { get: (_, id) => named(id) });
  const out = analyzeCrafts(bazaar, { recipes }, settings, meta, { kind: "fusion" });
  for (const r of out) {
    r.shard = byId[r.id] || null;
    r.category = "Shards";
    if (r.shard) r.tier = r.shard.rarity.toUpperCase(); // colours the icon by rarity
    r.reptile = !!r.pair?.some((c) => fusionData.shards[c]?.family.includes("Reptile"));
  }
  return out;
}

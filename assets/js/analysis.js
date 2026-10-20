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
export const TICK = 0.1; // smallest bazaar price increment
export const HOURS_PER_WEEK = 168;

export const DEFAULT_SETTINGS = Object.freeze({
  budget: 10_000_000, // coins you are willing to tie up in one item
  tax: 0.0125, // 1.25% base; 1.125% / 1% with the Bazaar Flipper community upgrade
  capture: 0.1, // share of the item's hourly volume you realistically win
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
// of the book is, i.e. how quickly you will get undercut.
function crowdNearTop(levels, best, pct, side) {
  let orders = 0;
  for (const l of levels) {
    const within = side === "bid" ? l.pricePerUnit >= best * (1 - pct) : l.pricePerUnit <= best * (1 + pct);
    if (!within) break;
    orders += l.orders;
  }
  return orders;
}

// history: array of { t, bid, ask } (oldest first), may be empty.
export function historyStats(history, now = Date.now()) {
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
    askChange24: base.ask && last.ask ? (last.ask - base.ask) / base.ask : null,
    bidChange24: base.bid && last.bid ? (last.bid - base.bid) / base.bid : null,
    spanHours: (last.t - history[0].t) / 3600e3,
  };
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

  const instaSellsHr = (q.sellMovingWeek || 0) / HOURS_PER_WEEK; // fills your buy order
  const instaBuysHr = (q.buyMovingWeek || 0) / HOURS_PER_WEEK; // fills your sell offer
  const flowHr = Math.min(instaSellsHr, instaBuysHr);
  const marketProfitHr = Math.max(0, margin) * flowHr;

  const affordable = Math.floor(budget / buyAt);
  const orderQty = Math.max(0, Math.min(affordable, ORDER_CAP));
  const unitsHr = Math.min(flowHr * capture, orderQty);
  const profitHr = Math.max(0, margin) * unitsHr;
  const profitPerOrder = Math.max(0, margin) * orderQty;
  // Hours for a full-size order to fill on each side at your capture share.
  const buyFillHrs = instaSellsHr > 0 ? orderQty / (instaSellsHr * capture) : Infinity;
  const sellFillHrs = instaBuysHr > 0 ? orderQty / (instaBuysHr * capture) : Infinity;

  const totalOrders = (q.buyOrders || 0) + (q.sellOrders || 0);
  const crowdBid = crowdNearTop(bids, bestBid, 0.01, "bid");
  const crowdAsk = crowdNearTop(asks, bestAsk, 0.01, "ask");
  // orders per unit of hourly volume, log-mapped to 0..1
  const competition = clamp(Math.log10(1 + totalOrders / Math.max(flowHr, 0.1)) / 3, 0, 1);

  const hs = historyStats(history);
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
  let stability = 1;
  if (hs && hs.medianAsk && hs.medianBid) {
    const devAsk = Math.abs(bestAsk - hs.medianAsk) / hs.medianAsk;
    const devBid = Math.abs(bestBid - hs.medianBid) / hs.medianBid;
    const dev = Math.max(devAsk, devBid);
    stability = dev <= 0.1 ? 1 : clamp(1 - (dev - 0.1) * 1.5, 0.25, 1);
    if (bestAsk > hs.medianAsk * 1.3) flags.push({ key: "spike", level: "bad", label: "Price spike", tip: `Ask is ${pct(bestAsk / hs.medianAsk - 1)} above its recent median. Likely manipulation; it may crash before you sell.` });
    else if (bestBid < hs.medianBid * 0.7) flags.push({ key: "crash", level: "warn", label: "Price crash", tip: `Bid is ${pct(1 - bestBid / hs.medianBid)} below its recent median.` });
  }
  if (totalOrders > 0 && competition > 0.75) flags.push({ key: "crowded", level: "warn", label: "Crowded", tip: "Lots of orders for the volume. Expect to be undercut constantly." });
  const npc = meta.npcSell || 0;
  if (npc > 0 && npc >= buyAt * 0.98) flags.push({ key: "floor", level: "good", label: "NPC floor", tip: `NPCs buy this for ${npc}, close to or above your buy price, which limits your downside.` });

  // Confidence 0..1: how much we trust the paper profit to be real.
  const volConf = clamp(Math.sqrt(flowHr / 30), 0.05, 1);
  const spreadConf = spreadRatio > 4 ? 0.05 : marginPct <= 0.3 ? 1 : clamp(0.3 / marginPct, 0.1, 1);
  const compConf = 1 - 0.5 * competition;
  const balanceConf = 0.6 + 0.4 * Math.sqrt(balance);
  const confidence = volConf * spreadConf * compConf * balanceConf * stability;
  const adjProfitHr = profitHr * confidence;

  const npcProfit = npc > 0 ? npc - buyAt : 0;
  const npcProfitHr = npcProfit > 0 ? npcProfit * Math.min(instaSellsHr * capture, orderQty) : 0;

  return {
    id,
    name: meta.name || prettyId(id),
    category: meta.category || categoryOf(id),
    tier: meta.tier || null,
    bestBid, bestAsk, buyAt, sellAt, netSell, taxPerUnit,
    margin, marginPct, spreadRatio,
    instaSellsHr, instaBuysHr, flowHr, marketProfitHr,
    orderQty, unitsHr, profitHr, profitPerOrder, buyFillHrs, sellFillHrs,
    buyOrders: q.buyOrders || 0, sellOrders: q.sellOrders || 0, totalOrders,
    crowdBid, crowdAsk, competition, balance,
    confidence, adjProfitHr, flags,
    risky: flags.some((f) => f.level === "bad"),
    npcSell: npc, npcProfit, npcProfitHr,
    history: hs,
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

import test from "node:test";
import assert from "node:assert/strict";
import { analyzeProduct, analyzeAll, analyzeCrafts, planFlips, mayorEffects, rank, prettyId, buildMeta, DEFAULT_SETTINGS } from "../assets/js/analysis.js";
import { appendSnapshot, seriesFor, mergedSeries, EMPTY_HISTORY } from "../assets/js/history.js";

// bid = best buy order (sell_summary), ask = best sell offer (buy_summary)
function product({ bid = 100, ask = 120, instaSellWeek = 16800, instaBuyWeek = 16800, buyOrders = 10, sellOrders = 10 } = {}) {
  return {
    sell_summary: bid ? [{ amount: 500, pricePerUnit: bid, orders: 2 }, { amount: 900, pricePerUnit: bid - 1, orders: 3 }] : [],
    buy_summary: ask ? [{ amount: 400, pricePerUnit: ask, orders: 1 }, { amount: 800, pricePerUnit: ask + 1, orders: 4 }] : [],
    quick_status: { sellMovingWeek: instaSellWeek, buyMovingWeek: instaBuyWeek, buyOrders, sellOrders, sellVolume: 1400, buyVolume: 1200 },
  };
}

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("prices are one tick inside the spread and margin is after sell tax", () => {
  const r = analyzeProduct("X", product({ bid: 100, ask: 120 }), DEFAULT_SETTINGS);
  near(r.buyAt, 100.1);
  near(r.sellAt, 119.9);
  near(r.margin, 119.9 * (1 - 0.0125) - 100.1);
  near(r.marginPct, r.margin / 100.1);
});

test("lower tax (Bazaar Flipper) increases margin", () => {
  const a = analyzeProduct("X", product(), { ...DEFAULT_SETTINGS, tax: 0.0125 });
  const b = analyzeProduct("X", product(), { ...DEFAULT_SETTINGS, tax: 0.01 });
  assert.ok(b.margin > a.margin);
});

test("volume is limited by the slower side of the flip", () => {
  const r = analyzeProduct("X", product({ instaSellWeek: 1680, instaBuyWeek: 16800 }), DEFAULT_SETTINGS);
  near(r.instaSellsHr, 10);
  near(r.instaBuysHr, 100);
  near(r.flowHr, 10);
});

test("profit/hr respects volume share and budget", () => {
  const s = { ...DEFAULT_SETTINGS, capture: 0.1, budget: 1e9 };
  const r = analyzeProduct("X", product({ instaSellWeek: 168000, instaBuyWeek: 168000 }), s); // 1000/hr
  near(r.unitsHr, 100);
  near(r.profitHr, r.margin * 100);
  const poor = analyzeProduct("X", product({ instaSellWeek: 168000, instaBuyWeek: 168000 }), { ...s, budget: 1001 });
  assert.equal(poor.orderQty, 10);
  near(poor.unitsHr, 10);
  const broke = analyzeProduct("X", product(), { ...s, budget: 50 });
  assert.equal(broke.orderQty, 0);
  assert.equal(broke.profitHr, 0);
});

test("one-sided books are skipped", () => {
  assert.equal(analyzeProduct("X", product({ bid: 0 })), null);
  assert.equal(analyzeProduct("X", product({ ask: 0 })), null);
});

test("lowball bids are flagged as a dead spread and hidden by default", () => {
  const r = analyzeProduct("X", product({ bid: 0.1, ask: 5000 }), DEFAULT_SETTINGS);
  assert.ok(r.flags.some((f) => f.key === "wide"));
  assert.ok(r.risky);
  const ranked = rank([r], "best", DEFAULT_SETTINGS);
  assert.equal(ranked.length, 0);
  assert.equal(rank([r], "best", DEFAULT_SETTINGS, { hideRisky: false }).length, 1);
});

test("price spike vs history is flagged and lowers confidence", () => {
  const now = Date.now();
  const hist = Array.from({ length: 24 }, (_, i) => ({ t: now - (24 - i) * 3600e3, bid: 100, ask: 110 }));
  const calm = analyzeProduct("X", product({ bid: 100, ask: 110 }), DEFAULT_SETTINGS, {}, hist);
  const spiked = analyzeProduct("X", product({ bid: 100, ask: 200 }), DEFAULT_SETTINGS, {}, hist);
  assert.ok(spiked.flags.some((f) => f.key === "spike"));
  assert.ok(spiked.confidence < calm.confidence);
});

test("NPC flips use npc_sell_price with no tax", () => {
  const r = analyzeProduct("X", product({ bid: 100, ask: 120 }), DEFAULT_SETTINGS, { npcSell: 110 });
  near(r.npcProfit, 110 - 100.1);
  assert.ok(r.npcProfitHr > 0);
  assert.ok(r.flags.some((f) => f.key === "floor"));
});

test("analyzeAll scores relative to the best flip", () => {
  const out = analyzeAll({ products: { A: product({ ask: 130 }), B: product({ ask: 110 }) } }, DEFAULT_SETTINGS);
  const a = out.find((r) => r.id === "A");
  assert.equal(a.score, 100);
  assert.ok(out.find((r) => r.id === "B").score < 100);
});

test("names", () => {
  assert.equal(prettyId("ENCHANTMENT_SHARPNESS_5"), "Sharpness V");
  assert.equal(prettyId("ENCHANTMENT_ULTIMATE_CHIMERA_1"), "Chimera I");
  assert.equal(prettyId("ENCHANTMENT_ULTIMATE_WISE_3"), "Ultimate Wise III");
  assert.equal(prettyId("ESSENCE_WITHER"), "Wither Essence");
  assert.equal(prettyId("SHARD_APEX_DRAGON"), "Apex Dragon Shard");
  assert.equal(prettyId("ENCHANTED_DIAMOND"), "Enchanted Diamond");
  const meta = buildMeta({ items: [{ id: "RED_GIFT", name: "§cRed Gift", tier: "RARE", npc_sell_price: 5 }] });
  assert.deepEqual(meta.RED_GIFT, { name: "Red Gift", category: "Materials", tier: "RARE", npcSell: 5 });
});

test("history snapshots append, skip too-frequent points, and trim", () => {
  const bz = (bid, ask) => ({ products: { A: product({ bid, ask }) } });
  let h = EMPTY_HISTORY();
  h = appendSnapshot(h, bz(100, 120), { t: 0 });
  h = appendSnapshot(h, bz(101, 121), { t: 60e3 }); // too soon -> skipped
  h = appendSnapshot(h, bz(102, 122), { t: 3600e3 });
  assert.equal(h.t.length, 2);
  assert.deepEqual(seriesFor(h, "A").map((p) => p.bid), [100, 102]);
  for (let i = 2; i < 10; i++) h = appendSnapshot(h, bz(100 + i, 120 + i), { t: i * 3600e3, maxPoints: 5 });
  assert.equal(h.t.length, 5);
  assert.equal(h.p.A.length, 10);
  const local = appendSnapshot(EMPTY_HISTORY(), bz(1, 2), { t: 9 * 3600e3 + 60e3 });
  assert.equal(mergedSeries([h, local], "A").length, 5); // duplicate hour collapsed
});

test("craft flips: patient vs instant profit and volume limits", () => {
  const bz = { products: {
    ING: product({ bid: 10, ask: 11, instaSellWeek: 168 * 1600 }), // 1600/hr instant-sold
    OUT: product({ bid: 1700, ask: 2000, instaBuyWeek: 168 * 20 }), // 20/hr instant-bought
  } };
  const [c] = analyzeCrafts(bz, { recipes: { OUT: [{ in: { ING: 160 }, out: 1 }] }, reqs: { OUT: "Requires: Ing IV" } }, { ...DEFAULT_SETTINGS, budget: 1e9, capture: 0.5 });
  near(c.cost, 160 * 10.1);
  near(c.margin, 1999.9 * (1 - 0.0125) - 160 * 10.1);
  near(c.instantProfit, 1700 * (1 - 0.0125) - 160 * 11);
  near(c.marketCraftsHr, 10); // ingredient side: 1600/160 = 10 < 20 output side
  near(c.craftsHr, 5);
  assert.equal(c.req, "Requires: Ing IV");
});

test("crafts with an ingredient missing from the bazaar are skipped", () => {
  const bz = { products: { OUT: product() } };
  assert.equal(analyzeCrafts(bz, { recipes: { OUT: [{ in: { NOPE: 1 }, out: 1 }] } }).length, 0);
});

test("planner spends within purse, diversifies, and skips risky items", () => {
  const res = analyzeAll({ products: {
    A: product({ bid: 100, ask: 130, instaSellWeek: 168e4, instaBuyWeek: 168e4 }),
    B: product({ bid: 100, ask: 120, instaSellWeek: 168e4, instaBuyWeek: 168e4 }),
    C: product({ bid: 0.1, ask: 5000, instaSellWeek: 168e4, instaBuyWeek: 168e4 }),
  } }, DEFAULT_SETTINGS);
  const plan = planFlips(res, { purse: 100000, slots: 5, maxShare: 0.5, capture: 0.1, minProfit: 1 });
  assert.ok(plan.invested <= 100000);
  assert.deepEqual(plan.picks.map((p) => p.r.id), ["A", "B"]);
  for (const p of plan.picks) assert.ok(p.cost <= 50000 + 1e-6);
});

test("mayor effects: Derpy quadruples tax, others pass through", () => {
  const derpy = mayorEffects({ mayor: { name: "Derpy", perks: [{ name: "QUAD TAXES!!!", description: "§7Quadruples taxes on the Auction House and Bazaar." }], minister: { name: "Diaz", perk: { name: "Shopping Spree", description: "x" } } } });
  assert.equal(derpy.taxMult, 4);
  assert.equal(derpy.minister, "Diaz");
  assert.equal(derpy.notes[0].applied, true);
  const diaz = mayorEffects({ mayor: { name: "Diaz", perks: [{ name: "Volume Trading", description: "Shen" }] } });
  assert.equal(diaz.taxMult, 1);
  assert.equal(diaz.notes.length, 0);
  assert.equal(mayorEffects(null).taxMult, 1);
});

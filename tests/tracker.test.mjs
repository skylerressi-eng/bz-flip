import test from "node:test";
import assert from "node:assert/strict";
import { newEntry, newFusionEntry, repriceInput, trackStatus, trackerTotals, profitOf, unitsOf } from "../assets/js/tracker.js";

const r = { id: "X", name: "Thing", buyAt: 100.1, sellAt: 119.9 };
const tax = 0.0125;

test("buy order on top vs outbid", () => {
  const e = newEntry(r, { qty: 10, tax, now: 1 });
  assert.equal(trackStatus(e, () => ({ bestBid: 100.1, bestAsk: 120 })).key, "top"); // our own order is the best bid
  const s = trackStatus(e, () => ({ bestBid: 101, bestAsk: 120 }));
  assert.equal(s.key, "outbid");
  assert.equal(s.price, 101.1);
  assert.equal(s.field, "buyPrice");
  assert.equal(trackStatus(e, () => ({ bestBid: 118, bestAsk: 119 })).key, "outbid-dead");
});

test("sell offer undercut, and refusing to relist below break-even", () => {
  const e = { ...newEntry(r, { qty: 10, tax, now: 1 }), stage: "selling" };
  assert.equal(trackStatus(e, () => ({ bestBid: 100, bestAsk: 119.9 })).key, "top");
  const s = trackStatus(e, () => ({ bestBid: 100, bestAsk: 115 }));
  assert.equal(s.key, "undercut");
  assert.equal(s.price, 114.9);
  assert.equal(trackStatus(e, () => ({ bestBid: 99, bestAsk: 101 })).key, "undercut-loss");
});

test("totals: realized vs open", () => {
  const now = 10 * 86400e3;
  const done = { ...newEntry(r, { qty: 10, tax, now }), stage: "done", soldPrice: 120, soldAt: now - 3600e3 };
  const old = { ...done, key: "old", soldAt: now - 3 * 86400e3 };
  const buying = newEntry(r, { qty: 5, tax, now });
  const t = trackerTotals([done, old, buying], now);
  const p = (120 * (1 - tax) - 100.1) * 10;
  assert.ok(Math.abs(t.realized - 2 * p) < 1e-6);
  assert.ok(Math.abs(t.realized24 - p) < 1e-6);
  assert.ok(Math.abs(t.inOrders - 5 * 100.1) < 1e-6);
  assert.equal(t.open, 1);
  assert.equal(t.flips, 2);
  assert.ok(Math.abs(profitOf(buying) - (119.9 * (1 - tax) - 100.1) * 5) < 1e-6);
});

test("fusion entries: watch every input, then the output", () => {
  const c = { id: "SHARD_O", name: "O Shard", count: 2, sellAt: 999.9, cost: 5 * 100.1 + 2 * 300.1,
    inputs: [{ id: "SHARD_A", name: "A Shard", qty: 5, orderPrice: 100.1 }, { id: "SHARD_B", name: "B Shard", qty: 2, orderPrice: 300.1 }] };
  const e = newFusionEntry(c, { qty: 10, tax, now: 1 });
  const book = { SHARD_A: { bestBid: 100.1, bestAsk: 110 }, SHARD_B: { bestBid: 300.1, bestAsk: 320 }, SHARD_O: { bestBid: 900, bestAsk: 999.9 } };
  assert.equal(trackStatus(e, (id) => book[id]).key, "top");
  book.SHARD_B = { bestBid: 305, bestAsk: 320 };
  const s = trackStatus(e, (id) => book[id]);
  assert.equal(s.key, "outbid");
  assert.equal(s.field, "input:SHARD_B");
  assert.equal(s.price, 305.1);
  repriceInput(e, "SHARD_B", s.price);
  assert.ok(Math.abs(e.buyPrice - (5 * 100.1 + 2 * 305.1)) < 1e-9);
  assert.equal(trackStatus(e, (id) => book[id]).key, "top");
  assert.equal(unitsOf(e), 20);
  assert.ok(Math.abs(profitOf(e) - (999.9 * (1 - tax) * 2 - e.buyPrice) * 10) < 1e-6);
  const selling = { ...e, stage: "selling" };
  book.SHARD_O = { bestBid: 900, bestAsk: 950 };
  assert.equal(trackStatus(selling, (id) => book[id]).key, "undercut");
});

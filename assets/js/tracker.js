// "My flips": orders the user has actually placed, checked against the live
// order book on every refresh. Pure functions; the app owns storage and UI.
//
// entry: { key, id, name, qty, buyPrice, sellPrice, stage: "buying" | "selling" | "done",
//          created, filledAt?, soldAt?, soldPrice?, tax }

const round1 = (n) => Math.round(n * 10) / 10;
const EPS = 0.05; // prices are in 0.1 steps; anything closer is "the same price"

export function newEntry(r, { qty, tax, now = Date.now() }) {
  return {
    key: `${r.id}-${now.toString(36)}`,
    id: r.id,
    name: r.name,
    qty,
    buyPrice: r.buyAt,
    sellPrice: r.sellAt,
    stage: "buying",
    created: now,
    tax,
  };
}

export const profitOf = (e, sellPrice = e.soldPrice ?? e.sellPrice) => (sellPrice * (1 - e.tax) - e.buyPrice) * e.qty;

// What the user should do about this order right now.
// top: { bestBid, bestAsk } from the live bazaar (undefined if the item vanished).
export function trackStatus(e, top) {
  if (e.stage === "done") return { key: "done", level: "info", text: `Sold · ${signed(profitOf(e))} profit` };
  if (!top || !top.bestBid || !top.bestAsk) return { key: "unknown", level: "warn", text: "No live price for this item right now." };
  const breakEven = e.buyPrice / (1 - e.tax);
  if (e.stage === "buying") {
    if (top.bestBid > e.buyPrice + EPS) {
      const price = round1(top.bestBid + 0.1);
      const stillProfitable = round1(top.bestAsk - 0.1) * (1 - e.tax) > price;
      return stillProfitable
        ? { key: "outbid", level: "bad", text: `Outbid: someone is buying at ${fmt(top.bestBid)}. Cancel and re-order at ${fmt(price)}.`, price, field: "buyPrice" }
        : { key: "outbid-dead", level: "bad", text: `Outbid at ${fmt(top.bestBid)}, and outbidding again would leave no margin. Consider cancelling.` };
    }
    return { key: "top", level: "good", text: "Your buy order is on top. Waiting for it to fill." };
  }
  // selling
  if (top.bestAsk < e.sellPrice - EPS) {
    const price = round1(top.bestAsk - 0.1);
    return price > breakEven
      ? { key: "undercut", level: "bad", text: `Undercut: someone is selling at ${fmt(top.bestAsk)}. Relist at ${fmt(price)} (${signed(profitOf(e, price))} total).`, price, field: "sellPrice" }
      : { key: "undercut-loss", level: "bad", text: `Undercut to ${fmt(top.bestAsk)}, which is below your break-even of ${fmt(breakEven)}. Waiting is probably better than relisting.` };
  }
  return { key: "top", level: "good", text: `Your sell offer is the cheapest. ${signed(profitOf(e))} when it sells.` };
}

export function trackerTotals(entries, now = Date.now()) {
  const day = now - 24 * 3600e3;
  let realized = 0, realized24 = 0, inOrders = 0, inItems = 0, expected = 0, flips = 0;
  for (const e of entries) {
    if (e.stage === "done") {
      const p = profitOf(e);
      realized += p;
      flips++;
      if ((e.soldAt || 0) >= day) realized24 += p;
    } else {
      if (e.stage === "buying") inOrders += e.qty * e.buyPrice;
      else inItems += e.qty * e.buyPrice;
      expected += profitOf(e);
    }
  }
  return { realized, realized24, inOrders, inItems, expected, flips, open: entries.filter((e) => e.stage !== "done").length };
}

function fmt(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function signed(n) {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(1)}k` : Math.round(a).toLocaleString("en-US");
  return `${n < 0 ? "−" : "+"}${s}`;
}

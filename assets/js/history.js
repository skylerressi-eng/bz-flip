// Compact hourly price history. The Hypixel API has no history endpoint, so we
// record our own snapshots (server-side via the hourly GitHub Action, and
// locally in the browser while the page is open).
//
// Format: { v: 1, t: [ms, ...], p: { ID: [bid0, ask0, bid1, ask1, ...] } }
// Each product array is aligned with `t`; 0 means "no data at that time".

export const EMPTY_HISTORY = () => ({ v: 1, t: [], p: {} });

const r1 = (n) => Math.round(n * 10) / 10;

export function isHistory(h) {
  return !!h && h.v === 1 && Array.isArray(h.t) && h.p && typeof h.p === "object";
}

// Append one bazaar response as a snapshot. Only products that actually trade
// (>= minFlow units/hour) are kept, which keeps the file small.
export function appendSnapshot(history, bazaar, { t = bazaar.lastUpdated || Date.now(), maxPoints = 168, minFlow = 0.5, minGapMs = 20 * 60e3 } = {}) {
  const h = isHistory(history) ? history : EMPTY_HISTORY();
  const lastT = h.t[h.t.length - 1];
  if (lastT != null && t - lastT < minGapMs) return h; // too soon, skip

  const idx = h.t.length;
  h.t.push(t);
  for (const [id, prod] of Object.entries(bazaar.products || {})) {
    const q = prod.quick_status || {};
    const flow = Math.min(q.sellMovingWeek || 0, q.buyMovingWeek || 0) / 168;
    const bid = prod.sell_summary?.[0]?.pricePerUnit || 0;
    const ask = prod.buy_summary?.[0]?.pricePerUnit || 0;
    if (flow < minFlow && !h.p[id]) continue;
    if (!h.p[id]) h.p[id] = new Array(idx * 2).fill(0);
    h.p[id].push(r1(bid), r1(ask));
  }
  // pad products that were missing from this snapshot
  for (const arr of Object.values(h.p)) while (arr.length < h.t.length * 2) arr.push(0);
  return trim(h, maxPoints);
}

export function trim(h, maxPoints) {
  const drop = h.t.length - maxPoints;
  if (drop <= 0) return h;
  h.t = h.t.slice(drop);
  for (const id of Object.keys(h.p)) {
    h.p[id] = h.p[id].slice(drop * 2);
    if (h.p[id].every((x) => x === 0)) delete h.p[id];
  }
  return h;
}

// -> [{ t, bid, ask }] oldest first, skipping empty points
export function seriesFor(h, id) {
  if (!isHistory(h) || !h.p[id]) return [];
  const arr = h.p[id];
  const out = [];
  for (let i = 0; i < h.t.length; i++) {
    const bid = arr[i * 2], ask = arr[i * 2 + 1];
    if (bid > 0 && ask > 0) out.push({ t: h.t[i], bid, ask });
  }
  return out;
}

// Merge several histories into per-product series, de-duplicating points that
// fall within `gapMs` of each other (earlier sources win).
export function mergedSeries(histories, id, gapMs = 20 * 60e3) {
  const pts = histories.flatMap((h) => seriesFor(h, id)).sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of pts) if (!out.length || p.t - out[out.length - 1].t >= gapMs) out.push(p);
  return out;
}

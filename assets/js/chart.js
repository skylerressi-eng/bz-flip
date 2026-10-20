// Tiny dependency-free SVG line chart for bid/ask history with a hover readout.
import { price, coins } from "./format.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function renderPriceChart(box, series) {
  if (!series || series.length < 2) {
    box.innerHTML = `<div class="chart-empty">Not enough price history yet. A snapshot is saved every hour, so the chart fills in as data comes in.</div>`;
    return;
  }
  const W = Math.max(280, box.clientWidth - 20);
  const H = 190;
  const pad = { l: 52, r: 8, t: 10, b: 22 };
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  let lo = Infinity, hi = -Infinity;
  for (const p of series) { lo = Math.min(lo, p.bid, p.ask); hi = Math.max(hi, p.bid, p.ask); }
  const span = hi - lo || hi * 0.05 || 1;
  lo = Math.max(0, lo - span * 0.08); hi += span * 0.08;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const path = (k) => series.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  const area = `${path("ask")}L${x(t1)},${y(series[series.length - 1].bid)}${series.slice().reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.bid).toFixed(1)}`).join("")}Z`;

  const green = css("--green"), red = css("--red"), line = css("--line"), faint = css("--faint"), gold = css("--gold");
  const ticks = [0, 0.5, 1].map((f) => lo + (hi - lo) * (1 - f));
  const hours = (t1 - t0) / 3600e3;
  const tfmt = (t) => {
    const d = new Date(t);
    return hours > 36 ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="height:${H}px" role="img" aria-label="Buy order and sell offer price history">
      ${ticks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="${line}" stroke-dasharray="3 4"/>
        <text x="${pad.l - 6}" y="${y(v) + 4}" fill="${faint}" font-size="10.5" text-anchor="end" stroke="none">${coins(v)}</text>`).join("")}
      <text x="${pad.l}" y="${H - 5}" fill="${faint}" font-size="10.5" stroke="none">${tfmt(t0)}</text>
      <text x="${W - pad.r}" y="${H - 5}" fill="${faint}" font-size="10.5" text-anchor="end" stroke="none">${tfmt(t1)}</text>
      <path d="${area}" fill="${gold}" fill-opacity="0.08" stroke="none"/>
      <path d="${path("ask")}" stroke="${red}" stroke-width="2" fill="none"/>
      <path d="${path("bid")}" stroke="${green}" stroke-width="2" fill="none"/>
      <line class="hair" y1="${pad.t}" y2="${H - pad.b}" stroke="${faint}" stroke-dasharray="2 3" visibility="hidden"/>
      <circle class="dot-a" r="3.5" fill="${red}" stroke="none" visibility="hidden"/>
      <circle class="dot-b" r="3.5" fill="${green}" stroke="none" visibility="hidden"/>
      <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent" stroke="none" class="hit"/>
    </svg>
    <div class="chart-legend"><span><i style="background:${red}"></i>Lowest sell offer</span><span><i style="background:${green}"></i>Highest buy order</span><span class="muted">${series.length} snapshots</span></div>
    <div class="chart-tip" hidden></div>`;

  const svg = box.querySelector("svg");
  const tip = box.querySelector(".chart-tip");
  const hair = svg.querySelector(".hair"), da = svg.querySelector(".dot-a"), db = svg.querySelector(".dot-b");
  const show = (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const tt = t0 + ((sx - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
    let best = series[0];
    for (const p of series) if (Math.abs(p.t - tt) < Math.abs(best.t - tt)) best = p;
    const px = x(best.t);
    for (const el of [hair, da, db]) el.setAttribute("visibility", "visible");
    hair.setAttribute("x1", px); hair.setAttribute("x2", px);
    da.setAttribute("cx", px); da.setAttribute("cy", y(best.ask));
    db.setAttribute("cx", px); db.setAttribute("cy", y(best.bid));
    tip.hidden = false;
    tip.style.left = `${(px / W) * r.width + 10}px`;
    tip.style.top = `${(y(best.ask) / H) * r.height + 10}px`;
    tip.innerHTML = `${new Date(best.t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}<br><span style="color:${red}">ask ${price(best.ask)}</span><br><span style="color:${green}">bid ${price(best.bid)}</span>`;
  };
  const hide = () => { for (const el of [hair, da, db]) el.setAttribute("visibility", "hidden"); tip.hidden = true; };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerleave", hide);
}

// Inline sparkline for table rows: green when the latest value is up on the first.
export function sparkline(values, w = 72, h = 24) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`);
  const up = values[values.length - 1] >= values[0];
  const change = values[0] ? (values[values.length - 1] - values[0]) / values[0] : 0;
  return `<svg class="spark ${up ? "up" : "down"}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="24h ${up ? "up" : "down"} ${Math.abs(change * 100).toFixed(1)}%"><polyline points="${pts.join(" ")}"/></svg>`;
}

export function coins(n, { digits } = {}) {
  if (!Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const fmt = (v, u) => {
    const d = digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2);
    return sign + v.toFixed(d).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1") + u;
  };
  if (a >= 1e9) return fmt(a / 1e9, "B");
  if (a >= 1e6) return fmt(a / 1e6, "M");
  if (a >= 1e4) return fmt(a / 1e3, "k");
  return sign + a.toLocaleString("en-US", { maximumFractionDigits: a < 10 ? 2 : 1 });
}

// exact bazaar price, e.g. 1,234,567.8
export function price(n) {
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function int(n) {
  if (!Number.isFinite(n)) return "–";
  return Math.round(n).toLocaleString("en-US");
}

export function pct(x, digits = 1) {
  if (!Number.isFinite(x)) return "–";
  const v = x * 100;
  const d = Math.abs(v) >= 100 ? 0 : digits;
  return `${v.toFixed(d)}%`;
}

export function rate(n) {
  if (!Number.isFinite(n)) return "–";
  if (n < 10) return n.toFixed(1);
  return coins(n);
}

export function duration(hours) {
  if (!Number.isFinite(hours)) return "never";
  if (hours < 1 / 60) return "< 1m";
  if (hours < 1) return `~${Math.round(hours * 60)}m`;
  if (hours < 48) return `~${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  return `~${Math.round(hours / 24)}d`;
}

export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function parseCoins(str) {
  const m = String(str).trim().toLowerCase().replace(/[, _]/g, "").match(/^(\d*\.?\d+)([kmb]?)$/);
  if (!m) return NaN;
  return Number(m[1]) * { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]];
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

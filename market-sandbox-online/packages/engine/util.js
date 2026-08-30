function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, items) => items[Math.floor(rng() * items.length)];
const range = (rng, min, max) => min + rng() * (max - min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const money = (v, d = 2) =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`;
const signed = (v, d = 2) =>
  `${v >= 0 ? "+" : "-"}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`;
const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
const signedPct = (v, d = 2) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const clock = (ms) => {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

module.exports = { mulberry32, pick, range, clamp, money, signed, pct, signedPct, clock };

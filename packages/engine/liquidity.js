const { CONFIG, scaleOf } = require("./config");

/* ----------------------------- LIQUIDITY ENGINE ---------------------------
   Влияет ТОЛЬКО на цену исполнения, никогда не блокирует выход.
--------------------------------------------------------------------------- */
function computeLiquidity(state) {
  let freeCash = 0;
  let openInterest = 0;
  for (const p of state.players) {
    freeCash += p.cash;
    if (p.position) openInterest += p.position.units * state.price;
  }
  const scale = scaleOf(state);
  const raw =
    CONFIG.liquidity.base * scale +
    freeCash * CONFIG.liquidity.freeCashWeight +
    Math.max(0, state.poolCash) * CONFIG.liquidity.poolWeight;
  const saturation = 1 + CONFIG.liquidity.openInterestPenalty * (openInterest / Math.max(1, state.totalCapital));
  return Math.max(CONFIG.liquidity.min * scale, raw / saturation);
}

function executionPrice(ref, notional, liquidity, direction, scale = 1) {
  const magnitude = Math.min(
    CONFIG.impact.maxImpact,
    (CONFIG.impact.coefficient * Math.abs(notional)) / Math.max(liquidity, CONFIG.liquidity.min * scale)
  );
  return Math.max(CONFIG.market.minPrice, ref * (1 + magnitude * direction));
}

module.exports = { computeLiquidity, executionPrice };

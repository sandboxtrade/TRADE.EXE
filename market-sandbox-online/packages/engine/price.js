const { CONFIG } = require("./config");

/* ------------------------------- PRICE ENGINE ------------------------------
   netPressure = buyPressure − sellPressure
   impulse     = netPressure / liquidity
   return      = maxTickMove · tanh(impulse / sensitivity)
   newPrice    = price · (1 + return)
--------------------------------------------------------------------------- */
function decayPressure(previous, incoming, scale = 1) {
  const next = previous * CONFIG.price.pressureDecay + incoming;
  return next < CONFIG.price.pressureFloor * scale ? 0 : next;
}

function nextPrice({ price, buyPressure, sellPressure, liquidity, scale = 1 }) {
  const netPressure = buyPressure - sellPressure;
  const safeLiquidity = Math.max(liquidity, CONFIG.liquidity.min * scale);
  const impulse = netPressure / safeLiquidity;
  const returnRate = CONFIG.price.maxTickMove * Math.tanh(impulse / CONFIG.price.sensitivity);
  return { price: Math.max(CONFIG.market.minPrice, price * (1 + returnRate)), returnRate, netPressure, impulse };
}

module.exports = { decayPressure, nextPrice };

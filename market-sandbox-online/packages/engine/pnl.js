const { CONFIG } = require("./config");

/* -------------------------------- PNL ENGINE ------------------------------
   settlementValue — сколько игрок получит, закрыв позицию прямо сейчас.
--------------------------------------------------------------------------- */
function settlementValue(pos, price) {
  if (pos.side === "long") return pos.units * price;
  return Math.max(0, pos.margin + (pos.entryPrice - price) * pos.units);
}
const unrealizedPnL = (p, price) => (p.position ? settlementValue(p.position, price) - p.position.margin : 0);
const equityOf = (p, price) => p.cash + (p.position ? settlementValue(p.position, price) : 0);
const isLiquidatable = (pos, price) =>
  pos.side === "short" && settlementValue(pos, price) <= pos.margin * CONFIG.risk.shortLiquidationRatio;

function aggregate(state) {
  let totalEquity = 0, totalCash = 0, longExposure = 0, shortExposure = 0;
  let longPlayers = 0, shortPlayers = 0, settlementTotal = 0;
  for (const p of state.players) {
    totalCash += p.cash;
    totalEquity += equityOf(p, state.price);
    if (p.position) {
      settlementTotal += settlementValue(p.position, state.price);
      const exposure = p.position.units * state.price;
      if (p.position.side === "long") { longExposure += exposure; longPlayers++; }
      else { shortExposure += exposure; shortPlayers++; }
    }
  }
  const directional = longPlayers + shortPlayers;
  return {
    totalEquity, totalCash, longExposure, shortExposure, longPlayers, shortPlayers,
    flatPlayers: state.players.length - directional,
    activePositions: directional,
    poolEquity: state.poolCash - settlementTotal,
    marketCap: state.price * CONFIG.market.totalPlayers,
    longShare: directional === 0 ? 0 : longPlayers / directional,
    shortShare: directional === 0 ? 0 : shortPlayers / directional,
  };
}

module.exports = { settlementValue, unrealizedPnL, equityOf, isLiquidatable, aggregate };

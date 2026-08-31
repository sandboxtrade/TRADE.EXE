/**
 * Ядро ценообразования. Перенесено из market-sandbox.jsx без изменения логики
 * (см. ARCHITECTURE.md, раздел 6). Импортируется и клиентом, и Cloud Functions,
 * и тик-процессом на Cloud Run — это ЕДИНСТВЕННОЕ место, где живут эти числа.
 */

const CONFIG = {
  market: {
    assetSymbol: "SIM",
    totalPlayers: 100,
    startingCapital: 100,
    capitalOptions: [100, 500, 1000, 10000],
    initialPrice: 100,
    tickMs: 100,
    minPrice: 0.01,
  },
  price: { maxTickMove: 0.02, sensitivity: 0.12, pressureDecay: 0.45, pressureFloor: 0.01 },
  liquidity: { base: 250, freeCashWeight: 0.45, poolWeight: 0.35, openInterestPenalty: 0.9, min: 120 },
  impact: { coefficient: 0.1, maxImpact: 0.02 },
  risk: { shortLiquidationRatio: 0.05 },
  history: { maxPoints: 6000 },
};

const REFERENCE_CAPITAL = CONFIG.market.totalPlayers * CONFIG.market.startingCapital;

/**
 * Масштаб сессии — см. оригинальный комментарий в market-sandbox.jsx.
 * Абсолютные константы движка откалиброваны под рынок в $10 000; при
 * другом размере сессии их нужно домножать на scale.
 */
const scaleOf = (state) => state.totalCapital / REFERENCE_CAPITAL;
const minTrade = (state) => 0.5 * scaleOf(state);

/** Локальный практический режим — один человек. В онлайн-режиме playerId
 *  участника назначается при входе в комнату (обычно Firebase uid). */
const HUMAN_ID = "p-000";

module.exports = { CONFIG, REFERENCE_CAPITAL, scaleOf, minTrade, HUMAN_ID };

"use strict";
/**
 * ГРАНИЦА КЛИЕНТ/СЕРВЕР. Всё, чего нет в снапшоте, клиент знать не должен.
 *
 * КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ СТАРОГО ДВИЖКА: раздельно отдаются mark и closeValue.
 * units * mark НЕ передаётся и не должен считаться на клиенте — эта величина
 * не является суммой денег (FINAL-AUDIT-V3, часть 1).
 */
function projectPlayer(m, pl, { viewer, devMode }) {
  const out = {
    id: pl.id, name: pl.name, isHuman: pl.isHuman,
    archetype: pl.npc ? pl.npc.type : null,
    cash: pl.cash,
    equity: m.equity(pl.id),
    closeValue: m.settlement(pl.id),
    unrealized: m.unrealized(pl.id),
    realizedPnL: pl.realizedPnL,
    tradeCount: pl.tradeCount,
    position: pl.u === 0 ? null : {
      side: pl.u > 0 ? "long" : "short",
      units: Math.abs(pl.u),
      invested: pl.invested,
      entryPrice: pl.entryPrice,
    },
  };
  if (viewer) { out.stopLoss = pl.stopLoss; out.takeProfit = pl.takeProfit;
    out.limits = pl.limits || []; }
  if (devMode && pl.npc) out.debug = { type: pl.npc.type, lag: pl.npc.lag,
    size: pl.npc.size, act: pl.npc.act };
  return out;
}

function createSnapshot(m, viewerId, { level = "full", devMode = false } = {}) {
  const snap = {
    tick: m.tick,
    mark: m.mark,                       // цена рынка (график)
    liquidationPrice: m.liquidationPrice, // цена, по которой считается closeValue
    Q: m.Q,
    priceRange: [m.curve.PMIN, m.curve.PMAX],
    escrow: m.escrow,
    totalCapital: m.C,
  };
  const me = m.players.find((p) => p.id === viewerId);
  if (me) snap.you = projectPlayer(m, me, { viewer: true, devMode });
  if (level === "roster" || level === "full") {
    snap.participants = m.players.map((p) =>
      projectPlayer(m, p, { viewer: false, devMode }));
  }
  if (level === "full" && devMode) snap.debug = { sumEquity: m.sumEquity() };
  return snap;
}
module.exports = { createSnapshot, projectPlayer };

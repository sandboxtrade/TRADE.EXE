const { CONFIG } = require("./config");
const { aggregate, equityOf, unrealizedPnL, settlementValue } = require("./pnl");

/**
 * ГРАНИЦА КЛИЕНТ / СЕРВЕР — см. ARCHITECTURE.md.
 * Всё, чего нет в снапшоте, клиент знать не должен и вычислить не может.
 */
function projectPlayer(state, player, { viewer, devMode }) {
  const position = player.position;
  const projected = {
    id: player.id,
    name: player.name,
    isHuman: player.isHuman,
    archetype: player.npc ? player.npc.strategyType : null,
    startingCapital: player.startingCapital,
    cash: player.cash,
    tradeCount: player.tradeCount,
    realizedPnL: player.realizedPnL,
    equity: equityOf(player, state.price),
    unrealized: unrealizedPnL(player, state.price),
    position: position ? {
      side: position.side,
      units: position.units,
      margin: position.margin,
      entryPrice: position.entryPrice,
      openedAtTick: position.openedAtTick,
      settlement: settlementValue(position, state.price),
    } : null,
  };

  if (viewer) {
    projected.stopLoss = player.stopLoss;
    projected.takeProfit = player.takeProfit;
  }

  if (devMode && player.npc) {
    projected.debug = {
      lookback: player.npc.lookback,
      intervalTicks: player.npc.intervalTicks,
      accuracy: player.npc.accuracy,
      lastAction: player.mind.lastAction,
      lastActionTick: player.mind.lastActionTick,
      lastReasons: player.mind.lastReasons,
      wins: player.mind.wins,
      losses: player.mind.losses,
      mistakes: player.mind.mistakes,
      confidence: player.mind.confidence,
      regimeBias: player.mind.regimeBias,
      nextDecisionTick: player.mind.nextDecisionTick,
    };
  }
  return projected;
}

/**
 * level "tick"   — цена, давления, агрегаты толпы и ВАША позиция (~1 КБ, 10/с).
 * level "roster" — список участников (раз в секунду, вкладка «Участники»).
 * level "full"   — всё сразу (вход в комнату / локальный режим).
 * См. ARCHITECTURE.md раздел 2 для замера, обосновавшего это разделение.
 */
function createSnapshot(state, viewerId, { devMode = false, streamLimit = 1200, level = "full" } = {}) {
  const market = aggregate(state);

  if (level === "tick") {
    const you = state.playersById[viewerId]
      ? projectPlayer(state, state.playersById[viewerId], { viewer: true, devMode: false })
      : null;
    // Ранг на тиковом уровне не пересчитывается по всем 100 участникам —
    // дорого гонять на 10 Гц. Обновляется вместе с roster-снапшотом.
    return {
      roomId: state.roomId, tick: state.tick, time: state.time, phase: state.phase,
      price: state.price, previousPrice: state.previousPrice,
      initialPrice: CONFIG.market.initialPrice, symbol: CONFIG.market.assetSymbol,
      buyPressure: state.buyPressure, sellPressure: state.sellPressure,
      netPressure: state.netPressure, liquidity: state.liquidity,
      startingCapital: state.startingCapital, totalCapital: state.totalCapital,
      totalPlayers: state.players.length,
      totalTrades: state.totalTrades,
      market, you,
      yourOrders: state.limitOrders.filter((o) => o.playerId === viewerId),
      lastPoint: state.priceHistory[state.priceHistory.length - 1],
    };
  }

  const players = state.players.map((p) =>
    projectPlayer(state, p, { viewer: p.id === viewerId, devMode })
  );
  const byEquity = [...players].sort((a, b) => b.equity - a.equity);
  const rank = byEquity.findIndex((p) => p.id === viewerId) + 1;
  const you = players.find((p) => p.id === viewerId) ?? null;

  if (level === "roster") {
    return {
      roomId: state.roomId, tick: state.tick, phase: state.phase, price: state.price,
      market, players, rank, you,
      totalPlayers: state.players.length,
    };
  }

  const stream = state.priceHistory.length > streamLimit
    ? state.priceHistory.slice(-streamLimit)
    : state.priceHistory;

  return {
    roomId: state.roomId,
    tick: state.tick,
    time: state.time,
    phase: state.phase,

    price: state.price,
    previousPrice: state.previousPrice,
    initialPrice: CONFIG.market.initialPrice,
    symbol: CONFIG.market.assetSymbol,

    buyPressure: state.buyPressure,
    sellPressure: state.sellPressure,
    netPressure: state.netPressure,
    liquidity: state.liquidity,

    startingCapital: state.startingCapital,
    totalCapital: state.totalCapital,
    totalPlayers: state.players.length,
    totalTrades: state.totalTrades,

    market,
    players,
    rank,
    you,
    yourTrades: state.humanTradesById[viewerId] ?? [],
    yourOrders: state.limitOrders.filter((o) => o.playerId === viewerId),
    orders: state.limitOrders.map((o) => ({
      id: o.id, playerId: o.playerId, side: o.side,
      notional: o.notional, limitPrice: o.limitPrice,
      playerName: state.playersById[o.playerId]?.name ?? o.playerId,
    })),
    priceStream: stream,

    debug: devMode ? {
      context: state.context,
      lastTrades: state.lastTickTrades,
      capitalDrift: state.capitalDrift,
      poolCash: state.poolCash,
    } : null,
  };
}

module.exports = { projectPlayer, createSnapshot };

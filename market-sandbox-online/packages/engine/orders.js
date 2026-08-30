const { HUMAN_ID, minTrade, scaleOf } = require("./config");
const { executionPrice } = require("./liquidity");
const { settlementValue } = require("./pnl");
const { clamp } = require("./util");
const { recordEntry, recordExit } = require("./npc");

/* ------------------------------- ORDER ENGINE -----------------------------
   Единственный модуль, который двигает деньги. Любой перевод — это
   player.cash ↔ poolCash, поэтому сумма никогда не меняется.
--------------------------------------------------------------------------- */
function pushTrade(state, rec) {
  state.lastTickTrades.push(rec);
  state.totalTrades++;
  if (rec.flow === "buy") state.rawBuyPressure += rec.notional;
  else state.rawSellPressure += rec.notional;
  if (state.humanIds && state.humanIds.has(rec.playerId)) {
    if (!state.humanTradesById[rec.playerId]) state.humanTradesById[rec.playerId] = [];
    const list = state.humanTradesById[rec.playerId];
    list.unshift(rec);
    if (list.length > 60) list.pop();
  }
}

function closePosition(state, player, reason, fraction = 1) {
  const pos = player.position;
  if (!pos) return null;

  const f = clamp(fraction, 0, 1);
  const remainingMargin = pos.margin * (1 - f);
  const full = f >= 1 || remainingMargin < minTrade(state);
  const units = full ? pos.units : pos.units * f;
  const margin = full ? pos.margin : pos.margin * f;

  const direction = pos.side === "long" ? -1 : 1;
  const exposure = units * state.price;
  const execPrice = executionPrice(state.price, exposure, state.liquidity, direction, scaleOf(state));
  const payout = settlementValue({ ...pos, units, margin }, execPrice);
  const realized = payout - margin;

  player.cash += payout;
  state.poolCash -= payout;
  player.realizedPnL += realized;
  player.tradeCount++;

  const side = pos.side;
  if (player.mind) recordExit(player, state, realized, full);
  if (full) {
    player.position = null;
    player.stopLoss = null;
    player.takeProfit = null;
  } else {
    pos.units -= units;
    pos.margin -= margin;
  }

  const rec = {
    tick: state.tick, time: state.time, playerId: player.id, playerName: player.name,
    action: "CLOSE", flow: side === "long" ? "sell" : "buy",
    notional: exposure, units, execPrice, realizedPnL: realized,
    reason: full ? reason : `${reason} (частично)`,
  };
  pushTrade(state, rec);
  return rec;
}

function openPosition(state, player, side, requested, reason, stopLoss, takeProfit) {
  const notional = Math.min(requested, player.cash);
  if (notional < minTrade(state)) return null;
  const direction = side === "long" ? 1 : -1;
  const execPrice = executionPrice(state.price, notional, state.liquidity, direction, scaleOf(state));
  const units = notional / execPrice;

  player.cash -= notional;
  state.poolCash += notional;
  player.position = { side, units, entryPrice: execPrice, margin: notional, openedAtTick: state.tick };
  player.stopLoss = stopLoss ?? null;
  player.takeProfit = takeProfit ?? null;
  player.tradeCount++;
  if (player.mind) recordEntry(player, state, notional, side);

  const rec = {
    tick: state.tick, time: state.time, playerId: player.id, playerName: player.name,
    action: side === "long" ? "BUY" : "SELL", flow: side === "long" ? "buy" : "sell",
    notional, units, execPrice, reason,
  };
  pushTrade(state, rec);
  return rec;
}

/**
 * BUY   : шорт → закрыть; вне рынка → открыть лонг; лонг → долить
 * SELL  : лонг → закрыть; вне рынка → открыть шорт; шорт → долить
 * CLOSE : закрыть целиком или частично
 */
function executeIntent(state, intent) {
  const player = state.playersById[intent.playerId];
  if (!player) return;
  if (intent.action === "CLOSE") {
    closePosition(state, player, intent.reason, intent.fraction ?? 1);
    return;
  }

  const desired = intent.action === "BUY" ? "long" : "short";
  if (player.position && player.position.side !== desired) {
    closePosition(state, player, intent.reason);
    return;
  }

  const notional = intent.notional ?? 0;
  if (notional < minTrade(state)) return;

  if (player.position && player.position.side === desired) {
    const prev = player.position;
    const closed = closePosition(state, player, `${intent.reason} (доливка)`);
    const combined = (closed ? closed.notional + (closed.realizedPnL ?? 0) : prev.margin) + notional;
    openPosition(state, player, desired, combined, intent.reason, intent.stopLoss, intent.takeProfit);
    return;
  }
  openPosition(state, player, desired, notional, intent.reason, intent.stopLoss, intent.takeProfit);
}

function triggerLimitOrders(state) {
  if (state.limitOrders.length === 0) return [];
  const triggered = [];
  state.limitOrders = state.limitOrders.filter((o) => {
    const hit = o.side === "buy" ? state.price <= o.limitPrice : state.price >= o.limitPrice;
    if (!hit) return true;
    triggered.push({
      playerId: o.playerId, action: o.side === "buy" ? "BUY" : "SELL",
      notional: o.notional, source: "system", reason: `лимит @ ${o.limitPrice.toFixed(2)}`,
    });
    return false;
  });
  return triggered;
}

module.exports = { pushTrade, closePosition, openPosition, executeIntent, triggerLimitOrders };

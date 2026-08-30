const { minTrade } = require("./config");

/** Проверки, которые обязан выполнять сервер и которым нельзя доверять клиенту. */
function validateCommand(state, playerId, command) {
  const player = state.playersById[playerId];
  if (!player) return { ok: false, reason: "участник не найден" };

  switch (command.type) {
    case "TRADE": {
      if (command.action === "CLOSE") {
        if (!player.position) return { ok: false, reason: "нет открытой позиции" };
        const f = command.fraction ?? 1;
        if (!(f > 0 && f <= 1)) return { ok: false, reason: "неверная доля закрытия" };
        return { ok: true };
      }
      if (command.action !== "BUY" && command.action !== "SELL") {
        return { ok: false, reason: "неизвестное действие" };
      }
      const opposite = player.position &&
        player.position.side !== (command.action === "BUY" ? "long" : "short");
      if (opposite) return { ok: true };

      const notional = Number(command.notional);
      if (!Number.isFinite(notional) || notional <= 0) {
        return { ok: false, reason: "неверный объём" };
      }
      if (notional < minTrade(state)) return { ok: false, reason: "объём ниже минимального" };
      if (notional > player.cash + 1e-9) return { ok: false, reason: "недостаточно средств" };
      return { ok: true };
    }
    case "LIMIT": {
      const price = Number(command.limitPrice);
      const notional = Number(command.notional);
      if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: "неверная цена" };
      if (!Number.isFinite(notional) || notional < minTrade(state)) {
        return { ok: false, reason: "неверный объём" };
      }
      if (notional > player.cash + 1e-9) return { ok: false, reason: "недостаточно средств" };
      if (state.limitOrders.filter((o) => o.playerId === playerId).length >= 10) {
        return { ok: false, reason: "слишком много заявок" };
      }
      return { ok: true };
    }
    case "CANCEL_LIMIT": {
      const order = state.limitOrders.find((o) => o.id === command.orderId);
      if (!order) return { ok: false, reason: "заявка не найдена" };
      if (order.playerId !== playerId) return { ok: false, reason: "чужая заявка" };
      return { ok: true };
    }
    case "PROTECT": {
      if (!player.position) return { ok: false, reason: "нет открытой позиции" };
      for (const value of [command.stopLoss, command.takeProfit]) {
        if (value !== null && value !== undefined && !(Number(value) > 0)) {
          return { ok: false, reason: "неверный уровень" };
        }
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: "неизвестная команда" };
  }
}

module.exports = { validateCommand };

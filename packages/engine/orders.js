"use strict";
/**
 * Преобразование пользовательских команд и отложенных ордеров в НАМЕРЕНИЯ тика.
 * Никакой ордер не исполняется здесь — только в Market.clear(), по единой цене.
 * Поэтому массовое срабатывание стопов не даёт преимущества по порядку.
 */
function validateCommand(m, i, cmd) {
  const pl = m.players[i];
  if (!pl) return { ok: false, reason: "нет такого участника" };
  if (!cmd || typeof cmd !== "object") return { ok: false, reason: "пустая команда" };

  switch (cmd.type) {
    case "TRADE": {
      if (!["BUY", "SELL", "CLOSE"].includes(cmd.action))
        return { ok: false, reason: "неизвестное действие" };
      if (cmd.action === "CLOSE") {
        if (pl.u === 0) return { ok: false, reason: "нет открытой позиции" };
        return { ok: true };
      }
      const n = cmd.notional;
      if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "неверный объём" };
      if (n > pl.cash + 1e-9) return { ok: false, reason: "недостаточно средств" };
      return { ok: true };
    }
    case "PROTECT": {
      if (pl.u === 0) return { ok: false, reason: "нет открытой позиции" };
      return { ok: true };
    }
    case "LIMIT": {
      const n = cmd.notional;
      if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "неверный объём" };
      if (!Number.isFinite(cmd.limitPrice)) return { ok: false, reason: "неверная цена" };
      if (n > pl.cash + 1e-9) return { ok: false, reason: "недостаточно средств" };
      if ((pl.limits || []).length >= 10) return { ok: false, reason: "слишком много заявок" };
      return { ok: true };
    }
    case "CANCEL_LIMIT": return { ok: true };
    default: return { ok: false, reason: "неизвестная команда" };
  }
}

/** Команда игрока -> намерение (du). */
function commandToIntent(m, i, cmd) {
  const pl = m.players[i], P = m.mark;
  if (cmd.type === "TRADE") {
    if (cmd.action === "CLOSE") {
      const frac = Number.isFinite(cmd.fraction) ? Math.min(1, Math.max(0, cmd.fraction)) : 1;
      return { i, du: -pl.u * frac, reason: "close" };
    }
    const units = m.curve.unitsFor(cmd.notional, P);
    const dir = cmd.action === "BUY" ? 1 : -1;
    return { i, du: dir * units, reason: cmd.action.toLowerCase() };
  }
  return null;
}

/** Отложенные: стоп/тейк/лимит -> намерения. Проверяются по mark ПЕРЕД клирингом. */
function pendingIntents(m) {
  const out = [];
  const P = m.mark;
  for (const pl of m.players) {
    if (pl.u !== 0 && pl.entryPrice !== null) {
      const long = pl.u > 0;
      if (pl.stopLoss !== null &&
          ((long && P <= pl.stopLoss) || (!long && P >= pl.stopLoss)))
        out.push({ i: pl.id, du: -pl.u, reason: "stop" });
      else if (pl.takeProfit !== null &&
          ((long && P >= pl.takeProfit) || (!long && P <= pl.takeProfit)))
        out.push({ i: pl.id, du: -pl.u, reason: "take" });
    }
    for (const lo of pl.limits || []) {
      if (lo.filled) continue;
      const hit = lo.side === "BUY" ? P <= lo.limitPrice : P >= lo.limitPrice;
      if (hit) {
        lo.filled = true;
        const units = m.curve.unitsFor(lo.notional, P);
        out.push({ i: pl.id, du: (lo.side === "BUY" ? 1 : -1) * units, reason: "limit" });
      }
    }
  }
  return out;
}
module.exports = { validateCommand, commandToIntent, pendingIntents };

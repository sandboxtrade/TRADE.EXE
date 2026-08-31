"use strict";
/**
 * ПЕРЕХОДНИК ДЛЯ СТАРОГО ИНТЕРФЕЙСА (app/src/MarketSandbox.jsx).
 *
 * Интерфейс был написан под старый движок (buyPressure/sellPressure,
 * агрегаты market{...}, Room.join(id, name), Room.snapshotFor(id),
 * Room.paused). Новый движок v4 устроен иначе и честнее (units*mark
 * больше не считается деньгами — см. snapshot.js), но у него другие
 * имена методов и полей.
 *
 * LegacyRoom оборачивает настоящий v4-движок и отдаёт наружу данные в
 * СТАРОЙ форме, но все числа настоящие, посчитанные v4-математикой.
 * Ничего не подделывается — только переименовывается и агрегируется.
 *
 * ВАЖНО: это НЕ заменяет обычный Room у сервера/app.js. Экспортируется
 * отдельным именем LegacyRoom, чтобы не задеть остальной код.
 */
const { Room: RoomV4 } = require("./room");
const { CONFIG: CONFIG_V4 } = require("./config");
const { TYPES } = require("./npc");

/** Старый движок использовал фиксированный id человека. Новый — нет,
 *  он сам решает, какой слот отдать человеку при join(). Оставляем
 *  константу только для обратной совместимости импорта, реальный id
 *  всегда берётся из возврата LegacyRoom.join(). */
const HUMAN_ID = 0;

const CONFIG = {
  ...CONFIG_V4,
  market: {
    assetSymbol: "SIM",
    totalPlayers: 100,
    capitalOptions: [100, 500, 1000, 10000],
    initialPrice: CONFIG_V4.P0,
    tickMs: 100,
  },
};

const RU_LABELS = {
  aggressive: "агрессивный", conservative: "консервативный", momentum: "моментум",
  contrarian: "контрариан", random: "случайный", scared: "пугливый",
  greedy: "жадный", scalper: "скальпер", longterm: "долгосрочный",
  panic: "паникёр", inactive: "пассивный",
};
const STRATEGY_LABELS = Object.fromEntries(TYPES.map((t) => [t, RU_LABELS[t] || t]));

function clock(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
function signedPct(v, d = 2) {
  const s = v >= 0 ? "+" : "";
  return `${s}${(v * 100).toFixed(d)}%`;
}

class LegacyRoom {
  constructor({ startingCapital = 100, seed = 1, devMode = true, playerCount } = {}) {
    const count = playerCount || CONFIG.market.totalPlayers;
    this._room = new RoomV4({ playerCount: count, startingCapital, seed, npcCount: count - 1 });
    this.devMode = devMode;
    this.paused = false;
    this._buyPressure = 0;
    this._sellPressure = 0;
    this._totalTrades = 0;
    this._priceHistory = this._room.history.map((price, i) => ({ price, time: i }));
  }

  /** Старая сигнатура join(id, name) — id игнорируется, v4 сам выдаёт свой. */
  join(_ignoredId, name) {
    return this._room.join(name);
  }

  advance(n) {
    for (let k = 0; k < n && !this._room.halted; k++) this.step();
    return this;
  }

  step() {
    if (this.paused || this._room.halted) return null;
    const result = this._room.step();
    let buy = 0, sell = 0;
    if (result && result.executed) {
      for (const e of result.executed) {
        const notional = Math.abs(e.du) * e.price;
        if (e.du > 0) buy += notional; else sell += notional;
      }
      this._totalTrades += result.executed.length;
    }
    this._buyPressure = buy;
    this._sellPressure = sell;
    this._priceHistory.push({ price: this._room.market.mark, time: this._room.market.tick });
    if (this._priceHistory.length > 1200) this._priceHistory.shift();
    return result;
  }

  send(playerId, cmd) { return this._room.send(playerId, cmd); }

  /** Старая сигнатура snapshotFor(id) — уровень "full" + legacy-поля поверх. */
  snapshotFor(viewerId) {
    const base = this._room.snapshot(viewerId, { level: "full", devMode: this.devMode });
    const players = (base.participants || []).map((p) => this._legacyPlayer(p));
    return {
      ...base,
      players,
      you: base.you ? this._legacyPlayer(base.you) : null,
      buyPressure: this._buyPressure,
      sellPressure: this._sellPressure,
      netPressure: this._buyPressure - this._sellPressure,
      totalTrades: this._totalTrades,
      totalPlayers: this._room.market.players.length,
      priceHistory: this._priceHistory,
      lastPoint: this._priceHistory[this._priceHistory.length - 1],
      market: this._aggregate(base.participants || []),
    };
  }

  _legacyPlayer(p) {
    return {
      ...p,
      position: p.position ? {
        ...p.position,
        margin: p.position.invested,   // старое имя того же смысла
        openedAtTick: null,             // v4 это не хранит, не критично для интерфейса
        settlement: p.closeValue,
      } : null,
    };
  }

  _aggregate(participants) {
    let totalEquity = 0, totalCash = 0, longExposure = 0, shortExposure = 0;
    let longPlayers = 0, shortPlayers = 0;
    for (const p of participants) {
      totalCash += p.cash;
      totalEquity += p.equity;
      if (p.position) {
        if (p.position.side === "long") { longExposure += p.closeValue; longPlayers++; }
        else { shortExposure += p.closeValue; shortPlayers++; }
      }
    }
    const directional = longPlayers + shortPlayers;
    return {
      totalEquity, totalCash, longExposure, shortExposure, longPlayers, shortPlayers,
      flatPlayers: participants.length - directional,
      activePositions: directional,
      marketCap: this._room.market.mark * participants.length,
      longShare: directional === 0 ? 0 : longPlayers / directional,
      shortShare: directional === 0 ? 0 : shortPlayers / directional,
    };
  }
}

module.exports = { LegacyRoom, CONFIG, STRATEGY_LABELS, clock, signedPct, HUMAN_ID };

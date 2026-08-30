const { SimulationEngine } = require("./simulation");
const { validateCommand } = require("./validate");
const { createSnapshot } = require("./snapshot");
const { CONFIG } = require("./config");

/**
 * КОМНАТА. На Cloud Run живёт в памяти тик-процесса; Market Engine внутри
 * неё не знает ни про сеть, ни про Firebase, ни про то, сколько людей
 * сейчас в комнате против ботов.
 */
class Room {
  constructor({ id = "local", startingCapital = CONFIG.market.startingCapital,
                seed = Date.now() % 2147483647, devMode = true } = {}) {
    this.id = id;
    this.devMode = devMode;
    this.engine = new SimulationEngine(seed, startingCapital);
    this.engine.getState().roomId = id;
    this.rejections = [];
    this.humanCount = 0;
  }

  join(uid, name) {
    const slot = this.engine.addHuman(uid, name);
    if (slot) this.humanCount = this.engine.getState().humanIds.size;
    return slot;
  }

  leave(uid) {
    this.engine.removeHuman(uid);
    this.humanCount = this.engine.getState().humanIds.size;
  }

  /** Единственная точка входа для действий игрока. */
  send(playerId, command) {
    const state = this.engine.getState();
    const check = validateCommand(state, playerId, command);
    if (!check.ok) {
      this.rejections.unshift({ tick: state.tick, playerId, command, reason: check.reason });
      this.rejections = this.rejections.slice(0, 20);
      return check;
    }

    switch (command.type) {
      case "TRADE":
        this.engine.submit(playerId, {
          action: command.action,
          notional: command.notional,
          fraction: command.fraction,
          reason: command.reason ?? "команда игрока",
        });
        break;
      case "LIMIT":
        this.engine.placeLimitOrder({
          playerId, side: command.side,
          notional: command.notional, limitPrice: command.limitPrice,
        });
        break;
      case "CANCEL_LIMIT":
        this.engine.cancelLimitOrder(command.orderId);
        break;
      case "PROTECT":
        this.engine.setProtection(playerId, command.stopLoss ?? null, command.takeProfit ?? null);
        if (command.clear) this.engine.clearProtection(playerId, command.clear);
        break;
      default:
        break;
    }
    return { ok: true };
  }

  advance(steps) { this.engine.advance(steps); }
  get paused() { return this.engine.paused; }
  set paused(value) { this.engine.paused = value; }

  snapshotFor(viewerId, opts = {}) {
    return createSnapshot(this.engine.getState(), viewerId, { devMode: this.devMode, ...opts });
  }

  /**
   * Чекпоинт для Firestore (см. ARCHITECTURE.md, раздел 7 «Восстановление
   * после сбоя»). ВНИМАНИЕ: это снимок для аудита/ручного восстановления,
   * а не точный дамп для бесшовного продолжения — состояние ГПСЧ (rng)
   * не сериализуется, поэтому после восстановления память ботов (кто когда
   * решает) переинициализируется заново с новым seed. Позиции, кэш и цена
   * восстанавливаются точно; поведение толпы — приблизительно.
   * Это осознанный компромисс для MVP, а не пропущенный баг.
   */
  serializeForCheckpoint() {
    const state = this.engine.getState();
    const { rng, ...rest } = state;
    return {
      id: this.id,
      devMode: this.devMode,
      humanIds: Array.from(state.humanIds),
      state: JSON.parse(JSON.stringify(rest)),
    };
  }
}

module.exports = { Room };

"use strict";
const { Market } = require("./market");
const { attachNPCs, npcIntents } = require("./npc");
const { validateCommand, commandToIntent, pendingIntents } = require("./orders");
const { checkInvariants } = require("./invariants");
const { createSnapshot } = require("./snapshot");

/**
 * ROOM — цикл тика. Порядок фиксирован и одинаков для всех:
 *   1. собрать отложенные (стоп/тейк/лимит)
 *   2. собрать намерения NPC
 *   3. собрать команды людей, поступившие с прошлого тика
 *   4. ОДИН клиринг: единая цена для всех
 *   5. проверить инварианты; при нарушении — HALT
 *
 * Люди и NPC ничем не отличаются на шаге 4. Порядок внутри шагов не влияет
 * на результат (доказано: обрезка зависит только от P* и своего состояния).
 */
class Room {
  constructor({ playerCount = 100, startingCapital = 100, seed = 1, npcCount = null } = {}) {
    this.market = new Market({ playerCount, startingCapital, seed });
    this.history = [this.market.mark];
    this.pendingCommands = [];
    this.humanSlots = new Set();
    this.halted = null;
    const npcs = npcCount === null ? playerCount : npcCount;
    if (npcs > 0) attachNPCs(this.market, playerCount - npcs, npcs, seed);
  }

  /** Человек занимает слот бота: позиция бота закрывается в ближайшем клиринге. */
  join(name) {
    const m = this.market;
    const slot = m.players.find((p) => p.npc && !p.isHuman);
    if (!slot) return null;
    if (slot.u !== 0) this.pendingCommands.push({ i: slot.id, cmd: { type: "TRADE", action: "CLOSE" } });
    slot.npc = null; slot.isHuman = true; slot.name = name;
    this.humanSlots.add(slot.id);
    return slot.id;
  }

  send(playerId, cmd) {
    const v = validateCommand(this.market, playerId, cmd);
    if (!v.ok) return v;
    if (cmd.type === "PROTECT") {
      const pl = this.market.players[playerId];
      if (cmd.clear) { pl.stopLoss = null; pl.takeProfit = null; }
      if (Number.isFinite(cmd.stopLoss)) pl.stopLoss = cmd.stopLoss;
      if (Number.isFinite(cmd.takeProfit)) pl.takeProfit = cmd.takeProfit;
      return { ok: true };
    }
    if (cmd.type === "LIMIT") {
      const pl = this.market.players[playerId];
      pl.limits = pl.limits || [];
      pl.limits.push({ id: `L${pl.limits.length}-${this.market.tick}`,
        side: cmd.side, notional: cmd.notional, limitPrice: cmd.limitPrice, filled: false });
      return { ok: true };
    }
    if (cmd.type === "CANCEL_LIMIT") {
      const pl = this.market.players[playerId];
      pl.limits = (pl.limits || []).filter((l) => l.id !== cmd.orderId);
      return { ok: true };
    }
    this.pendingCommands.push({ i: playerId, cmd });
    return { ok: true };
  }

  step() {
    if (this.halted) return this.halted;
    const m = this.market;
    const intents = [];
    intents.push(...pendingIntents(m));
    intents.push(...npcIntents(m, this.history, 0));
    for (const { i, cmd } of this.pendingCommands) {
      const it = commandToIntent(m, i, cmd);
      if (it) intents.push(it);
    }
    this.pendingCommands = [];

    const result = m.clear(intents);
    this.history.push(m.mark);
    if (this.history.length > 5000) this.history.shift();

    const inv = checkInvariants(m, { intents: intents.length });
    if (!inv.ok) { this.halted = inv.report; return inv.report; }
    return result;
  }

  advance(n) { for (let k = 0; k < n && !this.halted; k++) this.step(); return this; }
  snapshot(viewerId, opts) { return createSnapshot(this.market, viewerId, opts); }
}
module.exports = { Room };

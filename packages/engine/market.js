"use strict";
const { CONFIG } = require("./config");
const { makeCurve } = require("./curve");

/**
 * MARKET STATE + CLEARING. Три уровня разделены (MODEL-V4 требование 13):
 *   market  — Q, price, escrow
 *   player  — cash, u, entry, realized
 *   clearing— кто, сколько и по какой цене; исполняется здесь и только здесь.
 */
class Market {
  constructor({ playerCount, startingCapital, seed = 1 }) {
    this.startingCapital = startingCapital;
    this.C = playerCount * startingCapital;
    this.curve = makeCurve(this.C);
    this.Q = 0;
    this.escrow = 0;
    this.tick = 0;
    this.seed = seed;
    this.players = Array.from({ length: playerCount }, (_, i) => ({
      id: i, name: null, isHuman: false,
      cash: startingCapital, u: 0,
      entryPrice: null, invested: 0,
      realizedPnL: 0, tradeCount: 0,
      stopLoss: null, takeProfit: null,
      npc: null,
    }));
  }

  get mark() { return this.curve.p(this.Q); }
  get liquidationPrice() { return this.curve.liquidationPrice(this.Q); }

  /** CLOSE VALUE: сколько игрок получит, если ВСЕ позиции закроются в этом тике.
   *  Не units*mark. Sum по всем игрокам тождественно равна escrow. */
  settlement(i) {
    return this.curve.value(this.players[i].u, this.liquidationPrice);
  }
  equity(i) { return this.players[i].cash + this.settlement(i); }
  unrealized(i) {
    const pl = this.players[i];
    return pl.u === 0 ? 0 : this.settlement(i) - pl.invested;
  }
  sumEquity() { return this.players.reduce((a, _, i) => a + this.equity(i), 0); }

  /** Максимальный размер позиции для ОДИНОЧНОЙ заявки (для UI-подсказки).
   *  Внутри тика реальный предел определяет обрезка. */
  maxUnitsSolo(i, side) {
    const pl = this.players[i], { R, PMAX } = this.curve, Q = this.Q;
    const cost = (u) => side > 0 ? R(Q + u) - R(Q) : u * PMAX - (R(Q) - R(Q - u));
    let lo = 0, hi = 1;
    while (cost(hi) < pl.cash && hi < 1e9) hi *= 2;
    for (let k = 0; k < 100; k++) {
      const m = (lo + hi) / 2;
      if (cost(m) <= pl.cash) lo = m; else hi = m;
    }
    return lo;
  }

  /**
   * ДВУХПРОХОДНЫЙ КЛИРИНГ.
   * orders: [{ i, du }] — желаемое изменение позиции.
   *
   * Обрезка вычисляется ОТ ИСХОДНОГО запроса при текущей P* (не накопительно),
   * поэтому итерация ищет истинную неподвижную точку, а не консервативную
   * недооценку (minCash выходит на 1e-13, а не оставляет запас).
   *
   * Обрезка каждой заявки — функция ТОЛЬКО от (P*, cash_i, u_i, запрос_i).
   * Ни от каких чужих заявок и ни от какого порядка. Отсюда
   * порядко-независимость: перестановка не меняет ни P*, ни исполнение.
   */
  clear(orders) {
    const orig = orders
      .filter((o) => Number.isFinite(o.du) && Math.abs(o.du) > 1e-15)
      .map((o) => ({ i: o.i, du: o.du, reason: o.reason || null }));
    if (!orig.length) { this.tick++; return { price: this.mark, executed: [], iters: 0 }; }

    const { value, clearingPrice, PMAX } = this.curve;
    const work = orig.map((o) => ({ ...o }));
    let P = clearingPrice(this.Q, work.reduce((a, o) => a + o.du, 0));
    let iters = 0;

    for (; iters < CONFIG.CLIP_MAX_ITER; iters++) {
      for (let k = 0; k < work.length; k++) {
        const want = orig[k].du, pl = this.players[work[k].i];
        const before = pl.u, after = before + want;
        const budget = pl.cash + value(before, P);
        let maxAfter = after > 0 ? budget / P : after < 0 ? -budget / (PMAX - P) : 0;
        let allowed = after;
        if (after > 0 && after > maxAfter) allowed = maxAfter;
        if (after < 0 && after < maxAfter) allowed = maxAfter;
        work[k].du = allowed - before;
      }
      const P2 = clearingPrice(this.Q, work.reduce((a, o) => a + o.du, 0));
      if (Math.abs(P2 - P) < CONFIG.EPS) { P = P2; break; }
      P = P2;
    }

    const executed = [];
    for (const o of work) {
      if (Math.abs(o.du) < 1e-15) continue;
      const pl = this.players[o.i];
      const before = pl.u, after = before + o.du;
      const vb = value(before, P), va = value(after, P);
      pl.cash += vb - va;
      this.escrow += va - vb;

      // учёт реализованного PnL и средней цены входа
      if (before !== 0 && (after === 0 || Math.sign(after) !== Math.sign(before))) {
        pl.realizedPnL += vb - pl.invested;      // закрыли старую экспозицию целиком
        pl.invested = 0; pl.entryPrice = null;
        pl.stopLoss = null; pl.takeProfit = null;
      } else if (before !== 0 && Math.abs(after) < Math.abs(before)) {
        const frac = 1 - Math.abs(after) / Math.abs(before);
        const closedCost = pl.invested * frac;
        pl.realizedPnL += (vb - va) - closedCost;
        pl.invested -= closedCost;
      }
      if (after !== 0) {
        if (before === 0 || Math.sign(after) !== Math.sign(before)) {
          pl.invested = va; pl.entryPrice = P;
        } else if (Math.abs(after) > Math.abs(before)) {
          pl.invested += va - vb;
          pl.entryPrice = pl.invested / Math.abs(after) *
            (after > 0 ? 1 : 1); // средняя стоимость единицы
          pl.entryPrice = P;     // цена последнего клиринга как ориентир UI
        }
      }
      pl.u = after;
      pl.tradeCount++;
      executed.push({ i: o.i, du: o.du, price: P, reason: o.reason });
    }
    this.Q += work.reduce((a, o) => a + o.du, 0);
    this.tick++;
    return { price: P, executed, iters };
  }
}
module.exports = { Market };

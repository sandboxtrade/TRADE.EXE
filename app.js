import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/* ============================================================================
   TRADE.EXE — офлайн-версия с полным интерфейсом (движок v4 + красивый UI)
   Собрано автоматически из packages/engine (v4) и app/src/MarketSandbox.jsx.
   Без Firebase, без сервера — всё считается прямо в браузере.
   ========================================================================== */

// ==== ДВИЖОК MODEL-V4 (инлайн) ====
// ---- config.js ----
/**
 * Конфигурация модели V4.
 *
 * ВАЖНО: значения ниже НЕ подбирались "на глаз". Каждое обосновано
 * измерением в аудитах MODEL-V3/V4. Ссылки — в комментариях.
 * Менять их можно только вместе с перепрогоном test/audit.js.
 */
const CONFIG = {
  // --- Ценовая кривая p(Q) = P0 * (1 + beta * tanh(Q / kappa)) ---
  P0: 100,          // базовая цена
  beta: 0.75,       // диапазон цены: [P0*(1-beta), P0*(1+beta)] = [25, 175]
                    // Ограниченность с ОБЕИХ сторон -> убыток обеих сторон
                    // конечен -> equity >= 0 без ликвидаций (MODEL-V2, разд. I)

  // kappa НЕ задаётся вручную. kappa = C / (P0 * THETA).
  // Это даёт масштабную инвариантность: движение цены зависит только от
  // ДОЛИ совокупного капитала (MODEL-V2, разд. 3: 12 конфигураций,
  // идентичный результат до 6-го знака).
  THETA: 0.5,

  // --- Клиринг ---
  CLIP_MAX_ITER: 200,   // предел итераций обрезки; эмпирически хватает <= 14
  EPS: 1e-12,

  // --- NPC ---
  // Доля NPC, реагирующих БЕЗ задержки. Найдена численно в SELFPUMP-FIX:
  // при 0% самораскачка даёт +0.0385 (t=20.7), при 60% — отрицательна на
  // всех размерах. Лаг реакции был единственной причиной эксплойта.
  NPC_INSTANT_FRACTION: 0.60,

  // --- Инварианты ---
  TOL_CAPITAL: 1e-6,
  TOL_NONNEG: 1e-9,
};

// ---- curve.js ----

/**
 * Ценовая кривая и резервная функция.
 *
 * p(Q) = P0 * (1 + beta * tanh(Q/kappa))          -- цена состояния (mark)
 * R(Q) = P0 * [Q + beta*kappa*ln cosh(Q/kappa)]   -- резерв, интеграл p по [0,Q]
 *
 * R имеет ЗАМКНУТУЮ форму. Это не косметика: цена клиринга есть
 * (R(Q+dQ)-R(Q))/dQ, и без замкнутой формы её пришлось бы интегрировать
 * численно, из-за чего сохранение капитала стало бы приближённым.
 * Именно поэтому выбрана эта кривая, а не мультипликативно-симметричная
 * exp(tanh) (MODEL-V2, разд. B).
 */
function makeCurve(totalCapital) {
  const { P0, beta, THETA } = CONFIG;
  const kappa = totalCapital / (P0 * THETA);
  const PMIN = P0 * (1 - beta);
  const PMAX = P0 * (1 + beta);

  const p = (Q) => P0 * (1 + beta * Math.tanh(Q / kappa));
  const R = (Q) => P0 * (Q + beta * kappa * Math.log(Math.cosh(Q / kappa)));

  /**
   * Стоимость позиции u при цене P. ОБЕ стороны платят вперёд, взнос >= 0:
   *   лонг  вносит u * P
   *   шорт  вносит |u| * (PMAX - P)
   * Отсюда escrow >= 0 всегда, а equity >= 0 структурно.
   */
  const value = (u, P) => (u > 0 ? u * P : u < 0 ? -u * (PMAX - P) : 0);

  /**
   * ЕДИНАЯ цена клиринга тика = средняя цена кривой на отрезке чистого сдвига.
   * Единственная цена, совместимая с сохранением капитала: собранные деньги
   * dQ*P* в точности равны изменению резерва R(Q+dQ)-R(Q).
   * Не зависит от вида кривой — выводится только из сохранения.
   */
  const clearingPrice = (Q, dQ) =>
    Math.abs(dQ) < CONFIG.EPS ? p(Q) : (R(Q + dQ) - R(Q)) / dQ;

  /**
   * Цена ПОЛНОЙ ликвидации рынка (Q -> 0). На ней считается CLOSE VALUE.
   * Выбор именно этой цены даёт Sum(settlement) = escrow тождественно,
   * а значит Sum(equity) = C (FINAL-AUDIT-V2, вопрос 4).
   */
  const liquidationPrice = (Q) => (Math.abs(Q) < CONFIG.EPS ? p(0) : R(Q) / Q);

  /** Размер позиции: СИММЕТРИЧНЫЙ перевод денег в units.
   *  budget/P для лонга и budget/(PMAX-P) для шорта давали шорту в 1.33 раза
   *  больше экспозиции за те же деньги -> систематический дрейф вниз и
   *  эксплойт "всегда шорт" (t=65.6). Общий знаменатель это устраняет
   *  (ATTACK-AND-STRATEGIES, разд. 2). */
  const unitsFor = (budget, P) => budget / Math.max(P, PMAX - P);

  return { kappa, PMIN, PMAX, p, R, value, clearingPrice, liquidationPrice, unitsFor };
}

// ---- market.js ----

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

// ---- invariants.js ----

/**
 * INVARIANT CHECKER. Вызывается после КАЖДОГО тика.
 * При нарушении возвращает отчёт, достаточный для воспроизведения.
 */
function checkInvariants(m, ctx = {}) {
  const errs = [];
  const { TOL_CAPITAL: TC, TOL_NONNEG: TN } = CONFIG;
  const totalCash = m.players.reduce((a, p) => a + p.cash, 0);

  if (Math.abs(totalCash + m.escrow - m.C) > TC)
    errs.push(`Σcash+escrow ≠ C: ${(totalCash + m.escrow - m.C).toExponential(3)}`);
  if (Math.abs(m.sumEquity() - m.C) > TC)
    errs.push(`Σequity ≠ C: ${(m.sumEquity() - m.C).toExponential(3)}`);
  if (m.escrow < -TN) errs.push(`escrow < 0: ${m.escrow}`);

  const price = m.mark;
  if (price < m.curve.PMIN - TN || price > m.curve.PMAX + TN)
    errs.push(`price вне [${m.curve.PMIN}, ${m.curve.PMAX}]: ${price}`);

  for (const p of m.players) {
    if (p.cash < -TN) errs.push(`cash < 0 у #${p.id}: ${p.cash}`);
    if (m.equity(p.id) < -TN) errs.push(`equity < 0 у #${p.id}: ${m.equity(p.id)}`);
    if (!Number.isFinite(p.cash) || !Number.isFinite(p.u))
      errs.push(`не-число у #${p.id}`);
  }

  if (errs.length) {
    return {
      ok: false,
      halt: true,
      report: {
        tick: m.tick, seed: m.seed, Q: m.Q, price, escrow: m.escrow,
        sumEquity: m.sumEquity(), C: m.C, errors: errs, context: ctx,
      },
    };
  }
  return { ok: true };
}

// ---- npc.js ----

/** Детерминированный ГПСЧ: один seed -> одна и та же сессия. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * NPC — ОБЫЧНЫЕ участники. У каждого свой cash, позиция, entry, стратегия.
 * Проходят тот же clear(), что и человек. Не поставщики ликвидности,
 * не контрагенты, не источник бесплатных денег.
 *
 * bias распределён так, чтобы вес trend и fade был сопоставим. Считать надо
 * ВЕС (size*act), а не число типов: балансировка по числу оставляла
 * отношение 1.15 (ATTACK-AND-STRATEGIES, разд. 2).
 */
const ARCHETYPES = {
  aggressive:   { size: [0.8, 1.0], act: 0.30, stop: -0.25, take: 0.40, bias: "trend" },
  conservative: { size: [0.05, 0.2], act: 0.10, stop: -0.05, take: 0.08, bias: "fade" },
  momentum:     { size: [0.2, 0.5], act: 0.35, stop: -0.10, take: 0.25, bias: "trend" },
  contrarian:   { size: [0.2, 0.5], act: 0.35, stop: -0.10, take: 0.25, bias: "fade" },
  random:       { size: [0.1, 0.4], act: 0.25, stop: -0.20, take: 0.20, bias: "rand" },
  scared:       { size: [0.1, 0.3], act: 0.20, stop: -0.02, take: 0.05, bias: "fade" },
  greedy:       { size: [0.5, 0.9], act: 0.15, stop: -0.30, take: 0.60, bias: "trend" },
  scalper:      { size: [0.2, 0.4], act: 0.60, stop: -0.03, take: 0.03, bias: "fade" },
  longterm:     { size: [0.3, 0.6], act: 0.03, stop: -0.40, take: 0.80, bias: "trend" },
  panic:        { size: [0.3, 0.6], act: 0.20, stop: -0.08, take: 0.30, bias: "fade" },
  inactive:     { size: [0.05, 0.2], act: 0.02, stop: -0.30, take: 0.30, bias: "rand" },
};
const TYPES = Object.keys(ARCHETYPES);

function attachNPCs(m, startIdx, count, seed) {
  const r = mulberry32(seed);
  for (let k = 0; k < count; k++) {
    const type = TYPES[k % TYPES.length];
    const spec = ARCHETYPES[type];
    const idx = startIdx + k;
    m.players[idx].name = `${type}-${k}`;
    m.players[idx].npc = {
      type, spec,
      size: spec.size[0] + r() * (spec.size[1] - spec.size[0]),
      act: spec.act * (0.6 + 0.8 * r()),
      // Доля с НУЛЕВОЙ задержкой. Лаг реакции был единственной причиной
      // эксплойта самораскачки: при lag=0 её EV становится отрицательным.
      lag: r() < CONFIG.NPC_INSTANT_FRACTION ? 0 : 1 + Math.floor(r() * 5),
      rng: mulberry32(seed * 7919 + k + 1),
    };
  }
}

/** Решение NPC. Видит только: текущую цену, историю, своё состояние, свой шум. */
function decide(m, i, history) {
  const pl = m.players[i], n = pl.npc;
  if (!n) return 0;
  const r = n.rng;
  if (r() > n.act) return 0;

  const P = m.mark;
  const j = Math.max(0, history.length - 1 - n.lag);
  const past = history.length ? history[j] : P;
  const mom = (P - past) / Math.max(past, 1e-9);

  if (pl.u !== 0 && pl.entryPrice !== null) {
    const pnl = pl.u > 0 ? (P - pl.entryPrice) / pl.entryPrice
                         : (pl.entryPrice - P) / pl.entryPrice;
    if (pnl <= n.spec.stop || pnl >= n.spec.take) return -pl.u;
  }
  if (pl.u !== 0) return 0;

  let dir;
  if (n.spec.bias === "trend") dir = mom > 0 ? 1 : mom < 0 ? -1 : (r() < 0.5 ? 1 : -1);
  else if (n.spec.bias === "fade") dir = mom > 0 ? -1 : mom < 0 ? 1 : (r() < 0.5 ? 1 : -1);
  else dir = r() < 0.5 ? 1 : -1;
  if (Math.abs(mom) < 1e-6 && n.spec.bias !== "rand" && r() < 0.7) return 0;

  const units = m.curve.unitsFor(pl.cash * n.size, P);
  return dir > 0 ? units : -units;
}

function npcIntents(m, history, fromIdx) {
  const out = [];
  for (let i = fromIdx; i < m.players.length; i++) {
    if (!m.players[i].npc) continue;
    const du = decide(m, i, history);
    if (Math.abs(du) > 1e-12) out.push({ i, du, reason: "npc" });
  }
  return out;
}

// ---- orders.js ----
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

// ---- snapshot.js ----
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

// ---- room.js ----

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
class RoomV4 {
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


// ==== ПЕРЕХОДНИК ДЛЯ КРАСИВОГО ИНТЕРФЕЙСА (тот же смысл, что legacyRoom.js в packages/engine) ====
const LEGACY_HUMAN_ID = 0;

CONFIG.market = {
  assetSymbol: "SIM",
  totalPlayers: 100,
  capitalOptions: [100, 500, 1000, 10000],
  initialPrice: CONFIG.P0,
  tickMs: 100,
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
        margin: p.position.invested,
        openedAtTick: null,
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


// Старый интерфейс ожидает класс "Room" со старым API — LegacyRoom это и есть.
const Room = LegacyRoom;

// ==== ПРОФИЛЬ / ЛОКАЛЬНЫЙ ТРАНСПОРТ / ИНТЕРФЕЙС ====
class LocalTransport {
  constructor({ startingCapital, seed, devMode = true } = {}) {
    this.room = new Room({ startingCapital, seed, devMode });
    this.playerId = this.room.join(null, "ВЫ"); // новый движок сам выдаёт id человека
    this.timer = null;
    this.speed = 1;
  }
  start(onSnapshot) {
    this.timer = setInterval(() => {
      this.room.advance(this.speed);
      onSnapshot(this.room.snapshotFor(this.playerId));
    }, CONFIG.market.tickMs);
    onSnapshot(this.room.snapshotFor(this.playerId));
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  async send(command) { return this.room.send(this.playerId, command); }
  snapshot() { return this.room.snapshotFor(this.playerId); }
  setSpeed(value) { this.speed = value; }
  setPaused(value) { this.room.paused = value; }
  get paused() { return this.room.paused; }
}

/**
 * Онлайн-комната на Firebase. Команды идут HTTP-запросом на сервис Cloud
 * Run (см. callRoomService выше и server/index.js → /api/submitCommand),
 * тиковый поток — по WebSocket напрямую на тот же сервис (см. server/index.js
 * и ARCHITECTURE.md, раздел 4 — Firestore не годится как канал для 10
 * сообщений в секунду на игрока).
 *
 * Клиент не может управлять скоростью симуляции — это единственное
 * отличие в контракте от LocalTransport, и оно намеренное: скорость
 * тика в онлайн-комнате задаёт только сервер (ARCHITECTURE.md, раздел 4).
 */

function buildCandles(points, bucketMs, maxCandles) {
  if (points.length === 0) return [];
  const candles = [];
  let current = null;
  const earliest = points[points.length - 1].t - bucketMs * (maxCandles + 1);
  for (const point of points) {
    if (point.t < earliest) continue;
    const bucket = Math.floor(point.t / bucketMs) * bucketMs;
    if (!current || current.t !== bucket) {
      current = { t: bucket, open: point.price, high: point.price, low: point.price, close: point.price, volume: point.volume };
      candles.push(current);
    } else {
      current.high = Math.max(current.high, point.price);
      current.low = Math.min(current.low, point.price);
      current.close = point.price;
      current.volume += point.volume;
    }
  }
  return candles.slice(-maxCandles);
}

/* ---------------------------------- ТЕМА ---------------------------------- */
/**
 * Монохром: чёрный фон, белый текст, серые оттенки для всего служебного.
 * Цвет разрешён ровно в двух местах — кнопки ЛОНГ/ШОРТ и знак результата
 * (PnL, экспозиция сторон). Всё остальное намеренно бесцветно, иначе
 * акценты перестают работать как акценты.
 */
const BG = "#000000";
const SURFACE = "#0B0B0C";
const RAISED = "#141416";
const HAIR = "#1E1E21";
const TEXT = "#FFFFFF";
const DIM = "#7A7A80";
const FAINT = "#46464C";
const LONG = "#19D67E";
const SHORT = "#FF3F52";

const fmt = (v, d = 2) => {
  const digits = Math.abs(v) >= 1000 ? 0 : d;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  })}`;
};
const fmtSigned = (v, d = 2) => `${v >= 0 ? "+" : "−"}${fmt(Math.abs(v), d).replace("-", "")}`;

/* --------------------------------- ГРАФИК --------------------------------- */
const CW = 700, AXIS = 74, CH = 340, VH = 60, MAX_CANDLES = 60;

function Chart({ state, timeframe, mode, entryPrice, stopLoss, takeProfit }) {
  const bucketMs = TIMEFRAMES.find((t) => t.label === timeframe)?.ms ?? 1000;
  const candles = buildCandles(state.priceHistory, bucketMs, MAX_CANDLES);
  if (candles.length < 2) {
    return <div style={{ height: 380 }} className="flex items-center justify-center text-[12px]"
      >{<span style={{ color: FAINT }}>собираем свечи…</span>}</div>;
  }

  let min = Infinity, max = -Infinity, maxVol = 0;
  for (const c of candles) {
    min = Math.min(min, c.low); max = Math.max(max, c.high);
    maxVol = Math.max(maxVol, c.volume);
  }
  for (const level of [entryPrice, stopLoss, takeProfit]) {
    if (level && level > min * 0.94 && level < max * 1.06) { min = Math.min(min, level); max = Math.max(max, level); }
  }
  const pad = Math.max((max - min) * 0.1, max * 0.0015);
  min -= pad; max += pad;
  const span = max - min || 1;
  const toY = (p) => CH - ((p - min) / span) * CH;

  const slot = CW / MAX_CANDLES;
  const body = Math.max(2, slot * 0.55);
  const offset = Math.max(0, MAX_CANDLES - candles.length);
  const grid = Array.from({ length: 5 }, (_, i) => min + (span * i) / 4);
  const priceY = toY(state.price);

  const level = (value, label, dash) =>
    value && value > min && value < max ? (
      <g>
        <line x1={0} x2={CW} y1={toY(value)} y2={toY(value)} stroke={FAINT} strokeWidth={1} strokeDasharray={dash} />
        <text x={4} y={toY(value) - 5} fill={FAINT} fontSize={11} fontFamily="monospace">{label}</text>
      </g>
    ) : null;

  return (
    <svg viewBox={`0 0 ${CW + AXIS} ${CH + VH + 4}`} className="w-full" style={{ height: 380 }}>
      {grid.map((p, i) => (
        <g key={i}>
          <line x1={0} x2={CW} y1={toY(p)} y2={toY(p)} stroke={HAIR} strokeWidth={1} />
          <text x={CW + 8} y={toY(p) + 4} fill={FAINT} fontSize={12} fontFamily="monospace">{p.toFixed(2)}</text>
        </g>
      ))}

      {mode === "свечи"
        ? candles.map((c, i) => {
            const x = (offset + i) * slot + slot / 2;
            const up = c.close >= c.open;
            const color = up ? LONG : SHORT;
            const top = toY(Math.max(c.open, c.close));
            const bottom = toY(Math.min(c.open, c.close));
            return (
              <g key={c.t}>
                <line x1={x} x2={x} y1={toY(c.high)} y2={toY(c.low)} stroke={color} strokeWidth={1} />
                <rect x={x - body / 2} y={top} width={body} height={Math.max(1.2, bottom - top)} fill={color} />
              </g>
            );
          })
        : (() => {
            const pts = candles.map((c, i) => `${(offset + i) * slot + slot / 2},${toY(c.close)}`).join(" ");
            const trend = candles[candles.length - 1].close >= candles[0].open ? LONG : SHORT;
            return (
              <>
                <polygon points={`${pts} ${CW},${CH} ${offset * slot},${CH}`} fill={trend} opacity={0.08} />
                <polyline points={pts} fill="none" stroke={trend} strokeWidth={1.6} />
              </>
            );
          })()}

      {level(entryPrice, `вход ${entryPrice?.toFixed(2)}`, "1 4")}
      {level(stopLoss, `стоп ${stopLoss?.toFixed(2)}`, "4 4")}
      {level(takeProfit, `тейк ${takeProfit?.toFixed(2)}`, "4 4")}

      {candles.map((c, i) => {
        const x = (offset + i) * slot + slot / 2;
        const h = maxVol === 0 ? 0 : (c.volume / maxVol) * (VH - 8);
        return <rect key={`v${c.t}`} x={x - body / 2} y={CH + 4 + (VH - 8 - h)}
          width={body} height={Math.max(0.5, h)}
          fill={c.close >= c.open ? LONG : SHORT} opacity={0.35} />;
      })}

      <line x1={0} x2={CW} y1={priceY} y2={priceY} stroke={TEXT} strokeWidth={1} strokeDasharray="3 3" opacity={0.4} />
      <rect x={CW + 2} y={priceY - 12} width={AXIS - 4} height={24} rx={3}
        fill={state.price >= state.previousPrice ? LONG : SHORT} />
      <text x={CW + AXIS / 2} y={priceY + 5} textAnchor="middle" fill={BG}
        fontSize={13} fontFamily="monospace" fontWeight="700">{state.price.toFixed(2)}</text>
    </svg>
  );
}

/* ------------------------------- ЭЛЕМЕНТЫ UI ------------------------------ */
function Metric({ label, value, color = TEXT }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-[0.12em] mb-1" style={{ color: FAINT }}>{label}</div>
      <div className="text-[15px] font-mono truncate" style={{ color }}>{value}</div>
    </div>
  );
}
function Line({ left, right, color }) {
  return (
    <div className="flex justify-between gap-3 py-2 border-b" style={{ borderColor: HAIR }}>
      <span className="text-[12px] truncate" style={{ color: DIM }}>{left}</span>
      <span className="text-[12px] font-mono whitespace-nowrap" style={{ color: color ?? TEXT }}>{right}</span>
    </div>
  );
}
const Blank = ({ children }) => (
  <div className="text-[12px] py-8 text-center" style={{ color: FAINT }}>{children}</div>
);
function Toggle({ active, onClick, children }) {
  return (
    <button onClick={onClick} className="px-2.5 py-1.5 rounded text-[12px] transition"
      style={{ color: active ? BG : DIM, backgroundColor: active ? TEXT : "transparent" }}>
      {children}
    </button>
  );
}

/* ================================ ПРОФИЛЬ ================================
   Профиль переживает сессии: кошелёк, история результатов, статистика.
   Хранится через window.storage, поэтому при следующем открытии
   приложение помнит, чем закончились прошлые заходы.
   ======================================================================== */
const PROFILE_KEY = "sandbox:profile";
const STARTING_WALLET = 25000;

const emptyProfile = () => ({
  wallet: STARTING_WALLET,
  deposited: STARTING_WALLET,
  sessions: [],
});

/**
 * ХРАНИЛИЩЕ ПРОФИЛЯ — второй шов под Firebase.
 *
 * Приложение работает с profileStore, а не с конкретным хранилищем.
 * Сейчас это локальный ключ-значение. В боевой версии подставляется
 * реализация поверх Firestore, а баланс становится серверным:
 *
 *   load()  → getDoc(doc(db, 'users', uid))
 *   save()  → НЕ пишется клиентом напрямую
 *
 * Последнее принципиально. Баланс и история сессий — это деньги игры.
 * Если клиент может писать в свой документ, он может дописать себе
 * любой баланс. Клиент вызывает startSession / closeSession, а
 * записывает только сервер. Правила Firestore на users/{uid} должны
 * быть read-only для владельца и полностью закрыты на запись.
 */
const profileStore = {
  // ОФФЛАЙН-ВЕРСИЯ: window.storage существует только внутри интерфейса
  // Claude.ai, на обычном сайте (GitHub Pages) его нет. Здесь используется
  // обычный localStorage браузера — работает точно так же, хранится
  // локально на этом устройстве.
  async load() {
    try {
      const found = localStorage.getItem(PROFILE_KEY);
      if (found) return { ...emptyProfile(), ...JSON.parse(found) };
    } catch {
      // ключа ещё нет либо хранилище недоступно — начинаем с чистого профиля
    }
    return emptyProfile();
  },
  async save(profile) {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch {
      // Не удалось сохранить — сессия продолжается, но история не переживёт
      // перезагрузку. Ронять приложение из-за этого не стоит.
    }
  },
};

const loadProfile = () => profileStore.load();
const saveProfile = (profile) => profileStore.save(profile);

function profileStats(profile) {
  const list = profile.sessions;
  if (list.length === 0) {
    return { count: 0, wins: 0, winRate: 0, total: 0, best: 0, worst: 0 };
  }
  const total = list.reduce((sum, x) => sum + x.pnl, 0);
  return {
    count: list.length,
    wins: list.filter((x) => x.pnl > 0).length,
    winRate: list.filter((x) => x.pnl > 0).length / list.length,
    total,
    best: Math.max(...list.map((x) => x.pnl)),
    worst: Math.min(...list.map((x) => x.pnl)),
  };
}

/* --------------------------------- ЛОББИ --------------------------------- */
function Lobby({ profile, onNew, onReset, onExit }) {
  const st = profileStats(profile);
  const affordable = CONFIG.market.capitalOptions.some((c) => c <= profile.wallet);

  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 overflow-y-auto px-6 pt-10 pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] tracking-[0.4em]" style={{ color: FAINT }}>ЗАКРЫТЫЙ РЫНОК · ПРАКТИКА</span>
          {onExit && (
            <button onClick={onExit} className="text-[11px]" style={{ color: DIM }}>сменить режим</button>
          )}
        </div>
        <div className="text-[28px] leading-none tracking-tight mb-10">Market Sandbox</div>

        <div className="text-[11px] tracking-[0.15em] mb-2" style={{ color: FAINT }}>БАЛАНС</div>
        <div className="text-[44px] leading-none font-mono tracking-tight">{fmt(profile.wallet)}</div>
        <div className="text-[13px] font-mono mt-2"
          style={{ color: st.total > 0 ? LONG : st.total < 0 ? SHORT : DIM }}>
          {st.count === 0 ? "сессий ещё не было" : `${fmtSigned(st.total)} за ${st.count} сесс.`}
        </div>

        <div className="grid grid-cols-4 gap-3 mt-8">
          <Metric label="СЕССИЙ" value={String(st.count)} />
          <Metric label="ПРИБЫЛЬНЫХ" value={st.count ? `${st.wins}` : "—"}
            color={st.wins > 0 ? LONG : TEXT} />
          <Metric label="ЛУЧШАЯ" value={st.count ? fmtSigned(st.best, 0) : "—"}
            color={st.best > 0 ? LONG : TEXT} />
          <Metric label="ХУДШАЯ" value={st.count ? fmtSigned(st.worst, 0) : "—"}
            color={st.worst < 0 ? SHORT : TEXT} />
        </div>

        <div className="text-[11px] tracking-[0.15em] mt-10 mb-1" style={{ color: FAINT }}>ИСТОРИЯ</div>
        {profile.sessions.length === 0 ? (
          <Blank>здесь появятся результаты ваших сессий</Blank>
        ) : (
          profile.sessions.slice(0, 12).map((x, i) => (
            <div key={i} className="flex items-center justify-between py-2.5 border-b" style={{ borderColor: HAIR }}>
              <div className="min-w-0">
                <div className="text-[13px] font-mono">{fmt(x.capital, 0)} → {fmt(x.equity)}</div>
                <div className="text-[11px]" style={{ color: FAINT }}>
                  {clock(x.ticks * CONFIG.market.tickMs)} в рынке · место {x.rank} из {CONFIG.market.totalPlayers}
                </div>
              </div>
              <div className="text-[14px] font-mono" style={{ color: x.pnl >= 0 ? LONG : SHORT }}>
                {fmtSigned(x.pnl)}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="max-w-md w-full mx-auto px-6 pb-8 pt-3">
        {affordable ? (
          <button onClick={onNew} className="w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold"
            style={{ backgroundColor: TEXT, color: BG }}>
            НОВАЯ СЕССИЯ
          </button>
        ) : (
          <>
            <div className="text-[12px] mb-3 text-center" style={{ color: FAINT }}>
              На балансе меньше минимального взноса.
            </div>
            <button onClick={onReset} className="w-full rounded-lg py-4 text-[15px] tracking-[0.15em]"
              style={{ backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }}>
              ПОПОЛНИТЬ ДО {fmt(STARTING_WALLET, 0)}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------- ВЫБОР РАЗМЕРА СЕССИИ ------------------------ */
function SessionSetup({ wallet, onStart, onBack }) {
  const options = CONFIG.market.capitalOptions;
  const [capital, setCapital] = useState(
    options.filter((c) => c <= wallet).slice(-1)[0] ?? options[0]
  );

  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6">
        <button onClick={onBack} className="text-[12px] mb-8 text-left" style={{ color: DIM }}>← назад</button>

        <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>ВЗНОС В СЕССИЮ</div>
        <div className="grid grid-cols-2 gap-2">
          {options.map((value) => {
            const active = capital === value;
            const locked = value > wallet;
            return (
              <button key={value} disabled={locked} onClick={() => setCapital(value)}
                className="rounded-lg py-5 text-left px-4 transition disabled:opacity-25"
                style={{
                  backgroundColor: active && !locked ? TEXT : SURFACE,
                  color: active && !locked ? BG : TEXT,
                  border: `1px solid ${active && !locked ? TEXT : HAIR}`,
                }}>
                <div className="text-[22px] font-mono">${value.toLocaleString("en-US")}</div>
                <div className="text-[11px] mt-1" style={{ color: active && !locked ? "#555" : FAINT }}>
                  {locked ? "не хватает баланса" : `рынок $${(value * CONFIG.market.totalPlayers).toLocaleString("en-US")}`}
                </div>
              </button>
            );
          })}
        </div>

        <div className="text-[12px] mt-5 leading-relaxed" style={{ color: FAINT }}>
          Столько же получает каждый из 99 ботов. Взнос списывается с баланса,
          а в конце сессии на баланс возвращается ваш итоговый капитал.
          Размер сессии меняет только масштаб денег — поведение рынка от него не зависит.
        </div>
      </div>

      <div className="max-w-md w-full mx-auto px-6 pb-8">
        <button onClick={() => onStart(capital)}
          className="w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold"
          style={{ backgroundColor: TEXT, color: BG }}>
          ВОЙТИ В РЫНОК · {fmt(capital, 0)}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ ИТОГ СЕССИИ ------------------------------- */
function SessionResult({ result, onDone }) {
  const good = result.pnl >= 0;
  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6">
        <div className="text-[11px] tracking-[0.4em] mb-3" style={{ color: FAINT }}>СЕССИЯ ЗАВЕРШЕНА</div>
        <div className="text-[52px] leading-none font-mono tracking-tight" style={{ color: good ? LONG : SHORT }}>
          {fmtSigned(result.pnl)}
        </div>
        <div className="text-[15px] font-mono mt-2" style={{ color: DIM }}>
          {((result.pnl / result.capital) * 100).toFixed(2)}% от взноса
        </div>

        <div className="mt-10">
          <Line left="Взнос" right={fmt(result.capital)} />
          <Line left="Итоговый капитал" right={fmt(result.equity)} />
          <Line left="Место в рейтинге" right={`${result.rank} из ${CONFIG.market.totalPlayers}`} />
          <Line left="Сделок" right={String(result.trades)} />
          <Line left="Время в рынке" right={clock(result.ticks * CONFIG.market.tickMs)} />
          <Line left="Цена на выходе" right={fmt(result.price)} />
        </div>
      </div>
      <div className="max-w-md w-full mx-auto px-6 pb-8">
        <button onClick={onDone} className="w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold"
          style={{ backgroundColor: TEXT, color: BG }}>
          В ЛОББИ
        </button>
      </div>
    </div>
  );
}

/* ============================ ПРАКТИКА (ОФЛАЙН) ============================
   Полностью локальный режим: движок крутится в браузере, профиль хранится
   через window.storage. Ничего не отправляется в сеть — удобно, чтобы
   попробовать механику рынка без входа в аккаунт.
   ========================================================================== */
function PracticeApp({ onExit }) {
  const [profile, setProfile] = useState(null);
  const [screen, setScreen] = useState("lobby");
  const [result, setResult] = useState(null);
  const [session, setSession] = useState(null);
  const engineRef = useRef(null);

  const [snapshot, setSnapshot] = useState(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState("Рынок");
  const [timeframe, setTimeframe] = useState("1с");
  const [chartMode, setChartMode] = useState("свечи");
  const [showSettings, setShowSettings] = useState(false);
  const [size, setSize] = useState("0");
  const [sheet, setSheet] = useState(null);
  const [limitPrice, setLimitPrice] = useState("");
  const [limitSide, setLimitSide] = useState("buy");
  const [playerFilter, setPlayerFilter] = useState("Все");
  const [npcMode, setNpcMode] = useState("активные");
  const [toast, setToast] = useState(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);

  const speedRef = useRef(1);
  speedRef.current = speed;
  const toastTimer = useRef(null);

  useEffect(() => { loadProfile().then(setProfile); }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  useEffect(() => {
    if (screen !== "game" || !session) return undefined;
    const transport = engineRef.current;
    if (!transport) return undefined;
    transport.start((next) => setSnapshot(next));
    return () => transport.stop();
  }, [screen, session]);

  useEffect(() => { engineRef.current?.setSpeed(speed); }, [speed]);

  const persist = (next) => { setProfile(next); saveProfile(next); };

  const startSession = (capital) => {
    // Приложение больше не создаёт движок напрямую — только транспорт.
    // При переезде на сервер здесь меняется одна строка на RemoteTransport.
    engineRef.current = new LocalTransport({ startingCapital: capital });
    setSize(String(Math.round(capital * 0.3)));
    setPaused(false);
    setTab("Рынок");
    setSession(capital);
    setScreen("game");
    persist({ ...profile, wallet: profile.wallet - capital });
  };

  /** Завершение сессии: итоговый капитал возвращается на баланс. */
  const finishSession = () => {
    const transport = engineRef.current;
    if (!transport) return;
    // Итог сессии берётся из снапшота, а не считается клиентом:
    // на сервере это будет ответ функции closeSession.
    const snap = transport.snapshot();
    const record = {
      capital: session,
      equity: snap.you.equity,
      pnl: snap.you.equity - session,
      rank: snap.rank,
      trades: snap.you.tradeCount,
      ticks: snap.tick,
      price: snap.price,
    };

    persist({
      ...profile,
      wallet: profile.wallet + record.equity,
      sessions: [record, ...profile.sessions].slice(0, 40),
    });

    transport.stop();
    engineRef.current = null;
    setSnapshot(null);
    setSession(null);
    setShowSettings(false);
    setResult(record);
    setScreen("result");
  };

  if (!profile) {
    return (
      <div className="w-full h-screen flex items-center justify-center"
        style={{ backgroundColor: BG, color: FAINT }}>
        <span className="text-[12px]">загрузка профиля…</span>
      </div>
    );
  }
  if (screen === "lobby") {
    return <Lobby profile={profile} onNew={() => setScreen("setup")} onExit={onExit}
      onReset={() => persist({ ...profile, wallet: STARTING_WALLET, deposited: profile.deposited + STARTING_WALLET })} />;
  }
  if (screen === "setup") {
    return <SessionSetup wallet={profile.wallet} onStart={startSession} onBack={() => setScreen("lobby")} />;
  }
  if (screen === "result" && result) {
    return <SessionResult result={result} onDone={() => { setResult(null); setScreen("lobby"); }} />;
  }
  if (!engineRef.current || !snapshot) {
    return <Lobby profile={profile} onNew={() => setScreen("setup")} onExit={onExit}
      onReset={() => persist({ ...profile, wallet: STARTING_WALLET })} />;
  }

  const transport = engineRef.current;
  const snap = snapshot;
  const say = (text, color = TEXT) => {
    setToast({ text, color });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1700);
  };

  const state = snap;                 // всё, что знает клиент
  const human = snap.you;
  const stats = snap.market;
  const notional = Math.max(0, Number(size) || 0);
  const myLimits = snap.yourOrders;
  const changeAbs = snap.price - snap.initialPrice;
  const changePct = changeAbs / snap.initialPrice;
  const pos = human.position;
  const pnl = human.unrealized;
  const pnlRatio = pos ? pnl / pos.margin : 0;
  const equity = human.equity;
  const pnlColor = pnl > 0 ? LONG : pnl < 0 ? SHORT : TEXT;

  const refresh = () => setSnapshot(transport.snapshot());
  const togglePause = () => {
    transport.setPaused(!transport.paused);
    setPaused(transport.paused);
  };
  /** Все действия игрока идут одним путём — через команду транспорту.
   *  transport.send() асинхронный (в онлайн-режиме это сетевой вызов),
   *  поэтому и весь путь команды — от кнопки до тоста — асинхронный. */
  const send = async (command) => {
    const res = await transport.send(command);
    if (!res.ok) say(res.reason, SHORT);
    refresh();
    return res;
  };

  const buyHint = pos && pos.side === "short" ? "закроет Short" : "открыть / увеличить Long";
  const sellHint = pos && pos.side === "long" ? "закроет Long" : "открыть / увеличить Short";

  const doBuy = async () => {
    const res = await send({ type: "TRADE", action: "BUY", notional, reason: "ручная покупка" });
    if (res.ok) say(pos && pos.side === "short" ? "закрываем Short" : `покупка ${fmt(notional, 0)}`, LONG);
  };
  const doSell = async () => {
    const res = await send({ type: "TRADE", action: "SELL", notional, reason: "ручная продажа" });
    if (res.ok) say(pos && pos.side === "long" ? "закрываем Long" : `продажа ${fmt(notional, 0)}`, SHORT);
  };
  const doClose = async (fraction, label) => {
    const res = await send({ type: "TRADE", action: "CLOSE", fraction, reason: "ручное закрытие" });
    if (res.ok) say(label);
  };
  const setRisk = async (kind, delta) => {
    if (!pos) return;
    const long = pos.side === "long";
    const target = kind === "sl"
      ? (long ? pos.entryPrice * (1 - delta) : pos.entryPrice * (1 + delta))
      : (long ? pos.entryPrice * (1 + delta) : pos.entryPrice * (1 - delta));
    const res = await send({
      type: "PROTECT",
      stopLoss: kind === "sl" ? target : null,
      takeProfit: kind === "tp" ? target : null,
    });
    if (res.ok) say(`${kind === "sl" ? "стоп" : "тейк"} ${target.toFixed(2)}`);
  };

  const TAB_KEYS = ["Рынок", "Позиции", "Ордера", "Участники", "Отладка"];

  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex flex-col h-full relative">

        {/* --------------------------------- шапка --------------------------- */}
        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-[11px] tracking-[0.3em]" style={{ color: FAINT }}>
            {CONFIG.market.assetSymbol} · {fmt(session, 0)}
          </span>
          <div className="flex items-center gap-4">
            <button onClick={togglePause} className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: paused ? FAINT : TEXT }} />
              <span className="text-[11px] tracking-[0.15em]" style={{ color: paused ? FAINT : DIM }}>
                {paused ? "ПАУЗА" : "LIVE"}
              </span>
            </button>
            <button onClick={() => setShowSettings((v) => !v)}
              className="text-[11px] tracking-[0.15em]" style={{ color: showSettings ? TEXT : FAINT }}>
              ЕЩЁ
            </button>
          </div>
        </div>

        {showSettings && (
          <div className="px-5 pb-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] tracking-[0.15em]" style={{ color: FAINT }}>СКОРОСТЬ</span>
              <div className="flex gap-1">
                {[1, 2, 5, 10].map((s) => (
                  <Toggle key={s} active={speed === s} onClick={() => setSpeed(s)}>{s}x</Toggle>
                ))}
              </div>
            </div>
            {confirmingEnd ? (
              <div className="flex gap-2">
                <button onClick={() => setConfirmingEnd(false)} className="flex-1 rounded-lg py-3 text-[13px]"
                  style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                  Отмена
                </button>
                <button onClick={finishSession} className="flex-1 rounded-lg py-3 text-[13px] font-semibold"
                  style={{ backgroundColor: SHORT, color: BG }}>
                  Да, завершить
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmingEnd(true)} className="rounded-lg py-3 text-[13px]"
                style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                Завершить сессию · {fmt(equity)} на баланс
              </button>
            )}
          </div>
        )}

        {/* -------------------------------- контент -------------------------- */}
        <div className="flex-1 overflow-y-auto">

          {tab === "Рынок" && (
            <>
              <div className="px-5 pt-1 flex items-end justify-between">
                <div>
                  <div className="text-[46px] leading-none font-mono tracking-tight">
                    {fmt(state.price)}
                  </div>
                  <div className="text-[14px] font-mono mt-1.5" style={{ color: changeAbs >= 0 ? LONG : SHORT }}>
                    {changeAbs >= 0 ? "+" : "−"}{Math.abs(changePct * 100).toFixed(2)}%
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] tracking-[0.15em]" style={{ color: DIM }}>{state.phase}</div>
                  <div className="text-[11px] font-mono mt-1" style={{ color: FAINT }}>
                    {stats.activePositions} / {CONFIG.market.totalPlayers} в рынке
                  </div>
                </div>
              </div>

              {/* Полоса сторон — единственный график толпы на главном экране */}
              <div className="px-5 pt-4">
                <div className="h-1 w-full flex rounded-full overflow-hidden" style={{ backgroundColor: HAIR }}>
                  <div style={{ width: `${stats.longShare * 100}%`, backgroundColor: LONG }} />
                  <div style={{ width: `${stats.shortShare * 100}%`, backgroundColor: SHORT }} />
                </div>
              </div>

              <div className="px-5 pt-4 grid grid-cols-4 gap-3">
                <Metric label="LONG" value={fmt(stats.longExposure, 0)} color={LONG} />
                <Metric label="SHORT" value={fmt(stats.shortExposure, 0)} color={SHORT} />
                <Metric label="BUY PRESS" value={fmt(state.buyPressure, 0)} />
                <Metric label="SELL PRESS" value={fmt(state.sellPressure, 0)} />
              </div>

              <div className="flex items-center justify-between px-5 pt-5">
                <div className="flex gap-0.5">
                  {TIMEFRAMES.map((tf) => (
                    <Toggle key={tf.label} active={timeframe === tf.label} onClick={() => setTimeframe(tf.label)}>
                      {tf.label}
                    </Toggle>
                  ))}
                </div>
                <button onClick={() => setChartMode(chartMode === "свечи" ? "линия" : "свечи")}
                  className="text-[12px]" style={{ color: DIM }}>{chartMode}</button>
              </div>

              <div className="px-2 pt-1">
                <Chart state={state} timeframe={timeframe} mode={chartMode}
                  entryPrice={pos?.entryPrice} stopLoss={human.stopLoss} takeProfit={human.takeProfit} />
              </div>

              <div className="px-5 pb-4 grid grid-cols-4 gap-3">
                <Metric label="ЭКВИТИ" value={fmt(equity)} />
                <Metric label="СВОБОДНО" value={fmt(human.cash)} />
                <Metric label="ПОЗИЦИЯ"
                  value={pos ? `${pos.side === "long" ? "LONG" : "SHORT"} ${fmt(pos.margin, 0)}` : "—"}
                  color={pos ? (pos.side === "long" ? LONG : SHORT) : TEXT} />
                <Metric label="PNL" value={pos ? fmtSigned(pnl) : "—"} color={pnlColor} />
              </div>
            </>
          )}

          {tab === "Позиции" && (
            <div className="px-5 pt-2 pb-6">
              <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>ПОЗИЦИЯ</div>
              {pos ? (
                <>
                  <div className="flex items-baseline justify-between mb-4">
                    <span className="text-[26px]" style={{ color: pos.side === "long" ? LONG : SHORT }}>
                      {pos.side === "long" ? "LONG" : "SHORT"}
                    </span>
                    <span className="text-[20px] font-mono">{fmt(pos.margin)}</span>
                    <span className="text-[15px] font-mono" style={{ color: pnlColor }}>
                      {fmtSigned(pnl)} · {signedPct(pnlRatio)}
                    </span>
                  </div>
                  <Line left="Цена входа" right={fmt(pos.entryPrice)} />
                  <Line left="Текущая цена" right={fmt(state.price)} />
                  <Line left="Объём в единицах" right={pos.units.toFixed(4)} />
                  <Line left="При закрытии сейчас" right={fmt(pos.settlement)} />
                  <Line left="Стоп-лосс" right={human.stopLoss ? fmt(human.stopLoss) : "нет"} />
                  <Line left="Тейк-профит" right={human.takeProfit ? fmt(human.takeProfit) : "нет"} />
                  <div className="grid grid-cols-3 gap-2 mt-4">
                    {[[0.25, "25%"], [0.5, "50%"], [1, "всё"]].map(([f, l]) => (
                      <button key={l} onClick={() => doClose(f, `закрыто ${l}`)}
                        className="rounded-lg py-3 text-[13px]"
                        style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>{l}</button>
                    ))}
                  </div>
                </>
              ) : <Blank>Позиции нет</Blank>}

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>ИТОГИ</div>
              <Line left="Стартовый капитал" right={fmt(human.startingCapital)} />
              <Line left="Эквити" right={fmt(equity)} />
              <Line left="Всего заработано" right={fmtSigned(equity - human.startingCapital)}
                color={equity >= human.startingCapital ? LONG : SHORT} />
              <Line left="Реализованный PnL" right={fmtSigned(human.realizedPnL)}
                color={human.realizedPnL >= 0 ? LONG : SHORT} />
              <Line left="Место в рейтинге" right={`${snap.rank} из ${snap.totalPlayers}`} />

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>ВАШИ СДЕЛКИ</div>
              {snap.yourTrades.length === 0 ? <Blank>сделок не было</Blank> :
                snap.yourTrades.map((t, i) => (
                  <Line key={i}
                    left={`${clock(t.time)} · ${t.action === "BUY" ? "покупка" : t.action === "SELL" ? "продажа" : "закрытие"}`}
                    right={`${fmt(t.notional, 0)} @ ${t.execPrice.toFixed(2)}${t.realizedPnL !== undefined ? `  ${fmtSigned(t.realizedPnL)}` : ""}`}
                    color={t.flow === "buy" ? LONG : SHORT} />
                ))}
            </div>
          )}

          {tab === "Ордера" && (
            <div className="px-5 pt-2 pb-6">
              <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>
                ЛИМИТНЫЕ ЗАЯВКИ · {myLimits.length}
              </div>
              {myLimits.length === 0 ? <Blank>активных заявок нет</Blank> :
                myLimits.map((o) => (
                  <div key={o.id} className="flex items-center justify-between py-3 border-b" style={{ borderColor: HAIR }}>
                    <div>
                      <div className="text-[13px]" style={{ color: o.side === "buy" ? LONG : SHORT }}>
                        {o.side === "buy" ? "покупка" : "продажа"} {fmt(o.notional, 0)}
                      </div>
                      <div className="text-[11px] font-mono" style={{ color: FAINT }}>
                        при цене {o.side === "buy" ? "≤" : "≥"} {o.limitPrice.toFixed(2)}
                      </div>
                    </div>
                    <button onClick={async () => { if ((await send({ type: "CANCEL_LIMIT", orderId: o.id })).ok) say("заявка снята"); }}
                      className="text-[12px]" style={{ color: DIM }}>снять</button>
                  </div>
                ))}

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>ЗАЩИТА ПОЗИЦИИ</div>
              {!pos ? <Blank>нужна открытая позиция</Blank> : (
                <>
                  <div className="flex items-center justify-between py-3 border-b" style={{ borderColor: HAIR }}>
                    <span className="text-[13px] font-mono">стоп {human.stopLoss ? fmt(human.stopLoss) : "—"}</span>
                    {human.stopLoss && (
                      <button onClick={() => send({ type: "PROTECT", clear: "sl", stopLoss: null, takeProfit: null })}
                        className="text-[12px]" style={{ color: DIM }}>убрать</button>
                    )}
                  </div>
                  <div className="flex items-center justify-between py-3">
                    <span className="text-[13px] font-mono">тейк {human.takeProfit ? fmt(human.takeProfit) : "—"}</span>
                    {human.takeProfit && (
                      <button onClick={() => send({ type: "PROTECT", clear: "tp", stopLoss: null, takeProfit: null })}
                        className="text-[12px]" style={{ color: DIM }}>убрать</button>
                    )}
                  </div>
                </>
              )}

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>
                ЗАЯВКИ УЧАСТНИКОВ · {snap.orders.length}
              </div>
              {snap.orders.length === 0
                ? <Blank>боты пользуются стопами и тейками</Blank>
                : snap.orders.slice(0, 20).map((o) => (
                    <Line key={o.id} left={o.playerName}
                      right={`${fmt(o.notional, 0)} @ ${o.limitPrice.toFixed(2)}`}
                      color={o.side === "buy" ? LONG : SHORT} />
                  ))}
            </div>
          )}

          {tab === "Участники" && (
            <div className="px-5 pt-2 pb-6">
              <div className="grid grid-cols-3 gap-3 mb-5">
                <Metric label="В ЛОНГЕ" value={String(stats.longPlayers)} color={LONG} />
                <Metric label="В ШОРТЕ" value={String(stats.shortPlayers)} color={SHORT} />
                <Metric label="ВНЕ РЫНКА" value={String(stats.flatPlayers)} />
              </div>
              <div className="flex gap-0.5 mb-2 flex-wrap">
                {["Все", "Лонг", "Шорт", "Вне рынка", "Топ-15"].map((f) => (
                  <Toggle key={f} active={playerFilter === f} onClick={() => setPlayerFilter(f)}>{f}</Toggle>
                ))}
              </div>
              {(() => {
                let list = [...snap.players];
                if (playerFilter === "Лонг") list = list.filter((p) => p.position?.side === "long");
                if (playerFilter === "Шорт") list = list.filter((p) => p.position?.side === "short");
                if (playerFilter === "Вне рынка") list = list.filter((p) => !p.position);
                list.sort((a, b) => b.equity - a.equity);
                if (playerFilter === "Топ-15") list = list.slice(0, 15);
                if (list.length === 0) return <Blank>пусто</Blank>;
                return list.map((p, i) => {
                  const eq = p.equity;
                  const delta = eq - p.startingCapital;
                  return (
                    <div key={p.id} className="flex items-center gap-3 py-2.5 border-b" style={{ borderColor: HAIR }}>
                      <span className="text-[11px] font-mono w-6 shrink-0" style={{ color: FAINT }}>{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] truncate" style={{ color: p.isHuman ? TEXT : DIM }}>
                          {p.name}
                          {p.position && (
                            <span className="ml-2 text-[11px] font-mono"
                              style={{ color: p.position.side === "long" ? LONG : SHORT }}>
                              {p.position.side === "long" ? "long" : "short"} {fmt(p.position.margin, 0)}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] truncate" style={{ color: FAINT }}>
                          {p.isHuman ? "живой игрок" : STRATEGY_LABELS[p.archetype]} · сделок {p.tradeCount}
                        </div>
                      </div>
                      <div className="text-right whitespace-nowrap">
                        <div className="text-[13px] font-mono">{fmt(eq)}</div>
                        <div className="text-[11px] font-mono" style={{ color: delta >= 0 ? LONG : SHORT }}>
                          {fmtSigned(delta)}
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}

          {tab === "Отладка" && (
            <div className="px-5 pt-2 pb-6">
              <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>КАПИТАЛ СИСТЕМЫ</div>
              <Line left="Общий капитал рынка" right={fmt(state.totalCapital)} />
              <Line left="Свободный кэш участников" right={fmt(stats.totalCash)} />
              <Line left="Кэш пула" right={fmt(snap.debug?.poolCash ?? 0)} />
              <Line left="Эквити пула" right={fmt(stats.poolEquity)} />
              <Line left="Эквити участников" right={fmt(stats.totalEquity)} />
              <Line left="Сумма" right={fmt(stats.totalEquity + stats.poolEquity)} />
              <Line left="Расхождение капитала" right={(snap.debug?.capitalDrift ?? 0).toExponential(2)}
                color={Math.abs(snap.debug?.capitalDrift ?? 0) < 1e-5 ? LONG : SHORT} />

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>МЕХАНИКА ЦЕНЫ</div>
              <Line left="Давление покупок" right={fmt(state.buyPressure)} />
              <Line left="Давление продаж" right={fmt(state.sellPressure)} />
              <Line left="Чистое давление" right={fmt(state.netPressure)}
                color={state.netPressure >= 0 ? LONG : SHORT} />
              <Line left="Ликвидность" right={fmt(state.liquidity)} />
              <Line left="Капитализация" right={fmt(stats.marketCap)} />
              <Line left="Фаза рынка" right={state.phase} />
              <Line left="Скорость (10 тиков)" right={signedPct(snap.debug?.context?.speed ?? 0)} />
              <Line left="Волатильность" right={((snap.debug?.context?.volatility ?? 0) * 100).toFixed(3) + "%"} />
              <Line left="Перекос толпы" right={signedPct(snap.debug?.context?.imbalance ?? 0, 0)} />
              <Line left="Всего сделок" right={String(snap.totalTrades)} />

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-2" style={{ color: FAINT }}>
                СДЕЛКИ ПОСЛЕДНЕГО ТИКА · ПОЧЕМУ ЦЕНА ДВИНУЛАСЬ
              </div>
              {(snap.debug?.lastTrades ?? []).length === 0
                ? <Blank>сделок не было — цена стоит на месте</Blank>
                : snap.debug.lastTrades.slice(0, 14).map((t, i) => (
                    <Line key={i}
                      left={`${t.playerName} · ${t.action === "BUY" ? "покупка" : t.action === "SELL" ? "продажа" : "закрытие"} · ${t.reason}`}
                      right={`${fmt(t.notional, 0)} @ ${t.execPrice.toFixed(2)}`}
                      color={t.flow === "buy" ? LONG : SHORT} />
                  ))}

              <div className="flex items-center justify-between mt-8 mb-2">
                <span className="text-[11px] tracking-[0.15em]" style={{ color: FAINT }}>NPC И ПРИЧИНЫ РЕШЕНИЙ</span>
                <div className="flex gap-0.5">
                  {["активные", "все"].map((m) => (
                    <Toggle key={m} active={npcMode === m} onClick={() => setNpcMode(m)}>{m}</Toggle>
                  ))}
                </div>
              </div>
              {(() => {
                // Отладочный блок приходит только в dev-снапшоте.
                // В продакшене сервер его не отдаёт, и вкладка будет пустой.
                let list = snap.players.filter((p) => p.debug);
                if (list.length === 0) return <Blank>отладка ботов доступна только в dev-режиме</Blank>;
                if (npcMode === "активные") {
                  list = list.filter((p) => p.position || snap.tick - p.debug.lastActionTick < 120);
                }
                list = list.sort((a, b) => b.debug.lastActionTick - a.debug.lastActionTick).slice(0, 25);
                if (list.length === 0) return <Blank>сейчас никто не действует</Blank>;
                return list.map((p) => {
                  const pnlNow = p.unrealized;
                  return (
                    <div key={p.id} className="py-2.5 border-b" style={{ borderColor: HAIR }}>
                      <div className="flex justify-between gap-2">
                        <span className="text-[12px] truncate">
                          {p.name} · <span style={{ color: DIM }}>{STRATEGY_LABELS[p.archetype]}</span>
                        </span>
                        <span className="text-[12px] font-mono whitespace-nowrap">{p.debug.lastAction}</span>
                      </div>
                      <div className="text-[11px] font-mono mt-0.5" style={{ color: FAINT }}>
                        капитал {fmt(p.equity, 0)} ·{" "}
                        {p.position
                          ? `${p.position.side} ${fmt(p.position.margin, 0)} от ${p.position.entryPrice.toFixed(2)} · ${fmtSigned(pnlNow)}`
                          : "вне рынка"}
                      </div>
                      <div className="text-[11px] font-mono" style={{ color: FAINT }}>
                        окно {p.debug.lookback}т · решение каждые {(p.debug.intervalTicks / 10).toFixed(1)}с ·
                        {" "}точность {(p.debug.accuracy * 100).toFixed(0)}% · ошибок {p.debug.mistakes}
                      </div>
                      <div className="text-[11px] font-mono" style={{ color: FAINT }}>
                        +{p.debug.wins} / −{p.debug.losses} · уверенность {(p.debug.confidence * 100).toFixed(0)}% ·
                        {" "}режим {p.debug.regimeBias > 0.2 ? "за трендом" : p.debug.regimeBias < -0.2 ? "против тренда" : "нейтрально"} ·
                        {" "}след. решение в {p.debug.nextDecisionTick}
                      </div>
                      <div className="flex flex-wrap gap-x-3 mt-0.5">
                        {(p.debug.lastReasons ?? []).map(([label, value], i) => (
                          <span key={i} className="text-[11px] font-mono"
                            style={{ color: value > 0 ? LONG : value < 0 ? SHORT : FAINT }}>
                            {label} {value >= 0 ? "+" : ""}{value.toFixed(2)}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>

        {/* ---------------------------- панель торговли ---------------------- */}
        {tab === "Рынок" && (
          <div className="px-4 pt-3 pb-3 border-t" style={{ borderColor: HAIR, backgroundColor: BG }}>
            {sheet && (
              <>
                <div className="fixed inset-0 z-10" style={{ backgroundColor: "rgba(0,0,0,0.75)" }}
                  onClick={() => setSheet(null)} />
                <div className="relative z-20 mb-3 rounded-lg p-3"
                  style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-[12px]">{sheet === "risk" ? "Стоп и тейк" : "Лимитная заявка"}</span>
                    <button onClick={() => setSheet(null)} className="text-[11px]" style={{ color: DIM }}>закрыть</button>
                  </div>

                  {sheet === "risk" ? (
                    <div className="flex flex-col gap-2">
                      {[["sl", "СТОП", [0.01, 0.02, 0.05], "−"], ["tp", "ТЕЙК", [0.01, 0.03, 0.06], "+"]].map(
                        ([kind, label, steps, sign]) => (
                          <div key={kind} className="flex items-center gap-2">
                            <span className="text-[10px] w-10 shrink-0" style={{ color: FAINT }}>{label}</span>
                            {steps.map((d) => (
                              <button key={d} disabled={!pos} onClick={() => setRisk(kind, d)}
                                className="flex-1 py-2.5 rounded text-[12px] font-mono disabled:opacity-25"
                                style={{ backgroundColor: RAISED }}>
                                {sign}{(d * 100).toFixed(0)}%
                              </button>
                            ))}
                            <span className="w-14 text-right text-[12px] font-mono" style={{ color: DIM }}>
                              {kind === "sl"
                                ? (human.stopLoss ? human.stopLoss.toFixed(2) : "—")
                                : (human.takeProfit ? human.takeProfit.toFixed(2) : "—")}
                            </span>
                          </div>
                        )
                      )}
                      {!pos && <div className="text-[11px]" style={{ color: FAINT }}>
                        Уровни считаются от цены входа — сначала откройте позицию.
                      </div>}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button onClick={() => setLimitSide(limitSide === "buy" ? "sell" : "buy")}
                        className="px-3 py-2.5 rounded text-[12px] font-semibold whitespace-nowrap"
                        style={{ backgroundColor: limitSide === "buy" ? LONG : SHORT, color: BG }}>
                        {limitSide === "buy" ? "LONG" : "SHORT"}
                      </button>
                      <input value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} inputMode="decimal"
                        placeholder={`цена · сейчас ${state.price.toFixed(2)}`}
                        className="flex-1 min-w-0 rounded px-3 py-2.5 outline-none font-mono text-[13px]"
                        style={{ backgroundColor: RAISED, color: TEXT }} />
                      <button
                        onClick={async () => {
                          const res = await send({
                            type: "LIMIT", side: limitSide, notional, limitPrice: Number(limitPrice),
                          });
                          if (res.ok) { setLimitPrice(""); setSheet(null); say("заявка выставлена"); }
                        }}
                        className="px-4 py-2.5 rounded text-[12px] font-semibold"
                        style={{ backgroundColor: TEXT, color: BG }}>ОК</button>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="flex items-center gap-1.5 mb-2.5">
              <div className="flex-1 flex items-center rounded px-3 py-2 min-w-0"
                style={{ backgroundColor: SURFACE }}>
                <span className="font-mono text-[13px] mr-1.5" style={{ color: FAINT }}>$</span>
                <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal"
                  className="w-full bg-transparent outline-none font-mono text-[15px] min-w-0"
                  style={{ color: TEXT }} />
              </div>
              {[0.25, 0.5, 1].map((f) => (
                <button key={f} onClick={() => setSize(String(Math.round(human.cash * f)))}
                  className="px-2.5 py-2.5 rounded font-mono text-[11px]"
                  style={{ backgroundColor: SURFACE, color: DIM }}>{f * 100}%</button>
              ))}
              <button onClick={() => setSheet(sheet === "risk" ? null : "risk")}
                className="px-2.5 py-2.5 rounded text-[11px]"
                style={{ backgroundColor: sheet === "risk" ? TEXT : SURFACE, color: sheet === "risk" ? BG : DIM }}>
                SL/TP
              </button>
              <button onClick={() => setSheet(sheet === "limit" ? null : "limit")}
                className="px-2.5 py-2.5 rounded text-[11px]"
                style={{ backgroundColor: sheet === "limit" ? TEXT : SURFACE, color: sheet === "limit" ? BG : DIM }}>
                лимит{myLimits.length ? ` ${myLimits.length}` : ""}
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button disabled={notional < 1 && !(pos && pos.side === "short")} onClick={doBuy}
                className="rounded-lg py-3 disabled:opacity-25 flex flex-col items-center"
                style={{ backgroundColor: LONG, color: BG, boxShadow: `0 0 26px ${LONG}38` }}>
                <span className="font-bold text-[16px] tracking-wide">ЛОНГ</span>
                <span className="text-[9px] opacity-70 leading-tight">{buyHint}</span>
              </button>
              <button disabled={notional < 1 && !(pos && pos.side === "long")} onClick={doSell}
                className="rounded-lg py-3 disabled:opacity-25 flex flex-col items-center"
                style={{ backgroundColor: SHORT, color: BG, boxShadow: `0 0 26px ${SHORT}38` }}>
                <span className="font-bold text-[16px] tracking-wide">ШОРТ</span>
                <span className="text-[9px] opacity-70 leading-tight">{sellHint}</span>
              </button>
              <button disabled={!pos} onClick={() => doClose(1, "позиция закрыта")}
                className="rounded-lg py-3 disabled:opacity-25 flex flex-col items-center"
                style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                <span className="font-bold text-[16px] tracking-wide">ЗАКРЫТЬ</span>
                <span className="text-[9px] leading-tight" style={{ color: pos ? pnlColor : FAINT }}>
                  {pos ? fmtSigned(pnl) : "нет позиции"}
                </span>
              </button>
            </div>
          </div>
        )}

        {toast && (
          <div className="absolute left-0 right-0 flex justify-center pointer-events-none" style={{ bottom: 150 }}>
            <div className="px-4 py-2 rounded-full text-[12px]"
              style={{ backgroundColor: RAISED, color: toast.color, border: `1px solid ${HAIR}` }}>
              {toast.text}
            </div>
          </div>
        )}

        <div className="grid grid-cols-5 border-t" style={{ borderColor: HAIR }}>
          {TAB_KEYS.map((key) => (
            <button key={key} onClick={() => setTab(key)} className="py-3 text-[11px]"
              style={{ color: tab === key ? TEXT : FAINT }}>
              {key}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ==== ТОЧКА ВХОДА ====
createRoot(document.getElementById("root")).render(<PracticeApp />);

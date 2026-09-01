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

  // --- Оборот NPC (LIVENESS-FIX) ---
  // stop/take в ARCHETYPES заданы в долях цены входа (-0.25 = -25%).
  // Реальный ход цены в закрытом рынке ~3%, поэтому НИ ОДИН порог никогда
  // не срабатывал: боты открывались в первые тики и держали позицию вечно.
  // Замер: сделок за 25 тиков 76 -> 18 -> 2 -> 0 (полная остановка к 100-му тику).
  NPC_PNL_SCALE: 0.15,   // масштаб порогов под реальный диапазон цены
  NPC_HOLD_MIN: 40,      // выход по времени: никто не сидит в позиции вечно
  NPC_HOLD_MAX: 400,
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
      // lag = 0 означал past = history[последний] = ТЕКУЩАЯ цена, то есть
      // mom === 0 всегда: 60% ботов были слепыми. Минимум теперь 1 тик.
      lag: r() < CONFIG.NPC_INSTANT_FRACTION ? 1 : 2 + Math.floor(r() * 5),
      stop: spec.stop * CONFIG.NPC_PNL_SCALE,
      take: spec.take * CONFIG.NPC_PNL_SCALE,
      hold: Math.round(CONFIG.NPC_HOLD_MIN +
        r() * (CONFIG.NPC_HOLD_MAX - CONFIG.NPC_HOLD_MIN)),
      since: 0, lastU: 0,
      rng: mulberry32(seed * 7919 + k + 1),
    };
  }
}

/** Решение NPC. Видит только: текущую цену, историю, своё состояние, свой шум. */
function decide(m, i, history) {
  const pl = m.players[i], n = pl.npc;
  if (!n) return 0;
  // Сколько тиков бот находится в текущем состоянии (позиция не менялась).
  if (n.lastU !== pl.u) { n.lastU = pl.u; n.since = 0; }
  n.since++;
  const r = n.rng;
  if (r() > n.act) return 0;

  const P = m.mark;
  const lag = Math.max(1, n.lag);          // 0 давал mom === 0 всегда
  const j = Math.max(0, history.length - 1 - lag);
  const past = history.length ? history[j] : P;
  const mom = (P - past) / Math.max(past, 1e-9);

  if (pl.u !== 0 && pl.entryPrice !== null) {
    const pnl = pl.u > 0 ? (P - pl.entryPrice) / pl.entryPrice
                         : (pl.entryPrice - P) / pl.entryPrice;
    if (pnl <= n.stop || pnl >= n.take) return -pl.u;   // стоп / тейк
    if (n.since >= n.hold) return -pl.u;                // выход по времени
    // Живой оборот: боты доливают и частично фиксируют, а не сидят камнем.
    if (r() < 0.12) {
      if (r() < 0.5) return -pl.u * (0.3 + 0.4 * r());
      const add = m.curve.unitsFor(pl.cash * n.size * 0.5, P);
      return pl.u > 0 ? add : -add;
    }
    return 0;
  }

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
    this._startingCapital = startingCapital;
    this.paused = false;
    this._buyPressure = 0;
    this._sellPressure = 0;
    this._totalTrades = 0;
    this._priceHistory = this._room.history.map((price, i) => ({
      price, t: i * CONFIG.market.tickMs, volume: 0,
    }));
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
    this._priceHistory.push({
      price: this._room.market.mark,
      t: this._room.market.tick * CONFIG.market.tickMs,
      volume: buy + sell,   // оборот тика — высота столбика объёма на графике
    });
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
      market: { ...this._aggregate(base.participants || []), poolEquity: base.escrow },
      price: this._room.market.mark,
      previousPrice: this._priceHistory.length >= 2
        ? this._priceHistory[this._priceHistory.length - 2].price
        : this._room.market.mark,
      initialPrice: CONFIG.market.initialPrice,
      rank: this._rank(viewerId, base.participants || []),
      yourOrders: base.you ? (base.you.limits || []) : [],
      // v4 не хранит историю отдельных сделок игрока (только счётчик tradeCount) —
      // список остаётся пустым, вкладка "сделки" будет пока без записей.
      yourTrades: [],
      // Заявки других участников намеренно не передаются клиенту — так задумано
      // в архитектуре v4 (приватность, см. ARCHITECTURE.md), а не баг переходника.
      orders: [],
      // "ликвидность" старого движка ~ параметр глубины кривой Q нового
      liquidity: base.Q,
      phase: this._phase(base),
    };
  }

  _phase(base) {
    const [lo, hi] = base.priceRange || [0, 1];
    const pos = hi > lo ? (base.mark - lo) / (hi - lo) : 0.5;
    if (pos > 0.8) return "перегрев";
    if (pos < 0.2) return "распродажа";
    return "стабильно";
  }

  _rank(viewerId, participants) {
    const sorted = [...participants].sort((a, b) => b.equity - a.equity);
    const idx = sorted.findIndex((p) => p.id === viewerId);
    return idx === -1 ? null : idx + 1;
  }

  _legacyPlayer(p) {
    return {
      ...p,
      startingCapital: this._startingCapital,
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

/* -------------------------------- СВЕЧИ ---------------------------------- */
const TIMEFRAMES = [
  { label: "1с", ms: 1000 }, { label: "5с", ms: 5000 }, { label: "15с", ms: 15000 },
  { label: "1м", ms: 60000 }, { label: "5м", ms: 300000 },
];

// Свечи строятся ТОЛЬКО из price stream движка, отдельной генерации нет.
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

/* --------------------------------- ГРАФИК ---------------------------------
   Рисуется в реальных пикселях контейнера. Раньше был фиксированный viewBox
   с preserveAspectRatio="none" — из-за этого картинка растягивалась под
   размер экрана и свечи выглядели раздутыми. Теперь размер меряется через
   ResizeObserver, и одна единица SVG равна одному пикселю.

   Жесты (как на биржевых терминалах):
     - один палец по горизонтали  — прокрутка истории;
     - два пальца, разводим/сводим по горизонтали — ширина свечи (масштаб времени);
     - два пальца по вертикали    — растяжение ценовой шкалы;
     - двойное касание            — сброс к автомасштабу.
   -------------------------------------------------------------------------- */
const AXIS_W = 56;          // ширина ценовой шкалы справа
const VOL_H = 44;           // высота стакана объёмов снизу
const PAD_T = 10, PAD_B = 6;
const BAR_MIN = 2.5, BAR_MAX = 34, BAR_DEFAULT = 8;
const HISTORY_CANDLES = 600;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function Chart({ state, timeframe, mode, entryPrice, stopLoss, takeProfit }) {
  const box = useRef(null);
  const [size, setSize] = useState({ w: 360, h: 300 });

  // --- измерение контейнера ---
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setSize((p) => (Math.abs(p.w - r.width) < 1 && Math.abs(p.h - r.height) < 1
          ? p : { w: r.width, h: r.height }));
      }
    };
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- состояние вида ---
  const [barW, setBarW] = useState(BAR_DEFAULT);   // ширина слота свечи, px
  const [offset, setOffset] = useState(0);         // сдвиг вправо-налево, в свечах
  const [yZoom, setYZoom] = useState(1);           // растяжение ценовой шкалы
  const view = useRef({ barW, offset, yZoom });
  view.current = { barW, offset, yZoom };
  const auto = offset === 0 && Math.abs(yZoom - 1) < 0.01 && barW === BAR_DEFAULT;

  // --- жесты ---
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let one = null, two = null, lastTap = 0;

    const spread = (t) => ({
      x: Math.abs(t[0].clientX - t[1].clientX),
      y: Math.abs(t[0].clientY - t[1].clientY),
    });

    const start = (e) => {
      if (e.touches.length === 2) {
        const s = spread(e.touches);
        two = { x: Math.max(12, s.x), y: Math.max(12, s.y), ...view.current };
        one = null;
      } else if (e.touches.length === 1) {
        one = { x: e.touches[0].clientX, offset: view.current.offset };
        const now = Date.now();
        if (now - lastTap < 300) {
          setBarW(BAR_DEFAULT); setOffset(0); setYZoom(1);
        }
        lastTap = now;
      }
    };

    const move = (e) => {
      if (e.touches.length === 2 && two) {
        e.preventDefault();
        const s = spread(e.touches);
        // По горизонтали — время, по вертикали — цена. Ось выбирается
        // по тому, какое расстояние изменилось заметнее.
        const kx = Math.max(12, s.x) / two.x;
        const ky = Math.max(12, s.y) / two.y;
        if (Math.abs(kx - 1) > 0.04) setBarW(clamp(two.barW * kx, BAR_MIN, BAR_MAX));
        if (Math.abs(ky - 1) > 0.04) setYZoom(clamp(two.yZoom / ky, 0.25, 4));
        return;
      }
      if (e.touches.length === 1 && one) {
        const dx = e.touches[0].clientX - one.x;
        if (Math.abs(dx) < 6) return;
        e.preventDefault();
        setOffset(clamp(Math.round(one.offset + dx / view.current.barW),
          0, HISTORY_CANDLES));
      }
    };

    const end = (e) => { if (e.touches.length === 0) { one = null; two = null; } };
    const wheel = (e) => {
      e.preventDefault();
      setBarW((w) => clamp(w * (e.deltaY > 0 ? 0.9 : 1.11), BAR_MIN, BAR_MAX));
    };

    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("wheel", wheel);
    };
  }, []);

  // --- геометрия ---
  const W = size.w, H = size.h;
  const plotW = Math.max(40, W - AXIS_W);
  const plotH = Math.max(60, H - VOL_H - PAD_T - PAD_B);
  const volTop = PAD_T + plotH + 4;

  const bucketMs = TIMEFRAMES.find((t) => t.label === timeframe)?.ms ?? 1000;
  const all = buildCandles(state.priceHistory, bucketMs, HISTORY_CANDLES);
  const fit = Math.max(4, Math.ceil(plotW / barW));
  const end = Math.max(1, all.length - offset);
  const shown = all.slice(Math.max(0, end - fit), end);

  // --- сглаживание ценовой шкалы ---
  const scale = useRef(null);
  let lo = Infinity, hi = -Infinity, maxVol = 0;
  for (const c of shown) {
    lo = Math.min(lo, c.low); hi = Math.max(hi, c.high);
    maxVol = Math.max(maxVol, c.volume);
  }
  for (const lvl of [entryPrice, stopLoss, takeProfit]) {
    if (lvl && lvl > lo * 0.94 && lvl < hi * 1.06) { lo = Math.min(lo, lvl); hi = Math.max(hi, lvl); }
  }

  if (shown.length < 2 || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return (
      <div ref={box} className="w-full h-full flex items-center justify-center text-[12px]"
        style={{ minHeight: 160 }}>
        <span style={{ color: FAINT }}>собираем свечи…</span>
      </div>
    );
  }

  const mid = (hi + lo) / 2;
  const half = Math.max((hi - lo) / 2, mid * 0.0008) * 1.12 / yZoom;
  const tMin = mid - half, tMax = mid + half;

  const prev = scale.current;
  const jump = !prev || prev.tf !== timeframe || prev.z !== yZoom || prev.off !== offset;
  const EASE = 0.18;
  const min = jump ? tMin : prev.min + (tMin - prev.min) * EASE;
  const max = jump ? tMax : prev.max + (tMax - prev.max) * EASE;
  scale.current = { min, max, tf: timeframe, z: yZoom, off: offset };

  const span = max - min || 1;
  const toY = (p) => PAD_T + plotH - ((p - min) / span) * plotH;
  // Свечи прижаты к правому краю окна.
  const xAt = (i) => plotW - (shown.length - 1 - i) * barW - barW / 2;
  const body = Math.max(1, Math.min(barW * 0.68, barW - 1.2));
  const wick = Math.max(0.7, Math.min(1.4, barW * 0.12));

  // --- сетка: «круглые» уровни цены ---
  const step = niceStep(span / 4);
  const lines = [];
  for (let p = Math.ceil(min / step) * step; p <= max; p += step) lines.push(p);

  const digits = step < 0.1 ? 3 : step < 1 ? 2 : 1;
  const priceY = toY(state.price);
  const up = state.price >= state.previousPrice;

  const level = (value, label, dash, color) =>
    value && value > min && value < max ? (
      <g key={label}>
        <line x1={0} x2={plotW} y1={toY(value)} y2={toY(value)}
          stroke={color} strokeWidth={1} strokeDasharray={dash} opacity={0.75} />
        <text x={4} y={toY(value) - 4} fill={color} fontSize={9} fontFamily="monospace"
          opacity={0.9}>{label}</text>
      </g>
    ) : null;

  return (
    <div ref={box} className="w-full h-full relative select-none"
      style={{ minHeight: 160, touchAction: "none" }}>

      {!auto && (
        <button onClick={() => { setBarW(BAR_DEFAULT); setOffset(0); setYZoom(1); }}
          className="absolute top-1 left-1 z-10 px-2 py-1 rounded text-[10px] font-mono tap"
          style={{ backgroundColor: RAISED, color: DIM, border: `1px solid ${HAIR}` }}>
          {shown.length} св.{offset ? ` · −${offset}` : ""} · сброс
        </button>
      )}

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* сетка и ценовая шкала */}
        {lines.map((p) => (
          <g key={p}>
            <line x1={0} x2={plotW} y1={toY(p)} y2={toY(p)} stroke={HAIR} strokeWidth={1} />
            <text x={plotW + 6} y={toY(p) + 3.5} fill={FAINT} fontSize={10}
              fontFamily="monospace">{p.toFixed(digits)}</text>
          </g>
        ))}

        {mode === "свечи" ? (
          <g>
            {shown.map((c, i) => {
              const x = xAt(i);
              if (x < -barW) return null;
              const grow = c.close >= c.open;
              const color = grow ? LONG : SHORT;
              const top = toY(Math.max(c.open, c.close));
              const bottom = toY(Math.min(c.open, c.close));
              return (
                <g key={c.t}>
                  <rect x={x - wick / 2} y={toY(c.high)} width={wick}
                    height={Math.max(0.6, toY(c.low) - toY(c.high))} fill={color} />
                  <rect x={x - body / 2} y={top} width={body}
                    height={Math.max(1, bottom - top)} fill={color}
                    rx={body > 5 ? 1 : 0} />
                </g>
              );
            })}
          </g>
        ) : (() => {
          const pts = shown.map((c, i) => `${xAt(i).toFixed(1)},${toY(c.close).toFixed(1)}`);
          const trend = shown[shown.length - 1].close >= shown[0].open ? LONG : SHORT;
          return (
            <g>
              <defs>
                <linearGradient id="tx-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={trend} stopOpacity="0.22" />
                  <stop offset="100%" stopColor={trend} stopOpacity="0" />
                </linearGradient>
              </defs>
              <polygon fill="url(#tx-area)"
                points={`${pts.join(" ")} ${xAt(shown.length - 1)},${PAD_T + plotH} ${xAt(0)},${PAD_T + plotH}`} />
              <polyline points={pts.join(" ")} fill="none" stroke={trend}
                strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })()}

        {level(entryPrice, `вход ${entryPrice?.toFixed(2)}`, "1 3", DIM)}
        {level(stopLoss, `стоп ${stopLoss?.toFixed(2)}`, "4 3", SHORT)}
        {level(takeProfit, `тейк ${takeProfit?.toFixed(2)}`, "4 3", LONG)}

        {/* объёмы */}
        {shown.map((c, i) => {
          const x = xAt(i);
          if (x < -barW) return null;
          const h = maxVol === 0 ? 0 : (c.volume / maxVol) * (VOL_H - 6);
          return <rect key={`v${c.t}`} x={x - body / 2} y={volTop + (VOL_H - 6 - h)}
            width={body} height={Math.max(0.5, h)}
            fill={c.close >= c.open ? LONG : SHORT} opacity={0.28} rx={body > 5 ? 1 : 0} />;
        })}

        {/* текущая цена */}
        <line x1={0} x2={plotW} y1={priceY} y2={priceY} stroke={TEXT} strokeWidth={1}
          strokeDasharray="2 3" opacity={0.35} />
        <rect x={plotW + 1} y={priceY - 9} width={AXIS_W - 2} height={18} rx={3}
          fill={up ? LONG : SHORT} />
        <text x={plotW + AXIS_W / 2} y={priceY + 4} textAnchor="middle" fill={BG}
          fontSize={11} fontFamily="monospace" fontWeight="700">
          {state.price.toFixed(2)}
        </text>
      </svg>
    </div>
  );
}

/** Ближайший «человеческий» шаг сетки: 1, 2, 2.5 или 5 на порядок. */
function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return mult * pow;
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
      style={{ color: active ? BG : TEXT,
        backgroundColor: active ? TEXT : RAISED,
        border: `1px solid ${active ? TEXT : HAIR}`, marginRight: 2 }}>
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
  // ОФФЛАЙН: window.storage есть только внутри Claude.ai, на обычном сайте
  // его нет — используем обычный localStorage браузера.
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



/* ============================ АНИМАЦИИ ====================================
   Один <style> на всё приложение. Вставляется один раз при загрузке модуля.
   Все анимации короткие (150-450 мс) и работают на transform/opacity, чтобы
   не вызывать перерасчёт вёрстки на каждом кадре.
   ========================================================================== */
const GLOBAL_CSS = `
@keyframes tx-fade-up { from { opacity: 0; transform: translateY(14px); }
                          to { opacity: 1; transform: none; } }
@keyframes tx-fade    { from { opacity: 0; } to { opacity: 1; } }
@keyframes tx-pop     { 0% { opacity: 0; transform: scale(.94); }
                        60% { transform: scale(1.01); }
                        100% { opacity: 1; transform: scale(1); } }
@keyframes tx-pulse   { 0%,100% { opacity: 1; transform: scale(1); }
                        50% { opacity: .45; transform: scale(.82); } }
@keyframes tx-draw    { from { stroke-dashoffset: var(--len); }
                          to { stroke-dashoffset: 0; } }
@keyframes tx-sheet   { from { opacity: 0; transform: translateY(28px); }
                          to { opacity: 1; transform: none; } }
@keyframes tx-spin    { to { transform: rotate(360deg); } }
@keyframes tx-dome-spin { from { transform: rotateZ(0deg) scaleX(1); }
                          50%  { transform: scaleX(.86); }
                          to   { transform: scaleX(1); } }
@keyframes tx-twinkle { 0%,100% { opacity: .18; } 50% { opacity: .9; } }
@keyframes tx-wave    { 0%,100% { transform: translateY(0); }
                        50% { transform: translateY(-4px); } }

.tx-screen { animation: tx-fade-up .34s cubic-bezier(.22,.9,.3,1) both; }
.tx-in     { animation: tx-fade-up .38s cubic-bezier(.22,.9,.3,1) both; }
.tx-fade   { animation: tx-fade .3s ease both; }
.tx-pop    { animation: tx-pop .32s cubic-bezier(.22,.9,.3,1) both; }
.tx-sheet  { animation: tx-sheet .28s cubic-bezier(.22,.9,.3,1) both; }
.tx-dot    { animation: tx-pulse 2s ease-in-out infinite; }
.tx-spin   { animation: tx-spin 1.1s linear infinite; }
.tx-line   { stroke-dasharray: var(--len); animation: tx-draw .7s ease-out both; }
.tx-dome    { transform-origin: 80px 70px; animation: tx-dome-spin 7s ease-in-out infinite; }
.tx-twinkle { animation: tx-twinkle 2.6s ease-in-out infinite; }
.tx-wave    { animation: tx-wave 4.2s ease-in-out infinite; }

/* Нажатие: лёгкое сжатие. Работает и на тач-устройствах. */
.tap { transition: transform .12s ease, opacity .12s ease, background-color .18s ease,
                   color .18s ease, border-color .18s ease; }
.tap:active { transform: scale(.97); opacity: .9; }

@media (prefers-reduced-motion: reduce) {
  .tx-screen, .tx-in, .tx-fade, .tx-pop, .tx-sheet, .tx-dot, .tx-line, .tx-spin,
  .tx-dome, .tx-twinkle, .tx-wave { animation: none !important; }
}
`;

if (typeof document !== "undefined" && !document.getElementById("tx-css")) {
  const tag = document.createElement("style");
  tag.id = "tx-css";
  tag.textContent = GLOBAL_CSS;
  document.head.appendChild(tag);
}

/** Задержка появления для «лесенки» блоков. */
const stagger = (i) => ({ animationDelay: `${i * 55}ms` });

/* ============================ АККАУНТ И ВХОД ==============================
   ТРЕТИЙ ШОВ ПОД FIREBASE. Экраны ниже — это только интерфейс. Сейчас
   аккаунт хранится локально и НИКАКОЙ проверки подлинности не происходит:
   пароль не сохраняется и не сверяется, любой ввод считается успешным.
   Это честная заглушка, а не защита.

   При переезде на Firebase Auth меняется ровно одна вещь — реализация
   authStore.signIn / signUp / signOut:
     signIn  -> signInWithEmailAndPassword(auth, email, password)
     signUp  -> createUserWithEmailAndPassword(auth, email, password)
     signOut -> firebaseSignOut(auth)
   Сами экраны не меняются: они уже возвращают {ok, reason} и умеют
   показывать ошибку и состояние ожидания.
   ========================================================================== */
const ACCOUNT_KEY = "sandbox:account";

const authStore = {
  async current() {
    try {
      const raw = localStorage.getItem(ACCOUNT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  async signIn(email) {
    const account = { email, at: Date.now() };
    try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); } catch {}
    return { ok: true, account };
  },
  async signUp(email) { return this.signIn(email); },
  async signOut() {
    try { localStorage.removeItem(ACCOUNT_KEY); } catch {}
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Логотип: рамка-«окно» с котировками внутри. Чистый SVG, без картинок. */
function Logo({ size = 96 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <path d="M22 16H16v14M78 16h6v14M22 84H16V70M78 84h6V70"
        stroke={TEXT} strokeWidth={5} strokeLinecap="square" />
      <rect x="28" y="24" width="44" height="52" stroke={TEXT} strokeWidth={3} />
      <g stroke={TEXT} strokeWidth={3}>
        <path d="M38 34v32" /><path d="M50 28v44" /><path d="M62 38v24" />
      </g>
      <g fill={BG} stroke={TEXT} strokeWidth={3}>
        <rect x="34" y="41" width="8" height="16" />
        <rect x="46" y="35" width="8" height="24" />
        <rect x="58" y="45" width="8" height="12" />
      </g>
      <g stroke={TEXT} strokeWidth={3} strokeLinecap="square">
        <path d="M6 44h10M6 54h6M84 44h10M88 54h6" />
      </g>
    </svg>
  );
}

/** Экран загрузки. Показывается, пока читаются аккаунт и профиль. */
function Splash({ text = "загрузка" }) {
  return (
    <div className="w-full flex flex-col items-center justify-center gap-6 tx-fade"
      style={{ height: "100dvh", backgroundColor: BG }}>
      <div className="tx-dot"><Logo size={84} /></div>
      <div className="text-[11px] tracking-[0.35em]" style={{ color: FAINT }}>
        {text.toUpperCase()}
      </div>
    </div>
  );
}

const FEATURES = [
  { icon: "candles", title: "РЕАЛЬНЫЙ РЫНОК",
    text: "Цена формируется только действиями участников." },
  { icon: "people", title: "ЖИВЫЕ ИГРОКИ",
    text: "Торгуй против других участников в реальном времени." },
  { icon: "shield", title: "НИЧЕГО ЛИШНЕГО",
    text: "Никаких внешних факторов. Только ты и рынок." },
];

const FeatureIcon = ({ name }) => {
  const c = { width: 44, height: 44, viewBox: "0 0 44 44", fill: "none",
    stroke: TEXT, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
  if (name === "candles") return (
    <svg {...c}>
      <path d="M11 10v24M22 6v32M33 13v18" />
      <rect x="7" y="16" width="8" height="13" fill={BG} />
      <rect x="18" y="12" width="8" height="20" fill={BG} />
      <rect x="29" y="19" width="8" height="9" fill={BG} />
    </svg>
  );
  if (name === "people") return (
    <svg {...c}>
      <circle cx="15" cy="15" r="5" /><circle cx="29" cy="13" r="4" />
      <path d="M6 34c0-6 4-9 9-9s9 3 9 9M26 34c0-5 3-8 7-8s6 3 6 8" />
    </svg>
  );
  return (
    <svg {...c}>
      <path d="M22 5l14 5v11c0 8-6 14-14 18-8-4-14-10-14-18V10z" />
      <path d="M16 21l5 5 8-9" />
    </svg>
  );
};

/** Онбординг: три слайда, переключаются кнопкой и точками. */
function Onboarding({ onSignIn, onSignUp }) {
  const [slide, setSlide] = useState(0);
  const last = slide === 2;

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 min-h-0 flex flex-col justify-center px-7">

        {slide === 0 && (
          <div key="s0" className="flex flex-col items-center tx-in">
            <Logo size={104} />
            <div className="text-[30px] tracking-tight mt-5">trade.exe</div>
            <div className="text-[12px] tracking-[0.35em] text-center mt-10 leading-loose"
              style={{ color: DIM }}>
              ЗАКРЫТЫЙ РЫНОК<br />ДЛЯ ПРАКТИКИ
            </div>
          </div>
        )}

        {slide === 1 && (
          <div key="s1" className="flex flex-col items-center tx-in">
            <Logo size={72} />
            <div className="text-[22px] tracking-tight mt-3 mb-8">trade.exe</div>
            <div className="w-full">
              {FEATURES.map((f, i) => (
                <div key={f.title}
                  className={`flex items-start gap-5 py-6 tx-in ${i ? "border-t" : ""}`}
                  style={{ borderColor: HAIR, ...stagger(i + 1) }}>
                  <div className="shrink-0 mt-0.5"><FeatureIcon name={f.icon} /></div>
                  <div className="min-w-0">
                    <div className="text-[13px] tracking-[0.2em] font-semibold">{f.title}</div>
                    <div className="text-[13px] mt-1.5 leading-snug" style={{ color: DIM }}>
                      {f.text}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {slide === 2 && (
          <div key="s2" className="flex flex-col items-center text-center tx-in">
            <Logo size={84} />
            <div className="text-[26px] tracking-tight mt-4">Готовы начать?</div>
            <div className="text-[13px] mt-4 leading-relaxed max-w-[280px]" style={{ color: DIM }}>
              Сессия — это закрытая комната на 100 участников с одинаковым взносом.
              Общий капитал не меняется: всё, что кто-то заработал, кто-то потерял.
            </div>
          </div>
        )}
      </div>

      <div className="max-w-md w-full mx-auto px-7 pb-8 shrink-0">
        <div className="flex justify-center gap-2 mb-7">
          {[0, 1, 2].map((i) => (
            <button key={i} onClick={() => setSlide(i)} className="rounded-full"
              style={{ width: i === slide ? 22 : 7, height: 7,
                backgroundColor: i === slide ? TEXT : HAIR,
                transition: "width 260ms cubic-bezier(.22,.9,.3,1), background-color 260ms" }} />
          ))}
        </div>

        <button onClick={() => (last ? onSignIn() : setSlide(slide + 1))}
          className="w-full rounded-2xl py-5 text-[14px] tracking-[0.25em] font-bold tap"
          style={{ backgroundColor: TEXT, color: BG }}>
          {last ? "ВОЙТИ" : "ДАЛЕЕ"}
        </button>
        <button onClick={last ? onSignUp : () => onSignIn()}
          className="w-full py-4 text-[12px] tracking-[0.25em] tap" style={{ color: DIM }}>
          {last ? "СОЗДАТЬ АККАУНТ" : "ПРОПУСТИТЬ"}
        </button>
      </div>
    </div>
  );
}

/** Поле ввода с подписью и, для паролей, кнопкой показа. */
function Field({ label, value, onChange, placeholder, secret, type = "text" }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="mb-4 tx-in">
      <div className="text-[10px] tracking-[0.2em] mb-2" style={{ color: FAINT }}>{label}</div>
      <div className="flex items-center rounded-xl px-4"
        style={{ backgroundColor: RAISED, border: `1px solid ${HAIR}` }}>
        <input value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder} type={secret && !shown ? "password" : type}
          autoCapitalize="none" autoCorrect="off" spellCheck="false"
          className="flex-1 min-w-0 bg-transparent outline-none py-4 text-[14px]"
          style={{ color: TEXT }} />
        {secret && (
          <button onClick={() => setShown((v) => !v)} className="pl-3 text-[11px]"
            style={{ color: shown ? TEXT : FAINT }}>
            {shown ? "скрыть" : "показать"}
          </button>
        )}
      </div>
    </div>
  );
}

const Check = ({ on, onClick, children }) => (
  <button onClick={onClick} className="flex items-start gap-3 text-left w-full">
    <span className="w-[18px] h-[18px] rounded shrink-0 mt-0.5 flex items-center justify-center"
      style={{ backgroundColor: on ? TEXT : "transparent", border: `1px solid ${on ? TEXT : DIM}` }}>
      {on && <Icon name="check" size={12} color={BG} />}
    </span>
    <span className="text-[12px] leading-snug" style={{ color: DIM }}>{children}</span>
  </button>
);

/** Вход и регистрация. Один экран, две вкладки. */
function AuthScreen({ mode, onMode, onBack, onDone }) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [remember, setRemember] = useState(true);
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";

  const submit = async () => {
    setError(null);
    if (!EMAIL_RE.test(email.trim())) return setError("Проверьте адрес почты");
    if (pass.length < 6) return setError("Пароль от 6 символов");
    if (signup && pass !== pass2) return setError("Пароли не совпадают");
    if (signup && !agree) return setError("Нужно принять условия");
    setBusy(true);
    const res = signup
      ? await authStore.signUp(email.trim(), pass)
      : await authStore.signIn(email.trim(), pass);
    setBusy(false);
    if (!res.ok) return setError(res.reason || "Не удалось войти");
    onDone(res.account);
  };

  const tab = (key, label) => (
    <button onClick={() => { onMode(key); setError(null); }}
      className="flex-1 rounded-xl py-3.5 text-[12px] tracking-[0.2em] font-semibold tap"
      style={{ backgroundColor: mode === key ? RAISED : "transparent",
        color: mode === key ? TEXT : FAINT,
        border: `1px solid ${mode === key ? "#3A3A40" : "transparent"}` }}>
      {label}
    </button>
  );

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-6 pt-6 pb-6">
        <button onClick={onBack} className="text-[20px] leading-none py-2"
          style={{ color: TEXT }}>←</button>

        <div className="text-center mt-6">
          <div className="text-[13px] tracking-[0.3em]" style={{ color: DIM }}>
            {signup ? "СОЗДАЙТЕ АККАУНТ" : "ДОБРО ПОЖАЛОВАТЬ"}
          </div>
          <div className="text-[14px] mt-2" style={{ color: DIM }}>
            {signup ? "Начните торговать" : "Войдите в свой аккаунт"}
          </div>
        </div>

        <div className="flex gap-1 p-1 rounded-2xl mt-7 mb-7"
          style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
          {tab("signin", "ВОЙТИ")}
          {tab("signup", "РЕГИСТРАЦИЯ")}
        </div>

        <Field label="EMAIL" value={email} onChange={setEmail}
          placeholder="you@example.com" type="email" />
        <Field label="ПАРОЛЬ" value={pass} onChange={setPass}
          placeholder="Введите пароль" secret />
        {signup && (
          <Field key="p2" label="ПОДТВЕРДИТЕ ПАРОЛЬ" value={pass2} onChange={setPass2}
            placeholder="Повторите пароль" secret />
        )}

        {!signup ? (
          <div className="flex items-center justify-between mt-1 mb-6">
            <Check on={remember} onClick={() => setRemember((v) => !v)}>Запомнить меня</Check>
            <button className="text-[12px] whitespace-nowrap" style={{ color: DIM }}>
              Забыли пароль?
            </button>
          </div>
        ) : (
          <div className="mt-1 mb-6">
            <Check on={agree} onClick={() => setAgree((v) => !v)}>
              Я принимаю Пользовательское соглашение и Политику конфиденциальности
            </Check>
          </div>
        )}

        {error && (
          <div className="text-[12px] mb-4 text-center tx-pop" style={{ color: SHORT }}>{error}</div>
        )}

        <button onClick={submit} disabled={busy}
          className="w-full rounded-2xl py-5 text-[14px] tracking-[0.25em] font-bold disabled:opacity-40 tap"
          style={{ backgroundColor: TEXT, color: BG }}>
          {busy ? "ПОДОЖДИТЕ…" : signup ? "СОЗДАТЬ АККАУНТ" : "ВОЙТИ"}
        </button>

        {!signup && (
          <>
            <div className="flex items-center gap-4 my-6">
              <div className="flex-1 h-px" style={{ backgroundColor: HAIR }} />
              <span className="text-[11px] tracking-[0.2em]" style={{ color: FAINT }}>ИЛИ</span>
              <div className="flex-1 h-px" style={{ backgroundColor: HAIR }} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              {["Google", "Apple"].map((p) => (
                <button key={p} onClick={() => setError(`Вход через ${p} появится вместе с сервером`)}
                  className="rounded-2xl py-4 text-[13px] font-semibold tap"
                  style={{ backgroundColor: RAISED, color: TEXT, border: `1px solid ${HAIR}` }}>
                  {p}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="text-[11px] text-center mt-8 leading-relaxed" style={{ color: FAINT }}>
          {signup
            ? "Уже есть аккаунт? Нажмите «Войти» выше."
            : "Нажимая «Войти», вы соглашаетесь с Условиями и Политикой конфиденциальности."}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- ЛОББИ ---------------------------------
   Главный экран. Три смысловых блока: баланс, дневная динамика, история.
   Всё, что не является результатом игрока, намеренно бесцветно — зелёный
   и красный работают только как знак результата.
   ------------------------------------------------------------------------ */

/** Мелкие иконки. Рисуются вручную, чтобы не тянуть иконочный пакет. */
const Icon = ({ name, size = 16, color = TEXT }) => {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: color, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
  if (name === "bars") return (
    <svg {...common}><path d="M6 20V10M12 20V4M18 20v-6" /></svg>
  );
  if (name === "gear") return (
    <svg {...common}><circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>
  );
  if (name === "flag") return (
    <svg {...common}><path d="M4 21V4h11l-1.5 4H20v8h-8l-1-3H4" /></svg>
  );
  if (name === "trend") return (
    <svg {...common}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
  );
  if (name === "star") return (
    <svg {...common}><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></svg>
  );
  if (name === "chevron") return (
    <svg {...common}><path d="M9 6l6 6-6 6" /></svg>
  );
  if (name === "home") return (
    <svg {...common}><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" /></svg>
  );
  if (name === "candles") return (
    <svg {...common}><path d="M7 4v16M12 2v20M17 6v12" />
      <rect x="4.5" y="8" width="5" height="8" /><rect x="9.5" y="6" width="5" height="12" />
      <rect x="14.5" y="10" width="5" height="5" /></svg>
  );
  if (name === "trophy") return (
    <svg {...common}><path d="M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" />
      <path d="M10 14h4l.5 4h-5z" /><path d="M8 20h8" /></svg>
  );
  if (name === "clock") return (
    <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5.5l3.5 2" /></svg>
  );
  if (name === "card") return (
    <svg {...common}><rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      <path d="M2.5 10h19M6 15h4" /></svg>
  );
  if (name === "coin") return (
    <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M8 9h8M12 9v7" /></svg>
  );
  if (name === "dots") return (
    <svg {...common}><circle cx="6" cy="12" r="1.2" fill={color} /><circle cx="12" cy="12" r="1.2" fill={color} />
      <circle cx="18" cy="12" r="1.2" fill={color} /></svg>
  );
  if (name === "check") return (
    <svg {...common}><path d="M5 12l5 5 9-10" /></svg>
  );
  if (name === "caret") return (
    <svg {...common}><path d="M6 9l6 6 6-6" /></svg>
  );
  return null;
};

/** Кнопка-иконка в шапке. */
const IconButton = ({ name, onClick, active }) => (
  <button onClick={onClick}
    className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 tap"
    style={{ backgroundColor: active ? TEXT : RAISED, border: `1px solid ${active ? TEXT : HAIR}` }}>
    <Icon name={name} size={18} color={active ? BG : TEXT} />
  </button>
);

const LOBBY_RANGES = [
  { key: "СЕГОДНЯ", ms: 24 * 3600e3 },
  { key: "НЕДЕЛЯ", ms: 7 * 24 * 3600e3 },
  { key: "ВСЁ ВРЕМЯ", ms: Infinity },
];

/**
 * Кривая накопленного результата. Строится из истории сессий: точка ставится
 * после каждой закрытой сессии, значение — сумма PnL к этому моменту.
 * Это НЕ котировка и не симуляция — только фактические результаты игрока.
 */
function EquityCurve({ sessions, rangeMs }) {
  const W = 320, H = 118, PADR = 46, PADB = 18;
  const now = Date.now();
  const list = [...sessions]
    .filter((x) => Number.isFinite(x.at) && now - x.at <= rangeMs)
    .sort((a, b) => a.at - b.at);

  if (list.length === 0) {
    return (
      <div className="flex items-center justify-center text-[12px] tx-fade"
        style={{ height: 64, color: FAINT }}>
        закрытых сессий за этот период нет
      </div>
    );
  }

  let acc = 0;
  const pts = list.map((x) => { acc += x.pnl; return { t: x.at, v: acc }; });
  pts.unshift({ t: pts[0].t - 1, v: 0 });

  const vs = pts.map((p) => p.v);
  const rawMax = Math.max(...vs, 0), rawMin = Math.min(...vs, 0);
  const pad = Math.max((rawMax - rawMin) * 0.25, 1);
  const max = rawMax + pad, min = rawMin - pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const spanT = Math.max(1, t1 - t0);

  const x = (t) => ((t - t0) / spanT) * (W - PADR);
  const y = (v) => H - PADB - ((v - min) / (max - min)) * (H - PADB - 6);
  const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const color = acc >= 0 ? LONG : SHORT;
  const grid = [max, (max + min) / 2 + (max - min) * 0.25, 0, min + (max - min) * 0.25, min];
  const hhmm = (t) => new Date(t).toLocaleTimeString("ru-RU",
    { hour: "2-digit", minute: "2-digit" });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 118 }}>
      {grid.map((g, i) => (
        <g key={i}>
          <line x1={0} x2={W - PADR} y1={y(g)} y2={y(g)}
            stroke={Math.abs(g) < 1e-9 ? DIM : HAIR} strokeWidth={0.8}
            strokeDasharray={Math.abs(g) < 1e-9 ? "" : "2 3"} />
          <text x={W - PADR + 6} y={y(g) + 3.5} fill={FAINT} fontSize={9}
            fontFamily="monospace">{fmtSigned(g, 0)}</text>
        </g>
      ))}

      <polygon points={`${line} ${x(t1)},${H - PADB} ${x(t0)},${H - PADB}`}
        fill={color} opacity={0.12} className="tx-fade" />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.8}
        className="tx-line" style={{ "--len": W * 1.6 }} />
      <circle cx={x(t1)} cy={y(acc)} r={3.2} fill={color} className="tx-pop" />

      <text x={0} y={H - 5} fill={FAINT} fontSize={9} fontFamily="monospace">{hhmm(t0)}</text>
      <text x={x(t1)} y={H - 5} fill={FAINT} fontSize={9} fontFamily="monospace"
        textAnchor="end">{hhmm(t1)}</text>
    </svg>
  );
}


/* ------------------------------ СТАТИСТИКА -------------------------------
   Разбор всех закрытых сессий. Данные берутся только из profile.sessions,
   ничего не пересчитывается по рынку.
   ------------------------------------------------------------------------ */
function StatsSheet({ profile, onClose }) {
  const list = profile.sessions;
  const n = list.length;

  const sum = (f) => list.reduce((a, x) => a + f(x), 0);
  const wins = list.filter((x) => x.pnl > 0).length;
  const total = sum((x) => x.pnl);
  const invested = sum((x) => x.capital);
  const roi = invested ? total / invested : 0;
  const avg = n ? total / n : 0;
  const avgRank = n ? sum((x) => x.rank) / n : 0;
  const bestRank = n ? Math.min(...list.map((x) => x.rank)) : 0;
  const trades = sum((x) => x.trades);
  const avgTime = n ? sum((x) => x.ticks) * CONFIG.market.tickMs / n : 0;

  // Распределение мест по пятёркам процентилей: 1-20, 21-40, ...
  const buckets = [0, 0, 0, 0, 0];
  const T = CONFIG.market.totalPlayers;
  list.forEach((x) => {
    const b = Math.min(4, Math.floor(((x.rank - 1) / T) * 5));
    buckets[b]++;
  });
  const maxB = Math.max(1, ...buckets);

  const card = { backgroundColor: SURFACE, border: `1px solid ${HAIR}` };
  const Cell = ({ label, value, color = TEXT }) => (
    <div className="min-w-0">
      <div className="text-[9px] tracking-[0.15em] mb-1.5 truncate" style={{ color: FAINT }}>
        {label}
      </div>
      <div className="text-[17px] font-mono truncate" style={{ color }}>{value}</div>
    </div>
  );

  return (
    <div className="w-full flex flex-col tx-sheet"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pt-5 pb-4">

        <div className="flex items-center justify-between">
          <div className="text-[10px] tracking-[0.3em]" style={{ color: FAINT }}>СТАТИСТИКА</div>
          <button onClick={onClose} className="text-[11px] tracking-[0.2em] py-2 tap"
            style={{ color: DIM }}>ЗАКРЫТЬ</button>
        </div>

        {n === 0 ? (
          <div className="rounded-2xl py-12 text-center text-[12px] mt-6"
            style={{ ...card, color: FAINT }}>
            пока нечего разбирать — сыграйте первую сессию
          </div>
        ) : (
          <>
            <div className="mt-5 tx-in" style={stagger(0)}>
              <div className="text-[40px] leading-none font-mono tracking-tight"
                style={{ color: total > 0 ? LONG : total < 0 ? SHORT : TEXT }}>
                {fmtSigned(total)}
              </div>
              <div className="text-[12px] mt-2" style={{ color: DIM }}>
                за {n} {n === 1 ? "сессию" : "сессий"} · доходность {signedPct(roi)}
              </div>
            </div>

            <div className="rounded-2xl px-4 py-4 mt-5 grid grid-cols-3 gap-y-5 gap-x-3 tx-in"
              style={{ ...card, ...stagger(1) }}>
              <Cell label="СЕССИЙ" value={String(n)} />
              <Cell label="ПРИБЫЛЬНЫХ" value={String(wins)} color={wins ? LONG : TEXT} />
              <Cell label="ВИНРЕЙТ" value={`${Math.round((wins / n) * 100)}%`} />
              <Cell label="СРЕДНЯЯ" value={fmtSigned(avg)}
                color={avg > 0 ? LONG : avg < 0 ? SHORT : TEXT} />
              <Cell label="ЛУЧШАЯ" value={fmtSigned(Math.max(...list.map((x) => x.pnl)))}
                color={LONG} />
              <Cell label="ХУДШАЯ" value={fmtSigned(Math.min(...list.map((x) => x.pnl)))}
                color={SHORT} />
              <Cell label="СРЕД. МЕСТО" value={avgRank.toFixed(1)} />
              <Cell label="ЛУЧШЕЕ МЕСТО" value={String(bestRank)} />
              <Cell label="ВСЕГО СДЕЛОК" value={String(trades)} />
              <Cell label="СРЕД. ВРЕМЯ" value={clock(avgTime)} />
              <Cell label="ВЗНОСОВ" value={fmt(invested, 0)} />
              <Cell label="СДЕЛОК/СЕССИЯ" value={(trades / n).toFixed(1)} />
            </div>

            <div className="text-[10px] tracking-[0.3em] mt-7 mb-2.5" style={{ color: FAINT }}>
              РАСПРЕДЕЛЕНИЕ МЕСТ
            </div>
            <div className="rounded-2xl px-4 py-4 tx-in" style={{ ...card, ...stagger(2) }}>
              {buckets.map((b, i) => (
                <div key={i} className="flex items-center gap-3 py-1.5">
                  <span className="text-[10px] font-mono w-[52px] shrink-0" style={{ color: FAINT }}>
                    {i * (T / 5) + 1}–{(i + 1) * (T / 5)}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full overflow-hidden"
                    style={{ backgroundColor: HAIR }}>
                    <div style={{ width: `${(b / maxB) * 100}%`, height: "100%",
                      backgroundColor: i === 0 ? LONG : i === 4 ? SHORT : DIM,
                      transition: "width 500ms cubic-bezier(.22,.9,.3,1)" }} />
                  </div>
                  <span className="text-[11px] font-mono w-5 text-right" style={{ color: DIM }}>{b}</span>
                </div>
              ))}
            </div>

            <div className="text-[10px] tracking-[0.3em] mt-7 mb-2.5" style={{ color: FAINT }}>
              ВСЕ СЕССИИ
            </div>
            <div className="flex flex-col gap-2">
              {list.map((x, i) => (
                <div key={i}
                  className="rounded-2xl px-4 py-3 flex items-center justify-between gap-3 tx-in"
                  style={{ ...card, ...stagger(3 + Math.min(i, 8)) }}>
                  <div className="min-w-0">
                    <div className="text-[14px] font-mono truncate">
                      {fmt(x.capital, 0)} → {fmt(x.equity)}
                    </div>
                    <div className="text-[11px] mt-1 truncate" style={{ color: FAINT }}>
                      {clock(x.ticks * CONFIG.market.tickMs)} · {x.trades} сделок · место {x.rank} из {T}
                    </div>
                  </div>
                  <span className="text-[14px] font-mono shrink-0"
                    style={{ color: x.pnl >= 0 ? LONG : SHORT }}>{fmtSigned(x.pnl)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ModeArt({ kind }) {
  // Онлайн: вращающийся каркасный купол. Офлайн: точечная волна.
  // Обе картинки — чистый SVG с CSS-анимацией, без внешних файлов.
  if (kind === "online") {
    const rings = [0.30, 0.48, 0.66, 0.84, 1.0];
    return (
      <svg viewBox="0 0 160 96" className="w-full" style={{ height: 96 }}>
        <g className="tx-dome">
          {rings.map((k, i) => (
            <ellipse key={i} cx="80" cy="70" rx={64 * k} ry={22 * k}
              fill="none" stroke={LONG} strokeWidth="0.7"
              opacity={0.16 + i * 0.11} />
          ))}
          {Array.from({ length: 14 }, (_, i) => {
            const a = (i / 14) * Math.PI * 2;
            return (
              <line key={i} x1="80" y1="70"
                x2={80 + Math.cos(a) * 64} y2={70 + Math.sin(a) * 22}
                stroke={LONG} strokeWidth="0.5" opacity="0.22" />
            );
          })}
          {Array.from({ length: 22 }, (_, i) => {
            const a = (i / 22) * Math.PI * 2;
            const k = rings[i % rings.length];
            return (
              <circle key={i} cx={80 + Math.cos(a) * 64 * k} cy={70 + Math.sin(a) * 22 * k}
                r="1.3" fill={LONG} opacity={0.35 + (i % 5) * 0.12}
                className="tx-twinkle" style={{ animationDelay: `${(i % 7) * 260}ms` }} />
            );
          })}
        </g>
        <circle cx="80" cy="70" r="2.4" fill={LONG} className="tx-dot" />
      </svg>
    );
  }
  const rows = 7, cols = 22;
  return (
    <svg viewBox="0 0 160 96" className="w-full" style={{ height: 96 }}>
      {Array.from({ length: rows }, (_, r) => (
        <g key={r} className="tx-wave" style={{ animationDelay: `${r * 190}ms` }}>
          {Array.from({ length: cols }, (_, c) => {
            const depth = r / (rows - 1);
            const x = 12 + (c / (cols - 1)) * 136;
            const y = 40 + depth * 46 + Math.sin((c / cols) * Math.PI * 2 + r * 0.7) * 6 * (1 - depth * 0.4);
            return <circle key={c} cx={x} cy={y} r={0.7 + depth * 1.1}
              fill={TEXT} opacity={0.12 + depth * 0.45} />;
          })}
        </g>
      ))}
    </svg>
  );
}

/** Карточка выбора режима. */
function ModeCard({ kind, title, text, cta, primary, onClick, disabled }) {
  return (
    <div className="rounded-2xl p-3.5 flex flex-col flex-1 min-w-0"
      style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
      <div className="text-[11px] tracking-[0.18em] font-semibold">{title}</div>
      <div className="my-2 overflow-hidden rounded-xl"
        style={{ backgroundColor: "#08080A" }}>
        <ModeArt kind={kind} />
      </div>
      <div className="text-[11px] leading-snug mb-3 min-h-[30px]" style={{ color: DIM }}>{text}</div>
      <button onClick={onClick} disabled={disabled}
        className="w-full rounded-xl py-3 text-[11px] tracking-[0.15em] font-bold tap disabled:opacity-45"
        style={primary
          ? { backgroundColor: TEXT, color: BG }
          : { backgroundColor: RAISED, color: TEXT, border: "1px solid #3A3A40" }}>
        {cta}
      </button>
    </div>
  );
}

/* ------------------------------ ПОПОЛНЕНИЕ -------------------------------
   Интерфейс готов, платёжный провайдер не подключён. Кнопка «ПОПОЛНИТЬ»
   намеренно ничего не списывает и не зачисляет — она сообщает, что оплаты
   пока нет. Отдельная демо-кнопка начисляет практические доллары, чтобы
   можно было продолжать играть.
   ------------------------------------------------------------------------ */
const PAY_METHODS = [
  { id: "card", label: "Банковская карта", sub: "•••• 4242", icon: "card", tint: TEXT },
  { id: "trc", label: "USDT (TRC20)", icon: "coin", tint: LONG },
  { id: "erc", label: "USDT (ERC20)", icon: "coin", tint: LONG },
  { id: "btc", label: "BTC", icon: "coin", tint: "#F7931A" },
  { id: "other", label: "Другой способ", icon: "dots", tint: DIM },
];

function DepositScreen({ profile, onBack, onDemoTopUp }) {
  const [amount, setAmount] = useState("100");
  const [method, setMethod] = useState("card");
  const [note, setNote] = useState(null);
  const value = Number(amount.replace(/[^\d.]/g, "")) || 0;
  const ok = value >= 10;

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pt-5 pb-4">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="text-[20px] leading-none py-1 tap">←</button>
          <div className="text-[11px] tracking-[0.25em]" style={{ color: DIM }}>
            ПОПОЛНЕНИЕ БАЛАНСА
          </div>
        </div>

        <div className="text-[10px] tracking-[0.25em] mt-6" style={{ color: FAINT }}>
          ТЕКУЩИЙ БАЛАНС
        </div>
        <div className="text-[30px] font-mono leading-none mt-2 tx-pop">{fmt(profile.wallet, 0)}</div>

        <div className="text-[10px] tracking-[0.25em] mt-6 mb-2" style={{ color: FAINT }}>
          СУММА ПОПОЛНЕНИЯ
        </div>
        <div className="flex items-center rounded-xl px-4"
          style={{ backgroundColor: RAISED, border: `1px solid ${HAIR}` }}>
          <span className="text-[16px] font-mono" style={{ color: DIM }}>$</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="flex-1 min-w-0 bg-transparent outline-none py-4 pl-1 text-[16px] font-mono"
            style={{ color: TEXT }} />
        </div>

        <div className="grid grid-cols-4 gap-2 mt-2">
          {[50, 100, 250, 500].map((v) => (
            <button key={v} onClick={() => setAmount(String(v))}
              className="rounded-xl py-3 text-[12px] font-mono font-semibold tap"
              style={{ backgroundColor: String(v) === amount ? TEXT : RAISED,
                color: String(v) === amount ? BG : TEXT,
                border: `1px solid ${String(v) === amount ? TEXT : HAIR}` }}>
              ${v}
            </button>
          ))}
        </div>

        <div className="text-[10px] tracking-[0.25em] mt-7 mb-2" style={{ color: FAINT }}>
          СПОСОБ ОПЛАТЫ
        </div>
        <div className="rounded-2xl overflow-hidden"
          style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
          {PAY_METHODS.map((m, i) => (
            <button key={m.id} onClick={() => setMethod(m.id)}
              className={`w-full flex items-center gap-3 px-4 py-3.5 text-left tap ${i ? "border-t" : ""}`}
              style={{ borderColor: HAIR,
                backgroundColor: method === m.id ? RAISED : "transparent" }}>
              <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                style={{ backgroundColor: "#0E0E11" }}>
                <Icon name={m.icon} size={16} color={m.tint} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] truncate">{m.label}</span>
                {m.sub && (
                  <span className="block text-[11px] font-mono" style={{ color: FAINT }}>{m.sub}</span>
                )}
              </span>
              <span className="w-[18px] h-[18px] rounded-full shrink-0 flex items-center justify-center"
                style={{ border: `1.5px solid ${method === m.id ? LONG : DIM}` }}>
                {method === m.id && (
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: LONG }} />
                )}
              </span>
            </button>
          ))}
        </div>

        {note && (
          <div className="text-[12px] text-center mt-5 leading-snug tx-pop" style={{ color: DIM }}>
            {note}
          </div>
        )}
      </div>

      <div className="max-w-md w-full mx-auto px-5 pb-5 pt-2 shrink-0">
        <button disabled={!ok}
          onClick={() => setNote("Приём оплат ещё не подключён. Пока баланс можно пополнить только в демо-режиме.")}
          className="w-full rounded-2xl py-4 text-[13px] tracking-[0.25em] font-bold tap disabled:opacity-40"
          style={{ backgroundColor: TEXT, color: BG }}>
          ПОПОЛНИТЬ
        </button>
        <button disabled={!ok} onClick={() => { onDemoTopUp(value); onBack(); }}
          className="w-full py-3 mt-2 text-[11px] tracking-[0.2em] tap disabled:opacity-40"
          style={{ color: DIM }}>
          НАЧИСЛИТЬ {fmt(value, 0)} В ДЕМО-РЕЖИМЕ
        </button>
        <div className="text-[11px] text-center mt-1" style={{ color: FAINT }}>
          Минимальная сумма — $10
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- РЕЙТИНГ --------------------------------
   Таблица собирается детерминированно из зерна периода, а результат игрока
   берётся из его реальной истории. Это витрина под будущий серверный
   лидерборд: когда появится Firestore, меняется только источник rows.
   ------------------------------------------------------------------------ */
const RANK_NAMES = ["MarketKing", "TraderOne", "AlphaWolf", "SigmaTrader", "FastHands",
  "ByteBro", "ChartMaster", "GreenPips", "DarkPool", "NightDesk", "ColdEntry",
  "TickHunter", "QuietSize", "RiskOff", "LateFill", "BlueTape", "SharpBid"];

function RankingTab({ profile, period, onPeriod }) {
  const st = profileStats(profile);
  const seed = { "ДЕНЬ": 11, "НЕДЕЛЯ": 27, "МЕСЯЦ": 53, "ВСЁ ВРЕМЯ": 91 }[period] || 11;
  const rnd = mulberry32(seed);
  const scale = { "ДЕНЬ": 1, "НЕДЕЛЯ": 3.4, "МЕСЯЦ": 9, "ВСЁ ВРЕМЯ": 21 }[period] || 1;

  const bots = RANK_NAMES.map((name) => ({
    name, pnl: Math.round((400 + rnd() * 12000) * scale) / 100,
  }));
  const rows = [...bots, { name: "вы", pnl: st.total, me: true }]
    .sort((a, b) => b.pnl - a.pnl)
    .map((r, i) => ({ ...r, place: i + 1 }));

  const podium = [rows[1], rows[0], rows[2]];

  return (
    <div className="px-5 pt-5">
      <div className="text-[11px] tracking-[0.25em] text-center" style={{ color: DIM }}>
        РЕЙТИНГ ИГРОКОВ
      </div>

      <div className="flex gap-1 p-1 rounded-2xl mt-5"
        style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
        {["ДЕНЬ", "НЕДЕЛЯ", "МЕСЯЦ", "ВСЁ ВРЕМЯ"].map((p) => (
          <button key={p} onClick={() => onPeriod(p)}
            className="flex-1 rounded-xl py-2.5 text-[10px] tracking-[0.12em] font-semibold tap"
            style={{ backgroundColor: p === period ? RAISED : "transparent",
              color: p === period ? TEXT : FAINT,
              border: `1px solid ${p === period ? "#3A3A40" : "transparent"}` }}>
            {p}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-2 mt-5">
        {podium.map((r, i) => {
          const first = i === 1;
          return (
            <div key={r.name}
              className="flex-1 min-w-0 rounded-2xl px-2 py-3 text-center tx-in"
              style={{ backgroundColor: first ? RAISED : SURFACE,
                border: `1px solid ${first ? "#3A3A40" : HAIR}`,
                marginBottom: first ? 0 : 8, ...stagger(i) }}>
              {first && <div className="text-[13px] leading-none mb-1">♛</div>}
              <div className="text-[15px] font-mono">{r.place}</div>
              <div className="w-7 h-7 rounded-full mx-auto my-2"
                style={{ backgroundColor: first ? TEXT : "#26262B" }} />
              <div className="text-[11px] truncate" style={{ color: r.me ? LONG : TEXT }}>
                {r.name}
              </div>
              <div className="text-[11px] font-mono mt-0.5"
                style={{ color: r.pnl >= 0 ? LONG : SHORT }}>{fmtSigned(r.pnl, 0)}</div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center px-4 mt-6 mb-1 text-[9px] tracking-[0.15em]"
        style={{ color: FAINT }}>
        <span className="w-7">#</span>
        <span className="flex-1">ИГРОК</span>
        <span>РЕЗУЛЬТАТ</span>
      </div>
      <div className="rounded-2xl overflow-hidden"
        style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
        {rows.slice(3).map((r, i) => (
          <div key={r.name}
            className={`flex items-center px-4 py-3 ${i ? "border-t" : ""}`}
            style={{ borderColor: HAIR, backgroundColor: r.me ? RAISED : "transparent" }}>
            <span className="w-7 text-[12px] font-mono" style={{ color: FAINT }}>{r.place}</span>
            <span className="flex-1 min-w-0 text-[13px] truncate"
              style={{ color: r.me ? LONG : TEXT }}>{r.name}</span>
            <span className="text-[13px] font-mono"
              style={{ color: r.pnl >= 0 ? LONG : SHORT }}>{fmtSigned(r.pnl, 0)}</span>
          </div>
        ))}
      </div>

      <div className="text-[11px] text-center mt-4 leading-snug" style={{ color: FAINT }}>
        Соперники показаны для примера: общий рейтинг появится вместе с онлайн-режимом.
        Ваша строка считается по реальной истории сессий.
      </div>
    </div>
  );
}

/* --------------------------------- РЫНКИ --------------------------------- */
function MarketsTab({ onPlay }) {
  const m = CONFIG.market;
  const row = (label, value) => (
    <div className="flex justify-between py-2 text-[12px]" style={{ borderColor: HAIR }}>
      <span style={{ color: DIM }}>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
  return (
    <div className="px-5 pt-5">
      <div className="text-[11px] tracking-[0.25em] text-center" style={{ color: DIM }}>
        ДОСТУПНЫЕ РЫНКИ
      </div>

      <div className="rounded-2xl p-4 mt-5 tx-in"
        style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}`, ...stagger(0) }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[17px] font-mono">{m.assetSymbol}</div>
            <div className="text-[11px] mt-1" style={{ color: DIM }}>закрытый рынок · практика</div>
          </div>
          <span className="px-2.5 py-1 rounded-full text-[10px] tracking-[0.15em]"
            style={{ backgroundColor: RAISED, color: LONG, border: `1px solid ${HAIR}` }}>
            ОТКРЫТ
          </span>
        </div>
        <div className="my-3 rounded-xl overflow-hidden" style={{ backgroundColor: "#08080A" }}>
          <ModeArt kind="offline" />
        </div>
        {row("Участников в комнате", m.totalPlayers)}
        {row("Стартовая цена", fmt(m.initialPrice))}
        {row("Взнос", m.capitalOptions.map((c) => fmt(c, 0)).join(" · "))}
        {row("Тик", `${m.tickMs} мс`)}
        <button onClick={onPlay}
          className="w-full rounded-xl py-3.5 mt-3 text-[12px] tracking-[0.2em] font-bold tap"
          style={{ backgroundColor: TEXT, color: BG }}>
          ИГРАТЬ
        </button>
      </div>

      {["BTC/USD", "ETH/USD", "Индекс страха"].map((name, i) => (
        <div key={name}
          className="rounded-2xl px-4 py-4 mt-2 flex items-center justify-between tx-in"
          style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}`, ...stagger(i + 1) }}>
          <div>
            <div className="text-[14px] font-mono" style={{ color: DIM }}>{name}</div>
            <div className="text-[11px] mt-1" style={{ color: FAINT }}>появится позже</div>
          </div>
          <span className="px-2.5 py-1 rounded-full text-[10px] tracking-[0.15em]"
            style={{ backgroundColor: "#0E0E11", color: FAINT }}>СКОРО</span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------- ИСТОРИЯ -------------------------------- */
function HistoryTab({ profile }) {
  const list = profile.sessions;
  const card = { backgroundColor: SURFACE, border: `1px solid ${HAIR}` };
  return (
    <div className="px-5 pt-5">
      <div className="text-[11px] tracking-[0.25em] text-center" style={{ color: DIM }}>
        ИСТОРИЯ СЕССИЙ
      </div>
      {list.length === 0 ? (
        <div className="rounded-2xl py-12 text-center text-[12px] mt-5"
          style={{ ...card, color: FAINT }}>
          здесь появятся результаты ваших сессий
        </div>
      ) : (
        <div className="flex flex-col gap-2 mt-5">
          {list.map((x, i) => (
            <div key={i}
              className="rounded-2xl px-4 py-3 flex items-center justify-between gap-3 tx-in"
              style={{ ...card, ...stagger(Math.min(i, 8)) }}>
              <div className="min-w-0">
                <div className="text-[14px] font-mono truncate">
                  {fmt(x.capital, 0)} → {fmt(x.equity)}
                </div>
                <div className="text-[11px] mt-1 truncate" style={{ color: FAINT }}>
                  {x.at ? new Date(x.at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + " · " : ""}
                  {clock(x.ticks * CONFIG.market.tickMs)} в рынке · {x.trades} сделок · место {x.rank} из {CONFIG.market.totalPlayers}
                </div>
              </div>
              <span className="text-[14px] font-mono shrink-0"
                style={{ color: x.pnl >= 0 ? LONG : SHORT }}>{fmtSigned(x.pnl)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- НИЖНЕЕ МЕНЮ ------------------------------ */
const TABS = [
  { key: "home", label: "ГЛАВНАЯ", icon: "home" },
  { key: "markets", label: "РЫНКИ", icon: "candles" },
  { key: "rank", label: "РЕЙТИНГ", icon: "trophy" },
  { key: "history", label: "ИСТОРИЯ", icon: "clock" },
];

function TabBar({ active, onChange }) {
  return (
    <div className="max-w-md w-full mx-auto grid grid-cols-4 shrink-0 pt-2 pb-5"
      style={{ borderTop: `1px solid ${HAIR}` }}>
      {TABS.map((t) => {
        const on = t.key === active;
        return (
          <button key={t.key} onClick={() => onChange(t.key)}
            className="flex flex-col items-center gap-1.5 py-1.5 tap">
            <Icon name={t.icon} size={19} color={on ? LONG : FAINT} />
            <span className="text-[9px] tracking-[0.12em]" style={{ color: on ? LONG : FAINT }}>
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------- ЛОББИ --------------------------------- */
function Lobby({ profile, account, onNew, onReset, onExit, onSignOut, onTopUp }) {
  const st = profileStats(profile);
  const [tab, setTab] = useState("home");
  const [stats, setStats] = useState(false);
  const [deposit, setDeposit] = useState(false);
  const [range, setRange] = useState(LOBBY_RANGES[0]);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [period, setPeriod] = useState("ДЕНЬ");
  const [notice, setNotice] = useState(null);

  const now = Date.now();
  const inRange = profile.sessions.filter(
    (x) => Number.isFinite(x.at) && now - x.at <= range.ms);
  const rangeTotal = inRange.reduce((sum, x) => sum + x.pnl, 0);
  const affordable = CONFIG.market.capitalOptions.some((c) => c <= profile.wallet);
  const card = { backgroundColor: SURFACE, border: `1px solid ${HAIR}` };

  if (stats) return <StatsSheet profile={profile} onClose={() => setStats(false)} />;
  if (deposit) {
    return <DepositScreen profile={profile} onBack={() => setDeposit(false)}
      onDemoTopUp={onTopUp} />;
  }

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        <div className="max-w-md w-full mx-auto pb-4">

          {tab === "home" && (
            <div className="px-5 pt-5">
              {/* --------------------------- шапка --------------------------- */}
              <div className="flex items-start justify-between gap-3 tx-in" style={stagger(0)}>
                <div className="min-w-0">
                  <Logo size={46} />
                  <div className="text-[19px] tracking-tight mt-1">trade.exe</div>
                </div>
                <div className="flex gap-2">
                  <IconButton name="bars" active={false} onClick={() => setStats(true)} />
                  <IconButton name="gear" active={menu} onClick={() => setMenu((v) => !v)} />
                </div>
              </div>

              {menu && (
                <div className="mt-4 rounded-2xl p-2 flex flex-col tx-pop" style={card}>
                  <button onClick={() => { onReset(); setMenu(false); }}
                    className="text-left px-3 py-3 rounded-xl text-[13px] tap" style={{ color: TEXT }}>
                    Сбросить баланс до {fmt(STARTING_WALLET, 0)}
                  </button>
                  {onExit && (
                    <button onClick={onExit} className="text-left px-3 py-3 rounded-xl text-[13px] tap"
                      style={{ color: DIM }}>Сменить режим</button>
                  )}
                  {onSignOut && (
                    <button onClick={onSignOut} className="text-left px-3 py-3 rounded-xl text-[13px] tap"
                      style={{ color: SHORT }}>
                      Выйти{account?.email ? ` · ${account.email}` : ""}
                    </button>
                  )}
                </div>
              )}

              {/* -------------------------- баланс --------------------------- */}
              <div className="text-[10px] tracking-[0.3em] mt-5" style={{ color: FAINT }}>БАЛАНС</div>
              <div className="flex items-end justify-between gap-3 mt-1.5">
                <div className="text-[36px] leading-none font-mono tracking-tight truncate tx-pop">
                  {fmt(profile.wallet, 0)}
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full shrink-0" style={card}>
                  <span className="w-1.5 h-1.5 rounded-full tx-dot" style={{ backgroundColor: LONG }} />
                  <span className="text-[10px] tracking-[0.2em]">ОНЛАЙН</span>
                </div>
              </div>
              <div className="text-[13px] font-mono mt-2"
                style={{ color: st.total > 0 ? LONG : st.total < 0 ? SHORT : DIM }}>
                {st.count === 0 ? "сессий ещё не было" : `${fmtSigned(st.total)} за ${st.count} сесс.`}
              </div>

              {/* --------------------------- режимы -------------------------- */}
              <div className="flex gap-2.5 mt-5 tx-in" style={stagger(1)}>
                <ModeCard kind="online" title="ОНЛАЙН РЫНОК"
                  text="Торгуй с реальными игроками в реальном времени"
                  cta="ИГРАТЬ ОНЛАЙН" primary
                  onClick={() => setNotice("Онлайн-комнаты появятся после подключения сервера. Пока доступна офлайн-практика.")} />
                <ModeCard kind="offline" title="ОФЛАЙН ПРАКТИКА"
                  text="Практикуй стратегии без риска для баланса"
                  cta="ИГРАТЬ ОФЛАЙН" onClick={onNew} disabled={!affordable} />
              </div>

              {notice && (
                <div className="text-[12px] mt-3 rounded-xl px-4 py-3 leading-snug tx-pop"
                  style={{ ...card, color: DIM }}>{notice}</div>
              )}

              {/* ------------------------- статистика ------------------------ */}
              <div className="rounded-2xl px-4 py-3.5 mt-5 tx-in" style={{ ...card, ...stagger(2) }}>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    ["СЕССИЙ", String(st.count), TEXT, "flag"],
                    ["ПРИБЫЛЬНЫХ", st.count ? String(st.wins) : "—", st.wins > 0 ? LONG : TEXT, "trend"],
                    ["ЛУЧШАЯ", st.count ? fmtSigned(st.best, 0) : "—", st.best > 0 ? LONG : TEXT, "star"],
                    ["ХУДШАЯ", st.count ? fmtSigned(st.worst, 0) : "—", st.worst < 0 ? SHORT : TEXT, "star"],
                  ].map(([label, value, color, icon]) => (
                    <div key={label} className="min-w-0">
                      <div className="text-[9px] tracking-[0.1em] mb-1.5 truncate" style={{ color: FAINT }}>
                        {label}
                      </div>
                      <div className="text-[16px] font-mono truncate" style={{ color }}>{value}</div>
                      <div className="mt-2"><Icon name={icon} size={13} color={FAINT} /></div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ---------------------- дневная динамика --------------------- */}
              <div className="text-[10px] tracking-[0.3em] mt-6 mb-2.5" style={{ color: FAINT }}>
                ДНЕВНАЯ ДИНАМИКА
              </div>
              <div className="rounded-2xl px-4 py-3.5 tx-in" style={{ ...card, ...stagger(3) }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[20px] font-mono leading-none"
                      style={{ color: rangeTotal > 0 ? LONG : rangeTotal < 0 ? SHORT : TEXT }}>
                      {inRange.length ? fmtSigned(rangeTotal) : "—"}
                    </div>
                    <div className="text-[12px] mt-1.5" style={{ color: DIM }}>суммарный результат</div>
                  </div>
                  <div className="relative shrink-0">
                    <button onClick={() => setRangeOpen((v) => !v)}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] tracking-[0.15em] tap"
                      style={{ backgroundColor: RAISED, color: TEXT, border: `1px solid ${HAIR}` }}>
                      {range.key}<Icon name="caret" size={13} color={DIM} />
                    </button>
                    {rangeOpen && (
                      <div className="absolute right-0 mt-1 rounded-xl overflow-hidden z-10 tx-pop"
                        style={{ ...card, backgroundColor: RAISED }}>
                        {LOBBY_RANGES.map((r) => (
                          <button key={r.key} onClick={() => { setRange(r); setRangeOpen(false); }}
                            className="block w-full text-left px-4 py-2.5 text-[11px] tracking-[0.15em] whitespace-nowrap tap"
                            style={{ color: r.key === range.key ? TEXT : DIM }}>
                            {r.key}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-3">
                  <EquityCurve sessions={profile.sessions} rangeMs={range.ms} />
                </div>
              </div>

              {/* ------------------------ последние сессии ------------------- */}
              <div className="flex items-center justify-between mt-6 mb-2.5">
                <span className="text-[10px] tracking-[0.3em]" style={{ color: FAINT }}>
                  ПОСЛЕДНИЕ СЕССИИ
                </span>
                {profile.sessions.length > 0 && (
                  <button onClick={() => setTab("history")}
                    className="text-[10px] tracking-[0.2em] tap" style={{ color: LONG }}>
                    СМОТРЕТЬ ВСЕ
                  </button>
                )}
              </div>
              {profile.sessions.length === 0 ? (
                <div className="rounded-2xl py-7 text-center text-[12px]" style={{ ...card, color: FAINT }}>
                  здесь появятся результаты ваших сессий
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {profile.sessions.slice(0, 2).map((x, i) => (
                    <div key={i}
                      className="rounded-2xl px-4 py-3 flex items-center justify-between gap-3 tx-in tap"
                      style={{ ...card, ...stagger(4 + i) }}>
                      <div className="min-w-0">
                        <div className="text-[14px] font-mono truncate">
                          {fmt(x.capital, 0)} → {fmt(x.equity)}
                        </div>
                        <div className="text-[11px] mt-1 truncate" style={{ color: FAINT }}>
                          {clock(x.ticks * CONFIG.market.tickMs)} в рынке · место {x.rank} из {CONFIG.market.totalPlayers}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[14px] font-mono"
                          style={{ color: x.pnl >= 0 ? LONG : SHORT }}>{fmtSigned(x.pnl)}</span>
                        <Icon name="chevron" size={14} color={FAINT} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <button onClick={() => setDeposit(true)}
                className="w-full rounded-2xl py-4 mt-5 text-[13px] tracking-[0.25em] font-bold tap"
                style={{ backgroundColor: TEXT, color: BG }}>
                ПОПОЛНИТЬ БАЛАНС
              </button>
            </div>
          )}

          {tab === "markets" && <MarketsTab onPlay={onNew} />}
          {tab === "rank" && <RankingTab profile={profile} period={period} onPeriod={setPeriod} />}
          {tab === "history" && <HistoryTab profile={profile} />}
        </div>
      </div>

      <TabBar active={tab} onChange={(k) => { setTab(k); setNotice(null); }} />
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
    <div className="w-full flex flex-col" style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
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

/* --------------------------- ПОИСК ИГРОКОВ -------------------------------
   Офлайн-сессия должна ощущаться как онлайн: перед входом в рынок игрок
   видит, как комната набирается. Это чистая косметика поверх LocalTransport —
   когда появится RemoteTransport, экран остаётся тот же, меняется только
   источник счётчика (сейчас таймер, потом события сервера).
   ------------------------------------------------------------------------ */
const ROOM_NAMES = [
  "Ivan", "Nord", "Kite", "Vera", "Osip", "Mira", "Zed", "Lika", "Orion",
  "Rune", "Sable", "Tessa", "Umka", "Vega", "Wolf", "Xena", "Yuri", "Zara",
];

function Matchmaking({ capital, onReady, onCancel }) {
  const [joined, setJoined] = useState(1);
  const [feed, setFeed] = useState(["вы вошли в комнату"]);
  const total = CONFIG.market.totalPlayers;

  useEffect(() => {
    let count = 1;
    let ready = null;               // отложенный старт, снимается при размонтировании
    const timer = setInterval(() => {
      // Набор ускоряется к концу — так очередь не кажется линейной полосой.
      count = Math.min(total, count + 3 + Math.floor(Math.random() * 9));
      setJoined(count);
      const who = ROOM_NAMES[Math.floor(Math.random() * ROOM_NAMES.length)];
      setFeed((prev) => [`${who}-${Math.floor(Math.random() * 900 + 100)} присоединился`,
        ...prev].slice(0, 5));
      if (count >= total) {
        clearInterval(timer);
        ready = setTimeout(onReady, 700);
      }
    }, 130);
    // Без снятия таймера отмена подбора в последние 700 мс всё равно
    // запускала сессию уже из лобби.
    return () => { clearInterval(timer); if (ready) clearTimeout(ready); };
  }, []);

  const pct = joined / total;

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6">
        <div className="text-[11px] tracking-[0.3em]" style={{ color: FAINT }}>ПОДБОР УЧАСТНИКОВ</div>
        <div className="text-[64px] leading-none font-mono tracking-tight mt-3">
          {joined}<span className="text-[24px]" style={{ color: FAINT }}> / {total}</span>
        </div>

        <div className="h-1 w-full rounded-full mt-6 overflow-hidden" style={{ backgroundColor: HAIR }}>
          <div style={{ width: `${pct * 100}%`, height: "100%", backgroundColor: TEXT,
            transition: "width 200ms cubic-bezier(.22,.9,.3,1)" }} />
        </div>

        <div className="mt-8">
          <Line left="Взнос каждого" right={fmt(capital, 0)} />
          <Line left="Капитал комнаты" right={fmt(capital * total, 0)} />
          <Line left="Актив" right={CONFIG.market.assetSymbol} />
        </div>

        <div className="mt-8 h-[110px]">
          {feed.map((line, i) => (
            <div key={`${line}-${i}`} className="text-[12px] font-mono py-1 tx-in"
              style={{ color: i === 0 ? DIM : FAINT, opacity: 1 - i * 0.18 }}>
              {line}
            </div>
          ))}
        </div>
      </div>

      <div className="max-w-md w-full mx-auto px-6 pb-8">
        <button onClick={onCancel} className="w-full rounded-lg py-4 text-[13px] tracking-[0.15em] font-semibold tap"
          style={{ backgroundColor: RAISED, color: TEXT, border: `1px solid #3A3A40` }}>
          ОТМЕНИТЬ ПОДБОР
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ ИТОГ СЕССИИ ------------------------------- */
function SessionResult({ result, onDone }) {
  const good = result.pnl >= 0;
  return (
    <div className="w-full flex flex-col" style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
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
  const [account, setAccount] = useState(undefined);   // undefined = ещё грузим, null = не вошёл
  const [authStage, setAuthStage] = useState("intro"); // intro | signin | signup
  const [screen, setScreen] = useState("lobby");
  const [result, setResult] = useState(null);
  const [session, setSession] = useState(null);
  const [pending, setPending] = useState(null);   // взнос, пока идёт подбор
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
  useEffect(() => { authStore.current().then((a) => setAccount(a ?? null)); }, []);
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

  /** Первая фаза: подбор участников. Реальная комната ещё не создана. */
  const queueSession = (capital) => { setPending(capital); setScreen("matching"); };

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
    setPending(null);
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
      at: Date.now(),        // отметка времени для кривой "дневная динамика"
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

  if (!profile || account === undefined) return <Splash />;

  // Не вошёл — показываем онбординг, затем экран входа/регистрации.
  if (!account) {
    if (authStage === "intro") {
      return <Onboarding onSignIn={() => setAuthStage("signin")}
        onSignUp={() => setAuthStage("signup")} />;
    }
    return <AuthScreen mode={authStage}
      onMode={setAuthStage}
      onBack={() => setAuthStage("intro")}
      onDone={(acc) => { setAccount(acc); setAuthStage("intro"); }} />;
  }
  const topUp = (value) => persist({
    ...profile,
    wallet: profile.wallet + value,
    deposited: profile.deposited + value,
  });

  const signOut = async () => { await authStore.signOut(); setAccount(null); setAuthStage("intro"); };

  if (screen === "lobby") {
    return <Lobby profile={profile} account={account} onSignOut={signOut} onTopUp={topUp}
      onNew={() => setScreen("setup")} onExit={onExit}
      onReset={() => persist({ ...profile, wallet: STARTING_WALLET, deposited: profile.deposited + STARTING_WALLET })} />;
  }
  if (screen === "setup") {
    return <SessionSetup wallet={profile.wallet} onStart={queueSession} onBack={() => setScreen("lobby")} />;
  }
  if (screen === "matching" && pending !== null) {
    return <Matchmaking capital={pending} onReady={() => startSession(pending)}
      onCancel={() => { setPending(null); setScreen("lobby"); }} />;
  }
  if (screen === "result" && result) {
    return <SessionResult result={result} onDone={() => { setResult(null); setScreen("lobby"); }} />;
  }
  if (!engineRef.current || !snapshot) {
    return <Lobby profile={profile} account={account} onSignOut={signOut} onTopUp={topUp}
      onNew={() => setScreen("setup")} onExit={onExit}
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
    <div className="w-full flex flex-col" style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
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
                <button onClick={() => setConfirmingEnd(false)} className="flex-1 rounded-lg py-3 text-[13px] font-semibold tap"
                  style={{ backgroundColor: RAISED, color: TEXT, border: `1px solid #3A3A40` }}>
                  Отмена
                </button>
                <button onClick={finishSession} className="flex-1 rounded-lg py-3 text-[13px] font-semibold tap"
                  style={{ backgroundColor: SHORT, color: BG }}>
                  Да, завершить
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmingEnd(true)} className="rounded-lg py-3 text-[13px] font-semibold tap"
                style={{ backgroundColor: RAISED, color: TEXT, border: `1px solid #3A3A40` }}>
                Завершить сессию · {fmt(equity)} на баланс
              </button>
            )}
          </div>
        )}

        {/* -------------------------------- контент -------------------------- */}
        {/* min-h-0 обязателен: без него flex-элемент не даёт себя сжать и
            вся страница уезжает в скролл (проблема 1). */}
        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">

          {tab === "Рынок" && (
            <div className="flex flex-col h-full">
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

              <div className="px-2 pt-1 flex-1 min-h-0">
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
            </div>
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
                        className="rounded-lg py-3 text-[13px] font-semibold tap"
                        style={{ backgroundColor: RAISED, color: TEXT, border: `1px solid #3A3A40` }}>{l}</button>
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
                                className="flex-1 py-2.5 rounded text-[12px] font-mono font-semibold disabled:opacity-25"
                                style={{ backgroundColor: RAISED, color: TEXT, border: `1px solid #3A3A40` }}>
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
                  className="px-2.5 py-2.5 rounded font-mono text-[11px] font-semibold tap"
                  style={{ backgroundColor: RAISED, color: TEXT, border: `1px solid ${HAIR}` }}>
                  {f * 100}%
                </button>
              ))}
              <button onClick={() => setSheet(sheet === "risk" ? null : "risk")}
                className="px-2.5 py-2.5 rounded text-[11px] font-semibold tap"
                style={{ backgroundColor: sheet === "risk" ? TEXT : RAISED,
                  color: sheet === "risk" ? BG : TEXT, border: `1px solid ${HAIR}` }}>
                SL/TP
              </button>
              <button onClick={() => setSheet(sheet === "limit" ? null : "limit")}
                className="px-2.5 py-2.5 rounded text-[11px] font-semibold tap"
                style={{ backgroundColor: sheet === "limit" ? TEXT : RAISED,
                  color: sheet === "limit" ? BG : TEXT, border: `1px solid ${HAIR}` }}>
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
                style={{ backgroundColor: RAISED, color: TEXT, border: `1px solid #3A3A40` }}>
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
            <button key={key} onClick={() => setTab(key)}
              className="py-3 text-[11px] font-semibold tap"
              style={{ color: tab === key ? BG : DIM,
                backgroundColor: tab === key ? TEXT : "transparent" }}>
              {key}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ==== ТОЧКА ВХОДА ====
// ВРЕМЕННО: ловушка ошибок отрисовки. Показывает текст ошибки на экране
// с переносом строк, чтобы ничего не обрезалось. Убрать после починки.
class ErrBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null, info: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { this.setState({ err, info }); }
  render() {
    if (!this.state.err) return this.props.children;
    const e = this.state.err;
    const text =
      "СООБЩЕНИЕ:\n" + (e && e.message ? e.message : String(e)) +
      "\n\nСТЕК:\n" + (e && e.stack ? e.stack : "(нет)") +
      "\n\nКОМПОНЕНТЫ:\n" + (this.state.info && this.state.info.componentStack
        ? this.state.info.componentStack : "(нет)");
    return React.createElement("pre", {
      style: {
        margin: 0, padding: "16px", background: "#111", color: "#fff",
        fontSize: "11px", lineHeight: 1.45,
        whiteSpace: "pre-wrap", wordBreak: "break-all", overflowWrap: "anywhere",
        minHeight: "100vh", WebkitUserSelect: "text", userSelect: "text",
      },
    }, text);
  }
}

createRoot(document.getElementById("root")).render(
  <ErrBoundary><PracticeApp /></ErrBoundary>
);

// ==== ДВИЖОК MODEL-V4 (инлайн, без require/module.exports) ====

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

// ==================== ИНТЕРФЕЙС (React, без шага сборки) ====================
import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";

const TICK_MS = 250;
const START_CAPITAL = 100;
const PLAYER_COUNT = 100;

function fmt(n, d = 2) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(d);
}
function pct(n, d = 2) {
  const s = n >= 0 ? "+" : "";
  return s + (n * 100).toFixed(d) + "%";
}

/* ---- мини-график цены: обычный SVG, без сторонних библиотек ---- */
function PriceChart({ history, pmin, pmax }) {
  const w = 600, h = 160, pad = 6;
  if (history.length < 2) return jsx("div", { style: { height: h } });
  const n = history.length;
  const y = (p) => pad + (h - 2 * pad) * (1 - (p - pmin) / (pmax - pmin));
  const x = (i) => (w * i) / (n - 1);
  const d = history.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const last = history[n - 1], prev = history[0];
  const color = last >= prev ? "#22c55e" : "#ef4444";
  return jsxs("svg", { width: "100%", height: h, viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none",
    style: { display: "block" }, children: [
      jsx("path", { d, fill: "none", stroke: color, strokeWidth: 2 }),
      jsx("line", { x1: 0, x2: w, y1: y(START_CAPITAL), y2: y(START_CAPITAL),
        stroke: "#3a3a3f", strokeDasharray: "3,3" }),
    ] });
}

function StatBlock({ label, value, sub, accent }) {
  return jsxs("div", { children: [
    jsx("div", { className: "text-[11px] uppercase tracking-wide text-[#7A7A80]", children: label }),
    jsx("div", { className: "text-[22px] tabular-nums", style: accent ? { color: accent } : undefined, children: value }),
    sub ? jsx("div", { className: "text-[11px] text-[#46464C] mt-0.5", children: sub }) : null,
  ] });
}

function App() {
  const roomRef = useRef(null);
  const humanIdRef = useRef(null);
  const [tick, setTick] = useState(0);
  const [snap, setSnap] = useState(null);
  const [history, setHistory] = useState([]);
  const [amount, setAmount] = useState(50);
  const [paused, setPaused] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    const room = new Room({ playerCount: PLAYER_COUNT, startingCapital: START_CAPITAL,
      seed: Date.now() % 100000, npcCount: PLAYER_COUNT - 1 });
    const id = room.join("Вы");
    room.advance(40); // разогрев, чтобы рынок не был мёртвым в первую секунду
    roomRef.current = room; humanIdRef.current = id;
    setHistory(room.history.slice());
    setSnap(room.snapshot(id, { level: "full", devMode: true }));
  }, []);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      const room = roomRef.current; if (!room || room.halted) return;
      room.step();
      setHistory(room.history.slice(-300));
      setSnap(room.snapshot(humanIdRef.current, { level: "full", devMode: true }));
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [paused]);

  const doFlash = useCallback((msg, ok) => {
    setFlash({ msg, ok }); setTimeout(() => setFlash(null), 1800);
  }, []);

  const trade = useCallback((action) => {
    const room = roomRef.current, id = humanIdRef.current; if (!room) return;
    let cmd;
    if (action === "CLOSE") cmd = { type: "TRADE", action: "CLOSE" };
    else cmd = { type: "TRADE", action, notional: (snap.you.cash * amount) / 100 };
    const r = room.send(id, cmd);
    doFlash(r.ok ? "исполнено" : r.reason, r.ok);
    room.step();
    setSnap(room.snapshot(id, { level: "full", devMode: true }));
    setHistory(room.history.slice(-300));
  }, [amount, snap, doFlash]);

  if (!snap) return jsx("div", { className: "min-h-screen bg-black text-white flex items-center justify-center",
    children: "Загрузка рынка…" });

  const { you, mark, priceRange, Q, escrow, totalCapital } = snap;
  const [pmin, pmax] = priceRange;
  const changeFromStart = mark / START_CAPITAL - 1;
  const hasPos = !!you.position;

  return jsxs("div", { className: "min-h-screen bg-black text-white pb-40", children: [

    jsxs("div", { className: "px-4 pt-5 pb-3 border-b border-[#1E1E21]", children: [
      jsxs("div", { className: "flex items-baseline justify-between", children: [
        jsx("div", { className: "text-[36px] font-light tabular-nums", children: "$" + fmt(mark) }),
        jsx("div", { className: "text-[13px] tabular-nums", style: { color: changeFromStart >= 0 ? "#22c55e" : "#ef4444" },
          children: pct(changeFromStart) }),
      ] }),
      jsx("div", { className: "text-[11px] text-[#7A7A80] mt-1",
        children: `диапазон $${fmt(pmin,0)}–$${fmt(pmax,0)} · Q=${fmt(Q,2)} · тик ${snap.tick}` }),
    ] }),

    jsx("div", { className: "px-4 pt-4", children: jsx(PriceChart, { history, pmin, pmax }) }),

    jsxs("div", { className: "px-4 py-4 grid grid-cols-2 gap-4 border-b border-[#1E1E21]", children: [
      jsx(StatBlock, { label: "Эквити", value: "$" + fmt(you.equity) }),
      jsx(StatBlock, { label: "Свободно", value: "$" + fmt(you.cash) }),
      jsx(StatBlock, { label: "Close Value", value: hasPos ? "$" + fmt(you.closeValue) : "—",
        sub: "получите, если закрыть СЕЙЧАС", accent: "#e5e5e5" }),
      jsx(StatBlock, { label: "PnL", value: hasPos ? (you.unrealized >= 0 ? "+" : "") + "$" + fmt(you.unrealized) : "$0.00",
        accent: hasPos ? (you.unrealized >= 0 ? "#22c55e" : "#ef4444") : undefined }),
    ] }),

    hasPos ? jsxs("div", { className: "mx-4 mt-2 mb-4 p-3 rounded-lg bg-[#0B0B0C] border border-[#1E1E21] text-[13px]", children: [
      jsxs("div", { className: "flex justify-between", children: [
        jsx("span", { className: "text-[#7A7A80]", children: "Позиция" }),
        jsx("span", { children: `${you.position.side === "long" ? "ЛОНГ" : "ШОРТ"} · ${fmt(you.position.units,4)} ед.` }),
      ] }),
      jsxs("div", { className: "flex justify-between mt-1", children: [
        jsx("span", { className: "text-[#7A7A80]", children: "Цена входа (клиринга)" }),
        jsx("span", { children: "$" + fmt(you.position.entryPrice) }),
      ] }),
      jsxs("div", { className: "flex justify-between mt-1 text-[11px] text-[#46464C]", children: [
        jsx("span", { children: "Цена рынка (справочно, НЕ ваша выплата)" }),
        jsx("span", { children: "$" + fmt(mark) }),
      ] }),
    ] }) : null,

    flash ? jsx("div", { className: "mx-4 mb-3 px-3 py-2 rounded text-[12px]",
      style: { background: flash.ok ? "#0f2417" : "#2a1414", color: flash.ok ? "#4ade80" : "#f87171" },
      children: flash.msg }) : null,

    jsxs("div", { className: "px-4", children: [
      jsxs("div", { className: "flex items-center gap-2 mb-3", children: [
        jsx("span", { className: "text-[13px] text-[#7A7A80]", children: "Объём" }),
        jsxs("div", { className: "flex gap-1 flex-1", children: [10,25,50,100].map((p) =>
          jsx("button", { onClick: () => setAmount(p),
            className: "flex-1 py-1.5 rounded text-[12px] " + (amount === p ? "bg-white text-black" : "bg-[#141416] text-[#9a9aa0]"),
            children: p + "%" }, p)) }),
      ] }),
      jsxs("div", { className: "grid grid-cols-3 gap-2", children: [
        jsxs("button", { onClick: () => trade("BUY"),
          className: "py-4 rounded-lg bg-[#16a34a] text-white text-[15px] font-medium",
          children: [jsx("div", null, "ЛОНГ"), jsx("div", { className: "text-[11px] opacity-80 mt-0.5",
            children: `$${fmt((you.cash*amount)/100,0)}` })] }),
        jsxs("button", { onClick: () => trade("SELL"),
          className: "py-4 rounded-lg bg-[#dc2626] text-white text-[15px] font-medium",
          children: [jsx("div", null, "ШОРТ"), jsx("div", { className: "text-[11px] opacity-80 mt-0.5",
            children: `$${fmt((you.cash*amount)/100,0)}` })] }),
        jsx("button", { onClick: () => trade("CLOSE"), disabled: !hasPos,
          className: "py-4 rounded-lg text-[15px] font-medium " + (hasPos ? "bg-[#232326] text-white" : "bg-[#141416] text-[#46464C]"),
          children: "ЗАКРЫТЬ" }),
      ] }),
    ] }),

    jsxs("div", { className: "px-4 mt-6 flex gap-2", children: [
      jsx("button", { onClick: () => setPaused((p) => !p),
        className: "px-3 py-2 rounded bg-[#141416] text-[12px] text-[#9a9aa0]",
        children: paused ? "▶ продолжить" : "⏸ пауза" }),
      jsx("button", { onClick: () => setShowParticipants((s) => !s),
        className: "px-3 py-2 rounded bg-[#141416] text-[12px] text-[#9a9aa0]",
        children: (showParticipants ? "скрыть" : "показать") + ` участников (${snap.participants.length})` }),
      jsx("button", { onClick: () => setShowDebug((s) => !s),
        className: "px-3 py-2 rounded bg-[#141416] text-[12px] text-[#9a9aa0]", children: "отладка" }),
    ] }),

    showDebug ? jsxs("div", { className: "mx-4 mt-3 p-3 rounded bg-[#0B0B0C] border border-[#1E1E21] text-[11px] font-mono text-[#7A7A80] space-y-1", children: [
      jsx("div", { children: `escrow: ${fmt(escrow,4)}` }),
      jsx("div", { children: `totalCapital: ${fmt(totalCapital,4)}` }),
      jsx("div", { children: `Σ equity (проверка): ${fmt(snap.debug ? snap.debug.sumEquity : NaN,6)}` }),
      jsx("div", { children: `halted: ${roomRef.current && roomRef.current.halted ? "ДА — " + JSON.stringify(roomRef.current.halted.errors) : "нет"}` }),
    ] }) : null,

    showParticipants ? jsx("div", { className: "mx-4 mt-3 rounded border border-[#1E1E21] divide-y divide-[#1E1E21] max-h-[340px] overflow-y-auto no-scrollbar", children:
      snap.participants
        .slice().sort((a,b) => b.equity - a.equity)
        .map((p) => jsxs("div", { className: "flex justify-between px-3 py-2 text-[12px]", children: [
          jsx("span", { className: p.isHuman ? "text-white" : "text-[#7A7A80]",
            children: p.isHuman ? "Вы" : (p.archetype || "—") }),
          jsx("span", { className: "tabular-nums " + (p.equity >= 100 ? "text-[#22c55e]" : "text-[#ef4444]"),
            children: "$" + fmt(p.equity) }),
        ] }, p.id))
    }) : null,

  ] });
}

createRoot(document.getElementById("root")).render(jsx(App, {}));

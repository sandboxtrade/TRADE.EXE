import { CONFIG } from "./config.js";

// ---- market.js (MODEL-S) ----

/**
 * ЦЕНОВАЯ МОДЕЛЬ S — «спор сторон».
 *
 * Заменяет кривую p(Q) = P0*(1+beta*tanh(Q/kappa)) вместе с резервом, escrow,
 * ценой полной ликвидации и двухпроходным клирингом. Причина замены — теорема,
 * доказанная в аудите: если деньги за позицию лежат в общем резерве, а цена
 * есть функция состояния рынка, то цена ОБЯЗАНА быть функцией одного Q, а
 * значит закрытие всех позиций всегда возвращает её ровно в P0. Отсюда и
 * бралась беспроигрышная стратегия «торгуй возврат к сотне» (60/60 сессий).
 *
 * Три правила модели S:
 *
 *  1. СТАВКА ИГРАЕТ РОВНО НАСТОЛЬКО, НАСКОЛЬКО ЕЁ ПЕРЕКРЫЛА ДРУГАЯ СТОРОНА.
 *     L — деньги на повышение, S — на понижение, спорят min(L, S).
 *     Меньшинство участвует на 100%, большинство — частично.
 *     Нет противоположной стороны — никто не может ни выиграть, ни проиграть.
 *
 *  2. ЦЕНА ДВИГАЕТСЯ ТОЛЬКО ОТ ПЕРЕВЕСА ЗАЯВОК ТИКА.
 *     dP = k * (приток на повышение − приток на понижение).
 *     Чем больше участников в позиции, тем слабее один доллар двигает цену.
 *
 *  3. СДВИГ ЦЕНЫ ДОСТАЁТСЯ ТОЛЬКО ТЕМ, КТО В ЭТОМ ТИКЕ НЕ ДЕЙСТВОВАЛ.
 *     Это не косметика, а единственный симметричный вариант. Замерено:
 *       - если действующий попадает в переоценку, он зарабатывает на
 *         собственном сдвиге — возвращается самораскачка;
 *       - если попадает только выходящий, вход и выход несимметричны, и
 *         пассивное держание даёт +2.05 в лонг И +2.11 в шорт при 92-97%
 *         прибыльных сессий, то есть беспроигрышную стратегию без навыка;
 *       - при полном исключении действующего 500 кругов «вошёл-вышел» дают
 *         ровно 0.00, а пассивное держание +0.64 / +0.92 при 60-70%.
 *
 * ЕДИНИЦЫ. Поле pl.u теперь хранит СТАВКУ В ДЕНЬГАХ со знаком:
 * u > 0 — на повышение, u < 0 — на понижение, |u| — сколько денег поставлено.
 * Поэтому value(u, P) = |u|, а деньги участника = cash + |u|. Весь код ботов,
 * заявок и снапшота работает с u как раньше и правки не требует.
 *
 * Чего больше НЕ существует: резерва R(Q), escrow, цены полной ликвидации,
 * цены клиринга, маржин-коллов, ликвидаций, плеча и отрицательного эквити.
 * Максимальный убыток равен сматченной части ставки, и она каждый тик
 * пересчитывается от уже уменьшившейся суммы, поэтому деньги участника
 * никогда не уходят в минус — структурно, а не проверкой.
 */

/** Совместимость: остальной файл ждёт объект curve с этими полями. */
function makeCurve(marketRef) {
  const { P0, beta } = CONFIG;
  const PMIN = P0 * (1 - beta);
  const PMAX = P0 * (1 + beta);
  return {
    PMIN, PMAX,
    /** Стоимость позиции = поставленные деньги. */
    value: (u) => Math.abs(u),
    /** Размер позиции: ставка в деньгах и есть размер. */
    unitsFor: (budget) => Math.max(0, budget),
    /** Оценка собственного сдвига цены — нужна ботам для расчёта выгоды. */
    clearingPrice: (_Q, du) => marketRef.P + marketRef.depth() * du,
    /** Цена — самостоятельное состояние, отдельной «цены ликвидации» нет. */
    liquidationPrice: () => marketRef.P,
    p: () => marketRef.P,
  };
}

class Market {
  constructor({ playerCount, startingCapital, seed = 1, leverage = 1 }) {
    /* ПЛЕЧО В МОДЕЛИ S.
       Заём берётся из общей кассы комнаты: cash участника уходит в минус
       ровно на занятую сумму. Тождество Σcash + Σ|u| = C от этого не
       страдает — деньги не создаются, они перекладываются. Плата за это —
       эквити может уйти в ноль и ниже, поэтому нужен маржин-колл, которого
       в безрычажном режиме нет по построению. */
    this.leverage = Math.max(1, leverage || 1);
    this.maintenance = this.leverage > 1
      ? CONFIG.LEV_MAINTENANCE / this.leverage : 0;
    this.npcLeverage = 1;
    this.liquidations = 0;
    this.totalTicks = null;
    this.phase = null;
    this.warmupTicks = 0;
    this.startingCapital = startingCapital;
    this.C = playerCount * startingCapital;
    this.seed = seed;
    this.rng = mulberry32(seed * 2654435761 + 12345);

    /* СКРЫТЫЙ ЦЕНТР. Точка, в которую вернётся цена, если все закроются,
       разная в каждой сессии и нигде не показывается. Без этого «торгуй
       возврат к сотне» давала +3.23 при 95% прибыльных; со скрытым центром
       игрок вынужден оценивать его по средней цене и получает +0.58 при
       медиане 0.00 и 48% прибыльных, то есть ничего. */
    this.center = CONFIG.CENTER_MIN +
      this.rng() * (CONFIG.CENTER_MAX - CONFIG.CENTER_MIN);
    this.P = this.center;

    this.curve = makeCurve(this);
    this.tick = 0;
    this.longRealized = 0;
    this.shortRealized = 0;
    this.crowd = 0;
    this.crowdMoney = 0;
    this.players = Array.from({ length: playerCount }, (_, i) => ({
      id: i, name: null, isHuman: false,
      cash: startingCapital,
      // ставка в деньгах со знаком: + на повышение, − на понижение
      u: 0,
      entryPrice: null,
      // invested и basis — одна и та же величина: сколько денег было
      // поставлено при входе. Оба поля оставлены, потому что снапшот
      // отдаёт invested как «маржу» позиции.
      invested: 0, basis: 0,
      realizedPnL: 0, tradeCount: 0,
      stopLoss: null, takeProfit: null,
      liquidatedAt: null,
      npc: null,
    }));
  }

  /* --------------------------- состояние рынка --------------------------- */

  get mark() { return this.P; }
  get liquidationPrice() { return this.P; }
  /** Перевес сторон в деньгах. Наружу отдаётся только для отладки. */
  get Q() { let s = 0; for (const p of this.players) s += p.u; return s; }
  /** Сумма всех ставок. Заменяет прежний escrow в снапшоте. */
  get escrow() { let s = 0; for (const p of this.players) s += Math.abs(p.u); return s; }

  /**
   * Перекос книги по ВЛОЖЕННЫМ деньгам (basis), а не по текущей ставке.
   *
   * Разница принципиальная. Текущая ставка каждый тик переоценивается, и
   * выигравшая сторона механически «толстеет» — значит перекос по ставке
   * есть просто функция недавнего хода цены. Боты, реагирующие на такой
   * перекос, превращаются в чистых контр-трендовых с идеальным сигналом, и
   * цена становится предсказуемой: замер показал, что тройка maker +
   * crowdfade + sniper на перекосе по ставке давала стратегии «возврат к
   * средней» +9.5 при 97% прибыльных сессий. На basis тот же набор ботов
   * даёт −2.8 при 40%.
   */
  sidesBasis() {
    // В свободном рынке pendingIntents уже делает обязательный проход по
    // 5 001 счёту ради стопов/тейков. Переиспользуем собранную там книгу,
    // чтобы maker/crowd-стратегии не запускали дополнительные O(N) проходы.
    if (this.freeMarket && this._freePreStats) {
      return { L: this._freePreStats.longBasis || 0, S: this._freePreStats.shortBasis || 0 };
    }
    let L = 0, S = 0;
    for (const p of this.players) {
      if (p.u > 0) L += p.basis; else if (p.u < 0) S += p.basis;
    }
    return { L, S };
  }

  /** Деньги на повышение, на понижение и сколько из них реально спорит. */
  sides() {
    let L = 0, S = 0, N = 0;
    for (const p of this.players) {
      if (p.u > 0) { L += p.u; N++; }
      else if (p.u < 0) { S -= p.u; N++; }
    }
    return { L, S, K: Math.min(L, S), N };
  }

  /**
   * Глубина рынка: насколько один доллар двигает цену.
   * База выбрана так, чтобы 0.5% капитала комнаты двигали цену на один пункт.
   * Это делает модель масштабно-инвариантной: при взносе $100 и при $10 000
   * относительная динамика одинакова.
   * Замер размаха за сессию при 99 ботах: DEPTH 0.0025 -> 3.5%,
   * 0.005 -> 6.3% (95-й перцентиль 15.3%), 0.01 -> 19.7%.
   */
  depth() {
    /* Поправка на размер комнаты. Знаки заявок случайны, поэтому суммарный
       поток за тик растёт не как число участников, а как корень из него.
       Без поправки комната на 500 человек становилась мёртвой: размах за
       сессию 3.1% против 16.3% у сотни. Показатель 0.35 подобран замером:
       при 0.5 комната на 300 разгонялась до 15.6%, при 0.25 — на 500 до
       11.8%; на 0.35 размах держится в диапазоне 5-10% при любом размере. */
    /* ГЛУБИНА СЧИТАЕТСЯ ОТ ДЕНЕГ В КНИГЕ, А НЕ ОТ ЧИСЛА УЧАСТНИКОВ.
       Раньше делителем было (1 + DEPTH_CROWD * доля занятых), то есть
       ГОЛОВЫ. Из-за этого удар заявки не зависел от того, сколько денег
       реально стоит в рынке: вход игрока на $1000 при книге в $329 двигал
       цену на 1.7% одной свечой. Теперь чем больше поставлено, тем труднее
       сдвинуть цену — как на настоящем рынке. Замер: удар заявки на $1000
       в комнате 100 x $1000 упал с 1.73% до 0.25%. */
    const n = this.players.length;
    const book = this.freeMarket && Number.isFinite(this._freePreStats?.escrow)
      ? this._freePreStats.escrow : this.escrow;
    return Math.pow(n / 100, 0.35) /
      Math.max(1e-9, this.C * CONFIG.DEPTH_FRACTION + CONFIG.DEPTH_BOOK * book);
  }

  /** Сколько участник получит, если закроется сейчас: ровно свою ставку. */
  settlement(i) { return Math.abs(this.players[i].u); }
  equity(i) { const p = this.players[i]; return p.cash + Math.abs(p.u); }
  /** Результат по открытой позиции = ставка сейчас минус ставка при входе. */
  unrealized(i) {
    const pl = this.players[i];
    return pl.u === 0 ? 0 : Math.abs(pl.u) - pl.basis;
  }
  sumEquity() { let s = 0; for (const p of this.players) s += p.cash + Math.abs(p.u); return s; }

  /**
   * Досрочный выход. Позиция уже закрыта, поэтому все деньги в cash.
   * Доля frac снимается и поровну раздаётся остальным: Σ денег не меняется.
   */
  applyExitPenalty(i, frac) {
    const pl = this.players[i];
    const amount = Math.max(0, this.equity(i)) * frac;
    if (amount <= 0) return 0;
    const others = this.players.filter((p) => p.id !== i);
    if (!others.length) return 0;
    pl.cash -= amount;
    const share = amount / others.length;
    for (const p of others) p.cash += share;
    return amount;
  }

  /**
   * ПЛАТА ЗА ЗАЁМ. Начисляется каждый тик на отрицательный cash и делится
   * между теми, у кого cash положительный, пропорционально свободным
   * деньгам. Деньги не создаются и не исчезают.
   *
   * Зачем она нужна. Маржин-колл обрезает убыток снизу (ниже уровня
   * поддержки позиция закрывается), а прибыль сверху ничем не ограничена.
   * Бесплатно такая асимметрия даёт положительное матожидание из воздуха:
   * замер на 60 сессиях при плече x10 и входе на всю покупательную
   * способность — медиана +141 при взносе 1000, то есть +14% за сессию
   * просто за факт использования максимального плеча. Плата за заём
   * ровно это и компенсирует, как ставка финансирования на бирже.
   */
  /** Плечо конкретного участника. NPC всегда торгуют без займа. */
  playerLeverage(i) {
    const pl = this.players[i];
    if (!pl) return 1;
    return pl.npc ? this.npcLeverage : this.leverage;
  }

  accrueBorrowCost() {
    if (this.leverage <= 1 || CONFIG.LEV_BORROW_RATE <= 0) return;
    let owed = 0, free = 0;
    /* Заём разрешён только реальным участникам. NPC работают с x1, поэтому
       пассивный игрок больше не получает "процент" от случайных долгов ботов. */
    for (const p of this.players) {
      const lev = this.playerLeverage(p.id);
      if (lev > 1 && p.cash < 0) owed += -p.cash;
      else if (p.cash > 0) free += p.cash;
    }
    if (owed <= 0 || free <= 0) return;
    const fee = Math.min(owed * CONFIG.LEV_BORROW_RATE, free);
    for (const p of this.players) {
      if (this.playerLeverage(p.id) > 1 && p.cash < 0)
        p.cash -= (-p.cash / owed) * fee;
    }
    for (const p of this.players) if (p.cash > 0) p.cash += (p.cash / free) * fee;
  }

  /** Сколько ещё можно поставить сверх уже поставленного. */
  buyingPower(i) {
    const pl = this.players[i];
    const lev = this.playerLeverage(i);
    return Math.max(0, lev * this.equity(i) - Math.abs(pl.u));
  }
  /**
   * Уровень маржи = эквити / размер позиции. При входе на всю
   * покупательную способность равен 1/L, то есть 10% при плече x10.
   * null — позиции нет или участник торгует без плеча.
   */
  marginLevel(i) {
    if (this.playerLeverage(i) <= 1) return null;
    const pl = this.players[i];
    if (!pl || pl.u === 0) return null;
    return this.equity(i) / Math.abs(pl.u);
  }

  /**
   * ОЦЕНКА цены принудительного закрытия. Именно оценка, а не точная
   * величина: в модели S ставка меняется не от цены напрямую, а от
   * СМАТЧЕННОЙ доли хода, которая зависит от состава книги в каждом тике.
   * Формула считает худший случай — полное совпадение сторон (доля 1).
   */
  liquidationEstimate(i) {
    if (this.playerLeverage(i) <= 1) return null;
    const pl = this.players[i];
    if (!pl || pl.u === 0 || pl.basis <= 0) return null;
    const borrowed = -Math.min(0, pl.cash);
    if (borrowed <= 0) return null;
    // Порог: |u| * (1 − maintenance) = занятое.
    const target = borrowed / Math.max(1e-9, 1 - this.maintenance);
    if (target >= Math.abs(pl.u)) return this.P;
    const half = CONFIG.P0 * CONFIG.beta;
    const move = half * (target / pl.basis - 1);
    const entry = pl.entryPrice ?? this.P;
    const price = pl.u > 0 ? entry + move : entry - move;
    return clamp(price, this.curve.PMIN, this.curve.PMAX);
  }

  /**
   * Маржин-колл. Позиция закрывается ЦЕЛИКОМ и в общем клиринге тика,
   * вместе со всеми остальными заявками: отдельной цены для ликвидируемых
   * нет, иначе они исполнялись бы лучше или хуже прочих.
   */
  marginCalls() {
    if (this.leverage <= 1) return [];
    const out = [];
    for (const pl of this.players) {
      if (pl.u === 0 || this.playerLeverage(pl.id) <= 1) continue;
      const lvl = this.equity(pl.id) / Math.abs(pl.u);
      if (lvl < this.maintenance)
        out.push({ i: pl.id, du: -pl.u, reason: "liquidation" });
    }
    return out;
  }

  /* ------------------------------ КЛИРИНГ -------------------------------- */
  /**
   * orders: [{ i, du, reason }] — желаемое изменение ставки в деньгах.
   *
   * Порядок заявок не влияет ни на цену, ни на исполнение: сначала все
   * заявки складываются по участнику, потом считается один общий перевес,
   * потом одна переоценка. Проверено: перестановка даёт расхождение 0.
   */
  clear(orders) {
    /* Защитные действия НЕ суммируются с обычными. Если на одном тике
       сработал margin-call/stop/take/leave, он полностью подавляет рыночные
       и NPC-намерения этого же участника. Иначе CLOSE мог случайно
       превратиться в разворот позиции. */
    const PRIORITY = { leave: 5, "free-retire": 5, liquidation: 4, stop: 3, take: 3 };
    const merged = new Map();
    for (const o of orders) {
      if (!Number.isFinite(o.du) || o.du === 0) continue;
      const reason = o.reason || null;
      const prio = PRIORITY[reason] || 0;
      const cur = merged.get(o.i);
      if (!cur) {
        merged.set(o.i, { i: o.i, du: o.du, reason, priority: prio });
        continue;
      }
      if (prio > cur.priority) {
        cur.du = o.du; cur.reason = reason; cur.priority = prio;
        continue;
      }
      if (prio < cur.priority) continue;
      /* Для защитного приоритета достаточно одного полного закрытия.
         Для обычных заявок сохраняем прежнюю симметрию: они неттятся. */
      if (prio > 0) continue;
      cur.du += o.du;
    }
    const work = [...merged.values()].filter((o) => Math.abs(o.du) > 1e-12);
    if (!work.length) { this.tick++; return { price: this.P, executed: [], iters: 0 }; }

    const { PMIN, PMAX } = this.curve;
    const k = this.depth();

    /* 1. Обрезка по деньгам. Ставка после действия не может превышать
       свободные деньги плюс уже поставленное. Зависит только от своего
       состояния, поэтому от чужих заявок и от порядка не зависит. */
    let flow = 0;
    for (const o of work) {
      const pl = this.players[o.i];
      const before = pl.u;
      let after = before + o.du;
      /* Потолок ставки = плечо × эквити. При L = 1 это ровно прежнее
         «свободные деньги плюс уже поставленное». Зависит только от
         своего состояния, поэтому от чужих заявок и от порядка не
         зависит. Заявки на УМЕНЬШЕНИЕ позиции не режутся никогда:
         иначе маржин-колл не смог бы закрыть позицию, вышедшую за
         потолок из-за переоценки. */
      const budget = this.playerLeverage(pl.id) * (pl.cash + Math.abs(before));
      if (Math.abs(after) > Math.max(budget, Math.abs(before)))
        after = Math.sign(after) * Math.max(budget, Math.abs(before));
      o.after = after;
      o.before = before;
      /* Поток делится на ОТКРЫТИЕ (рост риска) и ЗАКРЫТИЕ (движение к нулю).
         Закрытие двигает цену в CLOSE_IMPACT раз слабее — см. комментарий
         к CLOSE_IMPACT. Обрезка по деньгам уже применена, поэтому деление
         считается по фактическим before/after и от порядка не зависит. */
      const closing = before !== 0 && Math.sign(after) !== Math.sign(before)
        ? -before
        : (Math.abs(after) < Math.abs(before) ? after - before : 0);
      const opening = (after - before) - closing;
      flow += opening + CONFIG.CLOSE_IMPACT * closing;
    }

    /* 2. Сдвиг цены от суммарного перевеса. */
    let Pn = this.P + k * flow;
    if (Pn > PMAX - 1e-6) Pn = PMAX - 1e-6;
    if (Pn < PMIN + 1e-6) Pn = PMIN + 1e-6;
    const dP = Pn - this.P;

    /* 3. Переоценка ОСТАТОЧНОЙ КНИГИ — без тех, кто действует в этом тике.
       Суммы сторон в остаточной книге равны K', поэтому сумма всех
       изменений строго ноль и деньги сохраняются точно. */
    if (dP !== 0) {
      let L2 = 0, S2 = 0;
      for (const p of this.players) {
        if (merged.has(p.id) || p.u === 0) continue;
        if (p.u > 0) L2 += p.u; else S2 -= p.u;
      }
      const K2 = Math.min(L2, S2);
      if (K2 > 0) {
        const fL = K2 / L2, fS = K2 / S2;
        const scale = dP / (CONFIG.P0 * CONFIG.beta);   // полуширина коридора
        for (const p of this.players) {
          if (merged.has(p.id) || p.u === 0) continue;
          const m = Math.abs(p.u) * (p.u > 0 ? fL : fS);
          p.u += m * scale;
          if (Math.abs(p.u) < 1e-12) { p.u = 0; p.entryPrice = null; p.basis = 0;
            p.invested = 0; p.stopLoss = null; p.takeProfit = null; }
        }
      }
    }
    this.P = Pn;

    /* 4. Применение заявок. Деньги: вернули старую ставку, списали новую. */
    const executed = [];
    for (const o of work) {
      const pl = this.players[o.i];
      const before = o.before, after = o.after;
      if (Math.abs(after - before) < 1e-12) continue;
      const sb = Math.abs(before), sa = Math.abs(after);
      pl.cash += sb - sa;

      if (before !== 0 && (after === 0 || Math.sign(after) !== Math.sign(before))) {
        const booked = sb - pl.basis;                  // закрыли старую ставку целиком
        pl.realizedPnL += booked;
        if (before > 0) this.longRealized += booked; else this.shortRealized += booked;
        pl.basis = 0; pl.invested = 0; pl.entryPrice = null;
        pl.stopLoss = null; pl.takeProfit = null;
      } else if (before !== 0 && sa < sb) {
        const keep = sa / sb;
        const closedBasis = pl.basis * (1 - keep);
        const booked = (sb - sa) - closedBasis;
        pl.realizedPnL += booked;
        if (before > 0) this.longRealized += booked; else this.shortRealized += booked;
        pl.basis *= keep; pl.invested = pl.basis;
      }
      if (after !== 0) {
        if (before === 0 || Math.sign(after) !== Math.sign(before)) {
          pl.basis = sa; pl.invested = sa; pl.entryPrice = Pn;
        } else if (sa > sb) {
          pl.basis += sa - sb; pl.invested = pl.basis; pl.entryPrice = Pn;
        }
      }
      pl.u = after;
      pl.tradeCount++;
      if (o.reason === "liquidation") {
        pl.liquidatedAt = this.tick;
        this.liquidations++;
      }
      const actualDu = after - before;
      executed.push({ i: o.i, du: actualDu, price: Pn, reason: o.reason });
    }
    this.tick++;
    return { price: Pn, executed, iters: 0 };
  }
}

// ---- invariants.js ----

/**
 * INVARIANT CHECKER. Вызывается после КАЖДОГО тика.
 * При нарушении возвращает отчёт, достаточный для воспроизведения.
 */
function checkInvariants(m, ctx = {}) {
  const errs = [];
  /* Допуски МАСШТАБИРУЮТСЯ вместе с капиталом комнаты.
     Раньше они были абсолютными, и при взносе $10 000 (капитал комнаты
     $1 000 000) обычный численный шум клиринга в 7.5e-2 — относительная
     ошибка 7.5e-8, то есть безупречная точность — валил сессию в аварийную
     остановку. При взносе $100 та же проверка была, наоборот, слишком
     мягкой. */
  const scale = Math.max(1, m.C / 10000);
  const TC = CONFIG.TOL_CAPITAL * scale;
  const TN = CONFIG.TOL_NONNEG * scale;
  const totalCash = m.players.reduce((a, p) => a + p.cash, 0);

  if (Math.abs(totalCash + m.escrow - m.C) > TC)
    errs.push(`Σcash+escrow ≠ C: ${(totalCash + m.escrow - m.C).toExponential(3)}`);
  if (Math.abs(m.sumEquity() - m.C) > TC)
    errs.push(`Σequity ≠ C: ${(m.sumEquity() - m.C).toExponential(3)}`);
  if (m.escrow < -TN) errs.push(`escrow < 0: ${m.escrow}`);

  const price = m.mark;
  if (price < m.curve.PMIN - TN || price > m.curve.PMAX + TN)
    errs.push(`price вне [${m.curve.PMIN}, ${m.curve.PMAX}]: ${price}`);

  // При плече кэш уходит в минус только у реального участника. NPC всегда
  // x1, поэтому отрицательный cash у бота — уже ошибка движка.
  for (const p of m.players) {
    const lev = m.playerLeverage(p.id) > 1;
    if (!lev && p.cash < -TN) errs.push(`cash < 0 у #${p.id}: ${p.cash}`);
    if (!lev && m.equity(p.id) < -TN) errs.push(`equity < 0 у #${p.id}: ${m.equity(p.id)}`);
    if (lev && m.equity(p.id) < -(p.startingCapital ?? m.startingCapital) * 4)
      errs.push(`неуправляемый долг у #${p.id}: ${m.equity(p.id)}`);
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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
  aggressive:   { size: [0.8, 1.0], act: 0.30, stop: -0.25, take: 0.40, bias: "trend", fast: true },
  conservative: { size: [0.05, 0.2], act: 0.10, stop: -0.05, take: 0.08, bias: "fade", fast: true },
  momentum:     { size: [0.2, 0.5], act: 0.35, stop: -0.10, take: 0.25, bias: "trend", fast: true },
  contrarian:   { size: [0.2, 0.5], act: 0.35, stop: -0.10, take: 0.25, bias: "fade" },
  random:       { size: [0.1, 0.4], act: 0.25, stop: -0.20, take: 0.20, bias: "rand" },
  scared:       { size: [0.1, 0.3], act: 0.20, stop: -0.02, take: 0.05, bias: "fade", fast: true },
  greedy:       { size: [0.5, 0.9], act: 0.15, stop: -0.30, take: 0.60, bias: "trend" },
  scalper:      { size: [0.2, 0.4], act: 0.60, stop: -0.03, take: 0.03, bias: "fade", fast: true },
  longterm:     { size: [0.3, 0.6], act: 0.03, stop: -0.40, take: 0.80, bias: "trend" },
  panic:        { size: [0.3, 0.6], act: 0.20, stop: -0.08, take: 0.30, bias: "fade", fast: true },
  inactive:     { size: [0.05, 0.2], act: 0.02, stop: -0.30, take: 0.30, bias: "rand" },
  // Пробойщик: входит не по наклону, а по выходу цены за экстремум окна.
  // Именно он ломает «торговлю от одних и тех же уровней»: пока цена в
  // коридоре, он молчит, а на выходе из него добавляет силы движению.
  breakout:     { size: [0.4, 0.8], act: 0.40, stop: -0.12, take: 0.50, bias: "break" },
  // Стадо: смотрит не на цену, а на перекос позиций толпы.
  herd:         { size: [0.3, 0.6], act: 0.25, stop: -0.15, take: 0.35, bias: "herd" },
  // Охотник за стопами: толкает цену к ближайшему экстремуму окна, где
  // скопились чужие стопы, и разворачивается, когда уровень пробит.
  hunter:       { size: [0.5, 0.9], act: 0.45, stop: -0.10, take: 0.20, bias: "hunt" },
  // Ловушка: входит ПРОТИВ свежего пробоя, рассчитывая на ложный выход.
  trap:         { size: [0.4, 0.7], act: 0.35, stop: -0.12, take: 0.30, bias: "trap" },

  /* ---------------------------------------------------------------------
     ВТОРАЯ ВОЛНА АРХЕТИПОВ. До неё все боты смотрели ровно на две вещи:
     наклон цены и экстремумы окна. Из-за этого рынок вёл себя однообразно,
     а «толпа» была величиной, на которую никто не реагировал осмысленно.
     Каждый тип ниже смотрит на СВОЙ признак состояния рынка.
     --------------------------------------------------------------------- */

  // Против толпы: чем сильнее перекос ДЕНЕГ в книге, тем охотнее встаёт
  // на противоположную сторону. Не путать с herd — тот перекос копирует.
  crowdfade:    { size: [0.4, 0.8], act: 0.30, stop: -0.12, take: 0.28, bias: "crowdfade" },
  // Возврат к средней цене окна. В отличие от fade смотрит не на наклон,
  // а на отклонение от собственной скользящей средней.
  meanrev:      { size: [0.3, 0.7], act: 0.30, stop: -0.10, take: 0.15, bias: "meanrev" },
  // Работа от границ диапазона: продаёт у верхней, покупает у нижней.
  range:        { size: [0.3, 0.6], act: 0.35, stop: -0.08, take: 0.18, bias: "range" },
  // Сжатие волатильности: молчит, пока рынок стоит узко, и входит по
  // направлению первого выхода из сжатия.
  squeeze:      { size: [0.4, 0.8], act: 0.30, stop: -0.10, take: 0.35, bias: "squeeze" },
  // Гашение выброса: одиночная резкая свеча гасится входом против неё.
  spike:        { size: [0.3, 0.7], act: 0.45, stop: -0.08, take: 0.12, bias: "spike" },
  // Уравновешивающий: сознательно встаёт на сторону МЕНЬШИНСТВА книги.
  // Без него книга держит перекос ~39%, цена системно идёт против
  // большинства и любой участник, чья сторона не связана с толпой,
  // зарабатывает без навыка (замер в разделе CLOSE_IMPACT).
  maker:        { size: [0.3, 0.7], act: 0.50, stop: -0.15, take: 0.10, bias: "maker" },
  // Подражатель: копирует сторону самого прибыльного участника рынка.
  // Даёт обратную связь «успех притягивает деньги», которой не было.
  copycat:      { size: [0.3, 0.6], act: 0.25, stop: -0.12, take: 0.25, bias: "copy" },
  // Снайпер: почти всё время вне рынка, но входит редко и крупно, когда
  // сходятся отклонение от средней и перекос книги.
  sniper:       { size: [0.7, 1.0], act: 0.06, stop: -0.10, take: 0.30, bias: "sniper" },

  /* Трендовая половина второй волны. Без неё пул перекосился в контр-тренд:
     стратегия «возврат к средней» давала +10.6, моментум −18.5. Эти четыре
     типа входят по направлению движения, но каждый по своему признаку. */

  // Откат: направление длинного тренда, но вход на откате к средней,
  // а не по факту движения.
  pullback:     { size: [0.4, 0.8], act: 0.30, stop: -0.10, take: 0.30, bias: "pullback" },
  // Поток: идёт за перекосом ДЕНЕГ в книге (денежный аналог стада).
  flow:         { size: [0.3, 0.7], act: 0.30, stop: -0.12, take: 0.25, bias: "flow" },
  // Ускорение: короткий импульс сильнее длинного и в ту же сторону.
  accel:        { size: [0.4, 0.8], act: 0.35, stop: -0.10, take: 0.28, bias: "accel" },
  // Догоняющий: входит по подтверждённому движению, когда оно держится
  // два окна подряд. Приходит поздно и потому часто ошибается.
  chase:        { size: [0.3, 0.6], act: 0.30, stop: -0.12, take: 0.30, bias: "chase" },
};
const TYPES = Object.keys(ARCHETYPES);
/** Архетипы, играющие ПО движению. Их общий вес — ручка NPC_TREND_SIZE. */
const TREND_BIASES = new Set(["trend", "break", "hunt", "pullback", "flow",
  "accel", "chase", "squeeze", "copy"]);

function makeNPCState(type, spec, r, seed, ordinal) {
  return {
    type, spec,
    size: CONFIG.NPC_SIZE_SCALE * (spec.size[0] + r() * (spec.size[1] - spec.size[0]))
      * (TREND_BIASES.has(spec.bias) ? CONFIG.NPC_TREND_SIZE : 1)
      * (spec.fast
        ? (spec.bias === "fade" ? CONFIG.NPC_FAST_FADE_WEIGHT : CONFIG.NPC_FAST_TREND_WEIGHT)
        : 1),
    act: spec.act * (0.6 + 0.8 * r()) * CONFIG.NPC_ACT_SCALE,
    lag: r() < CONFIG.NPC_INSTANT_FRACTION ? 1 : 2 + Math.floor(r() * 5),
    look: Math.round(5 * Math.pow(48, r())),
    thresh: (0.0004 + r() * 0.006) * CONFIG.NPC_THRESH_SCALE,
    herd: r() * CONFIG.NPC_HERD_MAX,
    trail: spec.bias === "trend" || spec.bias === "break" ? 0.3 + r() * 0.5 : 0,
    stop: spec.stop * CONFIG.NPC_PNL_SCALE,
    take: spec.take * CONFIG.NPC_PNL_SCALE,
    hold: Math.round(CONFIG.NPC_HOLD_MIN +
      r() * (CONFIG.NPC_HOLD_MAX - CONFIG.NPC_HOLD_MIN)),
    usesOrders: r() < CONFIG.NPC_ORDER_FRACTION,
    patience: 6 + Math.floor(r() * 40),
    minGap: Math.round(CONFIG.NPC_MIN_GAP * Math.pow(4, r())),
    flushAt: 0.88 + r() * 0.11,
    lastTrade: -1e9, urgent: false,
    flexibility: 0.15 + r() * 0.7,
    since: 0, lastU: 0, lastBasis: 0, peak: 0, conviction: 1, mood: 0,
    cooldown: 0, edge: 0, trades: 0, losses: 0, flipped: 0,
    startEquity: null, entryEquity: null,
    rng: mulberry32(seed * 7919 + ordinal + 1),
  };
}

function attachNPCs(m, startIdx, count, seed, typeList = TYPES) {
  const r = mulberry32(seed);
  const list = typeList && typeList.length ? typeList : TYPES;
  for (let k = 0; k < count; k++) {
    const type = list[k % list.length];
    const spec = ARCHETYPES[type];
    const idx = startIdx + k;
    m.players[idx].name = `${type}-${k}`;
    m.players[idx].npc = makeNPCState(type, spec, r, seed, k);
  }
}

/* --- Признаки состояния рынка для новых архетипов --- */

/** Средняя цена за look тиков. */
function windowMean(history, look) {
  const n = Math.min(look, history.length);
  if (n <= 0) return NaN;
  let s = 0;
  for (let k = 0; k < n; k++) s += history[history.length - 1 - k];
  return s / n;
}

/** Ширина диапазона окна в долях цены — мера волатильности. */
function windowWidth(history, look, P) {
  const { hi, lo } = windowRange(history, look);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || P <= 0) return NaN;
  return (hi - lo) / P;
}

/**
 * Сторона самого прибыльного участника, кто сейчас в позиции.
 * Считается по реализованному результату — по нему копировать честно,
 * скрытых полей снапшота это не раскрывает: подражатель — такой же бот.
 */
function leaderSide(m) {
  if (m.freeMarket && Number.isFinite(m._freePreStats?.leaderSide))
    return m._freePreStats.leaderSide;
  let best = null, bestPnL = 0;
  for (const p of m.players) {
    if (p.u === 0) continue;
    if (p.realizedPnL > bestPnL) { bestPnL = p.realizedPnL; best = p; }
  }
  return best ? Math.sign(best.u) : 0;
}

/** Во время предторгового отсчёта никаких заявок не создаётся.
 * Рынок полностью закрыт до момента открытия. */

/** Экстремумы окна: нужны пробойщикам. */
function windowRange(history, look) {
  const n = history.length;
  let hi = -Infinity, lo = Infinity;
  for (let k = Math.max(0, n - 1 - look); k < n - 1; k++) {
    if (history[k] > hi) hi = history[k];
    if (history[k] < lo) lo = history[k];
  }
  return { hi, lo };
}

/**
 * Решение NPC. Видит только: цену, историю, своё состояние, свой шум.
 *
 * Что изменилось против первой версии, где рынок ходил в узком коридоре:
 *  - горизонты наблюдения разбросаны от 5 до 240 тиков, а не 1-5 у всех;
 *  - у входа есть порог: мелкий шум игнорируется, и боты не дёргаются
 *    синхронно на каждом тике;
 *  - трендовые ведут трейлинг вместо фиксированного тейка, поэтому движение
 *    не срезается на первых процентах;
 *  - уверенность растёт после удачных сделок и падает после неудачных —
 *    выигрывающая сторона наращивает размер, и движения получают инерцию;
 *  - появились пробойщики и стадо, которые усиливают выход из коридора.
 */
function syncNPCState(m, i) {
  const pl = m.players[i], n = pl.npc;
  if (!n) return;
  if (n.startEquity === null) n.startEquity = m.equity(i);

  /* Синхронизация состояния выполняется один раз за тик ДО торгового
     решения. Это bookkeeping, а не сделка: он не должен откатываться,
     даже если minGap запретит очередное действие. */
  const basisChanged = Math.abs(pl.basis - (n.lastBasis ?? 0)) > 1e-9;
  if (basisChanged || (pl.u === 0) !== (n.lastU === 0)
      || Math.sign(pl.u) !== Math.sign(n.lastU)) {
    if (n.lastU !== 0 && pl.u === 0 && n.entryEquity !== null) {
      const eq = m.equity(i);
      close(n, eq > n.entryEquity, eq);
    }
    n.lastU = pl.u; n.lastBasis = pl.basis; n.since = 0; n.peak = 0;
  } else {
    n.lastU = pl.u; n.lastBasis = pl.basis;
  }
  n.since++;
  if (n.cooldown > 0) n.cooldown--;
}

function decideRaw(m, i, history) {
  const pl = m.players[i], n = pl.npc;
  if (!n) return 0;

  const r = n.rng;
  const P = m.mark;
  const equity = m.equity(i);
  const stake = pl.startingCapital ?? m.startingCapital;
  if (pl.u === 0 && pl.cash <= stake * 0.02) return 0;   // сгорел

  /* ------------------------- ВРЕМЯ СЕССИИ -------------------------------
     Комната закрывается по общему таймеру, поэтому время для бота — такой
     же фактор, как цена. Три отрезка:

     СТАРТ (первые 10%) — никто не хочет простоять сессию вне рынка:
       порог входа ниже, пауза не действует, размер чуть больше.
     СЕРЕДИНА — обычное поведение.
     КОНЕЦ (последние 20%) — поведение расходится по результату:
       кто в минусе, отыгрывается: больше размер, ниже порог, дольше держит;
       кто в плюсе, бережёт результат: сокращает размер и раньше выходит.
     ПОСЛЕДНИЕ 3% — все разгружаются: новых входов нет, позиции закрываются,
       потому что после закрытия комнаты держать уже нечего.            */
  const ph = m.phase;                     // null, если сессия бессрочная
  const opening = ph !== null && ph < 0.10;
  const endgame = ph !== null && ph > 0.75;
  /* Разгрузка перед закрытием комнаты. Порог СВОЙ У КАЖДОГО БОТА: при общем
     значении 0.97 все сто участников закрывали позиции в одни и те же три
     секунды, и в конце каждой сессии на графике получался одинаковый
     ровный разгон в одну сторону — на нём можно было зарабатывать, просто
     встав в нужную сторону перед звонком. Теперь выходы размазаны по
     последней десятой сессии. */
  const flush = ph !== null && ph > (n.flushAt ?? 0.97);
  const behind = n.startEquity ? equity < n.startEquity : false;
  // Множители порога входа и размера ставки от фазы.
  let phThresh = 1, phSize = 1;
  if (opening) { phThresh = 0.45; phSize = 1.25; }
  else if (endgame) {
    if (behind) { phThresh = 0.4; phSize = 2.0; }   // отыгрывается
    else { phThresh = 2.2; phSize = 0.45; }         // бережёт прибыль
  }

  const lag = Math.max(1, n.lag);
  const at = (k) => history[Math.max(0, history.length - 1 - k)];
  const past = history.length ? at(lag) : P;
  const mom = (P - past) / Math.max(past, 1e-9);
  const slow = history.length ? (P - at(lag + n.look)) / Math.max(at(lag + n.look), 1e-9) : 0;

  /* ------------------------- УПРАВЛЕНИЕ ПОЗИЦИЕЙ -------------------------
     Выход — тоже решение о деньгах, а не срабатывание таймера. Бот смотрит
     на свой результат в этой сделке и на то, продолжается ли движение,
     ради которого он вошёл.                                                */
  if (pl.u !== 0 && pl.entryPrice !== null) {
    const pnl = pl.u > 0 ? (P - pl.entryPrice) / pl.entryPrice
                         : (pl.entryPrice - P) / pl.entryPrice;
    if (pnl > n.peak) n.peak = pnl;
    const withFlow = (pl.u > 0 ? 1 : -1) * Math.sign(slow) > 0;

    /* ПЫЛЬ. Частичная фиксация режет позицию на 25-60%, и после нескольких
       подряд от ставки остаются копейки. Формально позиция открыта, поэтому
       бот не попадал в ветку входа и застревал в ней до конца сессии.
       Именно из-за этого книга держалась на 0.5% капитала комнаты, рынок
       был вялым, а вход игрока на $1000 рисовал свечу во весь экран.
       Остаток меньше 1% взноса закрывается полностью. */
    if (Math.abs(pl.u) < stake * 0.01) {
      n.urgent = true; close(n, pnl > 0, equity); return -pl.u;
    }
    // Комната вот-вот закроется — держать позицию больше незачем.
    if (flush) { n.urgent = true; close(n, pnl > 0, equity); return -pl.u; }
    // Впереди по итогу и осталось мало времени — фиксируем, не рискуя.
    if (endgame && !behind && pnl > 0 && r() < 0.35) { close(n, true, equity); return -pl.u; }

    if (pnl <= n.stop) { n.urgent = true; close(n, false, equity); return -pl.u; }

    if (n.trail > 0) {
      if (n.peak >= n.take * 0.6 && pnl <= n.peak * (1 - n.trail)) {
        n.urgent = true; close(n, true, equity); return -pl.u;
      }
      // Цель достигнута, но поток всё ещё за нас — жадность против правила.
      if (pnl >= n.take * 2.5 && (!withFlow || r() > n.flexibility)) {
        close(n, true, equity); return -pl.u;
      }
    } else if (pnl >= n.take) {
      n.urgent = true;
      if (withFlow && r() < n.flexibility * 0.5) {
        // Нарушаем собственный тейк и даём прибыли идти дальше.
        n.take *= 1.4;
      } else { close(n, true, equity); return -pl.u; }
    }

    // Движение выдохлось и развернулось против — выходим досрочно, не дожидаясь
    // стопа. Раньше бот просто досиживал до таймера.
    if (!withFlow && pnl < 0 && n.since > 15 && r() < 0.05 + n.flexibility * 0.05) {
      close(n, false, equity); return -pl.u;
    }
    // Отстающий в конце сессии тянет позицию дольше обычного: закрыть её
    // по таймеру значит зафиксировать минус.
    const holdLimit = endgame && behind ? n.hold * 2.5 : n.hold;
    if (n.since >= holdLimit) { close(n, pnl > 0, equity); return -pl.u; }

    if (r() < 0.12) {
      if (withFlow && pnl > 0 && n.conviction > 1) {
        const own = Math.max(0, pl.cash + m.curve.value(pl.u, P));
        let addBudget = own * n.size * 0.4 * n.conviction * m.npcLeverage;
        if (m.freeMarket && Number.isFinite(n.freeRiskCap)) {
          const maxGross = own * n.freeRiskCap;
          addBudget = Math.min(addBudget, Math.max(0, maxGross - Math.abs(pl.u)));
        }
        const add = m.curve.unitsFor(addBudget, P);
        return pl.u > 0 ? add : -add;
      }
      if (r() < 0.5) return -pl.u * (0.25 + 0.35 * r());
    }
    return 0;
  }

  /* ------------------------------- ВХОД ---------------------------------- */
  if (flush) return 0;                       // перед закрытием комнаты не входим
  if (n.cooldown > 0 && !opening) return 0;  // на старте пауза не держит
  if (r() > n.act * (opening ? 1.6 : endgame && behind ? 1.9 : 1)) return 0;

  // Сигнал и его сила. Сила нужна не для красоты: ниже она сравнивается
  // со стоимостью входа и выхода.
  let dir = 0, strength = 0;
  if (n.spec.bias === "break") {
    const { hi, lo } = windowRange(history, n.look);
    if (Number.isFinite(hi) && P > hi) { dir = 1; strength = (P - hi) / P; }
    else if (Number.isFinite(lo) && P < lo) { dir = -1; strength = (lo - P) / P; }
  } else if (n.spec.bias === "herd") {
    dir = Math.sign(m.crowd || 0); strength = Math.abs(m.crowd || 0) * 0.01;
  } else if (n.spec.bias === "hunt") {
    /* EYES — только интерфейсный слой. Охотник использует те же публичные
       признаки цены и в обычном, и в EYES-режиме, поэтому один seed
       порождает один и тот же рынок. */
    const { hi, lo } = windowRange(history, n.look);
    if (!Number.isFinite(hi) || hi <= lo) return 0;
    const pos = (P - lo) / (hi - lo);
    if (pos > 0.78) { dir = 1; strength = (hi - P) / P + 0.001; }
    else if (pos < 0.22) { dir = -1; strength = (P - lo) / P + 0.001; }
    else return 0;
  } else if (n.spec.bias === "trap") {
    const { hi, lo } = windowRange(history, n.look);
    if (Number.isFinite(hi) && P > hi) { dir = -1; strength = (P - hi) / P; }
    else if (Number.isFinite(lo) && P < lo) { dir = 1; strength = (lo - P) / P; }
    else return 0;
  } else if (n.spec.bias === "trend") {
    const sig = n.spec.fast ? mom : slow;
    if (Math.abs(sig) < n.thresh * phThresh) return 0;
    dir = Math.sign(sig); strength = Math.abs(sig);
  } else if (n.spec.bias === "fade") {
    const sig = n.spec.fast ? mom : slow;
    if (Math.abs(sig) < n.thresh * phThresh) return 0;
    dir = -Math.sign(sig); strength = Math.abs(sig);
  } else if (n.spec.bias === "crowdfade") {
    /* Перекос ДЕНЕГ, а не голов: сто участников по доллару весят меньше
       одного крупного. Именно денежный перекос двигает цену. */
    const cm = m.crowdMoney || 0;
    if (Math.abs(cm) < 0.12) return 0;
    dir = -Math.sign(cm); strength = Math.abs(cm) * 0.02;
  } else if (n.spec.bias === "meanrev") {
    const avg = windowMean(history, n.look);
    if (!Number.isFinite(avg) || avg <= 0) return 0;
    const dev = (P - avg) / avg;
    if (Math.abs(dev) < n.thresh * phThresh * 1.5) return 0;
    dir = -Math.sign(dev); strength = Math.abs(dev);
  } else if (n.spec.bias === "range") {
    const { hi, lo } = windowRange(history, n.look);
    if (!Number.isFinite(hi) || hi <= lo) return 0;
    const pos = (P - lo) / (hi - lo);
    if (pos > 0.82) { dir = -1; strength = (P - lo) / P * 0.5; }
    else if (pos < 0.18) { dir = 1; strength = (hi - P) / P * 0.5; }
    else return 0;
  } else if (n.spec.bias === "squeeze") {
    /* Сжатие: ширина короткого окна заметно меньше ширины длинного.
       Вход по направлению уже начавшегося выхода из сжатия. */
    const wS = windowWidth(history, Math.max(5, Math.round(n.look / 4)), P);
    const wL = windowWidth(history, n.look * 2, P);
    if (!Number.isFinite(wS) || !Number.isFinite(wL) || wL <= 0) return 0;
    if (wS > wL * 0.45) return 0;
    if (Math.abs(mom) < n.thresh * 0.5) return 0;
    dir = Math.sign(mom); strength = wL * 0.5;
  } else if (n.spec.bias === "spike") {
    /* Выброс: ход за 3 тика больше обычной ширины окна. Гасится входом
       против него — это то, что на живом рынке делают маркетмейкеры. */
    const p3 = at(3);
    const jump = (P - p3) / Math.max(p3, 1e-9);
    const w = windowWidth(history, n.look, P);
    if (!Number.isFinite(w) || Math.abs(jump) < Math.max(w * 0.5, n.thresh * 2)) return 0;
    dir = -Math.sign(jump); strength = Math.abs(jump) * 0.6;
  } else if (n.spec.bias === "maker") {
    const { L, S } = m.sidesBasis();
    const skew = (L - S) / Math.max(1e-9, L + S);
    if (Math.abs(skew) < 0.06) return 0;
    dir = -Math.sign(skew); strength = Math.max(n.thresh, Math.abs(skew) * 0.015);
  } else if (n.spec.bias === "copy") {
    const side = leaderSide(m);
    if (side === 0) return 0;
    dir = side; strength = n.thresh * 1.6;
  } else if (n.spec.bias === "sniper") {
    /* Редкий крупный вход: нужно СОВПАДЕНИЕ двух независимых признаков —
       цена далеко от средней И книга перекошена в ту же сторону. */
    const avg = windowMean(history, n.look);
    if (!Number.isFinite(avg) || avg <= 0) return 0;
    const dev = (P - avg) / avg;
    const cm = m.crowdMoney || 0;
    if (Math.abs(dev) < n.thresh * 3 || Math.sign(dev) !== Math.sign(cm)
        || Math.abs(cm) < 0.2) return 0;
    dir = -Math.sign(dev); strength = Math.abs(dev) * 1.2;
  } else if (n.spec.bias === "pullback") {
    const avg = windowMean(history, n.look);
    if (!Number.isFinite(avg) || avg <= 0) return 0;
    const trend = Math.sign(slow);
    const dev = (P - avg) / avg;
    if (trend === 0 || Math.abs(slow) < n.thresh * phThresh) return 0;
    if (Math.sign(dev) === trend || Math.abs(dev) < n.thresh * 0.5) return 0;
    dir = trend; strength = Math.abs(slow);
  } else if (n.spec.bias === "flow") {
    const cm = m.crowdMoney || 0;
    if (Math.abs(cm) < 0.12) return 0;
    dir = Math.sign(cm); strength = Math.abs(cm) * 0.02;
  } else if (n.spec.bias === "accel") {
    const fast = mom;
    if (Math.sign(fast) !== Math.sign(slow) || Math.sign(fast) === 0) return 0;
    if (Math.abs(fast) < Math.abs(slow) * 0.6 || Math.abs(fast) < n.thresh * phThresh) return 0;
    dir = Math.sign(fast); strength = Math.abs(fast);
  } else if (n.spec.bias === "chase") {
    const half = Math.max(2, Math.round(n.look / 2));
    const mid = at(lag + half);
    const older = at(lag + n.look);
    if (!Number.isFinite(mid) || !Number.isFinite(older)) return 0;
    const a = (P - mid) / Math.max(mid, 1e-9);
    const b = (mid - older) / Math.max(older, 1e-9);
    if (Math.sign(a) !== Math.sign(b) || Math.sign(a) === 0) return 0;
    if (Math.abs(a) < n.thresh * phThresh) return 0;
    dir = Math.sign(a); strength = Math.abs(a);
  } else {
    dir = r() < 0.5 ? 1 : -1; strength = n.thresh * 1.5;
  }

  if (dir === 0) return 0;

  /* --- Стратегия перестала работать: разворот собственного правила ---
     Бот помнит, сколько он зарабатывал последними сделками. Если его edge
     устойчиво отрицательный, гибкий бот начинает делать наоборот, а
     догматик просто уменьшает ставку. Именно это и отличает попытку
     заработать от торговли по инструкции.                                */
  if (n.edge < CONFIG.NPC_EDGE_GIVEUP && n.trades > 6) {
    if (r() < n.flexibility * 0.6) { dir = -dir; n.flipped++; }
    else if (r() < 0.5) { n.cooldown = n.patience; return 0; }
  }

  // Стадное чувство — по-прежнему примесь, а не основа.
  if (n.herd > 0.35 && r() < n.herd * 0.3) {
    const c = Math.sign(m.crowd || 0);
    if (c !== 0) { dir = c; strength = Math.max(strength, n.thresh); }
  }

  /* --- Ожидаемая выгода против стоимости входа и выхода ---
     Собственный сдвиг цены считается той же функцией клиринга, что и в
     движке, поэтому оценка честная, а не выдуманный коэффициент.         */
  const own = Math.max(0, m.equity(i));
  // Отстал от старта — рискует смелее; вышел вперёд — бережёт прибыль.
  const drawdown = n.startEquity ? (n.startEquity - equity) / n.startEquity : 0;
  const appetite = clamp(1 + drawdown * 1.5, 0.55, 1.7);
  let budget = own * n.size * n.conviction * appetite * phSize * m.npcLeverage;
  // В бессрочном рынке крупный счёт не должен механически доминировать
  // только из-за размера. У каждого капитального класса есть собственный
  // риск-бюджет: micro может рисковать большей долей счёта, whale — меньшей.
  if (m.freeMarket && Number.isFinite(n.freeRiskCap))
    budget = Math.min(budget, own * n.freeRiskCap);
  if (budget <= 0) return 0;

  let units = m.curve.unitsFor(budget, P);
  if (units <= 0) return 0;

  const impact = Math.abs(m.curve.clearingPrice(m.Q, dir * units) - P) / P;
  const roundTrip = impact * 2;
  const tilt = n.losses >= 3 && r() < CONFIG.NPC_TILT;   // сделка на эмоциях
  if (strength < roundTrip * CONFIG.NPC_EDGE_MULT && !tilt) {
    // Игра не стоит свеч в этом размере. Сдвиг цены растёт вместе с объёмом,
    // поэтому вместо отказа бот УМЕНЬШАЕТ ставку до той, что окупается.
    // Отказ остаётся только когда осмысленного размера не существует —
    // так крупный участник не парализует сам себя.
    const scale = strength / Math.max(1e-9, roundTrip * CONFIG.NPC_EDGE_MULT);
    if (scale < 0.05) { n.cooldown = Math.round(n.patience * 0.5); return 0; }
    units *= Math.max(scale, 0.05);
    budget *= Math.max(scale, 0.05);
  }
  if (budget < stake * 0.01) return 0;   // мелочь не стоит комиссии внимания

  n.entryEquity = equity;
  if (n.usesOrders) {
    const st = Math.abs(n.stop), tk = Math.abs(n.take);
    pl.stopLoss = dir > 0 ? P * (1 - st) : P * (1 + st);
    pl.takeProfit = dir > 0 ? P * (1 + tk) : P * (1 - tk);
  } else {
    pl.stopLoss = null; pl.takeProfit = null;
  }
  return dir > 0 ? units : -units;
}

/**
 * ЧАСТОТА СДЕЛОК. Раньше бот пересматривал позицию каждый тик, и 96% всех
 * сделок приходилось на доливки, частичные фиксации и досрочные выходы —
 * получалось 33 сделки на бота в минуту. Живой человек за минутную сессию
 * делает 3-5 входов.
 *
 * Теперь у каждого бота есть собственный минимальный интервал между
 * действиями: скальпер шевелится раз в пару секунд, долгосрочный — раз в
 * полминуты. Интервал не распространяется на жёсткий риск: стоп, тейк,
 * маржин-колл и разгрузку перед закрытием комнаты, иначе бот не смог бы
 * защитить деньги.
 */
function decide(m, i, history) {
  const pl = m.players[i], n = pl.npc;
  if (!n) return 0;

  // Участник уже решил уйти из бессрочного рынка. Пока его позиция
  // закрывается через приоритетный free-retire, новых входов/доливок нет.
  if (m.freeMarket && n.retireRequested) return 0;

  syncNPCState(m, i);
  const gap = m.tick - (n.lastTrade ?? -1e9);

  /* decideRaw содержит часть "намеренных" мутаций: close(), новый SL/TP,
     расширение тейка, cooldown после отказа и т.п. Если обычное решение
     запрещено minGap, эти изменения тоже не должны происходить.
     Снимок берётся ПОСЛЕ syncNPCState, поэтому реальное внешнее закрытие
     (stop/take) и течение cooldown не откатываются. */
  const snap = {};
  for (const k of Object.keys(n)) if (k !== "rng" && k !== "spec") snap[k] = n[k];
  const prevSL = pl.stopLoss, prevTP = pl.takeProfit;

  const du = decideRaw(m, i, history);
  if (du === 0) return 0;
  if (gap < n.minGap && !n.urgent) {
    for (const k of Object.keys(n)) {
      if (k !== "rng" && k !== "spec" && !(k in snap)) delete n[k];
    }
    for (const [k, v] of Object.entries(snap)) n[k] = v;
    pl.stopLoss = prevSL; pl.takeProfit = prevTP;
    return 0;
  }
  n.urgent = false;
  n.lastTrade = m.tick;
  return du;
}

/**
 * Закрытие сделки: бот записывает, сколько на ней заработал, и назначает
 * себе паузу. Именно эта запись потом решает, продолжать ли следовать
 * своей стратегии.
 */
function close(n, win, equity) {
  const gain = n.entryEquity ? (equity - n.entryEquity) / Math.max(1e-9, n.entryEquity) : 0;
  n.edge = n.edge * 0.8 + gain * 0.2;
  n.trades++;
  n.losses = gain < 0 ? n.losses + 1 : 0;
  n.cooldown = Math.round(n.patience * (gain < 0 ? 1.6 : 0.6));
  n.take = n.spec.take * CONFIG.NPC_PNL_SCALE;   // сброс раздвинутой цели
  n.entryEquity = null;                          // сделка записана ровно один раз
  note(n, win);
}

/**
 * Настроение бота: скользящее среднее исходов сделок, где выигрыш +1,
 * проигрыш −1. Из него получается множитель размера.
 *
 * Прежняя версия была мультипликативным храповиком (×1.10 на прибыль,
 * ×0.72 на убыток) и неизбежно съезжала вниз: рынок с нулевой суммой даёт
 * убыточных сделок больше, чем прибыльных, и через 300 тиков средняя
 * уверенность падала до 0.42 при полу 0.25. Боты продолжали торговать,
 * но объёмом в два-три раза меньше — на графике это выглядело как
 * умерший рынок с крошечными свечами.
 */
function note(n, win) {
  n.mood = (n.mood ?? 0) * 0.75 + (win ? 0.25 : -0.25);
  n.conviction = Math.min(1.6, Math.max(0.45, 1 + 0.6 * n.mood));
}

function npcIntents(m, history, fromIdx) {
  const out = [];
  const start = Math.max(0, fromIdx || 0);
  const total = m.players.length - start;
  const batch = Math.max(0, Math.min(total, m.npcBatchSize || total));

  // Обычные комнаты по-прежнему проверяют всех NPC каждый тик. Свободный
  // рынок держит 5 000 реальных объектов-ботов, но распределяет их решения
  // по тикам. При batch=160 каждый бот переоценивает рынок примерно раз в
  // 3.1 секунды при tick=100 мс — это сохраняет разнообразие стратегий и
  // не заставляет телефон выполнять 50 000 тяжёлых решений в секунду.
  if (batch >= total) {
    for (let i = start; i < m.players.length; i++) {
      if (!m.players[i].npc) continue;
      const du = decide(m, i, history);
      if (Math.abs(du) > 1e-12) out.push({ i, du, reason: "npc" });
    }
    return out;
  }

  let cursor = Number.isFinite(m.npcCursor) ? m.npcCursor : start;
  if (cursor < start || cursor >= m.players.length) cursor = start;
  let seen = 0;
  while (seen < batch) {
    const i = cursor;
    cursor++;
    if (cursor >= m.players.length) cursor = start;
    seen++;
    if (!m.players[i]?.npc) continue;
    const du = decide(m, i, history);
    if (Math.abs(du) > 1e-12) out.push({ i, du, reason: "npc" });
  }
  m.npcCursor = cursor;
  return out;
}

// ---- orders.js ----
/**
 * Преобразование пользовательских команд и отложенных ордеров в НАМЕРЕНИЯ тика.
 * Никакой ордер не исполняется здесь — только в Market.clear(), по единой цене.
 * Поэтому массовое срабатывание стопов не даёт преимущества по порядку.
 */
function availableBuyingPower(m, i) {
  const pl = m.players[i];
  if (!pl) return 0;
  return Math.max(0, m.buyingPower(i));
}

function exposureNeed(pl, action, notional) {
  const dir = action === "BUY" ? 1 : -1;
  const after = pl.u + dir * notional;
  return Math.max(0, Math.abs(after) - Math.abs(pl.u));
}

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
      const need = exposureNeed(pl, cmd.action, n);
      if (need > availableBuyingPower(m, i) + 1e-9)
        return { ok: false, reason: "недостаточно свободных средств" };
      return { ok: true };
    }
    case "PROTECT": {
      if (pl.u === 0) return { ok: false, reason: "нет открытой позиции" };
      return { ok: true };
    }
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

/** Защитные уровни: стоп/тейк -> намерения. Проверяются по mark ПЕРЕД клирингом. */
function pendingIntents(m) {
  const out = [];
  const P = m.mark;
  // В свободном рынке этот проход всё равно нужен для SL/TP всех
  // 5 000 ботов. Заодно собираем агрегаты книги и переиспользуем их в
  // depth/crowd, чтобы не сканировать весь массив ещё 2–3 раза за тик.
  let freeL = 0, freeS = 0, freeLBasis = 0, freeSBasis = 0, freeEscrow = 0;
  let freeLeaderPnL = -Infinity, freeLeaderSide = 0;
  for (const pl of m.players) {
    if (m.freeMarket && pl.u !== 0) {
      freeEscrow += Math.abs(pl.u);
      if (pl.u > 0) { freeL++; freeLBasis += pl.basis; }
      else { freeS++; freeSBasis += pl.basis; }
      if (pl.realizedPnL > freeLeaderPnL) {
        freeLeaderPnL = pl.realizedPnL; freeLeaderSide = Math.sign(pl.u);
      }
    }
    // Уходящий бот закрывается приоритетно. Новый участник появится только
    // после того, как старый полностью вышел из позиции.
    if (m.freeMarket && pl.npc?.retireRequested && pl.u !== 0) {
      out.push({ i: pl.id, du: -pl.u, reason: "free-retire" });
      continue;
    }
    if (pl.u !== 0 && pl.entryPrice !== null) {
      const long = pl.u > 0;
      if (pl.stopLoss !== null &&
          ((long && P <= pl.stopLoss) || (!long && P >= pl.stopLoss)))
        out.push({ i: pl.id, du: -pl.u, reason: "stop" });
      else if (pl.takeProfit !== null &&
          ((long && P >= pl.takeProfit) || (!long && P <= pl.takeProfit)))
        out.push({ i: pl.id, du: -pl.u, reason: "take" });
    }
  }
  if (m.freeMarket) {
    m._freePreStats = {
      longPlayers: freeL, shortPlayers: freeS,
      longBasis: freeLBasis, shortBasis: freeSBasis,
      escrow: freeEscrow, leaderSide: freeLeaderSide, leaderPnL: freeLeaderPnL,
    };
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
  if (viewer) { out.stopLoss = pl.stopLoss; out.takeProfit = pl.takeProfit; }
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
  if (level === "roster" || level === "full") {   // "you" — только свой срез
    snap.participants = m.players.map((p) =>
      projectPlayer(m, p, { viewer: false, devMode }));
  }
  /* Скрытый центр отдаётся ТОЛЬКО в режиме отладки. В обычной игре его нет
     ни в одном поле снапшота — иначе стратегия «торгуй возврат к центру»
     снова становится беспроигрышной. */
  if (devMode) snap.debug = { sumEquity: m.sumEquity(), center: m.center };
  return snap;
}

// ---- room.js ----

/**
 * ROOM — цикл тика. Порядок фиксирован и одинаков для всех:
 *   1. собрать защитные уровни (стоп/тейк)
 *   2. собрать намерения NPC
 *   3. собрать команды людей, поступившие с прошлого тика
 *   4. ОДИН клиринг: единая цена для всех
 *   5. проверить инварианты; при нарушении — HALT
 *
 * Люди и NPC ничем не отличаются на шаге 4. Порядок внутри шагов не влияет
 * на результат (доказано: обрезка зависит только от P* и своего состояния).
 */
class RoomV4 {
  constructor({ playerCount = 100, startingCapital = 100, seed = 1, npcCount = null,
    leverage = 1, durationTicks = null, warmupTicks = 0,
    prerollTicks = null } = {}) {
    this.market = new Market({ playerCount, startingCapital, seed, leverage });
    this.market.totalTicks = durationTicks;
    this.market.warmupTicks = warmupTicks;
    this.history = [this.market.mark];
    this.pendingCommands = [];
    this.humanSlots = new Set();
    this.halted = null;
    this._inPreroll = false;
    this.liveSteps = 0;
    const npcs = npcCount === null ? playerCount : npcCount;
    if (npcs > 0) attachNPCs(this.market, playerCount - npcs, npcs, seed);
    /* ПРЕДВАРИТЕЛЬНЫЙ ПРОГОН. Без него сессия начиналась бы ровно в скрытом
       центре, и он читался бы прямо со стартовой цены. Боты торгуют заранее,
       цена уходит в сторону, и к моменту входа игрока центр по графику не
       восстанавливается. Слот человека (без бота) прогон не затрагивает, его
       деньги остаются нетронутыми. */
    const pre = prerollTicks === null ? CONFIG.PREROLL_TICKS : prerollTicks;
    if (npcs > 0 && pre > 0) {
      const savedWarmup = this.market.warmupTicks;
      const savedTotalTicks = this.market.totalTicks;
      /* Preroll существует ДО сессии, поэтому боты не должны видеть ни её
         длительность, ни endgame/flush. Один seed теперь даёт одинаковый
         старт независимо от выбранных 1/5/10/30 минут. */
      this.market.warmupTicks = 0;
      this.market.totalTicks = null;
      this._inPreroll = true;
      for (let t = 0; t < pre && !this.halted; t++) this.step();
      this._inPreroll = false;
      this.market.warmupTicks = savedWarmup;
      this.market.totalTicks = savedTotalTicks;
      /* Счётчик тиков сбрасывается — значит надо сдвинуть и всё, что на него
         завязано. Без этого поле lastTrade у ботов оставалось равным ~400,
         а m.tick снова становился нулём: разница выходила отрицательной,
         пауза между сделками никогда не набиралась, и первые 33 секунды
         сессии рынок стоял мёртвый. Именно это выглядело как «боты тупят». */
      /* Каждому боту назначается свой момент первой сделки после открытия,
         разбросанный по первым CONFIG.OPEN_SPREAD тикам. Без этого все они
         становились готовы ровно в тик открытия и били одним залпом: при
         500 участниках это давало скачок цены до 10% за один тик — снова
         свеча во весь экран. */
      const w = this.market.warmupTicks;
      for (const p of this.market.players) {
        if (!p.npc) continue;
        p.npc.lastTrade = w - p.npc.minGap + Math.floor(this.market.rng() * CONFIG.OPEN_SPREAD);
      }
      this.market.tick = 0;
      this.market.phase = null;
      /* На графике остаётся только хвост прогона. Показывать его целиком
         нельзя: первая точка истории — это и есть скрытый центр. */
      this.history = this.history.slice(-CONFIG.PREROLL_KEEP);
      this.liveSteps = 0;
    }
  }

  /** Подготовить чистый человеческий слот, не создавая/уничтожая деньги. */
  _normalizeHumanSlot(slot, name) {
    const m = this.market;
    const oldEquity = m.equity(slot.id);
    const target = m.startingCapital;
    const correction = oldEquity - target; // столько надо вернуть остальным

    const others = m.players.filter((p) => p.id !== slot.id && !p.isHuman);
    if (correction > 1e-9 && others.length) {
      const share = correction / others.length;
      for (const p of others) p.cash += share;
    } else if (correction < -1e-9) {
      let need = -correction;
      let donors = others.filter((p) => p.cash > 1e-9);
      while (need > 1e-9 && donors.length) {
        const free = donors.reduce((a, p) => a + Math.max(0, p.cash), 0);
        if (free <= 1e-9) break;
        const takeNow = Math.min(need, free);
        for (const p of donors) {
          const take = takeNow * (Math.max(0, p.cash) / free);
          p.cash -= take;
        }
        need -= takeNow;
        donors = donors.filter((p) => p.cash > 1e-9);
      }
      if (need > 1e-6) return false;
    }

    slot.cash = target;
    slot.u = 0;
    slot.entryPrice = null;
    slot.invested = 0;
    slot.basis = 0;
    slot.realizedPnL = 0;
    slot.tradeCount = 0;
    slot.stopLoss = null;
    slot.takeProfit = null;
    slot.liquidatedAt = null;
    slot.npc = null;
    slot.isHuman = true;
    slot.name = name;
    return true;
  }

  /** Люди входят только до открытия и всегда получают чистый стартовый счёт. */
  join(name) {
    const m = this.market;
    if (this.liveSteps > 0 && m.tick >= m.warmupTicks) return null;

    const slot = m.players.find((p) => !p.npc && !p.isHuman)
      || m.players.find((p) => p.npc && !p.isHuman);
    if (!slot) return null;
    if (!this._normalizeHumanSlot(slot, name)) return null;

    this.humanSlots.add(slot.id);
    let L = 0, S = 0;
    for (const p of m.players) { if (p.u > 0) L++; else if (p.u < 0) S++; }
    m.crowd = L + S > 0 ? (L - S) / (L + S) : 0;
    const sides = m.sidesBasis();
    m.crowdMoney = sides.L + sides.S > 0
      ? (sides.L - sides.S) / (sides.L + sides.S) : 0;
    const inv = checkInvariants(m, { join: slot.id });
    if (!inv.ok) { this.halted = inv.report; return null; }
    return slot.id;
  }

  send(playerId, cmd) {
    /* До открытия рынок полностью закрыт для торговли. Это правило
       проверяется в движке, а не только в интерфейсе. */
    const m = this.market;
    if (m.tick < m.warmupTicks && cmd?.type === "TRADE") {
      return { ok: false, reason: "рынок ещё не открыт" };
    }
    const v = validateCommand(this.market, playerId, cmd);
    if (!v.ok) return v;
    if (cmd.type === "PROTECT") {
      const pl = this.market.players[playerId];
      if (cmd.clear === "sl") pl.stopLoss = null;
      else if (cmd.clear === "tp") pl.takeProfit = null;
      else if (cmd.clear === true || cmd.clear === "all") {
        pl.stopLoss = null; pl.takeProfit = null;
      }
      if (Number.isFinite(cmd.stopLoss)) pl.stopLoss = cmd.stopLoss;
      if (Number.isFinite(cmd.takeProfit)) pl.takeProfit = cmd.takeProfit;
      return { ok: true };
    }
    this.pendingCommands.push({ i: playerId, cmd });
    return { ok: true };
  }

  step(extraIntents = []) {
    if (this.halted) return this.halted;
    const m = this.market;
    if (!this._inPreroll) this.liveSteps++;
    // Фаза сессии обновляется до решений ботов: они смотрят на неё так же,
    // как на цену.
    // Разогрев не входит в сессию: фаза начинает считаться после открытия.
    m.phase = m.totalTicks
      ? clamp((m.tick - m.warmupTicks) / m.totalTicks, 0, 1) : null;

    /* ------------------------- ПРЕДТОРГОВЫЙ ПЕРИОД ----------------------
       Клиринга нет, Q не меняется, цена стоит. Рыночные сделки до открытия
       не принимаются. */
    if (m.tick < m.warmupTicks) {
      this.pendingCommands = [];
      m.tick++;
      this.history.push(m.mark);
      return { executed: [], price: m.mark, warmup: true };
    }

    m.accrueBorrowCost();

    // Бессрочный рынок не может состоять из одного и того же замороженного
    // населения вечно. Небольшими порциями выводим истощённые/старые счета
    // и заводим новых ботов, сохраняя ровно 5 000 NPC без массовых скачков.
    if (m.freeMarket && typeof m.freeMarketLifecycle === "function") m.freeMarketLifecycle(m);

    const intents = [];
    // Маржин-колл идёт ПЕРВЫМ и в том же клиринге, что и всё остальное:
    // единая цена тика не даёт ликвидируемым проскочить раньше других.
    intents.push(...m.marginCalls());
    if (extraIntents && extraIntents.length) intents.push(...extraIntents);
    intents.push(...pendingIntents(m));
    intents.push(...npcIntents(m, this.history, 0));
    for (const { i, cmd } of this.pendingCommands) {
      const it = commandToIntent(m, i, cmd);
      if (it) intents.push(it);
    }
    this.pendingCommands = [];

    const result = m.clear(intents);
    // Для 5 000 NPC повторный полный обход после клиринга слишком дорог.
    // pendingIntents уже собрал состояние книги перед этим тиком; задержка
    // crowd-сигнала на один тик = 100 мс и не даёт ботам дополнительной
    // информации, зато убирает два полных прохода по 5 001 участнику.
    if (m.freeMarket && m._freePreStats) {
      const s = m._freePreStats;
      const N = s.longPlayers + s.shortPlayers;
      m.crowd = N > 0 ? (s.longPlayers - s.shortPlayers) / N : 0;
      const B = s.longBasis + s.shortBasis;
      m.crowdMoney = B > 0 ? (s.longBasis - s.shortBasis) / B : 0;
    } else {
      let L = 0, S = 0;
      for (const p of m.players) { if (p.u > 0) L++; else if (p.u < 0) S++; }
      m.crowd = L + S > 0 ? (L - S) / (L + S) : 0;
      const sd = m.sidesBasis();
      m.crowdMoney = sd.L + sd.S > 0 ? (sd.L - sd.S) / (sd.L + sd.S) : 0;
    }
    this.history.push(m.mark);
    if (m.freeMarket) {
      if (this.history.length > 5200) this.history.splice(0, 200);
    } else if (this.history.length > 5000) {
      this.history.shift();
    }

    const every = Math.max(1, m.invariantEvery || 1);
    if (m.tick % every === 0) {
      const inv = checkInvariants(m, { intents: intents.length });
      if (!inv.ok) { this.halted = inv.report; return inv.report; }
    }
    return result;
  }

  advance(n) { for (let k = 0; k < n && !this.halted; k++) this.step(); return this; }
  snapshot(viewerId, opts) { return createSnapshot(this.market, viewerId, opts); }

  /** Закрыть позицию и выйти из комнаты со штрафом.
      Закрытие проходит полноценным тиком комнаты: tick, history, NPC
      и инварианты остаются синхронными. */
  leave(playerId, penaltyFraction) {
    const m = this.market;
    if (m.players[playerId].u !== 0) {
      this.step([{ i: playerId, du: -m.players[playerId].u, reason: "leave" }]);
    }
    return m.applyExitPenalty(playerId, penaltyFraction);
  }
}


export { makeCurve, Market, checkInvariants, clamp, mulberry32, ARCHETYPES, TYPES, makeNPCState, attachNPCs, availableBuyingPower, projectPlayer, createSnapshot, RoomV4 };

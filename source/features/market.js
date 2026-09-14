import { CONFIG } from "../core/config.js";
import { RoomV4, makeCurve, checkInvariants, mulberry32, ARCHETYPES, TYPES, makeNPCState, attachNPCs, availableBuyingPower, projectPlayer, clamp } from "../core/engine.js";
import { parseMoneyInput } from "../core/money.js";

/* ============================== EYES ======================================
   ИНФОРМАЦИОННЫЙ СЛОЙ. Ничего не создаёт и ничего не меняет в движке:
   только читает уже существующие поля pl.stopLoss / pl.takeProfit и позиции
   участников и сворачивает их в обезличенные кластеры.

   Источник данных — те же заявки, что исполняет pendingIntents() в общем
   клиринге. Никаких фиктивных заявок, никакого параллельного рынка.

   Личности не раскрываются: наружу уходят только тип, сторона, диапазон
   цены, суммарный объём и число участников.
   ------------------------------------------------------------------------ */
const EYES_BAND = 0.002;        // 0.2% цены — шаг сетки для устойчивого id
const EYES_GAP = 0.0035;        // разрыв, по которому кластер делится
const EYES_HISTORY = 40;        // сколько исчезнувших зон помним
const EYES_HISTORY_MS = 180000; // и как долго

class EyesLayer {
  constructor() {
    this.state = new Map();     // key -> живой кластер с историей объёма
    this.history = [];
    this.live = [];
    this.totals = { stopFlow: 0, takeFlow: 0, clusters: 0 };
  }

  /**
   * Пересчёт за тик. Вызывается ОДИН раз из step(), результат кэшируется —
   * снапшот его только отдаёт. Сложность O(n log n) по числу заявок.
   */
  update(market, executed, now) {
    const P = market.mark;
    const raw = [];
    for (const pl of market.players) {
      if (pl.u === 0 || pl.entryPrice === null) continue;
      const side = pl.u > 0 ? "LONG" : "SHORT";
      const volume = market.curve.value(pl.u, P);
      if (pl.stopLoss !== null) raw.push({ type: "STOP", side, price: pl.stopLoss, volume });
      if (pl.takeProfit !== null) raw.push({ type: "TAKE", side, price: pl.takeProfit, volume });
    }

    // --- кластеризация: сортировка и разрез по ценовому разрыву ---
    const groups = new Map();
    for (const o of raw) {
      const k = `${o.type}|${o.side}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }

    const seen = new Set();
    const live = [];
    for (const [k, list] of groups) {
      list.sort((a, b) => a.price - b.price);
      const [type, side] = k.split("|");
      let cur = null;
      const flush = () => {
        if (!cur) return;
        const mid = (cur.min + cur.max) / 2;
        const key = `${k}|${Math.round(mid / (P * EYES_BAND))}`;
        seen.add(key);
        live.push({ key, type, side, min: cur.min, max: cur.max,
          volume: cur.volume, participants: cur.n });
        cur = null;
      };
      for (const o of list) {
        if (cur && o.price - cur.max > P * EYES_GAP) flush();
        if (!cur) cur = { min: o.price, max: o.price, volume: 0, n: 0 };
        cur.max = o.price;
        cur.volume += o.volume;
        cur.n++;
      }
      flush();
    }

    // --- сопоставление с предыдущим состоянием: возраст и истончение ---
    for (const c of live) {
      const prev = this.state.get(c.key);
      if (prev) {
        c.createdAt = prev.createdAt;
        c.peak = Math.max(prev.peak, c.volume);
        c.trail = prev.volume !== c.volume
          ? [...prev.trail, c.volume].slice(-6) : prev.trail;
      } else {
        c.createdAt = now; c.peak = c.volume; c.trail = [c.volume];
      }
      c.age = now - c.createdAt;
      c.status = c.age < 4000 ? "NEW"
        : c.volume < c.peak * 0.7 ? "THINNING"
        : "ACTIVE";
      c.lastUpdatedAt = now;
      this.state.set(c.key, c);
    }

    // --- исчезнувшие: сработали или сняты ---
    const fired = new Set();
    for (const e of executed || []) {
      if (e.reason === "stop") fired.add("STOP");
      if (e.reason === "take") fired.add("TAKE");
    }
    for (const [key, prev] of this.state) {
      if (seen.has(key)) continue;
      const touched = P >= prev.min - P * EYES_GAP && P <= prev.max + P * EYES_GAP;
      this.history.unshift({
        key, type: prev.type, side: prev.side, min: prev.min, max: prev.max,
        volume: prev.peak, participants: prev.participants,
        trail: [...prev.trail, 0].slice(-6),
        status: touched && fired.has(prev.type) ? "TRIGGERED" : "REMOVED",
        at: now, age: now - prev.createdAt,
      });
      this.state.delete(key);
    }
    this.history = this.history
      .filter((h) => now - h.at < EYES_HISTORY_MS)
      .slice(0, EYES_HISTORY);

    live.sort((a, b) => b.volume - a.volume);
    this.live = live;
    this.totals = {
      stopFlow: live.filter((c) => c.type === "STOP").reduce((a, c) => a + c.volume, 0),
      takeFlow: live.filter((c) => c.type === "TAKE").reduce((a, c) => a + c.volume, 0),
      clusters: live.length,
      stopClusters: live.filter((c) => c.type === "STOP").length,
      takeClusters: live.filter((c) => c.type === "TAKE").length,
      participants: live.reduce((a, c) => a + c.participants, 0),
    };
  }

  /** Слепок для снапшота. Без каких-либо идентификаторов участников. */
  view() {
    return { live: this.live, history: this.history, totals: this.totals };
  }
}

class LegacyRoom {
  constructor({ startingCapital = 100, seed = 1, devMode = true, playerCount,
    leverage = 1, eyes = false, durationTicks = null,
    warmupTicks = CONFIG.market.warmupTicks } = {}) {
    const count = playerCount || CONFIG.market.totalPlayers;
    this.leverage = leverage;
    this.eyesMode = eyes;
    /* Длительность сессии в тиках. Нужна ботам: в закрытой комнате с общим
       таймером время — такой же фактор, как цена. null = бессрочная сессия,
       тогда фаза не считается и поведение прежнее. */
    this.totalTicks = null;
    this.phase = null;      // 0 в начале, 1 в конце
    /* Разогрев — только закрытый обратный отсчёт перед стартом.
       Цена и позиции в эти тики не меняются; история рынка уже сформирована
       отдельным preroll до появления игрока. */
    this.warmupTicks = 0;
    this.eyes = eyes ? new EyesLayer() : null;
    this._room = new RoomV4({ playerCount: count, startingCapital, seed,
      npcCount: count - 1, leverage, durationTicks, warmupTicks });
    this.devMode = devMode;
    this._startingCapital = startingCapital;
    this.paused = false;
    this._buyPressure = 0;
    this._sellPressure = 0;
    this._buyTotal = 0;      // накопленный оборот покупок за всю сессию
    this._sellTotal = 0;     // накопленный оборот продаж за всю сессию
    this._totalTrades = 0;
    /* ВРЕМЯ ТОЧЕК ПРОГОНА — ОТРИЦАТЕЛЬНОЕ.
       Счётчик тиков после предварительного прогона сбрасывается в ноль, и
       точки сессии начинали идти с t = 0 поверх точек прогона, у которых
       время было 0…14900 мс. Две ленты накладывались друг на друга, свечи
       собирались из перемешанных точек — на экране получался тот самый
       блок из наложенных друг на друга свечей посреди графика.
       Теперь последняя точка прогона имеет t = 0, а сессия продолжает
       её вперёд, и лента остаётся монотонной. */
    this._priceHistory = this._room.history.map((price, i, arr) => ({
      price, t: (i - (arr.length - 1)) * CONFIG.market.tickMs, volume: 0,
    }));
    this._openPrice = null;
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
    // EYES пересчитывается ровно один раз за тик и только читает рынок.
    if (this.eyes) {
      const m = this._room.market;
      this.eyes.update(m, result && result.executed, m.tick * CONFIG.market.tickMs);
    }
    let buy = 0, sell = 0;
    if (result && result.executed) {
      for (const e of result.executed) {
        // В MODEL-S du уже выражен в деньгах. Умножение на цену завышало
        // объём и buy/sell pressure примерно в 100 раз.
        const notional = Math.abs(e.du);
        if (e.du > 0) buy += notional; else sell += notional;
      }
      this._totalTrades += result.executed.length;
    }
    this._buyPressure = buy;
    this._sellPressure = sell;
    this._buyTotal += buy;
    this._sellTotal += sell;
    if (this._openPrice === null &&
        this._room.market.tick >= this._room.market.warmupTicks)
      this._openPrice = this._room.market.mark;
    this._priceHistory.push({
      price: this._room.market.mark,
      t: this._room.market.tick * CONFIG.market.tickMs,
      volume: buy + sell,   // оборот тика — высота столбика объёма на графике
    });
    if (this._priceHistory.length > 6000) this._priceHistory.shift();
    return result;
  }

  send(playerId, cmd) { return this._room.send(playerId, cmd); }
  /** Досрочный выход человека: закрыть позицию и заплатить штраф. */
  leave(playerId, fraction) { return this._room.leave(playerId, fraction); }

  snapshotFor(viewerId) {
    /* Полный список участников пересобирается раз в несколько тиков.
       Раньше на КАЖДОМ тике создавалось по два объекта на участника
       (projectPlayer + _legacyPlayer): при 100 игроках это 2000 объектов
       в секунду, при 500 — 10 000, и телефон захлёбывался на сборке
       мусора. Экраны «Участники» и счётчики сторон от обновления раз в
       треть секунды не страдают. */
    const tick = this._room.market.tick;
    const fresh = !this._cache || tick - this._cache.tick >= LegacyRoom.ROSTER_EVERY;
    const base = fresh
      ? this._room.snapshot(viewerId, { level: "full", devMode: this.devMode })
      : { ...this._room.snapshot(viewerId, { level: "you", devMode: this.devMode }),
          participants: this._cache.participants };
    if (fresh) this._cache = { tick, participants: base.participants,
      players: (base.participants || []).map((p) => this._legacyPlayer(p)) };
    const players = this._cache.players;
    return {
      ...base,
      players,
      you: base.you ? {
        ...this._legacyPlayer(base.you),
        marginLevel: this._room.market.marginLevel(viewerId),
        liquidationPrice: this._room.market.liquidationEstimate(viewerId),
        buyingPower: availableBuyingPower(this._room.market, viewerId),
        wasLiquidated: this._room.market.players[viewerId].liquidatedAt !== null,
      } : null,
      buyPressure: this._buyPressure,
      sellPressure: this._sellPressure,
      netPressure: this._buyPressure - this._sellPressure,
      buyTotal: this._buyTotal,
      sellTotal: this._sellTotal,
      netTotal: this._buyTotal - this._sellTotal,
      longRealized: this._room.market.longRealized,
      shortRealized: this._room.market.shortRealized,
      eyes: this.eyes ? this.eyes.view() : null,
      eyesMode: this.eyesMode,
      // Именно sessionPhase: поле phase в снапшоте уже занято словесной
      // характеристикой рынка («стабильно», «разгон»).
      sessionPhase: this._room.market.phase,
      warmupLeft: Math.max(0, this._room.market.warmupTicks - this._room.market.tick),
      tradingOpen: this._room.market.tick >= this._room.market.warmupTicks,
      leverage: this._room.market.leverage,
      maintenance: this._room.market.maintenance,
      liquidations: this._room.market.liquidations,
      totalTrades: this._totalTrades,
      totalPlayers: this._room.market.players.length,
      priceHistory: this._priceHistory,
      lastPoint: this._priceHistory[this._priceHistory.length - 1],
      market: { ...this._aggregate(base.participants || []), poolEquity: base.escrow },
      price: this._room.market.mark,
      previousPrice: this._priceHistory.length >= 2
        ? this._priceHistory[this._priceHistory.length - 2].price
        : this._room.market.mark,
      /* Цена на момент открытия рынка, а не константа P0: точка равновесия
         у каждой сессии своя и игроку не сообщается. */
      initialPrice: this._openPrice ?? this._room.market.mark,
      rank: this._rank(viewerId, base.participants || []),
      // "ликвидность" старого движка ~ параметр глубины кривой Q нового
      liquidity: base.Q,
      phase: this._phase(base),
      context: this._context(base),
    };
  }

  /** Показатели режима рынка. Раньше они существовали только в отчёте HALT,
   *  поэтому во вкладке отладки всегда стояли нули. */
  _context(base) {
    const h = this._priceHistory;
    const n = h.length;
    const at = (k) => h[Math.max(0, n - 1 - k)].price;
    const now = at(0);

    // Волатильность: среднеквадратичная доходность за последние 40 тиков.
    const win = Math.min(40, n - 1);
    let sum = 0, sum2 = 0;
    for (let k = 0; k < win; k++) {
      const r = (at(k) - at(k + 1)) / Math.max(at(k + 1), 1e-9);
      sum += r; sum2 += r * r;
    }
    const mean = win ? sum / win : 0;
    const volatility = win ? Math.sqrt(Math.max(0, sum2 / win - mean * mean)) : 0;

    // Перекос толпы: доля капитала в лонгах против шортов.
    const parts = base.participants || [];
    let L = 0, S = 0;
    for (const p of parts) {
      if (!p.position) continue;
      if (p.position.side === "long") L += p.position.invested;
      else S += p.position.invested;
    }
    const imbalance = L + S > 0 ? (L - S) / (L + S) : 0;

    return {
      speed: n > 10 ? (now - at(10)) / Math.max(at(10), 1e-9) : 0,
      volatility,
      imbalance,
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
      // В MODEL-S нет фиксированного количества токенов; корректный денежный
      // масштаб комнаты — суммарное equity участников.
      marketCap: totalEquity,
      longShare: directional === 0 ? 0 : longPlayers / directional,
      shortShare: directional === 0 ? 0 : shortPlayers / directional,
    };
  }
}


/* Как часто пересобирается список участников, в тиках. 3 тика = 0.3 с. */
LegacyRoom.ROSTER_EVERY = 3;

// Старый интерфейс ожидает класс "Room" со старым API — LegacyRoom это и есть.
const Room = LegacyRoom;

/* ============================ СВОБОДНЫЙ РЫНОК =============================
   Отдельная ветка движка. Это НЕ комната и не длинная сессия:
   - нет таймера и warmup;
   - 5 000 NPC существуют одновременно;
   - у каждого свой стартовый капитал $10…$10 000;
   - бот использует собственный капитал для размера позиции и порогов риска;
   - тяжёлые решения NPC распределяются по тикам, а риск-ордера проверяются
     каждый тик для всех игроков.

   Локальная версия создаёт уже "живой" рынок через preroll при входе.
   Настоящая непрерывность между устройствами/пользователями будет серверным
   этапом: один authoritative FreeMarketRoom вместо отдельного экземпляра в
   каждом браузере. Математика ниже для этого уже отделена от UI.
   ========================================================================== */
const FREE_MARKET = {
  botCount: 5000,
  minCapital: 10,
  maxCapital: 10000,
  npcBatchSize: 160,
  prerollTicks: 500,
  snapshotEvery: 5,          // тяжёлые агрегаты — 2 раза/с
  uiSnapshotMs: 200,         // React получает 5 кадров/с, движок тикает 10/с
  invariantEvery: 10,        // полный аудит 5 001 счёта раз в секунду
  rosterSample: 120,
  historyLimit: 36000,        // 1 час raw-истории при тике 100 мс
  historyTrimChunk: 2000,    // режем редко и пачкой, а не shift() каждый тик
  lifecycleEvery: 50,        // каждые 5 секунд — лёгкий проход за ротацией
  lifecycleMaxPerPass: 8,    // не больше 8 замен за раз, без массового шока
  retireMinTicks: 9000,      // естественная жизнь бота: от ~15 минут
  retireMaxTicks: 54000,     // до ~90 минут
  distressFraction: 0.035,   // <3.5% исходного счёта — участник уходит
};

// В free-market нет заведомо «inactive»: все пять тысяч — участники,
// способные торговать. Долгосрочные остаются медленными, но не выключенными.
const FREE_TYPES = TYPES.filter((t) => t !== "inactive");

const FREE_TIERS = [
  { key: "micro",  max: 100,      risk: [0.72, 0.95], act: 1.18, gap: 0.72, look: 0.78, hold: 0.82, orders: 0.34 },
  { key: "retail", max: 1000,     risk: [0.58, 0.82], act: 1.05, gap: 0.95, look: 0.95, hold: 1.00, orders: 0.46 },
  { key: "pro",    max: 5000,     risk: [0.42, 0.64], act: 0.86, gap: 1.18, look: 1.22, hold: 1.24, orders: 0.62 },
  { key: "whale",  max: Infinity, risk: [0.24, 0.42], act: 0.66, gap: 1.48, look: 1.55, hold: 1.52, orders: 0.78 },
];

function freeTierFor(capital) {
  return FREE_TIERS.find((t) => capital < t.max) || FREE_TIERS[FREE_TIERS.length - 1];
}

function freeBotCapital(r) {
  // Явные слои населения. Малых счетов много, крупных мало; при этом
  // диапазон $10…$10k используется весь, а не только середина.
  const u = r();
  let lo, hi;
  if (u < 0.40) { lo = 10; hi = 100; }
  else if (u < 0.75) { lo = 100; hi = 1000; }
  else if (u < 0.95) { lo = 1000; hi = 5000; }
  else { lo = 5000; hi = 10000; }
  return Math.round(lo * Math.pow(hi / lo, r()));
}

function applyFreePersonality(p, r, tick = 0, generation = 0) {
  const n = p.npc;
  if (!n) return;
  const tier = freeTierFor(p.startingCapital || p.cash || FREE_MARKET.minCapital);
  const risk = tier.risk[0] + r() * (tier.risk[1] - tier.risk[0]);
  n.freeTier = tier.key;
  n.freeRiskCap = risk;
  n.freeGeneration = generation;
  n.freeBirthTick = tick;
  n.freeRetireAt = tick + Math.round(FREE_MARKET.retireMinTicks +
    r() * (FREE_MARKET.retireMaxTicks - FREE_MARKET.retireMinTicks));
  n.retireRequested = false;

  // Капитал влияет не на «ум», а на стиль управления риском. Малые счета
  // быстрее и агрессивнее, большие — медленнее, дольше смотрят на рынок и
  // чаще используют защитные заявки. Это не даёт $10k-боту быть просто
  // увеличенной в 1000 раз копией $10-бота.
  n.act = clamp(n.act * tier.act * (0.90 + r() * 0.20), 0.01, 0.95);
  n.minGap = Math.max(4, Math.round(n.minGap * tier.gap * (0.90 + r() * 0.20)));
  n.look = Math.max(5, Math.min(360, Math.round(n.look * tier.look * (0.88 + r() * 0.24))));
  n.hold = Math.max(12, Math.round(n.hold * tier.hold * (0.90 + r() * 0.20)));
  n.usesOrders = r() < tier.orders;
  n.flexibility = clamp(n.flexibility * (0.90 + r() * 0.22), 0.08, 0.92);
}

function resetFreeBot(m, p) {
  const r = m.freeLifecycleRng || (m.freeLifecycleRng = mulberry32((m.seed ^ 0x4f1bbcdc) >>> 0));
  const oldCash = Math.max(0, p.cash);
  const fresh = freeBotCapital(r);
  const type = FREE_TYPES[Math.floor(r() * FREE_TYPES.length) % FREE_TYPES.length];
  const spec = ARCHETYPES[type];
  const generation = (p.npc?.freeGeneration || 0) + 1;
  const ordinal = p.id + generation * 10007;

  p.cash = fresh; p.startingCapital = fresh; p.u = 0;
  p.entryPrice = null; p.invested = 0; p.basis = 0; p.realizedPnL = 0;
  p.tradeCount = 0; p.stopLoss = null; p.takeProfit = null;
  p.liquidatedAt = null; p.isHuman = false; p.name = `${type}-${p.id}-g${generation}`;
  p.npc = makeNPCState(type, spec, r, m.seed + generation * 131, ordinal);
  applyFreePersonality(p, r, m.tick, generation);

  // Ушедший участник забирает остаток, новый заносит свой депозит. Это
  // реальный внешний приток/отток капитала свободного рынка, не PnL.
  m.C = Math.max(1e-9, m.C + fresh - oldCash);
  m.freeTurnover = (m.freeTurnover || 0) + 1;
}

function freeMarketLifecycle(m) {
  if (!m.freeMarket || m.tick % FREE_MARKET.lifecycleEvery !== 0) return;
  let rotated = 0, curveDirty = false;
  const start = Math.max(1, m.freeLifecycleCursor || 1);
  let cursor = start;
  let seen = 0;

  while (seen < FREE_MARKET.botCount && rotated < FREE_MARKET.lifecycleMaxPerPass) {
    const p = m.players[cursor];
    cursor++; if (cursor >= m.players.length) cursor = 1;
    seen++;
    if (!p?.npc) continue;
    const n = p.npc;
    const eq = m.equity(p.id);
    const distressed = eq <= Math.max(0.5, p.startingCapital * FREE_MARKET.distressFraction);
    const expired = m.tick >= (n.freeRetireAt || Infinity);
    if (!n.retireRequested && (distressed || expired)) n.retireRequested = true;
    if (!n.retireRequested || p.u !== 0) continue;
    resetFreeBot(m, p);
    rotated++; curveDirty = true;
  }

  m.freeLifecycleCursor = cursor;
  if (curveDirty) {
    m.startingCapital = m.C / m.players.length;
    m.curve = makeCurve(m);
    m._freePreStats = null;
  }
}

class FreeMarketLegacyRoom {
  constructor({ startingCapital = 0, seed = 7001, devMode = false,
    attachHuman = true } = {}) {
    // v52: Free Market больше не создаёт лишнюю закрытую LegacyRoom через
    // super(), чтобы тут же выбросить её. Это самостоятельный adapter над
    // одним RoomV4 с тем же публичным API, который нужен транспорту.
    const requestedHumanCapital = parseMoneyInput(startingCapital);
    const count = FREE_MARKET.botCount + 1; // 0 = зарезервированный слот человека
    this._room = new RoomV4({ playerCount: count, startingCapital: 1, seed,
      npcCount: 0, leverage: 1, durationTicks: null,
      warmupTicks: 0, prerollTicks: 0 });
    const m = this._room.market;
    m.freeMarket = true;
    m.freeMarketLifecycle = freeMarketLifecycle;
    m.phase = null;
    m.totalTicks = null;
    m.warmupTicks = 0;
    m.npcLeverage = 1;
    m.npcBatchSize = FREE_MARKET.npcBatchSize;
    m.npcCursor = 1;
    m.invariantEvery = FREE_MARKET.invariantEvery;

    const human = m.players[0];
    human.name = "ВЫ";
    human.isHuman = true;
    human.startingCapital = 0;
    human.cash = 0;
    human.npc = null;
    this._room.humanSlots.add(0);

    const r = mulberry32(seed ^ 0x51f15e);
    for (let i = 1; i < count; i++) {
      const cap = freeBotCapital(r);
      const p = m.players[i];
      p.startingCapital = cap;
      p.cash = cap;
    }

    // Пересчитываем денежный масштаб ДО появления позиций. После этого C
    // остаётся константой и обычные инварианты нулевой суммы продолжают
    // работать без отдельной математики для "богатых" и "бедных" ботов.
    m.C = m.players.reduce((s, p) => s + p.cash, 0);
    m.startingCapital = m.C / count; // только fallback для legacy-кода
    m.curve = makeCurve(m);
    attachNPCs(m, 1, FREE_MARKET.botCount, seed + 17, FREE_TYPES);
    m.freeLifecycleRng = mulberry32((seed ^ 0x4f1bbcdc) >>> 0);
    m.freeLifecycleCursor = 1;
    m.freeTurnover = 0;
    for (let i = 1; i < count; i++) applyFreePersonality(m.players[i], r, 0, 0);

    // Формируем историю до входа человека. Человек в preroll не торгует,
    // поэтому его капитал остаётся ровно выбранным.
    this._room._inPreroll = true;
    for (let t = 0; t < FREE_MARKET.prerollTicks && !this._room.halted; t++) {
      this._room.step();
    }
    this._room._inPreroll = false;

    this.devMode = devMode;
    this._startingCapital = 0;
    this._humanAttached = false;
    this._entryTick = m.tick;
    this.leverage = 1;
    this.eyesMode = false;
    this.eyes = null;
    this.paused = false;
    this._buyPressure = 0;
    this._sellPressure = 0;
    this._buyTotal = 0;
    this._sellTotal = 0;
    this._totalTrades = 0;
    this._openPrice = m.mark;
    this._cache = null;
    this._freeAggCache = null;
    /* В free-market тик НЕ сбрасывается после preroll. Если оставить хвост
       истории в диапазоне -N..0, а новые точки писать уже как m.tick*dt,
       график рвётся на две отдельные пачки свечей с огромной дырой между
       ними. Поэтому хвост сразу выравнивается в абсолютное время рынка:
       последняя историческая точка соответствует текущему m.tick. */
    this._priceHistory = this._room.history.map((price, i, arr) => ({
      price,
      t: (m.tick - (arr.length - 1 - i)) * CONFIG.market.tickMs,
      volume: 0,
    }));

    if (attachHuman && requestedHumanCapital >= FREE_MARKET.minCapital)
      this.attachHuman(requestedHumanCapital);
  }

  advance(n) {
    for (let k = 0; k < n && !this._room.halted; k++) this.step();
    return this;
  }

  send(playerId, cmd) { return this._room.send(playerId, cmd); }

  _context(base) {
    const h = this._priceHistory;
    const n = h.length;
    const at = (k) => h[Math.max(0, n - 1 - k)]?.price ?? this._room.market.mark;
    const now = at(0);
    const win = Math.min(40, Math.max(0, n - 1));
    let sum = 0, sum2 = 0;
    for (let k = 0; k < win; k++) {
      const r = (at(k) - at(k + 1)) / Math.max(at(k + 1), 1e-9);
      sum += r; sum2 += r * r;
    }
    const mean = win ? sum / win : 0;
    return {
      speed: n > 10 ? (now - at(10)) / Math.max(at(10), 1e-9) : 0,
      volatility: win ? Math.sqrt(Math.max(0, sum2 / win - mean * mean)) : 0,
      imbalance: 0,
    };
  }

  _phase(base) {
    const [lo, hi] = base.priceRange || [0, 1];
    const pos = hi > lo ? (base.mark - lo) / (hi - lo) : 0.5;
    if (pos > 0.8) return "перегрев";
    if (pos < 0.2) return "распродажа";
    return "стабильно";
  }

  join(_ignoredId, _name) { return 0; }

  // Свободный рынок хранит собственный стартовый капитал у каждого бота.
  // Обычный LegacyRoom оставлен неизменным и по-прежнему использует единый
  // this._startingCapital для закрытых комнат.
  _legacyPlayer(p) {
    return {
      ...p,
      startingCapital: p.startingCapital ?? this._startingCapital,
      position: p.position ? {
        ...p.position,
        margin: p.position.invested,
        openedAtTick: null,
        settlement: p.closeValue,
      } : null,
    };
  }

  attachHuman(capital) {
    const m = this._room.market;
    const p = m.players[0];
    const requested = parseMoneyInput(capital);
    if (!Number.isFinite(requested) || requested < FREE_MARKET.minCapital || requested > FREE_MARKET.maxCapital) {
      return null;
    }
    const amount = requested;
    if (this._humanAttached) return this.snapshotFor(0);
    p.cash = amount;
    p.u = 0; p.startingCapital = amount; p.entryPrice = null;
    p.invested = 0; p.basis = 0; p.realizedPnL = 0; p.tradeCount = 0;
    p.stopLoss = null; p.takeProfit = null; p.liquidatedAt = null;
    m.C += amount;
    m.startingCapital = m.C / m.players.length;
    m.curve = makeCurve(m);
    this._startingCapital = amount;
    this._humanAttached = true;
    this._entryTick = m.tick;
    this._openPrice = m.mark;
    this._freeAggCache = null;
    return this.snapshotFor(0);
  }

  detachHuman() {
    if (!this._humanAttached) return { equity: 0, snapshot: this.snapshotFor(0) };
    const m = this._room.market;
    const p = m.players[0];
    if (p.u !== 0) {
      const result = this._room.step([{ i: 0, du: -p.u, reason: "leave" }]);
      this._recordStepResult(result);
    }
    this._freeAggCache = null;
    const finalSnapshot = this.snapshotFor(0);
    const equity = p.cash;
    p.cash = 0; p.u = 0; p.startingCapital = 0;
    p.entryPrice = null; p.invested = 0; p.basis = 0;
    p.realizedPnL = 0; p.tradeCount = 0; p.liquidatedAt = null;
    p.stopLoss = null; p.takeProfit = null;
    m.C = Math.max(1e-9, m.C - equity);
    m.startingCapital = m.C / m.players.length;
    m.curve = makeCurve(m);
    this._startingCapital = 0;
    this._humanAttached = false;
    this._freeAggCache = null;
    const inv = checkInvariants(m, { freeDetach: true });
    if (!inv.ok) this._room.halted = inv.report;
    return { equity, snapshot: finalSnapshot };
  }

  _recordStepResult(result) {
    let buy = 0, sell = 0;
    if (result?.executed) {
      for (const e of result.executed) {
        const notional = Math.abs(e.du);
        if (e.du > 0) buy += notional; else sell += notional;
      }
      this._totalTrades += result.executed.length;
    }
    this._buyPressure = buy;
    this._sellPressure = sell;
    this._buyTotal += buy;
    this._sellTotal += sell;
    this._priceHistory.push({
      price: this._room.market.mark,
      t: this._room.market.tick * CONFIG.market.tickMs,
      volume: buy + sell,
    });
    if (this._priceHistory.length > FREE_MARKET.historyLimit + FREE_MARKET.historyTrimChunk)
      this._priceHistory.splice(0, FREE_MARKET.historyTrimChunk);
    return result;
  }

  step() {
    if (this.paused || this._room.halted) return null;
    return this._recordStepResult(this._room.step());
  }

  leave(_playerId) { return this.detachHuman(); }

  _freeAggregate(viewerId) {
    const m = this._room.market;
    const tick = m.tick;
    if (this._freeAggCache && tick - this._freeAggCache.tick < FREE_MARKET.snapshotEvery)
      return this._freeAggCache.value;

    let totalEquity = 0, totalCash = 0, longExposure = 0, shortExposure = 0;
    let longPlayers = 0, shortPlayers = 0, activeBots = 0, rank = 1;
    let netExposure = 0, totalEscrow = 0;
    const capitalTiers = { micro: 0, retail: 0, pro: 0, whale: 0 };
    const tierCapital = { micro: 0, retail: 0, pro: 0, whale: 0 };
    const strategies = {};
    const me = m.players[viewerId];
    const meEq = m.equity(viewerId);
    const meReturn = (meEq - (me.startingCapital || 1)) / Math.max(1e-9, me.startingCapital || 1);
    const sample = [];
    const stride = Math.max(1, Math.floor(FREE_MARKET.botCount / FREE_MARKET.rosterSample));

    for (let i = 0; i < m.players.length; i++) {
      const p = m.players[i];
      const eq = m.equity(i);
      totalEquity += eq;
      totalCash += p.cash;
      netExposure += p.u;
      totalEscrow += Math.abs(p.u);
      const ret = (eq - (p.startingCapital || 1)) / Math.max(1e-9, p.startingCapital || 1);
      if (i !== viewerId && ret > meReturn) rank++;
      if (p.u > 0) { longPlayers++; longExposure += m.settlement(i); }
      else if (p.u < 0) { shortPlayers++; shortExposure += m.settlement(i); }
      if (i > 0) {
        if (p.u !== 0) activeBots++;
        const tier = p.npc?.freeTier || freeTierFor(p.startingCapital || 0).key;
        capitalTiers[tier] = (capitalTiers[tier] || 0) + 1;
        tierCapital[tier] = (tierCapital[tier] || 0) + eq;
        const st = p.npc?.type || "unknown";
        strategies[st] = (strategies[st] || 0) + 1;
      }
      if (i === viewerId || (i > 0 && i % stride === 0 && sample.length < FREE_MARKET.rosterSample)) {
        const projected = projectPlayer(m, p, { viewer: i === viewerId, devMode: false });
        projected.startingCapital = p.startingCapital;
        sample.push(this._legacyPlayer(projected));
      }
    }
    const directional = longPlayers + shortPlayers;
    const value = {
      rank, sample, q: netExposure, escrow: totalEscrow,
      market: {
        totalEquity, totalCash, longExposure, shortExposure, longPlayers, shortPlayers,
        flatPlayers: m.players.length - directional,
        activePositions: directional,
        activeBots,
        capitalTiers, tierCapital, strategies, botTurnover: m.freeTurnover || 0,
        marketCap: totalEquity,
        poolEquity: totalEscrow,
        netExposure,
        longShare: directional ? longPlayers / directional : 0,
        shortShare: directional ? shortPlayers / directional : 0,
      },
    };
    this._freeAggCache = { tick, value };
    return value;
  }

  snapshotFor(viewerId) {
    const m = this._room.market;
    const agg = this._freeAggregate(viewerId);
    const raw = projectPlayer(m, m.players[viewerId], { viewer: true, devMode: false });
    raw.startingCapital = m.players[viewerId].startingCapital;
    const me = this._legacyPlayer(raw);
    const priceRange = [m.curve.PMIN, m.curve.PMAX];
    const contextBase = { mark: m.mark, priceRange, participants: [] };
    const context = this._context(contextBase);
    const exp = agg.market.longExposure + agg.market.shortExposure;
    context.imbalance = exp > 0
      ? (agg.market.longExposure - agg.market.shortExposure) / exp : 0;

    return {
      tick: m.tick, mark: m.mark, liquidationPrice: m.liquidationPrice,
      Q: agg.q, priceRange, escrow: agg.escrow, totalCapital: m.C,
      players: agg.sample,
      you: {
        ...me,
        marginLevel: null, liquidationPrice: null,
        buyingPower: availableBuyingPower(m, viewerId), wasLiquidated: false,
      },
      buyPressure: this._buyPressure, sellPressure: this._sellPressure,
      netPressure: this._buyPressure - this._sellPressure,
      buyTotal: this._buyTotal, sellTotal: this._sellTotal,
      netTotal: this._buyTotal - this._sellTotal,
      longRealized: m.longRealized, shortRealized: m.shortRealized,
      eyes: null, eyesMode: false, sessionPhase: null, warmupLeft: 0,
      tradingOpen: true, leverage: 1, maintenance: 0, liquidations: 0,
      totalTrades: this._totalTrades,
      totalPlayers: FREE_MARKET.botCount + (this._humanAttached ? 1 : 0),
      botCount: FREE_MARKET.botCount, freeMarket: true, humanAttached: this._humanAttached,
      sessionTicks: this._humanAttached ? Math.max(0, m.tick - this._entryTick) : 0,
      priceHistory: this._priceHistory,
      lastPoint: this._priceHistory[this._priceHistory.length - 1],
      market: agg.market, price: m.mark,
      previousPrice: this._priceHistory.length >= 2
        ? this._priceHistory[this._priceHistory.length - 2].price : m.mark,
      initialPrice: this._openPrice ?? m.mark,
      rank: this._humanAttached ? agg.rank : null,
      liquidity: agg.q, phase: this._phase(contextBase), context,
    };
  }
}

// ==== ПРОФИЛЬ / ЛОКАЛЬНЫЙ ТРАНСПОРТ / ИНТЕРФЕЙС ====
class LocalTransport {
  constructor({ startingCapital, seed, devMode = true, leverage = 1, eyes = false,
    durationTicks = null, warmupTicks = CONFIG.market.warmupTicks,
    playerCount = null } = {}) {
    this.leverage = leverage;
    this.eyes = eyes;
    this.room = new Room({ startingCapital, seed, devMode, leverage, eyes,
      durationTicks, warmupTicks, playerCount });
    this.playerId = this.room.join(null, "ВЫ"); // новый движок сам выдаёт id человека
    this.timer = null;
    this.speed = 1;
  }
  start(onSnapshot) {
    this.stop();
    this.timer = setInterval(() => {
      this.room.advance(this.speed);
      onSnapshot(this.room.snapshotFor(this.playerId));
    }, CONFIG.market.tickMs);
    onSnapshot(this.room.snapshotFor(this.playerId));
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async send(command) { return this.room.send(this.playerId, command); }
  snapshot() { return this.room.snapshotFor(this.playerId); }
  leave(penaltyFraction) { return this.room.leave(this.playerId, penaltyFraction); }
  setSpeed(value) { this.speed = value; }
  setPaused(value) { this.room.paused = value; }
  get paused() { return this.room.paused; }
}

class FreeMarketHub {
  constructor({ seed = Math.floor(Date.now() / 60000) } = {}) {
    this.room = new FreeMarketLegacyRoom({ startingCapital: 0, seed,
      devMode: false, attachHuman: false });
    this.subscribers = new Set();
    this.timer = null;
    this.lastStepAt = performance.now();
    this.lastEmitAt = 0;
    // Рынок может быть заранее создан в idle, но CPU-цикл запускается только
    // когда к нему реально подключён человек/экран. Раньше 5 000 NPC считались
    // бесконечно после одного посещения Free Market даже на главной странице.
  }
  start() {
    if (this.timer) return;
    this.lastStepAt = performance.now();
    this.timer = setInterval(() => this._pump(), CONFIG.market.tickMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  maybeStop() {
    if (!this.room._humanAttached && this.subscribers.size === 0) this.stop();
  }
  _pump() {
    const now = performance.now();
    let due = Math.max(1, Math.floor((now - this.lastStepAt) / CONFIG.market.tickMs));
    if (now - this.lastStepAt > 2000) {
      due = 1;
      this.lastStepAt = now - CONFIG.market.tickMs;
    }
    due = Math.min(due, 5);
    this.room.advance(due);
    this.lastStepAt += due * CONFIG.market.tickMs;
    if (this.subscribers.size && now - this.lastEmitAt >= FREE_MARKET.uiSnapshotMs) {
      const snap = this.room.snapshotFor(0);
      this.lastEmitAt = now;
      for (const cb of this.subscribers) cb(snap);
    }
  }
  subscribe(cb) {
    this.subscribers.add(cb);
    this.start();
    cb(this.room.snapshotFor(0));
    return () => {
      this.subscribers.delete(cb);
      this.maybeStop();
    };
  }
  attach(capital) {
    const snap = this.room.attachHuman(capital);
    if (!snap) return null;
    this.start();
    return snap;
  }
  detach() {
    const result = this.room.detachHuman();
    this.maybeStop();
    return result;
  }
  snapshot() { return this.room.snapshotFor(0); }
  async send(command) { return this.room.send(0, command); }
}

let FREE_MARKET_HUB = null;
function getFreeMarketHub() {
  if (!FREE_MARKET_HUB) FREE_MARKET_HUB = new FreeMarketHub();
  return FREE_MARKET_HUB;
}

class FreeMarketTransport {
  constructor({ startingCapital } = {}) {
    this.hub = getFreeMarketHub();
    this.playerId = 0;
    this.unsubscribe = null;
    this.finalSnapshot = null;
    this.left = false;
    const snap = this.hub.attach(startingCapital);
    if (!snap) throw new Error("invalid free market starting capital");
  }
  start(onSnapshot) {
    this.stop();
    this.unsubscribe = this.hub.subscribe(onSnapshot);
  }
  stop() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.hub.maybeStop();
  }
  async send(command) {
    if (this.left) return { ok: false, reason: "вы уже вышли из свободного рынка" };
    return this.hub.send(command);
  }
  snapshot() { return this.finalSnapshot || this.hub.snapshot(); }
  leave() {
    if (this.left) return { equity: this.finalSnapshot?.you?.equity || 0,
      snapshot: this.finalSnapshot };
    const exit = this.hub.detach();
    this.finalSnapshot = exit.snapshot;
    this.left = true;
    return exit;
  }
  setSpeed() {}
  setPaused() {}
  get paused() { return false; }
}

/* -------------------------------- СВЕЧИ ---------------------------------- */
const TIMEFRAMES = [
  { label: "1с", ms: 1000 }, { label: "5с", ms: 5000 }, { label: "15с", ms: 15000 },
  { label: "1м", ms: 60000 }, { label: "5м", ms: 300000 },
];

// Свечи строятся ТОЛЬКО из price stream движка, отдельной генерации нет.
/* Свечи собираются С КОНЦА истории и ровно столько, сколько влезает на
   экран. Прежняя версия перебирала все 6000 точек на каждом обновлении
   (десять раз в секунду) — при 500 участниках это и было главным
   источником подвисаний графика. */
function buildCandles(points, bucketMs, maxCandles) {
  const n = points.length;
  if (n === 0) return [];
  const earliest = points[n - 1].t - bucketMs * (maxCandles + 1);
  let start = n - 1;
  while (start > 0 && points[start - 1].t >= earliest) start--;
  const candles = [];
  let current = null;
  for (let k = start; k < n; k++) {
    const point = points[k];
    const bucket = Math.floor(point.t / bucketMs) * bucketMs;
    if (!current || current.t !== bucket) {
      current = { t: bucket, open: point.price, high: point.price,
        low: point.price, close: point.price, volume: point.volume };
      candles.push(current);
    } else {
      if (point.price > current.high) current.high = point.price;
      if (point.price < current.low) current.low = point.price;
      current.close = point.price;
      current.volume += point.volume;
    }
  }
  return candles.length > maxCandles ? candles.slice(-maxCandles) : candles;
}

export { EyesLayer, LegacyRoom, Room, FREE_MARKET, FreeMarketLegacyRoom, LocalTransport, FreeMarketHub, getFreeMarketHub, FreeMarketTransport, TIMEFRAMES, buildCandles };

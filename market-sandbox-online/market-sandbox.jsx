import React, { useEffect, useRef, useState } from "react";

/* ============================================================================
   MARKET SANDBOX — веб-версия движка из проекта closed-market-sim.
   Ядро ценообразования 1:1 с TypeScript-версией. В этой ревизии переработан
   слой поведения NPC (см. блок «ПОВЕДЕНИЕ ТОЛПЫ») и интерфейс.
   ========================================================================== */

const CONFIG = {
  market: {
    assetSymbol: "SIM",
    totalPlayers: 100,
    /** капитал по умолчанию; реальный выбирается при старте сессии */
    startingCapital: 100,
    /** доступные размеры сессии: столько получает КАЖДЫЙ из 100 участников */
    capitalOptions: [100, 500, 1000, 10000],
    initialPrice: 100,
    tickMs: 100,
    minPrice: 0.01,
  },
  price: { maxTickMove: 0.02, sensitivity: 0.12, pressureDecay: 0.45, pressureFloor: 0.01 },
  liquidity: { base: 250, freeCashWeight: 0.45, poolWeight: 0.35, openInterestPenalty: 0.9, min: 120 },
  impact: { coefficient: 0.55, maxImpact: 0.05 },
  risk: { shortLiquidationRatio: 0.05 },
  history: { maxPoints: 6000 },
};
const REFERENCE_CAPITAL = CONFIG.market.totalPlayers * CONFIG.market.startingCapital;

/**
 * Масштаб сессии.
 *
 * Абсолютные долларовые константы движка (база ликвидности, её минимум,
 * пол давления, минимальный размер сделки) откалиброваны под рынок в
 * $10 000. Если каждый участник получает $10 000, весь рынок — это уже
 * $1 000 000, и те же константы сделали бы рынок стоячим.
 *
 * Поэтому все абсолютные величины умножаются на scale = капитал рынка /
 * $10 000. Относительные величины (проскальзывание, чувствительность,
 * затухание) масштаба не требуют: они и так считаются в долях.
 * Это делает поведение рынка одинаковым при любом размере сессии.
 */
const scaleOf = (state) => state.totalCapital / REFERENCE_CAPITAL;
const minTrade = (state) => 0.5 * scaleOf(state);
const HUMAN_ID = "p-000";

/* --------------------------------- утилиты -------------------------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, items) => items[Math.floor(rng() * items.length)];
const range = (rng, min, max) => min + rng() * (max - min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const money = (v, d = 2) =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`;
const signed = (v, d = 2) =>
  `${v >= 0 ? "+" : "-"}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`;
const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
const signedPct = (v, d = 2) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const clock = (ms) => {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/* ------------------------------- PRICE ENGINE ------------------------------
   netPressure = buyPressure − sellPressure
   impulse     = netPressure / liquidity
   return      = maxTickMove · tanh(impulse / sensitivity)
   newPrice    = price · (1 + return)

   Давление меряется в долларах оборота и затухает между тиками — отсюда
   инерция. Деление на ликвидность даёт нелинейность: одна и та же заявка
   двигает тонкий рынок сильно, глубокий — слабо. tanh даёт насыщение.
   Мультипликативность делает отрицательную цену невозможной.
--------------------------------------------------------------------------- */
function decayPressure(previous, incoming, scale = 1) {
  const next = previous * CONFIG.price.pressureDecay + incoming;
  return next < CONFIG.price.pressureFloor * scale ? 0 : next;
}
function nextPrice({ price, buyPressure, sellPressure, liquidity, scale = 1 }) {
  const netPressure = buyPressure - sellPressure;
  const safeLiquidity = Math.max(liquidity, CONFIG.liquidity.min * scale);
  const impulse = netPressure / safeLiquidity;
  const returnRate = CONFIG.price.maxTickMove * Math.tanh(impulse / CONFIG.price.sensitivity);
  return { price: Math.max(CONFIG.market.minPrice, price * (1 + returnRate)), returnRate, netPressure, impulse };
}

/* ----------------------------- LIQUIDITY ENGINE ---------------------------
   Ликвидность — оценка глубины рынка. Свободные деньги = потенциальные
   контрагенты; чем больше капитала заперто в позициях, тем тоньше рынок.
   Влияет ТОЛЬКО на цену исполнения, никогда не блокирует выход.
--------------------------------------------------------------------------- */
function computeLiquidity(state) {
  let freeCash = 0;
  let openInterest = 0;
  for (const p of state.players) {
    freeCash += p.cash;
    if (p.position) openInterest += p.position.units * state.price;
  }
  const scale = scaleOf(state);
  const raw =
    CONFIG.liquidity.base * scale +
    freeCash * CONFIG.liquidity.freeCashWeight +
    Math.max(0, state.poolCash) * CONFIG.liquidity.poolWeight;
  const saturation = 1 + CONFIG.liquidity.openInterestPenalty * (openInterest / Math.max(1, state.totalCapital));
  return Math.max(CONFIG.liquidity.min * scale, raw / saturation);
}
function executionPrice(ref, notional, liquidity, direction, scale = 1) {
  const magnitude = Math.min(
    CONFIG.impact.maxImpact,
    (CONFIG.impact.coefficient * Math.abs(notional)) / Math.max(liquidity, CONFIG.liquidity.min * scale)
  );
  return Math.max(CONFIG.market.minPrice, ref * (1 + magnitude * direction));
}

/* -------------------------------- PNL ENGINE ------------------------------
   settlementValue — сколько игрок получит, закрыв позицию прямо сейчас.
     лонг : units · price
     шорт : margin + (entry − price) · units, ограничено нулём снизу
--------------------------------------------------------------------------- */
function settlementValue(pos, price) {
  if (pos.side === "long") return pos.units * price;
  return Math.max(0, pos.margin + (pos.entryPrice - price) * pos.units);
}
const unrealizedPnL = (p, price) => (p.position ? settlementValue(p.position, price) - p.position.margin : 0);
const equityOf = (p, price) => p.cash + (p.position ? settlementValue(p.position, price) : 0);
const isLiquidatable = (pos, price) =>
  pos.side === "short" && settlementValue(pos, price) <= pos.margin * CONFIG.risk.shortLiquidationRatio;

function aggregate(state) {
  let totalEquity = 0, totalCash = 0, longExposure = 0, shortExposure = 0;
  let longPlayers = 0, shortPlayers = 0, settlementTotal = 0;
  for (const p of state.players) {
    totalCash += p.cash;
    totalEquity += equityOf(p, state.price);
    if (p.position) {
      settlementTotal += settlementValue(p.position, state.price);
      const exposure = p.position.units * state.price;
      if (p.position.side === "long") { longExposure += exposure; longPlayers++; }
      else { shortExposure += exposure; shortPlayers++; }
    }
  }
  const directional = longPlayers + shortPlayers;
  return {
    totalEquity, totalCash, longExposure, shortExposure, longPlayers, shortPlayers,
    flatPlayers: state.players.length - directional,
    activePositions: directional,
    poolEquity: state.poolCash - settlementTotal,
    marketCap: state.price * CONFIG.market.totalPlayers,
    longShare: directional === 0 ? 0 : longPlayers / directional,
    shortShare: directional === 0 ? 0 : shortPlayers / directional,
  };
}

/* ------------------------------- ORDER ENGINE -----------------------------
   Единственный модуль, который двигает деньги. Любой перевод — это
   player.cash ↔ poolCash, поэтому сумма никогда не меняется.
   У закрытия позиции нет ни одного условия отказа.
--------------------------------------------------------------------------- */


function pushTrade(state, rec) {
  state.lastTickTrades.push(rec);
  state.totalTrades++;
  if (rec.flow === "buy") state.rawBuyPressure += rec.notional;
  else state.rawSellPressure += rec.notional;
  if (rec.playerId === HUMAN_ID) {
    state.humanTrades.unshift(rec);
    if (state.humanTrades.length > 60) state.humanTrades.pop();
  }
}

/**
 * Закрытие позиции целиком или её части.
 * fraction = 1 — полный выход; 0.5 — снять половину.
 * Частичные выходы важны для реализма: живые трейдеры редко выходят
 * всей позицией разом, и поток заявок получается гладким, а не
 * ступенчатым «всё или ничего».
 */
function closePosition(state, player, reason, fraction = 1) {
  const pos = player.position;
  if (!pos) return null;

  const f = clamp(fraction, 0, 1);
  const remainingMargin = pos.margin * (1 - f);
  // Огрызок позиции не оставляем — он всё равно неторгуем.
  const full = f >= 1 || remainingMargin < minTrade(state);
  const units = full ? pos.units : pos.units * f;
  const margin = full ? pos.margin : pos.margin * f;

  const direction = pos.side === "long" ? -1 : 1;
  const exposure = units * state.price;
  const execPrice = executionPrice(state.price, exposure, state.liquidity, direction, scaleOf(state));
  const payout = settlementValue({ ...pos, units, margin }, execPrice);
  const realized = payout - margin;

  player.cash += payout;
  state.poolCash -= payout;
  player.realizedPnL += realized;
  player.tradeCount++;

  const side = pos.side;
  if (player.mind) recordExit(player, state, realized, full);
  if (full) {
    player.position = null;
    player.stopLoss = null;
    player.takeProfit = null;
  } else {
    pos.units -= units;
    pos.margin -= margin;
  }

  const rec = {
    tick: state.tick, time: state.time, playerId: player.id, playerName: player.name,
    action: "CLOSE", flow: side === "long" ? "sell" : "buy",
    notional: exposure, units, execPrice, realizedPnL: realized,
    reason: full ? reason : `${reason} (частично)`,
  };
  pushTrade(state, rec);
  return rec;
}

function openPosition(state, player, side, requested, reason, stopLoss, takeProfit) {
  const notional = Math.min(requested, player.cash);
  if (notional < minTrade(state)) return null;
  const direction = side === "long" ? 1 : -1;
  const execPrice = executionPrice(state.price, notional, state.liquidity, direction, scaleOf(state));
  const units = notional / execPrice;

  player.cash -= notional;
  state.poolCash += notional;
  player.position = { side, units, entryPrice: execPrice, margin: notional, openedAtTick: state.tick };
  player.stopLoss = stopLoss ?? null;
  player.takeProfit = takeProfit ?? null;
  player.tradeCount++;
  if (player.mind) recordEntry(player, state, notional, side);

  const rec = {
    tick: state.tick, time: state.time, playerId: player.id, playerName: player.name,
    action: side === "long" ? "BUY" : "SELL", flow: side === "long" ? "buy" : "sell",
    notional, units, execPrice, reason,
  };
  pushTrade(state, rec);
  return rec;
}

/**
 * BUY   : шорт → закрыть; вне рынка → открыть лонг; лонг → долить
 * SELL  : лонг → закрыть; вне рынка → открыть шорт; шорт → долить
 * CLOSE : закрыть целиком или частично
 *
 * Встречное действие ТОЛЬКО закрывает позицию и не переворачивает её.
 * Переворот одним нажатием — источник неприятных сюрпризов: человек
 * жмёт «продать», ожидая выйти, а оказывается в шорте.
 */
function executeIntent(state, intent) {
  const player = state.playersById[intent.playerId];
  if (!player) return;
  if (intent.action === "CLOSE") {
    closePosition(state, player, intent.reason, intent.fraction ?? 1);
    return;
  }

  const desired = intent.action === "BUY" ? "long" : "short";
  if (player.position && player.position.side !== desired) {
    closePosition(state, player, intent.reason);
    return;
  }

  const notional = intent.notional ?? 0;
  if (notional < minTrade(state)) return;

  if (player.position && player.position.side === desired) {
    const prev = player.position;
    const closed = closePosition(state, player, `${intent.reason} (доливка)`);
    const combined = (closed ? closed.notional + (closed.realizedPnL ?? 0) : prev.margin) + notional;
    openPosition(state, player, desired, combined, intent.reason, intent.stopLoss, intent.takeProfit);
    return;
  }
  openPosition(state, player, desired, notional, intent.reason, intent.stopLoss, intent.takeProfit);
}

function triggerLimitOrders(state) {
  if (state.limitOrders.length === 0) return [];
  const triggered = [];
  state.limitOrders = state.limitOrders.filter((o) => {
    const hit = o.side === "buy" ? state.price <= o.limitPrice : state.price >= o.limitPrice;
    if (!hit) return true;
    triggered.push({
      playerId: o.playerId, action: o.side === "buy" ? "BUY" : "SELL",
      notional: o.notional, source: "system", reason: `лимит @ ${o.limitPrice.toFixed(2)}`,
    });
    return false;
  });
  return triggered;
}

/* ============================ ПОВЕДЕНИЕ ТОЛПЫ =============================

   ПОЧЕМУ ПРЕДЫДУЩАЯ ВЕРСИЯ БЫЛА ЛИНЕЙНОЙ

   Замеры старой модели (3000 тиков): в позициях постоянно находились
   в среднем 91 участник из 100, автокорреляция заполненности рынка на
   лаге 10 тиков — 0.67, до 28 сделок в один тик. То есть толпа входила
   и выходила синхронно, и график рисовал один и тот же маятник.

   Четыре конкретные причины:

   1. Все 99 ботов опрашивались КАЖДЫЙ тик, а частота решений умножалась
      на ОБЩИЙ множитель внимания. Это положительная обратная связь на
      всю толпу сразу: волатильность росла — ускорялись все, падала —
      замирали все. Готовый генератор колебаний.

   2. Все читали одни и те же r5/r20/r60, а пороги масштабировались одной
      и той же волатильностью. Пороги двигались синхронно, поэтому боты
      пересекали их толпой.

   3. Не было состояния «ничего не делать»: бот вне рынка при любом
      сигнале входил. Отсюда вечная перегруженность в 91%.

   4. Архетип «поставщик ликвидности» был буквально «вверх → продай,
      вниз → купи» — тот самый детерминированный паттерн, который и
      создаёт пилу. Удалён.

   ЧТО СДЕЛАНО ВЗАМЕН

   • Индивидуальный таймер решений. У каждого NPC свой интервал
     (от 0.6 с у агрессоров до 26 с у терпеливых) и джиттер ±45% при
     каждой перепланировке, поэтому моменты решений не выстраиваются
     в сетку и не синхронизируются даже случайно.

   • Собственное окно наблюдения. lookback у ботов от 5 до 220 тиков:
     они физически видят РАЗНЫЕ тренды на одном и том же ряду цен.
     Плюс индивидуальная задержка восприятия.

   • Решение ≠ сделка. Проснувшийся бот чаще всего не делает ничего:
     вероятность входа считается логистикой от силы сигнала за вычетом
     личной инерции.

   • Память. Каждый NPC хранит серию побед и поражений, уверенность,
     текущий риск, время последнего входа и выхода, последнее действие
     и разбор причин этого действия (виден в «Отладке»).

   • Отдых после сделки. После выхода бот берёт паузу, после убытка —
     более длинную. Это позволяет рынку иногда пустеть.

   • Размер позиции — случайная величина в диапазоне архетипа,
     умноженная на уверенность. Двух одинаковых объёмов не бывает.

   Фазы рынка (накопление, импульс, тренд, перегрев, паника,
   возврат к равновесию) НИГДЕ не прописаны как сценарий. Функция
   detectPhase только читает состояние и вешает ярлык для интерфейса —
   на решения ботов она не влияет.
--------------------------------------------------------------------------- */

/**
 * Архетипы. Веса w — вклад сигналов в решение об открытии:
 *   mom   — доходность за собственное окно наблюдения
 *   speed — скорость последнего движения (10 тиков)
 *   crowd — перекос толпы по экспозиции, −1…+1
 *   noise — личный шум
 * Отрицательные веса означают «против сигнала» (контрарианец).
 *
 * exit — вклад в решение о выходе:
 *   take (прибыль), pain (убыток), shock (резкое движение),
 *   patience (сколько тиков комфортно держать).
 */
/**
 * Архетипы. Веса w — вклад сигналов в решение об открытии:
 *   mom   — доходность за собственное окно наблюдения
 *   speed — скорость последнего движения (10 тиков)
 *   crowd — перекос толпы по экспозиции, −1…+1
 *   noise — личный шум
 * Отрицательные веса означают «против сигнала» (контртрендовый).
 *
 * accuracy — доля случаев, когда бот верно считывает направление.
 * Остальное — ошибка: бот разворачивает собственный вывод. Это не
 * «глупость», а главный механизм против предсказуемости: без ошибок
 * все контртрендовые боты откупали каждый провал, и стратегия
 * «падение −3% → лонг» давала 83% прибыльных сделок.
 *
 * exit — вклад в решение о выходе:
 *   take (прибыль), pain (убыток), shock (резкое движение),
 *   patience (сколько тиков комфортно держать).
 */
const ARCHETYPES = {
  aggressive: {
    label: "Агрессивный", count: 10, accuracy: 0.48,
    interval: [10, 30], perception: [0, 4], lookback: [10, 40],
    size: [0.20, 1.00], inertia: 0.72, rest: [15, 60],
    w: { mom: 1.10, speed: 0.85, crowd: 0.10, noise: 0.85 },
    exit: { take: 0.85, pain: 1.35, shock: 0.50, patience: 900 },
    addProb: 0.35, slProb: 0.25, tpProb: 0.30,
  },
  conservative: {
    label: "Осторожный", count: 15, accuracy: 0.55,
    interval: [30, 80], perception: [2, 10], lookback: [30, 90],
    size: [0.05, 0.30], inertia: 1.30, rest: [60, 200],
    w: { mom: 0.70, speed: 0.25, crowd: 0.20, noise: 0.30 },
    exit: { take: 1.55, pain: 1.10, shock: 0.30, patience: 600 },
    addProb: 0.05, slProb: 0.65, tpProb: 0.70,
  },
  trend: {
    label: "Трендовый", count: 10, accuracy: 0.60,
    interval: [12, 38], perception: [0, 6], lookback: [15, 50],
    size: [0.10, 0.45], inertia: 0.95, rest: [25, 90],
    w: { mom: 1.35, speed: 0.55, crowd: 0.25, noise: 0.35 },
    exit: { take: 1.00, pain: 1.20, shock: 0.40, patience: 800 },
    addProb: 0.22, slProb: 0.45, tpProb: 0.45,
  },
  contrarian: {
    label: "Контртрендовый", count: 10, accuracy: 0.52,
    interval: [25, 65], perception: [1, 8], lookback: [25, 80],
    size: [0.08, 0.35], inertia: 1.10, rest: [40, 140],
    w: { mom: -1.15, speed: -0.45, crowd: -0.55, noise: 0.40 },
    exit: { take: 1.20, pain: 1.00, shock: 0.25, patience: 1200 },
    addProb: 0.10, slProb: 0.50, tpProb: 0.60,
  },
  impulsive: {
    label: "Импульсивный", count: 10, accuracy: 0.45,
    interval: [8, 26], perception: [0, 5], lookback: [8, 25],
    size: [0.15, 0.60], inertia: 1.35, rest: [30, 110],
    w: { mom: 0.75, speed: 1.70, crowd: 0.45, noise: 0.30 },
    exit: { take: 0.70, pain: 1.50, shock: 0.80, patience: 400 },
    addProb: 0.25, slProb: 0.25, tpProb: 0.30,
  },
  patient: {
    label: "Терпеливый", count: 10, accuracy: 0.58,
    interval: [90, 260], perception: [4, 14], lookback: [80, 220],
    size: [0.10, 0.40], inertia: 1.20, rest: [200, 700],
    w: { mom: 0.90, speed: 0.05, crowd: 0.10, noise: 0.25 },
    exit: { take: 1.40, pain: 0.90, shock: 0.05, patience: 4000 },
    addProb: 0.08, slProb: 0.40, tpProb: 0.45,
  },
  scalper: {
    label: "Скальпер", count: 10, accuracy: 0.53,
    interval: [4, 14], perception: [0, 2], lookback: [6, 20],
    size: [0.04, 0.18], inertia: 0.70, rest: [5, 25],
    w: { mom: 0.60, speed: 0.90, crowd: 0.10, noise: 0.70 },
    exit: { take: 0.55, pain: 1.30, shock: 0.60, patience: 120 },
    addProb: 0.05, slProb: 0.55, tpProb: 0.65,
  },
  panic: {
    label: "Паникёр", count: 10, accuracy: 0.50,
    interval: [6, 22], perception: [0, 3], lookback: [20, 60],
    size: [0.10, 0.40], inertia: 1.55, rest: [80, 260],
    w: { mom: 0.55, speed: 0.30, crowd: 0.30, noise: 0.30 },
    exit: { take: 0.80, pain: 2.40, shock: 2.60, patience: 500 },
    addProb: 0.02, slProb: 0.55, tpProb: 0.40,
  },
  confident: {
    label: "Уверенный", count: 10, accuracy: 0.56,
    interval: [40, 120], perception: [2, 10], lookback: [40, 140],
    size: [0.15, 0.55], inertia: 1.15, rest: [60, 220],
    // Пересиживает просадку: боль почти не влияет, терпение огромное.
    w: { mom: 0.95, speed: 0.10, crowd: -0.15, noise: 0.30 },
    exit: { take: 1.30, pain: 0.35, shock: 0.10, patience: 3000 },
    addProb: 0.18, slProb: 0.15, tpProb: 0.35,
  },
  random: {
    label: "Экспериментатор", count: 4, accuracy: 0.42,
    interval: [20, 80], perception: [0, 12], lookback: [5, 120],
    size: [0.01, 0.35], inertia: 0.80, rest: [30, 140],
    w: { mom: 0.15, speed: 0.10, crowd: 0.05, noise: 1.70 },
    exit: { take: 1.00, pain: 1.00, shock: 0.20, patience: 700 },
    addProb: 0.08, slProb: 0.20, tpProb: 0.20,
  },
};

const STRATEGY_LABELS = Object.fromEntries(
  Object.entries(ARCHETYPES).map(([key, a]) => [key, a.label])
);

/** Список архетипов по одному на участника, согласно count. */
function buildPopulation() {
  const list = [];
  for (const [key, a] of Object.entries(ARCHETYPES)) {
    for (let i = 0; i < a.count; i++) list.push(key);
  }
  return list;
}

const logistic = (x) => 1 / (1 + Math.exp(-x));

/**
 * Профиль NPC создаётся один раз. Все диапазоны разыгрываются
 * индивидуально, поэтому двух одинаковых ботов не существует.
 */
function createNPCProfile(rng, archetypeKey) {
  const a = ARCHETYPES[archetypeKey];
  return {
    strategyType: archetypeKey,
    /** личная точность чтения направления; ниже — чаще ошибается */
    accuracy: clamp(a.accuracy + 0.1 + range(rng, -0.06, 0.06), 0.35, 0.85),
    intervalTicks: Math.round(range(rng, a.interval[0], a.interval[1])),
    perceptionLag: Math.floor(range(rng, a.perception[0], a.perception[1])),
    lookback: Math.round(range(rng, a.lookback[0], a.lookback[1])),
    sizeRange: a.size,
    inertia: a.inertia * range(rng, 0.85, 1.2),
    restRange: a.rest,
    w: a.w,
    exit: a.exit,
    addProb: a.addProb,
    slProb: a.slProb,
    tpProb: a.tpProb,
    /** личная цель по прибыли и терпимость к убытку */
    target: range(rng, 0.010, 0.060),
    tolerance: range(rng, 0.015, 0.070),
    riskTolerance: range(rng, 0.15, 0.95),
  };
}

/** Память бота. Именно она делает поведение последовательным, а не stateless. */
function createMind(rng, npc, tick) {
  return {
    // первое решение размазано по времени, чтобы старт не был синхронным
    nextDecisionTick: tick + Math.floor(rng() * npc.intervalTicks * 3),
    lastEntryTick: null,
    lastExitTick: null,
    restUntilTick: 0,
    wins: 0,
    losses: 0,
    /** уверенность 0.5…1.5, растёт от прибыльных сделок */
    confidence: range(rng, 0.8, 1.1),
    /** текущий риск-множитель, снижается после серии убытков */
    risk: 1,
    lastAction: "ожидание",
    lastActionTick: 0,
    lastReasons: [],
    /**
     * Внутрисессионное обучение. −1 — «в этой сессии работают развороты»,
     * +1 — «работает движение по тренду». Смещается после каждой закрытой
     * сделки в зависимости от того, оправдался ли выбранный стиль входа.
     */
    regimeBias: 0,
    /** стиль последнего входа: +1 по тренду, −1 против */
    entryStyle: 0,
    pendingStyle: 0,
    mistakes: 0,
  };
}

/** Перепланировка следующего решения с джиттером — сетка не выстраивается. */
function scheduleNext(mind, npc, rng, tick) {
  mind.nextDecisionTick = tick + Math.max(2, Math.round(npc.intervalTicks * range(rng, 0.55, 1.45)));
}

/**
 * Общий срез рынка. Считается один раз за тик и передаётся всем,
 * но КАЖДЫЙ бот достаёт из него собственное окно наблюдения.
 */
function buildMarketContext(state) {
  const h = state.priceHistory;
  const at = (lag) => h[Math.max(0, h.length - 1 - lag)].price;

  let longExposure = 0, shortExposure = 0, inPosition = 0;
  for (const p of state.players) {
    if (!p.position) continue;
    inPosition++;
    const exposure = p.position.units * state.price;
    if (p.position.side === "long") longExposure += exposure;
    else shortExposure += exposure;
  }
  const totalExposure = longExposure + shortExposure;

  let sum = 0, count = 0;
  for (let i = Math.max(1, h.length - 20); i < h.length; i++) {
    if (h[i - 1].price > 0) { sum += Math.abs(h[i].price / h[i - 1].price - 1); count++; }
  }

  return {
    at,
    price: state.price,
    speed: at(0) / at(10) - 1,
    volatility: count === 0 ? 0 : sum / count,
    longExposure,
    shortExposure,
    imbalance: totalExposure === 0 ? 0 : (longExposure - shortExposure) / totalExposure,
    inPosition,
    crowdedness: inPosition / state.players.length,
    buyPressure: state.buyPressure,
    sellPressure: state.sellPressure,
  };
}

/**
 * Ярлык фазы рынка. ТОЛЬКО для интерфейса: ни один бот его не читает.
 * Фазы возникают из поведения толпы, а не задают его.
 */
function detectPhase(ctx) {
  const imb = Math.abs(ctx.imbalance);
  // Пороги взяты из квантилей реальных прогонов: волатильность этого
  // рынка живёт в диапазоне 0.0001…0.0016, и «на глаз» выставленные
  // числа показывали одну фазу в 85% случаев.
  if (ctx.speed < -0.010 && ctx.volatility > 0.0008) return "ПАНИКА";
  if (imb > 0.57 && ctx.crowdedness > 0.42) return "ПЕРЕГРЕВ";
  if (ctx.volatility > 0.0008 && imb > 0.28) return "ТРЕНД";
  if (ctx.volatility > 0.0008) return "ИМПУЛЬС";
  if (Math.abs(ctx.speed) < 0.0008 && ctx.volatility < 0.0003) return "ФЛЭТ";
  if (ctx.volatility < 0.0005 && ctx.crowdedness < 0.38) return "НАКОПЛЕНИЕ";
  return "РАВНОВЕСИЕ";
}

/**
 * Одно решение одного NPC.
 * Возвращает намерение либо null («ничего не делать» — самый частый исход).
 * Причины решения складываются в mind.lastReasons для отладки.
 */
function decide(state, player, ctx, rng) {
  const npc = player.npc;
  const mind = player.mind;
  const reasons = [];

  const perceived = ctx.at(npc.perceptionLag);
  const past = ctx.at(npc.perceptionLag + npc.lookback);
  const mom = past > 0 ? perceived / past - 1 : 0;

  // ---------------------------------------------------------------- выход
  if (player.position) {
    const pos = player.position;
    const pnlRatio = unrealizedPnL(player, state.price) / Math.max(1e-6, pos.margin);
    const holdTicks = state.tick - pos.openedAtTick;
    const adverse = (pos.side === "long" && ctx.speed < 0) || (pos.side === "short" && ctx.speed > 0);

    const takeScore = Math.max(0, pnlRatio) / npc.target;
    const painScore = Math.max(0, -pnlRatio) / npc.tolerance;
    const shockScore = (Math.max(0, Math.abs(ctx.speed) - 0.008) / 0.02) * (adverse ? 1.6 : 0.5);
    const timeScore = holdTicks / npc.exit.patience;
    const luck = (rng() - 0.5) * 0.7;

    // Коэффициент 0.35 у фиксации прибыли подобран замером: при
    // полновесной жадности любое движение механически откатывалось, и
    // стратегия «шорт после роста +2%» выигрывала в 69% случаев.
    // Ослабление фиксации даёт трендам шанс продолжиться.
    const drive =
      npc.exit.take * 0.35 * takeScore +
      npc.exit.pain * painScore +
      npc.exit.shock * shockScore +
      timeScore + luck;

    if (takeScore > 0.05) reasons.push(["прибыль", npc.exit.take * takeScore]);
    if (painScore > 0.05) reasons.push(["убыток", npc.exit.pain * painScore]);
    if (shockScore > 0.05) reasons.push(["резкое движение", npc.exit.shock * shockScore]);
    if (timeScore > 0.1) reasons.push(["время в позиции", timeScore]);

    if (rng() < logistic(2.5 * (drive - 1))) {
      // Паникёры и осторожные чаще выходят целиком, остальные — частями.
      const full = rng() < (npc.strategyType === "panic" ? 0.65 : 0.42);
      const fraction = full ? 1 : range(rng, 0.3, 0.75);
      mind.lastReasons = reasons;
      return {
        playerId: player.id, action: "CLOSE", fraction, source: "npc",
        reason: fraction >= 1 ? "выход из позиции" : "частичная фиксация",
      };
    }

    // Доливка: только в прибыль и только по направлению собственного сигнала.
    const aligned = (pos.side === "long" && mom > 0) || (pos.side === "short" && mom < 0);
    if (aligned && pnlRatio > 0.004 && rng() < npc.addProb * mind.confidence * 0.35) {
      const extra = player.cash * range(rng, npc.sizeRange[0], npc.sizeRange[1]) * 0.5;
      if (extra >= 1) {
        reasons.push(["позиция в плюсе", pnlRatio / npc.target]);
        reasons.push(["сигнал подтверждается", Math.abs(mom) / 0.02]);
        mind.lastReasons = reasons;
        return {
          playerId: player.id, action: pos.side === "long" ? "BUY" : "SELL",
          notional: extra, source: "npc", reason: "наращивание позиции",
        };
      }
    }

    // Защитные уровни ставятся не сразу и не всеми — это тоже действие.
    if (player.stopLoss === null && rng() < npc.slProb * 0.3) {
      const distance = 0.010 + npc.riskTolerance * 0.035;
      player.stopLoss = pos.side === "long"
        ? pos.entryPrice * (1 - distance) : pos.entryPrice * (1 + distance);
      mind.lastAction = `стоп ${player.stopLoss.toFixed(2)}`;
      mind.lastActionTick = state.tick;
      mind.lastReasons = [["защита позиции", 1]];
      return null;
    }
    if (player.takeProfit === null && rng() < npc.tpProb * 0.3) {
      const distance = npc.target * range(rng, 0.9, 1.8);
      player.takeProfit = pos.side === "long"
        ? pos.entryPrice * (1 + distance) : pos.entryPrice * (1 - distance);
      mind.lastAction = `тейк ${player.takeProfit.toFixed(2)}`;
      mind.lastActionTick = state.tick;
      mind.lastReasons = [["цель по прибыли", 1]];
      return null;
    }

    mind.lastReasons = reasons.length ? reasons : [["держит позицию", 0]];
    return null;
  }

  // ----------------------------------------------------------------- вход
  if (state.tick < mind.restUntilTick) {
    mind.lastReasons = [["отдых после сделки", 0]];
    return null;
  }

  const momSignal = clamp(mom / 0.03, -3, 3);
  const speedSignal = clamp(ctx.speed / 0.012, -3, 3);
  const crowdSignal = ctx.imbalance;
  const noiseSignal = rng() * 2 - 1;

  // Внутрисессионное обучение: бот, который раз за разом ошибался,
  // ловя развороты, начинает склоняться к движению по тренду — и наоборот.
  const w = { ...npc.w, mom: npc.w.mom + mind.regimeBias * 0.7 };

  const parts = [
    ["импульс", w.mom * momSignal],
    ["скорость", w.speed * speedSignal],
    ["перекос толпы", w.crowd * crowdSignal],
    ["личный шум", w.noise * noiseSignal],
  ];
  let bias = parts.reduce((sum, [, v]) => sum + v, 0);

  // Ошибка чтения. Без неё одинаковый сигнал вызывал у всех ботов
  // одного архетипа одинаковую реакцию, и толпа снова становилась
  // одним алгоритмом.
  const misread = rng() > npc.accuracy;
  if (misread) {
    bias = -bias * range(rng, 0.5, 1);
    parts.push(["ошибся в направлении", -1]);
    mind.mistakes++;
  }
  const strength = Math.abs(bias);

  // Перегретый рынок сам себя тормозит: когда почти все в позициях,
  // новые входы становятся менее вероятными.
  const crowdBrake = 1 - 0.45 * Math.max(0, ctx.crowdedness - 0.55) / 0.45;
  const pOpen = logistic(2.2 * (strength - npc.inertia * 0.8)) * crowdBrake * mind.risk;

  if (rng() > pOpen) {
    mind.lastReasons = parts.filter(([, v]) => Math.abs(v) > 0.05);
    return null;
  }

  const fraction = range(rng, npc.sizeRange[0], npc.sizeRange[1]) *
    clamp(mind.confidence * mind.risk, 0.35, 1.4);
  const notional = player.cash * Math.min(0.98, fraction);
  if (notional < 1) return null;

  mind.lastReasons = parts.filter(([, v]) => Math.abs(v) > 0.05);
  // Стиль входа нужен обучению: вошёл ли бот по движению или против него.
  mind.pendingStyle = Math.sign(momSignal) === Math.sign(bias) ? 1 : -1;
  return {
    playerId: player.id,
    action: bias > 0 ? "BUY" : "SELL",
    notional,
    source: "npc",
    reason: ARCHETYPES[npc.strategyType].label.toLowerCase(),
  };
}

/** Запись входа в память бота. */
function recordEntry(player, state, notional, side) {
  const mind = player.mind;
  mind.entryStyle = mind.pendingStyle;
  mind.lastEntryTick = state.tick;
  mind.lastAction = `${side === "long" ? "ЛОНГ" : "ШОРТ"} ${money(notional, 0)}`;
  mind.lastActionTick = state.tick;
}

/**
 * Запись выхода. Здесь же живёт вся адаптация: серия побед поднимает
 * уверенность и риск, серия поражений опускает, а после закрытия бот
 * уходит на отдых — после убытка более длинный.
 */
function recordExit(player, state, realized, full) {
  const mind = player.mind;
  const npc = player.npc;
  if (realized >= 0) mind.wins++; else mind.losses++;
  mind.confidence = clamp(mind.confidence + (realized >= 0 ? 0.06 : -0.09), 0.5, 1.5);
  mind.risk = clamp(1 + (mind.wins - mind.losses) * 0.05, 0.4, 1.5);
  // Обучение: оправдался ли стиль входа. Три стопа подряд на ловле
  // разворотов — и бот в этой сессии больше их не ловит.
  if (mind.entryStyle !== 0) {
    mind.regimeBias = clamp(
      mind.regimeBias + (realized >= 0 ? 0.15 : -0.15) * mind.entryStyle, -1, 1
    );
  }
  mind.lastAction = `${full ? "ЗАКРЫЛ" : "СОКРАТИЛ"} ${signed(realized)}`;
  mind.lastActionTick = state.tick;
  if (full) {
    mind.lastExitTick = state.tick;
    const [lo, hi] = npc.restRange;
    const rest = range(state.rng, lo, hi) * (realized < 0 ? 1.6 : 1);
    mind.restUntilTick = state.tick + Math.round(rest);
  }
}

/**
 * Опрос толпы за тик.
 * Просыпаются только те боты, у кого подошёл собственный таймер, —
 * обычно это единицы из 99, а не все сразу.
 */
function collectNPCIntents(state, rng) {
  const ctx = buildMarketContext(state);
  state.context = ctx;
  state.phase = detectPhase(ctx);

  const intents = [];
  for (const player of state.players) {
    if (player.isHuman || !player.npc) continue;
    const mind = player.mind;
    if (state.tick < mind.nextDecisionTick) continue;

    scheduleNext(mind, player.npc, rng, state.tick);
    const intent = decide(state, player, ctx, rng);
    if (intent) intents.push(intent);
  }
  return intents;
}

/* ------------------------------ MARKET ENGINE ----------------------------- */
function createMarket(seed, startingCapital = CONFIG.market.startingCapital) {
  const rng = mulberry32(seed);
  const base = () => ({
    startingCapital, cash: startingCapital,
    position: null, realizedPnL: 0, stopLoss: null, takeProfit: null,
    tradeCount: 0, mind: null,
  });
  const players = [{ id: HUMAN_ID, name: "ВЫ", isHuman: true, ...base() }];

  // Архетипы перемешиваются, чтобы не идти блоками по номерам ботов.
  const population = buildPopulation();
  for (let i = population.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [population[i], population[j]] = [population[j], population[i]];
  }

  for (let i = 1; i < CONFIG.market.totalPlayers; i++) {
    const npc = createNPCProfile(rng, population[i - 1] ?? "noise");
    players.push({
      id: `p-${String(i).padStart(3, "0")}`, name: `Бот ${String(i).padStart(2, "0")}`,
      isHuman: false, ...base(), npc, mind: createMind(rng, npc, 0),
    });
  }
  const playersById = {};
  for (const p of players) playersById[p.id] = p;

  const state = {
    roomId: "local",
    tick: 0, time: 0, price: CONFIG.market.initialPrice, previousPrice: CONFIG.market.initialPrice,
    players, playersById, poolCash: 0,
    startingCapital,
    totalCapital: CONFIG.market.totalPlayers * startingCapital,
    limitOrders: [],
    rawBuyPressure: 0, rawSellPressure: 0, buyPressure: 0, sellPressure: 0, netPressure: 0,
    liquidity: 0, priceHistory: [{ t: 0, price: CONFIG.market.initialPrice, volume: 0 }],
    lastTickTrades: [], humanTrades: [], totalTrades: 0, capitalDrift: 0,
    /** срез рынка текущего тика и производный ярлык фазы (только для UI) */
    context: null, phase: "НАКОПЛЕНИЕ",
    /** ГПСЧ сессии: нужен слою памяти, чтобы отдых после сделки был детерминирован */
    rng,
  };
  state.liquidity = computeLiquidity(state);
  state.context = buildMarketContext(state);
  return { state, rng };
}

function collectProtectiveIntents(state) {
  const intents = [];
  for (const player of state.players) {
    const pos = player.position;
    if (!pos) continue;
    if (isLiquidatable(pos, state.price)) {
      intents.push({ playerId: player.id, action: "CLOSE", source: "system", reason: "ликвидация" });
      continue;
    }
    const long = pos.side === "long";
    if (player.stopLoss !== null) {
      const hit = long ? state.price <= player.stopLoss : state.price >= player.stopLoss;
      if (hit) { intents.push({ playerId: player.id, action: "CLOSE", source: "system", reason: "стоп-лосс" }); continue; }
    }
    if (player.takeProfit !== null) {
      const hit = long ? state.price >= player.takeProfit : state.price <= player.takeProfit;
      if (hit) intents.push({ playerId: player.id, action: "CLOSE", source: "system", reason: "тейк-профит" });
    }
  }
  return intents;
}

// Цена считается ПОСЛЕДНЕЙ и только из объёмов, исполненных на этом тике.
function step(state, incoming) {
  state.tick++;
  state.time += CONFIG.market.tickMs;
  state.lastTickTrades = [];
  state.rawBuyPressure = 0;
  state.rawSellPressure = 0;
  state.previousPrice = state.price;

  const intents = [...triggerLimitOrders(state), ...collectProtectiveIntents(state), ...incoming];
  for (const intent of intents) executeIntent(state, intent);

  const scale = scaleOf(state);
  state.buyPressure = decayPressure(state.buyPressure, state.rawBuyPressure, scale);
  state.sellPressure = decayPressure(state.sellPressure, state.rawSellPressure, scale);
  state.liquidity = computeLiquidity(state);

  const result = nextPrice({ ...state, scale });
  state.price = result.price;
  state.netPressure = result.netPressure;

  state.priceHistory.push({
    t: state.time, price: state.price, volume: state.rawBuyPressure + state.rawSellPressure,
  });
  if (state.priceHistory.length > CONFIG.history.maxPoints) {
    state.priceHistory.splice(0, state.priceHistory.length - CONFIG.history.maxPoints);
  }

  // Инвариант замкнутости капитала: пересчитывается каждый тик.
  let cashSum = 0;
  for (const p of state.players) cashSum += p.cash;
  state.capitalDrift = cashSum + state.poolCash - state.totalCapital;
}

class SimulationEngine {
  constructor(seed = Date.now() % 2147483647, startingCapital = CONFIG.market.startingCapital) {
    this.startingCapital = startingCapital;
    const created = createMarket(seed, startingCapital);
    this.state = created.state;
    this.rng = created.rng;
    this.queue = [];
    this.orderSeq = 0;
    this.paused = false;
  }
  getState() { return this.state; }
  getHuman() { return this.state.playersById[HUMAN_ID]; }
  submit(intent) { this.queue.push({ ...intent, playerId: HUMAN_ID, source: "human" }); }
  placeLimitOrder(order) {
    this.orderSeq++;
    this.state.limitOrders.push({ ...order, id: `lo-${this.orderSeq}`, createdAtTick: this.state.tick });
  }
  cancelLimitOrder(id) {
    this.state.limitOrders = this.state.limitOrders.filter((o) => o.id !== id);
  }
  setProtection(playerId, stopLoss, takeProfit) {
    const p = this.state.playersById[playerId];
    if (!p || !p.position) return;
    if (stopLoss !== null) p.stopLoss = stopLoss;
    if (takeProfit !== null) p.takeProfit = takeProfit;
  }
  clearProtection(playerId, kind) {
    const p = this.state.playersById[playerId];
    if (!p) return;
    if (kind === "sl") p.stopLoss = null;
    else p.takeProfit = null;
  }
  tick() {
    const intents = [...collectNPCIntents(this.state, this.rng), ...this.queue];
    this.queue = [];
    step(this.state, intents);
  }
  advance(steps) {
    if (this.paused) return;
    for (let i = 0; i < steps; i++) this.tick();
  }
  reset(seed = Date.now() % 2147483647) {
    const created = createMarket(seed, this.startingCapital);
    this.state = created.state;
    this.rng = created.rng;
    this.queue = [];
    this.orderSeq = 0;
    this.paused = false;
  }
}

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

/* ======================= ГРАНИЦА КЛИЕНТ / СЕРВЕР ==========================

   Зачем этот слой существует.

   До него интерфейс читал состояние движка напрямую: сам считал equity,
   сам лазил в профили и память ботов, сам знал позиции всех участников.
   Пока движок крутится на телефоне, это работает. В момент, когда игроков
   станет 100 живых, это превращается в дыру: клиент, который САМ считает,
   сколько он заработал, может посчитать что угодно.

   Поэтому вводятся три вещи.

   1. КОМАНДА (Command). Единственный способ что-либо сделать. Клиент
      отправляет намерение — «купить на $50», — а не результат. Никаких
      «у меня теперь позиция такая-то».

   2. ВАЛИДАЦИЯ НА СТОРОНЕ ДВИЖКА. validateCommand проверяет всё, что
      сейчас проверял бы сервер: хватает ли кэша, существует ли позиция,
      принадлежит ли заявка отправителю. Клиентские проверки остаются
      только для подсветки кнопок.

   3. СНАПШОТ (Snapshot). Плоский сериализуемый объект — ровно то, что
      сервер разошлёт игрокам. Все производные величины (equity, PnL,
      стоимость закрытия, место в рейтинге) считает движок, а не клиент.
      Отладочный блок помечен devOnly: в продакшене сервер его вырезает,
      иначе игроки увидят внутренности ботов и смогут по ним торговать.

   Room — это будущая «комната» матча. Сегодня в ней 1 человек и 99 NPC,
   завтра 100 человек, а Market Engine между этими двумя случаями не
   меняется вообще: NPC и живые игроки — просто два источника команд.

   Transport — то, что подменяется при переезде на сервер.
   LocalTransport крутит движок в процессе. RemoteTransport (заготовка
   ниже) будет слать команды в Cloud Function и слушать снапшоты из
   Firestore. Интерфейс о разнице не знает.
--------------------------------------------------------------------------- */

/** Проверки, которые обязан выполнять сервер и которым нельзя доверять клиенту. */
function validateCommand(state, playerId, command) {
  const player = state.playersById[playerId];
  if (!player) return { ok: false, reason: "участник не найден" };

  switch (command.type) {
    case "TRADE": {
      if (command.action === "CLOSE") {
        if (!player.position) return { ok: false, reason: "нет открытой позиции" };
        const f = command.fraction ?? 1;
        if (!(f > 0 && f <= 1)) return { ok: false, reason: "неверная доля закрытия" };
        return { ok: true };
      }
      if (command.action !== "BUY" && command.action !== "SELL") {
        return { ok: false, reason: "неизвестное действие" };
      }
      // Встречное действие закрывает позицию и объёма не требует.
      const opposite = player.position &&
        player.position.side !== (command.action === "BUY" ? "long" : "short");
      if (opposite) return { ok: true };

      const notional = Number(command.notional);
      if (!Number.isFinite(notional) || notional <= 0) {
        return { ok: false, reason: "неверный объём" };
      }
      if (notional < minTrade(state)) return { ok: false, reason: "объём ниже минимального" };
      // Ключевая проверка: заявка не может превышать свободный кэш.
      // Плеча в модели нет, долг сломал бы замкнутость капитала.
      if (notional > player.cash + 1e-9) return { ok: false, reason: "недостаточно средств" };
      return { ok: true };
    }
    case "LIMIT": {
      const price = Number(command.limitPrice);
      const notional = Number(command.notional);
      if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: "неверная цена" };
      if (!Number.isFinite(notional) || notional < minTrade(state)) {
        return { ok: false, reason: "неверный объём" };
      }
      if (notional > player.cash + 1e-9) return { ok: false, reason: "недостаточно средств" };
      if (state.limitOrders.filter((o) => o.playerId === playerId).length >= 10) {
        return { ok: false, reason: "слишком много заявок" };
      }
      return { ok: true };
    }
    case "CANCEL_LIMIT": {
      const order = state.limitOrders.find((o) => o.id === command.orderId);
      if (!order) return { ok: false, reason: "заявка не найдена" };
      // Чужие заявки снимать нельзя.
      if (order.playerId !== playerId) return { ok: false, reason: "чужая заявка" };
      return { ok: true };
    }
    case "PROTECT": {
      if (!player.position) return { ok: false, reason: "нет открытой позиции" };
      for (const value of [command.stopLoss, command.takeProfit]) {
        if (value !== null && value !== undefined && !(Number(value) > 0)) {
          return { ok: false, reason: "неверный уровень" };
        }
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: "неизвестная команда" };
  }
}

/** Проекция участника для снапшота: только то, что клиенту можно знать. */
function projectPlayer(state, player, { viewer, devMode }) {
  const position = player.position;
  const projected = {
    id: player.id,
    name: player.name,
    isHuman: player.isHuman,
    archetype: player.npc ? player.npc.strategyType : null,
    startingCapital: player.startingCapital,
    cash: player.cash,
    tradeCount: player.tradeCount,
    realizedPnL: player.realizedPnL,
    equity: equityOf(player, state.price),
    unrealized: unrealizedPnL(player, state.price),
    position: position ? {
      side: position.side,
      units: position.units,
      margin: position.margin,
      entryPrice: position.entryPrice,
      openedAtTick: position.openedAtTick,
      settlement: settlementValue(position, state.price),
    } : null,
  };

  // Уровни защиты — приватные, их видит только владелец.
  if (viewer) {
    projected.stopLoss = player.stopLoss;
    projected.takeProfit = player.takeProfit;
  }

  // Внутренности бота — строго для разработки. В продакшене сервер
  // не должен отдавать это клиенту: зная память ботов, игрок торгует
  // не рынок, а движок.
  if (devMode && player.npc) {
    projected.debug = {
      lookback: player.npc.lookback,
      intervalTicks: player.npc.intervalTicks,
      accuracy: player.npc.accuracy,
      lastAction: player.mind.lastAction,
      lastActionTick: player.mind.lastActionTick,
      lastReasons: player.mind.lastReasons,
      wins: player.mind.wins,
      losses: player.mind.losses,
      mistakes: player.mind.mistakes,
      confidence: player.mind.confidence,
      regimeBias: player.mind.regimeBias,
      nextDecisionTick: player.mind.nextDecisionTick,
    };
  }
  return projected;
}

/**
 * Снапшот комнаты для конкретного зрителя.
 *
 * Это контракт между сервером и клиентом. Всё, чего здесь нет, клиент
 * знать не должен и вычислить не может.
 *
 * streamLimit ограничивает историю цен: гонять по сети шесть тысяч точек
 * на каждом тике нельзя. В сетевой версии сюда добавится дельта-режим —
 * снапшот целиком при входе в комнату, дальше только новые точки.
 */
function createSnapshot(state, viewerId, { devMode = false, streamLimit = 1200, level = "full" } = {}) {
  const market = aggregate(state);
  const players = state.players.map((p) =>
    projectPlayer(state, p, { viewer: p.id === viewerId, devMode })
  );
  const byEquity = [...players].sort((a, b) => b.equity - a.equity);
  const rank = byEquity.findIndex((p) => p.id === viewerId) + 1;
  const you = players.find((p) => p.id === viewerId) ?? null;

  const stream = state.priceHistory.length > streamLimit
    ? state.priceHistory.slice(-streamLimit)
    : state.priceHistory;

  /**
   * УРОВНИ СНАПШОТА — результат замера, а не вкусовщина.
   *
   * Полный снапшот с массивом из 100 участников весит ~47 КБ. На частоте
   * 10 раз в секунду это 470 КБ/с на игрока и ~30 МБ/с на комнату из ста.
   * Для Firestore это неподъёмно и технически, и по деньгам: там платят
   * за чтение документа, а тут выходит 1000 чтений в секунду на комнату.
   *
   * Поэтому поток разделён:
   *   level "tick" — цена, давления, агрегаты толпы и ВАША позиция.
   *                  Около 1 КБ, уходит на каждом тике.
   *   level "roster" — список участников. Раз в секунду или по запросу
   *                  экрана «Участники».
   *   level "full" — всё сразу. Только при входе в комнату и локально.
   */
  if (level === "tick") {
    return {
      roomId: state.roomId, tick: state.tick, time: state.time, phase: state.phase,
      price: state.price, previousPrice: state.previousPrice,
      initialPrice: CONFIG.market.initialPrice, symbol: CONFIG.market.assetSymbol,
      buyPressure: state.buyPressure, sellPressure: state.sellPressure,
      netPressure: state.netPressure, liquidity: state.liquidity,
      startingCapital: state.startingCapital, totalCapital: state.totalCapital,
      totalPlayers: state.players.length,
      totalTrades: state.totalTrades,
      market, rank, you,
      yourOrders: state.limitOrders.filter((o) => o.playerId === viewerId),
      lastPoint: state.priceHistory[state.priceHistory.length - 1],
    };
  }

  const snapshot = {
    roomId: state.roomId,
    tick: state.tick,
    time: state.time,
    phase: state.phase,

    price: state.price,
    previousPrice: state.previousPrice,
    initialPrice: CONFIG.market.initialPrice,
    symbol: CONFIG.market.assetSymbol,

    buyPressure: state.buyPressure,
    sellPressure: state.sellPressure,
    netPressure: state.netPressure,
    liquidity: state.liquidity,

    startingCapital: state.startingCapital,
    totalCapital: state.totalCapital,
    totalPlayers: state.players.length,
    totalTrades: state.totalTrades,

    market,
    players,
    rank,
    you,
    yourTrades: state.humanTrades,
    yourOrders: state.limitOrders.filter((o) => o.playerId === viewerId),
    orders: state.limitOrders.map((o) => ({
      id: o.id, playerId: o.playerId, side: o.side,
      notional: o.notional, limitPrice: o.limitPrice,
      playerName: state.playersById[o.playerId]?.name ?? o.playerId,
    })),
    priceStream: stream,

    debug: devMode ? {
      context: state.context,
      lastTrades: state.lastTickTrades,
      capitalDrift: state.capitalDrift,
      poolCash: state.poolCash,
    } : null,
  };
  return snapshot;
}

/**
 * КОМНАТА. Сегодня живёт в приложении, завтра — в Cloud Function / Cloud Run.
 * Внутри неё Market Engine не знает ни про сеть, ни про Firebase.
 */
class Room {
  constructor({ id = "local", startingCapital = CONFIG.market.startingCapital,
                seed = Date.now() % 2147483647, devMode = true } = {}) {
    this.id = id;
    this.devMode = devMode;
    this.engine = new SimulationEngine(seed, startingCapital);
    this.engine.getState().roomId = id;
    this.rejections = [];
  }

  /**
   * Единственная точка входа для действий игрока.
   * Возвращает результат валидации — в сетевой версии это ответ
   * Cloud Function, а не локальный вызов.
   */
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
        this.engine.submit({
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

  snapshotFor(viewerId) {
    return createSnapshot(this.engine.getState(), viewerId, { devMode: this.devMode });
  }
}

/**
 * ТРАНСПОРТ. Интерфейс между приложением и комнатой.
 *
 * Ровно этот контракт реализует и локальная, и будущая сетевая версия:
 *   start(onSnapshot) → подписка на состояние
 *   send(command)     → отправка намерения
 *   stop()            → отписка
 */
class LocalTransport {
  constructor({ startingCapital, seed, devMode = true } = {}) {
    this.room = new Room({ startingCapital, seed, devMode });
    this.playerId = HUMAN_ID;
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
  send(command) { return this.room.send(this.playerId, command); }
  snapshot() { return this.room.snapshotFor(this.playerId); }
  setSpeed(value) { this.speed = value; }
  setPaused(value) { this.room.paused = value; }
  get paused() { return this.room.paused; }
}

/**
 * ЗАГОТОВКА СЕТЕВОГО ТРАНСПОРТА.
 *
 * Намеренно не реализована: без реального проекта Firebase её нельзя
 * ни собрать, ни проверить, а неработающий код, притворяющийся рабочим,
 * хуже честной заготовки. Форма контракта здесь — это всё, что нужно
 * для переезда: подменяется одна строка создания транспорта.
 *
 *   const transport = new RemoteTransport({ roomId, playerId, functions, firestore });
 *
 * start():  firestore.doc(`rooms/${roomId}/state/current`).onSnapshot(...)
 * send():   httpsCallable(functions, 'submitCommand')({ roomId, command })
 *
 * На сервере submitCommand делает ровно то же, что Room.send:
 * валидация → движок → атомарная запись состояния комнаты.
 * Тик комнаты крутит отдельный процесс (Cloud Run), а не клиент —
 * иначе скорость симуляции становится клиентским параметром.
 */
class RemoteTransport {
  constructor() {
    throw new Error(
      "RemoteTransport ещё не подключён: нужен проект Firebase. " +
      "См. ARCHITECTURE.md — схема Firestore, Cloud Functions и правила доступа."
    );
  }
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
  async load() {
    try {
      const found = await window.storage.get(PROFILE_KEY);
      if (found?.value) return { ...emptyProfile(), ...JSON.parse(found.value) };
    } catch {
      // ключа ещё нет либо хранилище недоступно — начинаем с чистого профиля
    }
    return emptyProfile();
  },
  async save(profile) {
    try {
      await window.storage.set(PROFILE_KEY, JSON.stringify(profile));
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
function Lobby({ profile, onNew, onReset }) {
  const st = profileStats(profile);
  const affordable = CONFIG.market.capitalOptions.some((c) => c <= profile.wallet);

  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 overflow-y-auto px-6 pt-10 pb-4">
        <div className="text-[11px] tracking-[0.4em] mb-2" style={{ color: FAINT }}>ЗАКРЫТЫЙ РЫНОК</div>
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

/* ================================ ПРИЛОЖЕНИЕ ============================== */
export default function MarketSandbox() {
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
      wallet: profile.wallet + equity,
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
    return <Lobby profile={profile} onNew={() => setScreen("setup")}
      onReset={() => persist({ ...profile, wallet: STARTING_WALLET, deposited: profile.deposited + STARTING_WALLET })} />;
  }
  if (screen === "setup") {
    return <SessionSetup wallet={profile.wallet} onStart={startSession} onBack={() => setScreen("lobby")} />;
  }
  if (screen === "result" && result) {
    return <SessionResult result={result} onDone={() => { setResult(null); setScreen("lobby"); }} />;
  }
  if (!engineRef.current || !snapshot) {
    return <Lobby profile={profile} onNew={() => setScreen("setup")}
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
  /** Все действия игрока идут одним путём — через команду транспорту. */
  const send = (command) => {
    const res = transport.send(command);
    if (!res.ok) say(res.reason, SHORT);
    refresh();
    return res;
  };

  const buyHint = pos && pos.side === "short" ? "закроет Short" : "открыть / увеличить Long";
  const sellHint = pos && pos.side === "long" ? "закроет Long" : "открыть / увеличить Short";

  const doBuy = () => {
    const res = send({ type: "TRADE", action: "BUY", notional, reason: "ручная покупка" });
    if (res.ok) say(pos && pos.side === "short" ? "закрываем Short" : `покупка ${fmt(notional, 0)}`, LONG);
  };
  const doSell = () => {
    const res = send({ type: "TRADE", action: "SELL", notional, reason: "ручная продажа" });
    if (res.ok) say(pos && pos.side === "long" ? "закрываем Long" : `продажа ${fmt(notional, 0)}`, SHORT);
  };
  const doClose = (fraction, label) => {
    if (send({ type: "TRADE", action: "CLOSE", fraction, reason: "ручное закрытие" }).ok) say(label);
  };
  const setRisk = (kind, delta) => {
    if (!pos) return;
    const long = pos.side === "long";
    const target = kind === "sl"
      ? (long ? pos.entryPrice * (1 - delta) : pos.entryPrice * (1 + delta))
      : (long ? pos.entryPrice * (1 + delta) : pos.entryPrice * (1 - delta));
    const res = send({
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
            <button onClick={finishSession} className="rounded-lg py-3 text-[13px]"
              style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
              Завершить сессию · {fmt(equity)} на баланс
            </button>
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
                    <button onClick={() => { if (send({ type: "CANCEL_LIMIT", orderId: o.id }).ok) say("заявка снята"); }}
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
                        onClick={() => {
                          const res = send({
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

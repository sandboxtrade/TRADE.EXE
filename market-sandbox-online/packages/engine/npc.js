const { clamp, range } = require("./util");
const { unrealizedPnL } = require("./pnl");

/* ============================ ПОВЕДЕНИЕ ТОЛПЫ =============================
   Портировано без изменений из market-sandbox.jsx. См. оригинальные
   комментарии в клиентском прототипе для обоснования модели — здесь
   оставлены только рабочие определения.
--------------------------------------------------------------------------- */
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

function buildPopulation() {
  const list = [];
  for (const [key, a] of Object.entries(ARCHETYPES)) {
    for (let i = 0; i < a.count; i++) list.push(key);
  }
  return list;
}

const logistic = (x) => 1 / (1 + Math.exp(-x));

function createNPCProfile(rng, archetypeKey) {
  const a = ARCHETYPES[archetypeKey];
  return {
    strategyType: archetypeKey,
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
    target: range(rng, 0.010, 0.060),
    tolerance: range(rng, 0.015, 0.070),
    riskTolerance: range(rng, 0.15, 0.95),
  };
}

function createMind(rng, npc, tick) {
  return {
    nextDecisionTick: tick + Math.floor(rng() * npc.intervalTicks * 3),
    lastEntryTick: null,
    lastExitTick: null,
    restUntilTick: 0,
    wins: 0,
    losses: 0,
    confidence: range(rng, 0.8, 1.1),
    risk: 1,
    lastAction: "ожидание",
    lastActionTick: 0,
    lastReasons: [],
    regimeBias: 0,
    entryStyle: 0,
    pendingStyle: 0,
    mistakes: 0,
  };
}

function scheduleNext(mind, npc, rng, tick) {
  mind.nextDecisionTick = tick + Math.max(2, Math.round(npc.intervalTicks * range(rng, 0.55, 1.45)));
}

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

function detectPhase(ctx) {
  const imb = Math.abs(ctx.imbalance);
  if (ctx.speed < -0.010 && ctx.volatility > 0.0008) return "ПАНИКА";
  if (imb > 0.57 && ctx.crowdedness > 0.42) return "ПЕРЕГРЕВ";
  if (ctx.volatility > 0.0008 && imb > 0.28) return "ТРЕНД";
  if (ctx.volatility > 0.0008) return "ИМПУЛЬС";
  if (Math.abs(ctx.speed) < 0.0008 && ctx.volatility < 0.0003) return "ФЛЭТ";
  if (ctx.volatility < 0.0005 && ctx.crowdedness < 0.38) return "НАКОПЛЕНИЕ";
  return "РАВНОВЕСИЕ";
}

function decide(state, player, ctx, rng) {
  const npc = player.npc;
  const mind = player.mind;
  const reasons = [];

  const perceived = ctx.at(npc.perceptionLag);
  const past = ctx.at(npc.perceptionLag + npc.lookback);
  const mom = past > 0 ? perceived / past - 1 : 0;

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
      const full = rng() < (npc.strategyType === "panic" ? 0.65 : 0.42);
      const fraction = full ? 1 : range(rng, 0.3, 0.75);
      mind.lastReasons = reasons;
      return {
        playerId: player.id, action: "CLOSE", fraction, source: "npc",
        reason: fraction >= 1 ? "выход из позиции" : "частичная фиксация",
      };
    }

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

  if (state.tick < mind.restUntilTick) {
    mind.lastReasons = [["отдых после сделки", 0]];
    return null;
  }

  const momSignal = clamp(mom / 0.03, -3, 3);
  const speedSignal = clamp(ctx.speed / 0.012, -3, 3);
  const crowdSignal = ctx.imbalance;
  const noiseSignal = rng() * 2 - 1;

  const w = { ...npc.w, mom: npc.w.mom + mind.regimeBias * 0.7 };

  const parts = [
    ["импульс", w.mom * momSignal],
    ["скорость", w.speed * speedSignal],
    ["перекос толпы", w.crowd * crowdSignal],
    ["личный шум", w.noise * noiseSignal],
  ];
  let bias = parts.reduce((sum, [, v]) => sum + v, 0);

  const misread = rng() > npc.accuracy;
  if (misread) {
    bias = -bias * range(rng, 0.5, 1);
    parts.push(["ошибся в направлении", -1]);
    mind.mistakes++;
  }
  const strength = Math.abs(bias);

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
  mind.pendingStyle = Math.sign(momSignal) === Math.sign(bias) ? 1 : -1;
  return {
    playerId: player.id,
    action: bias > 0 ? "BUY" : "SELL",
    notional,
    source: "npc",
    reason: ARCHETYPES[npc.strategyType].label.toLowerCase(),
  };
}

function recordEntry(player, state, notional, side) {
  const mind = player.mind;
  mind.entryStyle = mind.pendingStyle;
  mind.lastEntryTick = state.tick;
  mind.lastAction = `${side === "long" ? "ЛОНГ" : "ШОРТ"} ${notional.toFixed(0)}`;
  mind.lastActionTick = state.tick;
}

function recordExit(player, state, realized, full) {
  const mind = player.mind;
  const npc = player.npc;
  if (realized >= 0) mind.wins++; else mind.losses++;
  mind.confidence = clamp(mind.confidence + (realized >= 0 ? 0.06 : -0.09), 0.5, 1.5);
  mind.risk = clamp(1 + (mind.wins - mind.losses) * 0.05, 0.4, 1.5);
  if (mind.entryStyle !== 0) {
    mind.regimeBias = clamp(
      mind.regimeBias + (realized >= 0 ? 0.15 : -0.15) * mind.entryStyle, -1, 1
    );
  }
  mind.lastAction = `${full ? "ЗАКРЫЛ" : "СОКРАТИЛ"} ${realized >= 0 ? "+" : "-"}${Math.abs(realized).toFixed(2)}`;
  mind.lastActionTick = state.tick;
  if (full) {
    mind.lastExitTick = state.tick;
    const [lo, hi] = npc.restRange;
    const rest = range(state.rng, lo, hi) * (realized < 0 ? 1.6 : 1);
    mind.restUntilTick = state.tick + Math.round(rest);
  }
}

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

module.exports = {
  ARCHETYPES, STRATEGY_LABELS, buildPopulation, logistic,
  createNPCProfile, createMind, scheduleNext, buildMarketContext,
  detectPhase, decide, recordEntry, recordExit, collectNPCIntents,
};

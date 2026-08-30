var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// engine/config.js
var require_config = __commonJS({
  "engine/config.js"(exports, module) {
    var CONFIG2 = {
      market: {
        assetSymbol: "SIM",
        totalPlayers: 100,
        startingCapital: 100,
        capitalOptions: [100, 500, 1e3, 1e4],
        initialPrice: 100,
        tickMs: 100,
        minPrice: 0.01
      },
      price: { maxTickMove: 0.02, sensitivity: 0.12, pressureDecay: 0.45, pressureFloor: 0.01 },
      liquidity: { base: 250, freeCashWeight: 0.45, poolWeight: 0.35, openInterestPenalty: 0.9, min: 120 },
      impact: { coefficient: 0.55, maxImpact: 0.05 },
      risk: { shortLiquidationRatio: 0.05 },
      history: { maxPoints: 6e3 }
    };
    var REFERENCE_CAPITAL = CONFIG2.market.totalPlayers * CONFIG2.market.startingCapital;
    var scaleOf = (state) => state.totalCapital / REFERENCE_CAPITAL;
    var minTrade = (state) => 0.5 * scaleOf(state);
    var HUMAN_ID2 = "p-000";
    module.exports = { CONFIG: CONFIG2, REFERENCE_CAPITAL, scaleOf, minTrade, HUMAN_ID: HUMAN_ID2 };
  }
});

// engine/util.js
var require_util = __commonJS({
  "engine/util.js"(exports, module) {
    function mulberry32(seed) {
      let a = seed >>> 0;
      return function() {
        a |= 0;
        a = a + 1831565813 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    var pick = (rng, items) => items[Math.floor(rng() * items.length)];
    var range = (rng, min, max) => min + rng() * (max - min);
    var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    var money = (v, d = 2) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    })}`;
    var signed = (v, d = 2) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toLocaleString("en-US", {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    })}`;
    var pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
    var signedPct2 = (v, d = 2) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
    var clock2 = (ms) => {
      const total = Math.floor(ms / 1e3);
      return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    };
    module.exports = { mulberry32, pick, range, clamp, money, signed, pct, signedPct: signedPct2, clock: clock2 };
  }
});

// engine/price.js
var require_price = __commonJS({
  "engine/price.js"(exports, module) {
    var { CONFIG: CONFIG2 } = require_config();
    function decayPressure(previous, incoming, scale = 1) {
      const next = previous * CONFIG2.price.pressureDecay + incoming;
      return next < CONFIG2.price.pressureFloor * scale ? 0 : next;
    }
    function nextPrice({ price, buyPressure, sellPressure, liquidity, scale = 1 }) {
      const netPressure = buyPressure - sellPressure;
      const safeLiquidity = Math.max(liquidity, CONFIG2.liquidity.min * scale);
      const impulse = netPressure / safeLiquidity;
      const returnRate = CONFIG2.price.maxTickMove * Math.tanh(impulse / CONFIG2.price.sensitivity);
      return { price: Math.max(CONFIG2.market.minPrice, price * (1 + returnRate)), returnRate, netPressure, impulse };
    }
    module.exports = { decayPressure, nextPrice };
  }
});

// engine/liquidity.js
var require_liquidity = __commonJS({
  "engine/liquidity.js"(exports, module) {
    var { CONFIG: CONFIG2, scaleOf } = require_config();
    function computeLiquidity(state) {
      let freeCash = 0;
      let openInterest = 0;
      for (const p of state.players) {
        freeCash += p.cash;
        if (p.position) openInterest += p.position.units * state.price;
      }
      const scale = scaleOf(state);
      const raw = CONFIG2.liquidity.base * scale + freeCash * CONFIG2.liquidity.freeCashWeight + Math.max(0, state.poolCash) * CONFIG2.liquidity.poolWeight;
      const saturation = 1 + CONFIG2.liquidity.openInterestPenalty * (openInterest / Math.max(1, state.totalCapital));
      return Math.max(CONFIG2.liquidity.min * scale, raw / saturation);
    }
    function executionPrice(ref, notional, liquidity, direction, scale = 1) {
      const magnitude = Math.min(
        CONFIG2.impact.maxImpact,
        CONFIG2.impact.coefficient * Math.abs(notional) / Math.max(liquidity, CONFIG2.liquidity.min * scale)
      );
      return Math.max(CONFIG2.market.minPrice, ref * (1 + magnitude * direction));
    }
    module.exports = { computeLiquidity, executionPrice };
  }
});

// engine/pnl.js
var require_pnl = __commonJS({
  "engine/pnl.js"(exports, module) {
    var { CONFIG: CONFIG2, scaleOf } = require_config();
    var { executionPrice } = require_liquidity();
    function settlementValue(pos, price) {
      if (pos.side === "long") return pos.units * price;
      return Math.max(0, pos.margin + (pos.entryPrice - price) * pos.units);
    }
    function projectedSettlement(state, pos) {
      const direction = pos.side === "long" ? -1 : 1;
      const exposure = pos.units * state.price;
      const execPrice = executionPrice(state.price, exposure, state.liquidity, direction, scaleOf(state));
      return settlementValue(pos, execPrice);
    }
    var unrealizedPnL = (p, price) => p.position ? settlementValue(p.position, price) - p.position.margin : 0;
    var equityOf = (p, price) => p.cash + (p.position ? settlementValue(p.position, price) : 0);
    var isLiquidatable = (pos, price) => pos.side === "short" && settlementValue(pos, price) <= pos.margin * CONFIG2.risk.shortLiquidationRatio;
    function aggregate(state) {
      let totalEquity = 0, totalCash = 0, longExposure = 0, shortExposure = 0;
      let longPlayers = 0, shortPlayers = 0, settlementTotal = 0;
      for (const p of state.players) {
        totalCash += p.cash;
        totalEquity += equityOf(p, state.price);
        if (p.position) {
          settlementTotal += settlementValue(p.position, state.price);
          const exposure = p.position.units * state.price;
          if (p.position.side === "long") {
            longExposure += exposure;
            longPlayers++;
          } else {
            shortExposure += exposure;
            shortPlayers++;
          }
        }
      }
      const directional = longPlayers + shortPlayers;
      return {
        totalEquity,
        totalCash,
        longExposure,
        shortExposure,
        longPlayers,
        shortPlayers,
        flatPlayers: state.players.length - directional,
        activePositions: directional,
        poolEquity: state.poolCash - settlementTotal,
        marketCap: state.price * CONFIG2.market.totalPlayers,
        longShare: directional === 0 ? 0 : longPlayers / directional,
        shortShare: directional === 0 ? 0 : shortPlayers / directional
      };
    }
    module.exports = { settlementValue, projectedSettlement, unrealizedPnL, equityOf, isLiquidatable, aggregate };
  }
});

// engine/npc.js
var require_npc = __commonJS({
  "engine/npc.js"(exports, module) {
    var { clamp, range } = require_util();
    var { unrealizedPnL } = require_pnl();
    var ARCHETYPES = {
      aggressive: {
        label: "\u0410\u0433\u0440\u0435\u0441\u0441\u0438\u0432\u043D\u044B\u0439",
        count: 10,
        accuracy: 0.48,
        interval: [10, 30],
        perception: [0, 4],
        lookback: [10, 40],
        size: [0.2, 1],
        inertia: 0.72,
        rest: [15, 60],
        w: { mom: 1.1, speed: 0.85, crowd: 0.1, noise: 0.85 },
        exit: { take: 0.85, pain: 1.35, shock: 0.5, patience: 900 },
        addProb: 0.35,
        slProb: 0.25,
        tpProb: 0.3
      },
      conservative: {
        label: "\u041E\u0441\u0442\u043E\u0440\u043E\u0436\u043D\u044B\u0439",
        count: 15,
        accuracy: 0.55,
        interval: [30, 80],
        perception: [2, 10],
        lookback: [30, 90],
        size: [0.05, 0.3],
        inertia: 1.3,
        rest: [60, 200],
        w: { mom: 0.7, speed: 0.25, crowd: 0.2, noise: 0.3 },
        exit: { take: 1.55, pain: 1.1, shock: 0.3, patience: 600 },
        addProb: 0.05,
        slProb: 0.65,
        tpProb: 0.7
      },
      trend: {
        label: "\u0422\u0440\u0435\u043D\u0434\u043E\u0432\u044B\u0439",
        count: 10,
        accuracy: 0.6,
        interval: [12, 38],
        perception: [0, 6],
        lookback: [15, 50],
        size: [0.1, 0.45],
        inertia: 0.95,
        rest: [25, 90],
        w: { mom: 1.35, speed: 0.55, crowd: 0.25, noise: 0.35 },
        exit: { take: 1, pain: 1.2, shock: 0.4, patience: 800 },
        addProb: 0.22,
        slProb: 0.45,
        tpProb: 0.45
      },
      contrarian: {
        label: "\u041A\u043E\u043D\u0442\u0440\u0442\u0440\u0435\u043D\u0434\u043E\u0432\u044B\u0439",
        count: 10,
        accuracy: 0.52,
        interval: [25, 65],
        perception: [1, 8],
        lookback: [25, 80],
        size: [0.08, 0.35],
        inertia: 1.1,
        rest: [40, 140],
        w: { mom: -1.15, speed: -0.45, crowd: -0.55, noise: 0.4 },
        exit: { take: 1.2, pain: 1, shock: 0.25, patience: 1200 },
        addProb: 0.1,
        slProb: 0.5,
        tpProb: 0.6
      },
      impulsive: {
        label: "\u0418\u043C\u043F\u0443\u043B\u044C\u0441\u0438\u0432\u043D\u044B\u0439",
        count: 10,
        accuracy: 0.45,
        interval: [8, 26],
        perception: [0, 5],
        lookback: [8, 25],
        size: [0.15, 0.6],
        inertia: 1.35,
        rest: [30, 110],
        w: { mom: 0.75, speed: 1.7, crowd: 0.45, noise: 0.3 },
        exit: { take: 0.7, pain: 1.5, shock: 0.8, patience: 400 },
        addProb: 0.25,
        slProb: 0.25,
        tpProb: 0.3
      },
      patient: {
        label: "\u0422\u0435\u0440\u043F\u0435\u043B\u0438\u0432\u044B\u0439",
        count: 10,
        accuracy: 0.58,
        interval: [90, 260],
        perception: [4, 14],
        lookback: [80, 220],
        size: [0.1, 0.4],
        inertia: 1.2,
        rest: [200, 700],
        w: { mom: 0.9, speed: 0.05, crowd: 0.1, noise: 0.25 },
        exit: { take: 1.4, pain: 0.9, shock: 0.05, patience: 4e3 },
        addProb: 0.08,
        slProb: 0.4,
        tpProb: 0.45
      },
      scalper: {
        label: "\u0421\u043A\u0430\u043B\u044C\u043F\u0435\u0440",
        count: 10,
        accuracy: 0.53,
        interval: [4, 14],
        perception: [0, 2],
        lookback: [6, 20],
        size: [0.04, 0.18],
        inertia: 0.7,
        rest: [5, 25],
        w: { mom: 0.6, speed: 0.9, crowd: 0.1, noise: 0.7 },
        exit: { take: 0.55, pain: 1.3, shock: 0.6, patience: 120 },
        addProb: 0.05,
        slProb: 0.55,
        tpProb: 0.65
      },
      panic: {
        label: "\u041F\u0430\u043D\u0438\u043A\u0451\u0440",
        count: 10,
        accuracy: 0.5,
        interval: [6, 22],
        perception: [0, 3],
        lookback: [20, 60],
        size: [0.1, 0.4],
        inertia: 1.55,
        rest: [80, 260],
        w: { mom: 0.55, speed: 0.3, crowd: 0.3, noise: 0.3 },
        exit: { take: 0.8, pain: 2.4, shock: 2.6, patience: 500 },
        addProb: 0.02,
        slProb: 0.55,
        tpProb: 0.4
      },
      confident: {
        label: "\u0423\u0432\u0435\u0440\u0435\u043D\u043D\u044B\u0439",
        count: 10,
        accuracy: 0.56,
        interval: [40, 120],
        perception: [2, 10],
        lookback: [40, 140],
        size: [0.15, 0.55],
        inertia: 1.15,
        rest: [60, 220],
        w: { mom: 0.95, speed: 0.1, crowd: -0.15, noise: 0.3 },
        exit: { take: 1.3, pain: 0.35, shock: 0.1, patience: 3e3 },
        addProb: 0.18,
        slProb: 0.15,
        tpProb: 0.35
      },
      random: {
        label: "\u042D\u043A\u0441\u043F\u0435\u0440\u0438\u043C\u0435\u043D\u0442\u0430\u0442\u043E\u0440",
        count: 4,
        accuracy: 0.42,
        interval: [20, 80],
        perception: [0, 12],
        lookback: [5, 120],
        size: [0.01, 0.35],
        inertia: 0.8,
        rest: [30, 140],
        w: { mom: 0.15, speed: 0.1, crowd: 0.05, noise: 1.7 },
        exit: { take: 1, pain: 1, shock: 0.2, patience: 700 },
        addProb: 0.08,
        slProb: 0.2,
        tpProb: 0.2
      }
    };
    var STRATEGY_LABELS2 = Object.fromEntries(
      Object.entries(ARCHETYPES).map(([key, a]) => [key, a.label])
    );
    function buildPopulation() {
      const list = [];
      for (const [key, a] of Object.entries(ARCHETYPES)) {
        for (let i = 0; i < a.count; i++) list.push(key);
      }
      return list;
    }
    var logistic = (x) => 1 / (1 + Math.exp(-x));
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
        target: range(rng, 0.01, 0.06),
        tolerance: range(rng, 0.015, 0.07),
        riskTolerance: range(rng, 0.15, 0.95)
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
        lastAction: "\u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435",
        lastActionTick: 0,
        lastReasons: [],
        regimeBias: 0,
        entryStyle: 0,
        pendingStyle: 0,
        mistakes: 0
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
        if (h[i - 1].price > 0) {
          sum += Math.abs(h[i].price / h[i - 1].price - 1);
          count++;
        }
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
        sellPressure: state.sellPressure
      };
    }
    function detectPhase(ctx) {
      const imb = Math.abs(ctx.imbalance);
      if (ctx.speed < -0.01 && ctx.volatility > 8e-4) return "\u041F\u0410\u041D\u0418\u041A\u0410";
      if (imb > 0.57 && ctx.crowdedness > 0.42) return "\u041F\u0415\u0420\u0415\u0413\u0420\u0415\u0412";
      if (ctx.volatility > 8e-4 && imb > 0.28) return "\u0422\u0420\u0415\u041D\u0414";
      if (ctx.volatility > 8e-4) return "\u0418\u041C\u041F\u0423\u041B\u042C\u0421";
      if (Math.abs(ctx.speed) < 8e-4 && ctx.volatility < 3e-4) return "\u0424\u041B\u042D\u0422";
      if (ctx.volatility < 5e-4 && ctx.crowdedness < 0.38) return "\u041D\u0410\u041A\u041E\u041F\u041B\u0415\u041D\u0418\u0415";
      return "\u0420\u0410\u0412\u041D\u041E\u0412\u0415\u0421\u0418\u0415";
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
        const adverse = pos.side === "long" && ctx.speed < 0 || pos.side === "short" && ctx.speed > 0;
        const takeScore = Math.max(0, pnlRatio) / npc.target;
        const painScore = Math.max(0, -pnlRatio) / npc.tolerance;
        const shockScore = Math.max(0, Math.abs(ctx.speed) - 8e-3) / 0.02 * (adverse ? 1.6 : 0.5);
        const timeScore = holdTicks / npc.exit.patience;
        const luck = (rng() - 0.5) * 0.7;
        const drive = npc.exit.take * 0.35 * takeScore + npc.exit.pain * painScore + npc.exit.shock * shockScore + timeScore + luck;
        if (takeScore > 0.05) reasons.push(["\u043F\u0440\u0438\u0431\u044B\u043B\u044C", npc.exit.take * takeScore]);
        if (painScore > 0.05) reasons.push(["\u0443\u0431\u044B\u0442\u043E\u043A", npc.exit.pain * painScore]);
        if (shockScore > 0.05) reasons.push(["\u0440\u0435\u0437\u043A\u043E\u0435 \u0434\u0432\u0438\u0436\u0435\u043D\u0438\u0435", npc.exit.shock * shockScore]);
        if (timeScore > 0.1) reasons.push(["\u0432\u0440\u0435\u043C\u044F \u0432 \u043F\u043E\u0437\u0438\u0446\u0438\u0438", timeScore]);
        if (rng() < logistic(2.5 * (drive - 1))) {
          const full = rng() < (npc.strategyType === "panic" ? 0.65 : 0.42);
          const fraction2 = full ? 1 : range(rng, 0.3, 0.75);
          mind.lastReasons = reasons;
          return {
            playerId: player.id,
            action: "CLOSE",
            fraction: fraction2,
            source: "npc",
            reason: fraction2 >= 1 ? "\u0432\u044B\u0445\u043E\u0434 \u0438\u0437 \u043F\u043E\u0437\u0438\u0446\u0438\u0438" : "\u0447\u0430\u0441\u0442\u0438\u0447\u043D\u0430\u044F \u0444\u0438\u043A\u0441\u0430\u0446\u0438\u044F"
          };
        }
        const aligned = pos.side === "long" && mom > 0 || pos.side === "short" && mom < 0;
        if (aligned && pnlRatio > 4e-3 && rng() < npc.addProb * mind.confidence * 0.35) {
          const extra = player.cash * range(rng, npc.sizeRange[0], npc.sizeRange[1]) * 0.5;
          if (extra >= 1) {
            reasons.push(["\u043F\u043E\u0437\u0438\u0446\u0438\u044F \u0432 \u043F\u043B\u044E\u0441\u0435", pnlRatio / npc.target]);
            reasons.push(["\u0441\u0438\u0433\u043D\u0430\u043B \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0435\u0442\u0441\u044F", Math.abs(mom) / 0.02]);
            mind.lastReasons = reasons;
            return {
              playerId: player.id,
              action: pos.side === "long" ? "BUY" : "SELL",
              notional: extra,
              source: "npc",
              reason: "\u043D\u0430\u0440\u0430\u0449\u0438\u0432\u0430\u043D\u0438\u0435 \u043F\u043E\u0437\u0438\u0446\u0438\u0438"
            };
          }
        }
        if (player.stopLoss === null && rng() < npc.slProb * 0.3) {
          const distance = 0.01 + npc.riskTolerance * 0.035;
          player.stopLoss = pos.side === "long" ? pos.entryPrice * (1 - distance) : pos.entryPrice * (1 + distance);
          mind.lastAction = `\u0441\u0442\u043E\u043F ${player.stopLoss.toFixed(2)}`;
          mind.lastActionTick = state.tick;
          mind.lastReasons = [["\u0437\u0430\u0449\u0438\u0442\u0430 \u043F\u043E\u0437\u0438\u0446\u0438\u0438", 1]];
          return null;
        }
        if (player.takeProfit === null && rng() < npc.tpProb * 0.3) {
          const distance = npc.target * range(rng, 0.9, 1.8);
          player.takeProfit = pos.side === "long" ? pos.entryPrice * (1 + distance) : pos.entryPrice * (1 - distance);
          mind.lastAction = `\u0442\u0435\u0439\u043A ${player.takeProfit.toFixed(2)}`;
          mind.lastActionTick = state.tick;
          mind.lastReasons = [["\u0446\u0435\u043B\u044C \u043F\u043E \u043F\u0440\u0438\u0431\u044B\u043B\u0438", 1]];
          return null;
        }
        mind.lastReasons = reasons.length ? reasons : [["\u0434\u0435\u0440\u0436\u0438\u0442 \u043F\u043E\u0437\u0438\u0446\u0438\u044E", 0]];
        return null;
      }
      if (state.tick < mind.restUntilTick) {
        mind.lastReasons = [["\u043E\u0442\u0434\u044B\u0445 \u043F\u043E\u0441\u043B\u0435 \u0441\u0434\u0435\u043B\u043A\u0438", 0]];
        return null;
      }
      const momSignal = clamp(mom / 0.03, -3, 3);
      const speedSignal = clamp(ctx.speed / 0.012, -3, 3);
      const crowdSignal = ctx.imbalance;
      const noiseSignal = rng() * 2 - 1;
      const w = { ...npc.w, mom: npc.w.mom + mind.regimeBias * 0.7 };
      const parts = [
        ["\u0438\u043C\u043F\u0443\u043B\u044C\u0441", w.mom * momSignal],
        ["\u0441\u043A\u043E\u0440\u043E\u0441\u0442\u044C", w.speed * speedSignal],
        ["\u043F\u0435\u0440\u0435\u043A\u043E\u0441 \u0442\u043E\u043B\u043F\u044B", w.crowd * crowdSignal],
        ["\u043B\u0438\u0447\u043D\u044B\u0439 \u0448\u0443\u043C", w.noise * noiseSignal]
      ];
      let bias = parts.reduce((sum, [, v]) => sum + v, 0);
      const misread = rng() > npc.accuracy;
      if (misread) {
        bias = -bias * range(rng, 0.5, 1);
        parts.push(["\u043E\u0448\u0438\u0431\u0441\u044F \u0432 \u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0438", -1]);
        mind.mistakes++;
      }
      const strength = Math.abs(bias);
      const crowdBrake = 1 - 0.45 * Math.max(0, ctx.crowdedness - 0.55) / 0.45;
      const pOpen = logistic(2.2 * (strength - npc.inertia * 0.8)) * crowdBrake * mind.risk;
      if (rng() > pOpen) {
        mind.lastReasons = parts.filter(([, v]) => Math.abs(v) > 0.05);
        return null;
      }
      const fraction = range(rng, npc.sizeRange[0], npc.sizeRange[1]) * clamp(mind.confidence * mind.risk, 0.35, 1.4);
      const notional = player.cash * Math.min(0.98, fraction);
      if (notional < 1) return null;
      mind.lastReasons = parts.filter(([, v]) => Math.abs(v) > 0.05);
      mind.pendingStyle = Math.sign(momSignal) === Math.sign(bias) ? 1 : -1;
      return {
        playerId: player.id,
        action: bias > 0 ? "BUY" : "SELL",
        notional,
        source: "npc",
        reason: ARCHETYPES[npc.strategyType].label.toLowerCase()
      };
    }
    function recordEntry(player, state, notional, side) {
      const mind = player.mind;
      mind.entryStyle = mind.pendingStyle;
      mind.lastEntryTick = state.tick;
      mind.lastAction = `${side === "long" ? "\u041B\u041E\u041D\u0413" : "\u0428\u041E\u0420\u0422"} ${notional.toFixed(0)}`;
      mind.lastActionTick = state.tick;
    }
    function recordExit(player, state, realized, full) {
      const mind = player.mind;
      const npc = player.npc;
      if (realized >= 0) mind.wins++;
      else mind.losses++;
      mind.confidence = clamp(mind.confidence + (realized >= 0 ? 0.06 : -0.09), 0.5, 1.5);
      mind.risk = clamp(1 + (mind.wins - mind.losses) * 0.05, 0.4, 1.5);
      if (mind.entryStyle !== 0) {
        mind.regimeBias = clamp(
          mind.regimeBias + (realized >= 0 ? 0.15 : -0.15) * mind.entryStyle,
          -1,
          1
        );
      }
      mind.lastAction = `${full ? "\u0417\u0410\u041A\u0420\u042B\u041B" : "\u0421\u041E\u041A\u0420\u0410\u0422\u0418\u041B"} ${realized >= 0 ? "+" : "-"}${Math.abs(realized).toFixed(2)}`;
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
      ARCHETYPES,
      STRATEGY_LABELS: STRATEGY_LABELS2,
      buildPopulation,
      logistic,
      createNPCProfile,
      createMind,
      scheduleNext,
      buildMarketContext,
      detectPhase,
      decide,
      recordEntry,
      recordExit,
      collectNPCIntents
    };
  }
});

// engine/orders.js
var require_orders = __commonJS({
  "engine/orders.js"(exports, module) {
    var { HUMAN_ID: HUMAN_ID2, minTrade, scaleOf } = require_config();
    var { executionPrice } = require_liquidity();
    var { settlementValue } = require_pnl();
    var { clamp } = require_util();
    var { recordEntry, recordExit } = require_npc();
    function pushTrade(state, rec) {
      state.lastTickTrades.push(rec);
      state.totalTrades++;
      if (rec.flow === "buy") state.rawBuyPressure += rec.notional;
      else state.rawSellPressure += rec.notional;
      if (state.humanIds && state.humanIds.has(rec.playerId)) {
        if (!state.humanTradesById[rec.playerId]) state.humanTradesById[rec.playerId] = [];
        const list = state.humanTradesById[rec.playerId];
        list.unshift(rec);
        if (list.length > 60) list.pop();
      }
    }
    function closePosition(state, player, reason, fraction = 1) {
      const pos = player.position;
      if (!pos) return null;
      const f = clamp(fraction, 0, 1);
      const remainingMargin = pos.margin * (1 - f);
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
        tick: state.tick,
        time: state.time,
        playerId: player.id,
        playerName: player.name,
        action: "CLOSE",
        flow: side === "long" ? "sell" : "buy",
        notional: exposure,
        units,
        execPrice,
        realizedPnL: realized,
        reason: full ? reason : `${reason} (\u0447\u0430\u0441\u0442\u0438\u0447\u043D\u043E)`
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
        tick: state.tick,
        time: state.time,
        playerId: player.id,
        playerName: player.name,
        action: side === "long" ? "BUY" : "SELL",
        flow: side === "long" ? "buy" : "sell",
        notional,
        units,
        execPrice,
        reason
      };
      pushTrade(state, rec);
      return rec;
    }
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
        const closed = closePosition(state, player, `${intent.reason} (\u0434\u043E\u043B\u0438\u0432\u043A\u0430)`);
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
          playerId: o.playerId,
          action: o.side === "buy" ? "BUY" : "SELL",
          notional: o.notional,
          source: "system",
          reason: `\u043B\u0438\u043C\u0438\u0442 @ ${o.limitPrice.toFixed(2)}`
        });
        return false;
      });
      return triggered;
    }
    module.exports = { pushTrade, closePosition, openPosition, executeIntent, triggerLimitOrders };
  }
});

// engine/simulation.js
var require_simulation = __commonJS({
  "engine/simulation.js"(exports, module) {
    var { CONFIG: CONFIG2, HUMAN_ID: HUMAN_ID2, scaleOf } = require_config();
    var { mulberry32, range } = require_util();
    var { decayPressure, nextPrice } = require_price();
    var { computeLiquidity } = require_liquidity();
    var { isLiquidatable } = require_pnl();
    var {
      buildPopulation,
      createNPCProfile,
      createMind,
      buildMarketContext,
      collectNPCIntents
    } = require_npc();
    var { executeIntent, triggerLimitOrders } = require_orders();
    function createMarket(seed, startingCapital = CONFIG2.market.startingCapital) {
      const rng = mulberry32(seed);
      const base = () => ({
        startingCapital,
        cash: startingCapital,
        position: null,
        realizedPnL: 0,
        stopLoss: null,
        takeProfit: null,
        tradeCount: 0,
        mind: null
      });
      const population = buildPopulation();
      for (let i = population.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [population[i], population[j]] = [population[j], population[i]];
      }
      const players = [];
      for (let i = 0; i < CONFIG2.market.totalPlayers; i++) {
        const npc = createNPCProfile(rng, population[i] ?? "random");
        players.push({
          id: `bot-${String(i).padStart(3, "0")}`,
          name: `\u0411\u043E\u0442 ${String(i + 1).padStart(2, "0")}`,
          isHuman: false,
          ...base(),
          npc,
          mind: createMind(rng, npc, 0)
        });
      }
      const playersById = {};
      for (const p of players) playersById[p.id] = p;
      const state = {
        roomId: "local",
        tick: 0,
        time: 0,
        price: CONFIG2.market.initialPrice,
        previousPrice: CONFIG2.market.initialPrice,
        players,
        playersById,
        poolCash: 0,
        startingCapital,
        totalCapital: CONFIG2.market.totalPlayers * startingCapital,
        limitOrders: [],
        rawBuyPressure: 0,
        rawSellPressure: 0,
        buyPressure: 0,
        sellPressure: 0,
        netPressure: 0,
        liquidity: 0,
        priceHistory: [{ t: 0, price: CONFIG2.market.initialPrice, volume: 0 }],
        lastTickTrades: [],
        humanTradesById: {},
        humanIds: /* @__PURE__ */ new Set(),
        totalTrades: 0,
        capitalDrift: 0,
        context: null,
        phase: "\u041D\u0410\u041A\u041E\u041F\u041B\u0415\u041D\u0418\u0415",
        rng
      };
      state.liquidity = computeLiquidity(state);
      state.context = buildMarketContext(state);
      return { state, rng };
    }
    function takeOverSlot(state, uid, name) {
      if (state.playersById[uid]) return uid;
      const candidates = state.players.filter((p) => !p.isHuman);
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => {
        const aFlat = a.position ? 1 : 0, bFlat = b.position ? 1 : 0;
        if (aFlat !== bFlat) return aFlat - bFlat;
        return (a.position?.margin ?? 0) - (b.position?.margin ?? 0);
      });
      const bot = candidates[0];
      if (bot.position) {
        const { closePosition } = require_orders();
        closePosition(state, bot, "\u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0430 \u043C\u0435\u0441\u0442\u0430 \u0438\u0433\u0440\u043E\u043A\u0443");
      }
      delete state.playersById[bot.id];
      bot.id = uid;
      bot.name = name || "\u0418\u0433\u0440\u043E\u043A";
      bot.isHuman = true;
      bot.npc = null;
      bot.mind = null;
      state.playersById[uid] = bot;
      state.humanIds.add(uid);
      state.humanTradesById[uid] = state.humanTradesById[uid] ?? [];
      return uid;
    }
    function releaseSlot(state, uid) {
      const player = state.playersById[uid];
      if (!player || !player.isHuman) return;
      const { closePosition } = require_orders();
      if (player.position) closePosition(state, player, "\u0432\u044B\u0445\u043E\u0434 \u0438\u0437 \u043A\u043E\u043C\u043D\u0430\u0442\u044B");
      const npc = createNPCProfile(state.rng, "random");
      player.isHuman = false;
      player.npc = npc;
      player.mind = createMind(state.rng, npc, state.tick);
      player.name = `\u0411\u043E\u0442 ${player.id}`;
      state.humanIds.delete(uid);
    }
    function collectProtectiveIntents(state) {
      const intents = [];
      for (const player of state.players) {
        const pos = player.position;
        if (!pos) continue;
        if (isLiquidatable(pos, state.price)) {
          intents.push({ playerId: player.id, action: "CLOSE", source: "system", reason: "\u043B\u0438\u043A\u0432\u0438\u0434\u0430\u0446\u0438\u044F" });
          continue;
        }
        const long = pos.side === "long";
        if (player.stopLoss !== null) {
          const hit = long ? state.price <= player.stopLoss : state.price >= player.stopLoss;
          if (hit) {
            intents.push({ playerId: player.id, action: "CLOSE", source: "system", reason: "\u0441\u0442\u043E\u043F-\u043B\u043E\u0441\u0441" });
            continue;
          }
        }
        if (player.takeProfit !== null) {
          const hit = long ? state.price >= player.takeProfit : state.price <= player.takeProfit;
          if (hit) intents.push({ playerId: player.id, action: "CLOSE", source: "system", reason: "\u0442\u0435\u0439\u043A-\u043F\u0440\u043E\u0444\u0438\u0442" });
        }
      }
      return intents;
    }
    function step(state, incoming) {
      state.tick++;
      state.time += CONFIG2.market.tickMs;
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
        t: state.time,
        price: state.price,
        volume: state.rawBuyPressure + state.rawSellPressure
      });
      if (state.priceHistory.length > CONFIG2.history.maxPoints) {
        state.priceHistory.splice(0, state.priceHistory.length - CONFIG2.history.maxPoints);
      }
      let cashSum = 0;
      for (const p of state.players) cashSum += p.cash;
      state.capitalDrift = cashSum + state.poolCash - state.totalCapital;
    }
    var SimulationEngine = class _SimulationEngine {
      constructor(seed = Date.now() % 2147483647, startingCapital = CONFIG2.market.startingCapital) {
        this.startingCapital = startingCapital;
        const created = createMarket(seed, startingCapital);
        this.state = created.state;
        this.rng = created.rng;
        this.queue = [];
        this.orderSeq = 0;
        this.paused = false;
      }
      getState() {
        return this.state;
      }
      /** Практический (офлайн) режим: единственный человек занимает p-000 сразу. */
      static localSinglePlayer(seed, startingCapital) {
        const engine = new _SimulationEngine(seed, startingCapital);
        takeOverSlot(engine.state, HUMAN_ID2, "\u0412\u042B");
        return engine;
      }
      addHuman(uid, name) {
        return takeOverSlot(this.state, uid, name);
      }
      removeHuman(uid) {
        releaseSlot(this.state, uid);
      }
      submit(playerId, intent) {
        this.queue.push({ ...intent, playerId, source: "human" });
      }
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
    };
    module.exports = {
      createMarket,
      takeOverSlot,
      releaseSlot,
      collectProtectiveIntents,
      step,
      SimulationEngine
    };
  }
});

// engine/validate.js
var require_validate = __commonJS({
  "engine/validate.js"(exports, module) {
    var { minTrade } = require_config();
    function validateCommand(state, playerId, command) {
      const player = state.playersById[playerId];
      if (!player) return { ok: false, reason: "\u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" };
      switch (command.type) {
        case "TRADE": {
          if (command.action === "CLOSE") {
            if (!player.position) return { ok: false, reason: "\u043D\u0435\u0442 \u043E\u0442\u043A\u0440\u044B\u0442\u043E\u0439 \u043F\u043E\u0437\u0438\u0446\u0438\u0438" };
            const f = command.fraction ?? 1;
            if (!(f > 0 && f <= 1)) return { ok: false, reason: "\u043D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0434\u043E\u043B\u044F \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F" };
            return { ok: true };
          }
          if (command.action !== "BUY" && command.action !== "SELL") {
            return { ok: false, reason: "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u043E\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435" };
          }
          const opposite = player.position && player.position.side !== (command.action === "BUY" ? "long" : "short");
          if (opposite) return { ok: true };
          const notional = Number(command.notional);
          if (!Number.isFinite(notional) || notional <= 0) {
            return { ok: false, reason: "\u043D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043E\u0431\u044A\u0451\u043C" };
          }
          if (notional < minTrade(state)) return { ok: false, reason: "\u043E\u0431\u044A\u0451\u043C \u043D\u0438\u0436\u0435 \u043C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u043E\u0433\u043E" };
          if (notional > player.cash + 1e-9) return { ok: false, reason: "\u043D\u0435\u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u0441\u0440\u0435\u0434\u0441\u0442\u0432" };
          return { ok: true };
        }
        case "LIMIT": {
          const price = Number(command.limitPrice);
          const notional = Number(command.notional);
          if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: "\u043D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0446\u0435\u043D\u0430" };
          if (!Number.isFinite(notional) || notional < minTrade(state)) {
            return { ok: false, reason: "\u043D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043E\u0431\u044A\u0451\u043C" };
          }
          if (notional > player.cash + 1e-9) return { ok: false, reason: "\u043D\u0435\u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u0441\u0440\u0435\u0434\u0441\u0442\u0432" };
          if (state.limitOrders.filter((o) => o.playerId === playerId).length >= 10) {
            return { ok: false, reason: "\u0441\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u0437\u0430\u044F\u0432\u043E\u043A" };
          }
          return { ok: true };
        }
        case "CANCEL_LIMIT": {
          const order = state.limitOrders.find((o) => o.id === command.orderId);
          if (!order) return { ok: false, reason: "\u0437\u0430\u044F\u0432\u043A\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430" };
          if (order.playerId !== playerId) return { ok: false, reason: "\u0447\u0443\u0436\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430" };
          return { ok: true };
        }
        case "PROTECT": {
          if (!player.position) return { ok: false, reason: "\u043D\u0435\u0442 \u043E\u0442\u043A\u0440\u044B\u0442\u043E\u0439 \u043F\u043E\u0437\u0438\u0446\u0438\u0438" };
          for (const value of [command.stopLoss, command.takeProfit]) {
            if (value !== null && value !== void 0 && !(Number(value) > 0)) {
              return { ok: false, reason: "\u043D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0443\u0440\u043E\u0432\u0435\u043D\u044C" };
            }
          }
          return { ok: true };
        }
        default:
          return { ok: false, reason: "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430" };
      }
    }
    module.exports = { validateCommand };
  }
});

// engine/snapshot.js
var require_snapshot = __commonJS({
  "engine/snapshot.js"(exports, module) {
    var { CONFIG: CONFIG2 } = require_config();
    var { aggregate, equityOf, settlementValue, projectedSettlement } = require_pnl();
    function projectPlayer(state, player, { viewer, devMode }) {
      const position = player.position;
      const exitSettlement = viewer && position ? projectedSettlement(state, position) : null;
      const settlement = position ? exitSettlement ?? settlementValue(position, state.price) : null;
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
        unrealized: position ? settlement - position.margin : 0,
        position: position ? {
          side: position.side,
          units: position.units,
          margin: position.margin,
          entryPrice: position.entryPrice,
          openedAtTick: position.openedAtTick,
          settlement
        } : null
      };
      if (viewer) {
        projected.stopLoss = player.stopLoss;
        projected.takeProfit = player.takeProfit;
      }
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
          nextDecisionTick: player.mind.nextDecisionTick
        };
      }
      return projected;
    }
    function createSnapshot(state, viewerId, { devMode = false, streamLimit = 1200, level = "full" } = {}) {
      const market = aggregate(state);
      if (level === "tick") {
        const you2 = state.playersById[viewerId] ? projectPlayer(state, state.playersById[viewerId], { viewer: true, devMode: false }) : null;
        return {
          roomId: state.roomId,
          tick: state.tick,
          time: state.time,
          phase: state.phase,
          price: state.price,
          previousPrice: state.previousPrice,
          initialPrice: CONFIG2.market.initialPrice,
          symbol: CONFIG2.market.assetSymbol,
          buyPressure: state.buyPressure,
          sellPressure: state.sellPressure,
          netPressure: state.netPressure,
          liquidity: state.liquidity,
          startingCapital: state.startingCapital,
          totalCapital: state.totalCapital,
          totalPlayers: state.players.length,
          totalTrades: state.totalTrades,
          market,
          you: you2,
          yourOrders: state.limitOrders.filter((o) => o.playerId === viewerId),
          lastPoint: state.priceHistory[state.priceHistory.length - 1]
        };
      }
      const players = state.players.map(
        (p) => projectPlayer(state, p, { viewer: p.id === viewerId, devMode })
      );
      const byEquity = [...players].sort((a, b) => b.equity - a.equity);
      const rank = byEquity.findIndex((p) => p.id === viewerId) + 1;
      const you = players.find((p) => p.id === viewerId) ?? null;
      if (level === "roster") {
        return {
          roomId: state.roomId,
          tick: state.tick,
          phase: state.phase,
          price: state.price,
          market,
          players,
          rank,
          you,
          totalPlayers: state.players.length
        };
      }
      const stream = state.priceHistory.length > streamLimit ? state.priceHistory.slice(-streamLimit) : state.priceHistory;
      return {
        roomId: state.roomId,
        tick: state.tick,
        time: state.time,
        phase: state.phase,
        price: state.price,
        previousPrice: state.previousPrice,
        initialPrice: CONFIG2.market.initialPrice,
        symbol: CONFIG2.market.assetSymbol,
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
        yourTrades: state.humanTradesById[viewerId] ?? [],
        yourOrders: state.limitOrders.filter((o) => o.playerId === viewerId),
        orders: state.limitOrders.map((o) => ({
          id: o.id,
          playerId: o.playerId,
          side: o.side,
          notional: o.notional,
          limitPrice: o.limitPrice,
          playerName: state.playersById[o.playerId]?.name ?? o.playerId
        })),
        priceStream: stream,
        debug: devMode ? {
          context: state.context,
          lastTrades: state.lastTickTrades,
          capitalDrift: state.capitalDrift,
          poolCash: state.poolCash
        } : null
      };
    }
    module.exports = { projectPlayer, createSnapshot };
  }
});

// engine/room.js
var require_room = __commonJS({
  "engine/room.js"(exports, module) {
    var { SimulationEngine } = require_simulation();
    var { validateCommand } = require_validate();
    var { createSnapshot } = require_snapshot();
    var { CONFIG: CONFIG2 } = require_config();
    var Room2 = class {
      constructor({
        id = "local",
        startingCapital = CONFIG2.market.startingCapital,
        seed = Date.now() % 2147483647,
        devMode = true
      } = {}) {
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
              reason: command.reason ?? "\u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u0438\u0433\u0440\u043E\u043A\u0430"
            });
            break;
          case "LIMIT":
            this.engine.placeLimitOrder({
              playerId,
              side: command.side,
              notional: command.notional,
              limitPrice: command.limitPrice
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
      advance(steps) {
        this.engine.advance(steps);
      }
      get paused() {
        return this.engine.paused;
      }
      set paused(value) {
        this.engine.paused = value;
      }
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
          state: JSON.parse(JSON.stringify(rest))
        };
      }
    };
    module.exports = { Room: Room2 };
  }
});

// engine/index.js
var require_engine = __commonJS({
  "engine/index.js"(exports, module) {
    var config = require_config();
    var util = require_util();
    var price = require_price();
    var liquidity = require_liquidity();
    var pnl = require_pnl();
    var npc = require_npc();
    var orders = require_orders();
    var simulation = require_simulation();
    var validate = require_validate();
    var snapshot = require_snapshot();
    var room = require_room();
    module.exports = {
      ...config,
      ...util,
      ...price,
      ...liquidity,
      ...pnl,
      ...npc,
      ...orders,
      ...simulation,
      ...validate,
      ...snapshot,
      ...room
    };
  }
});

// entry.jsx
import React2 from "react";
import ReactDOM from "react-dom/client";

// MarketSandbox.src.jsx
var import_engine = __toESM(require_engine());
import React, { useEffect, useRef, useState } from "react";
import {
  initializeApp
} from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInAnonymously,
  signOut,
  sendPasswordResetEmail,
  updateProfile
} from "firebase/auth";
import {
  getFirestore,
  doc,
  onSnapshot as onFirestoreSnapshot
} from "firebase/firestore";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var firebaseConfig = {
  apiKey: "PASTE_API_KEY_HERE",
  authDomain: "PASTE_PROJECT_ID_HERE.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID_HERE",
  storageBucket: "PASTE_PROJECT_ID_HERE.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID_HERE",
  appId: "PASTE_APP_ID_HERE"
};
var ROOM_SERVICE_URL = "PASTE_ROOM_SERVICE_URL_HERE";
var ROOM_SERVICE_WS_URL = ROOM_SERVICE_URL ? `${ROOM_SERVICE_URL.replace(/^http/, "ws")}/ws` : "";
var FIREBASE_CONFIGURED = Boolean(
  firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("PASTE_")
);
var firebaseApp = null;
var auth = null;
var db = null;
function ensureFirebase() {
  if (!FIREBASE_CONFIGURED) {
    throw new Error(
      "Firebase \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D: \u043E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 app.js \u0438 \u0432\u043F\u0438\u0448\u0438\u0442\u0435 \u0441\u0432\u043E\u0438 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u044F \u0432 firebaseConfig (\u0441\u043C. \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u0432 \u043D\u0430\u0447\u0430\u043B\u0435 \u0444\u0430\u0439\u043B\u0430)."
    );
  }
  if (!firebaseApp) {
    firebaseApp = initializeApp(firebaseConfig);
    auth = getAuth(firebaseApp);
    db = getFirestore(firebaseApp);
  }
  return { auth, db };
}
async function callRoomService(path, { method = "GET", body } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("\u043D\u0435\u0442 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 \u0432\u0445\u043E\u0434\u0430");
  const token = await user.getIdToken();
  const res = await fetch(`${ROOM_SERVICE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : void 0
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !("ok" in data)) throw new Error(data.reason || `\u0441\u0435\u0440\u0432\u0438\u0441 \u0432\u0435\u0440\u043D\u0443\u043B ${res.status}`);
  return data;
}
var LocalTransport = class {
  constructor({ startingCapital, seed, devMode = true } = {}) {
    this.room = new import_engine.Room({ startingCapital, seed, devMode });
    this.playerId = import_engine.HUMAN_ID;
    this.room.join(this.playerId, "\u0412\u042B");
    this.timer = null;
    this.speed = 1;
  }
  start(onSnapshot) {
    this.timer = setInterval(() => {
      this.room.advance(this.speed);
      onSnapshot(this.room.snapshotFor(this.playerId));
    }, import_engine.CONFIG.market.tickMs);
    onSnapshot(this.room.snapshotFor(this.playerId));
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
  async send(command) {
    return this.room.send(this.playerId, command);
  }
  snapshot() {
    return this.room.snapshotFor(this.playerId);
  }
  setSpeed(value) {
    this.speed = value;
  }
  setPaused(value) {
    this.room.paused = value;
  }
  get paused() {
    return this.room.paused;
  }
};
var RemoteTransport = class {
  constructor({ roomId, playerId }) {
    this.roomId = roomId;
    this.playerId = playerId;
    this.ws = null;
    this.full = null;
    this.onSnapshot = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 1e3;
    this.onStatus = null;
  }
  async start(onSnapshot) {
    this.onSnapshot = onSnapshot;
    await this._connect();
  }
  async _connect() {
    this.onStatus?.("connecting");
    const user = auth.currentUser;
    if (!user) throw new Error("\u043D\u0435\u0442 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 \u0432\u0445\u043E\u0434\u0430");
    const token = await user.getIdToken();
    const url = `${ROOM_SERVICE_WS_URL}?roomId=${encodeURIComponent(this.roomId)}&token=${encodeURIComponent(token)}`;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      ws.onopen = () => {
        this.reconnectDelay = 1e3;
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "hello") {
          this.full = msg.snapshot;
          if (!settled) {
            settled = true;
            this.onStatus?.("online");
            resolve();
          }
          this.onSnapshot?.(this.full);
        } else if (msg.type === "tick") {
          if (!this.full) return;
          this.full = {
            ...this.full,
            tick: msg.snapshot.tick,
            time: msg.snapshot.time,
            phase: msg.snapshot.phase,
            price: msg.snapshot.price,
            previousPrice: msg.snapshot.previousPrice,
            buyPressure: msg.snapshot.buyPressure,
            sellPressure: msg.snapshot.sellPressure,
            netPressure: msg.snapshot.netPressure,
            liquidity: msg.snapshot.liquidity,
            totalTrades: msg.snapshot.totalTrades,
            market: msg.snapshot.market,
            you: msg.snapshot.you ?? this.full.you,
            yourOrders: msg.snapshot.yourOrders,
            priceStream: [...this.full.priceStream ?? [], msg.snapshot.lastPoint].slice(-1200)
          };
          this.onSnapshot?.(this.full);
        } else if (msg.type === "roster") {
          if (!this.full) return;
          this.full = {
            ...this.full,
            players: msg.snapshot.players,
            rank: msg.snapshot.rank,
            you: msg.snapshot.you ?? this.full.you,
            totalPlayers: msg.snapshot.totalPlayers
          };
          this.onSnapshot?.(this.full);
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("\u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C\u0441\u044F"));
        }
      };
      ws.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new Error("\u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u0437\u0430\u043A\u0440\u044B\u0442\u043E"));
        }
        if (!this.closed) this._scheduleReconnect();
      };
    });
  }
  _scheduleReconnect() {
    this.onStatus?.("reconnecting");
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this._connect().catch(() => this._scheduleReconnect());
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 15e3);
  }
  stop() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
  /** Единственный путь действий — HTTP-эндпоинт сервиса, сервер сам валидирует. */
  async send(command) {
    try {
      return await callRoomService("/api/submitCommand", {
        method: "POST",
        body: { roomId: this.roomId, command }
      });
    } catch (err) {
      return { ok: false, reason: err.message || "\u0441\u0435\u0442\u044C \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430" };
    }
  }
  snapshot() {
    return this.full;
  }
  setSpeed() {
  }
  setPaused() {
  }
  get paused() {
    return false;
  }
};
var TIMEFRAMES = [
  { label: "1\u0441", ms: 1e3 },
  { label: "5\u0441", ms: 5e3 },
  { label: "15\u0441", ms: 15e3 },
  { label: "1\u043C", ms: 6e4 },
  { label: "5\u043C", ms: 3e5 }
];
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
var BG = "#000000";
var SURFACE = "#0B0B0C";
var RAISED = "#141416";
var HAIR = "#1E1E21";
var TEXT = "#FFFFFF";
var DIM = "#7A7A80";
var FAINT = "#46464C";
var LONG = "#19D67E";
var SHORT = "#FF3F52";
var fmt = (v, d = 2) => {
  const digits = Math.abs(v) >= 1e3 ? 0 : d;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}`;
};
var fmtSigned = (v, d = 2) => `${v >= 0 ? "+" : "\u2212"}${fmt(Math.abs(v), d).replace("-", "")}`;
var CW = 700;
var AXIS = 74;
var CH = 340;
var VH = 60;
var MAX_CANDLES = 60;
function Chart({ state, timeframe, mode, entryPrice, stopLoss, takeProfit }) {
  const bucketMs = TIMEFRAMES.find((t) => t.label === timeframe)?.ms ?? 1e3;
  const candles = buildCandles(state.priceStream, bucketMs, MAX_CANDLES);
  if (candles.length < 2) {
    return /* @__PURE__ */ jsx(
      "div",
      {
        style: { height: 380 },
        className: "flex items-center justify-center text-[12px]",
        children: /* @__PURE__ */ jsx("span", { style: { color: FAINT }, children: "\u0441\u043E\u0431\u0438\u0440\u0430\u0435\u043C \u0441\u0432\u0435\u0447\u0438\u2026" })
      }
    );
  }
  let min = Infinity, max = -Infinity, maxVol = 0;
  for (const c of candles) {
    min = Math.min(min, c.low);
    max = Math.max(max, c.high);
    maxVol = Math.max(maxVol, c.volume);
  }
  for (const level2 of [entryPrice, stopLoss, takeProfit]) {
    if (level2 && level2 > min * 0.94 && level2 < max * 1.06) {
      min = Math.min(min, level2);
      max = Math.max(max, level2);
    }
  }
  const pad = Math.max((max - min) * 0.1, max * 15e-4);
  min -= pad;
  max += pad;
  const span = max - min || 1;
  const toY = (p) => CH - (p - min) / span * CH;
  const slot = CW / MAX_CANDLES;
  const body = Math.max(2, slot * 0.55);
  const offset = Math.max(0, MAX_CANDLES - candles.length);
  const grid = Array.from({ length: 5 }, (_, i) => min + span * i / 4);
  const priceY = toY(state.price);
  const level = (value, label, dash) => value && value > min && value < max ? /* @__PURE__ */ jsxs("g", { children: [
    /* @__PURE__ */ jsx("line", { x1: 0, x2: CW, y1: toY(value), y2: toY(value), stroke: FAINT, strokeWidth: 1, strokeDasharray: dash }),
    /* @__PURE__ */ jsx("text", { x: 4, y: toY(value) - 5, fill: FAINT, fontSize: 11, fontFamily: "monospace", children: label })
  ] }) : null;
  return /* @__PURE__ */ jsxs("svg", { viewBox: `0 0 ${CW + AXIS} ${CH + VH + 4}`, className: "w-full", style: { height: 380 }, children: [
    grid.map((p, i) => /* @__PURE__ */ jsxs("g", { children: [
      /* @__PURE__ */ jsx("line", { x1: 0, x2: CW, y1: toY(p), y2: toY(p), stroke: HAIR, strokeWidth: 1 }),
      /* @__PURE__ */ jsx("text", { x: CW + 8, y: toY(p) + 4, fill: FAINT, fontSize: 12, fontFamily: "monospace", children: p.toFixed(2) })
    ] }, i)),
    mode === "\u0441\u0432\u0435\u0447\u0438" ? candles.map((c, i) => {
      const x = (offset + i) * slot + slot / 2;
      const up = c.close >= c.open;
      const color = up ? LONG : SHORT;
      const top = toY(Math.max(c.open, c.close));
      const bottom = toY(Math.min(c.open, c.close));
      return /* @__PURE__ */ jsxs("g", { children: [
        /* @__PURE__ */ jsx("line", { x1: x, x2: x, y1: toY(c.high), y2: toY(c.low), stroke: color, strokeWidth: 1 }),
        /* @__PURE__ */ jsx("rect", { x: x - body / 2, y: top, width: body, height: Math.max(1.2, bottom - top), fill: color })
      ] }, c.t);
    }) : (() => {
      const pts = candles.map((c, i) => `${(offset + i) * slot + slot / 2},${toY(c.close)}`).join(" ");
      const trend = candles[candles.length - 1].close >= candles[0].open ? LONG : SHORT;
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("polygon", { points: `${pts} ${CW},${CH} ${offset * slot},${CH}`, fill: trend, opacity: 0.08 }),
        /* @__PURE__ */ jsx("polyline", { points: pts, fill: "none", stroke: trend, strokeWidth: 1.6 })
      ] });
    })(),
    level(entryPrice, `\u0432\u0445\u043E\u0434 ${entryPrice?.toFixed(2)}`, "1 4"),
    level(stopLoss, `\u0441\u0442\u043E\u043F ${stopLoss?.toFixed(2)}`, "4 4"),
    level(takeProfit, `\u0442\u0435\u0439\u043A ${takeProfit?.toFixed(2)}`, "4 4"),
    candles.map((c, i) => {
      const x = (offset + i) * slot + slot / 2;
      const h = maxVol === 0 ? 0 : c.volume / maxVol * (VH - 8);
      return /* @__PURE__ */ jsx(
        "rect",
        {
          x: x - body / 2,
          y: CH + 4 + (VH - 8 - h),
          width: body,
          height: Math.max(0.5, h),
          fill: c.close >= c.open ? LONG : SHORT,
          opacity: 0.35
        },
        `v${c.t}`
      );
    }),
    /* @__PURE__ */ jsx("line", { x1: 0, x2: CW, y1: priceY, y2: priceY, stroke: TEXT, strokeWidth: 1, strokeDasharray: "3 3", opacity: 0.4 }),
    /* @__PURE__ */ jsx(
      "rect",
      {
        x: CW + 2,
        y: priceY - 12,
        width: AXIS - 4,
        height: 24,
        rx: 3,
        fill: state.price >= state.previousPrice ? LONG : SHORT
      }
    ),
    /* @__PURE__ */ jsx(
      "text",
      {
        x: CW + AXIS / 2,
        y: priceY + 5,
        textAnchor: "middle",
        fill: BG,
        fontSize: 13,
        fontFamily: "monospace",
        fontWeight: "700",
        children: state.price.toFixed(2)
      }
    )
  ] });
}
function Metric({ label, value, color = TEXT }) {
  return /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
    /* @__PURE__ */ jsx("div", { className: "text-[10px] tracking-[0.12em] mb-1", style: { color: FAINT }, children: label }),
    /* @__PURE__ */ jsx("div", { className: "text-[15px] font-mono truncate", style: { color }, children: value })
  ] });
}
function Line({ left, right, color }) {
  return /* @__PURE__ */ jsxs("div", { className: "flex justify-between gap-3 py-2 border-b", style: { borderColor: HAIR }, children: [
    /* @__PURE__ */ jsx("span", { className: "text-[12px] truncate", style: { color: DIM }, children: left }),
    /* @__PURE__ */ jsx("span", { className: "text-[12px] font-mono whitespace-nowrap", style: { color: color ?? TEXT }, children: right })
  ] });
}
var Blank = ({ children }) => /* @__PURE__ */ jsx("div", { className: "text-[12px] py-8 text-center", style: { color: FAINT }, children });
function Toggle({ active, onClick, children }) {
  return /* @__PURE__ */ jsx(
    "button",
    {
      onClick,
      className: "px-2.5 py-1.5 rounded text-[12px] transition",
      style: { color: active ? BG : DIM, backgroundColor: active ? TEXT : "transparent" },
      children
    }
  );
}
var PROFILE_KEY = "sandbox:profile";
var STARTING_WALLET = 25e3;
var emptyProfile = () => ({
  wallet: STARTING_WALLET,
  deposited: STARTING_WALLET,
  sessions: []
});
var profileStore = {
  async load() {
    try {
      const found = await window.storage.get(PROFILE_KEY);
      if (found?.value) return { ...emptyProfile(), ...JSON.parse(found.value) };
    } catch {
    }
    return emptyProfile();
  },
  async save(profile) {
    try {
      await window.storage.set(PROFILE_KEY, JSON.stringify(profile));
    } catch {
    }
  }
};
var loadProfile = () => profileStore.load();
var saveProfile = (profile) => profileStore.save(profile);
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
    worst: Math.min(...list.map((x) => x.pnl))
  };
}
function Lobby({ profile, onNew, onReset, onExit }) {
  const st = profileStats(profile);
  const affordable = import_engine.CONFIG.market.capitalOptions.some((c) => c <= profile.wallet);
  return /* @__PURE__ */ jsxs("div", { className: "w-full h-screen flex flex-col", style: { backgroundColor: BG, color: TEXT }, children: [
    /* @__PURE__ */ jsxs("div", { className: "max-w-md w-full mx-auto flex-1 overflow-y-auto px-6 pt-10 pb-4", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between mb-2", children: [
        /* @__PURE__ */ jsx("span", { className: "text-[11px] tracking-[0.4em]", style: { color: FAINT }, children: "\u0417\u0410\u041A\u0420\u042B\u0422\u042B\u0419 \u0420\u042B\u041D\u041E\u041A \xB7 \u041F\u0420\u0410\u041A\u0422\u0418\u041A\u0410" }),
        onExit && /* @__PURE__ */ jsx("button", { onClick: onExit, className: "text-[11px]", style: { color: DIM }, children: "\u0441\u043C\u0435\u043D\u0438\u0442\u044C \u0440\u0435\u0436\u0438\u043C" })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "text-[28px] leading-none tracking-tight mb-10", children: "Market Sandbox" }),
      /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mb-2", style: { color: FAINT }, children: "\u0411\u0410\u041B\u0410\u041D\u0421" }),
      /* @__PURE__ */ jsx("div", { className: "text-[44px] leading-none font-mono tracking-tight", children: fmt(profile.wallet) }),
      /* @__PURE__ */ jsx(
        "div",
        {
          className: "text-[13px] font-mono mt-2",
          style: { color: st.total > 0 ? LONG : st.total < 0 ? SHORT : DIM },
          children: st.count === 0 ? "\u0441\u0435\u0441\u0441\u0438\u0439 \u0435\u0449\u0451 \u043D\u0435 \u0431\u044B\u043B\u043E" : `${fmtSigned(st.total)} \u0437\u0430 ${st.count} \u0441\u0435\u0441\u0441.`
        }
      ),
      /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-4 gap-3 mt-8", children: [
        /* @__PURE__ */ jsx(Metric, { label: "\u0421\u0415\u0421\u0421\u0418\u0419", value: String(st.count) }),
        /* @__PURE__ */ jsx(
          Metric,
          {
            label: "\u041F\u0420\u0418\u0411\u042B\u041B\u042C\u041D\u042B\u0425",
            value: st.count ? `${st.wins}` : "\u2014",
            color: st.wins > 0 ? LONG : TEXT
          }
        ),
        /* @__PURE__ */ jsx(
          Metric,
          {
            label: "\u041B\u0423\u0427\u0428\u0410\u042F",
            value: st.count ? fmtSigned(st.best, 0) : "\u2014",
            color: st.best > 0 ? LONG : TEXT
          }
        ),
        /* @__PURE__ */ jsx(
          Metric,
          {
            label: "\u0425\u0423\u0414\u0428\u0410\u042F",
            value: st.count ? fmtSigned(st.worst, 0) : "\u2014",
            color: st.worst < 0 ? SHORT : TEXT
          }
        )
      ] }),
      /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mt-10 mb-1", style: { color: FAINT }, children: "\u0418\u0421\u0422\u041E\u0420\u0418\u042F" }),
      profile.sessions.length === 0 ? /* @__PURE__ */ jsx(Blank, { children: "\u0437\u0434\u0435\u0441\u044C \u043F\u043E\u044F\u0432\u044F\u0442\u0441\u044F \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u044B \u0432\u0430\u0448\u0438\u0445 \u0441\u0435\u0441\u0441\u0438\u0439" }) : profile.sessions.slice(0, 12).map((x, i) => /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between py-2.5 border-b", style: { borderColor: HAIR }, children: [
        /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
          /* @__PURE__ */ jsxs("div", { className: "text-[13px] font-mono", children: [
            fmt(x.capital, 0),
            " \u2192 ",
            fmt(x.equity)
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "text-[11px]", style: { color: FAINT }, children: [
            (0, import_engine.clock)(x.ticks * import_engine.CONFIG.market.tickMs),
            " \u0432 \u0440\u044B\u043D\u043A\u0435 \xB7 \u043C\u0435\u0441\u0442\u043E ",
            x.rank,
            " \u0438\u0437 ",
            import_engine.CONFIG.market.totalPlayers
          ] })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "text-[14px] font-mono", style: { color: x.pnl >= 0 ? LONG : SHORT }, children: fmtSigned(x.pnl) })
      ] }, i))
    ] }),
    /* @__PURE__ */ jsx("div", { className: "max-w-md w-full mx-auto px-6 pb-8 pt-3", children: affordable ? /* @__PURE__ */ jsx(
      "button",
      {
        onClick: onNew,
        className: "w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold",
        style: { backgroundColor: TEXT, color: BG },
        children: "\u041D\u041E\u0412\u0410\u042F \u0421\u0415\u0421\u0421\u0418\u042F"
      }
    ) : /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("div", { className: "text-[12px] mb-3 text-center", style: { color: FAINT }, children: "\u041D\u0430 \u0431\u0430\u043B\u0430\u043D\u0441\u0435 \u043C\u0435\u043D\u044C\u0448\u0435 \u043C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0432\u0437\u043D\u043E\u0441\u0430." }),
      /* @__PURE__ */ jsxs(
        "button",
        {
          onClick: onReset,
          className: "w-full rounded-lg py-4 text-[15px] tracking-[0.15em]",
          style: { backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` },
          children: [
            "\u041F\u041E\u041F\u041E\u041B\u041D\u0418\u0422\u042C \u0414\u041E ",
            fmt(STARTING_WALLET, 0)
          ]
        }
      )
    ] }) })
  ] });
}
function SessionSetup({ wallet, onStart, onBack }) {
  const options = import_engine.CONFIG.market.capitalOptions;
  const [capital, setCapital] = useState(
    options.filter((c) => c <= wallet).slice(-1)[0] ?? options[0]
  );
  return /* @__PURE__ */ jsxs("div", { className: "w-full h-screen flex flex-col", style: { backgroundColor: BG, color: TEXT }, children: [
    /* @__PURE__ */ jsxs("div", { className: "max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6", children: [
      /* @__PURE__ */ jsx("button", { onClick: onBack, className: "text-[12px] mb-8 text-left", style: { color: DIM }, children: "\u2190 \u043D\u0430\u0437\u0430\u0434" }),
      /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mb-3", style: { color: FAINT }, children: "\u0412\u0417\u041D\u041E\u0421 \u0412 \u0421\u0415\u0421\u0421\u0418\u042E" }),
      /* @__PURE__ */ jsx("div", { className: "grid grid-cols-2 gap-2", children: options.map((value) => {
        const active = capital === value;
        const locked = value > wallet;
        return /* @__PURE__ */ jsxs(
          "button",
          {
            disabled: locked,
            onClick: () => setCapital(value),
            className: "rounded-lg py-5 text-left px-4 transition disabled:opacity-25",
            style: {
              backgroundColor: active && !locked ? TEXT : SURFACE,
              color: active && !locked ? BG : TEXT,
              border: `1px solid ${active && !locked ? TEXT : HAIR}`
            },
            children: [
              /* @__PURE__ */ jsxs("div", { className: "text-[22px] font-mono", children: [
                "$",
                value.toLocaleString("en-US")
              ] }),
              /* @__PURE__ */ jsx("div", { className: "text-[11px] mt-1", style: { color: active && !locked ? "#555" : FAINT }, children: locked ? "\u043D\u0435 \u0445\u0432\u0430\u0442\u0430\u0435\u0442 \u0431\u0430\u043B\u0430\u043D\u0441\u0430" : `\u0440\u044B\u043D\u043E\u043A $${(value * import_engine.CONFIG.market.totalPlayers).toLocaleString("en-US")}` })
            ]
          },
          value
        );
      }) }),
      /* @__PURE__ */ jsx("div", { className: "text-[12px] mt-5 leading-relaxed", style: { color: FAINT }, children: "\u0421\u0442\u043E\u043B\u044C\u043A\u043E \u0436\u0435 \u043F\u043E\u043B\u0443\u0447\u0430\u0435\u0442 \u043A\u0430\u0436\u0434\u044B\u0439 \u0438\u0437 99 \u0431\u043E\u0442\u043E\u0432. \u0412\u0437\u043D\u043E\u0441 \u0441\u043F\u0438\u0441\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0441 \u0431\u0430\u043B\u0430\u043D\u0441\u0430, \u0430 \u0432 \u043A\u043E\u043D\u0446\u0435 \u0441\u0435\u0441\u0441\u0438\u0438 \u043D\u0430 \u0431\u0430\u043B\u0430\u043D\u0441 \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u0442\u0441\u044F \u0432\u0430\u0448 \u0438\u0442\u043E\u0433\u043E\u0432\u044B\u0439 \u043A\u0430\u043F\u0438\u0442\u0430\u043B. \u0420\u0430\u0437\u043C\u0435\u0440 \u0441\u0435\u0441\u0441\u0438\u0438 \u043C\u0435\u043D\u044F\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u043C\u0430\u0441\u0448\u0442\u0430\u0431 \u0434\u0435\u043D\u0435\u0433 \u2014 \u043F\u043E\u0432\u0435\u0434\u0435\u043D\u0438\u0435 \u0440\u044B\u043D\u043A\u0430 \u043E\u0442 \u043D\u0435\u0433\u043E \u043D\u0435 \u0437\u0430\u0432\u0438\u0441\u0438\u0442." })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "max-w-md w-full mx-auto px-6 pb-8", children: /* @__PURE__ */ jsxs(
      "button",
      {
        onClick: () => onStart(capital),
        className: "w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold",
        style: { backgroundColor: TEXT, color: BG },
        children: [
          "\u0412\u041E\u0419\u0422\u0418 \u0412 \u0420\u042B\u041D\u041E\u041A \xB7 ",
          fmt(capital, 0)
        ]
      }
    ) })
  ] });
}
function SessionResult({ result, onDone }) {
  const good = result.pnl >= 0;
  return /* @__PURE__ */ jsxs("div", { className: "w-full h-screen flex flex-col", style: { backgroundColor: BG, color: TEXT }, children: [
    /* @__PURE__ */ jsxs("div", { className: "max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6", children: [
      /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.4em] mb-3", style: { color: FAINT }, children: "\u0421\u0415\u0421\u0421\u0418\u042F \u0417\u0410\u0412\u0415\u0420\u0428\u0415\u041D\u0410" }),
      /* @__PURE__ */ jsx("div", { className: "text-[52px] leading-none font-mono tracking-tight", style: { color: good ? LONG : SHORT }, children: fmtSigned(result.pnl) }),
      /* @__PURE__ */ jsxs("div", { className: "text-[15px] font-mono mt-2", style: { color: DIM }, children: [
        (result.pnl / result.capital * 100).toFixed(2),
        "% \u043E\u0442 \u0432\u0437\u043D\u043E\u0441\u0430"
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "mt-10", children: [
        /* @__PURE__ */ jsx(Line, { left: "\u0412\u0437\u043D\u043E\u0441", right: fmt(result.capital) }),
        /* @__PURE__ */ jsx(Line, { left: "\u0418\u0442\u043E\u0433\u043E\u0432\u044B\u0439 \u043A\u0430\u043F\u0438\u0442\u0430\u043B", right: fmt(result.equity) }),
        /* @__PURE__ */ jsx(Line, { left: "\u041C\u0435\u0441\u0442\u043E \u0432 \u0440\u0435\u0439\u0442\u0438\u043D\u0433\u0435", right: `${result.rank} \u0438\u0437 ${import_engine.CONFIG.market.totalPlayers}` }),
        /* @__PURE__ */ jsx(Line, { left: "\u0421\u0434\u0435\u043B\u043E\u043A", right: String(result.trades) }),
        /* @__PURE__ */ jsx(Line, { left: "\u0412\u0440\u0435\u043C\u044F \u0432 \u0440\u044B\u043D\u043A\u0435", right: (0, import_engine.clock)(result.ticks * import_engine.CONFIG.market.tickMs) }),
        /* @__PURE__ */ jsx(Line, { left: "\u0426\u0435\u043D\u0430 \u043D\u0430 \u0432\u044B\u0445\u043E\u0434\u0435", right: fmt(result.price) })
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "max-w-md w-full mx-auto px-6 pb-8", children: /* @__PURE__ */ jsx(
      "button",
      {
        onClick: onDone,
        className: "w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold",
        style: { backgroundColor: TEXT, color: BG },
        children: "\u0412 \u041B\u041E\u0411\u0411\u0418"
      }
    ) })
  ] });
}
function PracticeApp({ onExit }) {
  const [profile, setProfile] = useState(null);
  const [screen, setScreen] = useState("lobby");
  const [result, setResult] = useState(null);
  const [session, setSession] = useState(null);
  const engineRef = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState("\u0420\u044B\u043D\u043E\u043A");
  const [timeframe, setTimeframe] = useState("1\u0441");
  const [chartMode, setChartMode] = useState("\u0441\u0432\u0435\u0447\u0438");
  const [showSettings, setShowSettings] = useState(false);
  const [size, setSize] = useState("0");
  const [sheet, setSheet] = useState(null);
  const [limitPrice, setLimitPrice] = useState("");
  const [limitSide, setLimitSide] = useState("buy");
  const [playerFilter, setPlayerFilter] = useState("\u0412\u0441\u0435");
  const [npcMode, setNpcMode] = useState("\u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0435");
  const [toast, setToast] = useState(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const speedRef = useRef(1);
  speedRef.current = speed;
  const toastTimer = useRef(null);
  useEffect(() => {
    loadProfile().then(setProfile);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useEffect(() => {
    if (screen !== "game" || !session) return void 0;
    const transport2 = engineRef.current;
    if (!transport2) return void 0;
    transport2.start((next) => setSnapshot(next));
    return () => transport2.stop();
  }, [screen, session]);
  useEffect(() => {
    engineRef.current?.setSpeed(speed);
  }, [speed]);
  const persist = (next) => {
    setProfile(next);
    saveProfile(next);
  };
  const startSession = (capital) => {
    engineRef.current = new LocalTransport({ startingCapital: capital });
    setSize(String(Math.round(capital * 0.3)));
    setPaused(false);
    setTab("\u0420\u044B\u043D\u043E\u043A");
    setSession(capital);
    setScreen("game");
    persist({ ...profile, wallet: profile.wallet - capital });
  };
  const finishSession = () => {
    const transport2 = engineRef.current;
    if (!transport2) return;
    const snap2 = transport2.snapshot();
    const record = {
      capital: session,
      equity: snap2.you.equity,
      pnl: snap2.you.equity - session,
      rank: snap2.rank,
      trades: snap2.you.tradeCount,
      ticks: snap2.tick,
      price: snap2.price
    };
    persist({
      ...profile,
      wallet: profile.wallet + record.equity,
      sessions: [record, ...profile.sessions].slice(0, 40)
    });
    transport2.stop();
    engineRef.current = null;
    setSnapshot(null);
    setSession(null);
    setShowSettings(false);
    setResult(record);
    setScreen("result");
  };
  if (!profile) {
    return /* @__PURE__ */ jsx(
      "div",
      {
        className: "w-full h-screen flex items-center justify-center",
        style: { backgroundColor: BG, color: FAINT },
        children: /* @__PURE__ */ jsx("span", { className: "text-[12px]", children: "\u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u043F\u0440\u043E\u0444\u0438\u043B\u044F\u2026" })
      }
    );
  }
  if (screen === "lobby") {
    return /* @__PURE__ */ jsx(
      Lobby,
      {
        profile,
        onNew: () => setScreen("setup"),
        onExit,
        onReset: () => persist({ ...profile, wallet: STARTING_WALLET, deposited: profile.deposited + STARTING_WALLET })
      }
    );
  }
  if (screen === "setup") {
    return /* @__PURE__ */ jsx(SessionSetup, { wallet: profile.wallet, onStart: startSession, onBack: () => setScreen("lobby") });
  }
  if (screen === "result" && result) {
    return /* @__PURE__ */ jsx(SessionResult, { result, onDone: () => {
      setResult(null);
      setScreen("lobby");
    } });
  }
  if (!engineRef.current || !snapshot) {
    return /* @__PURE__ */ jsx(
      Lobby,
      {
        profile,
        onNew: () => setScreen("setup"),
        onExit,
        onReset: () => persist({ ...profile, wallet: STARTING_WALLET })
      }
    );
  }
  const transport = engineRef.current;
  const snap = snapshot;
  const say = (text, color = TEXT) => {
    setToast({ text, color });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1700);
  };
  const state = snap;
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
  const send = async (command) => {
    const res = await transport.send(command);
    if (!res.ok) say(res.reason, SHORT);
    refresh();
    return res;
  };
  const buyHint = pos && pos.side === "short" ? "\u0437\u0430\u043A\u0440\u043E\u0435\u0442 Short" : "\u043E\u0442\u043A\u0440\u044B\u0442\u044C / \u0443\u0432\u0435\u043B\u0438\u0447\u0438\u0442\u044C Long";
  const sellHint = pos && pos.side === "long" ? "\u0437\u0430\u043A\u0440\u043E\u0435\u0442 Long" : "\u043E\u0442\u043A\u0440\u044B\u0442\u044C / \u0443\u0432\u0435\u043B\u0438\u0447\u0438\u0442\u044C Short";
  const doBuy = async () => {
    const res = await send({ type: "TRADE", action: "BUY", notional, reason: "\u0440\u0443\u0447\u043D\u0430\u044F \u043F\u043E\u043A\u0443\u043F\u043A\u0430" });
    if (res.ok) say(pos && pos.side === "short" ? "\u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0435\u043C Short" : `\u043F\u043E\u043A\u0443\u043F\u043A\u0430 ${fmt(notional, 0)}`, LONG);
  };
  const doSell = async () => {
    const res = await send({ type: "TRADE", action: "SELL", notional, reason: "\u0440\u0443\u0447\u043D\u0430\u044F \u043F\u0440\u043E\u0434\u0430\u0436\u0430" });
    if (res.ok) say(pos && pos.side === "long" ? "\u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0435\u043C Long" : `\u043F\u0440\u043E\u0434\u0430\u0436\u0430 ${fmt(notional, 0)}`, SHORT);
  };
  const doClose = async (fraction, label) => {
    const res = await send({ type: "TRADE", action: "CLOSE", fraction, reason: "\u0440\u0443\u0447\u043D\u043E\u0435 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u0435" });
    if (res.ok) say(label);
  };
  const setRisk = async (kind, delta) => {
    if (!pos) return;
    const long = pos.side === "long";
    const target = kind === "sl" ? long ? pos.entryPrice * (1 - delta) : pos.entryPrice * (1 + delta) : long ? pos.entryPrice * (1 + delta) : pos.entryPrice * (1 - delta);
    const res = await send({
      type: "PROTECT",
      stopLoss: kind === "sl" ? target : null,
      takeProfit: kind === "tp" ? target : null
    });
    if (res.ok) say(`${kind === "sl" ? "\u0441\u0442\u043E\u043F" : "\u0442\u0435\u0439\u043A"} ${target.toFixed(2)}`);
  };
  const TAB_KEYS = ["\u0420\u044B\u043D\u043E\u043A", "\u041F\u043E\u0437\u0438\u0446\u0438\u0438", "\u041E\u0440\u0434\u0435\u0440\u0430", "\u0423\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u0438", "\u041E\u0442\u043B\u0430\u0434\u043A\u0430"];
  return /* @__PURE__ */ jsx("div", { className: "w-full h-screen flex flex-col", style: { backgroundColor: BG, color: TEXT }, children: /* @__PURE__ */ jsxs("div", { className: "max-w-md w-full mx-auto flex flex-col h-full relative", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between px-5 py-3", children: [
      /* @__PURE__ */ jsxs("span", { className: "text-[11px] tracking-[0.3em]", style: { color: FAINT }, children: [
        import_engine.CONFIG.market.assetSymbol,
        " \xB7 ",
        fmt(session, 0)
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-4", children: [
        /* @__PURE__ */ jsxs("button", { onClick: togglePause, className: "flex items-center gap-1.5", children: [
          /* @__PURE__ */ jsx(
            "span",
            {
              className: "w-1.5 h-1.5 rounded-full",
              style: { backgroundColor: paused ? FAINT : TEXT }
            }
          ),
          /* @__PURE__ */ jsx("span", { className: "text-[11px] tracking-[0.15em]", style: { color: paused ? FAINT : DIM }, children: paused ? "\u041F\u0410\u0423\u0417\u0410" : "LIVE" })
        ] }),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => setShowSettings((v) => !v),
            className: "text-[11px] tracking-[0.15em]",
            style: { color: showSettings ? TEXT : FAINT },
            children: "\u0415\u0429\u0401"
          }
        )
      ] })
    ] }),
    showSettings && /* @__PURE__ */ jsxs("div", { className: "px-5 pb-4 flex flex-col gap-3", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between", children: [
        /* @__PURE__ */ jsx("span", { className: "text-[11px] tracking-[0.15em]", style: { color: FAINT }, children: "\u0421\u041A\u041E\u0420\u041E\u0421\u0422\u042C" }),
        /* @__PURE__ */ jsx("div", { className: "flex gap-1", children: [1, 2, 5, 10].map((s) => /* @__PURE__ */ jsxs(Toggle, { active: speed === s, onClick: () => setSpeed(s), children: [
          s,
          "x"
        ] }, s)) })
      ] }),
      confirmingEnd ? /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => setConfirmingEnd(false),
            className: "flex-1 rounded-lg py-3 text-[13px]",
            style: { backgroundColor: SURFACE, border: `1px solid ${HAIR}` },
            children: "\u041E\u0442\u043C\u0435\u043D\u0430"
          }
        ),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: finishSession,
            className: "flex-1 rounded-lg py-3 text-[13px] font-semibold",
            style: { backgroundColor: SHORT, color: BG },
            children: "\u0414\u0430, \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C"
          }
        )
      ] }) : /* @__PURE__ */ jsxs(
        "button",
        {
          onClick: () => setConfirmingEnd(true),
          className: "rounded-lg py-3 text-[13px]",
          style: { backgroundColor: SURFACE, border: `1px solid ${HAIR}` },
          children: [
            "\u0417\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E \xB7 ",
            fmt(equity),
            " \u043D\u0430 \u0431\u0430\u043B\u0430\u043D\u0441"
          ]
        }
      )
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex-1 overflow-y-auto", children: [
      tab === "\u0420\u044B\u043D\u043E\u043A" && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsxs("div", { className: "px-5 pt-1 flex items-end justify-between", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "text-[46px] leading-none font-mono tracking-tight", children: fmt(state.price) }),
            /* @__PURE__ */ jsxs("div", { className: "text-[14px] font-mono mt-1.5", style: { color: changeAbs >= 0 ? LONG : SHORT }, children: [
              changeAbs >= 0 ? "+" : "\u2212",
              Math.abs(changePct * 100).toFixed(2),
              "%"
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "text-right", children: [
            /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em]", style: { color: DIM }, children: state.phase }),
            /* @__PURE__ */ jsxs("div", { className: "text-[11px] font-mono mt-1", style: { color: FAINT }, children: [
              stats.activePositions,
              " / ",
              import_engine.CONFIG.market.totalPlayers,
              " \u0432 \u0440\u044B\u043D\u043A\u0435"
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "px-5 pt-4", children: /* @__PURE__ */ jsxs("div", { className: "h-1 w-full flex rounded-full overflow-hidden", style: { backgroundColor: HAIR }, children: [
          /* @__PURE__ */ jsx("div", { style: { width: `${stats.longShare * 100}%`, backgroundColor: LONG } }),
          /* @__PURE__ */ jsx("div", { style: { width: `${stats.shortShare * 100}%`, backgroundColor: SHORT } })
        ] }) }),
        /* @__PURE__ */ jsxs("div", { className: "px-5 pt-4 grid grid-cols-4 gap-3", children: [
          /* @__PURE__ */ jsx(Metric, { label: "LONG", value: fmt(stats.longExposure, 0), color: LONG }),
          /* @__PURE__ */ jsx(Metric, { label: "SHORT", value: fmt(stats.shortExposure, 0), color: SHORT }),
          /* @__PURE__ */ jsx(Metric, { label: "BUY PRESS", value: fmt(state.buyPressure, 0) }),
          /* @__PURE__ */ jsx(Metric, { label: "SELL PRESS", value: fmt(state.sellPressure, 0) })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between px-5 pt-5", children: [
          /* @__PURE__ */ jsx("div", { className: "flex gap-0.5", children: TIMEFRAMES.map((tf) => /* @__PURE__ */ jsx(Toggle, { active: timeframe === tf.label, onClick: () => setTimeframe(tf.label), children: tf.label }, tf.label)) }),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => setChartMode(chartMode === "\u0441\u0432\u0435\u0447\u0438" ? "\u043B\u0438\u043D\u0438\u044F" : "\u0441\u0432\u0435\u0447\u0438"),
              className: "text-[12px]",
              style: { color: DIM },
              children: chartMode
            }
          )
        ] }),
        /* @__PURE__ */ jsx("div", { className: "px-2 pt-1", children: /* @__PURE__ */ jsx(
          Chart,
          {
            state,
            timeframe,
            mode: chartMode,
            entryPrice: pos?.entryPrice,
            stopLoss: human.stopLoss,
            takeProfit: human.takeProfit
          }
        ) }),
        /* @__PURE__ */ jsxs("div", { className: "px-5 pb-4 grid grid-cols-4 gap-3", children: [
          /* @__PURE__ */ jsx(Metric, { label: "\u042D\u041A\u0412\u0418\u0422\u0418", value: fmt(equity) }),
          /* @__PURE__ */ jsx(Metric, { label: "\u0421\u0412\u041E\u0411\u041E\u0414\u041D\u041E", value: fmt(human.cash) }),
          /* @__PURE__ */ jsx(
            Metric,
            {
              label: "\u041F\u041E\u0417\u0418\u0426\u0418\u042F",
              value: pos ? `${pos.side === "long" ? "LONG" : "SHORT"} ${fmt(pos.margin, 0)}` : "\u2014",
              color: pos ? pos.side === "long" ? LONG : SHORT : TEXT
            }
          ),
          /* @__PURE__ */ jsx(Metric, { label: "PNL", value: pos ? fmtSigned(pnl) : "\u2014", color: pnlColor })
        ] })
      ] }),
      tab === "\u041F\u043E\u0437\u0438\u0446\u0438\u0438" && /* @__PURE__ */ jsxs("div", { className: "px-5 pt-2 pb-6", children: [
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mb-3", style: { color: FAINT }, children: "\u041F\u041E\u0417\u0418\u0426\u0418\u042F" }),
        pos ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-baseline justify-between mb-4", children: [
            /* @__PURE__ */ jsx("span", { className: "text-[26px]", style: { color: pos.side === "long" ? LONG : SHORT }, children: pos.side === "long" ? "LONG" : "SHORT" }),
            /* @__PURE__ */ jsx("span", { className: "text-[20px] font-mono", children: fmt(pos.margin) }),
            /* @__PURE__ */ jsxs("span", { className: "text-[15px] font-mono", style: { color: pnlColor }, children: [
              fmtSigned(pnl),
              " \xB7 ",
              (0, import_engine.signedPct)(pnlRatio)
            ] })
          ] }),
          /* @__PURE__ */ jsx(Line, { left: "\u0426\u0435\u043D\u0430 \u0432\u0445\u043E\u0434\u0430", right: fmt(pos.entryPrice) }),
          /* @__PURE__ */ jsx(Line, { left: "\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0446\u0435\u043D\u0430", right: fmt(state.price) }),
          /* @__PURE__ */ jsx(Line, { left: "\u041E\u0431\u044A\u0451\u043C \u0432 \u0435\u0434\u0438\u043D\u0438\u0446\u0430\u0445", right: pos.units.toFixed(4) }),
          /* @__PURE__ */ jsx(Line, { left: "\u041F\u0440\u0438 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u0438 \u0441\u0435\u0439\u0447\u0430\u0441", right: fmt(pos.settlement) }),
          /* @__PURE__ */ jsx(Line, { left: "\u0421\u0442\u043E\u043F-\u043B\u043E\u0441\u0441", right: human.stopLoss ? fmt(human.stopLoss) : "\u043D\u0435\u0442" }),
          /* @__PURE__ */ jsx(Line, { left: "\u0422\u0435\u0439\u043A-\u043F\u0440\u043E\u0444\u0438\u0442", right: human.takeProfit ? fmt(human.takeProfit) : "\u043D\u0435\u0442" }),
          /* @__PURE__ */ jsx("div", { className: "grid grid-cols-3 gap-2 mt-4", children: [[0.25, "25%"], [0.5, "50%"], [1, "\u0432\u0441\u0451"]].map(([f, l]) => /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => doClose(f, `\u0437\u0430\u043A\u0440\u044B\u0442\u043E ${l}`),
              className: "rounded-lg py-3 text-[13px]",
              style: { backgroundColor: SURFACE, border: `1px solid ${HAIR}` },
              children: l
            },
            l
          )) })
        ] }) : /* @__PURE__ */ jsx(Blank, { children: "\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u043D\u0435\u0442" }),
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mt-8 mb-3", style: { color: FAINT }, children: "\u0418\u0422\u041E\u0413\u0418" }),
        /* @__PURE__ */ jsx(Line, { left: "\u0421\u0442\u0430\u0440\u0442\u043E\u0432\u044B\u0439 \u043A\u0430\u043F\u0438\u0442\u0430\u043B", right: fmt(human.startingCapital) }),
        /* @__PURE__ */ jsx(Line, { left: "\u042D\u043A\u0432\u0438\u0442\u0438", right: fmt(equity) }),
        /* @__PURE__ */ jsx(
          Line,
          {
            left: "\u0412\u0441\u0435\u0433\u043E \u0437\u0430\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u043E",
            right: fmtSigned(equity - human.startingCapital),
            color: equity >= human.startingCapital ? LONG : SHORT
          }
        ),
        /* @__PURE__ */ jsx(
          Line,
          {
            left: "\u0420\u0435\u0430\u043B\u0438\u0437\u043E\u0432\u0430\u043D\u043D\u044B\u0439 PnL",
            right: fmtSigned(human.realizedPnL),
            color: human.realizedPnL >= 0 ? LONG : SHORT
          }
        ),
        /* @__PURE__ */ jsx(Line, { left: "\u041C\u0435\u0441\u0442\u043E \u0432 \u0440\u0435\u0439\u0442\u0438\u043D\u0433\u0435", right: `${snap.rank} \u0438\u0437 ${snap.totalPlayers}` }),
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mt-8 mb-3", style: { color: FAINT }, children: "\u0412\u0410\u0428\u0418 \u0421\u0414\u0415\u041B\u041A\u0418" }),
        snap.yourTrades.length === 0 ? /* @__PURE__ */ jsx(Blank, { children: "\u0441\u0434\u0435\u043B\u043E\u043A \u043D\u0435 \u0431\u044B\u043B\u043E" }) : snap.yourTrades.map((t, i) => /* @__PURE__ */ jsx(
          Line,
          {
            left: `${(0, import_engine.clock)(t.time)} \xB7 ${t.action === "BUY" ? "\u043F\u043E\u043A\u0443\u043F\u043A\u0430" : t.action === "SELL" ? "\u043F\u0440\u043E\u0434\u0430\u0436\u0430" : "\u0437\u0430\u043A\u0440\u044B\u0442\u0438\u0435"}`,
            right: `${fmt(t.notional, 0)} @ ${t.execPrice.toFixed(2)}${t.realizedPnL !== void 0 ? `  ${fmtSigned(t.realizedPnL)}` : ""}`,
            color: t.flow === "buy" ? LONG : SHORT
          },
          i
        ))
      ] }),
      tab === "\u041E\u0440\u0434\u0435\u0440\u0430" && /* @__PURE__ */ jsxs("div", { className: "px-5 pt-2 pb-6", children: [
        /* @__PURE__ */ jsxs("div", { className: "text-[11px] tracking-[0.15em] mb-3", style: { color: FAINT }, children: [
          "\u041B\u0418\u041C\u0418\u0422\u041D\u042B\u0415 \u0417\u0410\u042F\u0412\u041A\u0418 \xB7 ",
          myLimits.length
        ] }),
        myLimits.length === 0 ? /* @__PURE__ */ jsx(Blank, { children: "\u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0445 \u0437\u0430\u044F\u0432\u043E\u043A \u043D\u0435\u0442" }) : myLimits.map((o) => /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between py-3 border-b", style: { borderColor: HAIR }, children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsxs("div", { className: "text-[13px]", style: { color: o.side === "buy" ? LONG : SHORT }, children: [
              o.side === "buy" ? "\u043F\u043E\u043A\u0443\u043F\u043A\u0430" : "\u043F\u0440\u043E\u0434\u0430\u0436\u0430",
              " ",
              fmt(o.notional, 0)
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "text-[11px] font-mono", style: { color: FAINT }, children: [
              "\u043F\u0440\u0438 \u0446\u0435\u043D\u0435 ",
              o.side === "buy" ? "\u2264" : "\u2265",
              " ",
              o.limitPrice.toFixed(2)
            ] })
          ] }),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: async () => {
                if ((await send({ type: "CANCEL_LIMIT", orderId: o.id })).ok) say("\u0437\u0430\u044F\u0432\u043A\u0430 \u0441\u043D\u044F\u0442\u0430");
              },
              className: "text-[12px]",
              style: { color: DIM },
              children: "\u0441\u043D\u044F\u0442\u044C"
            }
          )
        ] }, o.id)),
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mt-8 mb-3", style: { color: FAINT }, children: "\u0417\u0410\u0429\u0418\u0422\u0410 \u041F\u041E\u0417\u0418\u0426\u0418\u0418" }),
        !pos ? /* @__PURE__ */ jsx(Blank, { children: "\u043D\u0443\u0436\u043D\u0430 \u043E\u0442\u043A\u0440\u044B\u0442\u0430\u044F \u043F\u043E\u0437\u0438\u0446\u0438\u044F" }) : /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between py-3 border-b", style: { borderColor: HAIR }, children: [
            /* @__PURE__ */ jsxs("span", { className: "text-[13px] font-mono", children: [
              "\u0441\u0442\u043E\u043F ",
              human.stopLoss ? fmt(human.stopLoss) : "\u2014"
            ] }),
            human.stopLoss && /* @__PURE__ */ jsx(
              "button",
              {
                onClick: () => send({ type: "PROTECT", clear: "sl", stopLoss: null, takeProfit: null }),
                className: "text-[12px]",
                style: { color: DIM },
                children: "\u0443\u0431\u0440\u0430\u0442\u044C"
              }
            )
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between py-3", children: [
            /* @__PURE__ */ jsxs("span", { className: "text-[13px] font-mono", children: [
              "\u0442\u0435\u0439\u043A ",
              human.takeProfit ? fmt(human.takeProfit) : "\u2014"
            ] }),
            human.takeProfit && /* @__PURE__ */ jsx(
              "button",
              {
                onClick: () => send({ type: "PROTECT", clear: "tp", stopLoss: null, takeProfit: null }),
                className: "text-[12px]",
                style: { color: DIM },
                children: "\u0443\u0431\u0440\u0430\u0442\u044C"
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "text-[11px] tracking-[0.15em] mt-8 mb-3", style: { color: FAINT }, children: [
          "\u0417\u0410\u042F\u0412\u041A\u0418 \u0423\u0427\u0410\u0421\u0422\u041D\u0418\u041A\u041E\u0412 \xB7 ",
          snap.orders.length
        ] }),
        snap.orders.length === 0 ? /* @__PURE__ */ jsx(Blank, { children: "\u0431\u043E\u0442\u044B \u043F\u043E\u043B\u044C\u0437\u0443\u044E\u0442\u0441\u044F \u0441\u0442\u043E\u043F\u0430\u043C\u0438 \u0438 \u0442\u0435\u0439\u043A\u0430\u043C\u0438" }) : snap.orders.slice(0, 20).map((o) => /* @__PURE__ */ jsx(
          Line,
          {
            left: o.playerName,
            right: `${fmt(o.notional, 0)} @ ${o.limitPrice.toFixed(2)}`,
            color: o.side === "buy" ? LONG : SHORT
          },
          o.id
        ))
      ] }),
      tab === "\u0423\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u0438" && /* @__PURE__ */ jsxs("div", { className: "px-5 pt-2 pb-6", children: [
        /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-3 gap-3 mb-5", children: [
          /* @__PURE__ */ jsx(Metric, { label: "\u0412 \u041B\u041E\u041D\u0413\u0415", value: String(stats.longPlayers), color: LONG }),
          /* @__PURE__ */ jsx(Metric, { label: "\u0412 \u0428\u041E\u0420\u0422\u0415", value: String(stats.shortPlayers), color: SHORT }),
          /* @__PURE__ */ jsx(Metric, { label: "\u0412\u041D\u0415 \u0420\u042B\u041D\u041A\u0410", value: String(stats.flatPlayers) })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "flex gap-0.5 mb-2 flex-wrap", children: ["\u0412\u0441\u0435", "\u041B\u043E\u043D\u0433", "\u0428\u043E\u0440\u0442", "\u0412\u043D\u0435 \u0440\u044B\u043D\u043A\u0430", "\u0422\u043E\u043F-15"].map((f) => /* @__PURE__ */ jsx(Toggle, { active: playerFilter === f, onClick: () => setPlayerFilter(f), children: f }, f)) }),
        (() => {
          let list = [...snap.players];
          if (playerFilter === "\u041B\u043E\u043D\u0433") list = list.filter((p) => p.position?.side === "long");
          if (playerFilter === "\u0428\u043E\u0440\u0442") list = list.filter((p) => p.position?.side === "short");
          if (playerFilter === "\u0412\u043D\u0435 \u0440\u044B\u043D\u043A\u0430") list = list.filter((p) => !p.position);
          list.sort((a, b) => b.equity - a.equity);
          if (playerFilter === "\u0422\u043E\u043F-15") list = list.slice(0, 15);
          if (list.length === 0) return /* @__PURE__ */ jsx(Blank, { children: "\u043F\u0443\u0441\u0442\u043E" });
          return list.map((p, i) => {
            const eq = p.equity;
            const delta = eq - p.startingCapital;
            return /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 py-2.5 border-b", style: { borderColor: HAIR }, children: [
              /* @__PURE__ */ jsx("span", { className: "text-[11px] font-mono w-6 shrink-0", style: { color: FAINT }, children: i + 1 }),
              /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1", children: [
                /* @__PURE__ */ jsxs("div", { className: "text-[13px] truncate", style: { color: p.isHuman ? TEXT : DIM }, children: [
                  p.name,
                  p.position && /* @__PURE__ */ jsxs(
                    "span",
                    {
                      className: "ml-2 text-[11px] font-mono",
                      style: { color: p.position.side === "long" ? LONG : SHORT },
                      children: [
                        p.position.side === "long" ? "long" : "short",
                        " ",
                        fmt(p.position.margin, 0)
                      ]
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "text-[11px] truncate", style: { color: FAINT }, children: [
                  p.isHuman ? "\u0436\u0438\u0432\u043E\u0439 \u0438\u0433\u0440\u043E\u043A" : import_engine.STRATEGY_LABELS[p.archetype],
                  " \xB7 \u0441\u0434\u0435\u043B\u043E\u043A ",
                  p.tradeCount
                ] })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "text-right whitespace-nowrap", children: [
                /* @__PURE__ */ jsx("div", { className: "text-[13px] font-mono", children: fmt(eq) }),
                /* @__PURE__ */ jsx("div", { className: "text-[11px] font-mono", style: { color: delta >= 0 ? LONG : SHORT }, children: fmtSigned(delta) })
              ] })
            ] }, p.id);
          });
        })()
      ] }),
      tab === "\u041E\u0442\u043B\u0430\u0434\u043A\u0430" && /* @__PURE__ */ jsxs("div", { className: "px-5 pt-2 pb-6", children: [
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mb-3", style: { color: FAINT }, children: "\u041A\u0410\u041F\u0418\u0422\u0410\u041B \u0421\u0418\u0421\u0422\u0415\u041C\u042B" }),
        /* @__PURE__ */ jsx(Line, { left: "\u041E\u0431\u0449\u0438\u0439 \u043A\u0430\u043F\u0438\u0442\u0430\u043B \u0440\u044B\u043D\u043A\u0430", right: fmt(state.totalCapital) }),
        /* @__PURE__ */ jsx(Line, { left: "\u0421\u0432\u043E\u0431\u043E\u0434\u043D\u044B\u0439 \u043A\u044D\u0448 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u043E\u0432", right: fmt(stats.totalCash) }),
        /* @__PURE__ */ jsx(Line, { left: "\u041A\u044D\u0448 \u043F\u0443\u043B\u0430", right: fmt(snap.debug?.poolCash ?? 0) }),
        /* @__PURE__ */ jsx(Line, { left: "\u042D\u043A\u0432\u0438\u0442\u0438 \u043F\u0443\u043B\u0430", right: fmt(stats.poolEquity) }),
        /* @__PURE__ */ jsx(Line, { left: "\u042D\u043A\u0432\u0438\u0442\u0438 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u043E\u0432", right: fmt(stats.totalEquity) }),
        /* @__PURE__ */ jsx(Line, { left: "\u0421\u0443\u043C\u043C\u0430", right: fmt(stats.totalEquity + stats.poolEquity) }),
        /* @__PURE__ */ jsx(
          Line,
          {
            left: "\u0420\u0430\u0441\u0445\u043E\u0436\u0434\u0435\u043D\u0438\u0435 \u043A\u0430\u043F\u0438\u0442\u0430\u043B\u0430",
            right: (snap.debug?.capitalDrift ?? 0).toExponential(2),
            color: Math.abs(snap.debug?.capitalDrift ?? 0) < 1e-5 ? LONG : SHORT
          }
        ),
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mt-8 mb-3", style: { color: FAINT }, children: "\u041C\u0415\u0425\u0410\u041D\u0418\u041A\u0410 \u0426\u0415\u041D\u042B" }),
        /* @__PURE__ */ jsx(Line, { left: "\u0414\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u043E\u043A\u0443\u043F\u043E\u043A", right: fmt(state.buyPressure) }),
        /* @__PURE__ */ jsx(Line, { left: "\u0414\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u0440\u043E\u0434\u0430\u0436", right: fmt(state.sellPressure) }),
        /* @__PURE__ */ jsx(
          Line,
          {
            left: "\u0427\u0438\u0441\u0442\u043E\u0435 \u0434\u0430\u0432\u043B\u0435\u043D\u0438\u0435",
            right: fmt(state.netPressure),
            color: state.netPressure >= 0 ? LONG : SHORT
          }
        ),
        /* @__PURE__ */ jsx(Line, { left: "\u041B\u0438\u043A\u0432\u0438\u0434\u043D\u043E\u0441\u0442\u044C", right: fmt(state.liquidity) }),
        /* @__PURE__ */ jsx(Line, { left: "\u041A\u0430\u043F\u0438\u0442\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u044F", right: fmt(stats.marketCap) }),
        /* @__PURE__ */ jsx(Line, { left: "\u0424\u0430\u0437\u0430 \u0440\u044B\u043D\u043A\u0430", right: state.phase }),
        /* @__PURE__ */ jsx(Line, { left: "\u0421\u043A\u043E\u0440\u043E\u0441\u0442\u044C (10 \u0442\u0438\u043A\u043E\u0432)", right: (0, import_engine.signedPct)(snap.debug?.context?.speed ?? 0) }),
        /* @__PURE__ */ jsx(Line, { left: "\u0412\u043E\u043B\u0430\u0442\u0438\u043B\u044C\u043D\u043E\u0441\u0442\u044C", right: ((snap.debug?.context?.volatility ?? 0) * 100).toFixed(3) + "%" }),
        /* @__PURE__ */ jsx(Line, { left: "\u041F\u0435\u0440\u0435\u043A\u043E\u0441 \u0442\u043E\u043B\u043F\u044B", right: (0, import_engine.signedPct)(snap.debug?.context?.imbalance ?? 0, 0) }),
        /* @__PURE__ */ jsx(Line, { left: "\u0412\u0441\u0435\u0433\u043E \u0441\u0434\u0435\u043B\u043E\u043A", right: String(snap.totalTrades) }),
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mt-8 mb-2", style: { color: FAINT }, children: "\u0421\u0414\u0415\u041B\u041A\u0418 \u041F\u041E\u0421\u041B\u0415\u0414\u041D\u0415\u0413\u041E \u0422\u0418\u041A\u0410 \xB7 \u041F\u041E\u0427\u0415\u041C\u0423 \u0426\u0415\u041D\u0410 \u0414\u0412\u0418\u041D\u0423\u041B\u0410\u0421\u042C" }),
        (snap.debug?.lastTrades ?? []).length === 0 ? /* @__PURE__ */ jsx(Blank, { children: "\u0441\u0434\u0435\u043B\u043E\u043A \u043D\u0435 \u0431\u044B\u043B\u043E \u2014 \u0446\u0435\u043D\u0430 \u0441\u0442\u043E\u0438\u0442 \u043D\u0430 \u043C\u0435\u0441\u0442\u0435" }) : snap.debug.lastTrades.slice(0, 14).map((t, i) => /* @__PURE__ */ jsx(
          Line,
          {
            left: `${t.playerName} \xB7 ${t.action === "BUY" ? "\u043F\u043E\u043A\u0443\u043F\u043A\u0430" : t.action === "SELL" ? "\u043F\u0440\u043E\u0434\u0430\u0436\u0430" : "\u0437\u0430\u043A\u0440\u044B\u0442\u0438\u0435"} \xB7 ${t.reason}`,
            right: `${fmt(t.notional, 0)} @ ${t.execPrice.toFixed(2)}`,
            color: t.flow === "buy" ? LONG : SHORT
          },
          i
        )),
        /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between mt-8 mb-2", children: [
          /* @__PURE__ */ jsx("span", { className: "text-[11px] tracking-[0.15em]", style: { color: FAINT }, children: "NPC \u0418 \u041F\u0420\u0418\u0427\u0418\u041D\u042B \u0420\u0415\u0428\u0415\u041D\u0418\u0419" }),
          /* @__PURE__ */ jsx("div", { className: "flex gap-0.5", children: ["\u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0435", "\u0432\u0441\u0435"].map((m) => /* @__PURE__ */ jsx(Toggle, { active: npcMode === m, onClick: () => setNpcMode(m), children: m }, m)) })
        ] }),
        (() => {
          let list = snap.players.filter((p) => p.debug);
          if (list.length === 0) return /* @__PURE__ */ jsx(Blank, { children: "\u043E\u0442\u043B\u0430\u0434\u043A\u0430 \u0431\u043E\u0442\u043E\u0432 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0442\u043E\u043B\u044C\u043A\u043E \u0432 dev-\u0440\u0435\u0436\u0438\u043C\u0435" });
          if (npcMode === "\u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0435") {
            list = list.filter((p) => p.position || snap.tick - p.debug.lastActionTick < 120);
          }
          list = list.sort((a, b) => b.debug.lastActionTick - a.debug.lastActionTick).slice(0, 25);
          if (list.length === 0) return /* @__PURE__ */ jsx(Blank, { children: "\u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0438\u043A\u0442\u043E \u043D\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0443\u0435\u0442" });
          return list.map((p) => {
            const pnlNow = p.unrealized;
            return /* @__PURE__ */ jsxs("div", { className: "py-2.5 border-b", style: { borderColor: HAIR }, children: [
              /* @__PURE__ */ jsxs("div", { className: "flex justify-between gap-2", children: [
                /* @__PURE__ */ jsxs("span", { className: "text-[12px] truncate", children: [
                  p.name,
                  " \xB7 ",
                  /* @__PURE__ */ jsx("span", { style: { color: DIM }, children: import_engine.STRATEGY_LABELS[p.archetype] })
                ] }),
                /* @__PURE__ */ jsx("span", { className: "text-[12px] font-mono whitespace-nowrap", children: p.debug.lastAction })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "text-[11px] font-mono mt-0.5", style: { color: FAINT }, children: [
                "\u043A\u0430\u043F\u0438\u0442\u0430\u043B ",
                fmt(p.equity, 0),
                " \xB7",
                " ",
                p.position ? `${p.position.side} ${fmt(p.position.margin, 0)} \u043E\u0442 ${p.position.entryPrice.toFixed(2)} \xB7 ${fmtSigned(pnlNow)}` : "\u0432\u043D\u0435 \u0440\u044B\u043D\u043A\u0430"
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "text-[11px] font-mono", style: { color: FAINT }, children: [
                "\u043E\u043A\u043D\u043E ",
                p.debug.lookback,
                "\u0442 \xB7 \u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u043A\u0430\u0436\u0434\u044B\u0435 ",
                (p.debug.intervalTicks / 10).toFixed(1),
                "\u0441 \xB7",
                " ",
                "\u0442\u043E\u0447\u043D\u043E\u0441\u0442\u044C ",
                (p.debug.accuracy * 100).toFixed(0),
                "% \xB7 \u043E\u0448\u0438\u0431\u043E\u043A ",
                p.debug.mistakes
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "text-[11px] font-mono", style: { color: FAINT }, children: [
                "+",
                p.debug.wins,
                " / \u2212",
                p.debug.losses,
                " \xB7 \u0443\u0432\u0435\u0440\u0435\u043D\u043D\u043E\u0441\u0442\u044C ",
                (p.debug.confidence * 100).toFixed(0),
                "% \xB7",
                " ",
                "\u0440\u0435\u0436\u0438\u043C ",
                p.debug.regimeBias > 0.2 ? "\u0437\u0430 \u0442\u0440\u0435\u043D\u0434\u043E\u043C" : p.debug.regimeBias < -0.2 ? "\u043F\u0440\u043E\u0442\u0438\u0432 \u0442\u0440\u0435\u043D\u0434\u0430" : "\u043D\u0435\u0439\u0442\u0440\u0430\u043B\u044C\u043D\u043E",
                " \xB7",
                " ",
                "\u0441\u043B\u0435\u0434. \u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u0432 ",
                p.debug.nextDecisionTick
              ] }),
              /* @__PURE__ */ jsx("div", { className: "flex flex-wrap gap-x-3 mt-0.5", children: (p.debug.lastReasons ?? []).map(([label, value], i) => /* @__PURE__ */ jsxs(
                "span",
                {
                  className: "text-[11px] font-mono",
                  style: { color: value > 0 ? LONG : value < 0 ? SHORT : FAINT },
                  children: [
                    label,
                    " ",
                    value >= 0 ? "+" : "",
                    value.toFixed(2)
                  ]
                },
                i
              )) })
            ] }, p.id);
          });
        })()
      ] })
    ] }),
    tab === "\u0420\u044B\u043D\u043E\u043A" && /* @__PURE__ */ jsxs("div", { className: "px-4 pt-3 pb-3 border-t", style: { borderColor: HAIR, backgroundColor: BG }, children: [
      sheet && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(
          "div",
          {
            className: "fixed inset-0 z-10",
            style: { backgroundColor: "rgba(0,0,0,0.75)" },
            onClick: () => setSheet(null)
          }
        ),
        /* @__PURE__ */ jsxs(
          "div",
          {
            className: "relative z-20 mb-3 rounded-lg p-3",
            style: { backgroundColor: SURFACE, border: `1px solid ${HAIR}` },
            children: [
              /* @__PURE__ */ jsxs("div", { className: "flex justify-between items-center mb-3", children: [
                /* @__PURE__ */ jsx("span", { className: "text-[12px]", children: sheet === "risk" ? "\u0421\u0442\u043E\u043F \u0438 \u0442\u0435\u0439\u043A" : "\u041B\u0438\u043C\u0438\u0442\u043D\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430" }),
                /* @__PURE__ */ jsx("button", { onClick: () => setSheet(null), className: "text-[11px]", style: { color: DIM }, children: "\u0437\u0430\u043A\u0440\u044B\u0442\u044C" })
              ] }),
              sheet === "risk" ? /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2", children: [
                [["sl", "\u0421\u0422\u041E\u041F", [0.01, 0.02, 0.05], "\u2212"], ["tp", "\u0422\u0415\u0419\u041A", [0.01, 0.03, 0.06], "+"]].map(
                  ([kind, label, steps, sign]) => /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
                    /* @__PURE__ */ jsx("span", { className: "text-[10px] w-10 shrink-0", style: { color: FAINT }, children: label }),
                    steps.map((d) => /* @__PURE__ */ jsxs(
                      "button",
                      {
                        disabled: !pos,
                        onClick: () => setRisk(kind, d),
                        className: "flex-1 py-2.5 rounded text-[12px] font-mono disabled:opacity-25",
                        style: { backgroundColor: RAISED },
                        children: [
                          sign,
                          (d * 100).toFixed(0),
                          "%"
                        ]
                      },
                      d
                    )),
                    /* @__PURE__ */ jsx("span", { className: "w-14 text-right text-[12px] font-mono", style: { color: DIM }, children: kind === "sl" ? human.stopLoss ? human.stopLoss.toFixed(2) : "\u2014" : human.takeProfit ? human.takeProfit.toFixed(2) : "\u2014" })
                  ] }, kind)
                ),
                !pos && /* @__PURE__ */ jsx("div", { className: "text-[11px]", style: { color: FAINT }, children: "\u0423\u0440\u043E\u0432\u043D\u0438 \u0441\u0447\u0438\u0442\u0430\u044E\u0442\u0441\u044F \u043E\u0442 \u0446\u0435\u043D\u044B \u0432\u0445\u043E\u0434\u0430 \u2014 \u0441\u043D\u0430\u0447\u0430\u043B\u0430 \u043E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u043F\u043E\u0437\u0438\u0446\u0438\u044E." })
              ] }) : /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    onClick: () => setLimitSide(limitSide === "buy" ? "sell" : "buy"),
                    className: "px-3 py-2.5 rounded text-[12px] font-semibold whitespace-nowrap",
                    style: { backgroundColor: limitSide === "buy" ? LONG : SHORT, color: BG },
                    children: limitSide === "buy" ? "LONG" : "SHORT"
                  }
                ),
                /* @__PURE__ */ jsx(
                  "input",
                  {
                    value: limitPrice,
                    onChange: (e) => setLimitPrice(e.target.value),
                    inputMode: "decimal",
                    placeholder: `\u0446\u0435\u043D\u0430 \xB7 \u0441\u0435\u0439\u0447\u0430\u0441 ${state.price.toFixed(2)}`,
                    className: "flex-1 min-w-0 rounded px-3 py-2.5 outline-none font-mono text-[13px]",
                    style: { backgroundColor: RAISED, color: TEXT }
                  }
                ),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    onClick: async () => {
                      const res = await send({
                        type: "LIMIT",
                        side: limitSide,
                        notional,
                        limitPrice: Number(limitPrice)
                      });
                      if (res.ok) {
                        setLimitPrice("");
                        setSheet(null);
                        say("\u0437\u0430\u044F\u0432\u043A\u0430 \u0432\u044B\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0430");
                      }
                    },
                    className: "px-4 py-2.5 rounded text-[12px] font-semibold",
                    style: { backgroundColor: TEXT, color: BG },
                    children: "\u041E\u041A"
                  }
                )
              ] })
            ]
          }
        )
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1.5 mb-2.5", children: [
        /* @__PURE__ */ jsxs(
          "div",
          {
            className: "flex-1 flex items-center rounded px-3 py-2 min-w-0",
            style: { backgroundColor: SURFACE },
            children: [
              /* @__PURE__ */ jsx("span", { className: "font-mono text-[13px] mr-1.5", style: { color: FAINT }, children: "$" }),
              /* @__PURE__ */ jsx(
                "input",
                {
                  value: size,
                  onChange: (e) => setSize(e.target.value),
                  inputMode: "decimal",
                  className: "w-full bg-transparent outline-none font-mono text-[15px] min-w-0",
                  style: { color: TEXT }
                }
              )
            ]
          }
        ),
        [0.25, 0.5, 1].map((f) => /* @__PURE__ */ jsxs(
          "button",
          {
            onClick: () => setSize(String(Math.round(human.cash * f))),
            className: "px-2.5 py-2.5 rounded font-mono text-[11px]",
            style: { backgroundColor: SURFACE, color: DIM },
            children: [
              f * 100,
              "%"
            ]
          },
          f
        )),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => setSheet(sheet === "risk" ? null : "risk"),
            className: "px-2.5 py-2.5 rounded text-[11px]",
            style: { backgroundColor: sheet === "risk" ? TEXT : SURFACE, color: sheet === "risk" ? BG : DIM },
            children: "SL/TP"
          }
        ),
        /* @__PURE__ */ jsxs(
          "button",
          {
            onClick: () => setSheet(sheet === "limit" ? null : "limit"),
            className: "px-2.5 py-2.5 rounded text-[11px]",
            style: { backgroundColor: sheet === "limit" ? TEXT : SURFACE, color: sheet === "limit" ? BG : DIM },
            children: [
              "\u043B\u0438\u043C\u0438\u0442",
              myLimits.length ? ` ${myLimits.length}` : ""
            ]
          }
        )
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-3 gap-2", children: [
        /* @__PURE__ */ jsxs(
          "button",
          {
            disabled: notional < 1 && !(pos && pos.side === "short"),
            onClick: doBuy,
            className: "rounded-lg py-3 disabled:opacity-25 flex flex-col items-center",
            style: { backgroundColor: LONG, color: BG, boxShadow: `0 0 26px ${LONG}38` },
            children: [
              /* @__PURE__ */ jsx("span", { className: "font-bold text-[16px] tracking-wide", children: "\u041B\u041E\u041D\u0413" }),
              /* @__PURE__ */ jsx("span", { className: "text-[9px] opacity-70 leading-tight", children: buyHint })
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "button",
          {
            disabled: notional < 1 && !(pos && pos.side === "long"),
            onClick: doSell,
            className: "rounded-lg py-3 disabled:opacity-25 flex flex-col items-center",
            style: { backgroundColor: SHORT, color: BG, boxShadow: `0 0 26px ${SHORT}38` },
            children: [
              /* @__PURE__ */ jsx("span", { className: "font-bold text-[16px] tracking-wide", children: "\u0428\u041E\u0420\u0422" }),
              /* @__PURE__ */ jsx("span", { className: "text-[9px] opacity-70 leading-tight", children: sellHint })
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "button",
          {
            disabled: !pos,
            onClick: () => doClose(1, "\u043F\u043E\u0437\u0438\u0446\u0438\u044F \u0437\u0430\u043A\u0440\u044B\u0442\u0430"),
            className: "rounded-lg py-3 disabled:opacity-25 flex flex-col items-center",
            style: { backgroundColor: SURFACE, border: `1px solid ${HAIR}` },
            children: [
              /* @__PURE__ */ jsx("span", { className: "font-bold text-[16px] tracking-wide", children: "\u0417\u0410\u041A\u0420\u042B\u0422\u042C" }),
              /* @__PURE__ */ jsx("span", { className: "text-[9px] leading-tight", style: { color: pos ? pnlColor : FAINT }, children: pos ? fmtSigned(pnl) : "\u043D\u0435\u0442 \u043F\u043E\u0437\u0438\u0446\u0438\u0438" })
            ]
          }
        )
      ] })
    ] }),
    toast && /* @__PURE__ */ jsx("div", { className: "absolute left-0 right-0 flex justify-center pointer-events-none", style: { bottom: 150 }, children: /* @__PURE__ */ jsx(
      "div",
      {
        className: "px-4 py-2 rounded-full text-[12px]",
        style: { backgroundColor: RAISED, color: toast.color, border: `1px solid ${HAIR}` },
        children: toast.text
      }
    ) }),
    /* @__PURE__ */ jsx("div", { className: "grid grid-cols-5 border-t", style: { borderColor: HAIR }, children: TAB_KEYS.map((key) => /* @__PURE__ */ jsx(
      "button",
      {
        onClick: () => setTab(key),
        className: "py-3 text-[11px]",
        style: { color: tab === key ? TEXT : FAINT },
        children: key
      },
      key
    )) })
  ] }) });
}
function AuthScreen({ onBack }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const friendlyError = (err) => {
    const code = err?.code || "";
    if (code.includes("wrong-password") || code.includes("invalid-credential")) return "\u043D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 email \u0438\u043B\u0438 \u043F\u0430\u0440\u043E\u043B\u044C";
    if (code.includes("user-not-found")) return "\u0430\u043A\u043A\u0430\u0443\u043D\u0442 \u0441 \u0442\u0430\u043A\u0438\u043C email \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D";
    if (code.includes("email-already-in-use")) return "\u044D\u0442\u043E\u0442 email \u0443\u0436\u0435 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D";
    if (code.includes("weak-password")) return "\u043F\u0430\u0440\u043E\u043B\u044C \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439 (\u043C\u0438\u043D\u0438\u043C\u0443\u043C 6 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432)";
    if (code.includes("invalid-email")) return "\u043D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0444\u043E\u0440\u043C\u0430\u0442 email";
    if (code.includes("network-request-failed")) return "\u043D\u0435\u0442 \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u044F \u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u043C";
    return "\u0447\u0442\u043E-\u0442\u043E \u043F\u043E\u0448\u043B\u043E \u043D\u0435 \u0442\u0430\u043A, \u043F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437";
  };
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "signup") {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        if (name.trim()) await updateProfile(cred.user, { displayName: name.trim() });
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  const guest = async () => {
    setError("");
    setBusy(true);
    try {
      await signInAnonymously(auth);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  const resetPassword = async () => {
    if (!email) {
      setError("\u0441\u043D\u0430\u0447\u0430\u043B\u0430 \u0432\u0432\u0435\u0434\u0438\u0442\u0435 email");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setResetSent(true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsx("div", { className: "w-full h-screen flex flex-col", style: { backgroundColor: BG, color: TEXT }, children: /* @__PURE__ */ jsxs("div", { className: "max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6", children: [
    /* @__PURE__ */ jsx("button", { onClick: onBack, className: "text-[12px] mb-8 text-left", style: { color: DIM }, children: "\u2190 \u043D\u0430\u0437\u0430\u0434" }),
    /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.4em] mb-2", style: { color: FAINT }, children: "\u041E\u041D\u041B\u0410\u0419\u041D" }),
    /* @__PURE__ */ jsx("div", { className: "text-[24px] leading-none tracking-tight mb-8", children: mode === "signin" ? "\u0412\u0445\u043E\u0434" : "\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044F" }),
    /* @__PURE__ */ jsxs("form", { onSubmit: submit, className: "flex flex-col gap-3", children: [
      mode === "signup" && /* @__PURE__ */ jsx(
        "input",
        {
          value: name,
          onChange: (e) => setName(e.target.value),
          placeholder: "\u0438\u043C\u044F (\u043D\u0435\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u043E)",
          className: "rounded-lg px-4 py-3 outline-none text-[14px]",
          style: { backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }
        }
      ),
      /* @__PURE__ */ jsx(
        "input",
        {
          value: email,
          onChange: (e) => setEmail(e.target.value),
          type: "email",
          required: true,
          autoComplete: "email",
          placeholder: "email",
          className: "rounded-lg px-4 py-3 outline-none text-[14px]",
          style: { backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }
        }
      ),
      /* @__PURE__ */ jsx(
        "input",
        {
          value: password,
          onChange: (e) => setPassword(e.target.value),
          type: "password",
          required: true,
          autoComplete: mode === "signup" ? "new-password" : "current-password",
          placeholder: "\u043F\u0430\u0440\u043E\u043B\u044C",
          className: "rounded-lg px-4 py-3 outline-none text-[14px]",
          style: { backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }
        }
      ),
      error && /* @__PURE__ */ jsx("div", { className: "text-[12px]", style: { color: SHORT }, children: error }),
      resetSent && /* @__PURE__ */ jsx("div", { className: "text-[12px]", style: { color: LONG }, children: "\u043F\u0438\u0441\u044C\u043C\u043E \u0434\u043B\u044F \u0441\u0431\u0440\u043E\u0441\u0430 \u043F\u0430\u0440\u043E\u043B\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E" }),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "submit",
          disabled: busy,
          className: "rounded-lg py-3.5 text-[14px] font-semibold tracking-[0.1em] disabled:opacity-40",
          style: { backgroundColor: TEXT, color: BG },
          children: busy ? "\u043F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435\u2026" : mode === "signin" ? "\u0412\u041E\u0419\u0422\u0418" : "\u0421\u041E\u0417\u0414\u0410\u0422\u042C \u0410\u041A\u041A\u0410\u0423\u041D\u0422"
        }
      )
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between mt-4 text-[12px]", style: { color: DIM }, children: [
      /* @__PURE__ */ jsx("button", { onClick: () => {
        setMode(mode === "signin" ? "signup" : "signin");
        setError("");
      }, children: mode === "signin" ? "\u043D\u0435\u0442 \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430? \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C\u0441\u044F" : "\u0443\u0436\u0435 \u0435\u0441\u0442\u044C \u0430\u043A\u043A\u0430\u0443\u043D\u0442? \u0432\u043E\u0439\u0442\u0438" }),
      mode === "signin" && /* @__PURE__ */ jsx("button", { onClick: resetPassword, children: "\u0437\u0430\u0431\u044B\u043B\u0438 \u043F\u0430\u0440\u043E\u043B\u044C?" })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 my-6", children: [
      /* @__PURE__ */ jsx("div", { className: "flex-1 h-px", style: { backgroundColor: HAIR } }),
      /* @__PURE__ */ jsx("span", { className: "text-[11px]", style: { color: FAINT }, children: "\u0438\u043B\u0438" }),
      /* @__PURE__ */ jsx("div", { className: "flex-1 h-px", style: { backgroundColor: HAIR } })
    ] }),
    /* @__PURE__ */ jsx(
      "button",
      {
        onClick: guest,
        disabled: busy,
        className: "w-full rounded-lg py-3.5 text-[14px] disabled:opacity-40",
        style: { backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` },
        children: "\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C \u043A\u0430\u043A \u0433\u043E\u0441\u0442\u044C"
      }
    ),
    /* @__PURE__ */ jsx("div", { className: "text-[11px] mt-3 leading-relaxed", style: { color: FAINT }, children: "\u0413\u043E\u0441\u0442\u0435\u0432\u043E\u0439 \u0434\u043E\u0441\u0442\u0443\u043F \u043D\u0435 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D \u043A email \u2014 \u0435\u0441\u043B\u0438 \u043E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430 \u0438\u043B\u0438 \u0441\u043C\u0435\u043D\u0438\u0442\u044C \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E, \u0431\u0430\u043B\u0430\u043D\u0441 \u0438 \u0438\u0441\u0442\u043E\u0440\u0438\u044F \u0441\u0435\u0441\u0441\u0438\u0439 \u043D\u0435 \u0432\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u044F\u0442\u0441\u044F." })
  ] }) });
}
function ModeSelect({ onPick }) {
  return /* @__PURE__ */ jsx("div", { className: "w-full h-screen flex flex-col", style: { backgroundColor: BG, color: TEXT }, children: /* @__PURE__ */ jsxs("div", { className: "max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6", children: [
    /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.4em] mb-2", style: { color: FAINT }, children: "\u0417\u0410\u041A\u0420\u042B\u0422\u042B\u0419 \u0420\u042B\u041D\u041E\u041A" }),
    /* @__PURE__ */ jsx("div", { className: "text-[28px] leading-none tracking-tight mb-10", children: "Market Sandbox" }),
    /* @__PURE__ */ jsxs(
      "button",
      {
        onClick: () => onPick("online"),
        className: "w-full rounded-lg py-5 px-5 text-left mb-3",
        style: { backgroundColor: TEXT, color: BG },
        children: [
          /* @__PURE__ */ jsx("div", { className: "text-[16px] font-semibold tracking-[0.05em]", children: "\u041E\u041D\u041B\u0410\u0419\u041D" }),
          /* @__PURE__ */ jsx("div", { className: "text-[12px] mt-1", style: { color: "#555" }, children: "\u043E\u0431\u0449\u0430\u044F \u043A\u043E\u043C\u043D\u0430\u0442\u0430, \u0434\u043E 100 \u0436\u0438\u0432\u044B\u0445 \u0438\u0433\u0440\u043E\u043A\u043E\u0432, \u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u0432\u0445\u043E\u0434" })
        ]
      }
    ),
    /* @__PURE__ */ jsxs(
      "button",
      {
        onClick: () => onPick("practice"),
        className: "w-full rounded-lg py-5 px-5 text-left",
        style: { backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` },
        children: [
          /* @__PURE__ */ jsx("div", { className: "text-[16px] font-semibold tracking-[0.05em]", children: "\u041F\u0420\u0410\u041A\u0422\u0418\u041A\u0410" }),
          /* @__PURE__ */ jsx("div", { className: "text-[12px] mt-1", style: { color: FAINT }, children: "\u043E\u0444\u043B\u0430\u0439\u043D, \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u044B \u0438 99 \u0431\u043E\u0442\u043E\u0432, \u0431\u0435\u0437 \u0432\u0445\u043E\u0434\u0430" })
        ]
      }
    )
  ] }) });
}
function OnlineLobby({ user, profile, onNew, onSignOut, onExit }) {
  const st = profileStats(profile);
  const affordable = import_engine.CONFIG.market.capitalOptions.some((c) => c <= profile.wallet);
  return /* @__PURE__ */ jsxs("div", { className: "w-full h-screen flex flex-col", style: { backgroundColor: BG, color: TEXT }, children: [
    /* @__PURE__ */ jsxs("div", { className: "max-w-md w-full mx-auto flex-1 overflow-y-auto px-6 pt-10 pb-4", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between mb-2", children: [
        /* @__PURE__ */ jsx("span", { className: "text-[11px] tracking-[0.4em]", style: { color: FAINT }, children: "\u0417\u0410\u041A\u0420\u042B\u0422\u042B\u0419 \u0420\u042B\u041D\u041E\u041A \xB7 \u041E\u041D\u041B\u0410\u0419\u041D" }),
        /* @__PURE__ */ jsx("button", { onClick: onExit, className: "text-[11px]", style: { color: DIM }, children: "\u0441\u043C\u0435\u043D\u0438\u0442\u044C \u0440\u0435\u0436\u0438\u043C" })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "text-[28px] leading-none tracking-tight mb-1", children: "Market Sandbox" }),
      /* @__PURE__ */ jsxs("div", { className: "text-[12px] mb-8", style: { color: FAINT }, children: [
        user.isAnonymous ? "\u0433\u043E\u0441\u0442\u044C" : user.displayName || user.email,
        " \xB7",
        " ",
        /* @__PURE__ */ jsx("button", { onClick: onSignOut, style: { color: DIM }, children: "\u0432\u044B\u0439\u0442\u0438 \u0438\u0437 \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430" })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mb-2", style: { color: FAINT }, children: "\u0411\u0410\u041B\u0410\u041D\u0421" }),
      /* @__PURE__ */ jsx("div", { className: "text-[44px] leading-none font-mono tracking-tight", children: fmt(profile.wallet) }),
      /* @__PURE__ */ jsx(
        "div",
        {
          className: "text-[13px] font-mono mt-2",
          style: { color: st.total > 0 ? LONG : st.total < 0 ? SHORT : DIM },
          children: st.count === 0 ? "\u0441\u0435\u0441\u0441\u0438\u0439 \u0435\u0449\u0451 \u043D\u0435 \u0431\u044B\u043B\u043E" : `${fmtSigned(st.total)} \u0437\u0430 ${st.count} \u0441\u0435\u0441\u0441.`
        }
      ),
      /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-4 gap-3 mt-8", children: [
        /* @__PURE__ */ jsx(Metric, { label: "\u0421\u0415\u0421\u0421\u0418\u0419", value: String(st.count) }),
        /* @__PURE__ */ jsx(Metric, { label: "\u041F\u0420\u0418\u0411\u042B\u041B\u042C\u041D\u042B\u0425", value: st.count ? `${st.wins}` : "\u2014", color: st.wins > 0 ? LONG : TEXT }),
        /* @__PURE__ */ jsx(Metric, { label: "\u041B\u0423\u0427\u0428\u0410\u042F", value: st.count ? fmtSigned(st.best, 0) : "\u2014", color: st.best > 0 ? LONG : TEXT }),
        /* @__PURE__ */ jsx(Metric, { label: "\u0425\u0423\u0414\u0428\u0410\u042F", value: st.count ? fmtSigned(st.worst, 0) : "\u2014", color: st.worst < 0 ? SHORT : TEXT })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mt-10 mb-1", style: { color: FAINT }, children: "\u0418\u0421\u0422\u041E\u0420\u0418\u042F" }),
      profile.sessions.length === 0 ? /* @__PURE__ */ jsx(Blank, { children: "\u0437\u0434\u0435\u0441\u044C \u043F\u043E\u044F\u0432\u044F\u0442\u0441\u044F \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u044B \u0432\u0430\u0448\u0438\u0445 \u0441\u0435\u0441\u0441\u0438\u0439" }) : profile.sessions.slice(0, 12).map((x, i) => /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between py-2.5 border-b", style: { borderColor: HAIR }, children: [
        /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
          /* @__PURE__ */ jsxs("div", { className: "text-[13px] font-mono", children: [
            fmt(x.capital, 0),
            " \u2192 ",
            fmt(x.equity)
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "text-[11px]", style: { color: FAINT }, children: [
            (0, import_engine.clock)(x.ticks * import_engine.CONFIG.market.tickMs),
            " \u0432 \u0440\u044B\u043D\u043A\u0435 \xB7 \u043C\u0435\u0441\u0442\u043E ",
            x.rank,
            " \u0438\u0437 ",
            import_engine.CONFIG.market.totalPlayers
          ] })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "text-[14px] font-mono", style: { color: x.pnl >= 0 ? LONG : SHORT }, children: fmtSigned(x.pnl) })
      ] }, i))
    ] }),
    /* @__PURE__ */ jsx("div", { className: "max-w-md w-full mx-auto px-6 pb-8 pt-3", children: affordable ? /* @__PURE__ */ jsx(
      "button",
      {
        onClick: onNew,
        className: "w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold",
        style: { backgroundColor: TEXT, color: BG },
        children: "\u041D\u041E\u0412\u0410\u042F \u0421\u0415\u0421\u0421\u0418\u042F"
      }
    ) : /* @__PURE__ */ jsx("div", { className: "text-[12px] text-center", style: { color: FAINT }, children: "\u041D\u0430 \u0431\u0430\u043B\u0430\u043D\u0441\u0435 \u043C\u0435\u043D\u044C\u0448\u0435 \u043C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0432\u0437\u043D\u043E\u0441\u0430. \u041F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u0431\u0430\u043B\u0430\u043D\u0441\u0430 \u0432 \u043E\u043D\u043B\u0430\u0439\u043D-\u0440\u0435\u0436\u0438\u043C\u0435 \u0434\u0435\u043B\u0430\u0435\u0442 \u0441\u0435\u0440\u0432\u0435\u0440 (\u0441\u043C. README \u043F\u0440\u043E\u0435\u043A\u0442\u0430) \u2014 \u0437\u0434\u0435\u0441\u044C \u043E\u043D\u043E \u043D\u0430\u043C\u0435\u0440\u0435\u043D\u043D\u043E \u043D\u0435 \u0440\u0435\u0430\u043B\u0438\u0437\u043E\u0432\u0430\u043D\u043E, \u0447\u0442\u043E\u0431\u044B \u0438\u0433\u0440\u043E\u043A \u043D\u0435 \u043C\u043E\u0433 \u043D\u0430\u0447\u0438\u0441\u043B\u0438\u0442\u044C \u0441\u0435\u0431\u0435 \u0434\u0435\u043D\u044C\u0433\u0438 \u0441\u0430\u043C." }) })
  ] });
}
function ConnectingScreen({ label }) {
  return /* @__PURE__ */ jsx("div", { className: "w-full h-screen flex items-center justify-center", style: { backgroundColor: BG, color: FAINT }, children: /* @__PURE__ */ jsx("span", { className: "text-[12px]", children: label }) });
}
function OnlineGameScreen({ transport, session, onFinish }) {
  const [snapshot, setSnapshot] = useState(null);
  const [status, setStatus] = useState("connecting");
  const [tab, setTab] = useState("\u0420\u044B\u043D\u043E\u043A");
  const [timeframe, setTimeframe] = useState("1\u0441");
  const [chartMode, setChartMode] = useState("\u0441\u0432\u0435\u0447\u0438");
  const [showSettings, setShowSettings] = useState(false);
  const [size, setSize] = useState(String(Math.round(session * 0.3)));
  const [sheet, setSheet] = useState(null);
  const [limitPrice, setLimitPrice] = useState("");
  const [limitSide, setLimitSide] = useState("buy");
  const [playerFilter, setPlayerFilter] = useState("\u0412\u0441\u0435");
  const [toast, setToast] = useState(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const toastTimer = useRef(null);
  useEffect(() => {
    transport.onStatus = setStatus;
    transport.start((next) => setSnapshot(next));
    return () => transport.stop();
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const say = (text, color = TEXT) => {
    setToast({ text, color });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1700);
  };
  if (!snapshot) {
    return /* @__PURE__ */ jsx(ConnectingScreen, { label: status === "reconnecting" ? "\u043F\u0435\u0440\u0435\u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435\u2026" : "\u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u043A \u043A\u043E\u043C\u043D\u0430\u0442\u0435\u2026" });
  }
  const state = snapshot;
  const human = snapshot.you;
  if (!human) {
    return /* @__PURE__ */ jsx(ConnectingScreen, { label: "\u0432\u0445\u043E\u0434\u0438\u043C \u0432 \u043A\u043E\u043C\u043D\u0430\u0442\u0443\u2026" });
  }
  const stats = snapshot.market;
  const notional = Math.max(0, Number(size) || 0);
  const myLimits = snapshot.yourOrders;
  const changeAbs = snapshot.price - snapshot.initialPrice;
  const changePct = changeAbs / snapshot.initialPrice;
  const pos = human.position;
  const pnl = human.unrealized;
  const pnlRatio = pos ? pnl / pos.margin : 0;
  const equity = human.equity;
  const pnlColor = pnl > 0 ? LONG : pnl < 0 ? SHORT : TEXT;
  const refresh = () => setSnapshot(transport.snapshot());
  const send = async (command) => {
    const res = await transport.send(command);
    if (!res.ok) say(res.reason, SHORT);
    refresh();
    return res;
  };
  const buyHint = pos && pos.side === "short" ? "\u0437\u0430\u043A\u0440\u043E\u0435\u0442 Short" : "\u043E\u0442\u043A\u0440\u044B\u0442\u044C / \u0443\u0432\u0435\u043B\u0438\u0447\u0438\u0442\u044C Long";
  const sellHint = pos && pos.side === "long" ? "\u0437\u0430\u043A\u0440\u043E\u0435\u0442 Long" : "\u043E\u0442\u043A\u0440\u044B\u0442\u044C / \u0443\u0432\u0435\u043B\u0438\u0447\u0438\u0442\u044C Short";
  const doBuy = async () => {
    const res = await send({ type: "TRADE", action: "BUY", notional, reason: "\u0440\u0443\u0447\u043D\u0430\u044F \u043F\u043E\u043A\u0443\u043F\u043A\u0430" });
    if (res.ok) say(pos && pos.side === "short" ? "\u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0435\u043C Short" : `\u043F\u043E\u043A\u0443\u043F\u043A\u0430 ${fmt(notional, 0)}`, LONG);
  };
  const doSell = async () => {
    const res = await send({ type: "TRADE", action: "SELL", notional, reason: "\u0440\u0443\u0447\u043D\u0430\u044F \u043F\u0440\u043E\u0434\u0430\u0436\u0430" });
    if (res.ok) say(pos && pos.side === "long" ? "\u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0435\u043C Long" : `\u043F\u0440\u043E\u0434\u0430\u0436\u0430 ${fmt(notional, 0)}`, SHORT);
  };
  const doClose = async (fraction, label) => {
    const res = await send({ type: "TRADE", action: "CLOSE", fraction, reason: "\u0440\u0443\u0447\u043D\u043E\u0435 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u0435" });
    if (res.ok) say(label);
  };
  const setRisk = async (kind, delta) => {
    if (!pos) return;
    const long = pos.side === "long";
    const target = kind === "sl" ? long ? pos.entryPrice * (1 - delta) : pos.entryPrice * (1 + delta) : long ? pos.entryPrice * (1 + delta) : pos.entryPrice * (1 - delta);
    const res = await send({
      type: "PROTECT",
      stopLoss: kind === "sl" ? target : null,
      takeProfit: kind === "tp" ? target : null
    });
    if (res.ok) say(`${kind === "sl" ? "\u0441\u0442\u043E\u043F" : "\u0442\u0435\u0439\u043A"} ${target.toFixed(2)}`);
  };
  const doFinish = async () => {
    setEnding(true);
    try {
      await onFinish();
    } finally {
      setEnding(false);
    }
  };
  const TAB_KEYS = ["\u0420\u044B\u043D\u043E\u043A", "\u041F\u043E\u0437\u0438\u0446\u0438\u0438", "\u041E\u0440\u0434\u0435\u0440\u0430", "\u0423\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u0438"];
  const statusLabel = status === "online" ? "LIVE" : status === "reconnecting" ? "\u041F\u0415\u0420\u0415\u041F\u041E\u0414\u041A\u041B\u042E\u0427\u0415\u041D\u0418\u0415" : "\u041F\u041E\u0414\u041A\u041B\u042E\u0427\u0415\u041D\u0418\u0415";
  const statusColor = status === "online" ? TEXT : SHORT;
  return /* @__PURE__ */ jsx("div", { className: "w-full h-screen flex flex-col", style: { backgroundColor: BG, color: TEXT }, children: /* @__PURE__ */ jsxs("div", { className: "max-w-md w-full mx-auto flex flex-col h-full relative", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between px-5 py-3", children: [
      /* @__PURE__ */ jsxs("span", { className: "text-[11px] tracking-[0.3em]", style: { color: FAINT }, children: [
        import_engine.CONFIG.market.assetSymbol,
        " \xB7 ",
        fmt(session, 0)
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-4", children: [
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1.5", children: [
          /* @__PURE__ */ jsx("span", { className: "w-1.5 h-1.5 rounded-full", style: { backgroundColor: statusColor } }),
          /* @__PURE__ */ jsx("span", { className: "text-[11px] tracking-[0.15em]", style: { color: status === "online" ? DIM : SHORT }, children: statusLabel })
        ] }),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => setShowSettings((v) => !v),
            className: "text-[11px] tracking-[0.15em]",
            style: { color: showSettings ? TEXT : FAINT },
            children: "\u0415\u0429\u0401"
          }
        )
      ] })
    ] }),
    showSettings && /* @__PURE__ */ jsx("div", { className: "px-5 pb-4 flex flex-col gap-3", children: confirmingEnd ? /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          onClick: () => setConfirmingEnd(false),
          className: "flex-1 rounded-lg py-3 text-[13px]",
          style: { backgroundColor: SURFACE, border: `1px solid ${HAIR}` },
          children: "\u041E\u0442\u043C\u0435\u043D\u0430"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          onClick: doFinish,
          disabled: ending,
          className: "flex-1 rounded-lg py-3 text-[13px] font-semibold disabled:opacity-40",
          style: { backgroundColor: SHORT, color: BG },
          children: ending ? "\u0437\u0430\u0432\u0435\u0440\u0448\u0430\u0435\u043C\u2026" : "\u0414\u0430, \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C"
        }
      )
    ] }) : /* @__PURE__ */ jsxs(
      "button",
      {
        onClick: () => setConfirmingEnd(true),
        className: "rounded-lg py-3 text-[13px]",
        style: { backgroundColor: SURFACE, border: `1px solid ${HAIR}` },
        children: [
          "\u0417\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E \xB7 ",
          fmt(equity),
          " \u043D\u0430 \u0431\u0430\u043B\u0430\u043D\u0441"
        ]
      }
    ) }),
    /* @__PURE__ */ jsxs("div", { className: "flex-1 overflow-y-auto", children: [
      tab === "\u0420\u044B\u043D\u043E\u043A" && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsxs("div", { className: "px-5 pt-1 flex items-end justify-between", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "text-[46px] leading-none font-mono tracking-tight", children: fmt(state.price) }),
            /* @__PURE__ */ jsxs("div", { className: "text-[14px] font-mono mt-1.5", style: { color: changeAbs >= 0 ? LONG : SHORT }, children: [
              changeAbs >= 0 ? "+" : "\u2212",
              Math.abs(changePct * 100).toFixed(2),
              "%"
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "text-right", children: [
            /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em]", style: { color: DIM }, children: state.phase }),
            /* @__PURE__ */ jsxs("div", { className: "text-[11px] font-mono mt-1", style: { color: FAINT }, children: [
              stats.activePositions,
              " / ",
              import_engine.CONFIG.market.totalPlayers,
              " \u0432 \u0440\u044B\u043D\u043A\u0435"
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "px-5 pt-4", children: /* @__PURE__ */ jsxs("div", { className: "h-1 w-full flex rounded-full overflow-hidden", style: { backgroundColor: HAIR }, children: [
          /* @__PURE__ */ jsx("div", { style: { width: `${stats.longShare * 100}%`, backgroundColor: LONG } }),
          /* @__PURE__ */ jsx("div", { style: { width: `${stats.shortShare * 100}%`, backgroundColor: SHORT } })
        ] }) }),
        /* @__PURE__ */ jsxs("div", { className: "px-5 pt-4 grid grid-cols-4 gap-3", children: [
          /* @__PURE__ */ jsx(Metric, { label: "LONG", value: fmt(stats.longExposure, 0), color: LONG }),
          /* @__PURE__ */ jsx(Metric, { label: "SHORT", value: fmt(stats.shortExposure, 0), color: SHORT }),
          /* @__PURE__ */ jsx(Metric, { label: "BUY PRESS", value: fmt(state.buyPressure, 0) }),
          /* @__PURE__ */ jsx(Metric, { label: "SELL PRESS", value: fmt(state.sellPressure, 0) })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between px-5 pt-5", children: [
          /* @__PURE__ */ jsx("div", { className: "flex gap-0.5", children: TIMEFRAMES.map((tf) => /* @__PURE__ */ jsx(Toggle, { active: timeframe === tf.label, onClick: () => setTimeframe(tf.label), children: tf.label }, tf.label)) }),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => setChartMode(chartMode === "\u0441\u0432\u0435\u0447\u0438" ? "\u043B\u0438\u043D\u0438\u044F" : "\u0441\u0432\u0435\u0447\u0438"),
              className: "text-[12px]",
              style: { color: DIM },
              children: chartMode
            }
          )
        ] }),
        /* @__PURE__ */ jsx("div", { className: "px-2 pt-1", children: /* @__PURE__ */ jsx(
          Chart,
          {
            state,
            timeframe,
            mode: chartMode,
            entryPrice: pos?.entryPrice,
            stopLoss: human.stopLoss,
            takeProfit: human.takeProfit
          }
        ) }),
        /* @__PURE__ */ jsxs("div", { className: "px-5 pb-4 grid grid-cols-4 gap-3", children: [
          /* @__PURE__ */ jsx(Metric, { label: "\u042D\u041A\u0412\u0418\u0422\u0418", value: fmt(equity) }),
          /* @__PURE__ */ jsx(Metric, { label: "\u0421\u0412\u041E\u0411\u041E\u0414\u041D\u041E", value: fmt(human.cash) }),
          /* @__PURE__ */ jsx(
            Metric,
            {
              label: "\u041F\u041E\u0417\u0418\u0426\u0418\u042F",
              value: pos ? `${pos.side === "long" ? "LONG" : "SHORT"} ${fmt(pos.margin, 0)}` : "\u2014",
              color: pos ? pos.side === "long" ? LONG : SHORT : TEXT
            }
          ),
          /* @__PURE__ */ jsx(Metric, { label: "PNL", value: pos ? fmtSigned(pnl) : "\u2014", color: pnlColor })
        ] })
      ] }),
      tab === "\u041F\u043E\u0437\u0438\u0446\u0438\u0438" && /* @__PURE__ */ jsxs("div", { className: "px-5 pt-2 pb-6", children: [
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mb-3", style: { color: FAINT }, children: "\u041F\u041E\u0417\u0418\u0426\u0418\u042F" }),
        pos ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-baseline justify-between mb-4", children: [
            /* @__PURE__ */ jsx("span", { className: "text-[26px]", style: { color: pos.side === "long" ? LONG : SHORT }, children: pos.side === "long" ? "LONG" : "SHORT" }),
            /* @__PURE__ */ jsx("span", { className: "text-[20px] font-mono", children: fmt(pos.margin) }),
            /* @__PURE__ */ jsxs("span", { className: "text-[15px] font-mono", style: { color: pnlColor }, children: [
              fmtSigned(pnl),
              " \xB7 ",
              (0, import_engine.signedPct)(pnlRatio)
            ] })
          ] }),
          /* @__PURE__ */ jsx(Line, { left: "\u0426\u0435\u043D\u0430 \u0432\u0445\u043E\u0434\u0430", right: fmt(pos.entryPrice) }),
          /* @__PURE__ */ jsx(Line, { left: "\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0446\u0435\u043D\u0430", right: fmt(state.price) }),
          /* @__PURE__ */ jsx(Line, { left: "\u041E\u0431\u044A\u0451\u043C \u0432 \u0435\u0434\u0438\u043D\u0438\u0446\u0430\u0445", right: pos.units.toFixed(4) }),
          /* @__PURE__ */ jsx(Line, { left: "\u041F\u0440\u0438 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u0438 \u0441\u0435\u0439\u0447\u0430\u0441", right: fmt(pos.settlement) }),
          /* @__PURE__ */ jsx(Line, { left: "\u0421\u0442\u043E\u043F-\u043B\u043E\u0441\u0441", right: human.stopLoss ? fmt(human.stopLoss) : "\u043D\u0435\u0442" }),
          /* @__PURE__ */ jsx(Line, { left: "\u0422\u0435\u0439\u043A-\u043F\u0440\u043E\u0444\u0438\u0442", right: human.takeProfit ? fmt(human.takeProfit) : "\u043D\u0435\u0442" }),
          /* @__PURE__ */ jsx("div", { className: "grid grid-cols-3 gap-2 mt-4", children: [[0.25, "25%"], [0.5, "50%"], [1, "\u0432\u0441\u0451"]].map(([f, l]) => /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => doClose(f, `\u0437\u0430\u043A\u0440\u044B\u0442\u043E ${l}`),
              className: "rounded-lg py-3 text-[13px]",
              style: { backgroundColor: SURFACE, border: `1px solid ${HAIR}` },
              children: l
            },
            l
          )) })
        ] }) : /* @__PURE__ */ jsx(Blank, { children: "\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u043D\u0435\u0442" }),
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mt-8 mb-3", style: { color: FAINT }, children: "\u0418\u0422\u041E\u0413\u0418" }),
        /* @__PURE__ */ jsx(Line, { left: "\u0421\u0442\u0430\u0440\u0442\u043E\u0432\u044B\u0439 \u043A\u0430\u043F\u0438\u0442\u0430\u043B", right: fmt(human.startingCapital) }),
        /* @__PURE__ */ jsx(Line, { left: "\u042D\u043A\u0432\u0438\u0442\u0438", right: fmt(equity) }),
        /* @__PURE__ */ jsx(
          Line,
          {
            left: "\u0412\u0441\u0435\u0433\u043E \u0437\u0430\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u043E",
            right: fmtSigned(equity - human.startingCapital),
            color: equity >= human.startingCapital ? LONG : SHORT
          }
        ),
        /* @__PURE__ */ jsx(
          Line,
          {
            left: "\u0420\u0435\u0430\u043B\u0438\u0437\u043E\u0432\u0430\u043D\u043D\u044B\u0439 PnL",
            right: fmtSigned(human.realizedPnL),
            color: human.realizedPnL >= 0 ? LONG : SHORT
          }
        ),
        /* @__PURE__ */ jsx(Line, { left: "\u041C\u0435\u0441\u0442\u043E \u0432 \u0440\u0435\u0439\u0442\u0438\u043D\u0433\u0435", right: snapshot.rank ? `${snapshot.rank} \u0438\u0437 ${snapshot.totalPlayers}` : "\u043E\u0431\u043D\u043E\u0432\u043B\u044F\u0435\u0442\u0441\u044F\u2026" })
      ] }),
      tab === "\u041E\u0440\u0434\u0435\u0440\u0430" && /* @__PURE__ */ jsxs("div", { className: "px-5 pt-2 pb-6", children: [
        /* @__PURE__ */ jsxs("div", { className: "text-[11px] tracking-[0.15em] mb-3", style: { color: FAINT }, children: [
          "\u041B\u0418\u041C\u0418\u0422\u041D\u042B\u0415 \u0417\u0410\u042F\u0412\u041A\u0418 \xB7 ",
          myLimits.length
        ] }),
        myLimits.length === 0 ? /* @__PURE__ */ jsx(Blank, { children: "\u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0445 \u0437\u0430\u044F\u0432\u043E\u043A \u043D\u0435\u0442" }) : myLimits.map((o) => /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between py-3 border-b", style: { borderColor: HAIR }, children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsxs("div", { className: "text-[13px]", style: { color: o.side === "buy" ? LONG : SHORT }, children: [
              o.side === "buy" ? "\u043F\u043E\u043A\u0443\u043F\u043A\u0430" : "\u043F\u0440\u043E\u0434\u0430\u0436\u0430",
              " ",
              fmt(o.notional, 0)
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "text-[11px] font-mono", style: { color: FAINT }, children: [
              "\u043F\u0440\u0438 \u0446\u0435\u043D\u0435 ",
              o.side === "buy" ? "\u2264" : "\u2265",
              " ",
              o.limitPrice.toFixed(2)
            ] })
          ] }),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: async () => {
                if ((await send({ type: "CANCEL_LIMIT", orderId: o.id })).ok) say("\u0437\u0430\u044F\u0432\u043A\u0430 \u0441\u043D\u044F\u0442\u0430");
              },
              className: "text-[12px]",
              style: { color: DIM },
              children: "\u0441\u043D\u044F\u0442\u044C"
            }
          )
        ] }, o.id)),
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mt-8 mb-3", style: { color: FAINT }, children: "\u0417\u0410\u0429\u0418\u0422\u0410 \u041F\u041E\u0417\u0418\u0426\u0418\u0418" }),
        !pos ? /* @__PURE__ */ jsx(Blank, { children: "\u043D\u0443\u0436\u043D\u0430 \u043E\u0442\u043A\u0440\u044B\u0442\u0430\u044F \u043F\u043E\u0437\u0438\u0446\u0438\u044F" }) : /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between py-3 border-b", style: { borderColor: HAIR }, children: [
            /* @__PURE__ */ jsxs("span", { className: "text-[13px] font-mono", children: [
              "\u0441\u0442\u043E\u043F ",
              human.stopLoss ? fmt(human.stopLoss) : "\u2014"
            ] }),
            human.stopLoss && /* @__PURE__ */ jsx(
              "button",
              {
                onClick: () => send({ type: "PROTECT", clear: "sl", stopLoss: null, takeProfit: null }),
                className: "text-[12px]",
                style: { color: DIM },
                children: "\u0443\u0431\u0440\u0430\u0442\u044C"
              }
            )
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between py-3", children: [
            /* @__PURE__ */ jsxs("span", { className: "text-[13px] font-mono", children: [
              "\u0442\u0435\u0439\u043A ",
              human.takeProfit ? fmt(human.takeProfit) : "\u2014"
            ] }),
            human.takeProfit && /* @__PURE__ */ jsx(
              "button",
              {
                onClick: () => send({ type: "PROTECT", clear: "tp", stopLoss: null, takeProfit: null }),
                className: "text-[12px]",
                style: { color: DIM },
                children: "\u0443\u0431\u0440\u0430\u0442\u044C"
              }
            )
          ] })
        ] })
      ] }),
      tab === "\u0423\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u0438" && /* @__PURE__ */ jsxs("div", { className: "px-5 pt-2 pb-6", children: [
        /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-3 gap-3 mb-5", children: [
          /* @__PURE__ */ jsx(Metric, { label: "\u0412 \u041B\u041E\u041D\u0413\u0415", value: String(stats.longPlayers), color: LONG }),
          /* @__PURE__ */ jsx(Metric, { label: "\u0412 \u0428\u041E\u0420\u0422\u0415", value: String(stats.shortPlayers), color: SHORT }),
          /* @__PURE__ */ jsx(Metric, { label: "\u0412\u041D\u0415 \u0420\u042B\u041D\u041A\u0410", value: String(stats.flatPlayers) })
        ] }),
        !snapshot.players ? /* @__PURE__ */ jsx(Blank, { children: "\u0441\u043F\u0438\u0441\u043E\u043A \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u043E\u0432 \u043E\u0431\u043D\u043E\u0432\u043B\u044F\u0435\u0442\u0441\u044F \u0440\u0430\u0437 \u0432 \u0441\u0435\u043A\u0443\u043D\u0434\u0443\u2026" }) : /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx("div", { className: "flex gap-0.5 mb-2 flex-wrap", children: ["\u0412\u0441\u0435", "\u041B\u043E\u043D\u0433", "\u0428\u043E\u0440\u0442", "\u0412\u043D\u0435 \u0440\u044B\u043D\u043A\u0430", "\u0422\u043E\u043F-15"].map((f) => /* @__PURE__ */ jsx(Toggle, { active: playerFilter === f, onClick: () => setPlayerFilter(f), children: f }, f)) }),
          (() => {
            let list = [...snapshot.players];
            if (playerFilter === "\u041B\u043E\u043D\u0433") list = list.filter((p) => p.position?.side === "long");
            if (playerFilter === "\u0428\u043E\u0440\u0442") list = list.filter((p) => p.position?.side === "short");
            if (playerFilter === "\u0412\u043D\u0435 \u0440\u044B\u043D\u043A\u0430") list = list.filter((p) => !p.position);
            list.sort((a, b) => b.equity - a.equity);
            if (playerFilter === "\u0422\u043E\u043F-15") list = list.slice(0, 15);
            if (list.length === 0) return /* @__PURE__ */ jsx(Blank, { children: "\u043F\u0443\u0441\u0442\u043E" });
            return list.map((p, i) => {
              const eq = p.equity;
              const delta = eq - p.startingCapital;
              return /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 py-2.5 border-b", style: { borderColor: HAIR }, children: [
                /* @__PURE__ */ jsx("span", { className: "text-[11px] font-mono w-6 shrink-0", style: { color: FAINT }, children: i + 1 }),
                /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1", children: [
                  /* @__PURE__ */ jsxs("div", { className: "text-[13px] truncate", style: { color: p.isHuman ? TEXT : DIM }, children: [
                    p.name,
                    p.position && /* @__PURE__ */ jsxs(
                      "span",
                      {
                        className: "ml-2 text-[11px] font-mono",
                        style: { color: p.position.side === "long" ? LONG : SHORT },
                        children: [
                          p.position.side === "long" ? "long" : "short",
                          " ",
                          fmt(p.position.margin, 0)
                        ]
                      }
                    )
                  ] }),
                  /* @__PURE__ */ jsxs("div", { className: "text-[11px] truncate", style: { color: FAINT }, children: [
                    p.isHuman ? "\u0436\u0438\u0432\u043E\u0439 \u0438\u0433\u0440\u043E\u043A" : import_engine.STRATEGY_LABELS[p.archetype],
                    " \xB7 \u0441\u0434\u0435\u043B\u043E\u043A ",
                    p.tradeCount
                  ] })
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "text-right whitespace-nowrap", children: [
                  /* @__PURE__ */ jsx("div", { className: "text-[13px] font-mono", children: fmt(eq) }),
                  /* @__PURE__ */ jsx("div", { className: "text-[11px] font-mono", style: { color: delta >= 0 ? LONG : SHORT }, children: fmtSigned(delta) })
                ] })
              ] }, p.id);
            });
          })()
        ] })
      ] })
    ] }),
    tab === "\u0420\u044B\u043D\u043E\u043A" && /* @__PURE__ */ jsxs("div", { className: "px-4 pt-3 pb-3 border-t", style: { borderColor: HAIR, backgroundColor: BG }, children: [
      sheet && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(
          "div",
          {
            className: "fixed inset-0 z-10",
            style: { backgroundColor: "rgba(0,0,0,0.75)" },
            onClick: () => setSheet(null)
          }
        ),
        /* @__PURE__ */ jsxs(
          "div",
          {
            className: "relative z-20 mb-3 rounded-lg p-3",
            style: { backgroundColor: SURFACE, border: `1px solid ${HAIR}` },
            children: [
              /* @__PURE__ */ jsxs("div", { className: "flex justify-between items-center mb-3", children: [
                /* @__PURE__ */ jsx("span", { className: "text-[12px]", children: sheet === "risk" ? "\u0421\u0442\u043E\u043F \u0438 \u0442\u0435\u0439\u043A" : "\u041B\u0438\u043C\u0438\u0442\u043D\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430" }),
                /* @__PURE__ */ jsx("button", { onClick: () => setSheet(null), className: "text-[11px]", style: { color: DIM }, children: "\u0437\u0430\u043A\u0440\u044B\u0442\u044C" })
              ] }),
              sheet === "risk" ? /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2", children: [
                [["sl", "\u0421\u0422\u041E\u041F", [0.01, 0.02, 0.05], "\u2212"], ["tp", "\u0422\u0415\u0419\u041A", [0.01, 0.03, 0.06], "+"]].map(
                  ([kind, label, steps, sign]) => /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
                    /* @__PURE__ */ jsx("span", { className: "text-[10px] w-10 shrink-0", style: { color: FAINT }, children: label }),
                    steps.map((d) => /* @__PURE__ */ jsxs(
                      "button",
                      {
                        disabled: !pos,
                        onClick: () => setRisk(kind, d),
                        className: "flex-1 py-2.5 rounded text-[12px] font-mono disabled:opacity-25",
                        style: { backgroundColor: RAISED },
                        children: [
                          sign,
                          (d * 100).toFixed(0),
                          "%"
                        ]
                      },
                      d
                    )),
                    /* @__PURE__ */ jsx("span", { className: "w-14 text-right text-[12px] font-mono", style: { color: DIM }, children: kind === "sl" ? human.stopLoss ? human.stopLoss.toFixed(2) : "\u2014" : human.takeProfit ? human.takeProfit.toFixed(2) : "\u2014" })
                  ] }, kind)
                ),
                !pos && /* @__PURE__ */ jsx("div", { className: "text-[11px]", style: { color: FAINT }, children: "\u0423\u0440\u043E\u0432\u043D\u0438 \u0441\u0447\u0438\u0442\u0430\u044E\u0442\u0441\u044F \u043E\u0442 \u0446\u0435\u043D\u044B \u0432\u0445\u043E\u0434\u0430 \u2014 \u0441\u043D\u0430\u0447\u0430\u043B\u0430 \u043E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u043F\u043E\u0437\u0438\u0446\u0438\u044E." })
              ] }) : /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    onClick: () => setLimitSide(limitSide === "buy" ? "sell" : "buy"),
                    className: "px-3 py-2.5 rounded text-[12px] font-semibold whitespace-nowrap",
                    style: { backgroundColor: limitSide === "buy" ? LONG : SHORT, color: BG },
                    children: limitSide === "buy" ? "LONG" : "SHORT"
                  }
                ),
                /* @__PURE__ */ jsx(
                  "input",
                  {
                    value: limitPrice,
                    onChange: (e) => setLimitPrice(e.target.value),
                    inputMode: "decimal",
                    placeholder: `\u0446\u0435\u043D\u0430 \xB7 \u0441\u0435\u0439\u0447\u0430\u0441 ${state.price.toFixed(2)}`,
                    className: "flex-1 min-w-0 rounded px-3 py-2.5 outline-none font-mono text-[13px]",
                    style: { backgroundColor: RAISED, color: TEXT }
                  }
                ),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    onClick: async () => {
                      const res = await send({ type: "LIMIT", side: limitSide, notional, limitPrice: Number(limitPrice) });
                      if (res.ok) {
                        setLimitPrice("");
                        setSheet(null);
                        say("\u0437\u0430\u044F\u0432\u043A\u0430 \u0432\u044B\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0430");
                      }
                    },
                    className: "px-4 py-2.5 rounded text-[12px] font-semibold",
                    style: { backgroundColor: TEXT, color: BG },
                    children: "\u041E\u041A"
                  }
                )
              ] })
            ]
          }
        )
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1.5 mb-2.5", children: [
        /* @__PURE__ */ jsxs("div", { className: "flex-1 flex items-center rounded px-3 py-2 min-w-0", style: { backgroundColor: SURFACE }, children: [
          /* @__PURE__ */ jsx("span", { className: "font-mono text-[13px] mr-1.5", style: { color: FAINT }, children: "$" }),
          /* @__PURE__ */ jsx(
            "input",
            {
              value: size,
              onChange: (e) => setSize(e.target.value),
              inputMode: "decimal",
              className: "w-full bg-transparent outline-none font-mono text-[15px] min-w-0",
              style: { color: TEXT }
            }
          )
        ] }),
        [0.25, 0.5, 1].map((f) => /* @__PURE__ */ jsxs(
          "button",
          {
            onClick: () => setSize(String(Math.round(human.cash * f))),
            className: "px-2.5 py-2.5 rounded font-mono text-[11px]",
            style: { backgroundColor: SURFACE, color: DIM },
            children: [
              f * 100,
              "%"
            ]
          },
          f
        )),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => setSheet(sheet === "risk" ? null : "risk"),
            className: "px-2.5 py-2.5 rounded text-[11px]",
            style: { backgroundColor: sheet === "risk" ? TEXT : SURFACE, color: sheet === "risk" ? BG : DIM },
            children: "SL/TP"
          }
        ),
        /* @__PURE__ */ jsxs(
          "button",
          {
            onClick: () => setSheet(sheet === "limit" ? null : "limit"),
            className: "px-2.5 py-2.5 rounded text-[11px]",
            style: { backgroundColor: sheet === "limit" ? TEXT : SURFACE, color: sheet === "limit" ? BG : DIM },
            children: [
              "\u043B\u0438\u043C\u0438\u0442",
              myLimits.length ? ` ${myLimits.length}` : ""
            ]
          }
        )
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-3 gap-2", children: [
        /* @__PURE__ */ jsxs(
          "button",
          {
            disabled: notional < 1 && !(pos && pos.side === "short"),
            onClick: doBuy,
            className: "rounded-lg py-3 disabled:opacity-25 flex flex-col items-center",
            style: { backgroundColor: LONG, color: BG, boxShadow: `0 0 26px ${LONG}38` },
            children: [
              /* @__PURE__ */ jsx("span", { className: "font-bold text-[16px] tracking-wide", children: "\u041B\u041E\u041D\u0413" }),
              /* @__PURE__ */ jsx("span", { className: "text-[9px] opacity-70 leading-tight", children: buyHint })
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "button",
          {
            disabled: notional < 1 && !(pos && pos.side === "long"),
            onClick: doSell,
            className: "rounded-lg py-3 disabled:opacity-25 flex flex-col items-center",
            style: { backgroundColor: SHORT, color: BG, boxShadow: `0 0 26px ${SHORT}38` },
            children: [
              /* @__PURE__ */ jsx("span", { className: "font-bold text-[16px] tracking-wide", children: "\u0428\u041E\u0420\u0422" }),
              /* @__PURE__ */ jsx("span", { className: "text-[9px] opacity-70 leading-tight", children: sellHint })
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "button",
          {
            disabled: !pos,
            onClick: () => doClose(1, "\u043F\u043E\u0437\u0438\u0446\u0438\u044F \u0437\u0430\u043A\u0440\u044B\u0442\u0430"),
            className: "rounded-lg py-3 disabled:opacity-25 flex flex-col items-center",
            style: { backgroundColor: SURFACE, border: `1px solid ${HAIR}` },
            children: [
              /* @__PURE__ */ jsx("span", { className: "font-bold text-[16px] tracking-wide", children: "\u0417\u0410\u041A\u0420\u042B\u0422\u042C" }),
              /* @__PURE__ */ jsx("span", { className: "text-[9px] leading-tight", style: { color: pos ? pnlColor : FAINT }, children: pos ? fmtSigned(pnl) : "\u043D\u0435\u0442 \u043F\u043E\u0437\u0438\u0446\u0438\u0438" })
            ]
          }
        )
      ] })
    ] }),
    toast && /* @__PURE__ */ jsx("div", { className: "absolute left-0 right-0 flex justify-center pointer-events-none", style: { bottom: 150 }, children: /* @__PURE__ */ jsx(
      "div",
      {
        className: "px-4 py-2 rounded-full text-[12px]",
        style: { backgroundColor: RAISED, color: toast.color, border: `1px solid ${HAIR}` },
        children: toast.text
      }
    ) }),
    /* @__PURE__ */ jsx("div", { className: "grid grid-cols-4 border-t", style: { borderColor: HAIR }, children: TAB_KEYS.map((key) => /* @__PURE__ */ jsx(
      "button",
      {
        onClick: () => setTab(key),
        className: "py-3 text-[11px]",
        style: { color: tab === key ? TEXT : FAINT },
        children: key
      },
      key
    )) })
  ] }) });
}
function OnlineApp({ user, onExit }) {
  const [profile, setProfile] = useState(null);
  const [screen, setScreen] = useState("lobby");
  const [result, setResult] = useState(null);
  const [session, setSession] = useState(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const transportRef = useRef(null);
  useEffect(() => {
    const ref = doc(db, "users", user.uid);
    const unsub = onFirestoreSnapshot(ref, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setProfile({
          wallet: data.wallet ?? 0,
          stats: data.stats ?? { sessions: 0, wins: 0, totalPnL: 0, best: 0, worst: 0 },
          sessions: []
          // подробная история подтягивается отдельно, см. README → «Что дальше»
        });
      } else {
        setProfile({ wallet: 25e3, stats: { sessions: 0, wins: 0, totalPnL: 0, best: 0, worst: 0 }, sessions: [] });
      }
    });
    return unsub;
  }, [user.uid]);
  const startSession = async (capital) => {
    setJoining(true);
    setJoinError("");
    try {
      const res = await callRoomService("/api/joinRoom", { method: "POST", body: { capital } });
      if (!res.ok) throw new Error(res.reason || "\u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u043E\u0439\u0442\u0438 \u0432 \u043A\u043E\u043C\u043D\u0430\u0442\u0443");
      transportRef.current = new RemoteTransport({ roomId: res.roomId, playerId: res.playerId });
      setSession({ capital, roomId: res.roomId, playerId: res.playerId });
      setScreen("game");
    } catch (err) {
      setJoinError(err.message || "\u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u043E\u0439\u0442\u0438 \u0432 \u043A\u043E\u043C\u043D\u0430\u0442\u0443");
    } finally {
      setJoining(false);
    }
  };
  const finishSession = async () => {
    const res = await callRoomService("/api/closeSession", { method: "POST", body: { roomId: session.roomId } });
    transportRef.current?.stop();
    transportRef.current = null;
    setResult({ capital: session.capital, ...res });
    setSession(null);
    setScreen("result");
  };
  const handleSignOut = () => signOut(auth);
  if (!profile) return /* @__PURE__ */ jsx(ConnectingScreen, { label: "\u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u043F\u0440\u043E\u0444\u0438\u043B\u044F\u2026" });
  if (screen === "lobby") {
    return /* @__PURE__ */ jsx(
      OnlineLobby,
      {
        user,
        profile,
        onSignOut: handleSignOut,
        onExit,
        onNew: () => setScreen("setup")
      }
    );
  }
  if (screen === "setup") {
    return /* @__PURE__ */ jsx("div", { className: "w-full h-screen flex flex-col", style: { backgroundColor: BG, color: TEXT }, children: /* @__PURE__ */ jsxs("div", { className: "max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6", children: [
      /* @__PURE__ */ jsx("button", { onClick: () => setScreen("lobby"), className: "text-[12px] mb-8 text-left", style: { color: DIM }, children: "\u2190 \u043D\u0430\u0437\u0430\u0434" }),
      /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.15em] mb-3", style: { color: FAINT }, children: "\u0412\u0417\u041D\u041E\u0421 \u0412 \u0421\u0415\u0421\u0421\u0418\u042E" }),
      /* @__PURE__ */ jsx("div", { className: "grid grid-cols-2 gap-2", children: import_engine.CONFIG.market.capitalOptions.map((value) => {
        const locked = value > profile.wallet;
        return /* @__PURE__ */ jsxs(
          "button",
          {
            disabled: locked || joining,
            onClick: () => startSession(value),
            className: "rounded-lg py-5 text-left px-4 transition disabled:opacity-25",
            style: { backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` },
            children: [
              /* @__PURE__ */ jsxs("div", { className: "text-[22px] font-mono", children: [
                "$",
                value.toLocaleString("en-US")
              ] }),
              /* @__PURE__ */ jsx("div", { className: "text-[11px] mt-1", style: { color: FAINT }, children: locked ? "\u043D\u0435 \u0445\u0432\u0430\u0442\u0430\u0435\u0442 \u0431\u0430\u043B\u0430\u043D\u0441\u0430" : `\u0440\u044B\u043D\u043E\u043A $${(value * import_engine.CONFIG.market.totalPlayers).toLocaleString("en-US")}` })
            ]
          },
          value
        );
      }) }),
      joining && /* @__PURE__ */ jsx("div", { className: "text-[12px] mt-4", style: { color: DIM }, children: "\u0438\u0449\u0435\u043C \u0441\u0432\u043E\u0431\u043E\u0434\u043D\u0443\u044E \u043A\u043E\u043C\u043D\u0430\u0442\u0443\u2026" }),
      joinError && /* @__PURE__ */ jsx("div", { className: "text-[12px] mt-4", style: { color: SHORT }, children: joinError }),
      /* @__PURE__ */ jsx("div", { className: "text-[12px] mt-5 leading-relaxed", style: { color: FAINT }, children: "\u041A\u043E\u043C\u043D\u0430\u0442\u0430 \u043E\u0431\u0449\u0430\u044F: \u0440\u044F\u0434\u043E\u043C \u0441 \u0432\u0430\u043C\u0438 \u043C\u043E\u0433\u0443\u0442 \u043E\u043A\u0430\u0437\u0430\u0442\u044C\u0441\u044F \u0434\u0440\u0443\u0433\u0438\u0435 \u0436\u0438\u0432\u044B\u0435 \u0438\u0433\u0440\u043E\u043A\u0438 \u0438 \u0431\u043E\u0442\u044B, \u0434\u043E\u0431\u0438\u0440\u0430\u044E\u0449\u0438\u0435 \u043C\u0435\u0441\u0442\u043E \u0434\u043E 100 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u043E\u0432. \u0412\u0437\u043D\u043E\u0441 \u0441\u043F\u0438\u0441\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0441\u0440\u0430\u0437\u0443 \u0438 \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u0442\u0441\u044F (\u0441 \u0443\u0447\u0451\u0442\u043E\u043C \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u0430) \u043F\u0440\u0438 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0438 \u0441\u0435\u0441\u0441\u0438\u0438." })
    ] }) });
  }
  if (screen === "result" && result) {
    return /* @__PURE__ */ jsxs("div", { className: "w-full h-screen flex flex-col", style: { backgroundColor: BG, color: TEXT }, children: [
      /* @__PURE__ */ jsxs("div", { className: "max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6", children: [
        /* @__PURE__ */ jsx("div", { className: "text-[11px] tracking-[0.4em] mb-3", style: { color: FAINT }, children: "\u0421\u0415\u0421\u0421\u0418\u042F \u0417\u0410\u0412\u0415\u0420\u0428\u0415\u041D\u0410" }),
        /* @__PURE__ */ jsx(
          "div",
          {
            className: "text-[52px] leading-none font-mono tracking-tight",
            style: { color: result.pnl >= 0 ? LONG : SHORT },
            children: fmtSigned(result.pnl)
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "text-[15px] font-mono mt-2", style: { color: DIM }, children: [
          (result.pnl / result.capital * 100).toFixed(2),
          "% \u043E\u0442 \u0432\u0437\u043D\u043E\u0441\u0430"
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "mt-10", children: [
          /* @__PURE__ */ jsx(Line, { left: "\u0412\u0437\u043D\u043E\u0441", right: fmt(result.capital) }),
          /* @__PURE__ */ jsx(Line, { left: "\u0418\u0442\u043E\u0433\u043E\u0432\u044B\u0439 \u043A\u0430\u043F\u0438\u0442\u0430\u043B", right: fmt(result.equity) }),
          /* @__PURE__ */ jsx(Line, { left: "\u041C\u0435\u0441\u0442\u043E \u0432 \u0440\u0435\u0439\u0442\u0438\u043D\u0433\u0435", right: `${result.rank} \u0438\u0437 ${import_engine.CONFIG.market.totalPlayers}` }),
          /* @__PURE__ */ jsx(Line, { left: "\u0421\u0434\u0435\u043B\u043E\u043A", right: String(result.trades) }),
          /* @__PURE__ */ jsx(Line, { left: "\u0412\u0440\u0435\u043C\u044F \u0432 \u0440\u044B\u043D\u043A\u0435", right: (0, import_engine.clock)(result.ticks * import_engine.CONFIG.market.tickMs) }),
          /* @__PURE__ */ jsx(Line, { left: "\u0426\u0435\u043D\u0430 \u043D\u0430 \u0432\u044B\u0445\u043E\u0434\u0435", right: fmt(result.price) })
        ] })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "max-w-md w-full mx-auto px-6 pb-8", children: /* @__PURE__ */ jsx(
        "button",
        {
          onClick: () => {
            setResult(null);
            setScreen("lobby");
          },
          className: "w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold",
          style: { backgroundColor: TEXT, color: BG },
          children: "\u0412 \u041B\u041E\u0411\u0411\u0418"
        }
      ) })
    ] });
  }
  if (screen === "game" && session && transportRef.current) {
    return /* @__PURE__ */ jsx(
      OnlineGameScreen,
      {
        transport: transportRef.current,
        session: session.capital,
        onFinish: finishSession
      },
      session.roomId
    );
  }
  return /* @__PURE__ */ jsx(ConnectingScreen, { label: "\u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0430\u2026" });
}
function MarketSandboxRoot() {
  const [mode, setMode] = useState(null);
  const [authUser, setAuthUser] = useState(void 0);
  const [firebaseError, setFirebaseError] = useState("");
  useEffect(() => {
    if (mode !== "online") return void 0;
    try {
      const { auth: a } = ensureFirebase();
      return onAuthStateChanged(a, setAuthUser);
    } catch (err) {
      setFirebaseError(err.message);
      return void 0;
    }
  }, [mode]);
  if (mode === null) return /* @__PURE__ */ jsx(ModeSelect, { onPick: setMode });
  if (mode === "practice") return /* @__PURE__ */ jsx(PracticeApp, { onExit: () => setMode(null) });
  if (firebaseError) {
    return /* @__PURE__ */ jsxs(
      "div",
      {
        className: "w-full h-screen flex flex-col items-center justify-center px-8 text-center gap-4",
        style: { backgroundColor: BG, color: TEXT },
        children: [
          /* @__PURE__ */ jsx("div", { className: "text-[13px]", style: { color: SHORT }, children: firebaseError }),
          /* @__PURE__ */ jsx("button", { onClick: () => setMode(null), className: "text-[12px]", style: { color: DIM }, children: "\u2190 \u043D\u0430\u0437\u0430\u0434" })
        ]
      }
    );
  }
  if (authUser === void 0) return /* @__PURE__ */ jsx(ConnectingScreen, { label: "\u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C \u0432\u0445\u043E\u0434\u2026" });
  if (!authUser) return /* @__PURE__ */ jsx(AuthScreen, { onBack: () => setMode(null) });
  return /* @__PURE__ */ jsx(OnlineApp, { user: authUser, onExit: () => setMode(null) }, authUser.uid);
}

// entry.jsx
ReactDOM.createRoot(document.getElementById("root")).render(
  React2.createElement(React2.StrictMode, null, React2.createElement(MarketSandboxRoot))
);

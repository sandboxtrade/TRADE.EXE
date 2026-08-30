const { CONFIG, HUMAN_ID, scaleOf } = require("./config");
const { mulberry32, range } = require("./util");
const { decayPressure, nextPrice } = require("./price");
const { computeLiquidity } = require("./liquidity");
const { isLiquidatable } = require("./pnl");
const {
  buildPopulation, createNPCProfile, createMind, buildMarketContext,
  collectNPCIntents,
} = require("./npc");
const { executeIntent, triggerLimitOrders } = require("./orders");

/* ------------------------------ MARKET ENGINE -----------------------------
   Портировано из market-sandbox.jsx. Единственное сущностное изменение
   относительно однопользовательского прототипа: комната изначально
   заполняется ТОЛЬКО ботами (нет захардкоженного HUMAN_ID-игрока), а живые
   участники занимают место бота через takeOverSlot() при входе в комнату —
   это и есть переход от "1 человек + 99 ботов" к "до 100 человек", о котором
   говорит ARCHITECTURE.md, без изменения логики самого движка.
--------------------------------------------------------------------------- */
function createMarket(seed, startingCapital = CONFIG.market.startingCapital) {
  const rng = mulberry32(seed);
  const base = () => ({
    startingCapital, cash: startingCapital,
    position: null, realizedPnL: 0, stopLoss: null, takeProfit: null,
    tradeCount: 0, mind: null,
  });

  const population = buildPopulation();
  for (let i = population.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [population[i], population[j]] = [population[j], population[i]];
  }

  const players = [];
  for (let i = 0; i < CONFIG.market.totalPlayers; i++) {
    const npc = createNPCProfile(rng, population[i] ?? "random");
    players.push({
      id: `bot-${String(i).padStart(3, "0")}`, name: `Бот ${String(i + 1).padStart(2, "0")}`,
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
    lastTickTrades: [], humanTradesById: {}, humanIds: new Set(), totalTrades: 0, capitalDrift: 0,
    context: null, phase: "НАКОПЛЕНИЕ",
    rng,
  };
  state.liquidity = computeLiquidity(state);
  state.context = buildMarketContext(state);
  return { state, rng };
}

/**
 * Занимает свободное место бота живым участником. Предпочитает ботов вне
 * позиции (чтобы не обрывать чужую сделку на середине); если таких нет —
 * берёт бота с наименьшей открытой позицией. Возвращает id занятого места
 * (он же и есть playerId участника дальше) или null, если комната полна.
 */
function takeOverSlot(state, uid, name) {
  if (state.playersById[uid]) return uid; // уже в комнате (переподключение)
  const candidates = state.players.filter((p) => !p.isHuman);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aFlat = a.position ? 1 : 0, bFlat = b.position ? 1 : 0;
    if (aFlat !== bFlat) return aFlat - bFlat;
    return (a.position?.margin ?? 0) - (b.position?.margin ?? 0);
  });
  const bot = candidates[0];

  // Позицию бота закрываем по рынку перед передачей места — человек
  // должен войти "с чистого листа", а не унаследовать чужую сделку.
  if (bot.position) {
    const { closePosition } = require("./orders");
    closePosition(state, bot, "передача места игроку");
  }

  delete state.playersById[bot.id];
  bot.id = uid;
  bot.name = name || "Игрок";
  bot.isHuman = true;
  bot.npc = null;
  bot.mind = null;
  state.playersById[uid] = bot;
  state.humanIds.add(uid);
  state.humanTradesById[uid] = state.humanTradesById[uid] ?? [];
  return uid;
}

/** Освобождает место человека обратно боту при выходе/дисконнекте. */
function releaseSlot(state, uid) {
  const player = state.playersById[uid];
  if (!player || !player.isHuman) return;
  const { closePosition } = require("./orders");
  if (player.position) closePosition(state, player, "выход из комнаты");

  const npc = createNPCProfile(state.rng, "random");
  player.isHuman = false;
  player.npc = npc;
  player.mind = createMind(state.rng, npc, state.tick);
  player.name = `Бот ${player.id}`;
  state.humanIds.delete(uid);
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

  /** Практический (офлайн) режим: единственный человек занимает p-000 сразу. */
  static localSinglePlayer(seed, startingCapital) {
    const engine = new SimulationEngine(seed, startingCapital);
    takeOverSlot(engine.state, HUMAN_ID, "ВЫ");
    return engine;
  }

  addHuman(uid, name) { return takeOverSlot(this.state, uid, name); }
  removeHuman(uid) { releaseSlot(this.state, uid); }

  submit(playerId, intent) { this.queue.push({ ...intent, playerId, source: "human" }); }
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
}

module.exports = {
  createMarket, takeOverSlot, releaseSlot, collectProtectiveIntents, step, SimulationEngine,
};

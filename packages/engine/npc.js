"use strict";
const { CONFIG } = require("./config");

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
module.exports = { attachNPCs, decide, npcIntents, mulberry32, ARCHETYPES, TYPES };

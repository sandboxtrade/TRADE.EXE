import { CONFIG } from "./config.js";
function makeCurve(marketRef) {
    const { P0, beta } = CONFIG;
    const PMIN = P0 * (1 - beta);
    const PMAX = P0 * (1 + beta);
    return {
        PMIN, PMAX,
        value: (u) => Math.abs(u),
        unitsFor: (budget) => Math.max(0, budget),
        clearingPrice: (_Q, du) => marketRef.P + marketRef.depth() * du,
        liquidationPrice: () => marketRef.P,
        p: () => marketRef.P,
    };
}
class Market {
    constructor({ playerCount, startingCapital, seed = 1, leverage = 1 }) {
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
            u: 0,
            entryPrice: null,
            invested: 0, basis: 0,
            realizedPnL: 0, tradeCount: 0,
            stopLoss: null, takeProfit: null,
            liquidatedAt: null,
            npc: null,
        }));
    }
    get mark() { return this.P; }
    get liquidationPrice() { return this.P; }
    get Q() { let s = 0; for (const p of this.players)
        s += p.u; return s; }
    get escrow() { let s = 0; for (const p of this.players)
        s += Math.abs(p.u); return s; }
    sidesBasis() {
        if (this.freeMarket && this._freePreStats) {
            return { L: this._freePreStats.longBasis || 0, S: this._freePreStats.shortBasis || 0 };
        }
        let L = 0, S = 0;
        for (const p of this.players) {
            if (p.u > 0)
                L += p.basis;
            else if (p.u < 0)
                S += p.basis;
        }
        return { L, S };
    }
    sides() {
        let L = 0, S = 0, N = 0;
        for (const p of this.players) {
            if (p.u > 0) {
                L += p.u;
                N++;
            }
            else if (p.u < 0) {
                S -= p.u;
                N++;
            }
        }
        return { L, S, K: Math.min(L, S), N };
    }
    depth() {
        const n = this.players.length;
        const book = this.freeMarket && Number.isFinite(this._freePreStats?.escrow)
            ? this._freePreStats.escrow : this.escrow;
        return Math.pow(n / 100, 0.35) /
            Math.max(1e-9, this.C * CONFIG.DEPTH_FRACTION + CONFIG.DEPTH_BOOK * book);
    }
    settlement(i) { return Math.abs(this.players[i].u); }
    equity(i) { const p = this.players[i]; return p.cash + Math.abs(p.u); }
    unrealized(i) {
        const pl = this.players[i];
        return pl.u === 0 ? 0 : Math.abs(pl.u) - pl.basis;
    }
    sumEquity() { let s = 0; for (const p of this.players)
        s += p.cash + Math.abs(p.u); return s; }
    applyExitPenalty(i, frac) {
        const pl = this.players[i];
        const amount = Math.max(0, this.equity(i)) * frac;
        if (amount <= 0)
            return 0;
        const others = this.players.filter((p) => p.id !== i);
        if (!others.length)
            return 0;
        pl.cash -= amount;
        const share = amount / others.length;
        for (const p of others)
            p.cash += share;
        return amount;
    }
    playerLeverage(i) {
        const pl = this.players[i];
        if (!pl)
            return 1;
        return pl.npc ? this.npcLeverage : this.leverage;
    }
    accrueBorrowCost() {
        if (this.leverage <= 1 || CONFIG.LEV_BORROW_RATE <= 0)
            return;
        let owed = 0, free = 0;
        for (const p of this.players) {
            const lev = this.playerLeverage(p.id);
            if (lev > 1 && p.cash < 0)
                owed += -p.cash;
            else if (p.cash > 0)
                free += p.cash;
        }
        if (owed <= 0 || free <= 0)
            return;
        const fee = Math.min(owed * CONFIG.LEV_BORROW_RATE, free);
        for (const p of this.players) {
            if (this.playerLeverage(p.id) > 1 && p.cash < 0)
                p.cash -= (-p.cash / owed) * fee;
        }
        for (const p of this.players)
            if (p.cash > 0)
                p.cash += (p.cash / free) * fee;
    }
    buyingPower(i) {
        const pl = this.players[i];
        const lev = this.playerLeverage(i);
        return Math.max(0, lev * this.equity(i) - Math.abs(pl.u));
    }
    marginLevel(i) {
        if (this.playerLeverage(i) <= 1)
            return null;
        const pl = this.players[i];
        if (!pl || pl.u === 0)
            return null;
        return this.equity(i) / Math.abs(pl.u);
    }
    liquidationEstimate(i) {
        if (this.playerLeverage(i) <= 1)
            return null;
        const pl = this.players[i];
        if (!pl || pl.u === 0 || pl.basis <= 0)
            return null;
        const borrowed = -Math.min(0, pl.cash);
        if (borrowed <= 0)
            return null;
        const target = borrowed / Math.max(1e-9, 1 - this.maintenance);
        if (target >= Math.abs(pl.u))
            return this.P;
        const half = CONFIG.P0 * CONFIG.beta;
        const move = half * (target / pl.basis - 1);
        const entry = pl.entryPrice ?? this.P;
        const price = pl.u > 0 ? entry + move : entry - move;
        return clamp(price, this.curve.PMIN, this.curve.PMAX);
    }
    marginCalls() {
        if (this.leverage <= 1)
            return [];
        const out = [];
        for (const pl of this.players) {
            if (pl.u === 0 || this.playerLeverage(pl.id) <= 1)
                continue;
            const lvl = this.equity(pl.id) / Math.abs(pl.u);
            if (lvl < this.maintenance)
                out.push({ i: pl.id, du: -pl.u, reason: "liquidation" });
        }
        return out;
    }
    clear(orders) {
        const PRIORITY = { leave: 5, "free-retire": 5, liquidation: 4, stop: 3, take: 3 };
        const merged = new Map();
        for (const o of orders) {
            if (!Number.isFinite(o.du) || o.du === 0)
                continue;
            const reason = o.reason || null;
            const prio = PRIORITY[reason] || 0;
            const cur = merged.get(o.i);
            if (!cur) {
                merged.set(o.i, { i: o.i, du: o.du, reason, priority: prio });
                continue;
            }
            if (prio > cur.priority) {
                cur.du = o.du;
                cur.reason = reason;
                cur.priority = prio;
                continue;
            }
            if (prio < cur.priority)
                continue;
            if (prio > 0)
                continue;
            cur.du += o.du;
        }
        const work = [...merged.values()].filter((o) => Math.abs(o.du) > 1e-12);
        if (!work.length) {
            this.tick++;
            return { price: this.P, executed: [], iters: 0 };
        }
        const { PMIN, PMAX } = this.curve;
        const k = this.depth();
        let flow = 0;
        for (const o of work) {
            const pl = this.players[o.i];
            const before = pl.u;
            let after = before + o.du;
            const budget = this.playerLeverage(pl.id) * (pl.cash + Math.abs(before));
            if (Math.abs(after) > Math.max(budget, Math.abs(before)))
                after = Math.sign(after) * Math.max(budget, Math.abs(before));
            o.after = after;
            o.before = before;
            const closing = before !== 0 && Math.sign(after) !== Math.sign(before)
                ? -before
                : (Math.abs(after) < Math.abs(before) ? after - before : 0);
            const opening = (after - before) - closing;
            flow += opening + CONFIG.CLOSE_IMPACT * closing;
        }
        let Pn = this.P + k * flow;
        if (Pn > PMAX - 1e-6)
            Pn = PMAX - 1e-6;
        if (Pn < PMIN + 1e-6)
            Pn = PMIN + 1e-6;
        const dP = Pn - this.P;
        if (dP !== 0) {
            let L2 = 0, S2 = 0;
            for (const p of this.players) {
                if (merged.has(p.id) || p.u === 0)
                    continue;
                if (p.u > 0)
                    L2 += p.u;
                else
                    S2 -= p.u;
            }
            const K2 = Math.min(L2, S2);
            if (K2 > 0) {
                const fL = K2 / L2, fS = K2 / S2;
                const scale = dP / (CONFIG.P0 * CONFIG.beta);
                for (const p of this.players) {
                    if (merged.has(p.id) || p.u === 0)
                        continue;
                    const m = Math.abs(p.u) * (p.u > 0 ? fL : fS);
                    p.u += m * scale;
                    if (Math.abs(p.u) < 1e-12) {
                        p.u = 0;
                        p.entryPrice = null;
                        p.basis = 0;
                        p.invested = 0;
                        p.stopLoss = null;
                        p.takeProfit = null;
                    }
                }
            }
        }
        this.P = Pn;
        const executed = [];
        for (const o of work) {
            const pl = this.players[o.i];
            const before = o.before, after = o.after;
            if (Math.abs(after - before) < 1e-12)
                continue;
            const sb = Math.abs(before), sa = Math.abs(after);
            pl.cash += sb - sa;
            if (before !== 0 && (after === 0 || Math.sign(after) !== Math.sign(before))) {
                const booked = sb - pl.basis;
                pl.realizedPnL += booked;
                if (before > 0)
                    this.longRealized += booked;
                else
                    this.shortRealized += booked;
                pl.basis = 0;
                pl.invested = 0;
                pl.entryPrice = null;
                pl.stopLoss = null;
                pl.takeProfit = null;
            }
            else if (before !== 0 && sa < sb) {
                const keep = sa / sb;
                const closedBasis = pl.basis * (1 - keep);
                const booked = (sb - sa) - closedBasis;
                pl.realizedPnL += booked;
                if (before > 0)
                    this.longRealized += booked;
                else
                    this.shortRealized += booked;
                pl.basis *= keep;
                pl.invested = pl.basis;
            }
            if (after !== 0) {
                if (before === 0 || Math.sign(after) !== Math.sign(before)) {
                    pl.basis = sa;
                    pl.invested = sa;
                    pl.entryPrice = Pn;
                }
                else if (sa > sb) {
                    pl.basis += sa - sb;
                    pl.invested = pl.basis;
                    pl.entryPrice = Pn;
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
function checkInvariants(m, ctx = {}) {
    const errs = [];
    const scale = Math.max(1, m.C / 10000);
    const TC = CONFIG.TOL_CAPITAL * scale;
    const TN = CONFIG.TOL_NONNEG * scale;
    const totalCash = m.players.reduce((a, p) => a + p.cash, 0);
    if (Math.abs(totalCash + m.escrow - m.C) > TC)
        errs.push(`Σcash+escrow ≠ C: ${(totalCash + m.escrow - m.C).toExponential(3)}`);
    if (Math.abs(m.sumEquity() - m.C) > TC)
        errs.push(`Σequity ≠ C: ${(m.sumEquity() - m.C).toExponential(3)}`);
    if (m.escrow < -TN)
        errs.push(`escrow < 0: ${m.escrow}`);
    const price = m.mark;
    if (price < m.curve.PMIN - TN || price > m.curve.PMAX + TN)
        errs.push(`price вне [${m.curve.PMIN}, ${m.curve.PMAX}]: ${price}`);
    for (const p of m.players) {
        const lev = m.playerLeverage(p.id) > 1;
        if (!lev && p.cash < -TN)
            errs.push(`cash < 0 у #${p.id}: ${p.cash}`);
        if (!lev && m.equity(p.id) < -TN)
            errs.push(`equity < 0 у #${p.id}: ${m.equity(p.id)}`);
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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function mulberry32(a) {
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const ARCHETYPES = {
    aggressive: { size: [0.8, 1.0], act: 0.30, stop: -0.25, take: 0.40, bias: "trend", fast: true },
    conservative: { size: [0.05, 0.2], act: 0.10, stop: -0.05, take: 0.08, bias: "fade", fast: true },
    momentum: { size: [0.2, 0.5], act: 0.35, stop: -0.10, take: 0.25, bias: "trend", fast: true },
    contrarian: { size: [0.2, 0.5], act: 0.35, stop: -0.10, take: 0.25, bias: "fade" },
    random: { size: [0.1, 0.4], act: 0.25, stop: -0.20, take: 0.20, bias: "rand" },
    scared: { size: [0.1, 0.3], act: 0.20, stop: -0.02, take: 0.05, bias: "fade", fast: true },
    greedy: { size: [0.5, 0.9], act: 0.15, stop: -0.30, take: 0.60, bias: "trend" },
    scalper: { size: [0.2, 0.4], act: 0.60, stop: -0.03, take: 0.03, bias: "fade", fast: true },
    longterm: { size: [0.3, 0.6], act: 0.03, stop: -0.40, take: 0.80, bias: "trend" },
    panic: { size: [0.3, 0.6], act: 0.20, stop: -0.08, take: 0.30, bias: "fade", fast: true },
    inactive: { size: [0.05, 0.2], act: 0.02, stop: -0.30, take: 0.30, bias: "rand" },
    breakout: { size: [0.4, 0.8], act: 0.40, stop: -0.12, take: 0.50, bias: "break" },
    herd: { size: [0.3, 0.6], act: 0.25, stop: -0.15, take: 0.35, bias: "herd" },
    hunter: { size: [0.5, 0.9], act: 0.45, stop: -0.10, take: 0.20, bias: "hunt" },
    trap: { size: [0.4, 0.7], act: 0.35, stop: -0.12, take: 0.30, bias: "trap" },
    crowdfade: { size: [0.4, 0.8], act: 0.30, stop: -0.12, take: 0.28, bias: "crowdfade" },
    meanrev: { size: [0.3, 0.7], act: 0.30, stop: -0.10, take: 0.15, bias: "meanrev" },
    range: { size: [0.3, 0.6], act: 0.35, stop: -0.08, take: 0.18, bias: "range" },
    squeeze: { size: [0.4, 0.8], act: 0.30, stop: -0.10, take: 0.35, bias: "squeeze" },
    spike: { size: [0.3, 0.7], act: 0.45, stop: -0.08, take: 0.12, bias: "spike" },
    maker: { size: [0.3, 0.7], act: 0.50, stop: -0.15, take: 0.10, bias: "maker" },
    copycat: { size: [0.3, 0.6], act: 0.25, stop: -0.12, take: 0.25, bias: "copy" },
    sniper: { size: [0.7, 1.0], act: 0.06, stop: -0.10, take: 0.30, bias: "sniper" },
    pullback: { size: [0.4, 0.8], act: 0.30, stop: -0.10, take: 0.30, bias: "pullback" },
    flow: { size: [0.3, 0.7], act: 0.30, stop: -0.12, take: 0.25, bias: "flow" },
    accel: { size: [0.4, 0.8], act: 0.35, stop: -0.10, take: 0.28, bias: "accel" },
    chase: { size: [0.3, 0.6], act: 0.30, stop: -0.12, take: 0.30, bias: "chase" },
};
const TYPES = Object.keys(ARCHETYPES);
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
function windowMean(history, look) {
    const n = Math.min(look, history.length);
    if (n <= 0)
        return NaN;
    let s = 0;
    for (let k = 0; k < n; k++)
        s += history[history.length - 1 - k];
    return s / n;
}
function windowWidth(history, look, P) {
    const { hi, lo } = windowRange(history, look);
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || P <= 0)
        return NaN;
    return (hi - lo) / P;
}
function leaderSide(m) {
    if (m.freeMarket && Number.isFinite(m._freePreStats?.leaderSide))
        return m._freePreStats.leaderSide;
    let best = null, bestPnL = 0;
    for (const p of m.players) {
        if (p.u === 0)
            continue;
        if (p.realizedPnL > bestPnL) {
            bestPnL = p.realizedPnL;
            best = p;
        }
    }
    return best ? Math.sign(best.u) : 0;
}
function windowRange(history, look) {
    const n = history.length;
    let hi = -Infinity, lo = Infinity;
    for (let k = Math.max(0, n - 1 - look); k < n - 1; k++) {
        if (history[k] > hi)
            hi = history[k];
        if (history[k] < lo)
            lo = history[k];
    }
    return { hi, lo };
}
function syncNPCState(m, i) {
    const pl = m.players[i], n = pl.npc;
    if (!n)
        return;
    if (n.startEquity === null)
        n.startEquity = m.equity(i);
    const basisChanged = Math.abs(pl.basis - (n.lastBasis ?? 0)) > 1e-9;
    if (basisChanged || (pl.u === 0) !== (n.lastU === 0)
        || Math.sign(pl.u) !== Math.sign(n.lastU)) {
        if (n.lastU !== 0 && pl.u === 0 && n.entryEquity !== null) {
            const eq = m.equity(i);
            close(n, eq > n.entryEquity, eq);
        }
        n.lastU = pl.u;
        n.lastBasis = pl.basis;
        n.since = 0;
        n.peak = 0;
    }
    else {
        n.lastU = pl.u;
        n.lastBasis = pl.basis;
    }
    n.since++;
    if (n.cooldown > 0)
        n.cooldown--;
}
function decideRaw(m, i, history) {
    const pl = m.players[i], n = pl.npc;
    if (!n)
        return 0;
    const r = n.rng;
    const P = m.mark;
    const equity = m.equity(i);
    const stake = pl.startingCapital ?? m.startingCapital;
    if (pl.u === 0 && pl.cash <= stake * 0.02)
        return 0;
    const ph = m.phase;
    const opening = ph !== null && ph < 0.10;
    const endgame = ph !== null && ph > 0.75;
    const flush = ph !== null && ph > (n.flushAt ?? 0.97);
    const behind = n.startEquity ? equity < n.startEquity : false;
    let phThresh = 1, phSize = 1;
    if (opening) {
        phThresh = 0.45;
        phSize = 1.25;
    }
    else if (endgame) {
        if (behind) {
            phThresh = 0.4;
            phSize = 2.0;
        }
        else {
            phThresh = 2.2;
            phSize = 0.45;
        }
    }
    const lag = Math.max(1, n.lag);
    const at = (k) => history[Math.max(0, history.length - 1 - k)];
    const past = history.length ? at(lag) : P;
    const mom = (P - past) / Math.max(past, 1e-9);
    const slow = history.length ? (P - at(lag + n.look)) / Math.max(at(lag + n.look), 1e-9) : 0;
    if (pl.u !== 0 && pl.entryPrice !== null) {
        const pnl = pl.u > 0 ? (P - pl.entryPrice) / pl.entryPrice
            : (pl.entryPrice - P) / pl.entryPrice;
        if (pnl > n.peak)
            n.peak = pnl;
        const withFlow = (pl.u > 0 ? 1 : -1) * Math.sign(slow) > 0;
        if (Math.abs(pl.u) < stake * 0.01) {
            n.urgent = true;
            close(n, pnl > 0, equity);
            return -pl.u;
        }
        if (flush) {
            n.urgent = true;
            close(n, pnl > 0, equity);
            return -pl.u;
        }
        if (endgame && !behind && pnl > 0 && r() < 0.35) {
            close(n, true, equity);
            return -pl.u;
        }
        if (pnl <= n.stop) {
            n.urgent = true;
            close(n, false, equity);
            return -pl.u;
        }
        if (n.trail > 0) {
            if (n.peak >= n.take * 0.6 && pnl <= n.peak * (1 - n.trail)) {
                n.urgent = true;
                close(n, true, equity);
                return -pl.u;
            }
            if (pnl >= n.take * 2.5 && (!withFlow || r() > n.flexibility)) {
                close(n, true, equity);
                return -pl.u;
            }
        }
        else if (pnl >= n.take) {
            n.urgent = true;
            if (withFlow && r() < n.flexibility * 0.5) {
                n.take *= 1.4;
            }
            else {
                close(n, true, equity);
                return -pl.u;
            }
        }
        if (!withFlow && pnl < 0 && n.since > 15 && r() < 0.05 + n.flexibility * 0.05) {
            close(n, false, equity);
            return -pl.u;
        }
        const holdLimit = endgame && behind ? n.hold * 2.5 : n.hold;
        if (n.since >= holdLimit) {
            close(n, pnl > 0, equity);
            return -pl.u;
        }
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
            if (r() < 0.5)
                return -pl.u * (0.25 + 0.35 * r());
        }
        return 0;
    }
    if (flush)
        return 0;
    if (n.cooldown > 0 && !opening)
        return 0;
    if (r() > n.act * (opening ? 1.6 : endgame && behind ? 1.9 : 1))
        return 0;
    let dir = 0, strength = 0;
    if (n.spec.bias === "break") {
        const { hi, lo } = windowRange(history, n.look);
        if (Number.isFinite(hi) && P > hi) {
            dir = 1;
            strength = (P - hi) / P;
        }
        else if (Number.isFinite(lo) && P < lo) {
            dir = -1;
            strength = (lo - P) / P;
        }
    }
    else if (n.spec.bias === "herd") {
        dir = Math.sign(m.crowd || 0);
        strength = Math.abs(m.crowd || 0) * 0.01;
    }
    else if (n.spec.bias === "hunt") {
        const { hi, lo } = windowRange(history, n.look);
        if (!Number.isFinite(hi) || hi <= lo)
            return 0;
        const pos = (P - lo) / (hi - lo);
        if (pos > 0.78) {
            dir = 1;
            strength = (hi - P) / P + 0.001;
        }
        else if (pos < 0.22) {
            dir = -1;
            strength = (P - lo) / P + 0.001;
        }
        else
            return 0;
    }
    else if (n.spec.bias === "trap") {
        const { hi, lo } = windowRange(history, n.look);
        if (Number.isFinite(hi) && P > hi) {
            dir = -1;
            strength = (P - hi) / P;
        }
        else if (Number.isFinite(lo) && P < lo) {
            dir = 1;
            strength = (lo - P) / P;
        }
        else
            return 0;
    }
    else if (n.spec.bias === "trend") {
        const sig = n.spec.fast ? mom : slow;
        if (Math.abs(sig) < n.thresh * phThresh)
            return 0;
        dir = Math.sign(sig);
        strength = Math.abs(sig);
    }
    else if (n.spec.bias === "fade") {
        const sig = n.spec.fast ? mom : slow;
        if (Math.abs(sig) < n.thresh * phThresh)
            return 0;
        dir = -Math.sign(sig);
        strength = Math.abs(sig);
    }
    else if (n.spec.bias === "crowdfade") {
        const cm = m.crowdMoney || 0;
        if (Math.abs(cm) < 0.12)
            return 0;
        dir = -Math.sign(cm);
        strength = Math.abs(cm) * 0.02;
    }
    else if (n.spec.bias === "meanrev") {
        const avg = windowMean(history, n.look);
        if (!Number.isFinite(avg) || avg <= 0)
            return 0;
        const dev = (P - avg) / avg;
        if (Math.abs(dev) < n.thresh * phThresh * 1.5)
            return 0;
        dir = -Math.sign(dev);
        strength = Math.abs(dev);
    }
    else if (n.spec.bias === "range") {
        const { hi, lo } = windowRange(history, n.look);
        if (!Number.isFinite(hi) || hi <= lo)
            return 0;
        const pos = (P - lo) / (hi - lo);
        if (pos > 0.82) {
            dir = -1;
            strength = (P - lo) / P * 0.5;
        }
        else if (pos < 0.18) {
            dir = 1;
            strength = (hi - P) / P * 0.5;
        }
        else
            return 0;
    }
    else if (n.spec.bias === "squeeze") {
        const wS = windowWidth(history, Math.max(5, Math.round(n.look / 4)), P);
        const wL = windowWidth(history, n.look * 2, P);
        if (!Number.isFinite(wS) || !Number.isFinite(wL) || wL <= 0)
            return 0;
        if (wS > wL * 0.45)
            return 0;
        if (Math.abs(mom) < n.thresh * 0.5)
            return 0;
        dir = Math.sign(mom);
        strength = wL * 0.5;
    }
    else if (n.spec.bias === "spike") {
        const p3 = at(3);
        const jump = (P - p3) / Math.max(p3, 1e-9);
        const w = windowWidth(history, n.look, P);
        if (!Number.isFinite(w) || Math.abs(jump) < Math.max(w * 0.5, n.thresh * 2))
            return 0;
        dir = -Math.sign(jump);
        strength = Math.abs(jump) * 0.6;
    }
    else if (n.spec.bias === "maker") {
        const { L, S } = m.sidesBasis();
        const skew = (L - S) / Math.max(1e-9, L + S);
        if (Math.abs(skew) < 0.06)
            return 0;
        dir = -Math.sign(skew);
        strength = Math.max(n.thresh, Math.abs(skew) * 0.015);
    }
    else if (n.spec.bias === "copy") {
        const side = leaderSide(m);
        if (side === 0)
            return 0;
        dir = side;
        strength = n.thresh * 1.6;
    }
    else if (n.spec.bias === "sniper") {
        const avg = windowMean(history, n.look);
        if (!Number.isFinite(avg) || avg <= 0)
            return 0;
        const dev = (P - avg) / avg;
        const cm = m.crowdMoney || 0;
        if (Math.abs(dev) < n.thresh * 3 || Math.sign(dev) !== Math.sign(cm)
            || Math.abs(cm) < 0.2)
            return 0;
        dir = -Math.sign(dev);
        strength = Math.abs(dev) * 1.2;
    }
    else if (n.spec.bias === "pullback") {
        const avg = windowMean(history, n.look);
        if (!Number.isFinite(avg) || avg <= 0)
            return 0;
        const trend = Math.sign(slow);
        const dev = (P - avg) / avg;
        if (trend === 0 || Math.abs(slow) < n.thresh * phThresh)
            return 0;
        if (Math.sign(dev) === trend || Math.abs(dev) < n.thresh * 0.5)
            return 0;
        dir = trend;
        strength = Math.abs(slow);
    }
    else if (n.spec.bias === "flow") {
        const cm = m.crowdMoney || 0;
        if (Math.abs(cm) < 0.12)
            return 0;
        dir = Math.sign(cm);
        strength = Math.abs(cm) * 0.02;
    }
    else if (n.spec.bias === "accel") {
        const fast = mom;
        if (Math.sign(fast) !== Math.sign(slow) || Math.sign(fast) === 0)
            return 0;
        if (Math.abs(fast) < Math.abs(slow) * 0.6 || Math.abs(fast) < n.thresh * phThresh)
            return 0;
        dir = Math.sign(fast);
        strength = Math.abs(fast);
    }
    else if (n.spec.bias === "chase") {
        const half = Math.max(2, Math.round(n.look / 2));
        const mid = at(lag + half);
        const older = at(lag + n.look);
        if (!Number.isFinite(mid) || !Number.isFinite(older))
            return 0;
        const a = (P - mid) / Math.max(mid, 1e-9);
        const b = (mid - older) / Math.max(older, 1e-9);
        if (Math.sign(a) !== Math.sign(b) || Math.sign(a) === 0)
            return 0;
        if (Math.abs(a) < n.thresh * phThresh)
            return 0;
        dir = Math.sign(a);
        strength = Math.abs(a);
    }
    else {
        dir = r() < 0.5 ? 1 : -1;
        strength = n.thresh * 1.5;
    }
    if (dir === 0)
        return 0;
    if (n.edge < CONFIG.NPC_EDGE_GIVEUP && n.trades > 6) {
        if (r() < n.flexibility * 0.6) {
            dir = -dir;
            n.flipped++;
        }
        else if (r() < 0.5) {
            n.cooldown = n.patience;
            return 0;
        }
    }
    if (n.herd > 0.35 && r() < n.herd * 0.3) {
        const c = Math.sign(m.crowd || 0);
        if (c !== 0) {
            dir = c;
            strength = Math.max(strength, n.thresh);
        }
    }
    const own = Math.max(0, m.equity(i));
    const drawdown = n.startEquity ? (n.startEquity - equity) / n.startEquity : 0;
    const appetite = clamp(1 + drawdown * 1.5, 0.55, 1.7);
    let budget = own * n.size * n.conviction * appetite * phSize * m.npcLeverage;
    if (m.freeMarket && Number.isFinite(n.freeRiskCap))
        budget = Math.min(budget, own * n.freeRiskCap);
    if (budget <= 0)
        return 0;
    let units = m.curve.unitsFor(budget, P);
    if (units <= 0)
        return 0;
    const impact = Math.abs(m.curve.clearingPrice(m.Q, dir * units) - P) / P;
    const roundTrip = impact * 2;
    const tilt = n.losses >= 3 && r() < CONFIG.NPC_TILT;
    if (strength < roundTrip * CONFIG.NPC_EDGE_MULT && !tilt) {
        const scale = strength / Math.max(1e-9, roundTrip * CONFIG.NPC_EDGE_MULT);
        if (scale < 0.05) {
            n.cooldown = Math.round(n.patience * 0.5);
            return 0;
        }
        units *= Math.max(scale, 0.05);
        budget *= Math.max(scale, 0.05);
    }
    if (budget < stake * 0.01)
        return 0;
    n.entryEquity = equity;
    if (n.usesOrders) {
        const st = Math.abs(n.stop), tk = Math.abs(n.take);
        pl.stopLoss = dir > 0 ? P * (1 - st) : P * (1 + st);
        pl.takeProfit = dir > 0 ? P * (1 + tk) : P * (1 - tk);
    }
    else {
        pl.stopLoss = null;
        pl.takeProfit = null;
    }
    return dir > 0 ? units : -units;
}
function decide(m, i, history) {
    const pl = m.players[i], n = pl.npc;
    if (!n)
        return 0;
    if (m.freeMarket && n.retireRequested)
        return 0;
    syncNPCState(m, i);
    const gap = m.tick - (n.lastTrade ?? -1e9);
    const snap = {};
    for (const k of Object.keys(n))
        if (k !== "rng" && k !== "spec")
            snap[k] = n[k];
    const prevSL = pl.stopLoss, prevTP = pl.takeProfit;
    const du = decideRaw(m, i, history);
    if (du === 0)
        return 0;
    if (gap < n.minGap && !n.urgent) {
        for (const k of Object.keys(n)) {
            if (k !== "rng" && k !== "spec" && !(k in snap))
                delete n[k];
        }
        for (const [k, v] of Object.entries(snap))
            n[k] = v;
        pl.stopLoss = prevSL;
        pl.takeProfit = prevTP;
        return 0;
    }
    n.urgent = false;
    n.lastTrade = m.tick;
    return du;
}
function close(n, win, equity) {
    const gain = n.entryEquity ? (equity - n.entryEquity) / Math.max(1e-9, n.entryEquity) : 0;
    n.edge = n.edge * 0.8 + gain * 0.2;
    n.trades++;
    n.losses = gain < 0 ? n.losses + 1 : 0;
    n.cooldown = Math.round(n.patience * (gain < 0 ? 1.6 : 0.6));
    n.take = n.spec.take * CONFIG.NPC_PNL_SCALE;
    n.entryEquity = null;
    note(n, win);
}
function note(n, win) {
    n.mood = (n.mood ?? 0) * 0.75 + (win ? 0.25 : -0.25);
    n.conviction = Math.min(1.6, Math.max(0.45, 1 + 0.6 * n.mood));
}
function npcIntents(m, history, fromIdx) {
    const out = [];
    const start = Math.max(0, fromIdx || 0);
    const total = m.players.length - start;
    const batch = Math.max(0, Math.min(total, m.npcBatchSize || total));
    if (batch >= total) {
        for (let i = start; i < m.players.length; i++) {
            if (!m.players[i].npc)
                continue;
            const du = decide(m, i, history);
            if (Math.abs(du) > 1e-12)
                out.push({ i, du, reason: "npc" });
        }
        return out;
    }
    let cursor = Number.isFinite(m.npcCursor) ? m.npcCursor : start;
    if (cursor < start || cursor >= m.players.length)
        cursor = start;
    let seen = 0;
    while (seen < batch) {
        const i = cursor;
        cursor++;
        if (cursor >= m.players.length)
            cursor = start;
        seen++;
        if (!m.players[i]?.npc)
            continue;
        const du = decide(m, i, history);
        if (Math.abs(du) > 1e-12)
            out.push({ i, du, reason: "npc" });
    }
    m.npcCursor = cursor;
    return out;
}
function availableBuyingPower(m, i) {
    const pl = m.players[i];
    if (!pl)
        return 0;
    return Math.max(0, m.buyingPower(i));
}
function exposureNeed(pl, action, notional) {
    const dir = action === "BUY" ? 1 : -1;
    const after = pl.u + dir * notional;
    return Math.max(0, Math.abs(after) - Math.abs(pl.u));
}
function validateCommand(m, i, cmd) {
    const pl = m.players[i];
    if (!pl)
        return { ok: false, reason: "нет такого участника" };
    if (!cmd || typeof cmd !== "object")
        return { ok: false, reason: "пустая команда" };
    switch (cmd.type) {
        case "TRADE": {
            if (!["BUY", "SELL", "CLOSE"].includes(cmd.action))
                return { ok: false, reason: "неизвестное действие" };
            if (cmd.action === "CLOSE") {
                if (pl.u === 0)
                    return { ok: false, reason: "нет открытой позиции" };
                return { ok: true };
            }
            const n = cmd.notional;
            if (!Number.isFinite(n) || n <= 0)
                return { ok: false, reason: "неверный объём" };
            const need = exposureNeed(pl, cmd.action, n);
            if (need > availableBuyingPower(m, i) + 1e-9)
                return { ok: false, reason: "недостаточно свободных средств" };
            return { ok: true };
        }
        case "PROTECT": {
            if (pl.u === 0)
                return { ok: false, reason: "нет открытой позиции" };
            return { ok: true };
        }
        default: return { ok: false, reason: "неизвестная команда" };
    }
}
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
function pendingIntents(m) {
    const out = [];
    const P = m.mark;
    let freeL = 0, freeS = 0, freeLBasis = 0, freeSBasis = 0, freeEscrow = 0;
    let freeLeaderPnL = -Infinity, freeLeaderSide = 0;
    for (const pl of m.players) {
        if (m.freeMarket && pl.u !== 0) {
            freeEscrow += Math.abs(pl.u);
            if (pl.u > 0) {
                freeL++;
                freeLBasis += pl.basis;
            }
            else {
                freeS++;
                freeSBasis += pl.basis;
            }
            if (pl.realizedPnL > freeLeaderPnL) {
                freeLeaderPnL = pl.realizedPnL;
                freeLeaderSide = Math.sign(pl.u);
            }
        }
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
    if (viewer) {
        out.stopLoss = pl.stopLoss;
        out.takeProfit = pl.takeProfit;
    }
    if (devMode && pl.npc)
        out.debug = { type: pl.npc.type, lag: pl.npc.lag,
            size: pl.npc.size, act: pl.npc.act };
    return out;
}
function createSnapshot(m, viewerId, { level = "full", devMode = false } = {}) {
    const snap = {
        tick: m.tick,
        mark: m.mark,
        liquidationPrice: m.liquidationPrice,
        Q: m.Q,
        priceRange: [m.curve.PMIN, m.curve.PMAX],
        escrow: m.escrow,
        totalCapital: m.C,
    };
    const me = m.players.find((p) => p.id === viewerId);
    if (me)
        snap.you = projectPlayer(m, me, { viewer: true, devMode });
    if (level === "roster" || level === "full") {
        snap.participants = m.players.map((p) => projectPlayer(m, p, { viewer: false, devMode }));
    }
    if (devMode)
        snap.debug = { sumEquity: m.sumEquity(), center: m.center };
    return snap;
}
class RoomV4 {
    constructor({ playerCount = 100, startingCapital = 100, seed = 1, npcCount = null, leverage = 1, durationTicks = null, warmupTicks = 0, prerollTicks = null } = {}) {
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
        if (npcs > 0)
            attachNPCs(this.market, playerCount - npcs, npcs, seed);
        const pre = prerollTicks === null ? CONFIG.PREROLL_TICKS : prerollTicks;
        if (npcs > 0 && pre > 0) {
            const savedWarmup = this.market.warmupTicks;
            const savedTotalTicks = this.market.totalTicks;
            this.market.warmupTicks = 0;
            this.market.totalTicks = null;
            this._inPreroll = true;
            for (let t = 0; t < pre && !this.halted; t++)
                this.step();
            this._inPreroll = false;
            this.market.warmupTicks = savedWarmup;
            this.market.totalTicks = savedTotalTicks;
            const w = this.market.warmupTicks;
            for (const p of this.market.players) {
                if (!p.npc)
                    continue;
                p.npc.lastTrade = w - p.npc.minGap + Math.floor(this.market.rng() * CONFIG.OPEN_SPREAD);
            }
            this.market.tick = 0;
            this.market.phase = null;
            this.history = this.history.slice(-CONFIG.PREROLL_KEEP);
            this.liveSteps = 0;
        }
    }
    _normalizeHumanSlot(slot, name) {
        const m = this.market;
        const oldEquity = m.equity(slot.id);
        const target = m.startingCapital;
        const correction = oldEquity - target;
        const others = m.players.filter((p) => p.id !== slot.id && !p.isHuman);
        if (correction > 1e-9 && others.length) {
            const share = correction / others.length;
            for (const p of others)
                p.cash += share;
        }
        else if (correction < -1e-9) {
            let need = -correction;
            let donors = others.filter((p) => p.cash > 1e-9);
            while (need > 1e-9 && donors.length) {
                const free = donors.reduce((a, p) => a + Math.max(0, p.cash), 0);
                if (free <= 1e-9)
                    break;
                const takeNow = Math.min(need, free);
                for (const p of donors) {
                    const take = takeNow * (Math.max(0, p.cash) / free);
                    p.cash -= take;
                }
                need -= takeNow;
                donors = donors.filter((p) => p.cash > 1e-9);
            }
            if (need > 1e-6)
                return false;
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
    join(name) {
        const m = this.market;
        if (this.liveSteps > 0 && m.tick >= m.warmupTicks)
            return null;
        const slot = m.players.find((p) => !p.npc && !p.isHuman)
            || m.players.find((p) => p.npc && !p.isHuman);
        if (!slot)
            return null;
        if (!this._normalizeHumanSlot(slot, name))
            return null;
        this.humanSlots.add(slot.id);
        let L = 0, S = 0;
        for (const p of m.players) {
            if (p.u > 0)
                L++;
            else if (p.u < 0)
                S++;
        }
        m.crowd = L + S > 0 ? (L - S) / (L + S) : 0;
        const sides = m.sidesBasis();
        m.crowdMoney = sides.L + sides.S > 0
            ? (sides.L - sides.S) / (sides.L + sides.S) : 0;
        const inv = checkInvariants(m, { join: slot.id });
        if (!inv.ok) {
            this.halted = inv.report;
            return null;
        }
        return slot.id;
    }
    send(playerId, cmd) {
        const m = this.market;
        if (m.tick < m.warmupTicks && cmd?.type === "TRADE") {
            return { ok: false, reason: "рынок ещё не открыт" };
        }
        const v = validateCommand(this.market, playerId, cmd);
        if (!v.ok)
            return v;
        if (cmd.type === "PROTECT") {
            const pl = this.market.players[playerId];
            if (cmd.clear === "sl")
                pl.stopLoss = null;
            else if (cmd.clear === "tp")
                pl.takeProfit = null;
            else if (cmd.clear === true || cmd.clear === "all") {
                pl.stopLoss = null;
                pl.takeProfit = null;
            }
            if (Number.isFinite(cmd.stopLoss))
                pl.stopLoss = cmd.stopLoss;
            if (Number.isFinite(cmd.takeProfit))
                pl.takeProfit = cmd.takeProfit;
            return { ok: true };
        }
        this.pendingCommands.push({ i: playerId, cmd });
        return { ok: true };
    }
    step(extraIntents = []) {
        if (this.halted)
            return this.halted;
        const m = this.market;
        if (!this._inPreroll)
            this.liveSteps++;
        m.phase = m.totalTicks
            ? clamp((m.tick - m.warmupTicks) / m.totalTicks, 0, 1) : null;
        if (m.tick < m.warmupTicks) {
            this.pendingCommands = [];
            m.tick++;
            this.history.push(m.mark);
            return { executed: [], price: m.mark, warmup: true };
        }
        m.accrueBorrowCost();
        if (m.freeMarket && typeof m.freeMarketLifecycle === "function")
            m.freeMarketLifecycle(m);
        const intents = [];
        intents.push(...m.marginCalls());
        if (extraIntents && extraIntents.length)
            intents.push(...extraIntents);
        intents.push(...pendingIntents(m));
        intents.push(...npcIntents(m, this.history, 0));
        for (const { i, cmd } of this.pendingCommands) {
            const it = commandToIntent(m, i, cmd);
            if (it)
                intents.push(it);
        }
        this.pendingCommands = [];
        const result = m.clear(intents);
        if (m.freeMarket && m._freePreStats) {
            const s = m._freePreStats;
            const N = s.longPlayers + s.shortPlayers;
            m.crowd = N > 0 ? (s.longPlayers - s.shortPlayers) / N : 0;
            const B = s.longBasis + s.shortBasis;
            m.crowdMoney = B > 0 ? (s.longBasis - s.shortBasis) / B : 0;
        }
        else {
            let L = 0, S = 0;
            for (const p of m.players) {
                if (p.u > 0)
                    L++;
                else if (p.u < 0)
                    S++;
            }
            m.crowd = L + S > 0 ? (L - S) / (L + S) : 0;
            const sd = m.sidesBasis();
            m.crowdMoney = sd.L + sd.S > 0 ? (sd.L - sd.S) / (sd.L + sd.S) : 0;
        }
        this.history.push(m.mark);
        if (m.freeMarket) {
            if (this.history.length > 5200)
                this.history.splice(0, 200);
        }
        else if (this.history.length > 5000) {
            this.history.shift();
        }
        const every = Math.max(1, m.invariantEvery || 1);
        if (m.tick % every === 0) {
            const inv = checkInvariants(m, { intents: intents.length });
            if (!inv.ok) {
                this.halted = inv.report;
                return inv.report;
            }
        }
        return result;
    }
    advance(n) { for (let k = 0; k < n && !this.halted; k++)
        this.step(); return this; }
    snapshot(viewerId, opts) { return createSnapshot(this.market, viewerId, opts); }
    leave(playerId, penaltyFraction) {
        const m = this.market;
        if (m.players[playerId].u !== 0) {
            this.step([{ i: playerId, du: -m.players[playerId].u, reason: "leave" }]);
        }
        return m.applyExitPenalty(playerId, penaltyFraction);
    }
}
export { makeCurve, Market, checkInvariants, clamp, mulberry32, ARCHETYPES, TYPES, makeNPCState, attachNPCs, availableBuyingPower, projectPlayer, createSnapshot, RoomV4 };

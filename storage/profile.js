import { CONFIG } from "../core/config.js";
import { clamp } from "../core/engine.js";
const LEGACY_PROFILE_KEY = "sandbox:profile";
const PROFILE_KEY_PREFIX = "tradeexe:profile:v2:";
const STARTING_WALLET = 25000;
const emptyProfile = () => ({
    wallet: STARTING_WALLET,
    deposited: STARTING_WALLET,
    sessions: [],
    trophiesSpent: 0,
    activeSession: null,
});
function profileStorageKey(account) {
    const email = String(account?.email || "").trim().toLowerCase();
    return email ? `${PROFILE_KEY_PREFIX}${encodeURIComponent(email)}` : null;
}
function finiteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function nonNegativeNumber(value, fallback = 0) {
    return Math.max(0, finiteNumber(value, fallback));
}
function normalizeSession(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const capital = nonNegativeNumber(raw.capital, 0);
    const equity = nonNegativeNumber(raw.equity, capital);
    const pnlRaw = Number(raw.pnl);
    const pnl = Number.isFinite(pnlRaw) ? pnlRaw : equity - capital;
    const totalPlayers = Math.max(1, Math.round(nonNegativeNumber(raw.totalPlayers, CONFIG.market.totalPlayers)));
    const rank = clamp(Math.round(nonNegativeNumber(raw.rank, totalPlayers)), 1, totalPlayers);
    const top = Array.isArray(raw.top) ? raw.top.slice(0, 3).map((item) => ({
        name: String(item?.name || ""),
        pnl: finiteNumber(item?.pnl, 0),
        you: !!item?.you,
    })) : [];
    return {
        capital, equity, pnl, rank, totalPlayers,
        trades: Math.max(0, Math.round(nonNegativeNumber(raw.trades, 0))),
        ticks: Math.max(0, Math.round(nonNegativeNumber(raw.ticks, 0))),
        price: nonNegativeNumber(raw.price, CONFIG.market.initialPrice),
        at: Math.max(0, Math.round(nonNegativeNumber(raw.at, Date.now()))),
        leverage: Math.max(1, finiteNumber(raw.leverage, 1)),
        mode: raw.mode === "free" ? "free" : "session",
        early: !!raw.early,
        penalty: nonNegativeNumber(raw.penalty, 0),
        top,
    };
}
function normalizeActiveSession(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const capital = nonNegativeNumber(raw.capital, 0);
    if (capital <= 0)
        return null;
    return {
        capital,
        mode: raw.mode === "free" ? "free" : "session",
        startedAt: Math.max(0, Math.round(nonNegativeNumber(raw.startedAt, Date.now()))),
    };
}
function normalizeProfile(raw) {
    const base = emptyProfile();
    const src = raw && typeof raw === "object" ? raw : {};
    const sessions = Array.isArray(src.sessions)
        ? src.sessions.map(normalizeSession).filter(Boolean)
        : [];
    return {
        wallet: nonNegativeNumber(src.wallet, base.wallet),
        deposited: nonNegativeNumber(src.deposited, base.deposited),
        sessions,
        trophiesSpent: nonNegativeNumber(src.trophiesSpent, 0),
        activeSession: normalizeActiveSession(src.activeSession),
    };
}
const profileStore = {
    async load(account) {
        const key = profileStorageKey(account);
        if (!key)
            return emptyProfile();
        let profile = null;
        try {
            const found = localStorage.getItem(key);
            if (found)
                profile = normalizeProfile(JSON.parse(found));
            if (!profile) {
                const legacy = localStorage.getItem(LEGACY_PROFILE_KEY);
                if (legacy) {
                    profile = normalizeProfile(JSON.parse(legacy));
                    localStorage.setItem(key, JSON.stringify(profile));
                    localStorage.removeItem(LEGACY_PROFILE_KEY);
                }
            }
        }
        catch (_) {
            profile = null;
        }
        profile = normalizeProfile(profile);
        const escrow = Number(profile.activeSession?.capital);
        if (Number.isFinite(escrow) && escrow > 0) {
            profile = {
                ...profile,
                wallet: profile.wallet + escrow,
                activeSession: null,
                recoveredSessionAt: Date.now(),
            };
            try {
                localStorage.setItem(key, JSON.stringify(profile));
            }
            catch (_) { }
        }
        return profile;
    },
    async save(account, profile) {
        const key = profileStorageKey(account);
        if (!key)
            return false;
        try {
            localStorage.setItem(key, JSON.stringify(normalizeProfile(profile)));
            return true;
        }
        catch (_) {
            return false;
        }
    },
};
const loadProfile = (account) => profileStore.load(account);
const saveProfile = (account, profile) => profileStore.save(account, profile);
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
export { STARTING_WALLET, emptyProfile, profileStorageKey, normalizeSession, normalizeActiveSession, normalizeProfile, profileStore, loadProfile, saveProfile, profileStats };

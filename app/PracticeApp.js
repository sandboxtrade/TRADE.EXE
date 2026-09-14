import React, { useEffect, useRef, useState } from "react";
import { CONFIG } from "../core/config.js";
import { sanitizeMoneyInput, parseMoneyInput } from "../core/money.js";
import { FREE_MARKET, LocalTransport, FreeMarketTransport, TIMEFRAMES } from "../features/market.js";
import { ACTIVE_LANG, setActiveLanguage, tr, tfLabel, gameTabLabel, filterLabel, translateEngineReason, strategyLabel, clock, signedPct } from "../i18n/index.js";
import { BG, SURFACE, RAISED, HAIR, TEXT, DIM, FAINT, LONG, SHORT, ACCENT, CARD, btnAccent, btnSoft, fmt, fmtSigned } from "../ui/theme.js";
import { Chart, EyesPanel, BackButton, Line, Toggle, Metric, Blank, EYES_FILTERS, eyesFilter } from "../ui/components.js";
import { emptyProfile, loadProfile, saveProfile, normalizeProfile } from "../storage/profile.js";
import { authStore } from "../storage/auth.js";
import { Boot, Onboarding, AuthScreen } from "../features/auth.js";
import { ProfileScreen, TrophyScreen, DepositScreen, WithdrawScreen, Lobby, SettingsScreen } from "../features/dashboard.js";
import { FreeMarketSetup, SessionSetup, Matchmaking, SessionResult } from "../features/session.js";
import { Icon } from "../ui/icons.js";
function PracticeApp({ onExit }) {
    const [language, setLanguage] = useState(() => ACTIVE_LANG);
    const changeLanguage = (code) => {
        const next = setActiveLanguage(code);
        setLanguage(next);
    };
    const [profile, setProfile] = useState(null);
    const [account, setAccount] = useState(undefined);
    const [authStage, setAuthStage] = useState("intro");
    const [screen, setScreen] = useState("lobby");
    const [result, setResult] = useState(null);
    const [session, setSession] = useState(null);
    const [marketMode, setMarketMode] = useState("session");
    const [pending, setPending] = useState(null);
    const [leverage, setLeverage] = useState(1);
    const [pendingEyes, setPendingEyes] = useState(false);
    const [sessionDurationTicks, setSessionDurationTicks] = useState(null);
    const [left, setLeft] = useState(0);
    const engineRef = useRef(null);
    const finishingRef = useRef(false);
    const [snapshot, setSnapshot] = useState(null);
    const [speed, setSpeed] = useState(1);
    const [tab, setTab] = useState("Рынок");
    const [timeframe, setTimeframe] = useState("1с");
    const [chartMode, setChartMode] = useState("свечи");
    const [showSettings, setShowSettings] = useState(false);
    const [size, setSize] = useState("0");
    const [sheet, setSheet] = useState(null);
    const [playerFilter, setPlayerFilter] = useState("Все");
    const [toast, setToast] = useState(null);
    const [confirmingEnd, setConfirmingEnd] = useState(false);
    const [eyesOn, setEyesOn] = useState(true);
    const [eyesFilterName, setEyesFilterName] = useState("ВСЁ");
    const [eyesView, setEyesView] = useState("LIVE");
    const toastTimer = useRef(null);
    const [boot, setBoot] = useState(0);
    useEffect(() => {
        let alive = true;
        let idleId = null;
        let idleTimer = null;
        (async () => {
            const acc = await authStore.current();
            if (!alive)
                return;
            setAccount(acc ?? null);
            setBoot(1);
            const prof = acc ? await loadProfile(acc) : emptyProfile();
            if (!alive)
                return;
            setProfile(prof);
            setBoot(2);
            const warmEngine = () => {
                if (!alive)
                    return;
                try {
                    const warm = new LocalTransport({ startingCapital: 100, devMode: false });
                    warm.room.advance(120);
                    warm.stop();
                }
                catch (_) { }
            };
            if (typeof requestIdleCallback === "function") {
                idleId = requestIdleCallback(warmEngine, { timeout: 1200 });
            }
            else {
                idleTimer = setTimeout(warmEngine, 250);
            }
            setBoot(3);
            requestAnimationFrame(() => { if (alive)
                setBoot(4); });
        })();
        return () => {
            alive = false;
            if (idleId !== null && typeof cancelIdleCallback === "function")
                cancelIdleCallback(idleId);
            if (idleTimer !== null)
                clearTimeout(idleTimer);
        };
    }, []);
    useEffect(() => () => {
        clearTimeout(toastTimer.current);
        engineRef.current?.stop?.();
    }, []);
    useEffect(() => {
        if (screen !== "game" || !session)
            return undefined;
        const transport = engineRef.current;
        if (!transport)
            return undefined;
        transport.start((next) => {
            setSnapshot(next);
            if (marketMode === "free") {
                setLeft(0);
                return;
            }
            if (!sessionDurationTicks)
                return;
            const activeTicks = Math.max(0, next.tick - CONFIG.market.warmupTicks);
            const remainingTicks = Math.max(0, sessionDurationTicks - activeTicks);
            setLeft(remainingTicks * CONFIG.market.tickMs);
            if (remainingTicks <= 0)
                finishSession(false);
        });
        return () => transport.stop();
    }, [screen, session, sessionDurationTicks, marketMode]);
    useEffect(() => { engineRef.current?.setSpeed(speed); }, [speed]);
    const persist = (next) => {
        const normalized = normalizeProfile(next);
        setProfile(normalized);
        if (account)
            saveProfile(account, normalized);
    };
    const queueSession = (capital, leverage = 1, minutes = 5, eyes = false, players = CONFIG.market.playerOptions[0]) => {
        setPending({ capital, leverage, minutes, eyes, players });
        setScreen("matching");
    };
    const startSession = ({ capital, leverage, minutes, eyes, players }) => {
        if (!Number.isFinite(capital) || capital <= 0 || capital > profile.wallet)
            return;
        engineRef.current?.stop?.();
        setMarketMode("session");
        setConfirmingEnd(false);
        const durationTicks = Math.round(minutes * 60000 / CONFIG.market.tickMs);
        const seed = ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0) || 1;
        engineRef.current = new LocalTransport({
            startingCapital: capital, leverage, eyes, seed, devMode: false,
            playerCount: players || CONFIG.market.playerOptions[0],
            durationTicks,
        });
        setSize(String(Math.round(capital * 0.3)));
        setSheet(null);
        setTab("Рынок");
        setSession(capital);
        setLeverage(leverage);
        setSessionDurationTicks(durationTicks);
        setLeft(durationTicks * CONFIG.market.tickMs);
        setScreen("game");
        finishingRef.current = false;
        persist({
            ...profile,
            wallet: profile.wallet - capital,
            activeSession: { capital, mode: "session", startedAt: Date.now() },
        });
        setPending(null);
    };
    const startFreeMarket = (capital) => {
        const requested = parseMoneyInput(capital);
        const maxAllowed = Math.min(FREE_MARKET.maxCapital, profile.wallet);
        if (!Number.isFinite(requested) || requested < FREE_MARKET.minCapital || requested > maxAllowed)
            return;
        const amount = requested;
        engineRef.current?.stop?.();
        engineRef.current = new FreeMarketTransport({ startingCapital: amount });
        setMarketMode("free");
        setConfirmingEnd(false);
        setSession(amount);
        setLeverage(1);
        setSessionDurationTicks(null);
        setLeft(0);
        setSize(String(Math.max(10, Math.round(amount * 0.3))));
        setSheet(null);
        setSpeed(1);
        setTab("Рынок");
        setSnapshot(engineRef.current.snapshot());
        setScreen("game");
        finishingRef.current = false;
        persist({
            ...profile,
            wallet: profile.wallet - amount,
            activeSession: { capital: amount, mode: "free", startedAt: Date.now() },
        });
    };
    const finishSession = (early = false) => {
        if (finishingRef.current)
            return;
        const transport = engineRef.current;
        if (!transport)
            return;
        finishingRef.current = true;
        const free = marketMode === "free";
        let penalty = 0;
        let snap = null;
        if (typeof transport.leave === "function") {
            if (free) {
                const exit = transport.leave();
                snap = exit?.snapshot || null;
            }
            else if (early)
                penalty = transport.leave(CONFIG.market.earlyExitPenalty) || 0;
        }
        if (!snap)
            snap = transport.snapshot();
        const record = {
            capital: session,
            equity: snap.you.equity,
            pnl: snap.you.equity - session,
            rank: snap.rank,
            totalPlayers: snap.totalPlayers,
            trades: snap.you.tradeCount,
            ticks: free ? Math.max(0, snap.sessionTicks || 0) : Math.max(0, snap.tick - CONFIG.market.warmupTicks),
            price: snap.price,
            at: Date.now(),
            leverage,
            mode: free ? "free" : "session",
            early: free ? false : early,
            penalty,
            top: free ? [] : [...(snap.players || [])]
                .map((p) => ({ name: p.name,
                pnl: p.equity - (p.startingCapital ?? session), you: p.id === snap.you.id }))
                .sort((a, b) => b.pnl - a.pnl)
                .slice(0, 3),
        };
        persist({
            ...profile,
            wallet: profile.wallet + record.equity,
            sessions: [record, ...profile.sessions],
            activeSession: null,
        });
        transport.stop();
        engineRef.current = null;
        setSnapshot(null);
        setSession(null);
        setMarketMode("session");
        setSessionDurationTicks(null);
        setLeft(0);
        setShowSettings(false);
        setResult(record);
        setScreen("result");
    };
    if (boot < 4 || !profile || account === undefined)
        return React.createElement(Boot, { done: boot });
    if (!account) {
        if (authStage === "intro") {
            return React.createElement(Onboarding, { onSignIn: () => setAuthStage("signin"), onSignUp: () => setAuthStage("signup") });
        }
        return React.createElement(AuthScreen, { mode: authStage, onMode: setAuthStage, onBack: () => setAuthStage("intro"), onDone: async (acc) => {
                const prof = await loadProfile(acc);
                setProfile(prof);
                setAccount(acc);
                setAuthStage("intro");
            } });
    }
    const topUp = (value) => {
        const amount = parseMoneyInput(value);
        if (!Number.isFinite(amount) || amount <= 0)
            return false;
        persist({
            ...profile,
            wallet: profile.wallet + amount,
            deposited: profile.deposited + amount,
        });
        return true;
    };
    const redeem = (cups, bonus) => {
        const cupsValue = Number(cups);
        const bonusValue = Number(bonus);
        if (!Number.isFinite(cupsValue) || cupsValue <= 0 || !Number.isFinite(bonusValue) || bonusValue <= 0)
            return false;
        persist({
            ...profile,
            wallet: profile.wallet + bonusValue,
            trophiesSpent: (profile.trophiesSpent || 0) + cupsValue,
        });
        return true;
    };
    const signOut = async () => {
        await authStore.signOut();
        setAccount(null);
        setProfile(emptyProfile());
        setAuthStage("intro");
    };
    if (screen === "lobby") {
        return React.createElement(Lobby, { profile: profile, account: account, onSignOut: signOut, onTopUp: topUp, onRedeem: redeem, language: language, onLanguageChange: changeLanguage, onNew: (e) => { setPendingEyes(!!e); setScreen("setup"); }, onFree: () => setScreen("free-setup"), onExit: onExit, onReset: () => persist({ ...profile, wallet: 0 }) });
    }
    if (screen === "free-setup") {
        return React.createElement(FreeMarketSetup, { wallet: profile.wallet, onStart: startFreeMarket, onBack: () => setScreen("lobby") });
    }
    if (screen === "setup") {
        return React.createElement(SessionSetup, { wallet: profile.wallet, onStart: queueSession, eyes: !!pendingEyes, onBack: () => { setPendingEyes(false); setScreen("lobby"); } });
    }
    if (screen === "matching" && pending !== null) {
        return React.createElement(Matchmaking, { capital: pending.capital, leverage: pending.leverage, total: pending.players, onReady: () => startSession(pending), onCancel: () => { setPending(null); setScreen("lobby"); } });
    }
    if (screen === "result" && result) {
        return React.createElement(SessionResult, { result: result, onDone: () => { setResult(null); setScreen("lobby"); } });
    }
    if (!engineRef.current || !snapshot) {
        return React.createElement(Lobby, { profile: profile, account: account, onSignOut: signOut, onTopUp: topUp, onRedeem: redeem, language: language, onLanguageChange: changeLanguage, onNew: (e) => { setPendingEyes(!!e); setScreen("setup"); }, onFree: () => setScreen("free-setup"), onExit: onExit, onReset: () => persist({ ...profile, wallet: 0 }) });
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
    const notional = parseMoneyInput(size);
    const orderCapacity = Math.max(0, Number(leverage > 1 ? human.buyingPower : human.cash) || 0);
    const orderTooLarge = notional > orderCapacity + 1e-9;
    const validOrderSize = notional >= 1 && !orderTooLarge;
    const changeAbs = snap.price - snap.initialPrice;
    const changePct = changeAbs / snap.initialPrice;
    const pos = human.position;
    const pnl = human.unrealized;
    const pnlRatio = pos ? pnl / pos.margin : 0;
    const equity = human.equity;
    const pnlColor = pnl > 0 ? LONG : pnl < 0 ? SHORT : TEXT;
    const refresh = () => setSnapshot(transport.snapshot());
    const send = async (command) => {
        const res = await transport.send(command);
        if (!res.ok)
            say(translateEngineReason(res.reason), SHORT);
        refresh();
        return res;
    };
    const doBuy = async () => {
        const closingShort = pos && pos.side === "short";
        const res = closingShort
            ? await send({ type: "TRADE", action: "CLOSE", fraction: 1, reason: "закрытие Short кнопкой Long" })
            : await send({ type: "TRADE", action: "BUY", notional, reason: "ручная покупка" });
        if (res.ok)
            say(closingShort ? (ACTIVE_LANG === "en" ? "closing Short" : "закрываем Short") : (ACTIVE_LANG === "en" ? `buy ${fmt(notional, 0)}` : `покупка ${fmt(notional, 0)}`), LONG);
    };
    const doSell = async () => {
        const closingLong = pos && pos.side === "long";
        const res = closingLong
            ? await send({ type: "TRADE", action: "CLOSE", fraction: 1, reason: "закрытие Long кнопкой Short" })
            : await send({ type: "TRADE", action: "SELL", notional, reason: "ручная продажа" });
        if (res.ok)
            say(closingLong ? (ACTIVE_LANG === "en" ? "closing Long" : "закрываем Long") : (ACTIVE_LANG === "en" ? `sell ${fmt(notional, 0)}` : `продажа ${fmt(notional, 0)}`), SHORT);
    };
    const doClose = async (fraction, label) => {
        const res = await send({ type: "TRADE", action: "CLOSE", fraction, reason: "ручное закрытие" });
        if (res.ok)
            say(label);
    };
    const setLevelFromChart = async (kind, price) => {
        if (!pos || !Number.isFinite(price))
            return;
        const value = Math.max(0.01, price);
        const res = await send({
            type: "PROTECT",
            stopLoss: kind === "sl" ? value : null,
            takeProfit: kind === "tp" ? value : null,
        });
        if (res.ok)
            say(`${kind === "sl" ? (ACTIVE_LANG === "en" ? "stop" : "стоп") : (ACTIVE_LANG === "en" ? "take" : "тейк")} ${value.toFixed(2)}`);
    };
    const setRisk = async (kind, delta) => {
        if (!pos)
            return;
        const long = pos.side === "long";
        const target = kind === "sl"
            ? (long ? pos.entryPrice * (1 - delta) : pos.entryPrice * (1 + delta))
            : (long ? pos.entryPrice * (1 + delta) : pos.entryPrice * (1 - delta));
        const res = await send({
            type: "PROTECT",
            stopLoss: kind === "sl" ? target : null,
            takeProfit: kind === "tp" ? target : null,
        });
        if (res.ok)
            say(`${kind === "sl" ? (ACTIVE_LANG === "en" ? "stop" : "стоп") : (ACTIVE_LANG === "en" ? "take" : "тейк")} ${target.toFixed(2)}`);
    };
    const eyesData = snap.eyes;
    const TAB_KEYS = eyesData
        ? ["Рынок", "EYES", "Позиции", "Защита", "Участники"]
        : ["Рынок", "Позиции", "Защита", "Участники"];
    return (React.createElement("div", { className: "w-full flex flex-col", style: { height: "100dvh", backgroundColor: BG, color: TEXT } },
        React.createElement("div", { className: "max-w-md tx-trade-shell w-full mx-auto flex flex-col h-full relative" },
            React.createElement("div", { className: "flex items-center justify-between px-5 pb-3 ui-safe-top tx-trade-header" },
                React.createElement("span", { className: "text-[11px] tracking-[0.11em]", style: { color: FAINT } },
                    CONFIG.market.assetSymbol,
                    " \u00B7 ",
                    marketMode === "free" ? "FREE · " : "",
                    fmt(session, 0),
                    leverage > 1 && (React.createElement("span", { className: "ml-2 px-1.5 py-0.5 rounded font-semibold", style: { backgroundColor: RAISED, color: LONG } },
                        "x",
                        leverage)),
                    eyesData && (React.createElement("span", { className: "ml-2 px-1.5 py-0.5 rounded font-semibold", style: { backgroundColor: RAISED, color: LONG, border: `1px solid ${HAIR}` } }, "EYES"))),
                React.createElement("div", { className: "flex items-center gap-4" },
                    marketMode === "free" ? (React.createElement("span", { className: "text-[11px] font-mono", style: { color: ACCENT } }, ACTIVE_LANG === "en" ? "LOCAL" : "ЛОКАЛЬНО")) : sessionDurationTicks && (React.createElement("span", { className: "text-[12px] font-mono tabular-nums", style: { color: left < 30000 ? SHORT : left < 60000 ? TEXT : DIM } }, clock(left))),
                    React.createElement("button", { onClick: () => setShowSettings((v) => !v), className: "ui-hit px-2.5 rounded-xl text-[11px] tracking-[0.10em] tap", style: { color: showSettings ? TEXT : FAINT, backgroundColor: showSettings ? SURFACE : "transparent" } }, ACTIVE_LANG === "en" ? "MORE" : "ЕЩЁ"))),
            showSettings && (React.createElement("div", { className: "mx-4 mb-3 p-3.5 rounded-2xl flex flex-col gap-3 tx-pop tx-trade-settings", style: CARD },
                marketMode !== "free" && (React.createElement("div", { className: "flex items-center justify-between" },
                    React.createElement("span", { className: "text-[11px] tracking-[0.10em]", style: { color: FAINT } }, ACTIVE_LANG === "en" ? "SPEED" : "СКОРОСТЬ"),
                    React.createElement("div", { className: "flex gap-1" }, [1, 2, 5, 10].map((s) => (React.createElement(Toggle, { key: s, active: speed === s, onClick: () => setSpeed(s) },
                        s,
                        "x")))))),
                confirmingEnd && marketMode === "free" && (React.createElement("div", { className: "mb-2 text-[11px] leading-snug", style: { color: DIM } }, tr("Открытая позиция будет закрыта по текущему рынку. Штрафа за выход нет, итоговый капитал вернётся на баланс."))),
                confirmingEnd && marketMode !== "free" && left > 0 && (React.createElement("div", { className: "mb-2 text-[11px] leading-snug", style: { color: SHORT } }, ACTIVE_LANG === "en"
                    ? `${clock(left)} left in the session. Exiting early deducts ${Math.round(CONFIG.market.earlyExitPenalty * 100)}% of remaining equity and distributes it across the other participants.`
                    : `До конца сессии ещё ${clock(left)}. При досрочном выходе с остатка спишется ${Math.round(CONFIG.market.earlyExitPenalty * 100)}% и поровну уйдёт остальным участникам.`)),
                confirmingEnd ? (React.createElement("div", { className: "flex gap-2" },
                    React.createElement("button", { onClick: () => setConfirmingEnd(false), className: "flex-1 rounded-lg py-3 text-[13px] font-semibold tap", style: btnSoft(false) }, tr("Отмена")),
                    React.createElement("button", { onClick: () => finishSession(marketMode === "free" ? false : left > 0), className: "flex-1 rounded-lg py-3 text-[13px] font-semibold tap", style: { backgroundColor: SHORT, color: BG } }, tr("Да, завершить")))) : (React.createElement("button", { onClick: () => setConfirmingEnd(true), className: "rounded-lg py-3 text-[13px] font-semibold tap", style: btnSoft(false) },
                    marketMode === "free" ? (ACTIVE_LANG === "en" ? "Exit market" : "Выйти из рынка") : (ACTIVE_LANG === "en" ? "End session" : "Завершить сессию"),
                    " \u00B7 ",
                    fmt(marketMode === "free" ? equity : left > 0
                        ? equity * (1 - CONFIG.market.earlyExitPenalty) : equity),
                    " ",
                    ACTIVE_LANG === "en" ? "to balance" : "на баланс")))),
            React.createElement("div", { className: "flex-1 min-h-0 overflow-y-auto no-scrollbar tx-trade-main" },
                tab === "Рынок" && (React.createElement("div", { className: "flex flex-col h-full relative overflow-hidden" },
                    !snap.tradingOpen && (React.createElement("div", { className: "absolute inset-0 z-30 flex flex-col items-center justify-center\n                  backdrop-blur-[2px] tx-fade", style: { backgroundColor: "rgba(0,0,0,0.62)" } },
                        React.createElement("div", { className: "text-[10px] tracking-[0.19em]", style: { color: FAINT } }, tr("РЫНОК ОТКРОЕТСЯ ЧЕРЕЗ")),
                        React.createElement("div", { className: "text-[72px] leading-none font-mono mt-3 tabular-nums tx-pop", key: Math.ceil(snap.warmupLeft / 10) }, Math.ceil(snap.warmupLeft / 10)),
                        React.createElement("div", { className: "h-1 w-40 rounded-full mt-6 overflow-hidden", style: { backgroundColor: HAIR } },
                            React.createElement("div", { style: {
                                    width: `${(1 - snap.warmupLeft / CONFIG.market.warmupTicks) * 100}%`,
                                    height: "100%", backgroundColor: LONG,
                                    transition: "width var(--tx-fast) linear"
                                } })),
                        React.createElement("div", { className: "text-[12px] mt-5 text-center max-w-[260px] leading-snug", style: { color: DIM } }, tr("До открытия цена стоит и торговля полностью недоступна.")))),
                    leverage > 1 && !pos && (React.createElement("div", { className: "mx-4 mb-2 rounded-xl px-3.5 py-2.5 text-[11px]", style: { backgroundColor: RAISED, color: DIM, border: `1px solid ${HAIR}` } }, ACTIVE_LANG === "en"
                        ? `A 100% entry starts at ${(100 / leverage).toFixed(0)}% margin. Forced closure is at ${(snap.maintenance * 100).toFixed(0)}%, leaving about ${(100 / leverage - snap.maintenance * 100).toFixed(0)} percentage points of room.`
                        : React.createElement(React.Fragment, null,
                            "\u0412\u0445\u043E\u0434 \u043D\u0430 100% \u0434\u0430\u0451\u0442 \u043D\u0430\u0447\u0430\u043B\u044C\u043D\u0443\u044E \u043C\u0430\u0440\u0436\u0443 ",
                            (100 / leverage).toFixed(0),
                            "%. \u041F\u0440\u0438\u043D\u0443\u0434\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0435 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u0435 \u043F\u0440\u0438 ",
                            (snap.maintenance * 100).toFixed(0),
                            "% \u2014 \u0437\u0430\u043F\u0430\u0441\u0430 \u0445\u0432\u0430\u0442\u0430\u0435\u0442 \u043F\u0440\u0438\u043C\u0435\u0440\u043D\u043E \u043D\u0430 ",
                            (100 / leverage - snap.maintenance * 100).toFixed(0),
                            " \u043F\u0440\u043E\u0446\u0435\u043D\u0442\u043D\u044B\u0445 \u043F\u0443\u043D\u043A\u0442\u0430."))),
                    leverage > 1 && pos && human.marginLevel !== null
                        && human.marginLevel < snap.maintenance * 1.6 && (React.createElement("div", { className: "mx-4 mb-2 rounded-xl px-3.5 py-2.5 text-[11px] tx-pop", style: { backgroundColor: RAISED, color: SHORT, border: `1px solid ${SHORT}` } },
                        ACTIVE_LANG === "en" ? `Margin ${(human.marginLevel * 100).toFixed(0)}% · forced closure at ${(snap.maintenance * 100).toFixed(0)}%.` : `Маржа ${(human.marginLevel * 100).toFixed(0)}% — до принудительного закрытия ${(snap.maintenance * 100).toFixed(0)}%.`,
                        human.liquidationPrice
                            ? ACTIVE_LANG === "en" ? ` Liquidation near ${fmt(human.liquidationPrice)}.` : ` Ликвидация около ${fmt(human.liquidationPrice)}.` : "")),
                    leverage > 1 && !pos && human.wasLiquidated && (React.createElement("div", { className: "mx-4 mb-2 rounded-xl px-3.5 py-2.5 text-[11px]", style: { backgroundColor: RAISED, color: DIM, border: `1px solid ${HAIR}` } }, tr("Позиция была закрыта принудительно по маржин-коллу."))),
                    React.createElement("div", { className: "tx-price-row px-5 pt-1 flex items-end justify-between gap-4" },
                        React.createElement("div", null,
                            React.createElement("div", { className: "tx-price-value text-[38px] leading-none font-mono tracking-tight" }, fmt(state.price)),
                            React.createElement("div", { className: "text-[13px] font-mono mt-1", style: { color: changeAbs >= 0 ? LONG : SHORT } },
                                changeAbs >= 0 ? "+" : "−",
                                Math.abs(changePct * 100).toFixed(2),
                                "%")),
                        React.createElement("div", { className: "text-right" },
                            React.createElement("div", { className: "text-[11px] font-mono", style: { color: FAINT } },
                                stats.activePositions,
                                " / ",
                                snap.totalPlayers,
                                " ",
                                ACTIVE_LANG === "en" ? "in market" : "в рынке"))),
                    React.createElement("div", { className: "tx-crowd-bar px-5 pt-2.5" },
                        React.createElement("div", { className: "h-1 w-full flex rounded-full overflow-hidden", style: { backgroundColor: HAIR } },
                            React.createElement("div", { style: { width: `${stats.longShare * 100}%`, backgroundColor: LONG } }),
                            React.createElement("div", { style: { width: `${stats.shortShare * 100}%`, backgroundColor: SHORT } }))),
                    React.createElement("div", { className: "tx-market-metrics px-5 pt-3 grid grid-cols-4 gap-3" },
                        React.createElement(Metric, { label: tr("ЛОНГИ"), value: String(stats.longPlayers), color: LONG }),
                        React.createElement(Metric, { label: tr("ШОРТЫ"), value: String(stats.shortPlayers), color: SHORT }),
                        React.createElement(Metric, { label: tr("PNL ЛОНГОВ"), value: fmtSigned(state.longRealized ?? 0, 0), color: (state.longRealized ?? 0) >= 0 ? LONG : SHORT }),
                        React.createElement(Metric, { label: tr("PNL ШОРТОВ"), value: fmtSigned(state.shortRealized ?? 0, 0), color: (state.shortRealized ?? 0) >= 0 ? LONG : SHORT })),
                    React.createElement("div", { className: "tx-chart-toolbar flex items-center justify-between gap-2 px-5 pt-3" },
                        React.createElement("div", { className: "flex gap-1 min-w-0" }, TIMEFRAMES.map((tf) => (React.createElement(Toggle, { key: tf.label, active: timeframe === tf.label, onClick: () => setTimeframe(tf.label) }, tfLabel(tf.label))))),
                        React.createElement("button", { onClick: () => setChartMode(chartMode === "свечи" ? "линия" : "свечи"), className: "ui-hit px-3 rounded-xl text-[11px] shrink-0 tap", style: { color: DIM, backgroundColor: SURFACE, border: `1px solid ${HAIR}` } }, chartMode === "свечи" ? tr("СВЕЧИ") : tr("ЛИНИЯ"))),
                    eyesData && (React.createElement("div", { className: "flex items-center justify-between px-4 pb-1" },
                        React.createElement("button", { onClick: () => setEyesOn((v) => !v), className: "ui-hit flex items-center gap-2 px-3 rounded-xl text-[10px] tracking-[0.13em] tap", style: { backgroundColor: RAISED,
                                color: eyesOn ? LONG : DIM,
                                border: `1px solid ${eyesOn ? "#315A48" : HAIR}` } },
                            React.createElement(Icon, { name: "eye", size: 13, color: eyesOn ? LONG : DIM }),
                            "EYES"),
                        React.createElement("div", { className: "flex gap-1.5 overflow-x-auto no-scrollbar max-w-[250px]" }, EYES_FILTERS.map((f) => (React.createElement("button", { key: f, onClick: () => setEyesFilterName(f), className: "ui-hit px-2.5 rounded-lg text-[10px] tap shrink-0", style: { backgroundColor: f === eyesFilterName ? "#1B1B1F" : RAISED,
                                color: f === eyesFilterName ? TEXT : FAINT,
                                border: `1px solid ${f === eyesFilterName ? "#3A393D" : HAIR}` } }, f === "ВСЁ" ? tr("ВСЁ") : f)))))),
                    React.createElement("div", { className: "tx-chart-wrap px-3 pt-1.5 flex-1 min-h-0" },
                        React.createElement(Chart, { state: state, timeframe: timeframe, mode: chartMode, entryPrice: pos?.entryPrice, stopLoss: human.stopLoss, takeProfit: human.takeProfit, liquidationPrice: human.liquidationPrice, side: pos?.side, onLevel: setLevelFromChart, eyes: eyesData && eyesOn ? eyesFilter(eyesData.live, eyesFilterName) : null })),
                    React.createElement("div", { className: "tx-position-strip px-5 pb-3 pt-2 grid gap-3", style: { gridTemplateColumns: `repeat(${leverage > 1 ? 5 : 4}, minmax(0, 1fr))` } },
                        React.createElement(Metric, { label: tr("ЭКВИТИ"), value: fmt(equity) }),
                        React.createElement(Metric, { label: tr("СВОБОДНО"), value: fmt(human.cash) }),
                        React.createElement(Metric, { label: tr("ПОЗИЦИЯ"), value: pos ? `${pos.side === "long" ? "LONG" : "SHORT"} ${fmt(pos.margin, 0)}` : "—", color: pos ? (pos.side === "long" ? LONG : SHORT) : TEXT }),
                        React.createElement(Metric, { label: "PNL", value: pos ? fmtSigned(pnl) : "—", color: pnlColor }),
                        leverage > 1 && (React.createElement(Metric, { label: tr("МАРЖА"), value: pos && human.marginLevel !== null
                                ? `${(human.marginLevel * 100).toFixed(0)}%` : "—", color: !pos || human.marginLevel === null ? TEXT
                                : human.marginLevel < snap.maintenance * 1.6 ? SHORT
                                    : human.marginLevel < snap.maintenance * 3 ? TEXT : LONG }))))),
                tab === "EYES" && eyesData && (React.createElement(EyesPanel, { eyes: eyesData, filter: eyesFilterName, onFilter: setEyesFilterName, view: eyesView, onView: setEyesView })),
                tab === "Позиции" && (React.createElement("div", { className: "px-5 pt-2 pb-6" },
                    React.createElement("div", { className: "text-[11px] tracking-[0.10em] mb-3", style: { color: FAINT } }, tr("ПОЗИЦИЯ")),
                    pos ? (React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "flex items-baseline justify-between mb-4" },
                            React.createElement("span", { className: "text-[26px]", style: { color: pos.side === "long" ? LONG : SHORT } }, pos.side === "long" ? "LONG" : "SHORT"),
                            React.createElement("span", { className: "text-[20px] font-mono" }, fmt(pos.margin)),
                            React.createElement("span", { className: "text-[15px] font-mono", style: { color: pnlColor } },
                                fmtSigned(pnl),
                                " \u00B7 ",
                                signedPct(pnlRatio))),
                        React.createElement(Line, { left: tr("Цена входа"), right: fmt(pos.entryPrice) }),
                        React.createElement(Line, { left: tr("Текущая цена"), right: fmt(state.price) }),
                        React.createElement(Line, { left: tr("Объём в единицах"), right: pos.units.toFixed(4) }),
                        React.createElement(Line, { left: tr("При закрытии сейчас"), right: fmt(pos.settlement) }),
                        React.createElement(Line, { left: tr("Стоп-лосс"), right: human.stopLoss ? fmt(human.stopLoss) : tr("нет") }),
                        React.createElement(Line, { left: tr("Тейк-профит"), right: human.takeProfit ? fmt(human.takeProfit) : tr("нет") }),
                        React.createElement("div", { className: "grid grid-cols-3 gap-2 mt-4" }, [[0.25, "25%"], [0.5, "50%"], [1, "всё"]].map(([f, l]) => (React.createElement("button", { key: l, onClick: () => doClose(f, ACTIVE_LANG === "en" ? `closed ${l === "всё" ? "all" : l}` : `закрыто ${l}`), className: "rounded-lg py-3 text-[13px] font-semibold tap", style: btnSoft(false) }, l === "всё" ? tr("всё") : l)))))) : React.createElement(Blank, null, tr("Позиции нет")),
                    React.createElement("div", { className: "text-[11px] tracking-[0.10em] mt-8 mb-3", style: { color: FAINT } }, tr("ИТОГИ")),
                    React.createElement(Line, { left: tr("Стартовый капитал"), right: fmt(human.startingCapital) }),
                    React.createElement(Line, { left: tr("Эквити"), right: fmt(equity) }),
                    React.createElement(Line, { left: tr("Всего заработано"), right: fmtSigned(equity - human.startingCapital), color: equity >= human.startingCapital ? LONG : SHORT }),
                    React.createElement(Line, { left: tr("Реализованный PnL"), right: fmtSigned(human.realizedPnL), color: human.realizedPnL >= 0 ? LONG : SHORT }),
                    React.createElement(Line, { left: tr("Место в рейтинге"), right: ACTIVE_LANG === "en" ? `${snap.rank} of ${snap.totalPlayers}` : `${snap.rank} из ${snap.totalPlayers}` }))),
                tab === "Защита" && (React.createElement("div", { className: "px-5 pt-2 pb-6" },
                    React.createElement("div", { className: "text-[11px] tracking-[0.10em] mb-3", style: { color: FAINT } }, tr("ЗАЩИТА ПОЗИЦИИ")),
                    !pos ? React.createElement(Blank, null, tr("нужна открытая позиция")) : (React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "flex items-center justify-between py-3 border-b", style: { borderColor: HAIR } },
                            React.createElement("div", null,
                                React.createElement("div", { className: "text-[10px] tracking-[0.12em]", style: { color: FAINT } }, tr("СТОП")),
                                React.createElement("div", { className: "text-[14px] font-mono mt-1" }, human.stopLoss ? fmt(human.stopLoss) : tr("не установлен"))),
                            human.stopLoss && (React.createElement("button", { onClick: () => send({ type: "PROTECT", clear: "sl", stopLoss: null, takeProfit: null }), className: "ui-hit px-3 rounded-xl text-[11px] tap", style: btnSoft(false) }, tr("СНЯТЬ")))),
                        React.createElement("div", { className: "flex items-center justify-between py-3" },
                            React.createElement("div", null,
                                React.createElement("div", { className: "text-[10px] tracking-[0.12em]", style: { color: FAINT } }, tr("ТЕЙК")),
                                React.createElement("div", { className: "text-[14px] font-mono mt-1" }, human.takeProfit ? fmt(human.takeProfit) : tr("не установлен"))),
                            human.takeProfit && (React.createElement("button", { onClick: () => send({ type: "PROTECT", clear: "tp", stopLoss: null, takeProfit: null }), className: "ui-hit px-3 rounded-xl text-[11px] tap", style: btnSoft(false) }, tr("СНЯТЬ")))),
                        React.createElement("button", { onClick: () => { setTab("Рынок"); setSheet("risk"); }, className: "w-full min-h-[46px] rounded-xl mt-4 text-[11px] font-semibold tap", style: btnSoft(true) }, tr("НАСТРОИТЬ SL / TP")))))),
                tab === "Участники" && (React.createElement("div", { className: "px-5 pt-2 pb-6" },
                    React.createElement("div", { className: "grid grid-cols-3 gap-3 mb-5" },
                        React.createElement(Metric, { label: tr("ЛОНГИ"), value: String(stats.longPlayers), color: LONG }),
                        React.createElement(Metric, { label: tr("ШОРТЫ"), value: String(stats.shortPlayers), color: SHORT }),
                        React.createElement(Metric, { label: tr("ВНЕ РЫНКА"), value: String(stats.flatPlayers) })),
                    snap.freeMarket && (React.createElement("div", { className: "text-[10px] leading-snug mb-3", style: { color: FAINT } }, tr("Список ниже — выборка участников. Общие показатели сверху считаются по всему рынку."))),
                    React.createElement("div", { className: "flex gap-0.5 mb-2 flex-wrap" }, (snap.freeMarket ? ["Все", "Лонг", "Шорт", "Вне рынка"] : ["Все", "Лонг", "Шорт", "Вне рынка", "Топ-15"]).map((f) => (React.createElement(Toggle, { key: f, active: playerFilter === f, onClick: () => setPlayerFilter(f) }, filterLabel(f))))),
                    (() => {
                        let list = [...snap.players];
                        if (playerFilter === "Лонг")
                            list = list.filter((p) => p.position?.side === "long");
                        if (playerFilter === "Шорт")
                            list = list.filter((p) => p.position?.side === "short");
                        if (playerFilter === "Вне рынка")
                            list = list.filter((p) => !p.position);
                        list.sort((a, b) => snap.freeMarket
                            ? ((b.equity - b.startingCapital) / Math.max(1e-9, b.startingCapital))
                                - ((a.equity - a.startingCapital) / Math.max(1e-9, a.startingCapital))
                            : b.equity - a.equity);
                        if (!snap.freeMarket && playerFilter === "Топ-15")
                            list = list.slice(0, 15);
                        if (list.length === 0)
                            return React.createElement(Blank, null, tr("пусто"));
                        return list.map((p, i) => {
                            const eq = p.equity;
                            const delta = eq - p.startingCapital;
                            return (React.createElement("div", { key: p.id, className: "flex items-center gap-3 py-2.5 border-b", style: { borderColor: HAIR } },
                                React.createElement("span", { className: "text-[11px] font-mono w-6 shrink-0", style: { color: FAINT } }, i + 1),
                                React.createElement("div", { className: "min-w-0 flex-1" },
                                    React.createElement("div", { className: "text-[13px] truncate", style: { color: p.isHuman ? TEXT : DIM } },
                                        p.name,
                                        p.position && (React.createElement("span", { className: "ml-2 text-[11px] font-mono", style: { color: p.position.side === "long" ? LONG : SHORT } },
                                            p.position.side === "long" ? "long" : "short",
                                            " ",
                                            fmt(p.position.margin, 0)))),
                                    React.createElement("div", { className: "text-[11px] truncate", style: { color: FAINT } },
                                        p.isHuman ? tr("вы") : strategyLabel(p.archetype),
                                        " \u00B7 ",
                                        ACTIVE_LANG === "en" ? "trades" : "сделок",
                                        " ",
                                        p.tradeCount)),
                                React.createElement("div", { className: "text-right whitespace-nowrap" },
                                    React.createElement("div", { className: "text-[13px] font-mono" }, fmt(eq)),
                                    React.createElement("div", { className: "text-[11px] font-mono", style: { color: delta >= 0 ? LONG : SHORT } },
                                        fmtSigned(delta),
                                        snap.freeMarket
                                            ? ` · ${((delta / Math.max(1e-9, p.startingCapital)) * 100).toFixed(1)}%` : ""))));
                        });
                    })()))),
            tab === "Рынок" && (React.createElement("div", { className: "px-4 pt-2 pb-2 border-t tx-trade-panel", style: { borderColor: HAIR, background: "#070708" } },
                sheet && snap.tradingOpen && (React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "fixed inset-0 z-10", style: { backgroundColor: "rgba(0,0,0,0.78)" }, onClick: () => setSheet(null) }),
                    React.createElement("div", { className: "relative z-20 mb-3 rounded-[22px] p-4 tx-sheet", style: { ...CARD, boxShadow: "0 18px 60px rgba(0,0,0,.48)" } },
                        React.createElement("div", { className: "flex justify-between items-center gap-3 mb-4" },
                            React.createElement("div", null,
                                React.createElement("div", { className: "text-[10px] tracking-[0.12em]", style: { color: FAINT } }, tr("ЗАЩИТА ПОЗИЦИИ")),
                                React.createElement("div", { className: "text-[16px] mt-1" }, tr("Стоп / тейк"))),
                            React.createElement("button", { onClick: () => setSheet(null), className: "ui-hit px-3 rounded-xl text-[11px] tap", style: { color: DIM, backgroundColor: RAISED, border: `1px solid ${HAIR}` } }, tr("ЗАКРЫТЬ"))),
                        React.createElement("div", { className: "flex flex-col gap-2.5" },
                            [["sl", tr("СТОП"), [0.01, 0.02, 0.05], "−", human.stopLoss],
                                ["tp", tr("ТЕЙК"), [0.01, 0.03, 0.06], "+", human.takeProfit]].map(([kind, label, steps, sign, current]) => (React.createElement("div", { key: kind, className: "rounded-2xl p-3", style: { backgroundColor: RAISED, border: `1px solid ${HAIR}` } },
                                React.createElement("div", { className: "flex items-center justify-between gap-3 mb-2.5" },
                                    React.createElement("div", null,
                                        React.createElement("div", { className: "text-[9px] tracking-[0.11em]", style: { color: FAINT } }, label),
                                        React.createElement("div", { className: "text-[13px] font-mono mt-1", style: { color: current ? TEXT : DIM } }, current ? fmt(current) : tr("не установлен"))),
                                    current && (React.createElement("button", { onClick: () => send({ type: "PROTECT", clear: kind, stopLoss: null, takeProfit: null }), className: "ui-hit px-3 rounded-xl text-[11px] tap", style: { color: DIM, backgroundColor: SURFACE, border: `1px solid ${HAIR}` } }, tr("СНЯТЬ")))),
                                React.createElement("div", { className: "grid grid-cols-3 gap-2" }, steps.map((d) => (React.createElement("button", { key: d, disabled: !pos, onClick: () => setRisk(kind, d), className: "min-h-[44px] rounded-xl text-[12px] font-mono font-semibold tap disabled:opacity-30", style: btnSoft(false) },
                                    sign,
                                    (d * 100).toFixed(0),
                                    "%"))))))),
                            !pos && (React.createElement("div", { className: "text-[11px] leading-snug", style: { color: FAINT } }, tr("Сначала откройте позицию — уровни рассчитываются от цены входа."))))))),
                React.createElement("div", { className: "flex items-center justify-between gap-3 mb-2" },
                    React.createElement("div", { className: "text-[9px] tracking-[0.12em]", style: { color: FAINT } }, tr("ОРДЕР")),
                    React.createElement("span", { className: "text-[10px] font-mono shrink-0", style: { color: DIM } },
                        ACTIVE_LANG === "en" ? "available" : "свободно",
                        " ",
                        fmt(orderCapacity, 0))),
                React.createElement("div", { className: "flex items-stretch gap-1.5 mb-1.5" },
                    React.createElement("div", { className: "ui-field flex-1 min-w-0 rounded-xl px-3 flex items-center", style: { backgroundColor: SURFACE,
                            border: `1px solid ${orderTooLarge ? SHORT : HAIR}` } },
                        React.createElement("span", { className: "font-mono text-[12px] mr-1.5 shrink-0", style: { color: FAINT } }, "$"),
                        React.createElement("input", { value: size, onChange: (e) => setSize(sanitizeMoneyInput(e.target.value)), inputMode: "decimal", placeholder: "0", "aria-label": tr("Размер позиции"), className: "w-full bg-transparent outline-none font-mono text-[17px] min-w-0 h-[46px] leading-none", style: { color: orderTooLarge ? SHORT : TEXT } })),
                    [[0.25, "25%"], [0.5, "50%"], [1, "MAX"]].map(([f, label]) => (React.createElement("button", { key: label, onClick: () => setSize(String(Math.round(orderCapacity * f))), className: "w-[52px] h-[48px] rounded-xl font-mono text-[10px] font-semibold tap shrink-0", style: btnSoft(false) }, label)))),
                React.createElement("div", { className: "min-h-[16px] mb-1.5 flex items-center justify-between gap-2" },
                    React.createElement("span", { className: "text-[9px] truncate", style: { color: orderTooLarge ? SHORT : FAINT } }, orderTooLarge
                        ? ACTIVE_LANG === "en" ? `over available by ${fmt(notional - orderCapacity, 0)}` : `выше доступного на ${fmt(notional - orderCapacity, 0)}`
                        : notional > 0 ? ACTIVE_LANG === "en" ? `order ${fmt(notional, 0)}` : `ордер ${fmt(notional, 0)}` : tr("введите размер")),
                    React.createElement("button", { disabled: !pos, onClick: () => pos && setSheet(sheet === "risk" ? null : "risk"), className: "h-[34px] min-w-[82px] rounded-lg px-3 text-[10px] font-semibold tap disabled:opacity-30 shrink-0", style: sheet === "risk" ? btnSoft(true) : btnSoft(false) }, "SL / TP")),
                React.createElement("div", { className: "tx-order-actions grid grid-cols-2 gap-2" },
                    React.createElement("button", { disabled: !snap.tradingOpen || (!(pos && pos.side === "short") && !validOrderSize), onClick: doBuy, className: "rounded-2xl h-[60px] px-3 disabled:opacity-25 flex flex-col items-start justify-center text-left tap", style: btnAccent(LONG) },
                        React.createElement("span", { className: "font-bold text-[17px] tracking-wide" }, tr("ЛОНГ")),
                        React.createElement("span", { className: "text-[9px] opacity-70 mt-0.5 leading-tight truncate w-full" }, pos && pos.side === "short" ? tr("закрыть SHORT") : (ACTIVE_LANG === "en" ? `${fmt(notional, 0)} · open / add` : `${fmt(notional, 0)} · открыть / добавить`))),
                    React.createElement("button", { disabled: !snap.tradingOpen || (!(pos && pos.side === "long") && !validOrderSize), onClick: doSell, className: "rounded-2xl h-[60px] px-3 disabled:opacity-25 flex flex-col items-start justify-center text-left tap", style: btnAccent(SHORT) },
                        React.createElement("span", { className: "font-bold text-[17px] tracking-wide" }, tr("ШОРТ")),
                        React.createElement("span", { className: "text-[9px] opacity-70 mt-0.5 leading-tight truncate w-full" }, pos && pos.side === "long" ? tr("закрыть LONG") : (ACTIVE_LANG === "en" ? `${fmt(notional, 0)} · open / add` : `${fmt(notional, 0)} · открыть / добавить`)))),
                pos && (React.createElement("button", { disabled: !snap.tradingOpen, onClick: () => doClose(1, tr("позиция закрыта")), className: "w-full h-[38px] mt-1.5 rounded-xl px-3 flex items-center justify-between gap-3 tap disabled:opacity-30", style: btnSoft(false) },
                    React.createElement("span", { className: "text-[10px] font-semibold tracking-[0.08em]" }, tr("ЗАКРЫТЬ ПОЗИЦИЮ")),
                    React.createElement("span", { className: "text-[11px] font-mono", style: { color: pnlColor } }, fmtSigned(pnl)))))),
            toast && (React.createElement("div", { className: "tx-trade-toast absolute left-0 right-0 flex justify-center pointer-events-none", style: { bottom: tab === "Рынок" ? (pos ? 214 : 172) : 84 } },
                React.createElement("div", { className: "px-4 py-2 rounded-full text-[12px]", style: { backgroundColor: RAISED, color: toast.color, border: `1px solid ${HAIR}` } }, toast.text))),
            React.createElement("div", { className: "grid border-t ui-safe-bottom tx-trade-tabs", style: { borderColor: HAIR,
                    gridTemplateColumns: `repeat(${TAB_KEYS.length}, minmax(0, 1fr))` } }, TAB_KEYS.map((key) => {
                const active = tab === key;
                return (React.createElement("button", { key: key, onClick: () => setTab(key), className: "relative min-h-[48px] px-1 text-[10px] font-semibold tap", style: { color: active ? TEXT : FAINT, backgroundColor: "transparent" } },
                    active && React.createElement("span", { className: "absolute top-0 left-[22%] right-[22%] h-[2px] rounded-full", style: { backgroundColor: TEXT } }),
                    gameTabLabel(key)));
            })))));
}
export { PracticeApp };

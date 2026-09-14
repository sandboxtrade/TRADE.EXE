import React, { useEffect, useState } from "react";
import { CONFIG } from "../core/config.js";
import { sanitizeMoneyInput, parseMoneyInput } from "../core/money.js";
import { FREE_MARKET, LocalTransport, getFreeMarketHub } from "./market.js";
import { ACTIVE_LANG, tr, strategyLabel, clock } from "../i18n/index.js";
import { BG, RAISED, HAIR, TEXT, DIM, FAINT, LONG, SHORT, GOLD, CARD, CARD_SOFT, btnSoft, choiceStyle, fmt, fmtSigned } from "../ui/theme.js";
import { BackButton, Line } from "../ui/components.js";
import { stagger } from "../ui/styles.js";
function FreeMarketSetup({ wallet, onStart, onBack }) {
    const max = Math.min(FREE_MARKET.maxCapital, Math.max(0, wallet));
    const [amount, setAmount] = useState(String(Math.min(max, Math.max(FREE_MARKET.minCapital, Math.min(100, max)))));
    const value = parseMoneyInput(amount);
    const valid = value >= FREE_MARKET.minCapital && value <= max && value <= FREE_MARKET.maxCapital;
    useEffect(() => {
        let cancelled = false;
        const warm = () => { if (!cancelled)
            getFreeMarketHub(); };
        if (typeof requestIdleCallback === "function") {
            const id = requestIdleCallback(warm, { timeout: 800 });
            return () => { cancelled = true; if (typeof cancelIdleCallback === "function")
                cancelIdleCallback(id); };
        }
        const id = setTimeout(warm, 350);
        return () => { cancelled = true; clearTimeout(id); };
    }, []);
    return (React.createElement("div", { className: "w-full flex flex-col tx-screen", style: { height: "100dvh", backgroundColor: BG, color: TEXT } },
        React.createElement("div", { className: "max-w-md tx-form-wrap w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pb-8 ui-safe-top ui-scroll-pad" },
            React.createElement("div", { className: "flex items-center justify-between" },
                React.createElement(BackButton, { onClick: onBack }),
                React.createElement("span", { className: "ui-chip text-[9px] font-mono" }, ACTIVE_LANG === "en" ? "LOCAL · LIVE" : "ЛОКАЛЬНО · LIVE")),
            React.createElement("div", { className: "mt-6" },
                React.createElement("div", { className: "text-[28px] tracking-tight" }, tr("Свободный рынок")),
                React.createElement("div", { className: "text-[12px] mt-2 leading-relaxed max-w-[330px]", style: { color: DIM } }, tr("Непрерывный рынок из 5 000 автономных участников. Вход и выход — в любой момент."))),
            React.createElement("div", { className: "rounded-[20px] mt-5 px-4 py-3.5", style: CARD },
                React.createElement("div", { className: "grid grid-cols-3" }, [
                    [tr("БОТЫ"), FREE_MARKET.botCount.toLocaleString(ACTIVE_LANG === "en" ? "en-US" : "ru-RU")],
                    [tr("МИН. ВХОД"), fmt(FREE_MARKET.minCapital, 0)],
                    [tr("МАКС. ВХОД"), fmt(FREE_MARKET.maxCapital, 0)],
                ].map(([k, v], i) => (React.createElement("div", { key: k, className: `${i ? "pl-3 border-l" : ""} ${i < 2 ? "pr-3" : ""}`, style: { borderColor: HAIR } },
                    React.createElement("div", { className: "text-[8px] tracking-[0.08em]", style: { color: FAINT } }, k),
                    React.createElement("div", { className: "text-[14px] font-mono mt-1.5 truncate" }, v)))))),
            React.createElement("div", { className: "mt-7" },
                React.createElement("div", { className: "flex items-end justify-between gap-3 mb-2.5" },
                    React.createElement("div", { className: "text-[10px] tracking-[0.08em]", style: { color: FAINT } }, tr("КАПИТАЛ ДЛЯ ВХОДА")),
                    React.createElement("div", { className: "text-[10px] font-mono", style: { color: DIM } },
                        ACTIVE_LANG === "en" ? "available" : "доступно",
                        " ",
                        fmt(max, 0))),
                React.createElement("div", { className: "ui-field flex items-center rounded-[18px] px-4", style: { ...CARD, border: `1px solid ${valid ? HAIR : SHORT}` } },
                    React.createElement("span", { className: "text-[18px] font-mono mr-2", style: { color: FAINT } }, "$"),
                    React.createElement("input", { value: amount, onChange: (e) => setAmount(sanitizeMoneyInput(e.target.value)), inputMode: "decimal", autoComplete: "off", spellCheck: "false", className: "flex-1 bg-transparent outline-none py-4 text-[24px] font-mono min-w-0", style: { color: valid ? TEXT : SHORT } })),
                !valid && React.createElement("div", { className: "text-[10px] mt-2", style: { color: SHORT } },
                    ACTIVE_LANG === "en" ? "Available range" : "Доступный диапазон",
                    ": ",
                    fmt(FREE_MARKET.minCapital, 0),
                    "\u2013",
                    fmt(Math.min(FREE_MARKET.maxCapital, max), 0))),
            React.createElement("div", { className: "mt-5 rounded-[18px] px-4 py-3.5", style: CARD_SOFT },
                React.createElement("div", { className: "flex items-center justify-between py-1.5" },
                    React.createElement("span", { className: "text-[11px]", style: { color: DIM } }, tr("Таймер")),
                    React.createElement("span", { className: "text-[11px] font-mono" }, tr("нет"))),
                React.createElement("div", { className: "flex items-center justify-between py-1.5" },
                    React.createElement("span", { className: "text-[11px]", style: { color: DIM } }, tr("Штраф за выход")),
                    React.createElement("span", { className: "text-[11px] font-mono" }, tr("нет"))),
                React.createElement("div", { className: "flex items-center justify-between py-1.5" },
                    React.createElement("span", { className: "text-[11px]", style: { color: DIM } }, tr("Баланс участников")),
                    React.createElement("span", { className: "text-[11px]" }, tr("разный")))),
            React.createElement("div", { className: "text-[10px] mt-4 leading-relaxed", style: { color: FAINT } }, tr("Пока приложение открыто, повторный вход возвращает в тот же локальный рынок. После полной перезагрузки создаётся новое ядро."))),
        React.createElement("div", { className: "max-w-md tx-form-footer w-full mx-auto px-5 pt-3 ui-bottom-surface ui-safe-bottom" },
            React.createElement("button", { disabled: !valid, onClick: () => onStart(value), className: "w-full rounded-[18px] min-h-[54px] px-4 text-[13px] font-semibold tap disabled:opacity-30", style: btnSoft(true) },
                tr("ВОЙТИ"),
                " \u00B7 ",
                valid ? fmt(value, 0) : "—"))));
}
function SessionSetup({ wallet, onStart, onBack, eyes = false }) {
    const options = CONFIG.market.capitalOptions;
    const affordableOptions = options.filter((c) => c <= wallet);
    const [capital, setCapital] = useState(affordableOptions.slice(-1)[0] ?? null);
    const [leverage, setLeverage] = useState(1);
    const [minutes, setMinutes] = useState(CONFIG.market.durationOptions[1]);
    const [players, setPlayers] = useState(CONFIG.market.playerOptions[0]);
    return (React.createElement("div", { className: "w-full flex flex-col", style: { height: "100dvh", backgroundColor: BG, color: TEXT } },
        React.createElement("div", { className: "max-w-md tx-form-wrap w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pb-8 ui-safe-top ui-scroll-pad" },
            React.createElement(BackButton, { onClick: onBack }),
            React.createElement("div", { className: "mt-6" },
                React.createElement("div", { className: "text-[28px] tracking-tight" }, eyes ? tr("EYES-сессия") : tr("Новая сессия")),
                React.createElement("div", { className: "text-[12px] mt-2 leading-relaxed", style: { color: DIM } }, tr("Настройте капитал, размер комнаты и время. Все участники начинают на равных условиях.")),
                React.createElement("div", { className: "text-[10px] tracking-[0.08em] mt-7 mb-2.5", style: { color: FAINT } }, tr("ВЗНОС")),
                React.createElement("div", { className: "grid grid-cols-2 gap-2" }, options.map((value) => {
                    const active = capital === value;
                    const locked = value > wallet;
                    return (React.createElement("button", { key: value, disabled: locked, onClick: () => setCapital(value), className: "rounded-2xl min-h-[82px] py-4 text-left px-4 tap", style: choiceStyle(active, locked) },
                        React.createElement("div", { className: "text-[22px] font-mono" },
                            "$",
                            value.toLocaleString("en-US")),
                        React.createElement("div", { className: "text-[11px] mt-1", style: { color: active && !locked ? DIM : FAINT } }, locked ? tr("не хватает баланса") : (ACTIVE_LANG === "en" ? `market $${(value * players).toLocaleString("en-US")}` : `рынок $${(value * players).toLocaleString("en-US")}`))));
                })),
                React.createElement("div", { className: "text-[10px] tracking-[0.08em] mt-7 mb-2.5", style: { color: FAINT } }, tr("УЧАСТНИКИ")),
                React.createElement("div", { className: "grid grid-cols-3 gap-2" }, CONFIG.market.playerOptions.map((n) => {
                    const active = players === n;
                    return (React.createElement("button", { key: n, onClick: () => setPlayers(n), className: "rounded-xl min-h-[48px] px-2 text-[13px] font-mono font-semibold tap", style: choiceStyle(active) }, n));
                })),
                React.createElement("div", { className: "text-[10px] tracking-[0.08em] mt-7 mb-2.5", style: { color: FAINT } }, tr("ПЛЕЧО")),
                React.createElement("div", { className: "grid grid-cols-3 gap-2" }, CONFIG.market.leverageOptions.map((lv) => {
                    const active = leverage === lv;
                    return (React.createElement("button", { key: lv, onClick: () => setLeverage(lv), className: "rounded-xl min-h-[48px] px-2 text-[13px] font-mono font-semibold tap", style: choiceStyle(active) }, lv === 1 ? tr("без плеча") : `x${lv}`));
                })),
                leverage > 1 && (React.createElement("div", { className: "rounded-[16px] px-3.5 py-3 mt-3 text-[11px] leading-relaxed", style: { ...CARD_SOFT, color: DIM } },
                    ACTIVE_LANG === "en" ? `Maximum position size is x${leverage}. Borrowing is funded from the room pool; if margin falls below ` : `Максимальная позиция — x${leverage}. Заём оплачивается из кассы комнаты; при падении запаса ниже `,
                    React.createElement("span", { className: "font-mono", style: { color: TEXT } },
                        (CONFIG.LEV_MAINTENANCE / leverage * 100).toFixed(1),
                        "%"),
                    ACTIVE_LANG === "en" ? " the position is force-closed." : " позиция закрывается автоматически.")),
                React.createElement("div", { className: "text-[10px] tracking-[0.08em] mt-7 mb-2.5", style: { color: FAINT } }, tr("ДЛИТЕЛЬНОСТЬ")),
                React.createElement("div", { className: "grid grid-cols-4 gap-2" }, CONFIG.market.durationOptions.map((mm) => {
                    const active = minutes === mm;
                    return (React.createElement("button", { key: mm, onClick: () => setMinutes(mm), className: "rounded-xl min-h-[48px] px-2 text-[13px] font-mono font-semibold tap", style: choiceStyle(active) },
                        mm,
                        " ",
                        ACTIVE_LANG === "en" ? "min" : "мин"));
                })),
                React.createElement("div", { className: "rounded-[18px] px-4 py-3.5 mt-6", style: CARD_SOFT },
                    React.createElement("div", { className: "flex items-center justify-between py-1.5" },
                        React.createElement("span", { className: "text-[11px]", style: { color: DIM } }, tr("Капитал комнаты")),
                        React.createElement("span", { className: "text-[11px] font-mono" }, capital ? fmt(capital * players, 0) : "—")),
                    React.createElement("div", { className: "flex items-center justify-between py-1.5" },
                        React.createElement("span", { className: "text-[11px]", style: { color: DIM } }, tr("Равный старт")),
                        React.createElement("span", { className: "text-[11px]" },
                            players,
                            " ",
                            ACTIVE_LANG === "en" ? "participants" : "участников")),
                    React.createElement("div", { className: "flex items-center justify-between py-1.5" },
                        React.createElement("span", { className: "text-[11px]", style: { color: DIM } }, tr("Досрочный выход")),
                        React.createElement("span", { className: "text-[11px] font-mono" },
                            "\u2212",
                            Math.round(CONFIG.market.earlyExitPenalty * 100),
                            "%"))),
                React.createElement("div", { className: "text-[10px] mt-3 leading-relaxed", style: { color: FAINT } }, tr("В конце сессии на баланс возвращается итоговый капитал. Размер взноса меняет масштаб денег, но не поведение модели.")))),
        React.createElement("div", { className: "max-w-md tx-form-footer w-full mx-auto px-5 pt-3 ui-bottom-surface ui-safe-bottom" },
            React.createElement("button", { disabled: !capital || capital > wallet, onClick: () => capital && capital <= wallet && onStart(capital, leverage, minutes, eyes, players), className: "w-full rounded-2xl min-h-[54px] px-4 text-[14px] tracking-[0.09em] font-semibold tap disabled:opacity-30", style: btnSoft(true) }, capital ? (ACTIVE_LANG === "en" ? `ENTER ${eyes ? "EYES" : "MARKET"} · ${fmt(capital, 0)} · ${minutes} MIN · ${players}` : `ВОЙТИ В ${eyes ? "EYES" : "РЫНОК"} · ${fmt(capital, 0)} · ${minutes} МИН · ${players}`)
                : (ACTIVE_LANG === "en" ? "INSUFFICIENT BALANCE" : "НЕДОСТАТОЧНО СРЕДСТВ ДЛЯ ВХОДА")))));
}
const ROOM_NAMES = [
    "Ivan", "Nord", "Kite", "Vera", "Osip", "Mira", "Zed", "Lika", "Orion",
    "Rune", "Sable", "Tessa", "Umka", "Vega", "Wolf", "Xena", "Yuri", "Zara",
];
function Matchmaking({ capital, leverage = 1, total: totalProp, onReady, onCancel }) {
    const [joined, setJoined] = useState(1);
    const [feed, setFeed] = useState([ACTIVE_LANG === "en" ? "you joined the room" : "вы вошли в комнату"]);
    const total = totalProp || CONFIG.market.totalPlayers;
    useEffect(() => {
        let count = 1;
        let ready = null;
        const timer = setInterval(() => {
            const step = Math.max(1, Math.round(total / 100));
            count = Math.min(total, count + step * (3 + Math.floor(Math.random() * 9)));
            setJoined(count);
            const who = ROOM_NAMES[Math.floor(Math.random() * ROOM_NAMES.length)];
            setFeed((prev) => [ACTIVE_LANG === "en" ? `${who}-${Math.floor(Math.random() * 900 + 100)} joined` : `${who}-${Math.floor(Math.random() * 900 + 100)} присоединился`,
                ...prev].slice(0, 5));
            if (count >= total) {
                clearInterval(timer);
                ready = setTimeout(onReady, 700);
            }
        }, 130);
        return () => { clearInterval(timer); if (ready)
            clearTimeout(ready); };
    }, []);
    const pct = joined / total;
    return (React.createElement("div", { className: "w-full flex flex-col tx-screen", style: { height: "100dvh", backgroundColor: BG, color: TEXT } },
        React.createElement("div", { className: "max-w-md tx-form-wrap w-full mx-auto flex-1 flex flex-col justify-center px-5 ui-safe-top" },
            React.createElement("div", { className: "text-[11px] tracking-[0.11em]", style: { color: FAINT } }, tr("ПОДБОР УЧАСТНИКОВ")),
            React.createElement("div", { className: "text-[56px] leading-none font-mono tracking-tight mt-3" },
                joined,
                React.createElement("span", { className: "text-[24px]", style: { color: FAINT } },
                    " / ",
                    total)),
            React.createElement("div", { className: "h-1 w-full rounded-full mt-6 overflow-hidden", style: { backgroundColor: HAIR } },
                React.createElement("div", { style: { width: `${pct * 100}%`, height: "100%", backgroundColor: TEXT,
                        transition: "width var(--tx-mid) var(--tx-ease)" } })),
            React.createElement("div", { className: "mt-8" },
                React.createElement(Line, { left: tr("Взнос каждого"), right: fmt(capital, 0) }),
                React.createElement(Line, { left: tr("Капитал комнаты"), right: fmt(capital * total, 0) }),
                React.createElement(Line, { left: tr("Актив"), right: CONFIG.market.assetSymbol }),
                React.createElement(Line, { left: tr("Режим"), right: leverage > 1 ? (ACTIVE_LANG === "en" ? `margin · leverage x${leverage}` : `маржинальный · плечо x${leverage}`) : tr("обычный"), color: TEXT })),
            React.createElement("div", { className: "mt-8 h-[110px]" }, feed.map((line, i) => (React.createElement("div", { key: `${line}-${i}`, className: "text-[12px] font-mono py-1 tx-in", style: { color: i === 0 ? DIM : FAINT, opacity: 1 - i * 0.18 } }, line))))),
        React.createElement("div", { className: "max-w-md tx-form-footer w-full mx-auto px-5 pt-3 ui-safe-bottom" },
            React.createElement("button", { onClick: onCancel, className: "w-full rounded-2xl min-h-[52px] px-4 text-[13px] tracking-[0.14em] font-semibold tap", style: btnSoft(false) }, tr("ОТМЕНИТЬ ПОДБОР")))));
}
function SessionResult({ result, onDone }) {
    const good = result.pnl >= 0;
    const pct = result.capital ? (result.pnl / result.capital) * 100 : 0;
    return (React.createElement("div", { className: "w-full flex flex-col tx-screen", style: { height: "100dvh", backgroundColor: BG, color: TEXT } },
        React.createElement("div", { className: "max-w-md tx-form-wrap w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pb-8 ui-safe-top ui-scroll-pad" },
            React.createElement("div", { className: "text-[10px] tracking-[0.08em]", style: { color: FAINT } }, result.mode === "free" ? tr("ВЫХОД ИЗ FREE MARKET") : result.early ? tr("ДОСРОЧНЫЙ ВЫХОД") : tr("СЕССИЯ ЗАВЕРШЕНА")),
            React.createElement("div", { className: "mt-5 flex items-end justify-between gap-4" },
                React.createElement("div", { className: "text-[44px] leading-none font-mono tracking-tight", style: { color: good ? LONG : SHORT } }, fmtSigned(result.pnl)),
                React.createElement("div", { className: "text-[14px] font-mono pb-1", style: { color: good ? LONG : SHORT } },
                    pct >= 0 ? "+" : "",
                    pct.toFixed(2),
                    "%")),
            React.createElement("div", { className: "text-[12px] mt-2", style: { color: DIM } }, result.mode === "free" ? tr("результат от введённого капитала") : tr("результат сессии")),
            React.createElement("div", { className: "rounded-[20px] px-4 mt-7", style: CARD },
                React.createElement(Line, { left: result.mode === "free" ? tr("Введено") : tr("Взнос"), right: fmt(result.capital) }),
                React.createElement(Line, { left: tr("Итоговый капитал"), right: fmt(result.equity) }),
                React.createElement(Line, { left: tr("Место"), right: ACTIVE_LANG === "en" ? `${result.rank} of ${result.totalPlayers || CONFIG.market.totalPlayers}` : `${result.rank} из ${result.totalPlayers || CONFIG.market.totalPlayers}` }),
                React.createElement(Line, { left: tr("Сделки"), right: String(result.trades) }),
                React.createElement(Line, { left: tr("Время в рынке"), right: clock(result.ticks * CONFIG.market.tickMs) }),
                React.createElement("div", { className: "flex items-center justify-between gap-3 min-h-[42px] py-2.5" },
                    React.createElement("span", { className: "text-[12px]", style: { color: DIM } }, tr("Цена выхода")),
                    React.createElement("span", { className: "text-[12px] font-mono" }, fmt(result.price)))),
            result.early && React.createElement("div", { className: "rounded-[16px] px-4 py-3 mt-3 flex items-center justify-between", style: CARD_SOFT },
                React.createElement("span", { className: "text-[11px]", style: { color: DIM } }, tr("Штраф за досрочный выход")),
                React.createElement("span", { className: "text-[12px] font-mono", style: { color: SHORT } },
                    "\u2212",
                    fmt(result.penalty || 0))),
            result.top && result.top.length > 0 && React.createElement(React.Fragment, null,
                React.createElement("div", { className: "text-[10px] tracking-[0.08em] mt-8 mb-2.5", style: { color: FAINT } }, tr("ЛУЧШИЕ В КОМНАТЕ")),
                React.createElement("div", { className: "rounded-[20px] overflow-hidden", style: CARD }, result.top.map((p, i) => React.createElement("div", { key: i, className: `px-4 py-3 flex items-center gap-3 tx-in ${i ? "border-t" : ""}`, style: { borderColor: HAIR, backgroundColor: p.you ? RAISED : "transparent", ...stagger(i) } },
                    React.createElement("span", { className: "text-[12px] font-mono w-6 shrink-0", style: { color: i === 0 ? GOLD : FAINT } }, String(i + 1).padStart(2, "0")),
                    React.createElement("span", { className: "flex-1 min-w-0 text-[12px] truncate", style: { color: p.you ? TEXT : DIM } }, p.you ? tr("вы") : (strategyLabel(String(p.name).split("-")[0]) || p.name)),
                    React.createElement("span", { className: "text-[12px] font-mono shrink-0", style: { color: p.pnl >= 0 ? LONG : SHORT } }, fmtSigned(p.pnl))))))),
        React.createElement("div", { className: "max-w-md tx-form-footer w-full mx-auto px-5 pt-3 ui-bottom-surface ui-safe-bottom" },
            React.createElement("button", { onClick: onDone, className: "w-full rounded-[18px] min-h-[54px] px-4 text-[13px] font-semibold tap", style: btnSoft(true) }, tr("НА ГЛАВНУЮ")))));
}
export { FreeMarketSetup, SessionSetup, Matchmaking, SessionResult };

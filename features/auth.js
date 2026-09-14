import React, { useEffect, useState } from "react";
import { clamp } from "../core/engine.js";
import { ACTIVE_LANG, tr, translateEngineReason } from "../i18n/index.js";
import { BG, RAISED, HAIR, TEXT, DIM, FAINT, SHORT, ACCENT, CARD, btnSoft } from "../ui/theme.js";
import { BackButton, Line } from "../ui/components.js";
import { authStore, EMAIL_RE } from "../storage/auth.js";
import { stagger } from "../ui/styles.js";
import { Icon } from "../ui/icons.js";
const LOGO_SRC = new URL("../ui/trade-logo.png", import.meta.url).href;
function Logo({ size = 96 }) {
    return (React.createElement("span", { style: { display: "inline-block", width: size, height: size, lineHeight: 0 } },
        React.createElement("img", { src: LOGO_SRC, alt: "trade.exe", draggable: false, style: { width: "100%", height: "100%", display: "block",
                userSelect: "none", WebkitUserDrag: "none" } })));
}
const BOOT_STEPS = [
    { key: "auth", label: "проверка аккаунта" },
    { key: "profile", label: "загрузка профиля" },
    { key: "engine", label: "прогрев движка" },
    { key: "ready", label: "синхронизация интерфейса" },
];
function Boot({ done }) {
    const total = BOOT_STEPS.length;
    const progress = clamp(done / total, 0, 1);
    const current = Math.min(Math.max(done, 0), total - 1);
    return (React.createElement("div", { className: "w-full flex items-center justify-center px-8 tx-fade relative overflow-hidden", style: { height: "100dvh", backgroundColor: BG, color: TEXT } },
        React.createElement("div", { className: "absolute inset-0 pointer-events-none", style: { background: "radial-gradient(circle at 50% 38%, rgba(216,210,200,.055), transparent 34%)" } }),
        React.createElement("div", { className: "relative z-10 w-full max-w-[300px]" },
            React.createElement("div", { className: "flex items-center justify-center" },
                React.createElement("div", { className: "w-[86px] h-[86px] rounded-[18px] flex items-center justify-center", style: { ...CARD, background: "#070708" } },
                    React.createElement(Logo, { size: 62, live: true }))),
            React.createElement("div", { className: "text-center mt-7" },
                React.createElement("div", { className: "text-[24px] tracking-tight" }, "trade.exe"),
                React.createElement("div", { className: "text-[10px] tracking-[0.14em] mt-2", style: { color: FAINT } }, tr("ПОДГОТОВКА СРЕДЫ"))),
            React.createElement("div", { className: "mt-8" },
                React.createElement("div", { className: "flex justify-between text-[10px] mb-2", style: { color: FAINT } },
                    React.createElement("span", null, done >= total ? tr("готово") : tr(BOOT_STEPS[current]?.label)),
                    React.createElement("span", { className: "font-mono" },
                        Math.round(progress * 100),
                        "%")),
                React.createElement("div", { className: "h-[3px] rounded-full overflow-hidden", style: { backgroundColor: HAIR } },
                    React.createElement("div", { className: "h-full rounded-full", style: { width: `${progress * 100}%`, backgroundColor: ACCENT,
                            transition: "width 320ms var(--tx-ease)" } })),
                React.createElement("div", { className: "grid grid-cols-4 gap-2 mt-4" }, BOOT_STEPS.map((s, i) => {
                    const active = done > i;
                    return React.createElement("div", { key: s.key, className: "h-[2px] rounded-full", style: { backgroundColor: active ? TEXT : HAIR, opacity: active ? .8 : 1 } });
                }))))));
}
const FEATURES = [
    { icon: "candles", title: "РЕАЛЬНЫЙ РЫНОК",
        text: "Цена формируется только действиями участников." },
    { icon: "people", title: "ЖИВЫЕ ИГРОКИ",
        text: "Торгуй против других участников в реальном времени." },
    { icon: "shield", title: "НИЧЕГО ЛИШНЕГО",
        text: "Никаких внешних факторов. Только ты и рынок." },
];
const FeatureIcon = ({ name }) => {
    const c = { width: 44, height: 44, viewBox: "0 0 44 44", fill: "none",
        stroke: TEXT, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
    if (name === "candles")
        return (React.createElement("svg", { ...c },
            React.createElement("path", { d: "M11 10v24M22 6v32M33 13v18" }),
            React.createElement("rect", { x: "7", y: "16", width: "8", height: "13", fill: BG }),
            React.createElement("rect", { x: "18", y: "12", width: "8", height: "20", fill: BG }),
            React.createElement("rect", { x: "29", y: "19", width: "8", height: "9", fill: BG })));
    if (name === "people")
        return (React.createElement("svg", { ...c },
            React.createElement("circle", { cx: "15", cy: "15", r: "5" }),
            React.createElement("circle", { cx: "29", cy: "13", r: "4" }),
            React.createElement("path", { d: "M6 34c0-6 4-9 9-9s9 3 9 9M26 34c0-5 3-8 7-8s6 3 6 8" })));
    return (React.createElement("svg", { ...c },
        React.createElement("path", { d: "M22 5l14 5v11c0 8-6 14-14 18-8-4-14-10-14-18V10z" }),
        React.createElement("path", { d: "M16 21l5 5 8-9" })));
};
function Onboarding({ onSignIn, onSignUp }) {
    const [slide, setSlide] = useState(0);
    const [back, setBack] = useState(false);
    const go = (i) => { setBack(i < slide); setSlide(i); };
    const anim = back ? "tx-slide-back" : "tx-slide";
    const last = slide === 2;
    return (React.createElement("div", { className: "w-full flex flex-col tx-screen", style: { height: "100dvh", backgroundColor: BG, color: TEXT } },
        React.createElement("div", { className: "max-w-md tx-auth-wrap tx-onboarding-wrap w-full mx-auto flex-1 min-h-0 flex flex-col justify-center px-7 ui-safe-top" },
            slide === 0 && (React.createElement("div", { key: "s0", className: `flex flex-col items-center ${anim}` },
                React.createElement(Logo, { size: 112, live: true }),
                React.createElement("div", { className: "text-[30px] tracking-tight mt-5" }, "trade.exe"),
                React.createElement("div", { className: "text-[12px] tracking-[0.19em] text-center mt-10 leading-loose", style: { color: DIM } },
                    tr("ЗАКРЫТЫЙ РЫНОК"),
                    React.createElement("br", null),
                    tr("ДЛЯ ПРАКТИКИ")))),
            slide === 1 && (React.createElement("div", { key: "s1", className: `flex flex-col items-center ${anim}` },
                React.createElement(Logo, { size: 72, live: true }),
                React.createElement("div", { className: "text-[22px] tracking-tight mt-3 mb-8" }, "trade.exe"),
                React.createElement("div", { className: "w-full" }, FEATURES.map((f, i) => (React.createElement("div", { key: f.title, className: `flex items-start gap-5 py-6 ${anim} ${i ? "border-t" : ""}`, style: { borderColor: HAIR, ...stagger(i + 1) } },
                    React.createElement("div", { className: "shrink-0 mt-0.5" },
                        React.createElement(FeatureIcon, { name: f.icon })),
                    React.createElement("div", { className: "min-w-0" },
                        React.createElement("div", { className: "text-[13px] tracking-[0.13em] font-semibold" }, tr(f.title)),
                        React.createElement("div", { className: "text-[13px] mt-1.5 leading-snug", style: { color: DIM } }, tr(f.text))))))))),
            slide === 2 && (React.createElement("div", { key: "s2", className: `flex flex-col items-center text-center ${anim}` },
                React.createElement(Logo, { size: 84, live: true }),
                React.createElement("div", { className: "text-[26px] tracking-tight mt-4" }, tr("Готовы начать?")),
                React.createElement("div", { className: "text-[13px] mt-4 leading-relaxed max-w-[280px]", style: { color: DIM } }, ACTIVE_LANG === "en"
                    ? "A session is a closed room with 100 participants starting with equal capital. Total capital stays constant: every dollar earned is a dollar lost by someone else."
                    : "Сессия — это закрытая комната на 100 участников с одинаковым взносом. Общий капитал не меняется: всё, что кто-то заработал, кто-то потерял.")))),
        React.createElement("div", { className: "max-w-md tx-auth-actions w-full mx-auto px-7 pb-5 shrink-0 ui-safe-bottom" },
            React.createElement("div", { className: "flex justify-center gap-2 mb-7" }, [0, 1, 2].map((i) => (React.createElement("button", { key: i, onClick: () => go(i), "aria-label": `${ACTIVE_LANG === "en" ? "Slide" : "Слайд"} ${i + 1}`, className: "w-8 h-8 flex items-center justify-center rounded-full tap" },
                React.createElement("span", { className: "rounded-full", style: { width: i === slide ? 22 : 7, height: 7,
                        backgroundColor: i === slide ? TEXT : HAIR,
                        transition: "width var(--tx-mid) var(--tx-ease), background-color var(--tx-mid) var(--tx-ease)" } }))))),
            React.createElement("button", { onClick: () => (last ? onSignIn() : go(slide + 1)), className: "w-full rounded-2xl py-5 text-[14px] tracking-[0.10em] font-bold tap", style: btnSoft(true) }, last ? tr("ВОЙТИ") : tr("ДАЛЕЕ")),
            React.createElement("button", { onClick: last ? onSignUp : () => onSignIn(), className: "w-full py-4 text-[12px] tracking-[0.10em] tap", style: { color: DIM } }, last ? tr("СОЗДАТЬ АККАУНТ") : tr("ПРОПУСТИТЬ")))));
}
function Field({ label, value, onChange, placeholder, secret, type = "text" }) {
    const [shown, setShown] = useState(false);
    return (React.createElement("div", { className: "mb-4 tx-in" },
        React.createElement("div", { className: "text-[10px] tracking-[0.13em] mb-2", style: { color: FAINT } }, label),
        React.createElement("div", { className: "ui-field tx-field-control flex items-center rounded-2xl px-4", style: CARD },
            React.createElement("input", { value: value, onChange: (e) => onChange(e.target.value), placeholder: placeholder, type: secret && !shown ? "password" : type, autoCapitalize: "none", autoCorrect: "off", spellCheck: "false", className: "flex-1 min-w-0 bg-transparent outline-none py-4 text-[14px] min-h-[52px]", style: { color: TEXT } }),
            secret && (React.createElement("button", { onClick: () => setShown((v) => !v), className: "min-h-[44px] px-2 text-[11px] tap", style: { color: shown ? TEXT : FAINT } }, shown ? tr("скрыть") : tr("показать"))))));
}
const Check = ({ on, onClick, children }) => (React.createElement("button", { onClick: onClick, className: "flex items-start gap-3 text-left w-full" },
    React.createElement("span", { className: "w-[18px] h-[18px] rounded shrink-0 mt-0.5 flex items-center justify-center", style: { backgroundColor: on ? TEXT : "transparent", border: `1px solid ${on ? TEXT : DIM}` } }, on && React.createElement(Icon, { name: "check", size: 12, color: BG })),
    React.createElement("span", { className: "text-[12px] leading-snug", style: { color: DIM } }, children)));
function AuthScreen({ mode, onMode, onBack, onDone }) {
    const [email, setEmail] = useState("");
    const [pass, setPass] = useState("");
    const [pass2, setPass2] = useState("");
    const [remember, setRemember] = useState(true);
    const [agree, setAgree] = useState(false);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const signup = mode === "signup";
    const submit = async () => {
        setError(null);
        if (!EMAIL_RE.test(email.trim()))
            return setError(ACTIVE_LANG === "en" ? "Check your email address" : "Проверьте адрес почты");
        if (pass.length < 6)
            return setError(ACTIVE_LANG === "en" ? "Password must be at least 6 characters" : "Пароль от 6 символов");
        if (signup && pass !== pass2)
            return setError(ACTIVE_LANG === "en" ? "Passwords do not match" : "Пароли не совпадают");
        if (signup && !agree)
            return setError(ACTIVE_LANG === "en" ? "Please accept the terms" : "Нужно принять условия");
        setBusy(true);
        try {
            const res = signup
                ? await authStore.signUp(email.trim(), pass, true)
                : await authStore.signIn(email.trim(), pass, remember);
            if (!res.ok)
                return setError(translateEngineReason(res.reason) || (ACTIVE_LANG === "en" ? "Could not sign in" : "Не удалось войти"));
            onDone(res.account);
        }
        catch (_) {
            setError(ACTIVE_LANG === "en" ? "Could not sign in" : "Не удалось войти");
        }
        finally {
            setBusy(false);
        }
    };
    const tab = (key, label) => (React.createElement("button", { onClick: () => { onMode(key); setError(null); }, className: "flex-1 rounded-xl py-3.5 text-[12px] tracking-[0.13em] font-semibold tap", style: { backgroundColor: mode === key ? RAISED : "transparent",
            color: mode === key ? TEXT : FAINT,
            border: `1px solid ${mode === key ? "#35343A" : "transparent"}` } }, label));
    return (React.createElement("div", { className: "w-full flex flex-col tx-screen", style: { height: "100dvh", backgroundColor: BG, color: TEXT } },
        React.createElement("div", { className: "max-w-md tx-auth-wrap w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pb-8 ui-safe-top ui-scroll-pad" },
            React.createElement(BackButton, { onClick: onBack }),
            React.createElement("div", { className: "text-center mt-6" },
                React.createElement("div", { className: "text-[13px] tracking-[0.11em]", style: { color: DIM } }, signup ? tr("СОЗДАЙТЕ АККАУНТ") : tr("ДОБРО ПОЖАЛОВАТЬ")),
                React.createElement("div", { className: "text-[14px] mt-2", style: { color: DIM } }, signup ? tr("Начните торговать") : tr("Войдите в свой аккаунт"))),
            React.createElement("div", { className: "tx-auth-tabs flex gap-1 p-1 rounded-2xl mt-7 mb-7", style: CARD },
                tab("signin", tr("ВОЙТИ")),
                tab("signup", tr("РЕГИСТРАЦИЯ"))),
            React.createElement(Field, { label: "EMAIL", value: email, onChange: setEmail, placeholder: "you@example.com", type: "email" }),
            React.createElement(Field, { label: tr("ПАРОЛЬ"), value: pass, onChange: setPass, placeholder: tr("Введите пароль"), secret: true }),
            signup && (React.createElement(Field, { key: "p2", label: tr("ПОДТВЕРДИТЕ ПАРОЛЬ"), value: pass2, onChange: setPass2, placeholder: tr("Повторите пароль"), secret: true })),
            !signup ? (React.createElement("div", { className: "flex items-center justify-between mt-1 mb-6" },
                React.createElement(Check, { on: remember, onClick: () => setRemember((v) => !v) }, tr("Запомнить меня")),
                React.createElement("button", { onClick: () => setError(ACTIVE_LANG === "en" ? "Password recovery will be available once server authentication is connected" : "Восстановление пароля появится после подключения авторизации"), className: "min-h-[44px] px-2 text-[12px] whitespace-nowrap tap", style: { color: DIM } }, tr("Забыли пароль?")))) : (React.createElement("div", { className: "mt-1 mb-6" },
                React.createElement(Check, { on: agree, onClick: () => setAgree((v) => !v) }, tr("Я принимаю Пользовательское соглашение и Политику конфиденциальности")))),
            error && (React.createElement("div", { className: "text-[12px] mb-4 text-center tx-pop", style: { color: SHORT } }, error)),
            React.createElement("button", { onClick: submit, disabled: busy, className: "w-full rounded-2xl min-h-[54px] py-4 text-[14px] tracking-[0.08em] font-semibold disabled:opacity-40 tap", style: btnSoft(true) }, busy ? tr("ПОДОЖДИТЕ…") : signup ? tr("СОЗДАТЬ АККАУНТ") : tr("ВОЙТИ")),
            !signup && (React.createElement(React.Fragment, null,
                React.createElement("div", { className: "flex items-center gap-4 my-6" },
                    React.createElement("div", { className: "flex-1 h-px", style: { backgroundColor: HAIR } }),
                    React.createElement("span", { className: "text-[11px] tracking-[0.13em]", style: { color: FAINT } }, tr("ИЛИ")),
                    React.createElement("div", { className: "flex-1 h-px", style: { backgroundColor: HAIR } })),
                React.createElement("div", { className: "grid grid-cols-2 gap-3" }, ["Google", "Apple"].map((p) => (React.createElement("button", { key: p, onClick: () => setError(ACTIVE_LANG === "en" ? `${p} sign-in will be available with the server version` : `Вход через ${p} появится вместе с сервером`), className: "rounded-2xl py-4 text-[13px] font-semibold tap", style: btnSoft(false) }, p)))))),
            React.createElement("div", { className: "text-[11px] text-center mt-8 leading-relaxed", style: { color: FAINT } }, signup
                ? (ACTIVE_LANG === "en" ? "Already have an account? Tap Sign in above." : "Уже есть аккаунт? Нажмите «Войти» выше.")
                : (ACTIVE_LANG === "en" ? "By signing in, you agree to the Terms and Privacy Policy." : "Нажимая «Войти», вы соглашаетесь с Условиями и Политикой конфиденциальности.")))));
}
export { Logo, Boot, Onboarding, Field, Check, AuthScreen };

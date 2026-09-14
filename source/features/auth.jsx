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
  return (
    <span style={{ display: "inline-block", width: size, height: size, lineHeight: 0 }}>
      <img src={LOGO_SRC} alt="trade.exe" draggable={false}
        style={{ width: "100%", height: "100%", display: "block",
          userSelect: "none", WebkitUserDrag: "none" }} />
    </span>
  );
}

/** Экран загрузки. Показывается, пока читаются аккаунт и профиль. */
/* ------------------------------- ЗАГРУЗКА --------------------------------
   Экран запуска делает настоящую работу, а не просто ждёт таймер:
   читает аккаунт, читает профиль и прогревает движок — прогоняет
   одноразовую комнату на 120 тиков в idle-время, чтобы JIT успел
   скомпилировать горячие функции клиринга до первой настоящей сессии. Без прогрева
   первые секунды реальной игры заметно дёргались.
   ------------------------------------------------------------------------ */
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
  return (
    <div className="w-full flex items-center justify-center px-8 tx-fade relative overflow-hidden"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: "radial-gradient(circle at 50% 38%, rgba(216,210,200,.055), transparent 34%)" }} />
      <div className="relative z-10 w-full max-w-[300px]">
        <div className="flex items-center justify-center">
          <div className="w-[86px] h-[86px] rounded-[18px] flex items-center justify-center"
            style={{ ...CARD, background: "#070708" }}>
            <Logo size={62} live />
          </div>
        </div>
        <div className="text-center mt-7">
          <div className="text-[24px] tracking-tight">trade.exe</div>
          <div className="text-[10px] tracking-[0.14em] mt-2" style={{ color: FAINT }}>
            {tr("ПОДГОТОВКА СРЕДЫ")}
          </div>
        </div>
        <div className="mt-8">
          <div className="flex justify-between text-[10px] mb-2" style={{ color: FAINT }}>
            <span>{done >= total ? tr("готово") : tr(BOOT_STEPS[current]?.label)}</span>
            <span className="font-mono">{Math.round(progress * 100)}%</span>
          </div>
          <div className="h-[3px] rounded-full overflow-hidden" style={{ backgroundColor: HAIR }}>
            <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, backgroundColor: ACCENT,
              transition: "width 320ms var(--tx-ease)" }} />
          </div>
          <div className="grid grid-cols-4 gap-2 mt-4">
            {BOOT_STEPS.map((s, i) => {
              const active = done > i;
              return <div key={s.key} className="h-[2px] rounded-full"
                style={{ backgroundColor: active ? TEXT : HAIR, opacity: active ? .8 : 1 }} />;
            })}
          </div>
        </div>
      </div>
    </div>
  );
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
  if (name === "candles") return (
    <svg {...c}>
      <path d="M11 10v24M22 6v32M33 13v18" />
      <rect x="7" y="16" width="8" height="13" fill={BG} />
      <rect x="18" y="12" width="8" height="20" fill={BG} />
      <rect x="29" y="19" width="8" height="9" fill={BG} />
    </svg>
  );
  if (name === "people") return (
    <svg {...c}>
      <circle cx="15" cy="15" r="5" /><circle cx="29" cy="13" r="4" />
      <path d="M6 34c0-6 4-9 9-9s9 3 9 9M26 34c0-5 3-8 7-8s6 3 6 8" />
    </svg>
  );
  return (
    <svg {...c}>
      <path d="M22 5l14 5v11c0 8-6 14-14 18-8-4-14-10-14-18V10z" />
      <path d="M16 21l5 5 8-9" />
    </svg>
  );
};

/** Онбординг: три слайда, переключаются кнопкой и точками. */
function Onboarding({ onSignIn, onSignUp }) {
  const [slide, setSlide] = useState(0);
  /* Направление последнего перехода. Нужно, чтобы слайд въезжал с той
     стороны, откуда его позвали: вперёд — справа, назад по точкам —
     слева. Без этого возврат по точкам выглядел как повтор шага вперёд. */
  const [back, setBack] = useState(false);
  const go = (i) => { setBack(i < slide); setSlide(i); };
  const anim = back ? "tx-slide-back" : "tx-slide";
  const last = slide === 2;

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md tx-auth-wrap tx-onboarding-wrap w-full mx-auto flex-1 min-h-0 flex flex-col justify-center px-7 ui-safe-top">

        {slide === 0 && (
          <div key="s0" className={`flex flex-col items-center ${anim}`}>
            <Logo size={112} live />
            <div className="text-[30px] tracking-tight mt-5">trade.exe</div>
            <div className="text-[12px] tracking-[0.19em] text-center mt-10 leading-loose"
              style={{ color: DIM }}>
              {tr("ЗАКРЫТЫЙ РЫНОК")}<br />{tr("ДЛЯ ПРАКТИКИ")}
            </div>
          </div>
        )}

        {slide === 1 && (
          <div key="s1" className={`flex flex-col items-center ${anim}`}>
            <Logo size={72} live />
            <div className="text-[22px] tracking-tight mt-3 mb-8">trade.exe</div>
            <div className="w-full">
              {FEATURES.map((f, i) => (
                <div key={f.title}
                  className={`flex items-start gap-5 py-6 ${anim} ${i ? "border-t" : ""}`}
                  style={{ borderColor: HAIR, ...stagger(i + 1) }}>
                  <div className="shrink-0 mt-0.5"><FeatureIcon name={f.icon} /></div>
                  <div className="min-w-0">
                    <div className="text-[13px] tracking-[0.13em] font-semibold">{tr(f.title)}</div>
                    <div className="text-[13px] mt-1.5 leading-snug" style={{ color: DIM }}>
                      {tr(f.text)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {slide === 2 && (
          <div key="s2" className={`flex flex-col items-center text-center ${anim}`}>
            <Logo size={84} live />
            <div className="text-[26px] tracking-tight mt-4">{tr("Готовы начать?")}</div>
            <div className="text-[13px] mt-4 leading-relaxed max-w-[280px]" style={{ color: DIM }}>
              {ACTIVE_LANG === "en"
                ? "A session is a closed room with 100 participants starting with equal capital. Total capital stays constant: every dollar earned is a dollar lost by someone else."
                : "Сессия — это закрытая комната на 100 участников с одинаковым взносом. Общий капитал не меняется: всё, что кто-то заработал, кто-то потерял."}
            </div>
          </div>
        )}
      </div>

      <div className="max-w-md tx-auth-actions w-full mx-auto px-7 pb-5 shrink-0 ui-safe-bottom">
        <div className="flex justify-center gap-2 mb-7">
          {[0, 1, 2].map((i) => (
            <button key={i} onClick={() => go(i)} aria-label={`${ACTIVE_LANG === "en" ? "Slide" : "Слайд"} ${i + 1}`}
              className="w-8 h-8 flex items-center justify-center rounded-full tap">
              <span className="rounded-full" style={{ width: i === slide ? 22 : 7, height: 7,
                backgroundColor: i === slide ? TEXT : HAIR,
                transition: "width var(--tx-mid) var(--tx-ease), background-color var(--tx-mid) var(--tx-ease)" }} />
            </button>
          ))}
        </div>

        <button onClick={() => (last ? onSignIn() : go(slide + 1))}
          className="w-full rounded-2xl py-5 text-[14px] tracking-[0.10em] font-bold tap"
          style={btnSoft(true)}>
          {last ? tr("ВОЙТИ") : tr("ДАЛЕЕ")}
        </button>
        <button onClick={last ? onSignUp : () => onSignIn()}
          className="w-full py-4 text-[12px] tracking-[0.10em] tap" style={{ color: DIM }}>
          {last ? tr("СОЗДАТЬ АККАУНТ") : tr("ПРОПУСТИТЬ")}
        </button>
      </div>
    </div>
  );
}

/** Поле ввода с подписью и, для паролей, кнопкой показа. */
function Field({ label, value, onChange, placeholder, secret, type = "text" }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="mb-4 tx-in">
      <div className="text-[10px] tracking-[0.13em] mb-2" style={{ color: FAINT }}>{label}</div>
      <div className="ui-field tx-field-control flex items-center rounded-2xl px-4"
        style={CARD}>
        <input value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder} type={secret && !shown ? "password" : type}
          autoCapitalize="none" autoCorrect="off" spellCheck="false"
          className="flex-1 min-w-0 bg-transparent outline-none py-4 text-[14px] min-h-[52px]"
          style={{ color: TEXT }} />
        {secret && (
          <button onClick={() => setShown((v) => !v)} className="min-h-[44px] px-2 text-[11px] tap"
            style={{ color: shown ? TEXT : FAINT }}>
            {shown ? tr("скрыть") : tr("показать")}
          </button>
        )}
      </div>
    </div>
  );
}

const Check = ({ on, onClick, children }) => (
  <button onClick={onClick} className="flex items-start gap-3 text-left w-full">
    <span className="w-[18px] h-[18px] rounded shrink-0 mt-0.5 flex items-center justify-center"
      style={{ backgroundColor: on ? TEXT : "transparent", border: `1px solid ${on ? TEXT : DIM}` }}>
      {on && <Icon name="check" size={12} color={BG} />}
    </span>
    <span className="text-[12px] leading-snug" style={{ color: DIM }}>{children}</span>
  </button>
);

/** Вход и регистрация. Один экран, две вкладки. */
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
    if (!EMAIL_RE.test(email.trim())) return setError(ACTIVE_LANG === "en" ? "Check your email address" : "Проверьте адрес почты");
    if (pass.length < 6) return setError(ACTIVE_LANG === "en" ? "Password must be at least 6 characters" : "Пароль от 6 символов");
    if (signup && pass !== pass2) return setError(ACTIVE_LANG === "en" ? "Passwords do not match" : "Пароли не совпадают");
    if (signup && !agree) return setError(ACTIVE_LANG === "en" ? "Please accept the terms" : "Нужно принять условия");
    setBusy(true);
    try {
      const res = signup
        ? await authStore.signUp(email.trim(), pass, true)
        : await authStore.signIn(email.trim(), pass, remember);
      if (!res.ok) return setError(translateEngineReason(res.reason) || (ACTIVE_LANG === "en" ? "Could not sign in" : "Не удалось войти"));
      onDone(res.account);
    } catch (_) {
      setError(ACTIVE_LANG === "en" ? "Could not sign in" : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  };

  const tab = (key, label) => (
    <button onClick={() => { onMode(key); setError(null); }}
      className="flex-1 rounded-xl py-3.5 text-[12px] tracking-[0.13em] font-semibold tap"
      style={{ backgroundColor: mode === key ? RAISED : "transparent",
        color: mode === key ? TEXT : FAINT,
        border: `1px solid ${mode === key ? "#35343A" : "transparent"}` }}>
      {label}
    </button>
  );

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md tx-auth-wrap w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pb-8 ui-safe-top ui-scroll-pad">
        <BackButton onClick={onBack} />

        <div className="text-center mt-6">
          <div className="text-[13px] tracking-[0.11em]" style={{ color: DIM }}>
            {signup ? tr("СОЗДАЙТЕ АККАУНТ") : tr("ДОБРО ПОЖАЛОВАТЬ")}
          </div>
          <div className="text-[14px] mt-2" style={{ color: DIM }}>
            {signup ? tr("Начните торговать") : tr("Войдите в свой аккаунт")}
          </div>
        </div>

        <div className="tx-auth-tabs flex gap-1 p-1 rounded-2xl mt-7 mb-7"
          style={CARD}>
          {tab("signin", tr("ВОЙТИ"))}
          {tab("signup", tr("РЕГИСТРАЦИЯ"))}
        </div>

        <Field label="EMAIL" value={email} onChange={setEmail}
          placeholder="you@example.com" type="email" />
        <Field label={tr("ПАРОЛЬ")} value={pass} onChange={setPass}
          placeholder={tr("Введите пароль")} secret />
        {signup && (
          <Field key="p2" label={tr("ПОДТВЕРДИТЕ ПАРОЛЬ")} value={pass2} onChange={setPass2}
            placeholder={tr("Повторите пароль")} secret />
        )}

        {!signup ? (
          <div className="flex items-center justify-between mt-1 mb-6">
            <Check on={remember} onClick={() => setRemember((v) => !v)}>{tr("Запомнить меня")}</Check>
            <button onClick={() => setError(ACTIVE_LANG === "en" ? "Password recovery will be available once server authentication is connected" : "Восстановление пароля появится после подключения авторизации")}
              className="min-h-[44px] px-2 text-[12px] whitespace-nowrap tap" style={{ color: DIM }}>
              {tr("Забыли пароль?")}
            </button>
          </div>
        ) : (
          <div className="mt-1 mb-6">
            <Check on={agree} onClick={() => setAgree((v) => !v)}>
              {tr("Я принимаю Пользовательское соглашение и Политику конфиденциальности")}
            </Check>
          </div>
        )}

        {error && (
          <div className="text-[12px] mb-4 text-center tx-pop" style={{ color: SHORT }}>{error}</div>
        )}

        <button onClick={submit} disabled={busy}
          className="w-full rounded-2xl min-h-[54px] py-4 text-[14px] tracking-[0.08em] font-semibold disabled:opacity-40 tap"
          style={btnSoft(true)}>
          {busy ? tr("ПОДОЖДИТЕ…") : signup ? tr("СОЗДАТЬ АККАУНТ") : tr("ВОЙТИ")}
        </button>

        {!signup && (
          <>
            <div className="flex items-center gap-4 my-6">
              <div className="flex-1 h-px" style={{ backgroundColor: HAIR }} />
              <span className="text-[11px] tracking-[0.13em]" style={{ color: FAINT }}>{tr("ИЛИ")}</span>
              <div className="flex-1 h-px" style={{ backgroundColor: HAIR }} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              {["Google", "Apple"].map((p) => (
                <button key={p} onClick={() => setError(ACTIVE_LANG === "en" ? `${p} sign-in will be available with the server version` : `Вход через ${p} появится вместе с сервером`)}
                  className="rounded-2xl py-4 text-[13px] font-semibold tap"
                  style={btnSoft(false)}>
                  {p}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="text-[11px] text-center mt-8 leading-relaxed" style={{ color: FAINT }}>
          {signup
            ? (ACTIVE_LANG === "en" ? "Already have an account? Tap Sign in above." : "Уже есть аккаунт? Нажмите «Войти» выше.")
            : (ACTIVE_LANG === "en" ? "By signing in, you agree to the Terms and Privacy Policy." : "Нажимая «Войти», вы соглашаетесь с Условиями и Политикой конфиденциальности.")}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- ЛОББИ ---------------------------------
   Главный экран. Три смысловых блока: баланс, дневная динамика, история.
   Всё, что не является результатом игрока, намеренно бесцветно — зелёный
   и красный работают только как знак результата.
   ------------------------------------------------------------------------ */

/** Мелкие иконки. Рисуются вручную, чтобы не тянуть иконочный пакет. */

export { Logo, Boot, Onboarding, Field, Check, AuthScreen };

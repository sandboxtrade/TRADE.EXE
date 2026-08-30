import React, { useEffect, useRef, useState } from "react";
import {
  initializeApp,
} from "firebase/app";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInAnonymously, signOut, sendPasswordResetEmail, updateProfile,
} from "firebase/auth";
import {
  getFirestore, doc, onSnapshot as onFirestoreSnapshot,
} from "firebase/firestore";
import { CONFIG, STRATEGY_LABELS, clock, signedPct, HUMAN_ID, Room } from "@market-sandbox/engine";

/* ============================================================================
   MARKET SANDBOX — клиент.

   Торговый движок (ценообразование, ликвидность, PnL, поведение толпы,
   валидация команд, снапшоты, Room) больше не живёт в этом файле — он
   вынесен в packages/engine и импортируется отсюда, а также единственным
   сервисом на Cloud Run (см. server/index.js). Отдельных Cloud Functions
   в этой версии нет — сервис на Cloud Run сам проверяет Firebase Auth и
   сам пишет в Firestore через Admin SDK, это ровно то же самое, что умеет
   Cloud Function, только без лишнего сервиса для деплоя.

   Здесь остаётся: рендер, ввод, два транспорта (Local — для практики
   офлайн, Remote — для онлайн-комнаты на Firebase) и экран входа.
   ========================================================================== */

/* ============================== FIREBASE ==================================
   Значения берутся из переменных окружения Vite (см. .env.example в корне
   app/). Ничего секретного в этом объекте нет — конфиг Firebase рассчитан
   на попадание в клиентский бандл, но через .env удобнее держать разные
   значения для дев/прод без правки кода.
   ========================================================================== */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/** Адрес сервиса комнат на Cloud Run, БЕЗ финального слэша, напр.
 *  "https://market-sandbox-room-service-xxxxx.a.run.app" (то, что показывает
 *  Cloud Run после деплоя — просто вставить как есть, без "/ws" и "/api"). */
const ROOM_SERVICE_URL = import.meta.env.VITE_ROOM_SERVICE_URL;
const ROOM_SERVICE_WS_URL = ROOM_SERVICE_URL ? `${ROOM_SERVICE_URL.replace(/^http/, "ws")}/ws` : "";

// Практика (офлайн) не должна ломаться, если Firebase ещё не настроен —
// initializeApp() кидает исключение на пустом apiKey, поэтому инициализация
// делается лениво и только когда реально нужна (переход в онлайн-режим).
const FIREBASE_CONFIGURED = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
let firebaseApp = null, auth = null, db = null;
function ensureFirebase() {
  if (!FIREBASE_CONFIGURED) {
    throw new Error(
      "Firebase не настроен: заполните app/.env (см. .env.example) значениями вашего проекта."
    );
  }
  if (!firebaseApp) {
    firebaseApp = initializeApp(firebaseConfig);
    auth = getAuth(firebaseApp);
    db = getFirestore(firebaseApp);
  }
  return { auth, db };
}

/** Обёртка над fetch(), которая сама прикладывает Firebase ID-токен —
 *  единственный способ авторизации для сервиса на Cloud Run (см. комментарий
 *  выше и server/index.js → requireAuth). */
async function callRoomService(path, { method = "GET", body } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("нет активной сессии входа");
  const token = await user.getIdToken();
  const res = await fetch(`${ROOM_SERVICE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !("ok" in data)) throw new Error(data.reason || `сервис вернул ${res.status}`);
  return data;
}

// App Check (рекомендуется включить перед реальным запуском — см. README
// в корне репозитория, раздел «App Check»). Оставлено закомментированным,
// чтобы прототип запускался без дополнительной настройки сайт-ключей.
// import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
// initializeAppCheck(firebaseApp, {
//   provider: new ReCaptchaV3Provider("REPLACE_ME_RECAPTCHA_SITE_KEY"),
//   isTokenAutoRefreshEnabled: true,
// });

/* ============================ ТРАНСПОРТЫ ===================================
   Ровно тот контракт, который описан в ARCHITECTURE.md:
     start(onSnapshot) → подписка на состояние
     send(command)     → отправка намерения, возвращает Promise<{ok, reason?}>
     stop()            → отписка
   ========================================================================== */

/** Практика офлайн: движок крутится в процессе клиента, один человек. */
class LocalTransport {
  constructor({ startingCapital, seed, devMode = true } = {}) {
    this.room = new Room({ startingCapital, seed, devMode });
    this.playerId = HUMAN_ID;
    this.room.join(this.playerId, "ВЫ");
    this.timer = null;
    this.speed = 1;
  }
  start(onSnapshot) {
    this.timer = setInterval(() => {
      this.room.advance(this.speed);
      onSnapshot(this.room.snapshotFor(this.playerId));
    }, CONFIG.market.tickMs);
    onSnapshot(this.room.snapshotFor(this.playerId));
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  async send(command) { return this.room.send(this.playerId, command); }
  snapshot() { return this.room.snapshotFor(this.playerId); }
  setSpeed(value) { this.speed = value; }
  setPaused(value) { this.room.paused = value; }
  get paused() { return this.room.paused; }
}

/**
 * Онлайн-комната на Firebase. Команды идут HTTP-запросом на сервис Cloud
 * Run (см. callRoomService выше и server/index.js → /api/submitCommand),
 * тиковый поток — по WebSocket напрямую на тот же сервис (см. server/index.js
 * и ARCHITECTURE.md, раздел 4 — Firestore не годится как канал для 10
 * сообщений в секунду на игрока).
 *
 * Клиент не может управлять скоростью симуляции — это единственное
 * отличие в контракте от LocalTransport, и оно намеренное: скорость
 * тика в онлайн-комнате задаёт только сервер (ARCHITECTURE.md, раздел 4).
 */
class RemoteTransport {
  constructor({ roomId, playerId }) {
    this.roomId = roomId;
    this.playerId = playerId;
    this.ws = null;
    this.full = null;
    this.onSnapshot = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.onStatus = null; // ('connecting'|'online'|'reconnecting') => void, необязательный
  }

  async start(onSnapshot) {
    this.onSnapshot = onSnapshot;
    await this._connect();
  }

  async _connect() {
    this.onStatus?.("connecting");
    const user = auth.currentUser;
    if (!user) throw new Error("нет активной сессии входа");
    const token = await user.getIdToken();
    const url = `${ROOM_SERVICE_WS_URL}?roomId=${encodeURIComponent(this.roomId)}&token=${encodeURIComponent(token)}`;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      ws.onopen = () => { this.reconnectDelay = 1000; };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "hello") {
          this.full = msg.snapshot;
          if (!settled) { settled = true; this.onStatus?.("online"); resolve(); }
          this.onSnapshot?.(this.full);
        } else if (msg.type === "tick") {
          if (!this.full) return;
          this.full = {
            ...this.full,
            tick: msg.snapshot.tick, time: msg.snapshot.time, phase: msg.snapshot.phase,
            price: msg.snapshot.price, previousPrice: msg.snapshot.previousPrice,
            buyPressure: msg.snapshot.buyPressure, sellPressure: msg.snapshot.sellPressure,
            netPressure: msg.snapshot.netPressure, liquidity: msg.snapshot.liquidity,
            totalTrades: msg.snapshot.totalTrades,
            market: msg.snapshot.market, you: msg.snapshot.you ?? this.full.you,
            yourOrders: msg.snapshot.yourOrders,
            priceStream: [...(this.full.priceStream ?? []), msg.snapshot.lastPoint].slice(-1200),
          };
          this.onSnapshot?.(this.full);
        } else if (msg.type === "roster") {
          if (!this.full) return;
          this.full = {
            ...this.full,
            players: msg.snapshot.players, rank: msg.snapshot.rank,
            you: msg.snapshot.you ?? this.full.you, totalPlayers: msg.snapshot.totalPlayers,
          };
          this.onSnapshot?.(this.full);
        }
      };
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error("не удалось подключиться")); } };
      ws.onclose = () => {
        if (!settled) { settled = true; reject(new Error("соединение закрыто")); }
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
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 15000);
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
        method: "POST", body: { roomId: this.roomId, command },
      });
    } catch (err) {
      return { ok: false, reason: err.message || "сеть недоступна" };
    }
  }

  snapshot() { return this.full; }
  setSpeed() { /* сервер сам решает скорость тика — см. комментарий класса */ }
  setPaused() { /* пауза в общей комнате недоступна: рынок общий на всех */ }
  get paused() { return false; }
}

/* -------------------------------- СВЕЧИ ---------------------------------- */
const TIMEFRAMES = [
  { label: "1с", ms: 1000 }, { label: "5с", ms: 5000 }, { label: "15с", ms: 15000 },
  { label: "1м", ms: 60000 }, { label: "5м", ms: 300000 },
];

// Свечи строятся ТОЛЬКО из price stream движка, отдельной генерации нет.
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

/* ---------------------------------- ТЕМА ---------------------------------- */
/**
 * Монохром: чёрный фон, белый текст, серые оттенки для всего служебного.
 * Цвет разрешён ровно в двух местах — кнопки ЛОНГ/ШОРТ и знак результата
 * (PnL, экспозиция сторон). Всё остальное намеренно бесцветно, иначе
 * акценты перестают работать как акценты.
 */
const BG = "#000000";
const SURFACE = "#0B0B0C";
const RAISED = "#141416";
const HAIR = "#1E1E21";
const TEXT = "#FFFFFF";
const DIM = "#7A7A80";
const FAINT = "#46464C";
const LONG = "#19D67E";
const SHORT = "#FF3F52";

const fmt = (v, d = 2) => {
  const digits = Math.abs(v) >= 1000 ? 0 : d;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  })}`;
};
const fmtSigned = (v, d = 2) => `${v >= 0 ? "+" : "−"}${fmt(Math.abs(v), d).replace("-", "")}`;

/* --------------------------------- ГРАФИК --------------------------------- */
const CW = 700, AXIS = 74, CH = 340, VH = 60, MAX_CANDLES = 60;

function Chart({ state, timeframe, mode, entryPrice, stopLoss, takeProfit }) {
  const bucketMs = TIMEFRAMES.find((t) => t.label === timeframe)?.ms ?? 1000;
  const candles = buildCandles(state.priceHistory, bucketMs, MAX_CANDLES);
  if (candles.length < 2) {
    return <div style={{ height: 380 }} className="flex items-center justify-center text-[12px]"
      >{<span style={{ color: FAINT }}>собираем свечи…</span>}</div>;
  }

  let min = Infinity, max = -Infinity, maxVol = 0;
  for (const c of candles) {
    min = Math.min(min, c.low); max = Math.max(max, c.high);
    maxVol = Math.max(maxVol, c.volume);
  }
  for (const level of [entryPrice, stopLoss, takeProfit]) {
    if (level && level > min * 0.94 && level < max * 1.06) { min = Math.min(min, level); max = Math.max(max, level); }
  }
  const pad = Math.max((max - min) * 0.1, max * 0.0015);
  min -= pad; max += pad;
  const span = max - min || 1;
  const toY = (p) => CH - ((p - min) / span) * CH;

  const slot = CW / MAX_CANDLES;
  const body = Math.max(2, slot * 0.55);
  const offset = Math.max(0, MAX_CANDLES - candles.length);
  const grid = Array.from({ length: 5 }, (_, i) => min + (span * i) / 4);
  const priceY = toY(state.price);

  const level = (value, label, dash) =>
    value && value > min && value < max ? (
      <g>
        <line x1={0} x2={CW} y1={toY(value)} y2={toY(value)} stroke={FAINT} strokeWidth={1} strokeDasharray={dash} />
        <text x={4} y={toY(value) - 5} fill={FAINT} fontSize={11} fontFamily="monospace">{label}</text>
      </g>
    ) : null;

  return (
    <svg viewBox={`0 0 ${CW + AXIS} ${CH + VH + 4}`} className="w-full" style={{ height: 380 }}>
      {grid.map((p, i) => (
        <g key={i}>
          <line x1={0} x2={CW} y1={toY(p)} y2={toY(p)} stroke={HAIR} strokeWidth={1} />
          <text x={CW + 8} y={toY(p) + 4} fill={FAINT} fontSize={12} fontFamily="monospace">{p.toFixed(2)}</text>
        </g>
      ))}

      {mode === "свечи"
        ? candles.map((c, i) => {
            const x = (offset + i) * slot + slot / 2;
            const up = c.close >= c.open;
            const color = up ? LONG : SHORT;
            const top = toY(Math.max(c.open, c.close));
            const bottom = toY(Math.min(c.open, c.close));
            return (
              <g key={c.t}>
                <line x1={x} x2={x} y1={toY(c.high)} y2={toY(c.low)} stroke={color} strokeWidth={1} />
                <rect x={x - body / 2} y={top} width={body} height={Math.max(1.2, bottom - top)} fill={color} />
              </g>
            );
          })
        : (() => {
            const pts = candles.map((c, i) => `${(offset + i) * slot + slot / 2},${toY(c.close)}`).join(" ");
            const trend = candles[candles.length - 1].close >= candles[0].open ? LONG : SHORT;
            return (
              <>
                <polygon points={`${pts} ${CW},${CH} ${offset * slot},${CH}`} fill={trend} opacity={0.08} />
                <polyline points={pts} fill="none" stroke={trend} strokeWidth={1.6} />
              </>
            );
          })()}

      {level(entryPrice, `вход ${entryPrice?.toFixed(2)}`, "1 4")}
      {level(stopLoss, `стоп ${stopLoss?.toFixed(2)}`, "4 4")}
      {level(takeProfit, `тейк ${takeProfit?.toFixed(2)}`, "4 4")}

      {candles.map((c, i) => {
        const x = (offset + i) * slot + slot / 2;
        const h = maxVol === 0 ? 0 : (c.volume / maxVol) * (VH - 8);
        return <rect key={`v${c.t}`} x={x - body / 2} y={CH + 4 + (VH - 8 - h)}
          width={body} height={Math.max(0.5, h)}
          fill={c.close >= c.open ? LONG : SHORT} opacity={0.35} />;
      })}

      <line x1={0} x2={CW} y1={priceY} y2={priceY} stroke={TEXT} strokeWidth={1} strokeDasharray="3 3" opacity={0.4} />
      <rect x={CW + 2} y={priceY - 12} width={AXIS - 4} height={24} rx={3}
        fill={state.price >= state.previousPrice ? LONG : SHORT} />
      <text x={CW + AXIS / 2} y={priceY + 5} textAnchor="middle" fill={BG}
        fontSize={13} fontFamily="monospace" fontWeight="700">{state.price.toFixed(2)}</text>
    </svg>
  );
}

/* ------------------------------- ЭЛЕМЕНТЫ UI ------------------------------ */
function Metric({ label, value, color = TEXT }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-[0.12em] mb-1" style={{ color: FAINT }}>{label}</div>
      <div className="text-[15px] font-mono truncate" style={{ color }}>{value}</div>
    </div>
  );
}
function Line({ left, right, color }) {
  return (
    <div className="flex justify-between gap-3 py-2 border-b" style={{ borderColor: HAIR }}>
      <span className="text-[12px] truncate" style={{ color: DIM }}>{left}</span>
      <span className="text-[12px] font-mono whitespace-nowrap" style={{ color: color ?? TEXT }}>{right}</span>
    </div>
  );
}
const Blank = ({ children }) => (
  <div className="text-[12px] py-8 text-center" style={{ color: FAINT }}>{children}</div>
);
function Toggle({ active, onClick, children }) {
  return (
    <button onClick={onClick} className="px-2.5 py-1.5 rounded text-[12px] transition"
      style={{ color: active ? BG : DIM, backgroundColor: active ? TEXT : "transparent" }}>
      {children}
    </button>
  );
}

/* ================================ ПРОФИЛЬ ================================
   Профиль переживает сессии: кошелёк, история результатов, статистика.
   Хранится через window.storage, поэтому при следующем открытии
   приложение помнит, чем закончились прошлые заходы.
   ======================================================================== */
const PROFILE_KEY = "sandbox:profile";
const STARTING_WALLET = 25000;

const emptyProfile = () => ({
  wallet: STARTING_WALLET,
  deposited: STARTING_WALLET,
  sessions: [],
});

/**
 * ХРАНИЛИЩЕ ПРОФИЛЯ — второй шов под Firebase.
 *
 * Приложение работает с profileStore, а не с конкретным хранилищем.
 * Сейчас это локальный ключ-значение. В боевой версии подставляется
 * реализация поверх Firestore, а баланс становится серверным:
 *
 *   load()  → getDoc(doc(db, 'users', uid))
 *   save()  → НЕ пишется клиентом напрямую
 *
 * Последнее принципиально. Баланс и история сессий — это деньги игры.
 * Если клиент может писать в свой документ, он может дописать себе
 * любой баланс. Клиент вызывает startSession / closeSession, а
 * записывает только сервер. Правила Firestore на users/{uid} должны
 * быть read-only для владельца и полностью закрыты на запись.
 */
const profileStore = {
  async load() {
    try {
      const found = await window.storage.get(PROFILE_KEY);
      if (found?.value) return { ...emptyProfile(), ...JSON.parse(found.value) };
    } catch {
      // ключа ещё нет либо хранилище недоступно — начинаем с чистого профиля
    }
    return emptyProfile();
  },
  async save(profile) {
    try {
      await window.storage.set(PROFILE_KEY, JSON.stringify(profile));
    } catch {
      // Не удалось сохранить — сессия продолжается, но история не переживёт
      // перезагрузку. Ронять приложение из-за этого не стоит.
    }
  },
};

const loadProfile = () => profileStore.load();
const saveProfile = (profile) => profileStore.save(profile);

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

/* --------------------------------- ЛОББИ --------------------------------- */
function Lobby({ profile, onNew, onReset, onExit }) {
  const st = profileStats(profile);
  const affordable = CONFIG.market.capitalOptions.some((c) => c <= profile.wallet);

  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 overflow-y-auto px-6 pt-10 pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] tracking-[0.4em]" style={{ color: FAINT }}>ЗАКРЫТЫЙ РЫНОК · ПРАКТИКА</span>
          {onExit && (
            <button onClick={onExit} className="text-[11px]" style={{ color: DIM }}>сменить режим</button>
          )}
        </div>
        <div className="text-[28px] leading-none tracking-tight mb-10">Market Sandbox</div>

        <div className="text-[11px] tracking-[0.15em] mb-2" style={{ color: FAINT }}>БАЛАНС</div>
        <div className="text-[44px] leading-none font-mono tracking-tight">{fmt(profile.wallet)}</div>
        <div className="text-[13px] font-mono mt-2"
          style={{ color: st.total > 0 ? LONG : st.total < 0 ? SHORT : DIM }}>
          {st.count === 0 ? "сессий ещё не было" : `${fmtSigned(st.total)} за ${st.count} сесс.`}
        </div>

        <div className="grid grid-cols-4 gap-3 mt-8">
          <Metric label="СЕССИЙ" value={String(st.count)} />
          <Metric label="ПРИБЫЛЬНЫХ" value={st.count ? `${st.wins}` : "—"}
            color={st.wins > 0 ? LONG : TEXT} />
          <Metric label="ЛУЧШАЯ" value={st.count ? fmtSigned(st.best, 0) : "—"}
            color={st.best > 0 ? LONG : TEXT} />
          <Metric label="ХУДШАЯ" value={st.count ? fmtSigned(st.worst, 0) : "—"}
            color={st.worst < 0 ? SHORT : TEXT} />
        </div>

        <div className="text-[11px] tracking-[0.15em] mt-10 mb-1" style={{ color: FAINT }}>ИСТОРИЯ</div>
        {profile.sessions.length === 0 ? (
          <Blank>здесь появятся результаты ваших сессий</Blank>
        ) : (
          profile.sessions.slice(0, 12).map((x, i) => (
            <div key={i} className="flex items-center justify-between py-2.5 border-b" style={{ borderColor: HAIR }}>
              <div className="min-w-0">
                <div className="text-[13px] font-mono">{fmt(x.capital, 0)} → {fmt(x.equity)}</div>
                <div className="text-[11px]" style={{ color: FAINT }}>
                  {clock(x.ticks * CONFIG.market.tickMs)} в рынке · место {x.rank} из {CONFIG.market.totalPlayers}
                </div>
              </div>
              <div className="text-[14px] font-mono" style={{ color: x.pnl >= 0 ? LONG : SHORT }}>
                {fmtSigned(x.pnl)}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="max-w-md w-full mx-auto px-6 pb-8 pt-3">
        {affordable ? (
          <button onClick={onNew} className="w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold"
            style={{ backgroundColor: TEXT, color: BG }}>
            НОВАЯ СЕССИЯ
          </button>
        ) : (
          <>
            <div className="text-[12px] mb-3 text-center" style={{ color: FAINT }}>
              На балансе меньше минимального взноса.
            </div>
            <button onClick={onReset} className="w-full rounded-lg py-4 text-[15px] tracking-[0.15em]"
              style={{ backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }}>
              ПОПОЛНИТЬ ДО {fmt(STARTING_WALLET, 0)}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------- ВЫБОР РАЗМЕРА СЕССИИ ------------------------ */
function SessionSetup({ wallet, onStart, onBack }) {
  const options = CONFIG.market.capitalOptions;
  const [capital, setCapital] = useState(
    options.filter((c) => c <= wallet).slice(-1)[0] ?? options[0]
  );

  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6">
        <button onClick={onBack} className="text-[12px] mb-8 text-left" style={{ color: DIM }}>← назад</button>

        <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>ВЗНОС В СЕССИЮ</div>
        <div className="grid grid-cols-2 gap-2">
          {options.map((value) => {
            const active = capital === value;
            const locked = value > wallet;
            return (
              <button key={value} disabled={locked} onClick={() => setCapital(value)}
                className="rounded-lg py-5 text-left px-4 transition disabled:opacity-25"
                style={{
                  backgroundColor: active && !locked ? TEXT : SURFACE,
                  color: active && !locked ? BG : TEXT,
                  border: `1px solid ${active && !locked ? TEXT : HAIR}`,
                }}>
                <div className="text-[22px] font-mono">${value.toLocaleString("en-US")}</div>
                <div className="text-[11px] mt-1" style={{ color: active && !locked ? "#555" : FAINT }}>
                  {locked ? "не хватает баланса" : `рынок $${(value * CONFIG.market.totalPlayers).toLocaleString("en-US")}`}
                </div>
              </button>
            );
          })}
        </div>

        <div className="text-[12px] mt-5 leading-relaxed" style={{ color: FAINT }}>
          Столько же получает каждый из 99 ботов. Взнос списывается с баланса,
          а в конце сессии на баланс возвращается ваш итоговый капитал.
          Размер сессии меняет только масштаб денег — поведение рынка от него не зависит.
        </div>
      </div>

      <div className="max-w-md w-full mx-auto px-6 pb-8">
        <button onClick={() => onStart(capital)}
          className="w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold"
          style={{ backgroundColor: TEXT, color: BG }}>
          ВОЙТИ В РЫНОК · {fmt(capital, 0)}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ ИТОГ СЕССИИ ------------------------------- */
function SessionResult({ result, onDone }) {
  const good = result.pnl >= 0;
  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6">
        <div className="text-[11px] tracking-[0.4em] mb-3" style={{ color: FAINT }}>СЕССИЯ ЗАВЕРШЕНА</div>
        <div className="text-[52px] leading-none font-mono tracking-tight" style={{ color: good ? LONG : SHORT }}>
          {fmtSigned(result.pnl)}
        </div>
        <div className="text-[15px] font-mono mt-2" style={{ color: DIM }}>
          {((result.pnl / result.capital) * 100).toFixed(2)}% от взноса
        </div>

        <div className="mt-10">
          <Line left="Взнос" right={fmt(result.capital)} />
          <Line left="Итоговый капитал" right={fmt(result.equity)} />
          <Line left="Место в рейтинге" right={`${result.rank} из ${CONFIG.market.totalPlayers}`} />
          <Line left="Сделок" right={String(result.trades)} />
          <Line left="Время в рынке" right={clock(result.ticks * CONFIG.market.tickMs)} />
          <Line left="Цена на выходе" right={fmt(result.price)} />
        </div>
      </div>
      <div className="max-w-md w-full mx-auto px-6 pb-8">
        <button onClick={onDone} className="w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold"
          style={{ backgroundColor: TEXT, color: BG }}>
          В ЛОББИ
        </button>
      </div>
    </div>
  );
}

/* ============================ ПРАКТИКА (ОФЛАЙН) ============================
   Полностью локальный режим: движок крутится в браузере, профиль хранится
   через window.storage. Ничего не отправляется в сеть — удобно, чтобы
   попробовать механику рынка без входа в аккаунт.
   ========================================================================== */
function PracticeApp({ onExit }) {
  const [profile, setProfile] = useState(null);
  const [screen, setScreen] = useState("lobby");
  const [result, setResult] = useState(null);
  const [session, setSession] = useState(null);
  const engineRef = useRef(null);

  const [snapshot, setSnapshot] = useState(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState("Рынок");
  const [timeframe, setTimeframe] = useState("1с");
  const [chartMode, setChartMode] = useState("свечи");
  const [showSettings, setShowSettings] = useState(false);
  const [size, setSize] = useState("0");
  const [sheet, setSheet] = useState(null);
  const [limitPrice, setLimitPrice] = useState("");
  const [limitSide, setLimitSide] = useState("buy");
  const [playerFilter, setPlayerFilter] = useState("Все");
  const [npcMode, setNpcMode] = useState("активные");
  const [toast, setToast] = useState(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);

  const speedRef = useRef(1);
  speedRef.current = speed;
  const toastTimer = useRef(null);

  useEffect(() => { loadProfile().then(setProfile); }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  useEffect(() => {
    if (screen !== "game" || !session) return undefined;
    const transport = engineRef.current;
    if (!transport) return undefined;
    transport.start((next) => setSnapshot(next));
    return () => transport.stop();
  }, [screen, session]);

  useEffect(() => { engineRef.current?.setSpeed(speed); }, [speed]);

  const persist = (next) => { setProfile(next); saveProfile(next); };

  const startSession = (capital) => {
    // Приложение больше не создаёт движок напрямую — только транспорт.
    // При переезде на сервер здесь меняется одна строка на RemoteTransport.
    engineRef.current = new LocalTransport({ startingCapital: capital });
    setSize(String(Math.round(capital * 0.3)));
    setPaused(false);
    setTab("Рынок");
    setSession(capital);
    setScreen("game");
    persist({ ...profile, wallet: profile.wallet - capital });
  };

  /** Завершение сессии: итоговый капитал возвращается на баланс. */
  const finishSession = () => {
    const transport = engineRef.current;
    if (!transport) return;
    // Итог сессии берётся из снапшота, а не считается клиентом:
    // на сервере это будет ответ функции closeSession.
    const snap = transport.snapshot();
    const record = {
      capital: session,
      equity: snap.you.equity,
      pnl: snap.you.equity - session,
      rank: snap.rank,
      trades: snap.you.tradeCount,
      ticks: snap.tick,
      price: snap.price,
    };

    persist({
      ...profile,
      wallet: profile.wallet + record.equity,
      sessions: [record, ...profile.sessions].slice(0, 40),
    });

    transport.stop();
    engineRef.current = null;
    setSnapshot(null);
    setSession(null);
    setShowSettings(false);
    setResult(record);
    setScreen("result");
  };

  if (!profile) {
    return (
      <div className="w-full h-screen flex items-center justify-center"
        style={{ backgroundColor: BG, color: FAINT }}>
        <span className="text-[12px]">загрузка профиля…</span>
      </div>
    );
  }
  if (screen === "lobby") {
    return <Lobby profile={profile} onNew={() => setScreen("setup")} onExit={onExit}
      onReset={() => persist({ ...profile, wallet: STARTING_WALLET, deposited: profile.deposited + STARTING_WALLET })} />;
  }
  if (screen === "setup") {
    return <SessionSetup wallet={profile.wallet} onStart={startSession} onBack={() => setScreen("lobby")} />;
  }
  if (screen === "result" && result) {
    return <SessionResult result={result} onDone={() => { setResult(null); setScreen("lobby"); }} />;
  }
  if (!engineRef.current || !snapshot) {
    return <Lobby profile={profile} onNew={() => setScreen("setup")} onExit={onExit}
      onReset={() => persist({ ...profile, wallet: STARTING_WALLET })} />;
  }

  const transport = engineRef.current;
  const snap = snapshot;
  const say = (text, color = TEXT) => {
    setToast({ text, color });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1700);
  };

  const state = snap;                 // всё, что знает клиент
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
  /** Все действия игрока идут одним путём — через команду транспорту.
   *  transport.send() асинхронный (в онлайн-режиме это сетевой вызов),
   *  поэтому и весь путь команды — от кнопки до тоста — асинхронный. */
  const send = async (command) => {
    const res = await transport.send(command);
    if (!res.ok) say(res.reason, SHORT);
    refresh();
    return res;
  };

  const buyHint = pos && pos.side === "short" ? "закроет Short" : "открыть / увеличить Long";
  const sellHint = pos && pos.side === "long" ? "закроет Long" : "открыть / увеличить Short";

  const doBuy = async () => {
    const res = await send({ type: "TRADE", action: "BUY", notional, reason: "ручная покупка" });
    if (res.ok) say(pos && pos.side === "short" ? "закрываем Short" : `покупка ${fmt(notional, 0)}`, LONG);
  };
  const doSell = async () => {
    const res = await send({ type: "TRADE", action: "SELL", notional, reason: "ручная продажа" });
    if (res.ok) say(pos && pos.side === "long" ? "закрываем Long" : `продажа ${fmt(notional, 0)}`, SHORT);
  };
  const doClose = async (fraction, label) => {
    const res = await send({ type: "TRADE", action: "CLOSE", fraction, reason: "ручное закрытие" });
    if (res.ok) say(label);
  };
  const setRisk = async (kind, delta) => {
    if (!pos) return;
    const long = pos.side === "long";
    const target = kind === "sl"
      ? (long ? pos.entryPrice * (1 - delta) : pos.entryPrice * (1 + delta))
      : (long ? pos.entryPrice * (1 + delta) : pos.entryPrice * (1 - delta));
    const res = await send({
      type: "PROTECT",
      stopLoss: kind === "sl" ? target : null,
      takeProfit: kind === "tp" ? target : null,
    });
    if (res.ok) say(`${kind === "sl" ? "стоп" : "тейк"} ${target.toFixed(2)}`);
  };

  const TAB_KEYS = ["Рынок", "Позиции", "Ордера", "Участники", "Отладка"];

  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex flex-col h-full relative">

        {/* --------------------------------- шапка --------------------------- */}
        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-[11px] tracking-[0.3em]" style={{ color: FAINT }}>
            {CONFIG.market.assetSymbol} · {fmt(session, 0)}
          </span>
          <div className="flex items-center gap-4">
            <button onClick={togglePause} className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: paused ? FAINT : TEXT }} />
              <span className="text-[11px] tracking-[0.15em]" style={{ color: paused ? FAINT : DIM }}>
                {paused ? "ПАУЗА" : "LIVE"}
              </span>
            </button>
            <button onClick={() => setShowSettings((v) => !v)}
              className="text-[11px] tracking-[0.15em]" style={{ color: showSettings ? TEXT : FAINT }}>
              ЕЩЁ
            </button>
          </div>
        </div>

        {showSettings && (
          <div className="px-5 pb-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] tracking-[0.15em]" style={{ color: FAINT }}>СКОРОСТЬ</span>
              <div className="flex gap-1">
                {[1, 2, 5, 10].map((s) => (
                  <Toggle key={s} active={speed === s} onClick={() => setSpeed(s)}>{s}x</Toggle>
                ))}
              </div>
            </div>
            {confirmingEnd ? (
              <div className="flex gap-2">
                <button onClick={() => setConfirmingEnd(false)} className="flex-1 rounded-lg py-3 text-[13px]"
                  style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                  Отмена
                </button>
                <button onClick={finishSession} className="flex-1 rounded-lg py-3 text-[13px] font-semibold"
                  style={{ backgroundColor: SHORT, color: BG }}>
                  Да, завершить
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmingEnd(true)} className="rounded-lg py-3 text-[13px]"
                style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                Завершить сессию · {fmt(equity)} на баланс
              </button>
            )}
          </div>
        )}

        {/* -------------------------------- контент -------------------------- */}
        <div className="flex-1 overflow-y-auto">

          {tab === "Рынок" && (
            <>
              <div className="px-5 pt-1 flex items-end justify-between">
                <div>
                  <div className="text-[46px] leading-none font-mono tracking-tight">
                    {fmt(state.price)}
                  </div>
                  <div className="text-[14px] font-mono mt-1.5" style={{ color: changeAbs >= 0 ? LONG : SHORT }}>
                    {changeAbs >= 0 ? "+" : "−"}{Math.abs(changePct * 100).toFixed(2)}%
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] tracking-[0.15em]" style={{ color: DIM }}>{state.phase}</div>
                  <div className="text-[11px] font-mono mt-1" style={{ color: FAINT }}>
                    {stats.activePositions} / {CONFIG.market.totalPlayers} в рынке
                  </div>
                </div>
              </div>

              {/* Полоса сторон — единственный график толпы на главном экране */}
              <div className="px-5 pt-4">
                <div className="h-1 w-full flex rounded-full overflow-hidden" style={{ backgroundColor: HAIR }}>
                  <div style={{ width: `${stats.longShare * 100}%`, backgroundColor: LONG }} />
                  <div style={{ width: `${stats.shortShare * 100}%`, backgroundColor: SHORT }} />
                </div>
              </div>

              <div className="px-5 pt-4 grid grid-cols-4 gap-3">
                <Metric label="LONG" value={fmt(stats.longExposure, 0)} color={LONG} />
                <Metric label="SHORT" value={fmt(stats.shortExposure, 0)} color={SHORT} />
                <Metric label="BUY PRESS" value={fmt(state.buyPressure, 0)} />
                <Metric label="SELL PRESS" value={fmt(state.sellPressure, 0)} />
              </div>

              <div className="flex items-center justify-between px-5 pt-5">
                <div className="flex gap-0.5">
                  {TIMEFRAMES.map((tf) => (
                    <Toggle key={tf.label} active={timeframe === tf.label} onClick={() => setTimeframe(tf.label)}>
                      {tf.label}
                    </Toggle>
                  ))}
                </div>
                <button onClick={() => setChartMode(chartMode === "свечи" ? "линия" : "свечи")}
                  className="text-[12px]" style={{ color: DIM }}>{chartMode}</button>
              </div>

              <div className="px-2 pt-1">
                <Chart state={state} timeframe={timeframe} mode={chartMode}
                  entryPrice={pos?.entryPrice} stopLoss={human.stopLoss} takeProfit={human.takeProfit} />
              </div>

              <div className="px-5 pb-4 grid grid-cols-4 gap-3">
                <Metric label="ЭКВИТИ" value={fmt(equity)} />
                <Metric label="СВОБОДНО" value={fmt(human.cash)} />
                <Metric label="ПОЗИЦИЯ"
                  value={pos ? `${pos.side === "long" ? "LONG" : "SHORT"} ${fmt(pos.margin, 0)}` : "—"}
                  color={pos ? (pos.side === "long" ? LONG : SHORT) : TEXT} />
                <Metric label="PNL" value={pos ? fmtSigned(pnl) : "—"} color={pnlColor} />
              </div>
            </>
          )}

          {tab === "Позиции" && (
            <div className="px-5 pt-2 pb-6">
              <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>ПОЗИЦИЯ</div>
              {pos ? (
                <>
                  <div className="flex items-baseline justify-between mb-4">
                    <span className="text-[26px]" style={{ color: pos.side === "long" ? LONG : SHORT }}>
                      {pos.side === "long" ? "LONG" : "SHORT"}
                    </span>
                    <span className="text-[20px] font-mono">{fmt(pos.margin)}</span>
                    <span className="text-[15px] font-mono" style={{ color: pnlColor }}>
                      {fmtSigned(pnl)} · {signedPct(pnlRatio)}
                    </span>
                  </div>
                  <Line left="Цена входа" right={fmt(pos.entryPrice)} />
                  <Line left="Текущая цена" right={fmt(state.price)} />
                  <Line left="Объём в единицах" right={pos.units.toFixed(4)} />
                  <Line left="При закрытии сейчас" right={fmt(pos.settlement)} />
                  <Line left="Стоп-лосс" right={human.stopLoss ? fmt(human.stopLoss) : "нет"} />
                  <Line left="Тейк-профит" right={human.takeProfit ? fmt(human.takeProfit) : "нет"} />
                  <div className="grid grid-cols-3 gap-2 mt-4">
                    {[[0.25, "25%"], [0.5, "50%"], [1, "всё"]].map(([f, l]) => (
                      <button key={l} onClick={() => doClose(f, `закрыто ${l}`)}
                        className="rounded-lg py-3 text-[13px]"
                        style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>{l}</button>
                    ))}
                  </div>
                </>
              ) : <Blank>Позиции нет</Blank>}

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>ИТОГИ</div>
              <Line left="Стартовый капитал" right={fmt(human.startingCapital)} />
              <Line left="Эквити" right={fmt(equity)} />
              <Line left="Всего заработано" right={fmtSigned(equity - human.startingCapital)}
                color={equity >= human.startingCapital ? LONG : SHORT} />
              <Line left="Реализованный PnL" right={fmtSigned(human.realizedPnL)}
                color={human.realizedPnL >= 0 ? LONG : SHORT} />
              <Line left="Место в рейтинге" right={`${snap.rank} из ${snap.totalPlayers}`} />

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>ВАШИ СДЕЛКИ</div>
              {snap.yourTrades.length === 0 ? <Blank>сделок не было</Blank> :
                snap.yourTrades.map((t, i) => (
                  <Line key={i}
                    left={`${clock(t.time)} · ${t.action === "BUY" ? "покупка" : t.action === "SELL" ? "продажа" : "закрытие"}`}
                    right={`${fmt(t.notional, 0)} @ ${t.execPrice.toFixed(2)}${t.realizedPnL !== undefined ? `  ${fmtSigned(t.realizedPnL)}` : ""}`}
                    color={t.flow === "buy" ? LONG : SHORT} />
                ))}
            </div>
          )}

          {tab === "Ордера" && (
            <div className="px-5 pt-2 pb-6">
              <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>
                ЛИМИТНЫЕ ЗАЯВКИ · {myLimits.length}
              </div>
              {myLimits.length === 0 ? <Blank>активных заявок нет</Blank> :
                myLimits.map((o) => (
                  <div key={o.id} className="flex items-center justify-between py-3 border-b" style={{ borderColor: HAIR }}>
                    <div>
                      <div className="text-[13px]" style={{ color: o.side === "buy" ? LONG : SHORT }}>
                        {o.side === "buy" ? "покупка" : "продажа"} {fmt(o.notional, 0)}
                      </div>
                      <div className="text-[11px] font-mono" style={{ color: FAINT }}>
                        при цене {o.side === "buy" ? "≤" : "≥"} {o.limitPrice.toFixed(2)}
                      </div>
                    </div>
                    <button onClick={async () => { if ((await send({ type: "CANCEL_LIMIT", orderId: o.id })).ok) say("заявка снята"); }}
                      className="text-[12px]" style={{ color: DIM }}>снять</button>
                  </div>
                ))}

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>ЗАЩИТА ПОЗИЦИИ</div>
              {!pos ? <Blank>нужна открытая позиция</Blank> : (
                <>
                  <div className="flex items-center justify-between py-3 border-b" style={{ borderColor: HAIR }}>
                    <span className="text-[13px] font-mono">стоп {human.stopLoss ? fmt(human.stopLoss) : "—"}</span>
                    {human.stopLoss && (
                      <button onClick={() => send({ type: "PROTECT", clear: "sl", stopLoss: null, takeProfit: null })}
                        className="text-[12px]" style={{ color: DIM }}>убрать</button>
                    )}
                  </div>
                  <div className="flex items-center justify-between py-3">
                    <span className="text-[13px] font-mono">тейк {human.takeProfit ? fmt(human.takeProfit) : "—"}</span>
                    {human.takeProfit && (
                      <button onClick={() => send({ type: "PROTECT", clear: "tp", stopLoss: null, takeProfit: null })}
                        className="text-[12px]" style={{ color: DIM }}>убрать</button>
                    )}
                  </div>
                </>
              )}

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>
                ЗАЯВКИ УЧАСТНИКОВ · {snap.orders.length}
              </div>
              {snap.orders.length === 0
                ? <Blank>боты пользуются стопами и тейками</Blank>
                : snap.orders.slice(0, 20).map((o) => (
                    <Line key={o.id} left={o.playerName}
                      right={`${fmt(o.notional, 0)} @ ${o.limitPrice.toFixed(2)}`}
                      color={o.side === "buy" ? LONG : SHORT} />
                  ))}
            </div>
          )}

          {tab === "Участники" && (
            <div className="px-5 pt-2 pb-6">
              <div className="grid grid-cols-3 gap-3 mb-5">
                <Metric label="В ЛОНГЕ" value={String(stats.longPlayers)} color={LONG} />
                <Metric label="В ШОРТЕ" value={String(stats.shortPlayers)} color={SHORT} />
                <Metric label="ВНЕ РЫНКА" value={String(stats.flatPlayers)} />
              </div>
              <div className="flex gap-0.5 mb-2 flex-wrap">
                {["Все", "Лонг", "Шорт", "Вне рынка", "Топ-15"].map((f) => (
                  <Toggle key={f} active={playerFilter === f} onClick={() => setPlayerFilter(f)}>{f}</Toggle>
                ))}
              </div>
              {(() => {
                let list = [...snap.players];
                if (playerFilter === "Лонг") list = list.filter((p) => p.position?.side === "long");
                if (playerFilter === "Шорт") list = list.filter((p) => p.position?.side === "short");
                if (playerFilter === "Вне рынка") list = list.filter((p) => !p.position);
                list.sort((a, b) => b.equity - a.equity);
                if (playerFilter === "Топ-15") list = list.slice(0, 15);
                if (list.length === 0) return <Blank>пусто</Blank>;
                return list.map((p, i) => {
                  const eq = p.equity;
                  const delta = eq - p.startingCapital;
                  return (
                    <div key={p.id} className="flex items-center gap-3 py-2.5 border-b" style={{ borderColor: HAIR }}>
                      <span className="text-[11px] font-mono w-6 shrink-0" style={{ color: FAINT }}>{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] truncate" style={{ color: p.isHuman ? TEXT : DIM }}>
                          {p.name}
                          {p.position && (
                            <span className="ml-2 text-[11px] font-mono"
                              style={{ color: p.position.side === "long" ? LONG : SHORT }}>
                              {p.position.side === "long" ? "long" : "short"} {fmt(p.position.margin, 0)}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] truncate" style={{ color: FAINT }}>
                          {p.isHuman ? "живой игрок" : STRATEGY_LABELS[p.archetype]} · сделок {p.tradeCount}
                        </div>
                      </div>
                      <div className="text-right whitespace-nowrap">
                        <div className="text-[13px] font-mono">{fmt(eq)}</div>
                        <div className="text-[11px] font-mono" style={{ color: delta >= 0 ? LONG : SHORT }}>
                          {fmtSigned(delta)}
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}

          {tab === "Отладка" && (
            <div className="px-5 pt-2 pb-6">
              <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>КАПИТАЛ СИСТЕМЫ</div>
              <Line left="Общий капитал рынка" right={fmt(state.totalCapital)} />
              <Line left="Свободный кэш участников" right={fmt(stats.totalCash)} />
              <Line left="Кэш пула" right={fmt(snap.debug?.poolCash ?? 0)} />
              <Line left="Эквити пула" right={fmt(stats.poolEquity)} />
              <Line left="Эквити участников" right={fmt(stats.totalEquity)} />
              <Line left="Сумма" right={fmt(stats.totalEquity + stats.poolEquity)} />
              <Line left="Расхождение капитала" right={(snap.debug?.capitalDrift ?? 0).toExponential(2)}
                color={Math.abs(snap.debug?.capitalDrift ?? 0) < 1e-5 ? LONG : SHORT} />

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>МЕХАНИКА ЦЕНЫ</div>
              <Line left="Давление покупок" right={fmt(state.buyPressure)} />
              <Line left="Давление продаж" right={fmt(state.sellPressure)} />
              <Line left="Чистое давление" right={fmt(state.netPressure)}
                color={state.netPressure >= 0 ? LONG : SHORT} />
              <Line left="Ликвидность" right={fmt(state.liquidity)} />
              <Line left="Капитализация" right={fmt(stats.marketCap)} />
              <Line left="Фаза рынка" right={state.phase} />
              <Line left="Скорость (10 тиков)" right={signedPct(snap.debug?.context?.speed ?? 0)} />
              <Line left="Волатильность" right={((snap.debug?.context?.volatility ?? 0) * 100).toFixed(3) + "%"} />
              <Line left="Перекос толпы" right={signedPct(snap.debug?.context?.imbalance ?? 0, 0)} />
              <Line left="Всего сделок" right={String(snap.totalTrades)} />

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-2" style={{ color: FAINT }}>
                СДЕЛКИ ПОСЛЕДНЕГО ТИКА · ПОЧЕМУ ЦЕНА ДВИНУЛАСЬ
              </div>
              {(snap.debug?.lastTrades ?? []).length === 0
                ? <Blank>сделок не было — цена стоит на месте</Blank>
                : snap.debug.lastTrades.slice(0, 14).map((t, i) => (
                    <Line key={i}
                      left={`${t.playerName} · ${t.action === "BUY" ? "покупка" : t.action === "SELL" ? "продажа" : "закрытие"} · ${t.reason}`}
                      right={`${fmt(t.notional, 0)} @ ${t.execPrice.toFixed(2)}`}
                      color={t.flow === "buy" ? LONG : SHORT} />
                  ))}

              <div className="flex items-center justify-between mt-8 mb-2">
                <span className="text-[11px] tracking-[0.15em]" style={{ color: FAINT }}>NPC И ПРИЧИНЫ РЕШЕНИЙ</span>
                <div className="flex gap-0.5">
                  {["активные", "все"].map((m) => (
                    <Toggle key={m} active={npcMode === m} onClick={() => setNpcMode(m)}>{m}</Toggle>
                  ))}
                </div>
              </div>
              {(() => {
                // Отладочный блок приходит только в dev-снапшоте.
                // В продакшене сервер его не отдаёт, и вкладка будет пустой.
                let list = snap.players.filter((p) => p.debug);
                if (list.length === 0) return <Blank>отладка ботов доступна только в dev-режиме</Blank>;
                if (npcMode === "активные") {
                  list = list.filter((p) => p.position || snap.tick - p.debug.lastActionTick < 120);
                }
                list = list.sort((a, b) => b.debug.lastActionTick - a.debug.lastActionTick).slice(0, 25);
                if (list.length === 0) return <Blank>сейчас никто не действует</Blank>;
                return list.map((p) => {
                  const pnlNow = p.unrealized;
                  return (
                    <div key={p.id} className="py-2.5 border-b" style={{ borderColor: HAIR }}>
                      <div className="flex justify-between gap-2">
                        <span className="text-[12px] truncate">
                          {p.name} · <span style={{ color: DIM }}>{STRATEGY_LABELS[p.archetype]}</span>
                        </span>
                        <span className="text-[12px] font-mono whitespace-nowrap">{p.debug.lastAction}</span>
                      </div>
                      <div className="text-[11px] font-mono mt-0.5" style={{ color: FAINT }}>
                        капитал {fmt(p.equity, 0)} ·{" "}
                        {p.position
                          ? `${p.position.side} ${fmt(p.position.margin, 0)} от ${p.position.entryPrice.toFixed(2)} · ${fmtSigned(pnlNow)}`
                          : "вне рынка"}
                      </div>
                      <div className="text-[11px] font-mono" style={{ color: FAINT }}>
                        окно {p.debug.lookback}т · решение каждые {(p.debug.intervalTicks / 10).toFixed(1)}с ·
                        {" "}точность {(p.debug.accuracy * 100).toFixed(0)}% · ошибок {p.debug.mistakes}
                      </div>
                      <div className="text-[11px] font-mono" style={{ color: FAINT }}>
                        +{p.debug.wins} / −{p.debug.losses} · уверенность {(p.debug.confidence * 100).toFixed(0)}% ·
                        {" "}режим {p.debug.regimeBias > 0.2 ? "за трендом" : p.debug.regimeBias < -0.2 ? "против тренда" : "нейтрально"} ·
                        {" "}след. решение в {p.debug.nextDecisionTick}
                      </div>
                      <div className="flex flex-wrap gap-x-3 mt-0.5">
                        {(p.debug.lastReasons ?? []).map(([label, value], i) => (
                          <span key={i} className="text-[11px] font-mono"
                            style={{ color: value > 0 ? LONG : value < 0 ? SHORT : FAINT }}>
                            {label} {value >= 0 ? "+" : ""}{value.toFixed(2)}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>

        {/* ---------------------------- панель торговли ---------------------- */}
        {tab === "Рынок" && (
          <div className="px-4 pt-3 pb-3 border-t" style={{ borderColor: HAIR, backgroundColor: BG }}>
            {sheet && (
              <>
                <div className="fixed inset-0 z-10" style={{ backgroundColor: "rgba(0,0,0,0.75)" }}
                  onClick={() => setSheet(null)} />
                <div className="relative z-20 mb-3 rounded-lg p-3"
                  style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-[12px]">{sheet === "risk" ? "Стоп и тейк" : "Лимитная заявка"}</span>
                    <button onClick={() => setSheet(null)} className="text-[11px]" style={{ color: DIM }}>закрыть</button>
                  </div>

                  {sheet === "risk" ? (
                    <div className="flex flex-col gap-2">
                      {[["sl", "СТОП", [0.01, 0.02, 0.05], "−"], ["tp", "ТЕЙК", [0.01, 0.03, 0.06], "+"]].map(
                        ([kind, label, steps, sign]) => (
                          <div key={kind} className="flex items-center gap-2">
                            <span className="text-[10px] w-10 shrink-0" style={{ color: FAINT }}>{label}</span>
                            {steps.map((d) => (
                              <button key={d} disabled={!pos} onClick={() => setRisk(kind, d)}
                                className="flex-1 py-2.5 rounded text-[12px] font-mono disabled:opacity-25"
                                style={{ backgroundColor: RAISED }}>
                                {sign}{(d * 100).toFixed(0)}%
                              </button>
                            ))}
                            <span className="w-14 text-right text-[12px] font-mono" style={{ color: DIM }}>
                              {kind === "sl"
                                ? (human.stopLoss ? human.stopLoss.toFixed(2) : "—")
                                : (human.takeProfit ? human.takeProfit.toFixed(2) : "—")}
                            </span>
                          </div>
                        )
                      )}
                      {!pos && <div className="text-[11px]" style={{ color: FAINT }}>
                        Уровни считаются от цены входа — сначала откройте позицию.
                      </div>}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button onClick={() => setLimitSide(limitSide === "buy" ? "sell" : "buy")}
                        className="px-3 py-2.5 rounded text-[12px] font-semibold whitespace-nowrap"
                        style={{ backgroundColor: limitSide === "buy" ? LONG : SHORT, color: BG }}>
                        {limitSide === "buy" ? "LONG" : "SHORT"}
                      </button>
                      <input value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} inputMode="decimal"
                        placeholder={`цена · сейчас ${state.price.toFixed(2)}`}
                        className="flex-1 min-w-0 rounded px-3 py-2.5 outline-none font-mono text-[13px]"
                        style={{ backgroundColor: RAISED, color: TEXT }} />
                      <button
                        onClick={async () => {
                          const res = await send({
                            type: "LIMIT", side: limitSide, notional, limitPrice: Number(limitPrice),
                          });
                          if (res.ok) { setLimitPrice(""); setSheet(null); say("заявка выставлена"); }
                        }}
                        className="px-4 py-2.5 rounded text-[12px] font-semibold"
                        style={{ backgroundColor: TEXT, color: BG }}>ОК</button>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="flex items-center gap-1.5 mb-2.5">
              <div className="flex-1 flex items-center rounded px-3 py-2 min-w-0"
                style={{ backgroundColor: SURFACE }}>
                <span className="font-mono text-[13px] mr-1.5" style={{ color: FAINT }}>$</span>
                <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal"
                  className="w-full bg-transparent outline-none font-mono text-[15px] min-w-0"
                  style={{ color: TEXT }} />
              </div>
              {[0.25, 0.5, 1].map((f) => (
                <button key={f} onClick={() => setSize(String(Math.round(human.cash * f)))}
                  className="px-2.5 py-2.5 rounded font-mono text-[11px]"
                  style={{ backgroundColor: SURFACE, color: DIM }}>{f * 100}%</button>
              ))}
              <button onClick={() => setSheet(sheet === "risk" ? null : "risk")}
                className="px-2.5 py-2.5 rounded text-[11px]"
                style={{ backgroundColor: sheet === "risk" ? TEXT : SURFACE, color: sheet === "risk" ? BG : DIM }}>
                SL/TP
              </button>
              <button onClick={() => setSheet(sheet === "limit" ? null : "limit")}
                className="px-2.5 py-2.5 rounded text-[11px]"
                style={{ backgroundColor: sheet === "limit" ? TEXT : SURFACE, color: sheet === "limit" ? BG : DIM }}>
                лимит{myLimits.length ? ` ${myLimits.length}` : ""}
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button disabled={notional < 1 && !(pos && pos.side === "short")} onClick={doBuy}
                className="rounded-lg py-3 disabled:opacity-25 flex flex-col items-center"
                style={{ backgroundColor: LONG, color: BG, boxShadow: `0 0 26px ${LONG}38` }}>
                <span className="font-bold text-[16px] tracking-wide">ЛОНГ</span>
                <span className="text-[9px] opacity-70 leading-tight">{buyHint}</span>
              </button>
              <button disabled={notional < 1 && !(pos && pos.side === "long")} onClick={doSell}
                className="rounded-lg py-3 disabled:opacity-25 flex flex-col items-center"
                style={{ backgroundColor: SHORT, color: BG, boxShadow: `0 0 26px ${SHORT}38` }}>
                <span className="font-bold text-[16px] tracking-wide">ШОРТ</span>
                <span className="text-[9px] opacity-70 leading-tight">{sellHint}</span>
              </button>
              <button disabled={!pos} onClick={() => doClose(1, "позиция закрыта")}
                className="rounded-lg py-3 disabled:opacity-25 flex flex-col items-center"
                style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                <span className="font-bold text-[16px] tracking-wide">ЗАКРЫТЬ</span>
                <span className="text-[9px] leading-tight" style={{ color: pos ? pnlColor : FAINT }}>
                  {pos ? fmtSigned(pnl) : "нет позиции"}
                </span>
              </button>
            </div>
          </div>
        )}

        {toast && (
          <div className="absolute left-0 right-0 flex justify-center pointer-events-none" style={{ bottom: 150 }}>
            <div className="px-4 py-2 rounded-full text-[12px]"
              style={{ backgroundColor: RAISED, color: toast.color, border: `1px solid ${HAIR}` }}>
              {toast.text}
            </div>
          </div>
        )}

        <div className="grid grid-cols-5 border-t" style={{ borderColor: HAIR }}>
          {TAB_KEYS.map((key) => (
            <button key={key} onClick={() => setTab(key)} className="py-3 text-[11px]"
              style={{ color: tab === key ? TEXT : FAINT }}>
              {key}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================================ ВХОД (AUTH) ==============================
   Firebase Auth: email/пароль + гость (анонимный вход). Гостя достаточно,
   чтобы попробовать онлайн-комнату; email/пароль — чтобы баланс и история
   сессий не терялись при смене устройства (анонимный аккаунт Firebase
   привязан к конкретному браузеру и может быть очищен пользователем).
   ========================================================================== */
function AuthScreen({ onBack }) {
  const [mode, setMode] = useState("signin"); // 'signin' | 'signup'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resetSent, setResetSent] = useState(false);

  const friendlyError = (err) => {
    const code = err?.code || "";
    if (code.includes("wrong-password") || code.includes("invalid-credential")) return "неверный email или пароль";
    if (code.includes("user-not-found")) return "аккаунт с таким email не найден";
    if (code.includes("email-already-in-use")) return "этот email уже зарегистрирован";
    if (code.includes("weak-password")) return "пароль слишком короткий (минимум 6 символов)";
    if (code.includes("invalid-email")) return "неверный формат email";
    if (code.includes("network-request-failed")) return "нет соединения с сервером";
    return "что-то пошло не так, попробуйте ещё раз";
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      if (mode === "signup") {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        if (name.trim()) await updateProfile(cred.user, { displayName: name.trim() });
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      // Дальше подхватывает onAuthStateChanged в корневом компоненте.
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const guest = async () => {
    setError(""); setBusy(true);
    try {
      await signInAnonymously(auth);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async () => {
    if (!email) { setError("сначала введите email"); return; }
    setError(""); setBusy(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setResetSent(true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6">
        <button onClick={onBack} className="text-[12px] mb-8 text-left" style={{ color: DIM }}>← назад</button>

        <div className="text-[11px] tracking-[0.4em] mb-2" style={{ color: FAINT }}>ОНЛАЙН</div>
        <div className="text-[24px] leading-none tracking-tight mb-8">
          {mode === "signin" ? "Вход" : "Регистрация"}
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {mode === "signup" && (
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="имя (необязательно)"
              className="rounded-lg px-4 py-3 outline-none text-[14px]"
              style={{ backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }} />
          )}
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required
            autoComplete="email" placeholder="email"
            className="rounded-lg px-4 py-3 outline-none text-[14px]"
            style={{ backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }} />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required
            autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder="пароль"
            className="rounded-lg px-4 py-3 outline-none text-[14px]"
            style={{ backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }} />

          {error && <div className="text-[12px]" style={{ color: SHORT }}>{error}</div>}
          {resetSent && <div className="text-[12px]" style={{ color: LONG }}>письмо для сброса пароля отправлено</div>}

          <button type="submit" disabled={busy}
            className="rounded-lg py-3.5 text-[14px] font-semibold tracking-[0.1em] disabled:opacity-40"
            style={{ backgroundColor: TEXT, color: BG }}>
            {busy ? "подождите…" : mode === "signin" ? "ВОЙТИ" : "СОЗДАТЬ АККАУНТ"}
          </button>
        </form>

        <div className="flex items-center justify-between mt-4 text-[12px]" style={{ color: DIM }}>
          <button onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); }}>
            {mode === "signin" ? "нет аккаунта? зарегистрироваться" : "уже есть аккаунт? войти"}
          </button>
          {mode === "signin" && <button onClick={resetPassword}>забыли пароль?</button>}
        </div>

        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 h-px" style={{ backgroundColor: HAIR }} />
          <span className="text-[11px]" style={{ color: FAINT }}>или</span>
          <div className="flex-1 h-px" style={{ backgroundColor: HAIR }} />
        </div>

        <button onClick={guest} disabled={busy}
          className="w-full rounded-lg py-3.5 text-[14px] disabled:opacity-40"
          style={{ backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }}>
          Продолжить как гость
        </button>
        <div className="text-[11px] mt-3 leading-relaxed" style={{ color: FAINT }}>
          Гостевой доступ не привязан к email — если очистить данные браузера
          или сменить устройство, баланс и история сессий не восстановятся.
        </div>
      </div>
    </div>
  );
}

/* ============================= ВЫБОР РЕЖИМА ================================ */
function ModeSelect({ onPick }) {
  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6">
        <div className="text-[11px] tracking-[0.4em] mb-2" style={{ color: FAINT }}>ЗАКРЫТЫЙ РЫНОК</div>
        <div className="text-[28px] leading-none tracking-tight mb-10">Market Sandbox</div>

        <button onClick={() => onPick("online")}
          className="w-full rounded-lg py-5 px-5 text-left mb-3"
          style={{ backgroundColor: TEXT, color: BG }}>
          <div className="text-[16px] font-semibold tracking-[0.05em]">ОНЛАЙН</div>
          <div className="text-[12px] mt-1" style={{ color: "#555" }}>
            общая комната, до 100 живых игроков, требуется вход
          </div>
        </button>

        <button onClick={() => onPick("practice")}
          className="w-full rounded-lg py-5 px-5 text-left"
          style={{ backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }}>
          <div className="text-[16px] font-semibold tracking-[0.05em]">ПРАКТИКА</div>
          <div className="text-[12px] mt-1" style={{ color: FAINT }}>
            офлайн, только вы и 99 ботов, без входа
          </div>
        </button>
      </div>
    </div>
  );
}

/* ============================ ОНЛАЙН-РЕЖИМ ================================= */
function OnlineLobby({ user, profile, onNew, onSignOut, onExit }) {
  const st = profileStats(profile);
  const affordable = CONFIG.market.capitalOptions.some((c) => c <= profile.wallet);
  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex-1 overflow-y-auto px-6 pt-10 pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] tracking-[0.4em]" style={{ color: FAINT }}>ЗАКРЫТЫЙ РЫНОК · ОНЛАЙН</span>
          <button onClick={onExit} className="text-[11px]" style={{ color: DIM }}>сменить режим</button>
        </div>
        <div className="text-[28px] leading-none tracking-tight mb-1">Market Sandbox</div>
        <div className="text-[12px] mb-8" style={{ color: FAINT }}>
          {user.isAnonymous ? "гость" : (user.displayName || user.email)} ·{" "}
          <button onClick={onSignOut} style={{ color: DIM }}>выйти из аккаунта</button>
        </div>

        <div className="text-[11px] tracking-[0.15em] mb-2" style={{ color: FAINT }}>БАЛАНС</div>
        <div className="text-[44px] leading-none font-mono tracking-tight">{fmt(profile.wallet)}</div>
        <div className="text-[13px] font-mono mt-2"
          style={{ color: st.total > 0 ? LONG : st.total < 0 ? SHORT : DIM }}>
          {st.count === 0 ? "сессий ещё не было" : `${fmtSigned(st.total)} за ${st.count} сесс.`}
        </div>

        <div className="grid grid-cols-4 gap-3 mt-8">
          <Metric label="СЕССИЙ" value={String(st.count)} />
          <Metric label="ПРИБЫЛЬНЫХ" value={st.count ? `${st.wins}` : "—"} color={st.wins > 0 ? LONG : TEXT} />
          <Metric label="ЛУЧШАЯ" value={st.count ? fmtSigned(st.best, 0) : "—"} color={st.best > 0 ? LONG : TEXT} />
          <Metric label="ХУДШАЯ" value={st.count ? fmtSigned(st.worst, 0) : "—"} color={st.worst < 0 ? SHORT : TEXT} />
        </div>

        <div className="text-[11px] tracking-[0.15em] mt-10 mb-1" style={{ color: FAINT }}>ИСТОРИЯ</div>
        {profile.sessions.length === 0 ? (
          <Blank>здесь появятся результаты ваших сессий</Blank>
        ) : (
          profile.sessions.slice(0, 12).map((x, i) => (
            <div key={i} className="flex items-center justify-between py-2.5 border-b" style={{ borderColor: HAIR }}>
              <div className="min-w-0">
                <div className="text-[13px] font-mono">{fmt(x.capital, 0)} → {fmt(x.equity)}</div>
                <div className="text-[11px]" style={{ color: FAINT }}>
                  {clock(x.ticks * CONFIG.market.tickMs)} в рынке · место {x.rank} из {CONFIG.market.totalPlayers}
                </div>
              </div>
              <div className="text-[14px] font-mono" style={{ color: x.pnl >= 0 ? LONG : SHORT }}>
                {fmtSigned(x.pnl)}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="max-w-md w-full mx-auto px-6 pb-8 pt-3">
        {affordable ? (
          <button onClick={onNew} className="w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold"
            style={{ backgroundColor: TEXT, color: BG }}>
            НОВАЯ СЕССИЯ
          </button>
        ) : (
          <div className="text-[12px] text-center" style={{ color: FAINT }}>
            На балансе меньше минимального взноса. Пополнение баланса в
            онлайн-режиме делает сервер (см. README проекта) — здесь оно
            намеренно не реализовано, чтобы игрок не мог начислить себе деньги сам.
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectingScreen({ label }) {
  return (
    <div className="w-full h-screen flex items-center justify-center" style={{ backgroundColor: BG, color: FAINT }}>
      <span className="text-[12px]">{label}</span>
    </div>
  );
}

/**
 * Онлайн-игровой экран. Сознательно НЕ переиспользует JSX практики один
 * в один: тут нет управления скоростью/паузой (рынок общий на всех, задаёт
 * темп сервер) и нет вкладки «Отладка» (сервер и не отдаёт debug-данные
 * непривилегированным клиентам — см. createSnapshot в packages/engine).
 */
function OnlineGameScreen({ transport, session, onFinish }) {
  const [snapshot, setSnapshot] = useState(null);
  const [status, setStatus] = useState("connecting");
  const [tab, setTab] = useState("Рынок");
  const [timeframe, setTimeframe] = useState("1с");
  const [chartMode, setChartMode] = useState("свечи");
  const [showSettings, setShowSettings] = useState(false);
  const [size, setSize] = useState(String(Math.round(session * 0.3)));
  const [sheet, setSheet] = useState(null);
  const [limitPrice, setLimitPrice] = useState("");
  const [limitSide, setLimitSide] = useState("buy");
  const [playerFilter, setPlayerFilter] = useState("Все");
  const [toast, setToast] = useState(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const toastTimer = useRef(null);

  useEffect(() => {
    transport.onStatus = setStatus;
    transport.start((next) => setSnapshot(next));
    return () => transport.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const say = (text, color = TEXT) => {
    setToast({ text, color });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1700);
  };

  if (!snapshot) {
    return <ConnectingScreen label={status === "reconnecting" ? "переподключение…" : "подключение к комнате…"} />;
  }

  const state = snapshot;
  const human = snapshot.you;
  if (!human) {
    // Место в комнате ещё не подтверждено (гонка между WS hello и join) —
    // подождать следующего тика вместо падения на человеке === null.
    return <ConnectingScreen label="входим в комнату…" />;
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

  const buyHint = pos && pos.side === "short" ? "закроет Short" : "открыть / увеличить Long";
  const sellHint = pos && pos.side === "long" ? "закроет Long" : "открыть / увеличить Short";

  const doBuy = async () => {
    const res = await send({ type: "TRADE", action: "BUY", notional, reason: "ручная покупка" });
    if (res.ok) say(pos && pos.side === "short" ? "закрываем Short" : `покупка ${fmt(notional, 0)}`, LONG);
  };
  const doSell = async () => {
    const res = await send({ type: "TRADE", action: "SELL", notional, reason: "ручная продажа" });
    if (res.ok) say(pos && pos.side === "long" ? "закрываем Long" : `продажа ${fmt(notional, 0)}`, SHORT);
  };
  const doClose = async (fraction, label) => {
    const res = await send({ type: "TRADE", action: "CLOSE", fraction, reason: "ручное закрытие" });
    if (res.ok) say(label);
  };
  const setRisk = async (kind, delta) => {
    if (!pos) return;
    const long = pos.side === "long";
    const target = kind === "sl"
      ? (long ? pos.entryPrice * (1 - delta) : pos.entryPrice * (1 + delta))
      : (long ? pos.entryPrice * (1 + delta) : pos.entryPrice * (1 - delta));
    const res = await send({
      type: "PROTECT", stopLoss: kind === "sl" ? target : null, takeProfit: kind === "tp" ? target : null,
    });
    if (res.ok) say(`${kind === "sl" ? "стоп" : "тейк"} ${target.toFixed(2)}`);
  };

  const doFinish = async () => {
    setEnding(true);
    try { await onFinish(); } finally { setEnding(false); }
  };

  const TAB_KEYS = ["Рынок", "Позиции", "Ордера", "Участники"];
  const statusLabel = status === "online" ? "LIVE" : status === "reconnecting" ? "ПЕРЕПОДКЛЮЧЕНИЕ" : "ПОДКЛЮЧЕНИЕ";
  const statusColor = status === "online" ? TEXT : SHORT;

  return (
    <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md w-full mx-auto flex flex-col h-full relative">

        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-[11px] tracking-[0.3em]" style={{ color: FAINT }}>
            {CONFIG.market.assetSymbol} · {fmt(session, 0)}
          </span>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: statusColor }} />
              <span className="text-[11px] tracking-[0.15em]" style={{ color: status === "online" ? DIM : SHORT }}>
                {statusLabel}
              </span>
            </div>
            <button onClick={() => setShowSettings((v) => !v)}
              className="text-[11px] tracking-[0.15em]" style={{ color: showSettings ? TEXT : FAINT }}>
              ЕЩЁ
            </button>
          </div>
        </div>

        {showSettings && (
          <div className="px-5 pb-4 flex flex-col gap-3">
            {confirmingEnd ? (
              <div className="flex gap-2">
                <button onClick={() => setConfirmingEnd(false)} className="flex-1 rounded-lg py-3 text-[13px]"
                  style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                  Отмена
                </button>
                <button onClick={doFinish} disabled={ending} className="flex-1 rounded-lg py-3 text-[13px] font-semibold disabled:opacity-40"
                  style={{ backgroundColor: SHORT, color: BG }}>
                  {ending ? "завершаем…" : "Да, завершить"}
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmingEnd(true)} className="rounded-lg py-3 text-[13px]"
                style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                Завершить сессию · {fmt(equity)} на баланс
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">

          {tab === "Рынок" && (
            <>
              <div className="px-5 pt-1 flex items-end justify-between">
                <div>
                  <div className="text-[46px] leading-none font-mono tracking-tight">{fmt(state.price)}</div>
                  <div className="text-[14px] font-mono mt-1.5" style={{ color: changeAbs >= 0 ? LONG : SHORT }}>
                    {changeAbs >= 0 ? "+" : "−"}{Math.abs(changePct * 100).toFixed(2)}%
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] tracking-[0.15em]" style={{ color: DIM }}>{state.phase}</div>
                  <div className="text-[11px] font-mono mt-1" style={{ color: FAINT }}>
                    {stats.activePositions} / {CONFIG.market.totalPlayers} в рынке
                  </div>
                </div>
              </div>

              <div className="px-5 pt-4">
                <div className="h-1 w-full flex rounded-full overflow-hidden" style={{ backgroundColor: HAIR }}>
                  <div style={{ width: `${stats.longShare * 100}%`, backgroundColor: LONG }} />
                  <div style={{ width: `${stats.shortShare * 100}%`, backgroundColor: SHORT }} />
                </div>
              </div>

              <div className="px-5 pt-4 grid grid-cols-4 gap-3">
                <Metric label="LONG" value={fmt(stats.longExposure, 0)} color={LONG} />
                <Metric label="SHORT" value={fmt(stats.shortExposure, 0)} color={SHORT} />
                <Metric label="BUY PRESS" value={fmt(state.buyPressure, 0)} />
                <Metric label="SELL PRESS" value={fmt(state.sellPressure, 0)} />
              </div>

              <div className="flex items-center justify-between px-5 pt-5">
                <div className="flex gap-0.5">
                  {TIMEFRAMES.map((tf) => (
                    <Toggle key={tf.label} active={timeframe === tf.label} onClick={() => setTimeframe(tf.label)}>
                      {tf.label}
                    </Toggle>
                  ))}
                </div>
                <button onClick={() => setChartMode(chartMode === "свечи" ? "линия" : "свечи")}
                  className="text-[12px]" style={{ color: DIM }}>{chartMode}</button>
              </div>

              <div className="px-2 pt-1">
                <Chart state={state} timeframe={timeframe} mode={chartMode}
                  entryPrice={pos?.entryPrice} stopLoss={human.stopLoss} takeProfit={human.takeProfit} />
              </div>

              <div className="px-5 pb-4 grid grid-cols-4 gap-3">
                <Metric label="ЭКВИТИ" value={fmt(equity)} />
                <Metric label="СВОБОДНО" value={fmt(human.cash)} />
                <Metric label="ПОЗИЦИЯ"
                  value={pos ? `${pos.side === "long" ? "LONG" : "SHORT"} ${fmt(pos.margin, 0)}` : "—"}
                  color={pos ? (pos.side === "long" ? LONG : SHORT) : TEXT} />
                <Metric label="PNL" value={pos ? fmtSigned(pnl) : "—"} color={pnlColor} />
              </div>
            </>
          )}

          {tab === "Позиции" && (
            <div className="px-5 pt-2 pb-6">
              <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>ПОЗИЦИЯ</div>
              {pos ? (
                <>
                  <div className="flex items-baseline justify-between mb-4">
                    <span className="text-[26px]" style={{ color: pos.side === "long" ? LONG : SHORT }}>
                      {pos.side === "long" ? "LONG" : "SHORT"}
                    </span>
                    <span className="text-[20px] font-mono">{fmt(pos.margin)}</span>
                    <span className="text-[15px] font-mono" style={{ color: pnlColor }}>
                      {fmtSigned(pnl)} · {signedPct(pnlRatio)}
                    </span>
                  </div>
                  <Line left="Цена входа" right={fmt(pos.entryPrice)} />
                  <Line left="Текущая цена" right={fmt(state.price)} />
                  <Line left="Объём в единицах" right={pos.units.toFixed(4)} />
                  <Line left="При закрытии сейчас" right={fmt(pos.settlement)} />
                  <Line left="Стоп-лосс" right={human.stopLoss ? fmt(human.stopLoss) : "нет"} />
                  <Line left="Тейк-профит" right={human.takeProfit ? fmt(human.takeProfit) : "нет"} />
                  <div className="grid grid-cols-3 gap-2 mt-4">
                    {[[0.25, "25%"], [0.5, "50%"], [1, "всё"]].map(([f, l]) => (
                      <button key={l} onClick={() => doClose(f, `закрыто ${l}`)}
                        className="rounded-lg py-3 text-[13px]"
                        style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>{l}</button>
                    ))}
                  </div>
                </>
              ) : <Blank>Позиции нет</Blank>}

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>ИТОГИ</div>
              <Line left="Стартовый капитал" right={fmt(human.startingCapital)} />
              <Line left="Эквити" right={fmt(equity)} />
              <Line left="Всего заработано" right={fmtSigned(equity - human.startingCapital)}
                color={equity >= human.startingCapital ? LONG : SHORT} />
              <Line left="Реализованный PnL" right={fmtSigned(human.realizedPnL)}
                color={human.realizedPnL >= 0 ? LONG : SHORT} />
              <Line left="Место в рейтинге" right={snapshot.rank ? `${snapshot.rank} из ${snapshot.totalPlayers}` : "обновляется…"} />
            </div>
          )}

          {tab === "Ордера" && (
            <div className="px-5 pt-2 pb-6">
              <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>
                ЛИМИТНЫЕ ЗАЯВКИ · {myLimits.length}
              </div>
              {myLimits.length === 0 ? <Blank>активных заявок нет</Blank> :
                myLimits.map((o) => (
                  <div key={o.id} className="flex items-center justify-between py-3 border-b" style={{ borderColor: HAIR }}>
                    <div>
                      <div className="text-[13px]" style={{ color: o.side === "buy" ? LONG : SHORT }}>
                        {o.side === "buy" ? "покупка" : "продажа"} {fmt(o.notional, 0)}
                      </div>
                      <div className="text-[11px] font-mono" style={{ color: FAINT }}>
                        при цене {o.side === "buy" ? "≤" : "≥"} {o.limitPrice.toFixed(2)}
                      </div>
                    </div>
                    <button onClick={async () => { if ((await send({ type: "CANCEL_LIMIT", orderId: o.id })).ok) say("заявка снята"); }}
                      className="text-[12px]" style={{ color: DIM }}>снять</button>
                  </div>
                ))}

              <div className="text-[11px] tracking-[0.15em] mt-8 mb-3" style={{ color: FAINT }}>ЗАЩИТА ПОЗИЦИИ</div>
              {!pos ? <Blank>нужна открытая позиция</Blank> : (
                <>
                  <div className="flex items-center justify-between py-3 border-b" style={{ borderColor: HAIR }}>
                    <span className="text-[13px] font-mono">стоп {human.stopLoss ? fmt(human.stopLoss) : "—"}</span>
                    {human.stopLoss && (
                      <button onClick={() => send({ type: "PROTECT", clear: "sl", stopLoss: null, takeProfit: null })}
                        className="text-[12px]" style={{ color: DIM }}>убрать</button>
                    )}
                  </div>
                  <div className="flex items-center justify-between py-3">
                    <span className="text-[13px] font-mono">тейк {human.takeProfit ? fmt(human.takeProfit) : "—"}</span>
                    {human.takeProfit && (
                      <button onClick={() => send({ type: "PROTECT", clear: "tp", stopLoss: null, takeProfit: null })}
                        className="text-[12px]" style={{ color: DIM }}>убрать</button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "Участники" && (
            <div className="px-5 pt-2 pb-6">
              <div className="grid grid-cols-3 gap-3 mb-5">
                <Metric label="В ЛОНГЕ" value={String(stats.longPlayers)} color={LONG} />
                <Metric label="В ШОРТЕ" value={String(stats.shortPlayers)} color={SHORT} />
                <Metric label="ВНЕ РЫНКА" value={String(stats.flatPlayers)} />
              </div>
              {!snapshot.players ? (
                <Blank>список участников обновляется раз в секунду…</Blank>
              ) : (
                <>
                  <div className="flex gap-0.5 mb-2 flex-wrap">
                    {["Все", "Лонг", "Шорт", "Вне рынка", "Топ-15"].map((f) => (
                      <Toggle key={f} active={playerFilter === f} onClick={() => setPlayerFilter(f)}>{f}</Toggle>
                    ))}
                  </div>
                  {(() => {
                    let list = [...snapshot.players];
                    if (playerFilter === "Лонг") list = list.filter((p) => p.position?.side === "long");
                    if (playerFilter === "Шорт") list = list.filter((p) => p.position?.side === "short");
                    if (playerFilter === "Вне рынка") list = list.filter((p) => !p.position);
                    list.sort((a, b) => b.equity - a.equity);
                    if (playerFilter === "Топ-15") list = list.slice(0, 15);
                    if (list.length === 0) return <Blank>пусто</Blank>;
                    return list.map((p, i) => {
                      const eq = p.equity;
                      const delta = eq - p.startingCapital;
                      return (
                        <div key={p.id} className="flex items-center gap-3 py-2.5 border-b" style={{ borderColor: HAIR }}>
                          <span className="text-[11px] font-mono w-6 shrink-0" style={{ color: FAINT }}>{i + 1}</span>
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] truncate" style={{ color: p.isHuman ? TEXT : DIM }}>
                              {p.name}
                              {p.position && (
                                <span className="ml-2 text-[11px] font-mono"
                                  style={{ color: p.position.side === "long" ? LONG : SHORT }}>
                                  {p.position.side === "long" ? "long" : "short"} {fmt(p.position.margin, 0)}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] truncate" style={{ color: FAINT }}>
                              {p.isHuman ? "живой игрок" : STRATEGY_LABELS[p.archetype]} · сделок {p.tradeCount}
                            </div>
                          </div>
                          <div className="text-right whitespace-nowrap">
                            <div className="text-[13px] font-mono">{fmt(eq)}</div>
                            <div className="text-[11px] font-mono" style={{ color: delta >= 0 ? LONG : SHORT }}>
                              {fmtSigned(delta)}
                            </div>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </>
              )}
            </div>
          )}
        </div>

        {tab === "Рынок" && (
          <div className="px-4 pt-3 pb-3 border-t" style={{ borderColor: HAIR, backgroundColor: BG }}>
            {sheet && (
              <>
                <div className="fixed inset-0 z-10" style={{ backgroundColor: "rgba(0,0,0,0.75)" }}
                  onClick={() => setSheet(null)} />
                <div className="relative z-20 mb-3 rounded-lg p-3"
                  style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-[12px]">{sheet === "risk" ? "Стоп и тейк" : "Лимитная заявка"}</span>
                    <button onClick={() => setSheet(null)} className="text-[11px]" style={{ color: DIM }}>закрыть</button>
                  </div>
                  {sheet === "risk" ? (
                    <div className="flex flex-col gap-2">
                      {[["sl", "СТОП", [0.01, 0.02, 0.05], "−"], ["tp", "ТЕЙК", [0.01, 0.03, 0.06], "+"]].map(
                        ([kind, label, steps, sign]) => (
                          <div key={kind} className="flex items-center gap-2">
                            <span className="text-[10px] w-10 shrink-0" style={{ color: FAINT }}>{label}</span>
                            {steps.map((d) => (
                              <button key={d} disabled={!pos} onClick={() => setRisk(kind, d)}
                                className="flex-1 py-2.5 rounded text-[12px] font-mono disabled:opacity-25"
                                style={{ backgroundColor: RAISED }}>
                                {sign}{(d * 100).toFixed(0)}%
                              </button>
                            ))}
                            <span className="w-14 text-right text-[12px] font-mono" style={{ color: DIM }}>
                              {kind === "sl"
                                ? (human.stopLoss ? human.stopLoss.toFixed(2) : "—")
                                : (human.takeProfit ? human.takeProfit.toFixed(2) : "—")}
                            </span>
                          </div>
                        )
                      )}
                      {!pos && <div className="text-[11px]" style={{ color: FAINT }}>
                        Уровни считаются от цены входа — сначала откройте позицию.
                      </div>}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button onClick={() => setLimitSide(limitSide === "buy" ? "sell" : "buy")}
                        className="px-3 py-2.5 rounded text-[12px] font-semibold whitespace-nowrap"
                        style={{ backgroundColor: limitSide === "buy" ? LONG : SHORT, color: BG }}>
                        {limitSide === "buy" ? "LONG" : "SHORT"}
                      </button>
                      <input value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} inputMode="decimal"
                        placeholder={`цена · сейчас ${state.price.toFixed(2)}`}
                        className="flex-1 min-w-0 rounded px-3 py-2.5 outline-none font-mono text-[13px]"
                        style={{ backgroundColor: RAISED, color: TEXT }} />
                      <button
                        onClick={async () => {
                          const res = await send({ type: "LIMIT", side: limitSide, notional, limitPrice: Number(limitPrice) });
                          if (res.ok) { setLimitPrice(""); setSheet(null); say("заявка выставлена"); }
                        }}
                        className="px-4 py-2.5 rounded text-[12px] font-semibold"
                        style={{ backgroundColor: TEXT, color: BG }}>ОК</button>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="flex items-center gap-1.5 mb-2.5">
              <div className="flex-1 flex items-center rounded px-3 py-2 min-w-0" style={{ backgroundColor: SURFACE }}>
                <span className="font-mono text-[13px] mr-1.5" style={{ color: FAINT }}>$</span>
                <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal"
                  className="w-full bg-transparent outline-none font-mono text-[15px] min-w-0" style={{ color: TEXT }} />
              </div>
              {[0.25, 0.5, 1].map((f) => (
                <button key={f} onClick={() => setSize(String(Math.round(human.cash * f)))}
                  className="px-2.5 py-2.5 rounded font-mono text-[11px]" style={{ backgroundColor: SURFACE, color: DIM }}>
                  {f * 100}%
                </button>
              ))}
              <button onClick={() => setSheet(sheet === "risk" ? null : "risk")}
                className="px-2.5 py-2.5 rounded text-[11px]"
                style={{ backgroundColor: sheet === "risk" ? TEXT : SURFACE, color: sheet === "risk" ? BG : DIM }}>
                SL/TP
              </button>
              <button onClick={() => setSheet(sheet === "limit" ? null : "limit")}
                className="px-2.5 py-2.5 rounded text-[11px]"
                style={{ backgroundColor: sheet === "limit" ? TEXT : SURFACE, color: sheet === "limit" ? BG : DIM }}>
                лимит{myLimits.length ? ` ${myLimits.length}` : ""}
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button disabled={notional < 1 && !(pos && pos.side === "short")} onClick={doBuy}
                className="rounded-lg py-3 disabled:opacity-25 flex flex-col items-center"
                style={{ backgroundColor: LONG, color: BG, boxShadow: `0 0 26px ${LONG}38` }}>
                <span className="font-bold text-[16px] tracking-wide">ЛОНГ</span>
                <span className="text-[9px] opacity-70 leading-tight">{buyHint}</span>
              </button>
              <button disabled={notional < 1 && !(pos && pos.side === "long")} onClick={doSell}
                className="rounded-lg py-3 disabled:opacity-25 flex flex-col items-center"
                style={{ backgroundColor: SHORT, color: BG, boxShadow: `0 0 26px ${SHORT}38` }}>
                <span className="font-bold text-[16px] tracking-wide">ШОРТ</span>
                <span className="text-[9px] opacity-70 leading-tight">{sellHint}</span>
              </button>
              <button disabled={!pos} onClick={() => doClose(1, "позиция закрыта")}
                className="rounded-lg py-3 disabled:opacity-25 flex flex-col items-center"
                style={{ backgroundColor: SURFACE, border: `1px solid ${HAIR}` }}>
                <span className="font-bold text-[16px] tracking-wide">ЗАКРЫТЬ</span>
                <span className="text-[9px] leading-tight" style={{ color: pos ? pnlColor : FAINT }}>
                  {pos ? fmtSigned(pnl) : "нет позиции"}
                </span>
              </button>
            </div>
          </div>
        )}

        {toast && (
          <div className="absolute left-0 right-0 flex justify-center pointer-events-none" style={{ bottom: 150 }}>
            <div className="px-4 py-2 rounded-full text-[12px]"
              style={{ backgroundColor: RAISED, color: toast.color, border: `1px solid ${HAIR}` }}>
              {toast.text}
            </div>
          </div>
        )}

        <div className="grid grid-cols-4 border-t" style={{ borderColor: HAIR }}>
          {TAB_KEYS.map((key) => (
            <button key={key} onClick={() => setTab(key)} className="py-3 text-[11px]"
              style={{ color: tab === key ? TEXT : FAINT }}>
              {key}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Обёртка онлайн-режима: слушает Firebase Auth + Firestore-профиль,
 * вызывает /api/joinRoom и /api/closeSession на сервисе Cloud Run, поднимает RemoteTransport.
 */
function OnlineApp({ user, onExit }) {
  const [profile, setProfile] = useState(null);
  const [screen, setScreen] = useState("lobby"); // lobby | setup | game | result
  const [result, setResult] = useState(null);
  const [session, setSession] = useState(null); // { capital, roomId, playerId }
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
          sessions: [], // подробная история подтягивается отдельно, см. README → «Что дальше»
        });
      } else {
        // Профиль ещё не создан на сервере — joinRoom создаст его при первом входе.
        setProfile({ wallet: 25000, stats: { sessions: 0, wins: 0, totalPnL: 0, best: 0, worst: 0 }, sessions: [] });
      }
    });
    return unsub;
  }, [user.uid]);

  const startSession = async (capital) => {
    setJoining(true); setJoinError("");
    try {
      const res = await callRoomService("/api/joinRoom", { method: "POST", body: { capital } });
      if (!res.ok) throw new Error(res.reason || "не удалось войти в комнату");
      transportRef.current = new RemoteTransport({ roomId: res.roomId, playerId: res.playerId });
      setSession({ capital, roomId: res.roomId, playerId: res.playerId });
      setScreen("game");
    } catch (err) {
      setJoinError(err.message || "не удалось войти в комнату");
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

  if (!profile) return <ConnectingScreen label="загрузка профиля…" />;

  if (screen === "lobby") {
    return <OnlineLobby user={user} profile={profile} onSignOut={handleSignOut} onExit={onExit}
      onNew={() => setScreen("setup")} />;
  }
  if (screen === "setup") {
    return (
      <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
        <div className="max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6">
          <button onClick={() => setScreen("lobby")} className="text-[12px] mb-8 text-left" style={{ color: DIM }}>← назад</button>
          <div className="text-[11px] tracking-[0.15em] mb-3" style={{ color: FAINT }}>ВЗНОС В СЕССИЮ</div>
          <div className="grid grid-cols-2 gap-2">
            {CONFIG.market.capitalOptions.map((value) => {
              const locked = value > profile.wallet;
              return (
                <button key={value} disabled={locked || joining} onClick={() => startSession(value)}
                  className="rounded-lg py-5 text-left px-4 transition disabled:opacity-25"
                  style={{ backgroundColor: SURFACE, color: TEXT, border: `1px solid ${HAIR}` }}>
                  <div className="text-[22px] font-mono">${value.toLocaleString("en-US")}</div>
                  <div className="text-[11px] mt-1" style={{ color: FAINT }}>
                    {locked ? "не хватает баланса" : `рынок $${(value * CONFIG.market.totalPlayers).toLocaleString("en-US")}`}
                  </div>
                </button>
              );
            })}
          </div>
          {joining && <div className="text-[12px] mt-4" style={{ color: DIM }}>ищем свободную комнату…</div>}
          {joinError && <div className="text-[12px] mt-4" style={{ color: SHORT }}>{joinError}</div>}
          <div className="text-[12px] mt-5 leading-relaxed" style={{ color: FAINT }}>
            Комната общая: рядом с вами могут оказаться другие живые игроки
            и боты, добирающие место до 100 участников. Взнос списывается
            сразу и возвращается (с учётом результата) при завершении сессии.
          </div>
        </div>
      </div>
    );
  }
  if (screen === "result" && result) {
    return (
      <div className="w-full h-screen flex flex-col" style={{ backgroundColor: BG, color: TEXT }}>
        <div className="max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6">
          <div className="text-[11px] tracking-[0.4em] mb-3" style={{ color: FAINT }}>СЕССИЯ ЗАВЕРШЕНА</div>
          <div className="text-[52px] leading-none font-mono tracking-tight"
            style={{ color: result.pnl >= 0 ? LONG : SHORT }}>
            {fmtSigned(result.pnl)}
          </div>
          <div className="text-[15px] font-mono mt-2" style={{ color: DIM }}>
            {((result.pnl / result.capital) * 100).toFixed(2)}% от взноса
          </div>
          <div className="mt-10">
            <Line left="Взнос" right={fmt(result.capital)} />
            <Line left="Итоговый капитал" right={fmt(result.equity)} />
            <Line left="Место в рейтинге" right={`${result.rank} из ${CONFIG.market.totalPlayers}`} />
            <Line left="Сделок" right={String(result.trades)} />
            <Line left="Время в рынке" right={clock(result.ticks * CONFIG.market.tickMs)} />
            <Line left="Цена на выходе" right={fmt(result.price)} />
          </div>
        </div>
        <div className="max-w-md w-full mx-auto px-6 pb-8">
          <button onClick={() => { setResult(null); setScreen("lobby"); }}
            className="w-full rounded-lg py-4 text-[15px] tracking-[0.15em] font-semibold"
            style={{ backgroundColor: TEXT, color: BG }}>
            В ЛОББИ
          </button>
        </div>
      </div>
    );
  }
  if (screen === "game" && session && transportRef.current) {
    return <OnlineGameScreen key={session.roomId} transport={transportRef.current}
      session={session.capital} onFinish={finishSession} />;
  }
  return <ConnectingScreen label="загрузка…" />;
}

/* ================================ КОРЕНЬ ==================================== */
export default function MarketSandboxRoot() {
  const [mode, setMode] = useState(null); // null | 'practice' | 'online'
  const [authUser, setAuthUser] = useState(undefined); // undefined = ещё проверяем сессию
  const [firebaseError, setFirebaseError] = useState("");

  useEffect(() => {
    if (mode !== "online") return undefined;
    try {
      const { auth: a } = ensureFirebase();
      return onAuthStateChanged(a, setAuthUser);
    } catch (err) {
      setFirebaseError(err.message);
      return undefined;
    }
  }, [mode]);

  if (mode === null) return <ModeSelect onPick={setMode} />;
  if (mode === "practice") return <PracticeApp onExit={() => setMode(null)} />;

  // mode === 'online'
  if (firebaseError) {
    return (
      <div className="w-full h-screen flex flex-col items-center justify-center px-8 text-center gap-4"
        style={{ backgroundColor: BG, color: TEXT }}>
        <div className="text-[13px]" style={{ color: SHORT }}>{firebaseError}</div>
        <button onClick={() => setMode(null)} className="text-[12px]" style={{ color: DIM }}>← назад</button>
      </div>
    );
  }
  if (authUser === undefined) return <ConnectingScreen label="проверяем вход…" />;
  if (!authUser) return <AuthScreen onBack={() => setMode(null)} />;
  return <OnlineApp key={authUser.uid} user={authUser} onExit={() => setMode(null)} />;
}

import React, { useEffect, useMemo, useState } from "react";
import { CONFIG } from "../core/config.js";
import { clamp, mulberry32 } from "../core/engine.js";
import { sanitizeMoneyInput, parseMoneyInput } from "../core/money.js";
import { FREE_MARKET } from "./market.js";
import { ACTIVE_LANG, tr, periodLabel, clock, signedPct } from "../i18n/index.js";
import { BG, RAISED, HAIR, TEXT, DIM, FAINT, LONG, SHORT, GOLD, ACCENT, CARD, CARD_SOFT, CARD_BG, CARD_BG_SOFT, btnSoft, fmt, fmtSigned, shade } from "../ui/theme.js";
import { BackButton, Line, niceStep } from "../ui/components.js";
import { profileStats } from "../storage/profile.js";
import { stagger } from "../ui/styles.js";
import { Icon, RoundButton, WalletAction } from "../ui/icons.js";
import { Logo } from "./auth.js";

const LOBBY_RANGES = [
  { key: "СЕГОДНЯ", ms: 24 * 3600e3 },
  { key: "НЕДЕЛЯ", ms: 7 * 24 * 3600e3 },
  { key: "ВСЁ ВРЕМЯ", ms: Infinity },
];

/**
 * Кривая накопленного результата. Строится из истории сессий: точка ставится
 * после каждой закрытой сессии, значение — сумма PnL к этому моменту.
 * Это НЕ котировка и не симуляция — только фактические результаты игрока.
 */
function EquityCurve({ sessions, rangeMs }) {
  const W = 320, H = 128, PADR = 52, PADB = 18, PADT = 8;
  const now = Date.now();
  const list = [...sessions]
    .filter((x) => Number.isFinite(x.at) && now - x.at <= rangeMs)
    .sort((a, b) => a.at - b.at);

  if (list.length === 0) {
    return (
      <div className="flex items-center justify-center text-[12px] tx-fade"
        style={{ height: 64, color: FAINT }}>
        {ACTIVE_LANG === "en" ? "no closed sessions in this period" : "закрытых сессий за этот период нет"}
      </div>
    );
  }

  let acc = 0;
  const pts = list.map((x) => { acc += x.pnl; return { t: x.at, v: acc }; });
  pts.unshift({ t: pts[0].t - 1, v: 0 });

  const vs = pts.map((p) => p.v);
  const rawMax = Math.max(...vs, 0), rawMin = Math.min(...vs, 0);
  const pad = Math.max((rawMax - rawMin) * 0.2, 1);
  const max = rawMax + pad, min = rawMin - pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const spanT = Math.max(1, t1 - t0);

  const x = (t) => ((t - t0) / spanT) * (W - PADR);
  const y = (v) => PADT + (H - PADB - PADT) * (1 - (v - min) / (max - min));
  const zeroY = y(0);
  const up = acc >= 0;

  /* Плавная линия вместо ломаной: кубический сплайн Catmull-Rom, у которого
     контрольные точки берутся из соседей. Форма проходит ровно через все
     точки, поэтому цифры не искажаются. */
  const path = (() => {
    const P = pts.map((p) => [x(p.t), y(p.v)]);
    if (P.length < 2) return "";
    let d = `M ${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || P[i + 1];
      /* Контрольные точки ограничиваются отрезком между соседями: без этого
         сплайн выбрасывало за пределы данных, и на плоском участке кривая
         задиралась горбом. */
      const lim = (v, a, b) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = lim(p1[1] + (p2[1] - p0[1]) / 6, p1[1], p2[1]);
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = lim(p2[1] - (p3[1] - p1[1]) / 6, p1[1], p2[1]);
      d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)}` +
           ` ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  })();
  const area = `${path} L ${x(t1).toFixed(1)},${zeroY.toFixed(1)}` +
               ` L ${x(t0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  // Сетка по «круглым» уровням, ноль всегда есть и никогда не дублируется.
  const step = niceStep((max - min) / 3.2);
  const levels = [0];
  for (let v = step; v <= max; v += step) levels.push(v);
  for (let v = -step; v >= min; v -= step) levels.push(v);
  // Ноль подписывается отдельно, поэтому близкие к нему уровни убираем —
  // иначе «+$0» и соседняя подпись наезжали друг на друга.
  const gap = (max - min) * 0.14;
  const shown = levels.filter((v) => v > min + (max - min) * 0.05
    && v < max - (max - min) * 0.03 && Math.abs(v) > gap);

  const hhmm = (t) => new Date(t).toLocaleTimeString(ACTIVE_LANG === "en" ? "en-US" : "ru-RU",
    { hour: "2-digit", minute: "2-digit" });
  const uid = `eq${Math.round(min)}_${Math.round(max)}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 128 }}>
      <defs>
        {/* Заливка над нулём светло-серая, под нулём красная — одна и та же
            фигура рисуется дважды под разными обрезками. Зелёной верхняя
            часть была раньше: на весь экран получалось сплошное свечение,
            а знак результата и так виден по цифре над графиком. */}
        <linearGradient id={`${uid}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.26" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id={`${uid}r`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={SHORT} stopOpacity="0.34" />
          <stop offset="100%" stopColor={SHORT} stopOpacity="0.02" />
        </linearGradient>
        <clipPath id={`${uid}up`}>
          <rect x="0" y="0" width={W - PADR} height={Math.max(0, zeroY)} />
        </clipPath>
        <clipPath id={`${uid}dn`}>
          <rect x="0" y={zeroY} width={W - PADR} height={Math.max(0, H - zeroY)} />
        </clipPath>
      </defs>

      {shown.map((v) => (
        <g key={v}>
          <line x1={0} x2={W - PADR} y1={y(v)} y2={y(v)}
            stroke={HAIR} strokeWidth={0.7} strokeDasharray="2 4" />
          <text x={W - PADR + 7} y={y(v) + 3.2} fill={FAINT} fontSize={8.5}
            fontFamily="RodchenkoDigits, Neogurotesuku, monospace">{fmtSigned(v, 0)}</text>
        </g>
      ))}

      {/* нулевая линия — опора для взгляда */}
      <line x1={0} x2={W - PADR} y1={zeroY} y2={zeroY} stroke={DIM} strokeWidth={0.9} />
      <text x={W - PADR + 7} y={zeroY + 3.2} fill={DIM} fontSize={8.5}
        fontFamily="RodchenkoDigits, Neogurotesuku, monospace">$0</text>

      <g className="tx-fade">
        <path d={area} fill={`url(#${uid}g)`} clipPath={`url(#${uid}up)`} />
        <path d={area} fill={`url(#${uid}r)`} clipPath={`url(#${uid}dn)`} />
      </g>

      <path d={path} fill="none" stroke={ACCENT} strokeWidth={1.8} strokeLinecap="round"
        strokeLinejoin="round" clipPath={`url(#${uid}up)`} className="tx-line"
        style={{ "--len": W * 2 }} />
      <path d={path} fill="none" stroke={SHORT} strokeWidth={1.8} strokeLinecap="round"
        strokeLinejoin="round" clipPath={`url(#${uid}dn)`} className="tx-line"
        style={{ "--len": W * 2 }} />

      {/* Гало без анимации: CSS-transform у SVG-элемента считается от начала
          координат картинки, а не от центра круга, поэтому пульсация уводила
          кружок в сторону — он «летал» по карточке. */}
      <circle cx={x(t1)} cy={y(acc)} r={5.5} fill={up ? ACCENT : SHORT} opacity={0.16} />
      <circle cx={x(t1)} cy={y(acc)} r={2.8} fill={up ? ACCENT : SHORT} />

      <text x={0} y={H - 4} fill={FAINT} fontSize={8.5} fontFamily="RodchenkoDigits, Neogurotesuku, monospace">{hhmm(t0)}</text>
      <text x={x(t1)} y={H - 4} fill={FAINT} fontSize={8.5} fontFamily="RodchenkoDigits, Neogurotesuku, monospace"
        textAnchor="end">{hhmm(t1)}</text>
    </svg>
  );
}

/* ------------------------------ СТАТИСТИКА -------------------------------
   Разбор всех закрытых сессий. Данные берутся только из profile.sessions,
   ничего не пересчитывается по рынку.
   ------------------------------------------------------------------------ */
function ProfileScreen({ profile, account, onClose, onSettings }) {
  const list = profile.sessions;
  const n = list.length;

  const sum = (f) => list.reduce((a, x) => a + f(x), 0);
  const wins = list.filter((x) => x.pnl > 0).length;
  const total = sum((x) => x.pnl);
  const invested = sum((x) => x.capital);
  const roi = invested ? total / invested : 0;
  const avg = n ? total / n : 0;
  const avgRank = n ? sum((x) => x.rank) / n : 0;
  const bestRank = n ? Math.min(...list.map((x) => x.rank)) : 0;
  const trades = sum((x) => x.trades);
  // Суммарный заработок и убыток по отдельности: сумма всех плюсовых
  // сессий и сумма всех минусовых. total — их разность.
  const grossWin = list.filter((x) => x.pnl > 0).reduce((a, x) => a + x.pnl, 0);
  const grossLoss = list.filter((x) => x.pnl < 0).reduce((a, x) => a + x.pnl, 0);
  const avgTime = n ? sum((x) => x.ticks) * CONFIG.market.tickMs / n : 0;

  // Распределение по процентилям. Размер комнаты теперь выбирается игроком,
  // поэтому абсолютное место (например 40-е) нельзя сравнивать между 100 и 500.
  const buckets = [0, 0, 0, 0, 0];
  list.forEach((x) => {
    const totalPlayers = Math.max(1, x.totalPlayers || CONFIG.market.totalPlayers);
    const b = Math.min(4, Math.max(0, Math.floor(((x.rank - 1) / totalPlayers) * 5)));
    buckets[b]++;
  });
  const maxB = Math.max(1, ...buckets);

  const card = CARD;
  const Cell = ({ label, value, color = TEXT }) => (
    <div className="min-w-0">
      <div className="text-[9px] tracking-[0.10em] mb-1.5 truncate" style={{ color: FAINT }}>
        {label}
      </div>
      <div className="text-[17px] font-mono truncate" style={{ color }}>{value}</div>
    </div>
  );

  return (
    <div className="w-full flex flex-col tx-sheet"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md tx-profile-wrap w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pb-6 ui-safe-top ui-scroll-pad">

        <div className="flex items-center justify-between">
          <BackButton onClick={onClose} />
          <div className="text-[10px] tracking-[0.11em]" style={{ color: DIM }}>{tr("ПРОФИЛЬ")}</div>
          <button onClick={onSettings}
            className="w-11 h-11 rounded-xl flex items-center justify-center tap"
            style={{ backgroundColor: RAISED, border: `1px solid ${HAIR}` }}>
            <Icon name="gear" size={16} color={TEXT} />
          </button>
        </div>

        <div className="flex items-center gap-3 mt-5">
          <div className="w-12 h-12 rounded-full flex items-center justify-center shrink-0"
            style={{ backgroundColor: RAISED, border: `1px solid ${HAIR}` }}>
            <Icon name="user" size={22} color={DIM} />
          </div>
          <div className="min-w-0">
            <div className="text-[15px] truncate">{account?.email || tr("гость")}</div>
            <div className="text-[11px] mt-0.5" style={{ color: FAINT }}>
              {ACTIVE_LANG === "en" ? `level ${profileProgress(profile).level} · balance ${fmt(profile.wallet, 0)}` : `уровень ${profileProgress(profile).level} · баланс ${fmt(profile.wallet, 0)}`}
            </div>
          </div>
        </div>

        {n === 0 ? (
          <div className="rounded-2xl py-12 text-center text-[12px] mt-6"
            style={{ ...card, color: FAINT }}>
            {ACTIVE_LANG === "en" ? "nothing to analyze yet — finish your first session" : "пока нечего разбирать — проведите первую сессию"}
          </div>
        ) : (
          <>
            <div className="mt-5 tx-in" style={stagger(0)}>
              <div className="text-[40px] leading-none font-mono tracking-tight"
                style={{ color: total > 0 ? LONG : total < 0 ? SHORT : TEXT }}>
                {fmtSigned(total)}
              </div>
              <div className="text-[12px] mt-2" style={{ color: DIM }}>
                {ACTIVE_LANG === "en" ? `across ${n} ${n === 1 ? "session" : "sessions"} · return ${signedPct(roi)}` : `за ${n} ${n === 1 ? "сессию" : "сессий"} · доходность ${signedPct(roi)}`}
              </div>
            </div>

            <div className="rounded-2xl px-4 py-4 mt-5 grid grid-cols-3 gap-y-5 gap-x-3 tx-in"
              style={{ ...card, ...stagger(1) }}>
              <Cell label={tr("СЕССИЙ")} value={String(n)} />
              <Cell label={tr("ПРИБЫЛЬНЫХ")} value={String(wins)} />
              <Cell label={tr("ВИНРЕЙТ")} value={`${Math.round((wins / n) * 100)}%`} />
              <Cell label={tr("СРЕДНЯЯ")} value={fmtSigned(avg)}
                color={avg < 0 ? SHORT : TEXT} />
              <Cell label={tr("ЛУЧШАЯ")} value={fmtSigned(Math.max(...list.map((x) => x.pnl)))}
                color={LONG} />
              <Cell label={tr("ХУДШАЯ")} value={fmtSigned(Math.min(...list.map((x) => x.pnl)))}
                color={SHORT} />
              <Cell label={tr("СРЕД. МЕСТО")} value={avgRank.toFixed(1)} />
              <Cell label={tr("ЛУЧШЕЕ МЕСТО")} value={String(bestRank)} />
              <Cell label={tr("ВСЕГО СДЕЛОК")} value={String(trades)} />
              <Cell label={tr("СРЕД. ВРЕМЯ")} value={clock(avgTime)} />
              <Cell label={tr("ВЗНОСОВ")} value={fmt(invested, 0)} />
              <Cell label={tr("СДЕЛОК/СЕССИЯ")} value={(trades / n).toFixed(1)} />
              <Cell label={tr("ЗАРАБОТАНО")} value={fmtSigned(grossWin, 0)}
                color={grossWin > 0 ? LONG : TEXT} />
              <Cell label={tr("ПОТЕРЯНО")} value={fmtSigned(grossLoss, 0)}
                color={grossLoss < 0 ? SHORT : TEXT} />
            </div>

            <div className="text-[10px] tracking-[0.11em] mt-7 mb-2.5" style={{ color: FAINT }}>
              {tr("РАСПРЕДЕЛЕНИЕ МЕСТ")}
            </div>
            <div className="rounded-2xl px-4 py-4 tx-in" style={{ ...card, ...stagger(2) }}>
              {buckets.map((b, i) => (
                <div key={i} className="flex items-center gap-3 py-1.5">
                  <span className="text-[10px] font-mono w-[52px] shrink-0" style={{ color: FAINT }}>
                    {i * 20 + 1}–{(i + 1) * 20}%
                  </span>
                  <div className="flex-1 h-1.5 rounded-full overflow-hidden"
                    style={{ backgroundColor: HAIR }}>
                    <div style={{ width: `${(b / maxB) * 100}%`, height: "100%",
                      backgroundColor: i === 0 ? ACCENT : i === 4 ? SHORT : DIM,
                      transition: "width var(--tx-slow) var(--tx-ease)" }} />
                  </div>
                  <span className="text-[11px] font-mono w-5 text-right" style={{ color: DIM }}>{b}</span>
                </div>
              ))}
            </div>

            <div className="text-[10px] tracking-[0.11em] mt-7 mb-2.5" style={{ color: FAINT }}>
              {tr("ВСЕ СЕССИИ")}
            </div>
            <div className="flex flex-col gap-2">
              {list.map((x, i) => (
                <div key={i}
                  className="rounded-2xl px-4 py-3 flex items-center justify-between gap-3 tx-in"
                  style={{ ...card, ...stagger(3 + Math.min(i, 8)) }}>
                  <div className="min-w-0">
                    <div className="text-[14px] font-mono truncate">
                      {fmt(x.capital, 0)} → {fmt(x.equity)}
                    </div>
                    <div className="text-[11px] mt-1 truncate" style={{ color: FAINT }}>
                      {ACTIVE_LANG === "en" ? `${clock(x.ticks * CONFIG.market.tickMs)} · ${x.trades} trades · rank ${x.rank} of ${x.totalPlayers || CONFIG.market.totalPlayers}` : `${clock(x.ticks * CONFIG.market.tickMs)} · ${x.trades} сделок · место ${x.rank} из ${x.totalPlayers || CONFIG.market.totalPlayers}`}
                    </div>
                  </div>
                  <span className="text-[14px] font-mono shrink-0"
                    style={{ color: x.pnl >= 0 ? LONG : SHORT }}>{fmtSigned(x.pnl)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Карточка выбора режима. */
function ModeCard({ kind, title, text, cta, primary, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="tx-mode-card w-full rounded-[12px] px-4 py-3.5 text-left tap disabled:opacity-35 flex items-center gap-3"
      style={CARD}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-[12px] font-semibold truncate">{title}</div>
          {primary && <span className="tx-mode-badge text-[8px] px-1.5 py-0.5 rounded-full ui-chip shrink-0">MAIN</span>}
        </div>
        <div className="text-[11px] leading-snug mt-1 line-clamp-2" style={{ color: DIM }}>{text}</div>
        <div className="text-[9px] mt-1.5 tracking-[0.08em]" style={{ color: FAINT }}>{cta}</div>
      </div>
      <Icon name="chevron" size={15} color={FAINT} />
    </button>
  );
}

function FreeMarketMiniCard({ onClick }) {
  const fm = FREE_MARKET;
  return (
    <button onClick={onClick} className="tx-free-card w-full rounded-[12px] p-4 text-left tap" style={CARD}>
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-[0.12em]" style={{ color: FAINT }}>{tr("СВОБОДНЫЙ РЫНОК")}</span>
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: LONG }} />
          </div>
          <div className="tx-free-title text-[19px] leading-tight mt-2">{tr("Всегда открыт")}</div>
          <div className="text-[11px] leading-snug mt-1.5" style={{ color: DIM }}>
            {ACTIVE_LANG === "en" ? `${fm.botCount.toLocaleString("en-US")} autonomous participants · entry ${fmt(fm.minCapital,0)}–${fmt(fm.maxCapital,0)}` : `${fm.botCount.toLocaleString("ru-RU")} автономных участников · вход ${fmt(fm.minCapital,0)}–${fmt(fm.maxCapital,0)}`}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: `1px solid ${HAIR}` }}>
        <span className="text-[10px]" style={{ color: FAINT }}>{ACTIVE_LANG === "en" ? "LOCAL · no fixed session" : "ЛОКАЛЬНО · без фиксированной сессии"}</span>
        <span className="text-[11px] font-medium">{tr("ОТКРЫТЬ →")}</span>
      </div>
    </button>
  );
}

/* ------------------------------ ПОПОЛНЕНИЕ -------------------------------
   Интерфейс готов, платёжный провайдер не подключён. Кнопка «ПОПОЛНИТЬ»
   намеренно ничего не списывает и не зачисляет — она сообщает, что оплаты
   пока нет. Отдельная демо-кнопка начисляет практические доллары, чтобы
   можно было продолжать играть.
   ------------------------------------------------------------------------ */
const PAY_METHODS = [
  { id: "card", label: "Банковская карта", icon: "card", tint: TEXT },
  { id: "trc", label: "USDT (TRC20)", icon: "coin", tint: DIM },
  { id: "erc", label: "USDT (ERC20)", icon: "coin", tint: DIM },
  { id: "btc", label: "BTC", icon: "coin", tint: DIM },
  { id: "other", label: "Другой способ", icon: "dots", tint: DIM },
];

/* Обмен кубков на бонус. Курс растёт со ступенью: $5 за кубок на первых
   двух, $6.67 на третьей и $8.33 на последней. Копить выгоднее, чем
   разменивать по одному, но и мелкий обмен не выглядит наказанием. */
const TROPHY_TIERS = [
  { cups: 1, bonus: 5 },
  { cups: 2, bonus: 10 },
  { cups: 3, bonus: 20 },
  { cups: 12, bonus: 100 },
];

function TrophyScreen({ profile, onBack, onRedeem }) {
  const p = profileProgress(profile);
  const [note, setNote] = useState(null);

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md tx-form-wrap w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pb-6 ui-safe-top ui-scroll-pad">
        <div className="flex items-center gap-4">
          <BackButton onClick={onBack} />
          <div className="text-[11px] tracking-[0.10em]" style={{ color: DIM }}>{tr("ТРОФЕИ")}</div>
        </div>

        <div className="rounded-2xl px-4 py-5 mt-6 flex items-center gap-4"
          style={CARD}>
          <span className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
            style={{ backgroundColor: "#0D0B08", border: `1px solid ${shade(GOLD, 0.45)}` }}>
            <Icon name="trophy" size={26} color={GOLD} />
          </span>
          <div className="min-w-0">
            <div className="text-[32px] leading-none font-semibold"
              style={{ color: p.trophies > 0 ? GOLD : TEXT }}>{p.trophies}</div>
            <div className="text-[12px] mt-1.5" style={{ color: DIM }}>
              {ACTIVE_LANG === "en" ? "trophies available" : "кубков на счету"}{p.trophiesSpent > 0 ? ACTIVE_LANG === "en" ? ` · redeemed ${p.trophiesSpent}` : ` · обменяно ${p.trophiesSpent}` : ""}
            </div>
          </div>
        </div>

        <div className="text-[12px] mt-4 leading-relaxed" style={{ color: DIM }}>
          {ACTIVE_LANG === "en" ? "You earn one trophy for every five profitable sessions in a row." : "Кубок даётся за каждые пять прибыльных сессий подряд."}
          {p.streak > 0 && p.toTrophy > 0
            ? ACTIVE_LANG === "en" ? ` ${p.toTrophy} left until the next trophy.` : ` До следующего осталось ${p.toTrophy}.`
            : ACTIVE_LANG === "en" ? " The streak resets after the first losing session." : " Серия прерывается на первой убыточной сессии."}
        </div>

        <div className="text-[10px] tracking-[0.10em] mt-7 mb-2.5" style={{ color: FAINT }}>
          {tr("ОБМЕН НА БОНУС")}
        </div>
        <div className="flex flex-col gap-2.5">
          {TROPHY_TIERS.map((t) => {
            const can = p.trophies >= t.cups;
            return (
              <button key={t.cups} disabled={!can}
                onClick={() => {
                  onRedeem(t.cups, t.bonus);
                  setNote(ACTIVE_LANG === "en" ? `${fmt(t.bonus, 0)} added to your balance` : `${fmt(t.bonus, 0)} зачислены на баланс`);
                }}
                className="flex items-center gap-3.5 rounded-2xl px-4 py-3.5 text-left tap disabled:opacity-35"
                style={btnSoft(false)}>
                <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ backgroundColor: "#060608",
                    border: `1px solid ${can ? shade(GOLD, 0.5) : "rgba(255,255,255,0.07)"}` }}>
                  <Icon name="trophy" size={17} color={can ? GOLD : FAINT} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[15px] font-semibold">
                    {ACTIVE_LANG === "en" ? `${fmt(t.bonus, 0)} to balance` : `${fmt(t.bonus, 0)} на баланс`}
                  </span>
                  <span className="block text-[12px] mt-0.5" style={{ color: DIM }}>
                    {ACTIVE_LANG === "en"
                      ? `${t.cups} ${t.cups === 1 ? "trophy" : "trophies"} · ${fmt(t.bonus / t.cups, t.bonus / t.cups % 1 ? 2 : 0)} per trophy`
                      : `${t.cups} ${t.cups === 1 ? "кубок" : t.cups < 5 ? "кубка" : "кубков"} · ${fmt(t.bonus / t.cups, t.bonus / t.cups % 1 ? 2 : 0)} за кубок`}
                  </span>
                </span>
                <span className="text-[12px] shrink-0 tracking-[0.10em]"
                  style={{ color: can ? TEXT : FAINT }}>
                  {can ? tr("ОБМЕНЯТЬ") : tr("НЕ ХВАТАЕТ")}
                </span>
              </button>
            );
          })}
        </div>

        {note && (
          <div className="text-[12px] text-center mt-5 leading-snug tx-pop" style={{ color: LONG }}>
            {note}
          </div>
        )}

        <div className="text-[11px] text-center mt-6 leading-relaxed" style={{ color: FAINT }}>
          {ACTIVE_LANG === "en" ? "The bonus is added to your balance and can be used in sessions like any other deposit." : "Бонус попадает на баланс и участвует в сессиях наравне с пополнением."}
        </div>
      </div>
    </div>
  );
}

function DepositScreen({ profile, onBack, onDemoTopUp }) {
  const [amount, setAmount] = useState("100");
  const [method, setMethod] = useState("card");
  const [note, setNote] = useState(null);
  const value = parseMoneyInput(amount);
  const ok = value >= 10;

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md tx-form-wrap w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pb-6 ui-safe-top ui-scroll-pad">
        <div className="flex items-center gap-4">
          <BackButton onClick={onBack} />
          <div className="text-[11px] tracking-[0.10em]" style={{ color: DIM }}>
            {tr("ПОПОЛНЕНИЕ БАЛАНСА")}
          </div>
        </div>

        <div className="text-[10px] tracking-[0.10em] mt-6" style={{ color: FAINT }}>
          {tr("ТЕКУЩИЙ БАЛАНС")}
        </div>
        <div className="text-[30px] font-mono leading-none mt-2 tx-pop">{fmt(profile.wallet, 0)}</div>

        <div className="text-[10px] tracking-[0.10em] mt-6 mb-2" style={{ color: FAINT }}>
          {tr("СУММА ПОПОЛНЕНИЯ")}
        </div>
        <div className="ui-field flex items-center rounded-2xl px-4"
          style={CARD}>
          <span className="text-[16px] font-mono" style={{ color: DIM }}>$</span>
          <input value={amount} onChange={(e) => setAmount(sanitizeMoneyInput(e.target.value))}
            inputMode="decimal" autoComplete="off" spellCheck="false"
            className="flex-1 min-w-0 bg-transparent outline-none py-4 pl-1 text-[16px] font-mono"
            style={{ color: TEXT }} />
        </div>

        <div className="grid grid-cols-4 gap-2 mt-2">
          {[50, 100, 250, 500].map((v) => (
            <button key={v} onClick={() => setAmount(String(v))}
              className="rounded-xl min-h-[44px] px-2 text-[12px] font-mono font-semibold tap"
              style={{ background: String(v) === amount ? "#111112" : CARD_BG_SOFT,
                color: String(v) === amount ? TEXT : DIM,
                border: `1px solid ${String(v) === amount ? "#2D2D30" : HAIR}` }}>
              ${v}
            </button>
          ))}
        </div>

        <div className="text-[10px] tracking-[0.10em] mt-7 mb-2" style={{ color: FAINT }}>
          {tr("СПОСОБ ОПЛАТЫ")}
        </div>
        <div className="rounded-2xl overflow-hidden"
          style={CARD}>
          {PAY_METHODS.map((m, i) => (
            <button key={m.id} onClick={() => setMethod(m.id)}
              className={`w-full flex items-center gap-3 px-4 py-3.5 text-left tap ${i ? "border-t" : ""}`}
              style={{ borderColor: HAIR,
                backgroundColor: method === m.id ? RAISED : "transparent" }}>
              <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                style={{ backgroundColor: "#0D0D10" }}>
                <Icon name={m.icon} size={16} color={m.tint} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] truncate">{tr(m.label)}</span>
                {m.sub && (
                  <span className="block text-[11px] font-mono" style={{ color: FAINT }}>{m.sub}</span>
                )}
              </span>
              <span className="w-[18px] h-[18px] rounded-full shrink-0 flex items-center justify-center"
                style={{ border: `1.5px solid ${method === m.id ? TEXT : DIM}` }}>
                {method === m.id && (
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TEXT }} />
                )}
              </span>
            </button>
          ))}
        </div>

        {note && (
          <div className="text-[12px] text-center mt-5 leading-snug tx-pop" style={{ color: DIM }}>
            {note}
          </div>
        )}
      </div>

      <div className="max-w-md tx-form-footer w-full mx-auto px-5 pt-3 shrink-0 ui-bottom-surface ui-safe-bottom">
        <button disabled={!ok}
          onClick={() => setNote(ACTIVE_LANG === "en" ? "Payments are not connected yet. For now, balance top-ups are available in demo mode only." : "Приём оплат ещё не подключён. Пока баланс можно пополнить только в демо-режиме.")}
          className="w-full rounded-2xl py-4 text-[13px] tracking-[0.10em] font-bold tap disabled:opacity-40"
          style={btnSoft(true)}>
          {tr("ПОПОЛНИТЬ")}
        </button>
        <button disabled={!ok} onClick={() => { onDemoTopUp(value); onBack(); }}
          className="w-full py-3 mt-2 text-[11px] tracking-[0.13em] tap disabled:opacity-40"
          style={{ color: DIM }}>
          {ACTIVE_LANG === "en" ? `ADD ${fmt(value, 0)} IN DEMO MODE` : `НАЧИСЛИТЬ ${fmt(value, 0)} В ДЕМО-РЕЖИМЕ`}
        </button>
        <div className="text-[11px] text-center mt-1" style={{ color: FAINT }}>
          {tr("Минимальная сумма — $10")}
        </div>
      </div>
    </div>
  );
}


/* -------------------------------- ВЫВОД ----------------------------------
   Как и пополнение: интерфейс готов, выплаты не подключены. Кнопка честно
   сообщает об этом и ничего не списывает.
   ------------------------------------------------------------------------ */
const WITHDRAW_MIN = 50;

function WithdrawScreen({ profile, onBack }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("card");
  const [note, setNote] = useState(null);
  const value = parseMoneyInput(amount);
  const enough = value >= WITHDRAW_MIN && value <= profile.wallet;

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md tx-form-wrap w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pb-6 ui-safe-top ui-scroll-pad">
        <div className="flex items-center gap-4">
          <BackButton onClick={onBack} />
          <div className="text-[11px] tracking-[0.10em]" style={{ color: DIM }}>{tr("ВЫВОД СРЕДСТВ")}</div>
        </div>

        <div className="text-[10px] tracking-[0.10em] mt-6" style={{ color: FAINT }}>
          {tr("ДОСТУПНО К ВЫВОДУ")}
        </div>
        <div className="text-[30px] font-mono leading-none mt-2 tx-pop">{fmt(profile.wallet, 0)}</div>

        <div className="text-[10px] tracking-[0.10em] mt-6 mb-2" style={{ color: FAINT }}>
          {tr("СУММА ВЫВОДА")}
        </div>
        <div className="ui-field flex items-center rounded-2xl px-4"
          style={CARD}>
          <span className="text-[16px] font-mono" style={{ color: DIM }}>$</span>
          <input value={amount} onChange={(e) => setAmount(sanitizeMoneyInput(e.target.value))}
            placeholder="0" inputMode="decimal"
            className="flex-1 min-w-0 bg-transparent outline-none py-4 pl-1 text-[16px] font-mono"
            style={{ color: TEXT }} />
          <button onClick={() => setAmount(String(Math.floor(profile.wallet)))}
            className="pl-3 text-[11px] tracking-[0.1em] tap" style={{ color: DIM }}>
            {tr("ВСЁ")}
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2 mt-2">
          {[25, 50, 75, 100].map((p) => (
            <button key={p} onClick={() => setAmount(String(Math.floor(profile.wallet * p / 100)))}
              className="rounded-xl min-h-[44px] px-2 text-[12px] font-mono font-semibold tap"
              style={btnSoft(false)}>
              {p}%
            </button>
          ))}
        </div>

        <div className="text-[10px] tracking-[0.10em] mt-7 mb-2" style={{ color: FAINT }}>
          {tr("КУДА ВЫВЕСТИ")}
        </div>
        <div className="rounded-2xl overflow-hidden"
          style={CARD}>
          {PAY_METHODS.filter((m) => m.id !== "other").map((m, i) => (
            <button key={m.id} onClick={() => setMethod(m.id)}
              className={`w-full flex items-center gap-3 px-4 py-3.5 text-left tap ${i ? "border-t" : ""}`}
              style={{ borderColor: HAIR,
                backgroundColor: method === m.id ? RAISED : "transparent" }}>
              <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                style={{ backgroundColor: "#0D0D10" }}>
                <Icon name={m.icon} size={16} color={m.tint} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] truncate">{tr(m.label)}</span>
                {m.sub && (
                  <span className="block text-[11px] font-mono" style={{ color: FAINT }}>{m.sub}</span>
                )}
              </span>
              <span className="w-[18px] h-[18px] rounded-full shrink-0 flex items-center justify-center"
                style={{ border: `1.5px solid ${method === m.id ? TEXT : DIM}` }}>
                {method === m.id && (
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TEXT }} />
                )}
              </span>
            </button>
          ))}
        </div>

        {note && (
          <div className="text-[12px] text-center mt-5 leading-snug tx-pop" style={{ color: DIM }}>
            {note}
          </div>
        )}
      </div>

      <div className="max-w-md tx-form-footer w-full mx-auto px-5 pt-3 shrink-0 ui-bottom-surface ui-safe-bottom">
        <button disabled={!enough}
          onClick={() => setNote(ACTIVE_LANG === "en" ? "Withdrawals are not connected yet. Your balance will stay unchanged." : "Выплаты ещё не подключены. Баланс остаётся на месте.")}
          className="w-full rounded-2xl py-4 text-[13px] tracking-[0.10em] font-bold tap disabled:opacity-40"
          style={btnSoft(true)}>
          {tr("ВЫВЕСТИ")}
        </button>
        <div className="text-[11px] text-center mt-2" style={{ color: FAINT }}>
          {value > profile.wallet
            ? (ACTIVE_LANG === "en" ? "More than your available balance" : "Больше, чем есть на балансе")
            : (ACTIVE_LANG === "en" ? `Minimum amount — ${fmt(WITHDRAW_MIN, 0)}` : `Минимальная сумма — ${fmt(WITHDRAW_MIN, 0)}`)}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- РЕЙТИНГ --------------------------------
   Таблица собирается детерминированно из зерна периода, а результат игрока
   берётся из его реальной истории. Это витрина под будущий серверный
   лидерборд: когда появится Firestore, меняется только источник rows.
   ------------------------------------------------------------------------ */
const RANK_NAMES = ["MarketKing", "TraderOne", "AlphaWolf", "SigmaTrader", "FastHands",
  "ByteBro", "ChartMaster", "GreenPips", "DarkPool", "NightDesk", "ColdEntry",
  "TickHunter", "QuietSize", "RiskOff", "LateFill", "BlueTape", "SharpBid"];

function RankingTab({ profile, period, onPeriod }) {
  const st = profileStats(profile);
  const seed = { "ДЕНЬ": 11, "НЕДЕЛЯ": 27, "МЕСЯЦ": 53, "ВСЁ ВРЕМЯ": 91 }[period] || 11;
  const rnd = mulberry32(seed);
  const scale = { "ДЕНЬ": 1, "НЕДЕЛЯ": 3.4, "МЕСЯЦ": 9, "ВСЁ ВРЕМЯ": 21 }[period] || 1;

  const bots = RANK_NAMES.map((name) => ({
    name, pnl: Math.round((400 + rnd() * 12000) * scale) / 100,
  }));
  const rows = [...bots, { name: tr("вы"), pnl: st.total, me: true }]
    .sort((a, b) => b.pnl - a.pnl)
    .map((r, i) => ({ ...r, place: i + 1 }));

  const podium = [rows[1], rows[0], rows[2]];

  return (
    <div className="px-5 ui-safe-top tx-rank-wrap">
      <div className="text-[11px] tracking-[0.10em] text-center" style={{ color: DIM }}>
        {tr("РЕЙТИНГ ИГРОКОВ")}
      </div>

      <div className="flex gap-1 p-1 rounded-2xl mt-5"
        style={CARD}>
        {["ДЕНЬ", "НЕДЕЛЯ", "МЕСЯЦ", "ВСЁ ВРЕМЯ"].map((p) => (
          <button key={p} onClick={() => onPeriod(p)}
            className="flex-1 rounded-xl py-2.5 text-[10px] tracking-[0.12em] font-semibold tap"
            style={{ backgroundColor: p === period ? RAISED : "transparent",
              color: p === period ? TEXT : FAINT,
              border: `1px solid ${p === period ? "#35343A" : "transparent"}` }}>
            {periodLabel(p)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 mt-5">
        {podium.map((r, i) => {
          const first = i === 1;
          return (
            <div key={r.name} className="min-w-0 rounded-[18px] px-3 py-3.5 tx-in"
              style={{ ...(first ? CARD : CARD_SOFT), ...stagger(i) }}>
              <div className="flex items-center justify-between">
                <span className="text-[18px] font-mono" style={{ color: first ? TEXT : FAINT }}>{String(r.place).padStart(2, "0")}</span>
                {first && <Icon name="trophy" size={13} color={GOLD} />}
              </div>
              <div className="text-[11px] truncate mt-5" style={{ color: r.me ? TEXT : DIM }}>{r.name}</div>
              <div className="text-[12px] font-mono mt-1" style={{ color: r.pnl >= 0 ? LONG : SHORT }}>{fmtSigned(r.pnl, 0)}</div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center px-4 mt-6 mb-1 text-[9px] tracking-[0.10em]"
        style={{ color: FAINT }}>
        <span className="w-7">#</span>
        <span className="flex-1">{tr("ИГРОК")}</span>
        <span>{tr("РЕЗУЛЬТАТ")}</span>
      </div>
      <div className="rounded-2xl overflow-hidden"
        style={CARD}>
        {rows.slice(3).map((r, i) => (
          <div key={r.name}
            className={`flex items-center px-4 py-3 ${i ? "border-t" : ""}`}
            style={{ borderColor: HAIR, backgroundColor: r.me ? RAISED : "transparent" }}>
            <span className="w-7 text-[12px] font-mono" style={{ color: FAINT }}>{r.place}</span>
            <span className="flex-1 min-w-0 text-[13px] truncate"
              style={{ color: r.me ? TEXT : DIM }}>{r.name}</span>
            <span className="text-[13px] font-mono"
              style={{ color: r.pnl >= 0 ? LONG : SHORT }}>{fmtSigned(r.pnl, 0)}</span>
          </div>
        ))}
      </div>

      <div className="text-[11px] text-center mt-4 leading-snug" style={{ color: FAINT }}>
        {ACTIVE_LANG === "en" ? "Other players are placeholders for now; the global ranking will arrive with online mode. Your row is calculated from your actual session history." : "Соперники показаны для примера: общий рейтинг появится вместе с онлайн-режимом. Ваша строка считается по реальной истории сессий."}
      </div>
    </div>
  );
}

/* --------------------------------- РЫНКИ --------------------------------- */
function MarketsTab({ onPlay, onFree }) {
  const m = CONFIG.market;
  const MarketItem = ({ kind, title, sub, status, rows, note, onClick, disabled }) => (
    <button onClick={onClick} disabled={disabled}
      className="tx-market-card w-full rounded-[12px] p-4 text-left tap disabled:opacity-35 tx-in"
      style={CARD}>
      <div className="flex items-start gap-3.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-[16px] font-mono truncate">{title}</div>
            {status && <span className="text-[8px] px-2 py-1 rounded-full ui-chip shrink-0">{status}</span>}
          </div>
          <div className="text-[11px] mt-1" style={{ color: DIM }}>{sub}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3">
            {rows.map(([k, v]) => (
              <span key={k} className="text-[10px]" style={{ color: FAINT }}>
                {k} <span className="font-mono" style={{ color: TEXT }}>{v}</span>
              </span>
            ))}
          </div>
          {note && <div className="text-[10px] leading-snug mt-2.5" style={{ color: FAINT }}>{note}</div>}
        </div>
      </div>
      <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: `1px solid ${HAIR}` }}>
        <span className="text-[10px]" style={{ color: DIM }}>{disabled ? tr("недоступно сейчас") : tr("открыть рынок")}</span>
        <Icon name="chevron" size={15} color={disabled ? FAINT : TEXT} />
      </div>
    </button>
  );

  return (
    <div className="px-5 ui-safe-top pb-6 tx-markets-wrap">
      <div className="mb-5">
        <div className="text-[22px] tracking-tight">{tr("Рынки")}</div>
        <div className="text-[11px] mt-1.5" style={{ color: DIM }}>
          {tr("Разные режимы одной рыночной модели.")}
        </div>
      </div>

      <div className="grid gap-2.5 tx-markets-grid">
        <MarketItem kind="free" title={`${m.assetSymbol} · FREE`} status="LIVE"
          sub={tr("Свободный рынок без конца сессии")}
          rows={[[tr("ботов"), m.freeMarket.botCount.toLocaleString(ACTIVE_LANG === "en" ? "en-US" : "ru-RU")],
            [tr("вход"), `${fmt(m.freeMarket.minCapital,0)}–${fmt(m.freeMarket.maxCapital,0)}`], [tr("режим"), ACTIVE_LANG === "en" ? "LOCAL LIVE" : "ЛОКАЛЬНЫЙ"]]}
          note={tr("Участники с разными балансами и стратегиями. Войти и выйти можно в любой момент.")}
          onClick={onFree} />

        <MarketItem kind="offline" title={`${m.assetSymbol} · SESSION`} status="LOCAL"
          sub={tr("Закрытая сессия с одинаковым капиталом участников")}
          rows={[[tr("участники"), m.playerOptions.join("/")],
            [tr("взнос"), m.capitalOptions.map((c) => fmt(c,0)).join(" · ")], [tr("тик"), `${m.tickMs}ms`]]}
          note={tr("Подходит для коротких соревновательных сессий и проверки стратегий.")}
          onClick={() => onPlay(false)} />

        <MarketItem kind="online" title={`${m.assetSymbol} · EYES`} status="DATA"
          sub={tr("Тот же рынок с обезличенными зонами SL / TP")}
          rows={[[tr("данные"), tr("стопы / тейки")], [tr("имена"), tr("скрыты")], [tr("математика"), tr("та же")]]}
          note={tr("Дополнительный информационный слой без изменения базовой цены рынка.")}
          onClick={() => onPlay(true)} />
      </div>
    </div>
  );
}

/* ------------------------------- НИЖНЕЕ МЕНЮ ------------------------------ */
const TABS = [
  { key: "home", label: "ГЛАВНАЯ", icon: "home" },
  { key: "markets", label: "РЫНКИ", icon: "candles" },
  { key: "rank", label: "РЕЙТИНГ", icon: "trophy" },
];

function TabBar({ active, onChange }) {
  return (
    /* Колонок ровно столько, сколько вкладок. Раньше стояло grid-cols-4 при
       трёх вкладках — они прижимались влево, а справа зияла пустая четверть.
       Активная вкладка помечается белым, а не зелёным. */
    <div className="max-w-md tx-lobby-nav w-full mx-auto grid shrink-0 pt-2 ui-safe-bottom"
      style={{ borderTop: `1px solid ${HAIR}`,
        gridTemplateColumns: `repeat(${TABS.length}, minmax(0, 1fr))` }}>
      {TABS.map((t) => {
        const on = t.key === active;
        return (
          <button key={t.key} onClick={() => onChange(t.key)}
            className={`flex flex-col items-center justify-center gap-1.5 min-h-[54px] tap ${on ? "tx-nav-active" : ""}`}>
            <Icon name={t.icon} size={20} color={on ? TEXT : FAINT} />
            <span className="text-[10px] tracking-[0.06em]"
              style={{ color: on ? TEXT : FAINT }}>
              {tr(t.label)}
            </span>
          </button>
        );
      })}
    </div>
  );
}


/* ------------------------------ ПРОГРЕСС ---------------------------------
   Уровень считается по числу прибыльных сессий за всё время. Шаг удваивается:
   на 2-й уровень нужно 5 побед, на 3-й ещё 10, на 4-й ещё 20 и так далее.
   Кубок выдаётся за каждые пять прибыльных сессий ПОДРЯД; серия из 12 побед
   даёт два кубка, а первый же убыток серию обрывает.
   ------------------------------------------------------------------------ */
const LEVEL_STEP = (level) => 5 * Math.pow(2, level - 1);

function profileProgress(profile) {
  const list = [...(profile.sessions || [])].reverse();   // от старых к новым
  const wins = list.filter((x) => x.pnl > 0).length;

  let level = 1, spent = 0;
  while (wins - spent >= LEVEL_STEP(level)) { spent += LEVEL_STEP(level); level++; }
  const need = LEVEL_STEP(level);
  const done = wins - spent;

  let trophies = 0, streak = 0, best = 0;
  for (const x of list) {
    if (x.pnl > 0) { streak++; best = Math.max(best, streak); if (streak % 5 === 0) trophies++; }
    else streak = 0;
  }

  // Серия успеха: сколько календарных дней подряд была хотя бы одна сессия,
  // считая назад от последней. Дни берутся по локальной дате.
  const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = [...new Set(list.filter((x) => Number.isFinite(x.at)).map((x) => day(x.at)))]
    .sort((a, b) => b - a);
  let dayStreak = 0;
  if (days.length) {
    const today = day(Date.now());
    if (days[0] === today || days[0] === today - 86400e3) {
      dayStreak = 1;
      for (let i = 1; i < days.length; i++) {
        if (days[i - 1] - days[i] === 86400e3) dayStreak++; else break;
      }
    }
  }

  const bestPct = list.length
    ? Math.max(...list.map((x) => (x.capital ? x.pnl / x.capital : 0))) : 0;

  /* Кубки тратятся на бонусы, поэтому наружу отдаётся ОСТАТОК. Заработанные
     за всё время (trophiesEarned) нужны отдельно — по ним считается прогресс
     и они не уменьшаются при обмене. */
  const spentCups = profile.trophiesSpent || 0;
  return { level, wins, done, need, progress: need ? done / need : 0,
    trophiesEarned: trophies, trophiesSpent: spentCups,
    trophies: Math.max(0, trophies - spentCups),
    streak, bestStreak: best, dayStreak, bestPct,
    toTrophy: (5 - (streak % 5)) % 5 || 5 };
}

/* Куб уровня удалён из интерфейса: он стоял между числом уровня и блоком
   кубков, занимал треть строки, ничего не сообщал и добавлял третий
   светящийся зелёный объект на экран. Разметка блока уровня стала
   двухколоночной. */


/** Верхний блок главного экрана: уровень, прогресс, кубки, серия. */
function LevelBar({ profile }) {
  const p = profileProgress(profile);
  return (
    <div className="tx-level-card rounded-[12px] p-4 mt-4 tx-in" style={{ ...CARD, ...stagger(1) }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="ui-label">{tr("УРОВЕНЬ")}</div>
          <div className="tx-level-number text-[34px] leading-none font-mono mt-1">{p.level}</div>
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <Icon name="trophy" size={15} color={p.trophies > 0 ? GOLD : FAINT} />
            <span className="text-[18px] font-mono" style={{ color: p.trophies > 0 ? GOLD : TEXT }}>{p.trophies}</span>
          </div>
          <div className="text-[9px] mt-1" style={{ color: FAINT }}>{ACTIVE_LANG === "en" ? "trophies" : "кубков"}</div>
        </div>
      </div>
      <div className="flex items-center justify-between mt-4">
        <span className="text-[11px]" style={{ color: DIM }}>{ACTIVE_LANG === "en" ? `${p.done} of ${p.need} profitable sessions` : `${p.done} из ${p.need} прибыльных сессий`}</span>
        <span className="text-[11px] font-mono" style={{ color: DIM }}>{Math.round(p.progress*100)}%</span>
      </div>
      <div className="h-[3px] w-full rounded-full mt-2 overflow-hidden" style={{ backgroundColor: HAIR }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(1,p.progress)*100}%`, backgroundColor: ACCENT,
          transition: "width var(--tx-slow) var(--tx-ease)" }} />
      </div>
      <div className="grid grid-cols-2 gap-0 mt-4 pt-3" style={{ borderTop: `1px solid ${HAIR}` }}>
        <div className="pr-3">
          <div className="ui-label">{tr("СЕРИЯ")}</div>
          <div className="text-[12px] mt-1">{p.dayStreak > 0 ? ACTIVE_LANG === "en" ? `${p.dayStreak} ${p.dayStreak === 1 ? "day" : "days"} in a row` : `${p.dayStreak} ${plural(p.dayStreak,"день","дня","дней")} подряд` : "—"}</div>
        </div>
        <div className="pl-3" style={{ borderLeft: `1px solid ${HAIR}` }}>
          <div className="ui-label">{tr("ЛУЧШАЯ СЕССИЯ")}</div>
          <div className="tx-level-best text-[12px] font-mono mt-1" style={{ color: p.bestPct > 0 ? TEXT : DIM }}>
            {p.wins || p.bestPct ? signedPct(p.bestPct) : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Русское склонение по числу. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}


/* ------------------------------- НАСТРОЙКИ -------------------------------
   Отдельный экран, а не выпадающее меню. RU/EN переключаются глобально
   и сохраняются между запусками.
   ------------------------------------------------------------------------ */
const LANGS = [
  { code: "ru", label: "Русский" },
  { code: "en", label: "English" },
];

function SettingsScreen({ account, language, onLanguageChange, onClose, onReset, onExit, onSignOut }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const card = CARD;

  const Row = ({ label, sub, onClick, color = TEXT, last }) => (
    <button onClick={onClick}
      className={`w-full text-left px-4 py-3.5 tap ${last ? "" : "border-b"}`}
      style={{ borderColor: HAIR }}>
      <div className="text-[14px]" style={{ color }}>{label}</div>
      {sub && <div className="text-[11px] mt-0.5" style={{ color: FAINT }}>{sub}</div>}
    </button>
  );

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="max-w-md tx-form-wrap w-full mx-auto flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 pb-7 ui-safe-top ui-scroll-pad">
        <div className="flex items-center gap-4">
          <BackButton onClick={onClose} />
          <div className="text-[11px] tracking-[0.10em]" style={{ color: DIM }}>{tr("НАСТРОЙКИ")}</div>
        </div>

        <div className="text-[10px] tracking-[0.10em] mt-7 mb-2" style={{ color: FAINT }}>{tr("ЯЗЫК")}</div>
        <div className="grid grid-cols-2 gap-2">
          {LANGS.map((l) => (
            <button key={l.code} onClick={() => onLanguageChange(l.code)}
              className="rounded-xl py-3.5 text-[13px] font-semibold tap"
              style={{ background: language === l.code ? "#111112" : CARD_BG_SOFT,
                color: language === l.code ? TEXT : DIM,
                border: `1px solid ${language === l.code ? "#2D2D30" : HAIR}` }}>
              {l.code === "ru" ? (ACTIVE_LANG === "en" ? "Russian" : "Русский") : "English"}
            </button>
          ))}
        </div>
        <div className="text-[11px] mt-2" style={{ color: FAINT }}>
          {language === "en" ? "The interface is shown in English." : "Интерфейс показан на русском языке."}
        </div>

        <div className="text-[10px] tracking-[0.10em] mt-7 mb-2" style={{ color: FAINT }}>{tr("АККАУНТ")}</div>
        <div className="rounded-2xl overflow-hidden" style={card}>
          <Row label={account?.email || tr("гость")} sub={tr("почта аккаунта")} />
          {onExit && <Row label={tr("Сменить режим")} onClick={onExit} color={DIM} />}
          <Row label={tr("Выйти из аккаунта")} onClick={onSignOut} color={SHORT} last />
        </div>

        <div className="text-[10px] tracking-[0.10em] mt-7 mb-2" style={{ color: FAINT }}>{tr("БАЛАНС")}</div>
        <div className="rounded-2xl overflow-hidden" style={card}>
          {confirmReset ? (
            <div className="px-4 py-3.5">
              <div className="text-[13px]" style={{ color: SHORT }}>
                {ACTIVE_LANG === "en" ? "Reset balance? Your session history will be kept." : "Обнулить баланс? История сессий останется."}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3">
                <button onClick={() => setConfirmReset(false)}
                  className="rounded-xl py-3 text-[13px] font-semibold tap"
                  style={btnSoft(false)}>
                  {tr("Отмена")}
                </button>
                <button onClick={() => { onReset(); setConfirmReset(false); }}
                  className="rounded-xl py-3 text-[13px] font-semibold tap"
                  style={{ backgroundColor: SHORT, color: BG }}>
                  {tr("Обнулить")}
                </button>
              </div>
            </div>
          ) : (
            <Row label={tr("Сбросить баланс до $0")} sub={tr("пополнить можно на экране пополнения")}
              onClick={() => setConfirmReset(true)} color={SHORT} last />
          )}
        </div>

        <div className="text-[11px] text-center mt-8 leading-relaxed" style={{ color: FAINT }}>
          {ACTIVE_LANG === "en" ? "trade.exe · closed market for practice" : "trade.exe · закрытый рынок для практики"}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- ЛОББИ --------------------------------- */
function Lobby({ profile, account, onNew, onFree, onReset, onExit, onSignOut, onTopUp, onRedeem, language, onLanguageChange }) {
  const st = profileStats(profile);
  const [tab, setTab] = useState("home");
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deposit, setDeposit] = useState(false);
  const [withdraw, setWithdraw] = useState(false);
  const [trophy, setTrophy] = useState(false);
  const [range, setRange] = useState(LOBBY_RANGES[0]);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [period, setPeriod] = useState("ДЕНЬ");
  const [notice, setNotice] = useState(null);

  const now = Date.now();
  const inRange = profile.sessions.filter(
    (x) => Number.isFinite(x.at) && now - x.at <= range.ms);
  const rangeTotal = inRange.reduce((sum, x) => sum + x.pnl, 0);
  const affordable = CONFIG.market.capitalOptions.some((c) => c <= profile.wallet);
  const card = CARD;

  if (profileOpen) {
    return <ProfileScreen profile={profile} account={account}
      onClose={() => setProfileOpen(false)}
      onSettings={() => { setProfileOpen(false); setSettingsOpen(true); }} />;
  }
  if (settingsOpen) {
    return <SettingsScreen account={account} language={language} onLanguageChange={onLanguageChange}
      onClose={() => setSettingsOpen(false)} onReset={onReset} onExit={onExit} onSignOut={onSignOut} />;
  }
  if (deposit) {
    return <DepositScreen profile={profile} onBack={() => setDeposit(false)}
      onDemoTopUp={onTopUp} />;
  }
  if (withdraw) {
    return <WithdrawScreen profile={profile} onBack={() => setWithdraw(false)} />;
  }
  if (trophy) {
    return <TrophyScreen profile={profile} onBack={() => setTrophy(false)} onRedeem={onRedeem} />;
  }

  return (
    <div className="w-full flex flex-col tx-screen"
      style={{ height: "100dvh", backgroundColor: BG, color: TEXT }}>
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        <div className="max-w-md tx-lobby-shell w-full mx-auto pb-4">

          {tab === "home" && (
            <div className="px-5 ui-safe-top tx-lobby-home">
              {/* ---------------------------- шапка --------------------------
                 Логотип и название в одну строку, действия — круглыми
                 кнопками справа. Раньше название стояло ПОД логотипом, из-за
                 чего шапка занимала две строки и отжимала баланс вниз. */}
              <div className="tx-home-header flex items-center justify-between gap-3 tx-in tx-desk-full" style={stagger(0)}>
                <div className="flex items-center gap-3 min-w-0">
                  <Logo size={38} />
                  <div className="text-[19px] font-medium tracking-[-0.02em] truncate">trade.exe</div>
                </div>
                <div className="flex gap-2.5">
                  <RoundButton name="user" onClick={() => setProfileOpen(true)} />
                  <RoundButton name="gear" onClick={() => setSettingsOpen(true)} />
                </div>
              </div>

              {/* --------------------------- баланс ---------------------------
                 Идёт сразу за шапкой, как в кошельках: сумма — первое, что
                 человек ищет глазами. Блок уровня и трофеев переехал ниже
                 кнопок, раньше он стоял между шапкой и балансом и отжимал
                 сумму на середину экрана.
                 Сумма набрана обычным шрифтом, а не моноширинным:
                 моноширинный на большом кегле читается как терминал. */}
              <div className="tx-balance-block mt-6 tx-desk-half">
                <div className="text-[11px] tracking-[0.12em]" style={{ color: FAINT }}>
                  {tr("БАЛАНС")}
                </div>
                <div className="tx-balance-value text-[36px] leading-[1.05] font-semibold tracking-tight truncate tx-pop mt-1">
                  {fmt(profile.wallet, 0)}
                </div>
                <div className="tx-balance-sub text-[13px] mt-1.5"
                  style={{ color: st.total > 0 ? LONG : st.total < 0 ? SHORT : DIM }}>
                  {st.count === 0 ? tr("сессий ещё не было")
                    : (ACTIVE_LANG === "en" ? `${fmtSigned(st.total)} across ${st.count} sessions` : `${fmtSigned(st.total)} за ${st.count} сесс.`)}
                </div>
              </div>

              <div className="tx-free-market-block mt-4 tx-desk-half">
                <FreeMarketMiniCard onClick={onFree} />
              </div>

              <div className="tx-wallet-actions grid grid-cols-3 gap-2 mt-4 tx-desk-half">
                <WalletAction icon="plus" label={tr("Пополнить")} onClick={() => setDeposit(true)} />
                <WalletAction icon="arrowUpRight" label={tr("Вывести")} onClick={() => setWithdraw(true)} />
                <WalletAction icon="trophy" label={tr("Трофеи")} onClick={() => setTrophy(true)} />
              </div>

              <div className="tx-level-block tx-desk-half"><LevelBar profile={profile} /></div>

              {/* --------------------------- режимы -------------------------- */}
              <div className="tx-mode-list grid grid-cols-1 gap-2 mt-5 tx-in tx-desk-half" style={stagger(1)}>
                <ModeCard kind="online" title={tr("ОНЛАЙН РЫНОК")}
                  text={tr("Реальные участники и единая сессия в реальном времени")}
                  cta={tr("СЕРВЕРНАЯ ВЕРСИЯ")} primary
                  onClick={() => setNotice(tr("Онлайн-комнаты появятся после подключения сервера. Пока доступна офлайн-практика."))} />
                <ModeCard kind="offline" title={tr("ОФЛАЙН ПРАКТИКА")}
                  text={tr("Та же рыночная модель локально — для тестов и практики")}
                  cta={tr("ОТКРЫТЬ ПРАКТИКУ")} onClick={() => onNew(false)} disabled={!affordable} />
              </div>

              {notice && (
                <div className="tx-notice-block text-[12px] mt-3 rounded-xl px-4 py-3 leading-snug tx-pop tx-desk-half"
                  style={{ ...card, color: DIM }}>{notice}</div>
              )}

              {/* ------------------------- статистика ------------------------ */}
              <div className="tx-session-overview rounded-[12px] px-4 py-3.5 mt-5 tx-in tx-desk-half" style={{ ...card, ...stagger(3) }}>
                {/* Столбец «ПРИБЫЛЬНЫХ» убран: на четверти ширины подпись не
                    помещалась и обрезалась в «ПРИБЫЛЬ…», а сама цифра
                    повторяет винрейт из профиля. Осталось три колонки. */}
                <div className="grid grid-cols-3 gap-2">
                  {[
                    [tr("СЕССИЙ"), String(st.count), TEXT],
                    [tr("ЛУЧШАЯ"), st.count ? fmtSigned(st.best, 0) : "—", st.best > 0 ? LONG : TEXT],
                    [tr("ХУДШАЯ"), st.count ? fmtSigned(st.worst, 0) : "—", st.worst < 0 ? SHORT : TEXT],
                  ].map(([label, value, color]) => (
                    <div key={label} className="min-w-0">
                      <div className="text-[9px] tracking-[0.10em] truncate" style={{ color: FAINT }}>{label}</div>
                      <div className="tx-stat-value text-[15px] font-mono mt-2 truncate leading-none" style={{ color }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ---------------------- дневная динамика --------------------- */}
              <div className="tx-equity-block tx-desk-half">
              <div className="text-[10px] tracking-[0.11em] mt-6 mb-2.5" style={{ color: FAINT }}>
                {tr("ДНЕВНАЯ ДИНАМИКА")}
              </div>
              <div className="tx-equity-card rounded-[12px] px-4 py-3.5 tx-in" style={{ ...card, ...stagger(3) }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[20px] font-mono leading-none"
                      style={{ color: rangeTotal > 0 ? LONG : rangeTotal < 0 ? SHORT : TEXT }}>
                      {inRange.length ? fmtSigned(rangeTotal) : "—"}
                    </div>
                    <div className="text-[12px] mt-1.5" style={{ color: DIM }}>{tr("суммарный результат")}</div>
                  </div>
                  <div className="relative shrink-0">
                    <button onClick={() => setRangeOpen((v) => !v)}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] tracking-[0.10em] tap"
                      style={btnSoft(false)}>
                      {periodLabel(range.key)}<Icon name="caret" size={13} color={DIM} />
                    </button>
                    {rangeOpen && (
                      <div className="absolute right-0 mt-1 rounded-xl overflow-hidden z-10 tx-pop"
                        style={{ ...card, backgroundColor: RAISED }}>
                        {LOBBY_RANGES.map((r) => (
                          <button key={r.key} onClick={() => { setRange(r); setRangeOpen(false); }}
                            className="block w-full text-left px-4 py-2.5 text-[11px] tracking-[0.10em] whitespace-nowrap tap"
                            style={{ color: r.key === range.key ? TEXT : DIM }}>
                            {periodLabel(r.key)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-3">
                  <EquityCurve sessions={profile.sessions} rangeMs={range.ms} />
                </div>
              </div>
              </div>

              {/* ------------------------ последние сессии ------------------- */}
              <div className="tx-recent-block tx-desk-half">
              <div className="flex items-center justify-between mt-6 mb-2.5">
                <span className="text-[10px] tracking-[0.11em]" style={{ color: FAINT }}>
                  {tr("ПОСЛЕДНИЕ СЕССИИ")}
                </span>
                {profile.sessions.length > 0 && (
                  <button onClick={() => setProfileOpen(true)}
                    className="text-[10px] tracking-[0.13em] tap" style={{ color: DIM }}>
                    {tr("СМОТРЕТЬ ВСЕ")}
                  </button>
                )}
              </div>
              {profile.sessions.length === 0 ? (
                <div className="tx-empty-sessions rounded-[12px] py-7 text-center text-[12px]" style={{ ...card, color: FAINT }}>
                  {tr("здесь появятся результаты ваших сессий")}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {profile.sessions.slice(0, 2).map((x, i) => (
                    <div key={i}
                      className="tx-recent-session rounded-[10px] px-4 py-3 flex items-center justify-between gap-3 tx-in tap"
                      style={{ ...card, ...stagger(4 + i) }}>
                      <div className="min-w-0">
                        <div className="text-[14px] font-mono truncate">
                          {fmt(x.capital, 0)} → {fmt(x.equity)}
                        </div>
                        <div className="text-[11px] mt-1 truncate" style={{ color: FAINT }}>
                          {ACTIVE_LANG === "en" ? `${clock(x.ticks * CONFIG.market.tickMs)} in market · rank ${x.rank} of ${x.totalPlayers || CONFIG.market.totalPlayers}` : `${clock(x.ticks * CONFIG.market.tickMs)} в рынке · место ${x.rank} из ${x.totalPlayers || CONFIG.market.totalPlayers}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[14px] font-mono"
                          style={{ color: x.pnl >= 0 ? LONG : SHORT }}>{fmtSigned(x.pnl)}</span>
                        <Icon name="chevron" size={14} color={FAINT} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              </div>

            </div>
          )}

          {tab === "markets" && <MarketsTab onPlay={(e) => onNew(e)} onFree={onFree} />}
          {tab === "rank" && <RankingTab profile={profile} period={period} onPeriod={setPeriod} />}

        </div>
      </div>

      <TabBar active={tab} onChange={(k) => { setTab(k); setNotice(null); }} />
    </div>
  );
}

/* ----------------------------- СВОБОДНЫЙ РЫНОК ---------------------------- */

export { EquityCurve, ProfileScreen, ModeCard, FreeMarketMiniCard, TrophyScreen, DepositScreen, WithdrawScreen, RankingTab, MarketsTab, TabBar, profileProgress, LevelBar, plural, SettingsScreen, Lobby };

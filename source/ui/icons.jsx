import React from "react";
import { TEXT, CARD, CARD_SOFT } from "./theme.js";

const Icon = ({ name, size = 16, color = TEXT }) => {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: color, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
  if (name === "bars") return (
    <svg {...common}><path d="M6 20V10M12 20V4M18 20v-6" /></svg>
  );
  if (name === "gear") return (
    <svg {...common}><circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>
  );
  if (name === "flag") return (
    <svg {...common}><path d="M4 21V4h11l-1.5 4H20v8h-8l-1-3H4" /></svg>
  );
  if (name === "trend") return (
    <svg {...common}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
  );
  if (name === "star") return (
    <svg {...common}><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></svg>
  );
  if (name === "chevron") return (
    <svg {...common}><path d="M9 6l6 6-6 6" /></svg>
  );
  if (name === "home") return (
    <svg {...common}><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" /></svg>
  );
  if (name === "candles") return (
    <svg {...common}><path d="M7 4v16M12 2v20M17 6v12" />
      <rect x="4.5" y="8" width="5" height="8" /><rect x="9.5" y="6" width="5" height="12" />
      <rect x="14.5" y="10" width="5" height="5" /></svg>
  );
  if (name === "trophy") return (
    <svg {...common}><path d="M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" />
      <path d="M10 14h4l.5 4h-5z" /><path d="M8 20h8" /></svg>
  );
  if (name === "clock") return (
    <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5.5l3.5 2" /></svg>
  );
  if (name === "card") return (
    <svg {...common}><rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      <path d="M2.5 10h19M6 15h4" /></svg>
  );
  if (name === "coin") return (
    <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M8 9h8M12 9v7" /></svg>
  );
  if (name === "dots") return (
    <svg {...common}><circle cx="6" cy="12" r="1.2" fill={color} /><circle cx="12" cy="12" r="1.2" fill={color} />
      <circle cx="18" cy="12" r="1.2" fill={color} /></svg>
  );
  if (name === "user") return (
    <svg {...common}><circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" /></svg>
  );
  if (name === "eye") return (
    <svg {...common}><path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" /></svg>
  );
  if (name === "calendar") return (
    <svg {...common}><rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
  );
  if (name === "arrowUp") return (
    <svg {...common}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
  );
  if (name === "plus") return (
    <svg {...common}><path d="M12 5v14M5 12h14" /></svg>
  );
  if (name === "check") return (
    <svg {...common}><path d="M5 12l5 5 9-10" /></svg>
  );
  if (name === "arrowUpRight") return (
    <svg {...common}><path d="M7 17L17 7M8 7h9v9" /></svg>
  );
  if (name === "grid") return (
    <svg {...common}><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></svg>
  );
  if (name === "caret") return (
    <svg {...common}><path d="M6 9l6 6 6-6" /></svg>
  );
  return null;
};

/** Круглая кнопка действий в шапке кошелька. */
const RoundButton = ({ name, onClick }) => (
  <button onClick={onClick}
    className="tx-round-button relative w-11 h-11 rounded-[10px] flex items-center justify-center shrink-0 tap"
    style={CARD_SOFT}>
    <Icon name={name} size={18} color={TEXT} />
  </button>
);

/**
 * Плитка действия кошелька: иконка сверху, подпись снизу. Мягкий
 * вертикальный градиент и волосяная светлая рамка вместо плоской заливки —
 * на чёрном фоне плоский прямоугольник читается как дырка, а не как кнопка.
 */
const WalletAction = ({ icon, label, onClick }) => (
  <button onClick={onClick}
    className="tx-wallet-action flex items-center justify-center gap-2.5 rounded-[10px] tap ui-hit px-2"
    style={{ height: 58, ...CARD_SOFT }}>
    <Icon name={icon} size={18} color={TEXT} />
    <span className="text-[12px] font-medium truncate" style={{ color: TEXT }}>{label}</span>
  </button>
);


export { Icon, RoundButton, WalletAction };

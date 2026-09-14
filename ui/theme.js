const BG = "#030303";
const SURFACE = "#070708";
const RAISED = "#0A0A0B";
const HAIR = "#171719";
const TEXT = "#F0EEE9";
const DIM = "#918D86";
const FAINT = "#5D5A55";
const LONG = "#35B779";
const SHORT = "#D65F6B";
const GOLD = "#A88D61";
const ACCENT = "#DEDAD2";
const CARD_BG = "#070708";
const CARD_BG_SOFT = "#09090A";
const CARD = { background: CARD_BG, border: `1px solid ${HAIR}`, boxShadow: "none" };
const CARD_SOFT = { background: CARD_BG_SOFT, border: `1px solid ${HAIR}`, boxShadow: "none" };
const CHART_UP_FILL = "#ECE9E2";
const CHART_UP_STROKE = "#D3CEC5";
const CHART_DOWN_FILL = "rgba(0,0,0,0)";
const CHART_DOWN_STROKE = "#6F6C73";
const CHART_WICK = "#817D84";
const CHART_LINE = "#D9D4CB";
const CHART_LINE_FAINT = "rgba(217,212,203,.13)";
const CHART_VOL_UP = "rgba(236,233,226,.14)";
const CHART_VOL_DOWN = "rgba(119,115,124,.22)";
const CHART_PRICE_BG = "#050506";
const CHART_PRICE_STROKE = "#E5E1DA";
const shade = (hex, k) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
    return `#${((f(n >> 16) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255))
        .toString(16).padStart(6, "0")}`;
};
const btnAccent = (c) => ({
    backgroundColor: shade(c, 0.20),
    color: c,
    border: `1px solid ${shade(c, 0.64)}`,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,.025)",
});
const btnSoft = (on) => on
    ? { backgroundColor: "#E2DED6", color: "#060606", border: "1px solid #E2DED6", boxShadow: "none" }
    : { backgroundColor: "#09090A", color: TEXT, border: `1px solid ${HAIR}`, boxShadow: "none" };
const choiceStyle = (active, disabled = false) => ({
    background: active && !disabled ? "#101011" : CARD_BG_SOFT,
    color: disabled ? FAINT : active ? TEXT : DIM,
    border: `1px solid ${active && !disabled ? "#2A2A2D" : HAIR}`,
    boxShadow: "none",
});
const fmt = (v, d = 2) => {
    const digits = Math.abs(v) >= 1000 ? 0 : d;
    return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", {
        minimumFractionDigits: digits, maximumFractionDigits: digits,
    })}`;
};
const fmtSigned = (v, d = 2) => `${v >= 0 ? "+" : "−"}${fmt(Math.abs(v), d).replace("-", "")}`;
export { BG, SURFACE, RAISED, HAIR, TEXT, DIM, FAINT, LONG, SHORT, GOLD, ACCENT, CARD_BG, CARD_BG_SOFT, CARD, CARD_SOFT, CHART_UP_FILL, CHART_UP_STROKE, CHART_DOWN_FILL, CHART_DOWN_STROKE, CHART_WICK, CHART_LINE, CHART_LINE_FAINT, CHART_VOL_UP, CHART_VOL_DOWN, CHART_PRICE_BG, CHART_PRICE_STROKE, shade, btnAccent, btnSoft, choiceStyle, fmt, fmtSigned };

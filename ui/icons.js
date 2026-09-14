import React from "react";
import { TEXT, CARD, CARD_SOFT } from "./theme.js";
const Icon = ({ name, size = 16, color = TEXT }) => {
    const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: color, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
    if (name === "bars")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M6 20V10M12 20V4M18 20v-6" })));
    if (name === "gear")
        return (React.createElement("svg", { ...common },
            React.createElement("circle", { cx: "12", cy: "12", r: "3" }),
            React.createElement("path", { d: "M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" })));
    if (name === "flag")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M4 21V4h11l-1.5 4H20v8h-8l-1-3H4" })));
    if (name === "trend")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M3 17l6-6 4 4 8-8" }),
            React.createElement("path", { d: "M15 7h6v6" })));
    if (name === "star")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" })));
    if (name === "chevron")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M9 6l6 6-6 6" })));
    if (name === "home")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" })));
    if (name === "candles")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M7 4v16M12 2v20M17 6v12" }),
            React.createElement("rect", { x: "4.5", y: "8", width: "5", height: "8" }),
            React.createElement("rect", { x: "9.5", y: "6", width: "5", height: "12" }),
            React.createElement("rect", { x: "14.5", y: "10", width: "5", height: "5" })));
    if (name === "trophy")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M7 4h10v5a5 5 0 0 1-10 0z" }),
            React.createElement("path", { d: "M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" }),
            React.createElement("path", { d: "M10 14h4l.5 4h-5z" }),
            React.createElement("path", { d: "M8 20h8" })));
    if (name === "clock")
        return (React.createElement("svg", { ...common },
            React.createElement("circle", { cx: "12", cy: "12", r: "8.5" }),
            React.createElement("path", { d: "M12 7v5.5l3.5 2" })));
    if (name === "card")
        return (React.createElement("svg", { ...common },
            React.createElement("rect", { x: "2.5", y: "5.5", width: "19", height: "13", rx: "2" }),
            React.createElement("path", { d: "M2.5 10h19M6 15h4" })));
    if (name === "coin")
        return (React.createElement("svg", { ...common },
            React.createElement("circle", { cx: "12", cy: "12", r: "8.5" }),
            React.createElement("path", { d: "M8 9h8M12 9v7" })));
    if (name === "dots")
        return (React.createElement("svg", { ...common },
            React.createElement("circle", { cx: "6", cy: "12", r: "1.2", fill: color }),
            React.createElement("circle", { cx: "12", cy: "12", r: "1.2", fill: color }),
            React.createElement("circle", { cx: "18", cy: "12", r: "1.2", fill: color })));
    if (name === "user")
        return (React.createElement("svg", { ...common },
            React.createElement("circle", { cx: "12", cy: "8", r: "4" }),
            React.createElement("path", { d: "M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" })));
    if (name === "eye")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z" }),
            React.createElement("circle", { cx: "12", cy: "12", r: "3" })));
    if (name === "calendar")
        return (React.createElement("svg", { ...common },
            React.createElement("rect", { x: "3.5", y: "5", width: "17", height: "15", rx: "2" }),
            React.createElement("path", { d: "M3.5 10h17M8 3v4M16 3v4" })));
    if (name === "arrowUp")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M12 19V5M5 12l7-7 7 7" })));
    if (name === "plus")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M12 5v14M5 12h14" })));
    if (name === "check")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M5 12l5 5 9-10" })));
    if (name === "arrowUpRight")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M7 17L17 7M8 7h9v9" })));
    if (name === "grid")
        return (React.createElement("svg", { ...common },
            React.createElement("rect", { x: "4", y: "4", width: "6.5", height: "6.5", rx: "1.6" }),
            React.createElement("rect", { x: "13.5", y: "4", width: "6.5", height: "6.5", rx: "1.6" }),
            React.createElement("rect", { x: "4", y: "13.5", width: "6.5", height: "6.5", rx: "1.6" }),
            React.createElement("rect", { x: "13.5", y: "13.5", width: "6.5", height: "6.5", rx: "1.6" })));
    if (name === "caret")
        return (React.createElement("svg", { ...common },
            React.createElement("path", { d: "M6 9l6 6 6-6" })));
    return null;
};
const RoundButton = ({ name, onClick }) => (React.createElement("button", { onClick: onClick, className: "tx-round-button relative w-11 h-11 rounded-[10px] flex items-center justify-center shrink-0 tap", style: CARD_SOFT },
    React.createElement(Icon, { name: name, size: 18, color: TEXT })));
const WalletAction = ({ icon, label, onClick }) => (React.createElement("button", { onClick: onClick, className: "tx-wallet-action flex items-center justify-center gap-2.5 rounded-[10px] tap ui-hit px-2", style: { height: 58, ...CARD_SOFT } },
    React.createElement(Icon, { name: icon, size: 18, color: TEXT }),
    React.createElement("span", { className: "text-[12px] font-medium truncate", style: { color: TEXT } }, label)));
export { Icon, RoundButton, WalletAction };

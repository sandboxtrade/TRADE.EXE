import React, { useEffect, useMemo, useRef, useState } from "react";
import { TIMEFRAMES, buildCandles } from "../features/market.js";
import { clamp } from "../core/engine.js";
import { ACTIVE_LANG, tr, clock, tfLabel } from "../i18n/index.js";
import { BG, RAISED, HAIR, TEXT, DIM, FAINT, LONG, SHORT, CARD, CARD_BG, CARD_BG_SOFT, CHART_UP_FILL, CHART_UP_STROKE, CHART_DOWN_FILL, CHART_DOWN_STROKE, CHART_WICK, CHART_LINE, CHART_LINE_FAINT, CHART_VOL_UP, CHART_VOL_DOWN, CHART_PRICE_BG, CHART_PRICE_STROKE, fmt } from "./theme.js";
const AXIS_W = 56;
const VOL_H = 44;
const PAD_T = 10, PAD_B = 6;
const BAR_MIN = 2.0, BAR_MAX = 40, BAR_DEFAULT = 8;
const Y_MIN = 0.2, Y_MAX = 6;
const HISTORY_CANDLES = 2000;
function Chart({ state, timeframe, mode, entryPrice, stopLoss, takeProfit, liquidationPrice, side, onLevel, eyes }) {
    const box = useRef(null);
    const [size, setSize] = useState({ w: 360, h: 300 });
    useEffect(() => {
        const el = box.current;
        if (!el)
            return;
        const read = () => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                setSize((p) => (Math.abs(p.w - r.width) < 1 && Math.abs(p.h - r.height) < 1
                    ? p : { w: r.width, h: r.height }));
            }
        };
        read();
        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", read);
            return () => window.removeEventListener("resize", read);
        }
        const ro = new ResizeObserver(read);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const [barW, setBarW] = useState(BAR_DEFAULT);
    const [offset, setOffset] = useState(0);
    const [yZoom, setYZoom] = useState(1);
    const view = useRef({ barW, offset, yZoom });
    view.current = { barW, offset, yZoom };
    const scale = useRef(null);
    const geo = useRef({});
    const [drag, setDrag] = useState(null);
    const dragRef = useRef(null);
    dragRef.current = drag;
    const viewRaf = useRef(0);
    const viewQueued = useRef({});
    const queueView = (patch) => {
        Object.assign(viewQueued.current, patch);
        if (viewRaf.current)
            return;
        viewRaf.current = requestAnimationFrame(() => {
            viewRaf.current = 0;
            const q = viewQueued.current;
            viewQueued.current = {};
            if (Number.isFinite(q.barW)) {
                const next = clamp(q.barW, BAR_MIN, BAR_MAX);
                setBarW((prev) => Math.abs(prev - next) < 0.12 ? prev : next);
            }
            if (Number.isFinite(q.yZoom)) {
                const next = clamp(q.yZoom, Y_MIN, Y_MAX);
                setYZoom((prev) => Math.abs(prev - next) < 0.008 ? prev : next);
            }
            if (Number.isFinite(q.offset)) {
                const next = Math.max(0, Math.round(q.offset));
                setOffset((prev) => prev === next ? prev : next);
            }
        });
    };
    const queueYZoom = (next) => queueView({ yZoom: next });
    useEffect(() => () => {
        if (viewRaf.current)
            cancelAnimationFrame(viewRaf.current);
        viewRaf.current = 0;
        viewQueued.current = {};
    }, []);
    const auto = offset === 0 && Math.abs(yZoom - 1) < 0.02 && Math.abs(barW - BAR_DEFAULT) < 0.1;
    useEffect(() => () => {
        if (viewRaf.current)
            cancelAnimationFrame(viewRaf.current);
    }, []);
    useEffect(() => {
        setBarW(BAR_DEFAULT);
        setOffset(0);
        setYZoom(1);
        scale.current = null;
    }, [timeframe]);
    useEffect(() => {
        const el = box.current;
        if (!el)
            return;
        let one = null, two = null, grab = null, lastTap = 0, lastX = 0, lastY = 0;
        const spread = (t) => ({
            x: Math.abs(t[0].clientX - t[1].clientX),
            y: Math.abs(t[0].clientY - t[1].clientY),
        });
        const priceAt = (clientY) => {
            const g = geo.current;
            const top = el.getBoundingClientRect().top;
            const y = clientY - top;
            const k = (g.padT + g.plotH - y) / g.plotH;
            return g.min + k * (g.max - g.min);
        };
        const yOf = (price) => {
            const g = geo.current;
            return g.padT + g.plotH - ((price - g.min) / (g.max - g.min)) * g.plotH;
        };
        const start = (e) => {
            if (e.touches.length === 2) {
                const s = spread(e.touches);
                two = { sx: Math.max(1, s.x), sy: Math.max(1, s.y),
                    useX: s.x >= 24, useY: s.y >= 24, ...view.current };
                one = null;
                grab = null;
                return;
            }
            if (e.touches.length !== 1)
                return;
            const g = geo.current;
            const top = el.getBoundingClientRect().top;
            const y = e.touches[0].clientY - top;
            grab = null;
            if (g.side) {
                for (const kind of ["sl", "tp"]) {
                    const v = kind === "sl" ? g.stopLoss : g.takeProfit;
                    if (v && Math.abs(yOf(v) - y) < 16) {
                        grab = { kind };
                        break;
                    }
                }
            }
            if (grab) {
                setDrag({ kind: grab.kind, price: priceAt(e.touches[0].clientY) });
                return;
            }
            one = { x: e.touches[0].clientX, y: e.touches[0].clientY, offset: view.current.offset };
            const now = Date.now();
            if (now - lastTap < 320 && Math.abs(e.touches[0].clientY - lastY) < 24
                && Math.abs(e.touches[0].clientX - lastX) < 24) {
                if (g.side && g.onLevel) {
                    const price = priceAt(e.touches[0].clientY);
                    const above = price > g.entryPrice;
                    const kind = (g.side === "long") === above ? "tp" : "sl";
                    g.onLevel(kind, price);
                }
                else {
                    setBarW(g.fitAll || BAR_DEFAULT);
                    setOffset(0);
                    setYZoom(1);
                }
                lastTap = 0;
                return;
            }
            lastTap = now;
            lastX = e.touches[0].clientX;
            lastY = e.touches[0].clientY;
        };
        const move = (e) => {
            if (e.touches.length === 2 && two) {
                e.preventDefault();
                const s = spread(e.touches);
                const kx = two.useX ? clamp(Math.max(1, s.x) / two.sx, 0.25, 4) : 1;
                const ky = two.useY ? clamp(Math.max(1, s.y) / two.sy, 0.25, 4) : 1;
                queueView({ barW: two.barW * kx, yZoom: two.yZoom * ky });
                return;
            }
            if (e.touches.length === 1 && grab) {
                e.preventDefault();
                setDrag({ kind: grab.kind, price: priceAt(e.touches[0].clientY) });
                return;
            }
            if (e.touches.length === 1 && one) {
                const dx = e.touches[0].clientX - one.x;
                if (Math.abs(dx) < 6)
                    return;
                e.preventDefault();
                queueView({ offset: clamp(one.offset + dx / Math.max(BAR_MIN, view.current.barW), 0, HISTORY_CANDLES) });
            }
        };
        const end = (e) => {
            if (e.touches.length !== 0)
                return;
            if (grab) {
                const g = geo.current;
                const d = dragRef.current;
                if (d && g.onLevel)
                    g.onLevel(d.kind, d.price);
                setDrag(null);
            }
            one = null;
            two = null;
            grab = null;
        };
        const wheel = (e) => {
            e.preventDefault();
            const k = e.deltaY > 0 ? 0.9 : 1.11;
            queueView({ barW: view.current.barW * k, yZoom: view.current.yZoom * k });
        };
        el.addEventListener("touchstart", start, { passive: true });
        el.addEventListener("touchmove", move, { passive: false });
        el.addEventListener("touchend", end, { passive: true });
        el.addEventListener("touchcancel", end, { passive: true });
        el.addEventListener("wheel", wheel, { passive: false });
        return () => {
            el.removeEventListener("touchstart", start);
            el.removeEventListener("touchmove", move);
            el.removeEventListener("touchend", end);
            el.removeEventListener("touchcancel", end);
            el.removeEventListener("wheel", wheel);
        };
    }, []);
    const axis = useRef(null);
    useEffect(() => {
        const el = axis.current;
        if (!el)
            return;
        let grab = null;
        const start = (e) => {
            if (e.touches.length !== 1)
                return;
            grab = { y: e.touches[0].clientY, z: view.current.yZoom };
        };
        const move = (e) => {
            if (!grab || e.touches.length !== 1)
                return;
            e.preventDefault();
            const dy = e.touches[0].clientY - grab.y;
            queueYZoom(grab.z * Math.pow(2, dy / 160));
        };
        const end = () => { grab = null; };
        el.addEventListener("touchstart", start, { passive: true });
        el.addEventListener("touchmove", move, { passive: false });
        el.addEventListener("touchend", end, { passive: true });
        el.addEventListener("touchcancel", end, { passive: true });
        return () => {
            el.removeEventListener("touchstart", start);
            el.removeEventListener("touchmove", move);
            el.removeEventListener("touchend", end);
            el.removeEventListener("touchcancel", end);
        };
    }, []);
    const W = size.w, H = size.h;
    const plotW = Math.max(40, W - AXIS_W);
    const plotH = Math.max(60, H - VOL_H - PAD_T - PAD_B);
    const volTop = PAD_T + plotH + 4;
    const bucketMs = TIMEFRAMES.find((t) => t.label === timeframe)?.ms ?? 1000;
    const need = Math.min(HISTORY_CANDLES, Math.ceil(plotW / barW) + offset + 8);
    const all = useMemo(() => buildCandles(state.priceHistory, bucketMs, need), [state.tick, state.lastPoint?.t, state.lastPoint?.price, state.priceHistory.length, bucketMs, need]);
    const fit = Math.max(4, Math.ceil(plotW / barW));
    const span0 = state.priceHistory.length
        ? state.priceHistory[state.priceHistory.length - 1].t - state.priceHistory[0].t : 0;
    const totalCandles = Math.max(4, Math.min(HISTORY_CANDLES, Math.ceil(span0 / bucketMs) + 1));
    const fitAllBarW = clamp(plotW / totalCandles, BAR_MIN, BAR_MAX);
    const maxOffset = Math.max(0, all.length - fit);
    const effectiveOffset = Math.min(offset, maxOffset);
    const end = Math.max(1, all.length - effectiveOffset);
    const shown = all.slice(Math.max(0, end - fit), end);
    useEffect(() => {
        setOffset((prev) => (prev > maxOffset ? maxOffset : prev));
    }, [maxOffset]);
    let lo = Infinity, hi = -Infinity;
    const volSamples = [];
    for (const c of shown) {
        lo = Math.min(lo, c.low);
        hi = Math.max(hi, c.high);
        if (c.volume > 0)
            volSamples.push(c.volume);
    }
    volSamples.sort((a, b) => a - b);
    const volRef = volSamples.length
        ? volSamples[Math.min(volSamples.length - 1, Math.floor((volSamples.length - 1) * 0.90))]
        : 0;
    for (const lvl of [entryPrice, stopLoss, takeProfit, liquidationPrice]) {
        if (lvl && lvl > lo * 0.94 && lvl < hi * 1.06) {
            lo = Math.min(lo, lvl);
            hi = Math.max(hi, lvl);
        }
    }
    if (shown.length < 1 || !Number.isFinite(lo) || !Number.isFinite(hi)) {
        return (React.createElement("div", { ref: box, className: "w-full h-full flex items-center justify-center text-[12px]", style: { minHeight: 110 } },
            React.createElement("span", { style: { color: FAINT } }, tr("собираем свечи…"))));
    }
    const mid = (hi + lo) / 2;
    const half = Math.max((hi - lo) / 2, mid * 0.0008) * 1.12 / yZoom;
    const tMin = mid - half, tMax = mid + half;
    const prev = scale.current;
    const viewJump = !prev || prev.tf !== timeframe || prev.off !== effectiveOffset
        || Math.abs((prev?.z ?? yZoom) - yZoom) > 0.004;
    const CONTRACT = 0.10;
    let min, max;
    if (viewJump) {
        min = tMin;
        max = tMax;
    }
    else {
        min = tMin < prev.min ? tMin : prev.min + (tMin - prev.min) * CONTRACT;
        max = tMax > prev.max ? tMax : prev.max + (tMax - prev.max) * CONTRACT;
    }
    scale.current = { min, max, tf: timeframe, z: yZoom, off: effectiveOffset };
    const span = max - min || 1;
    const toY = (p) => PAD_T + plotH - ((p - min) / span) * plotH;
    geo.current = { min, max, plotH, padT: PAD_T, side, entryPrice, onLevel, fitAll: fitAllBarW,
        stopLoss: drag?.kind === "sl" ? drag.price : stopLoss,
        takeProfit: drag?.kind === "tp" ? drag.price : takeProfit };
    const last = shown[shown.length - 1];
    const xAt = (i) => shown.length === 1
        ? plotW * 0.72
        : plotW - barW / 2 - ((last.t - shown[i].t) / bucketMs) * barW;
    const body = Math.max(1, Math.min(barW * 0.68, barW - 1.2));
    const wick = Math.max(0.7, Math.min(1.4, barW * 0.12));
    const step = niceStep(span / 4);
    const lines = [];
    for (let p = Math.ceil(min / step) * step; p <= max; p += step)
        lines.push(p);
    const digits = step < 0.1 ? 3 : step < 1 ? 2 : 1;
    const priceY = clamp(toY(state.price), PAD_T, PAD_T + plotH);
    const level = (value, label, dash, color, strong) => value && value > min && value < max ? (React.createElement("g", { key: label },
        React.createElement("line", { x1: 0, x2: plotW, y1: toY(value), y2: toY(value), stroke: color, strokeWidth: strong ? 1.6 : 1, strokeDasharray: dash, opacity: strong ? 1 : 0.75 }),
        React.createElement("rect", { x: 2, y: toY(value) - 13, width: label.length * 5.6 + 8, height: 12, rx: 2, fill: BG, opacity: 0.75 }),
        React.createElement("text", { x: 6, y: toY(value) - 4, fill: color, fontSize: 9, fontFamily: "RodchenkoDigits, Neogurotesuku, monospace" }, label),
        strong && (React.createElement(React.Fragment, null,
            React.createElement("rect", { x: plotW + 1, y: toY(value) - 8, width: AXIS_W - 2, height: 16, rx: 3, fill: BG, stroke: color, strokeWidth: 1 }),
            React.createElement("text", { x: plotW + AXIS_W / 2, y: toY(value) + 4, textAnchor: "middle", fill: color, fontSize: 10, fontFamily: "RodchenkoDigits, Neogurotesuku, monospace" }, value.toFixed(2)))))) : null;
    return (React.createElement("div", { ref: box, className: "w-full h-full relative select-none", style: { minHeight: 160, touchAction: "none" } },
        shown.length < 2 && bucketMs > 1000 && (React.createElement("div", { className: "absolute inset-x-0 top-[44%] z-10 flex justify-center pointer-events-none" },
            React.createElement("div", { className: "px-2.5 py-1 rounded text-[10px]", style: { backgroundColor: "rgba(12,12,14,.9)", color: DIM, border: `1px solid ${HAIR}` } }, ACTIVE_LANG === "en"
                ? `${tfLabel(timeframe)}: history is building · ${shown.length} ${shown.length === 1 ? "candle" : "candles"}`
                : `${timeframe}: история накапливается · сейчас ${shown.length} ${shown.length === 1 ? "свеча" : "свечи"}`))),
        !auto && (React.createElement("button", { onClick: () => { setBarW(BAR_DEFAULT); setOffset(0); setYZoom(1); }, className: "absolute top-1 left-1 z-10 min-h-[36px] px-2.5 rounded-lg text-[10px] font-mono tap", style: { backgroundColor: RAISED, color: DIM, border: `1px solid ${HAIR}` } }, ACTIVE_LANG === "en"
            ? `${shown.length} candles${effectiveOffset ? ` · −${effectiveOffset}` : ""} · reset`
            : `${shown.length} св.${effectiveOffset ? ` · −${effectiveOffset}` : ""} · сброс`)),
        React.createElement("div", { ref: axis, className: "absolute top-0 right-0 z-10", style: { width: AXIS_W, height: PAD_T + plotH, touchAction: "none" } }),
        React.createElement("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: { overflow: "hidden" } },
            lines.map((p) => (React.createElement("g", { key: p },
                React.createElement("line", { x1: 0, x2: plotW, y1: toY(p), y2: toY(p), stroke: HAIR, strokeWidth: 1 }),
                React.createElement("text", { x: plotW + 6, y: toY(p) + 3.5, fill: FAINT, fontSize: 10.5, fontFamily: "RodchenkoDigits, Neogurotesuku, monospace" }, p.toFixed(digits))))),
            eyes && eyes.length > 0 && (() => {
                const vis = [];
                for (const c of eyes) {
                    if (c.max < min || c.min > max)
                        continue;
                    const y1 = toY(c.max), y2 = toY(c.min);
                    const near = vis.find((v) => v.type === c.type && v.side === c.side
                        && Math.abs((v.y1 + v.y2) / 2 - (y1 + y2) / 2) < 26);
                    if (near) {
                        near.y1 = Math.min(near.y1, y1);
                        near.y2 = Math.max(near.y2, y2);
                        near.volume += c.volume;
                        near.participants += c.participants;
                        near.merged++;
                    }
                    else {
                        vis.push({ ...c, y1, y2, merged: 1 });
                    }
                }
                const top = vis.sort((a, b) => b.volume - a.volume).slice(0, 6);
                const maxV = Math.max(1, ...top.map((c) => c.volume));
                return top.map((c) => {
                    const color = c.type === "STOP" ? SHORT : LONG;
                    const h = Math.max(3, c.y2 - c.y1);
                    const alpha = 0.07 + (c.volume / maxV) * 0.16;
                    const thin = c.status === "THINNING";
                    return (React.createElement("g", { key: c.key, opacity: thin ? 0.55 : 1 },
                        React.createElement("rect", { x: 0, y: c.y1, width: plotW, height: h, fill: color, opacity: alpha }),
                        React.createElement("line", { x1: 0, x2: plotW, y1: c.y1, y2: c.y1, stroke: color, strokeWidth: 0.8, opacity: 0.5, strokeDasharray: thin ? "2 4" : "" }),
                        React.createElement("line", { x1: 0, x2: plotW, y1: c.y2, y2: c.y2, stroke: color, strokeWidth: 0.8, opacity: 0.5, strokeDasharray: thin ? "2 4" : "" }),
                        React.createElement("text", { x: 5, y: c.y1 + h / 2 + 3, fontSize: 9, fontFamily: "RodchenkoDigits, Neogurotesuku, monospace", fill: color, opacity: 0.95 },
                            c.type,
                            " ",
                            c.side,
                            " \u00B7 ",
                            fmt(c.volume, 0),
                            " \u00B7 ",
                            c.participants)));
                });
            })(),
            mode === "свечи" ? (React.createElement("g", null, shown.map((c, i) => {
                const x = xAt(i);
                if (x < -barW)
                    return null;
                const grow = c.close >= c.open;
                const fill = grow ? CHART_UP_FILL : CHART_DOWN_FILL;
                const stroke = grow ? CHART_UP_STROKE : CHART_DOWN_STROKE;
                const top = toY(Math.max(c.open, c.close));
                const bottom = toY(Math.min(c.open, c.close));
                return (React.createElement("g", { key: c.t },
                    React.createElement("rect", { x: x - wick / 2, y: toY(c.high), width: wick, height: Math.max(0.6, toY(c.low) - toY(c.high)), fill: CHART_WICK, opacity: 0.95 }),
                    React.createElement("rect", { x: x - body / 2, y: top, width: body, height: Math.max(1, bottom - top), fill: fill, stroke: stroke, strokeWidth: 1, rx: body > 5 ? 1 : 0 })));
            }))) : (() => {
                const pts = shown.map((c, i) => `${xAt(i).toFixed(1)},${toY(c.close).toFixed(1)}`);
                const trend = CHART_LINE;
                if (shown.length === 1) {
                    const x = xAt(0), y = toY(shown[0].close);
                    return (React.createElement("g", null,
                        React.createElement("line", { x1: Math.max(0, x - 16), x2: Math.min(plotW, x + 16), y1: y, y2: y, stroke: trend, strokeWidth: 1.6, strokeLinecap: "round" }),
                        React.createElement("circle", { cx: x, cy: y, r: 2.6, fill: trend })));
                }
                return (React.createElement("g", null,
                    React.createElement("defs", null,
                        React.createElement("linearGradient", { id: "tx-area", x1: "0", y1: "0", x2: "0", y2: "1" },
                            React.createElement("stop", { offset: "0%", stopColor: trend, stopOpacity: "0.18" }),
                            React.createElement("stop", { offset: "100%", stopColor: trend, stopOpacity: "0" }))),
                    React.createElement("polygon", { fill: "url(#tx-area)", points: `${pts.join(" ")} ${xAt(shown.length - 1)},${PAD_T + plotH} ${xAt(0)},${PAD_T + plotH}`, opacity: "0.9" }),
                    React.createElement("polyline", { points: pts.join(" "), fill: "none", stroke: trend, strokeWidth: 1.6, strokeLinejoin: "round", strokeLinecap: "round" })));
            })(),
            level(entryPrice, `${ACTIVE_LANG === "en" ? "entry" : "вход"} ${entryPrice?.toFixed(2)}`, "6 4", TEXT, true),
            level(liquidationPrice, `${ACTIVE_LANG === "en" ? "liquidation" : "ликвидация"} ${liquidationPrice?.toFixed(2)}`, "2 2", SHORT, true),
            (() => {
                const sl = drag?.kind === "sl" ? drag.price : stopLoss;
                const tp = drag?.kind === "tp" ? drag.price : takeProfit;
                return (React.createElement(React.Fragment, null,
                    level(sl, `${ACTIVE_LANG === "en" ? "stop" : "стоп"} ${sl?.toFixed(2)}`, "4 3", SHORT, drag?.kind === "sl"),
                    level(tp, `${ACTIVE_LANG === "en" ? "take" : "тейк"} ${tp?.toFixed(2)}`, "4 3", LONG, drag?.kind === "tp")));
            })(),
            shown.map((c, i) => {
                const x = xAt(i);
                if (x < -barW)
                    return null;
                const h = volRef === 0 ? 0 : Math.min(1, c.volume / volRef) * (VOL_H - 6);
                return React.createElement("rect", { key: `v${c.t}`, x: x - body / 2, y: volTop + (VOL_H - 6 - h), width: body, height: Math.max(0.5, h), fill: c.close >= c.open ? CHART_VOL_UP : CHART_VOL_DOWN, rx: body > 5 ? 1 : 0 });
            }),
            React.createElement("line", { x1: 0, x2: plotW, y1: priceY, y2: priceY, stroke: CHART_LINE_FAINT, strokeWidth: 1, strokeDasharray: "2 4" }),
            React.createElement("rect", { x: plotW + 1.5, y: priceY - 10, width: AXIS_W - 3, height: 20, rx: 4, fill: CHART_PRICE_BG, stroke: CHART_PRICE_STROKE, strokeWidth: 1.1 }),
            React.createElement("text", { x: plotW + AXIS_W / 2, y: priceY + 4, textAnchor: "middle", fill: TEXT, fontSize: 11.5, fontFamily: "RodchenkoDigits, Neogurotesuku, monospace", fontWeight: "700" }, state.price.toFixed(2)))));
}
function niceStep(raw) {
    if (!Number.isFinite(raw) || raw <= 0)
        return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return mult * pow;
}
const EYES_FILTERS = ["ВСЁ", "STOP", "TAKE", "LONG", "SHORT"];
function pressureOf(side) {
    return side === "LONG" ? tr("потенциальное давление продаж")
        : tr("потенциальное давление покупок");
}
function eyesFilter(list, f) {
    if (f === "ВСЁ")
        return list;
    if (f === "STOP" || f === "TAKE")
        return list.filter((c) => c.type === f);
    return list.filter((c) => c.side === f);
}
function EyesPanel({ eyes, filter, onFilter, view, onView }) {
    const t = eyes.totals;
    const list = eyesFilter(view === "LIVE" ? eyes.live : eyes.history, filter);
    const card = CARD;
    return (React.createElement("div", { className: "px-4 pb-4" },
        React.createElement("div", { className: "rounded-2xl px-4 py-3.5 mt-2", style: card },
            React.createElement("div", { className: "flex items-center justify-between" },
                React.createElement("span", { className: "text-[11px] tracking-[0.11em]", style: { color: LONG } }, "EYES"),
                React.createElement("div", { className: "flex gap-1" }, ["LIVE", "HISTORY"].map((v) => (React.createElement("button", { key: v, onClick: () => onView(v), className: "px-2.5 py-1 rounded text-[10px] tracking-[0.1em] tap", style: { backgroundColor: v === view ? "#1B1B1F" : RAISED,
                        color: v === view ? TEXT : DIM, border: `1px solid ${v === view ? "#3A393D" : HAIR}` } }, v))))),
            React.createElement("div", { className: "grid grid-cols-3 gap-3 mt-3" },
                React.createElement("div", null,
                    React.createElement("div", { className: "text-[9px] tracking-[0.10em]", style: { color: FAINT } }, "STOP FLOW"),
                    React.createElement("div", { className: "text-[15px] font-mono mt-1", style: { color: SHORT } }, fmt(t.stopFlow, 0))),
                React.createElement("div", null,
                    React.createElement("div", { className: "text-[9px] tracking-[0.10em]", style: { color: FAINT } }, "TAKE FLOW"),
                    React.createElement("div", { className: "text-[15px] font-mono mt-1", style: { color: LONG } }, fmt(t.takeFlow, 0))),
                React.createElement("div", null,
                    React.createElement("div", { className: "text-[9px] tracking-[0.10em]", style: { color: FAINT } }, tr("КЛАСТЕРОВ")),
                    React.createElement("div", { className: "text-[15px] font-mono mt-1" },
                        t.stopClusters,
                        " / ",
                        t.takeClusters))),
            React.createElement("div", { className: "flex gap-1.5 mt-3 overflow-x-auto no-scrollbar" }, EYES_FILTERS.map((f) => (React.createElement("button", { key: f, onClick: () => onFilter(f), className: "px-3 py-1.5 rounded-lg text-[10px] tracking-[0.1em] shrink-0 tap", style: { backgroundColor: f === filter ? "#1B1B1F" : RAISED,
                    color: f === filter ? TEXT : DIM, border: `1px solid ${f === filter ? "#3A393D" : HAIR}` } }, f === "ВСЁ" ? tr("ВСЁ") : f))))),
        list.length === 0 ? (React.createElement("div", { className: "rounded-2xl py-8 text-center text-[12px] mt-2", style: { ...card, color: FAINT } }, view === "LIVE" ? tr("активных зон нет") : tr("история пока пуста"))) : (React.createElement("div", { className: "flex flex-col gap-2 mt-2" }, list.slice(0, 14).map((c) => {
            const color = c.type === "STOP" ? SHORT : LONG;
            return (React.createElement("div", { key: c.key + (c.at ?? ""), className: "rounded-xl px-4 py-3", style: card },
                React.createElement("div", { className: "flex items-center justify-between gap-3" },
                    React.createElement("span", { className: "text-[12px] tracking-[0.1em] font-semibold", style: { color } },
                        c.type,
                        " ",
                        c.side),
                    React.createElement("span", { className: "text-[11px] font-mono", style: { color: FAINT } }, c.min === c.max ? fmt(c.min) : `${fmt(c.min)} — ${fmt(c.max)}`)),
                React.createElement("div", { className: "flex items-center justify-between gap-3 mt-1.5" },
                    React.createElement("span", { className: "text-[15px] font-mono" }, fmt(c.volume, 0)),
                    React.createElement("span", { className: "text-[11px]", style: { color: DIM } },
                        c.participants,
                        " ",
                        ACTIVE_LANG === "en" ? "participants" : "уч.",
                        " \u00B7 ",
                        c.status === "NEW" ? "NEW" : clock(c.age || 0))),
                React.createElement("div", { className: "flex items-center justify-between gap-3 mt-1.5" },
                    React.createElement("span", { className: "text-[11px]", style: { color: FAINT } }, pressureOf(c.side)),
                    React.createElement("span", { className: "text-[10px] tracking-[0.1em]", style: { color: c.status === "TRIGGERED" ? color
                                : c.status === "THINNING" ? DIM : FAINT } }, c.status)),
                c.trail && c.trail.length > 1 && (React.createElement("div", { className: "text-[10px] font-mono mt-1.5", style: { color: FAINT } }, c.trail.map((v) => fmt(v, 0)).join(" → ")))));
        })))));
}
function Metric({ label, value, color = TEXT }) {
    return (React.createElement("div", { className: "min-w-0" },
        React.createElement("div", { className: "text-[9px] tracking-[0.1em] leading-[1.15] mb-1.5", style: { color: FAINT } }, label),
        React.createElement("div", { className: "text-[15px] leading-none font-mono truncate", style: { color } }, value)));
}
function Line({ left, right, color }) {
    return (React.createElement("div", { className: "flex items-center justify-between gap-3 min-h-[42px] py-2.5 border-b", style: { borderColor: HAIR } },
        React.createElement("span", { className: "text-[12px] leading-snug min-w-0", style: { color: DIM } }, left),
        React.createElement("span", { className: "text-[12px] font-mono whitespace-nowrap shrink-0", style: { color: color ?? TEXT } }, right)));
}
const Blank = ({ children }) => (React.createElement("div", { className: "text-[12px] py-9 text-center", style: { color: FAINT } }, children));
function Toggle({ active, onClick, children }) {
    return (React.createElement("button", { onClick: onClick, className: "ui-hit min-w-[44px] px-3 rounded-[9px] text-[12px] font-medium tap", style: { color: active ? TEXT : DIM,
            background: active ? "#111112" : CARD_BG_SOFT,
            border: `1px solid ${active ? "#2D2D30" : HAIR}`,
            boxShadow: "none" } }, children));
}
const BackButton = ({ onClick, label = "Назад" }) => (React.createElement("button", { onClick: onClick, "aria-label": label === "Назад" ? tr("Назад") : label, className: "ui-back tap shrink-0" },
    React.createElement("span", { "aria-hidden": "true", className: "text-[19px] leading-none -translate-y-px" }, "\u2190")));
export { Chart, EyesPanel, Metric, Line, Blank, Toggle, BackButton, niceStep, EYES_FILTERS, eyesFilter };

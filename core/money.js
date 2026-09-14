function sanitizeMoneyInput(value, decimals = 2) {
    let raw = String(value ?? "").replace(/,/g, ".").replace(/[^0-9.]/g, "");
    const dot = raw.indexOf(".");
    if (dot !== -1) {
        raw = raw.slice(0, dot + 1) + raw.slice(dot + 1).replace(/\./g, "");
        const [whole, frac = ""] = raw.split(".");
        raw = `${whole}.${frac.slice(0, decimals)}`;
    }
    return raw;
}
function parseMoneyInput(value) {
    const normalized = sanitizeMoneyInput(value);
    const n = Number(normalized);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
}
export { sanitizeMoneyInput, parseMoneyInput };

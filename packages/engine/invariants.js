"use strict";
const { CONFIG } = require("./config");

/**
 * INVARIANT CHECKER. Вызывается после КАЖДОГО тика.
 * При нарушении возвращает отчёт, достаточный для воспроизведения.
 */
function checkInvariants(m, ctx = {}) {
  const errs = [];
  const { TOL_CAPITAL: TC, TOL_NONNEG: TN } = CONFIG;
  const totalCash = m.players.reduce((a, p) => a + p.cash, 0);

  if (Math.abs(totalCash + m.escrow - m.C) > TC)
    errs.push(`Σcash+escrow ≠ C: ${(totalCash + m.escrow - m.C).toExponential(3)}`);
  if (Math.abs(m.sumEquity() - m.C) > TC)
    errs.push(`Σequity ≠ C: ${(m.sumEquity() - m.C).toExponential(3)}`);
  if (m.escrow < -TN) errs.push(`escrow < 0: ${m.escrow}`);

  const price = m.mark;
  if (price < m.curve.PMIN - TN || price > m.curve.PMAX + TN)
    errs.push(`price вне [${m.curve.PMIN}, ${m.curve.PMAX}]: ${price}`);

  for (const p of m.players) {
    if (p.cash < -TN) errs.push(`cash < 0 у #${p.id}: ${p.cash}`);
    if (m.equity(p.id) < -TN) errs.push(`equity < 0 у #${p.id}: ${m.equity(p.id)}`);
    if (!Number.isFinite(p.cash) || !Number.isFinite(p.u))
      errs.push(`не-число у #${p.id}`);
  }

  if (errs.length) {
    return {
      ok: false,
      halt: true,
      report: {
        tick: m.tick, seed: m.seed, Q: m.Q, price, escrow: m.escrow,
        sumEquity: m.sumEquity(), C: m.C, errors: errs, context: ctx,
      },
    };
  }
  return { ok: true };
}
module.exports = { checkInvariants };

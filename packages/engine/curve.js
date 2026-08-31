"use strict";
const { CONFIG } = require("./config");

/**
 * Ценовая кривая и резервная функция.
 *
 * p(Q) = P0 * (1 + beta * tanh(Q/kappa))          -- цена состояния (mark)
 * R(Q) = P0 * [Q + beta*kappa*ln cosh(Q/kappa)]   -- резерв, интеграл p по [0,Q]
 *
 * R имеет ЗАМКНУТУЮ форму. Это не косметика: цена клиринга есть
 * (R(Q+dQ)-R(Q))/dQ, и без замкнутой формы её пришлось бы интегрировать
 * численно, из-за чего сохранение капитала стало бы приближённым.
 * Именно поэтому выбрана эта кривая, а не мультипликативно-симметричная
 * exp(tanh) (MODEL-V2, разд. B).
 */
function makeCurve(totalCapital) {
  const { P0, beta, THETA } = CONFIG;
  const kappa = totalCapital / (P0 * THETA);
  const PMIN = P0 * (1 - beta);
  const PMAX = P0 * (1 + beta);

  const p = (Q) => P0 * (1 + beta * Math.tanh(Q / kappa));
  const R = (Q) => P0 * (Q + beta * kappa * Math.log(Math.cosh(Q / kappa)));

  /**
   * Стоимость позиции u при цене P. ОБЕ стороны платят вперёд, взнос >= 0:
   *   лонг  вносит u * P
   *   шорт  вносит |u| * (PMAX - P)
   * Отсюда escrow >= 0 всегда, а equity >= 0 структурно.
   */
  const value = (u, P) => (u > 0 ? u * P : u < 0 ? -u * (PMAX - P) : 0);

  /**
   * ЕДИНАЯ цена клиринга тика = средняя цена кривой на отрезке чистого сдвига.
   * Единственная цена, совместимая с сохранением капитала: собранные деньги
   * dQ*P* в точности равны изменению резерва R(Q+dQ)-R(Q).
   * Не зависит от вида кривой — выводится только из сохранения.
   */
  const clearingPrice = (Q, dQ) =>
    Math.abs(dQ) < CONFIG.EPS ? p(Q) : (R(Q + dQ) - R(Q)) / dQ;

  /**
   * Цена ПОЛНОЙ ликвидации рынка (Q -> 0). На ней считается CLOSE VALUE.
   * Выбор именно этой цены даёт Sum(settlement) = escrow тождественно,
   * а значит Sum(equity) = C (FINAL-AUDIT-V2, вопрос 4).
   */
  const liquidationPrice = (Q) => (Math.abs(Q) < CONFIG.EPS ? p(0) : R(Q) / Q);

  /** Размер позиции: СИММЕТРИЧНЫЙ перевод денег в units.
   *  budget/P для лонга и budget/(PMAX-P) для шорта давали шорту в 1.33 раза
   *  больше экспозиции за те же деньги -> систематический дрейф вниз и
   *  эксплойт "всегда шорт" (t=65.6). Общий знаменатель это устраняет
   *  (ATTACK-AND-STRATEGIES, разд. 2). */
  const unitsFor = (budget, P) => budget / Math.max(P, PMAX - P);

  return { kappa, PMIN, PMAX, p, R, value, clearingPrice, liquidationPrice, unitsFor };
}
module.exports = { makeCurve };

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const k = require('./konsultkalkyl.js');

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('defaultInputs mirrors the contracting spreadsheet', () => {
  const d = k.defaultInputs();
  assert.equal(d.rate, 1000);
  assert.equal(d.hoursPerWeek, 40);
  assert.equal(d.weeksPerYear - d.holidayWeeks - d.sickWeeks, 40); // 52-6-6 → 40 billable weeks
  assert.equal(d.corporateTaxPct, 20.6);
  assert.equal(d.dividendAllowance, 322400);
});

test('billable hours and revenue', () => {
  const r = k.computeContracting();
  assert.equal(r.billableWeeks, 40);
  assert.equal(r.billableHours, 1600);     // 40 weeks × 40 h
  assert.equal(r.revenue, 1600000);        // 1600 h × 1000 kr
});

test('löneväxling splits gross into cash salary + pension', () => {
  const r = k.computeContracting();
  assert.equal(r.grossSalary, 744000);     // 62 000 × 12
  assert.equal(r.lonevaxling, 99996);      // 8 333 × 12
  assert.equal(r.cashSalary, 744000 - 99996);
});

test('employer fee is charged on the cash salary at 31.42 %', () => {
  const r = k.computeContracting({ lonevaxlingMonthly: 0 });
  near(r.employerFee, 744000 * 0.3142, 1); // 233 765
});

test('särskild löneskatt (24.26 %) is charged on the pension premium', () => {
  const r = k.computeContracting();
  near(r.sarskildLoneskatt, r.lonevaxling * 0.2426, 1);
});

test('profit deducts the full salary cost incl. pension (sheet correction)', () => {
  const r = k.computeContracting();
  near(r.totalSalaryCost, r.cashSalary + r.employerFee + r.lonevaxling + r.sarskildLoneskatt, 1);
  near(r.profitBeforeTax, r.revenue - r.totalSalaryCost - r.otherCost, 1);
});

test('corporate tax is 20.6 % of profit before tax', () => {
  const r = k.computeContracting();
  near(r.corporateTax, r.profitBeforeTax * 0.206, 1);
  near(r.profitAfterTax, r.profitBeforeTax - r.corporateTax, 1);
});

test('dividend is capped at the 3:12 grundbelopp and taxed at 20 %', () => {
  const r = k.computeContracting();
  assert.equal(r.dividend, 322400);          // profitAfterTax > allowance → capped
  near(r.netDividend, 322400 * 0.8, 1);      // 257 920
  near(r.retainedProfit, r.profitAfterTax - 322400, 1);
});

test('dividend is limited by available profit when profit is small', () => {
  const r = k.computeContracting({ rate: 600 }); // low revenue → small profit
  assert.ok(r.dividend <= Math.max(0, r.profitAfterTax) + 1);
  assert.ok(r.dividend <= 322400);
});

test('grundavdrag matches Skatteverket 2026 anchors (round up to 100)', () => {
  assert.equal(k.grundavdrag(50000, k.PBB_2026), 25100);    // low-income standard
  assert.equal(k.grundavdrag(170000, k.PBB_2026), 45600);   // maximum (2.72–3.11 PBB)
  assert.equal(k.grundavdrag(900000, k.PBB_2026), 17400);   // high-income floor
});

test('no state tax below the 2026 brytpunkt, 20 % above it', () => {
  const below = k.computeContracting(); // cash salary ~644k → taxable < 643 000
  assert.equal(below.stateTax, 0);
  const above = k.computeContracting({ grossSalaryMonthly: 80000, lonevaxlingMonthly: 0 });
  assert.ok(above.stateTax > 0);
  near(above.stateTax, (above.taxableIncome - k.STATE_TAX_SKIKTGRANS) * 0.20, 1);
});

test('jobbskatteavdrag is near the 2026 max on the plateau', () => {
  const r = k.computeContracting(); // ~53.7k/mån cash → plateau
  near(r.workTaxCredit, 52392, 800); // Skatteverket 2026 max ≈ 4 366 kr/mån
});

test('net salary = cash salary − municipal − state + work tax credit', () => {
  const r = k.computeContracting();
  near(r.netSalary, r.cashSalary - r.municipalTax - r.stateTax + r.workTaxCredit, 1);
});

test('total net income = net salary + net dividend (retained profit excluded)', () => {
  const r = k.computeContracting();
  near(r.totalNetIncome, r.netSalary + r.netDividend, 1);
  assert.ok(r.takeHomeRate > 0 && r.takeHomeRate < 1);
});

test('zero billable weeks → no revenue, no negative explosions', () => {
  const r = k.computeContracting({ holidayWeeks: 30, sickWeeks: 30 });
  assert.equal(r.billableWeeks, 0);
  assert.equal(r.revenue, 0);
  assert.equal(r.corporateTax, 0);   // no positive profit
  assert.equal(r.dividend, 0);
});

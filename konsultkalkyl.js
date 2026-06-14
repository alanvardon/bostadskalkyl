/* konsultkalkyl.js — Konsultkalkyl: contracting through your own AB in Sweden.
   "What could it pay to go independent?" — turns an hourly rate into the full
   year: company revenue, salary + employer fees, corporate tax, a 3:12 dividend
   and finally what lands in your own pocket.

   The pure math section is exported for node tests; everything below the DOM
   guard only runs in the browser.

   All tax constants are for INCOME YEAR 2026. Sources (Skatteverket "Belopp och
   procent 2026" + the 2026 3:12 reform):
     • Bolagsskatt (corporate tax) ............ 20.6 %
     • Arbetsgivaravgift (employer fee) ....... 31.42 %
     • Särskild löneskatt (on pension) ........ 24.26 %
     • Prisbasbelopp (PBB) .................... 59 200 kr
     • Inkomstbasbelopp (IBB) ................. 83 400 kr
     • Statlig skatt: 20 % over skiktgräns .... 643 000 kr (taxable income)
     • 3:12 grundbelopp (new 2026 unified rule) 4 × IBB(2025 80 600) = 322 400 kr
     • Utdelningsskatt inom gränsbelopp ....... 20 %
     • Jobbskatteavdrag (max, under 66) ....... ~52 392 kr/år (4 366 kr/mån)

   NOTE vs. the original spreadsheet this replaces: the sheet left two things out
   that this tool corrects — (1) the löneväxling (pension) is a real company cost
   and is deducted from profit, and (2) särskild löneskatt (24.26 %) is charged on
   that pension premium. Both lower profit/dividend slightly but are correct. */
(function () {
  'use strict';

  // ── 2026 constants ───────────────────────────────────────────────
  var PBB_2026 = 59200;          // prisbasbelopp
  var STATE_TAX_SKIKTGRANS = 643000;  // taxable income where statlig skatt (20 %) starts
  var STATE_TAX_RATE = 0.20;

  // ── Pure: defaults ───────────────────────────────────────────────
  // Salary / löneväxling / other-cost are MONTHLY; rates are percentages.
  function defaultInputs() {
    return {
      rate: 1000,          // kr per billable hour
      hoursPerWeek: 40,
      weeksPerYear: 52,
      holidayWeeks: 6,     // semester
      sickWeeks: 6,        // sjuk / VAB
      grossSalaryMonthly: 62000,   // total gross you draw (cash + löneväxling)
      lonevaxlingMonthly: 8333,    // salary exchanged into pension
      otherCostMonthly: 5000,      // accountant, insurance, work computer …
      // Rates — 2026 defaults, editable
      employerFeePct: 31.42,
      sarskildLoneskattPct: 24.26,
      corporateTaxPct: 20.6,
      municipalTaxPct: 32.38,      // national average; set your kommun's rate
      dividendAllowance: 322400,   // 3:12 grundbelopp (4 × IBB 2025)
      dividendTaxPct: 20
    };
  }

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : (parseFloat(v) || 0); }

  // Grundavdrag for employment income, under 66, 2026 (bracket formula in PBB,
  // rounded UP to nearest 100 kr — gives Skatteverket's 25 100 / 45 600 / 17 400).
  function grundavdrag(income, pbb) {
    var ff = Math.max(0, income);
    var g;
    if (ff <= 0.99 * pbb)      g = 0.423 * pbb;
    else if (ff <= 2.72 * pbb) g = 0.423 * pbb + 0.20 * (ff - 0.99 * pbb);
    else if (ff <= 3.11 * pbb) g = 0.77 * pbb;
    else if (ff <= 7.88 * pbb) g = 0.77 * pbb - 0.10 * (ff - 3.11 * pbb);
    else                       g = 0.293 * pbb;
    return Math.ceil(g / 100) * 100;
  }

  // Jobbskatteavdrag (skattereduktion för arbetsinkomst), under 66, 2026.
  // Plateau + 3 % phase-out match Skatteverket's published 2026 max (≈52 392 kr at
  // the average municipal rate); the rising sub-brackets below ~40 000 kr/mån are a
  // continuous approximation (contractor salaries normally sit on the plateau).
  function jobbskatteavdrag(arbetsinkomst, ga, kommunalRate, pbb) {
    var ai = Math.max(0, arbetsinkomst);
    var PLATEAU = 3.027;   // calibrated so plateau = 2026 max at avg kommunalskatt
    var base;
    if (ai <= 0.91 * pbb) {
      base = ai;
    } else if (ai <= 3.24 * pbb) {
      base = 0.91 * pbb + 0.3874 * (ai - 0.91 * pbb);
    } else if (ai <= 8.08 * pbb) {
      var b2end = 0.91 * pbb + 0.3874 * (3.24 - 0.91) * pbb;   // value at 3.24 PBB
      var slope = (PLATEAU * pbb - b2end) / ((8.08 - 3.24) * pbb);
      base = b2end + slope * (ai - 3.24 * pbb);
    } else if (ai <= 13.54 * pbb) {
      base = PLATEAU * pbb;
    } else {
      base = PLATEAU * pbb - 0.03 * (ai - 13.54 * pbb);   // phase-out for high incomes
    }
    return Math.max(0, (base - ga) * kommunalRate);
  }

  // The whole picture, in yearly kronor (the DOM divides by 12 for the monthly
  // column). Every figure is a plain number so tests can assert on it directly.
  function computeContracting(input) {
    var d = Object.assign(defaultInputs(), input || {});

    // ── Billing → revenue ──
    var billableWeeks = Math.max(0, num(d.weeksPerYear) - num(d.holidayWeeks) - num(d.sickWeeks));
    var billableHours = billableWeeks * num(d.hoursPerWeek);
    var revenue = billableHours * num(d.rate);

    // ── Salary (löneväxling splits gross into cash + pension) ──
    var grossSalary = num(d.grossSalaryMonthly) * 12;
    var lonevaxling = Math.min(num(d.lonevaxlingMonthly) * 12, grossSalary);
    var cashSalary  = grossSalary - lonevaxling;   // taxable cash salary

    // ── Company costs ──
    var employerFee       = cashSalary * num(d.employerFeePct) / 100;       // arbetsgivaravgift on cash salary
    var sarskildLoneskatt = lonevaxling * num(d.sarskildLoneskattPct) / 100; // on the pension premium
    var otherCost         = num(d.otherCostMonthly) * 12;
    var totalSalaryCost   = cashSalary + employerFee + lonevaxling + sarskildLoneskatt;

    // ── Corporate profit & tax ──
    var profitBeforeTax = revenue - totalSalaryCost - otherCost;
    var corporateTax    = Math.max(0, profitBeforeTax) * num(d.corporateTaxPct) / 100;
    var profitAfterTax  = profitBeforeTax - corporateTax;

    // ── 3:12 dividend (up to the gränsbelopp, capped by available profit) ──
    var dividend       = Math.min(Math.max(0, profitAfterTax), num(d.dividendAllowance));
    var dividendTax    = dividend * num(d.dividendTaxPct) / 100;
    var netDividend    = dividend - dividendTax;
    var retainedProfit = profitAfterTax - dividend;

    // ── Personal income tax on the cash salary ──
    var kommunalRate  = num(d.municipalTaxPct) / 100;
    var ga            = grundavdrag(cashSalary, PBB_2026);
    var taxableIncome = Math.max(0, cashSalary - ga);
    var municipalTax  = taxableIncome * kommunalRate;
    var stateTax      = Math.max(0, taxableIncome - STATE_TAX_SKIKTGRANS) * STATE_TAX_RATE;
    var jsaRaw        = jobbskatteavdrag(cashSalary, ga, kommunalRate, PBB_2026);
    var workTaxCredit = Math.min(jsaRaw, municipalTax + stateTax);   // can't exceed the tax it reduces
    var netSalary     = cashSalary - municipalTax - stateTax + workTaxCredit;

    // ── What actually lands in your pocket ──
    var totalNetIncome = netSalary + netDividend;
    var totalTax = employerFee + sarskildLoneskatt + corporateTax + dividendTax
                 + municipalTax + stateTax - workTaxCredit;

    return {
      billableWeeks: billableWeeks,
      billableHours: billableHours,
      revenue: revenue,
      grossSalary: grossSalary,
      lonevaxling: lonevaxling,
      cashSalary: cashSalary,
      employerFee: employerFee,
      sarskildLoneskatt: sarskildLoneskatt,
      otherCost: otherCost,
      totalSalaryCost: totalSalaryCost,
      profitBeforeTax: profitBeforeTax,
      corporateTax: corporateTax,
      profitAfterTax: profitAfterTax,
      dividend: dividend,
      dividendTax: dividendTax,
      netDividend: netDividend,
      retainedProfit: retainedProfit,
      grundavdrag: ga,
      taxableIncome: taxableIncome,
      municipalTax: municipalTax,
      stateTax: stateTax,
      workTaxCredit: workTaxCredit,
      netSalary: netSalary,
      totalNetIncome: totalNetIncome,
      totalTax: totalTax,
      // headline ratios
      takeHomeRate: revenue > 0 ? totalNetIncome / revenue : 0,
      effectiveTaxRate: revenue > 0 ? totalTax / revenue : 0
    };
  }

  var api = {
    PBB_2026: PBB_2026,
    STATE_TAX_SKIKTGRANS: STATE_TAX_SKIKTGRANS,
    defaultInputs: defaultInputs,
    grundavdrag: grundavdrag,
    jobbskatteavdrag: jobbskatteavdrag,
    computeContracting: computeContracting
  };

  // Browser export
  if (typeof window !== 'undefined') {
    window.App = window.App || {};
    window.App.konsult = api;
  }
  // Guarded CJS export for node --test (konsultkalkyl.test.js)
  if (typeof module !== 'undefined') module.exports = api;

  // ────────────────────────────────────────────────────────────────
  // DOM wiring (browser only)
  // ────────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !document.getElementById('o-revenue-y')) return;

  var STORAGE_KEY = 'bostadskalkyl_konsult_v1';
  var C = window.App.calc;

  // input id → state key, with formatting kind ('cur' = thousands-spaced, 'num' = plain)
  var FIELDS = [
    { id: 'in-rate',              key: 'rate',                 kind: 'cur' },
    { id: 'in-hours',             key: 'hoursPerWeek',         kind: 'num' },
    { id: 'in-weeks',             key: 'weeksPerYear',         kind: 'num' },
    { id: 'in-holidays',          key: 'holidayWeeks',         kind: 'num' },
    { id: 'in-sick',              key: 'sickWeeks',            kind: 'num' },
    { id: 'in-gross',             key: 'grossSalaryMonthly',   kind: 'cur' },
    { id: 'in-lonevaxling',       key: 'lonevaxlingMonthly',   kind: 'cur' },
    { id: 'in-other',             key: 'otherCostMonthly',     kind: 'cur' },
    { id: 'in-employerFee',       key: 'employerFeePct',       kind: 'num' },
    { id: 'in-sarskild',          key: 'sarskildLoneskattPct', kind: 'num' },
    { id: 'in-corpTax',           key: 'corporateTaxPct',      kind: 'num' },
    { id: 'in-municipalTax',      key: 'municipalTaxPct',      kind: 'num' },
    { id: 'in-dividendAllowance', key: 'dividendAllowance',    kind: 'cur' },
    { id: 'in-dividendTax',       key: 'dividendTaxPct',       kind: 'num' }
  ];

  // result key → [monthly element id, yearly element id]
  var PAIRS = [
    ['revenue',           'o-revenue-m',           'o-revenue-y'],
    ['grossSalary',       'o-grossSalary-m',       'o-grossSalary-y'],
    ['lonevaxling',       'o-lonevaxling-m',       'o-lonevaxling-y'],
    ['cashSalary',        'o-cashSalary-m',        'o-cashSalary-y'],
    ['employerFee',       'o-employerFee-m',       'o-employerFee-y'],
    ['sarskildLoneskatt', 'o-sarskildLoneskatt-m', 'o-sarskildLoneskatt-y'],
    ['otherCost',         'o-otherCost-m',         'o-otherCost-y'],
    ['totalSalaryCost',   'o-totalSalaryCost-m',   'o-totalSalaryCost-y'],
    ['profitBeforeTax',   'o-profitBeforeTax-m',   'o-profitBeforeTax-y'],
    ['corporateTax',      'o-corporateTax-m',      'o-corporateTax-y'],
    ['profitAfterTax',    'o-profitAfterTax-m',    'o-profitAfterTax-y'],
    ['dividend',          'o-dividend-m',          'o-dividend-y'],
    ['dividendTax',       'o-dividendTax-m',       'o-dividendTax-y'],
    ['netDividend',       'o-netDividend-m',       'o-netDividend-y'],
    ['retainedProfit',    'o-retainedProfit-m',    'o-retainedProfit-y'],
    ['municipalTax',      'o-municipalTax-m',      'o-municipalTax-y'],
    ['stateTax',          'o-stateTax-m',          'o-stateTax-y'],
    ['workTaxCredit',     'o-workTaxCredit-m',     'o-workTaxCredit-y'],
    ['netSalary',         'o-netSalary-m',         'o-netSalary-y']
  ];

  var state = load();

  function load() {
    var s = defaultInputs();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        Object.keys(s).forEach(function (k) {
          if (typeof saved[k] === 'number' && isFinite(saved[k])) s[k] = saved[k];
        });
      }
    } catch (_) {}
    return s;
  }

  var saveTimer = null;
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    var badge = document.getElementById('saveState');
    if (!badge) return;
    badge.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { badge.classList.remove('show'); }, 1400);
  }

  // ── Formatters ──
  function money(n) { return C.formatWithSpaces(Math.round(n)) + ' kr'; }
  function pct0(x) { return Math.round(x) + ' %'; }
  function numStr(n) {
    // plain number, Swedish decimal comma, no trailing zeros
    return (Math.round(n * 100) / 100).toString().replace('.', ',');
  }
  function curStr(n) { return C.formatWithSpaces(Math.round(n)); }

  function setText(id, str) {
    var el = document.getElementById(id);
    if (el) el.textContent = str;
  }

  function fieldByInput(id) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].id === id) return FIELDS[i];
    return null;
  }

  // ── Populate inputs from state ──
  function fillInputs() {
    FIELDS.forEach(function (f) {
      var el = document.getElementById(f.id);
      if (!el) return;
      el.value = f.kind === 'cur' ? curStr(state[f.key]) : numStr(state[f.key]);
    });
  }

  // ── Recalculate & render ──
  function recalc() {
    var r = computeContracting(state);

    PAIRS.forEach(function (p) {
      setText(p[1], money(r[p[0]] / 12));
      setText(p[2], money(r[p[0]]));
    });

    // billing readout
    setText('o-billableHours', C.formatWithSpaces(r.billableHours) + ' h');
    setText('o-revenueMini', money(r.revenue));

    // hero
    setText('o-totalNet-m', money(r.totalNetIncome / 12));
    setText('o-totalNet-y', money(r.totalNetIncome));
    setText('o-totalNetLedger-m', money(r.totalNetIncome / 12));
    setText('o-totalNetLedger-y', money(r.totalNetIncome));
    setText('o-takeHomeRate', pct0(r.takeHomeRate * 100));
    setText('o-retained-m', money(r.retainedProfit / 12));
    setText('o-effTax', pct0(r.effectiveTaxRate * 100));

    // hero salary/dividend split bar
    var net = r.totalNetIncome > 0 ? r.totalNetIncome : 1;
    var salShare = Math.max(0, Math.min(100, (r.netSalary / net) * 100));
    var hs = document.getElementById('hsSalary');
    var hd = document.getElementById('hsDividend');
    if (hs) hs.style.width = salShare.toFixed(1) + '%';
    if (hd) hd.style.width = (100 - salShare).toFixed(1) + '%';
    setText('hl-salary', money(r.netSalary / 12));
    setText('hl-dividend', money(r.netDividend / 12));

    // live rate labels in the ledger
    setText('lbl-employerFee', numStr(state.employerFeePct) + ' %');
    setText('lbl-sarskild', numStr(state.sarskildLoneskattPct) + ' %');
    setText('lbl-corpTax', numStr(state.corporateTaxPct) + ' %');
    setText('lbl-dividendTax', numStr(state.dividendTaxPct) + ' %');
    setText('lbl-municipalTax', numStr(state.municipalTaxPct) + ' %');

    // mobile bar
    setText('m-net', money(r.totalNetIncome / 12));
    setText('m-rate', pct0(r.takeHomeRate * 100));
  }

  // ── Input handling (delegated) ──
  document.querySelector('.inputs-col').addEventListener('input', function (e) {
    var f = fieldByInput(e.target.id);
    if (!f) return;
    state[f.key] = C.parseFormatted(e.target.value);
    recalc();
    save();
  });

  // tidy up the displayed value on blur (re-format currency with spaces)
  document.querySelector('.inputs-col').addEventListener('focusout', function (e) {
    var f = fieldByInput(e.target.id);
    if (!f) return;
    e.target.value = f.kind === 'cur' ? curStr(state[f.key]) : numStr(state[f.key]);
  });

  // ── Reset ──
  var resetBtn = document.getElementById('resetBtn');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    state = defaultInputs();
    fillInputs();
    recalc();
    save();
  });

  // ── Theme toggle (shared key with the rest of Hemma) ──
  var THEME_KEY = 'bostadskalkyl_theme';
  var themeBtn = document.getElementById('themeToggleBtn');

  function applyThemeIcon() {
    if (themeBtn) themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? '☾' : '☀';
  }
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  }
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyThemeIcon();
    syncThemeColor();
  });
  applyThemeIcon();
  syncThemeColor();

  // ── Boot ──
  fillInputs();
  recalc();
}());

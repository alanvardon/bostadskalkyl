/* mortgagetracker.js — Bolånekoll: the mortgage tracker.

   You download a CSV of mortgage transactions from the bank every so often and
   today paste it into a Google Sheet to watch how much of the home you own
   versus how much the bank still owns. This tool replaces that: import the CSV,
   track each loan part (lånedel), enter the property's value over time, and see
   the equity split between both owners — at a glance and over the months.

   The bank export is a LEDGER: one row per entry, with a type column
   (Specifikation: "Betalning", "Ränta", "Amortering", "Lån"…), a single signed
   amount (Belopp) and a running balance (Saldo). An interest-only month shows a
   Ränta charge and an equal Betalning that cancel out, so the principal is flat;
   an amortising month shows the Saldo step down. We therefore trust the Saldo
   column as the source of truth for the outstanding balance when it's present,
   and fall back to start-balance-minus-amortisation when it isn't.

   This file is the PURE core — CSV parsing, column auto-mapping, row
   classification and the balance/equity math. No DOM dependency; shared 1:1
   between the browser (window.App.mortgage) and the node tests (module.exports).
   The page controller is below the document guard; persistence is in
   mortgagetracker-store.js. Owners are keys 'a' and 'b' with editable names. */
(function () {
  'use strict';

  function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  // ── Settings ────────────────────────────────────────────────────────────
  function defaultSettings() {
    return {
      property_name: '',
      owner_a_name: 'Alex',
      owner_b_name: 'Sam',
      my_ownership_pct: 50,
      i_am: 'a',
      currency: 'SEK',
      ranteavdrag: true
    };
  }
  function otherOwner(p) { return p === 'a' ? 'b' : 'a'; }

  // ── CSV parsing (shared, identical to Månadsavslut's battle-tested layer) ──
  function detectDelimiter(text) {
    var firstLine = String(text || '').split(/\r?\n/)[0] || '';
    var candidates = [',', ';', '\t'];
    var best = ',', bestCount = -1;
    candidates.forEach(function (d) {
      var count = firstLine.split(d).length - 1;
      if (count > bestCount) { bestCount = count; best = d; }
    });
    return best;
  }

  function parseCsv(text, opts) {
    opts = opts || {};
    if (text == null) return { delimiter: ',', headers: [], rows: [] };
    var s = String(text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip BOM
    var delim = opts.delimiter || detectDelimiter(s);

    var all = [];
    var field = '';
    var row = [];
    var inQuotes = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else { field += c; }
        continue;
      }
      if (c === '"') { inQuotes = true; }
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\r') { /* swallow; the \n closes the row */ }
      else if (c === '\n') { row.push(field); all.push(row); field = ''; row = []; }
      else { field += c; }
    }
    row.push(field);
    all.push(row);
    all = all.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });

    return { delimiter: delim, headers: all.length ? all[0] : [], rows: all.slice(1) };
  }

  // Parse a money string into a number, robust to locale (space/dot thousands,
  // comma OR dot decimals, currency suffixes, accounting parens, unicode minus).
  function parseAmount(raw) {
    if (raw == null) return NaN;
    var s = String(raw).trim();
    if (!s) return NaN;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/−/g, '-');
    if (s.indexOf('-') !== -1) neg = true;
    s = s.replace(/[^0-9.,]/g, '');
    if (!s) return NaN;
    var lastComma = s.lastIndexOf(',');
    var lastDot = s.lastIndexOf('.');
    var decSep = lastComma > lastDot ? ',' : (lastDot > -1 ? '.' : '');
    if (decSep) {
      var thouSep = decSep === ',' ? '.' : ',';
      s = s.split(thouSep).join('').replace(decSep, '.');
    }
    var n = parseFloat(s);
    if (isNaN(n)) return NaN;
    return neg ? -n : n;
  }

  // Majority sign of the non-zero amounts. Exported as part of the shared CSV
  // toolkit; the importer normalises with abs() since amounts are magnitudes.
  function inferSpendSign(amounts) {
    var pos = 0, neg = 0;
    (amounts || []).forEach(function (n) {
      n = Number(n);
      if (!isFinite(n) || n === 0) return;
      if (n > 0) pos++; else neg++;
    });
    return neg > pos ? -1 : 1;
  }

  // ── Column auto-mapping ─────────────────────────────────────────────────
  // The ledger export has a date, a TYPE column (Specifikation), a single signed
  // amount (Belopp) and a running balance (Saldo). Returns the matched column
  // INDEX for each (or null), pre-filling the dropdowns; everything is overridable.
  function autoMapColumns(headers) {
    var H = (headers || []).map(function (h) { return String(h == null ? '' : h).toLowerCase().trim(); });
    function find(re, avoid) {
      for (var i = 0; i < H.length; i++) {
        if (re.test(H[i]) && !(avoid && avoid.test(H[i]))) return i;
      }
      return null;
    }
    return {
      date: find(/(date|datum|bokf|transaktionsdat|betald|betalningsdag)/),
      specification: find(/(specifikation|transaktionstyp|\btyp\b|type|kind|slag|text|beskriv|händelse|handelse)/),
      amount: find(/(belopp|amount|summa|transaktionsbelopp|debet|kredit)/, /(saldo|balance)/),
      balance: find(/(saldo|kvar|restskuld|aktuell skuld|balance|återstå|aterstå)/),
      loan_number: find(/(lånenummer|lanenummer|lånenr|lanenr|kontonummer|account)/)
    };
  }

  // Classify a ledger row by its type/Specifikation text. Order matters:
  // amortisation ("avbetalning") is checked before the looser "betalning".
  function classifyKind(text) {
    var s = String(text == null ? '' : text).toLowerCase();
    if (/ränta|ranta|interest/.test(s)) return 'interest';
    if (/amorter|amort|principal|avbetal/.test(s)) return 'amortization';
    if (/betalning|payment|inbet|överför|overfor|insättning|insattning/.test(s)) return 'payment';
    if (/\blån\b|\blan\b|utbetalning|disburs|loan|uttag|nyutl/.test(s)) return 'loan';
    if (/avgift|fee|aviavgift/.test(s)) return 'fee';
    return 'other';
  }

  // ── Row builders ────────────────────────────────────────────────────────
  function makeLoanPart(partial) {
    partial = partial || {};
    var rate = partial.interest_rate;
    return {
      label: partial.label || '',
      loan_number: partial.loan_number || '',
      start_balance: _round2(Number(partial.start_balance) || 0),
      start_date: partial.start_date || '',
      interest_rate: (rate == null || rate === '') ? null : Number(rate),
      archived: !!partial.archived
    };
  }

  // Normalise a ledger entry. `kind` classifies the row; `amount` and
  // `balance_after` are stored as positive magnitudes (the bank exports debt as
  // a negative Saldo — we keep the outstanding debt as a positive number).
  function makePayment(partial) {
    partial = partial || {};
    var kind = partial.kind || classifyKind(partial.description || partial.specification || '');
    var amount = _round2(Math.abs(Number(partial.amount) || 0));
    var bal = partial.balance_after;
    return {
      loan_part_id: partial.loan_part_id || null,
      date: partial.date || '',
      kind: kind,
      description: partial.description || '',
      amount: amount,
      balance_after: (bal == null || bal === '') ? null : _round2(Math.abs(Number(bal) || 0)),
      source: partial.source || 'manual'
    };
  }

  // ── Duplicate spotting on re-import ───────────────────────────────────────
  function paymentFingerprint(p) {
    p = p || {};
    var date = String(p.date == null ? '' : p.date).trim();
    var part = p.loan_part_id || '';
    var kind = p.kind || '';
    var amount = Math.round((Number(p.amount) || 0) * 100) / 100;
    return date + '|' + part + '|' + kind + '|' + amount;
  }
  function flagDuplicates(existing, candidates) {
    var counts = {};
    (existing || []).forEach(function (p) {
      if (!p) return;
      var k = paymentFingerprint(p);
      counts[k] = (counts[k] || 0) + 1;
    });
    return (candidates || []).map(function (c) {
      if (!c) return false;
      var k = paymentFingerprint(c);
      if (counts[k] > 0) { counts[k]--; return true; }
      return false;
    });
  }

  // ── Assigning imported rows to a loan part ────────────────────────────────
  function _normNum(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\s-]/g, ''); }
  function assignPaymentsToPart(loanNumbers, parts, opts) {
    opts = opts || {};
    var fallback = opts.selectedPartId || null;
    var auto = !!opts.auto;
    var byNumber = {};
    (parts || []).forEach(function (p) {
      if (p && p.loan_number != null && String(p.loan_number).trim() !== '') {
        byNumber[_normNum(p.loan_number)] = p.id;
      }
    });
    return (loanNumbers || []).map(function (raw) {
      if (auto && raw != null && String(raw).trim() !== '') {
        var hit = byNumber[_normNum(raw)];
        if (hit) return { loan_part_id: hit, matched: true };
      }
      return { loan_part_id: fallback, matched: false };
    });
  }

  // ── Mortgage math ─────────────────────────────────────────────────────────
  // A part's outstanding balance. When the ledger carries a Saldo (balance_after)
  // we trust it — taking the latest date's SETTLED (post-payment, i.e. smallest)
  // balance, so an interest-charge row doesn't inflate the figure. Without any
  // Saldo we fall back to start balance minus booked amortisation.
  function partBalance(part, payments) {
    if (!part) return 0;
    var entries = (payments || []).filter(function (p) { return p && p.loan_part_id === part.id; });
    var withBal = entries.filter(function (p) { return p.balance_after != null; });
    if (withBal.length) {
      var latestDate = withBal.reduce(function (mx, p) { var d = String(p.date || ''); return d > mx ? d : mx; }, '');
      var sameDate = withBal.filter(function (p) { return String(p.date || '') === latestDate; });
      var bal = sameDate.reduce(function (mn, p) { var b = Number(p.balance_after) || 0; return (mn == null || b < mn) ? b : mn; }, null);
      return Math.max(0, _round2(bal));
    }
    var start = Number(part.start_balance) || 0;
    var startDate = String(part.start_date || '');
    var amort = 0;
    entries.forEach(function (p) {
      if (p.kind !== 'amortization') return;
      if (startDate && p.date && String(p.date) < startDate) return;
      amort += Number(p.amount) || 0;
    });
    return Math.max(0, _round2(start - amort));
  }

  // The part's original principal: the user's start balance if set, else the
  // "Lån" disbursement amount, else the earliest settled balance seen.
  function partOriginal(part, payments) {
    if (part && Number(part.start_balance) > 0) return _round2(Number(part.start_balance));
    var entries = (payments || []).filter(function (p) { return p && p.loan_part_id === (part && part.id); });
    var loans = entries.filter(function (p) { return p.kind === 'loan'; });
    if (loans.length) return _round2(Math.max.apply(null, loans.map(function (p) { return Number(p.amount) || 0; })));
    var withBal = entries.filter(function (p) { return p.balance_after != null; });
    if (withBal.length) {
      var earliest = withBal.reduce(function (mn, p) { var d = String(p.date || ''); return (mn == null || d < mn) ? d : mn; }, null);
      var same = withBal.filter(function (p) { return String(p.date || '') === earliest; });
      return _round2(Math.max.apply(null, same.map(function (p) { return Number(p.balance_after) || 0; })));
    }
    return partBalance(part, payments);
  }
  function partAmortized(part, payments) { return Math.max(0, _round2(partOriginal(part, payments) - partBalance(part, payments))); }

  function totalBalance(parts, payments) {
    return _round2((parts || []).reduce(function (s, p) {
      return (!p || p.archived) ? s : s + partBalance(p, payments);
    }, 0));
  }
  function totalAmortized(parts, payments) {
    return _round2((parts || []).reduce(function (s, p) {
      return (!p || p.archived) ? s : s + partAmortized(p, payments);
    }, 0));
  }
  // Interest paid = sum of the interest-kind ("Ränta") rows.
  function totalInterest(payments, opts) {
    opts = opts || {};
    var sum = 0;
    (payments || []).forEach(function (p) {
      if (!p || p.kind !== 'interest') return;
      if (opts.loan_part_id && p.loan_part_id !== opts.loan_part_id) return;
      if (opts.from && p.date && String(p.date) < opts.from) return;
      if (opts.to && p.date && String(p.date) > opts.to) return;
      sum += Number(p.amount) || 0;
    });
    return _round2(sum);
  }

  // Swedish ränteavdrag: 30% of interest up to 100 000 kr, 21% on the part above.
  function ranteavdrag(annualInterest) {
    var n = Number(annualInterest) || 0;
    if (n <= 0) return 0;
    var lower = Math.min(n, 100000);
    var upper = Math.max(0, n - 100000);
    return _round2(lower * 0.30 + upper * 0.21);
  }

  function latestValuation(valuations, asOf) {
    var best = null;
    (valuations || []).forEach(function (v) {
      if (!v) return;
      var d = String(v.date || '');
      if (!d) return;
      if (asOf && d > asOf) return;
      if (!best || d > String(best.date || '')) best = v;
    });
    return best;
  }
  function propertyValue(valuations, asOf) {
    var v = latestValuation(valuations, asOf);
    return v ? (Number(v.value) || 0) : 0;
  }

  function equity(value, balance) { return _round2((Number(value) || 0) - (Number(balance) || 0)); }
  function loanToValue(balance, value) {
    var v = Number(value) || 0;
    if (v <= 0) return 0;
    return _round2((Number(balance) || 0) / v * 100);
  }
  function _clampPct(pct, dflt) {
    var p = Number(pct);
    if (!isFinite(p)) p = dflt;
    return Math.max(0, Math.min(100, p));
  }
  function myShareEquity(equityVal, pct) {
    return _round2((Number(equityVal) || 0) * _clampPct(pct, 0) / 100);
  }
  // Split equity between the two owners by the stored ownership %. Returns { a, b }.
  function ownerSplit(equityVal, settings) {
    settings = settings || {};
    var me = settings.i_am === 'b' ? 'b' : 'a';
    var myPct = _clampPct(settings.my_ownership_pct, 50);
    var mine = _round2((Number(equityVal) || 0) * myPct / 100);
    var res = {};
    res[me] = mine;
    res[otherOwner(me)] = _round2((Number(equityVal) || 0) - mine);
    return res;
  }
  // Each owner's ownership percentage, as { a, b }.
  function ownerPercents(settings) {
    settings = settings || {};
    var me = settings.i_am === 'b' ? 'b' : 'a';
    var myPct = _clampPct(settings.my_ownership_pct, 50);
    var res = {};
    res[me] = myPct;
    res[otherOwner(me)] = _round2(100 - myPct);
    return res;
  }

  // ── Month helpers (for the timeline) ──────────────────────────────────────
  function monthKey(dateStr) {
    var s = String(dateStr == null ? '' : dateStr).trim();
    var m = /(\d{4})[-/](\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2];
    m = /(\d{2})[./](\d{2})[./](\d{4})/.exec(s);
    if (m) return m[3] + '-' + m[2];
    return '';
  }
  function monthLabel(mk) {
    if (!mk) return 'Utan datum · No date';
    var m = /^(\d{4})-(\d{2})$/.exec(mk);
    if (!m) return mk;
    try {
      var s = new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' });
      return s.charAt(0).toUpperCase() + s.slice(1);
    } catch (_) { return mk; }
  }
  function _enumerateMonths(startMk, endMk) {
    var out = [];
    var y = Number(startMk.slice(0, 4)), mo = Number(startMk.slice(5, 7));
    var endY = Number(endMk.slice(0, 4)), endMo = Number(endMk.slice(5, 7));
    var guard = 0;
    while ((y < endY || (y === endY && mo <= endMo)) && guard < 1200) {
      out.push(y + '-' + (mo < 10 ? '0' : '') + mo);
      mo++; if (mo > 12) { mo = 1; y++; }
      guard++;
    }
    return out;
  }
  function _monthRange(parts, payments) {
    var keys = [];
    (parts || []).forEach(function (p) { var k = monthKey(p && p.start_date); if (k) keys.push(k); });
    (payments || []).forEach(function (p) { var k = monthKey(p && p.date); if (k) keys.push(k); });
    if (!keys.length) return [];
    keys.sort();
    return _enumerateMonths(keys[0], keys[keys.length - 1]);
  }
  // A part's settled balance as of month `mk`: the latest Saldo on/before mk
  // (carried forward), else start-minus-amortisation. Mirrors partBalance.
  function _partBalanceAsOf(part, payments, mk) {
    var entries = (payments || []).filter(function (p) { return p && p.loan_part_id === part.id; });
    var withBal = entries.filter(function (p) {
      var pmk = monthKey(p.date);
      return p.balance_after != null && pmk && pmk <= mk;
    });
    if (withBal.length) {
      var latestMonth = withBal.reduce(function (mx, p) { var k = monthKey(p.date); return k > mx ? k : mx; }, '');
      var inMonth = withBal.filter(function (p) { return monthKey(p.date) === latestMonth; });
      var latestDate = inMonth.reduce(function (mx, p) { var d = String(p.date || ''); return d > mx ? d : mx; }, '');
      var sameDate = inMonth.filter(function (p) { return String(p.date || '') === latestDate; });
      var bal = sameDate.reduce(function (mn, p) { var b = Number(p.balance_after) || 0; return (mn == null || b < mn) ? b : mn; }, null);
      return Math.max(0, _round2(bal));
    }
    var start = Number(part.start_balance) || 0;
    var startDate = String(part.start_date || '');
    var amort = 0;
    entries.forEach(function (p) {
      if (p.kind !== 'amortization') return;
      var pmk = monthKey(p.date);
      if (!pmk || pmk > mk) return;
      if (startDate && p.date && String(p.date) < startDate) return;
      amort += Number(p.amount) || 0;
    });
    return Math.max(0, _round2(start - amort));
  }
  function balanceTimeline(parts, payments) {
    var active = (parts || []).filter(function (p) { return p && !p.archived; });
    if (!active.length) return [];
    return _monthRange(active, payments).map(function (mk) {
      var bal = 0;
      active.forEach(function (part) { bal += _partBalanceAsOf(part, payments, mk); });
      return { month: mk, label: monthLabel(mk), balance: _round2(bal) };
    });
  }
  function equityTimeline(parts, payments, valuations, settings) {
    settings = settings || {};
    var myPct = _clampPct(settings.my_ownership_pct, 50);
    var me = settings.i_am === 'b' ? 'b' : 'a';
    return balanceTimeline(parts, payments).map(function (row) {
      var asOf = row.month + '-31';
      var value = propertyValue(valuations, asOf);
      var eq = _round2(value - row.balance);
      var mine = _round2(eq * myPct / 100);
      var partner = _round2(eq - mine);
      return {
        month: row.month, label: row.label, value: value, balance: row.balance, bank: row.balance,
        equity: eq, my_equity: mine,
        a_equity: me === 'a' ? mine : partner,
        b_equity: me === 'a' ? partner : mine,
        partner_equity: partner
      };
    });
  }

  var api = {
    defaultSettings: defaultSettings,
    otherOwner: otherOwner,
    detectDelimiter: detectDelimiter,
    parseCsv: parseCsv,
    parseAmount: parseAmount,
    inferSpendSign: inferSpendSign,
    autoMapColumns: autoMapColumns,
    classifyKind: classifyKind,
    makeLoanPart: makeLoanPart,
    makePayment: makePayment,
    paymentFingerprint: paymentFingerprint,
    flagDuplicates: flagDuplicates,
    assignPaymentsToPart: assignPaymentsToPart,
    partBalance: partBalance,
    partOriginal: partOriginal,
    partAmortized: partAmortized,
    totalBalance: totalBalance,
    totalAmortized: totalAmortized,
    totalInterest: totalInterest,
    ranteavdrag: ranteavdrag,
    latestValuation: latestValuation,
    propertyValue: propertyValue,
    equity: equity,
    loanToValue: loanToValue,
    myShareEquity: myShareEquity,
    ownerSplit: ownerSplit,
    ownerPercents: ownerPercents,
    monthKey: monthKey,
    monthLabel: monthLabel,
    balanceTimeline: balanceTimeline,
    equityTimeline: equityTimeline
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.App = window.App || {}; window.App.mortgage = api; }

  // ════════════════════════════════════════════════════════════════════════
  // DOM controller — everything below runs only in the browser.
  // ════════════════════════════════════════════════════════════════════════
  if (typeof document === 'undefined') return;

  var store = window.App.mortgageStore;

  // ── tiny helpers ─────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clean(v) { return String(v == null ? '' : v).trim(); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  var CURRENCY_SUFFIX = { SEK: 'kr', NOK: 'kr', DKK: 'kr', EUR: '€', USD: '$', GBP: '£' };
  function formatMoney(n) {
    var num = Number(n) || 0;
    var hasOre = Math.abs(num - Math.round(num)) > 0.005;
    var suffix = CURRENCY_SUFFIX[settings && settings.currency] || 'kr';
    return num.toLocaleString('sv-SE', { minimumFractionDigits: hasOre ? 2 : 0, maximumFractionDigits: 2 }) + ' ' + suffix;
  }
  function formatPct(n) { return (Math.round((Number(n) || 0) * 10) / 10).toLocaleString('sv-SE') + ' %'; }
  function todayISO() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  var KIND_LABELS = { interest: 'Ränta', amortization: 'Amortering', payment: 'Betalning', loan: 'Lån', fee: 'Avgift', other: 'Övrigt' };
  function kindLabel(k) { return KIND_LABELS[k] || k || '—'; }

  var toastEl = $('toast');
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }
  var saveStateEl = $('saveState');
  function flashSaved() {
    if (!saveStateEl) return;
    saveStateEl.classList.add('show');
    setTimeout(function () { saveStateEl.classList.remove('show'); }, 1400);
  }

  // ── state ────────────────────────────────────────────────────────────────
  var settings = defaultSettings();
  var parsed = null;
  var triage = [];
  var fileName = '';
  var importParts = [];
  var importExisting = [];
  var currentPaymentFilter = 'all';
  var importQueue = [];   // selected files, processed one at a time
  var queueIndex = 0;

  function nameOf(p) { return p === 'b' ? settings.owner_b_name : settings.owner_a_name; }

  // ── segmented control helpers ─────────────────────────────────────────────
  function segVal(b) { return b.getAttribute('data-person') || b.getAttribute('data-class') || b.getAttribute('data-filter'); }
  function setSeg(container, val) {
    Array.prototype.forEach.call(container.querySelectorAll('.seg'), function (b) {
      var on = segVal(b) === val;
      b.classList.toggle('is-active', on);
      if (b.hasAttribute('aria-checked')) b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  function segValue(container) { var b = container.querySelector('.seg.is-active'); return b ? segVal(b) : null; }
  function wireSeg(container, onChange) {
    container.addEventListener('click', function (e) {
      var b = e.target.closest('.seg');
      if (!b || !container.contains(b)) return;
      var v = segVal(b);
      setSeg(container, v);
      if (onChange) onChange(v);
    });
  }

  // ── element refs: import ──────────────────────────────────────────────────
  var dropzone = $('dropzone'), fileInput = $('fileInput');
  var importGuard = $('importGuard'), importConfig = $('importConfig');
  var elDate = $('mapDate'), elType = $('mapType'), elAmount = $('mapAmount'), elBalance = $('mapBalance'), elLoanNo = $('mapLoanNo');
  var mapSelects = [elDate, elType, elAmount, elBalance, elLoanNo];
  var importPartSel = $('importPart');
  var triageBody = $('triageBody'), triageSummary = $('triageSummary');
  var confirmBtn = $('confirmImport');

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read that file.')); };
      reader.onload = function () {
        var buf = reader.result, text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
        catch (_) {
          try { text = new TextDecoder('windows-1252').decode(buf); }
          catch (__) { text = new TextDecoder('utf-8').decode(buf); }
        }
        resolve(text);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Take a list of dropped/browsed files and walk them one at a time. Each file
  // keeps its own column mapping and loan-part assignment; dedup carries across
  // the batch because every file re-reads the store (incl. rows just imported).
  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(Boolean);
    if (!files.length) return;
    importQueue = files;
    queueIndex = 0;
    loadQueueFile();
  }
  function loadQueueFile() {
    if (queueIndex < importQueue.length) handleFile(importQueue[queueIndex]);
  }
  function advanceQueue() {
    queueIndex++;
    if (queueIndex < importQueue.length) loadQueueFile();
    else finishQueue();
  }
  function finishQueue() {
    importQueue = [];
    queueIndex = 0;
    resetWizard();
  }
  function updateQueueInfo() {
    var multi = importQueue.length > 1;
    var q = $('queueInfo');
    if (q) { q.hidden = !multi; if (multi) q.textContent = 'File ' + (queueIndex + 1) + ' of ' + importQueue.length; }
    var skip = $('skipFileBtn');
    if (skip) skip.hidden = !multi;
  }

  function handleFile(file) {
    if (!file) return;
    Promise.all([store.listLoanParts(), store.listPayments()]).then(function (res) {
      importParts = res[0];
      importExisting = res[1];
      if (!importParts.length) { toast('Add a loan part first, then import.'); return; }
      readFileAsText(file).then(function (text) {
        var p = parseCsv(text);
        if (!p.headers.length || !p.rows.length) {
          toast('“' + (file.name || 'file') + '” has no rows to import.');
          if (importQueue.length > 1) advanceQueue();
          return;
        }
        parsed = p;
        fileName = file.name || 'statement.csv';
        triage = p.rows.map(function () { return { classification: 'include' }; });

        populateSelects();
        var auto = autoMapColumns(p.headers);
        setSelect(elDate, auto.date);
        setSelect(elType, auto.specification);
        setSelect(elAmount, auto.amount);
        setSelect(elBalance, auto.balance);
        setSelect(elLoanNo, auto.loan_number);
        rebuildImportPartSelect();

        $('fileName').textContent = fileName;
        $('fileMeta').textContent = p.rows.length + ' rows · “' + (p.delimiter === '\t' ? 'tab' : p.delimiter) + '” delimited';
        if (dropzone) dropzone.hidden = true;
        if (importGuard) importGuard.hidden = true;
        importConfig.hidden = false;
        updateQueueInfo();

        computeTriageMeta();
        triage.forEach(function (t) { t.classification = t.duplicate ? 'skip' : 'include'; });
        renderTriage();
      }).catch(function (e) { toast(e.message || 'Could not read that file.'); });
    });
  }

  // ── column-mapping selects ────────────────────────────────────────────────
  function populateSelects() {
    var opts = '<option value="">— none —</option>' + parsed.headers.map(function (h, i) {
      return '<option value="' + i + '">' + escapeHtml(h || ('Column ' + (i + 1))) + '</option>';
    }).join('');
    mapSelects.forEach(function (sel) { sel.innerHTML = opts; });
  }
  function setSelect(sel, idx) { sel.value = idx == null ? '' : String(idx); }
  function selectedMapping() {
    function v(sel) { return sel.value === '' ? null : parseInt(sel.value, 10); }
    return { date: v(elDate), specification: v(elType), amount: v(elAmount), balance: v(elBalance), loan_number: v(elLoanNo) };
  }
  function cellAt(row, idx) { return idx == null ? '' : (row[idx] == null ? '' : row[idx]); }

  function rebuildImportPartSelect() {
    var map = selectedMapping();
    var hasLoanNo = map.loan_number != null;
    var prev = importPartSel.value;
    var opts = '';
    if (hasLoanNo) opts += '<option value="__auto__">Auto-detect from loan #</option>';
    opts += importParts.map(function (p) {
      return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.label || '(loan part)') + '</option>';
    }).join('');
    importPartSel.innerHTML = opts;
    var keep = prev && Array.prototype.some.call(importPartSel.options, function (o) { return o.value === prev; });
    importPartSel.value = keep ? prev : (importPartSel.options[0] ? importPartSel.options[0].value : '');
  }

  // ── triage ────────────────────────────────────────────────────────────────
  function resolveAssignments() {
    var map = selectedMapping();
    var auto = importPartSel.value === '__auto__' && map.loan_number != null;
    var fallback = auto ? (importParts[0] && importParts[0].id) || null : importPartSel.value;
    var loanNumbers = parsed.rows.map(function (r) { return map.loan_number == null ? null : cellAt(r, map.loan_number); });
    return assignPaymentsToPart(loanNumbers, importParts, { selectedPartId: fallback, auto: auto });
  }
  function autoMode() { return importPartSel.value === '__auto__'; }
  function partLabelById(id) {
    for (var i = 0; i < importParts.length; i++) { if (importParts[i].id === id) return importParts[i].label || '(loan part)'; }
    return '';
  }

  function computeTriageMeta() {
    var map = selectedMapping();
    var assigns = resolveAssignments();
    var candidates = parsed.rows.map(function (r, i) {
      var t = triage[i];
      var specText = clean(cellAt(r, map.specification));
      var amt = map.amount == null ? NaN : parseAmount(r[map.amount]);
      var bal = map.balance == null ? NaN : parseAmount(r[map.balance]);
      t.specText = specText;
      t.kind = classifyKind(specText);
      t.amount = isFinite(amt) ? round2(Math.abs(amt)) : 0;
      t.balance_after = isFinite(bal) ? round2(Math.abs(bal)) : null;
      t.hasAmount = t.amount > 0 || t.balance_after != null;
      t.loan_part_id = assigns[i] ? assigns[i].loan_part_id : null;
      t.partMatched = assigns[i] ? assigns[i].matched : false;
      if (!t.hasAmount) return null;
      return { date: clean(cellAt(r, map.date)), loan_part_id: t.loan_part_id, kind: t.kind, amount: t.amount };
    });
    flagDuplicates(importExisting, candidates).forEach(function (f, i) { triage[i].duplicate = !!f; });
  }

  function seg(c, label, active) {
    return '<button type="button" class="seg' + (c === active ? ' is-active' : '') + '" data-class="' + c + '">' + label + '</button>';
  }
  function renderTriage() {
    var map = selectedMapping();
    var html = '';
    parsed.rows.forEach(function (row, i) {
      var t = triage[i];
      var treat, rowClass = '';
      if (t.hasAmount) {
        var cls = t.classification === 'skip' ? 'skip' : 'include';
        treat = '<div class="segmented segmented-sm" data-index="' + i + '">' + seg('include', 'Include', cls) + seg('skip', 'Skip', cls) + '</div>';
        if (t.duplicate) rowClass = ' is-dup';
        else if (cls === 'skip') rowClass = ' is-excluded';
      } else {
        treat = '<span class="treat-na">no amount</span>';
        rowClass = ' is-excluded';
      }
      var badges = '';
      if (t.duplicate) badges += ' <span class="row-flag">possible duplicate</span>';
      if (autoMode() && t.hasAmount) badges += ' <span class="row-flag' + (t.partMatched ? ' row-flag-refund' : '') + '">'
        + (t.partMatched ? '→ ' + escapeHtml(partLabelById(t.loan_part_id)) : 'no loan # → ' + escapeHtml(partLabelById(t.loan_part_id))) + '</span>';
      html += '<tr' + (rowClass ? ' class="' + rowClass.trim() + '"' : '') + '>'
        + '<td class="col-treat">' + treat + '</td>'
        + '<td class="col-date">' + escapeHtml(cellAt(row, map.date)) + '</td>'
        + '<td>' + escapeHtml(t.specText || kindLabel(t.kind)) + badges + '</td>'
        + '<td class="num">' + (t.hasAmount && t.amount ? formatMoney(t.amount) : '—') + '</td>'
        + '<td class="num">' + (t.balance_after != null ? formatMoney(t.balance_after) : '—') + '</td>'
        + '</tr>';
    });
    triageBody.innerHTML = html;
    updateSummary();
  }
  function updateSummary() {
    var add = 0, skip = 0, invalid = 0, dup = 0, interest = 0;
    triage.forEach(function (t) {
      if (!t.hasAmount) { invalid++; return; }
      if (t.classification === 'skip') { skip++; return; }
      add++;
      if (t.kind === 'interest') interest++;
      if (t.duplicate) dup++;
    });
    var parts = [add + ' row' + (add === 1 ? '' : 's') + ' to add'];
    if (interest) parts.push(interest + ' ränta');
    if (dup) parts.push(dup + ' possible duplicate' + (dup === 1 ? '' : 's'));
    if (skip) parts.push(skip + ' skipped');
    if (invalid) parts.push(invalid + ' without an amount');
    triageSummary.textContent = parts.join(' · ');
    confirmBtn.textContent = add ? ('Add ' + add + ' row' + (add === 1 ? '' : 's')) : 'Nothing to add';
    confirmBtn.disabled = add === 0;
  }

  function confirmImport() {
    var map = selectedMapping();
    var drafts = [];
    parsed.rows.forEach(function (row, i) {
      var t = triage[i];
      if (!t.hasAmount || t.classification === 'skip') return;
      drafts.push(makePayment({
        loan_part_id: t.loan_part_id,
        date: clean(cellAt(row, map.date)),
        kind: t.kind,
        description: t.specText,
        amount: t.amount,
        balance_after: t.balance_after,
        source: 'import:' + fileName
      }));
    });
    if (!drafts.length) { toast('Nothing selected to add.'); return; }
    store.addPayments(drafts).then(function (saved) {
      flashSaved();
      toast('Added ' + saved.length + ' row' + (saved.length === 1 ? '' : 's') + ' from “' + fileName + '”.');
      refresh();
      advanceQueue();
    });
  }
  function resetWizard() {
    parsed = null; triage = []; fileName = '';
    importConfig.hidden = true;
    fileInput.value = '';
    refreshImportAvailability();
  }
  function refreshImportAvailability() {
    return store.listLoanParts().then(function (parts) {
      var none = parts.length === 0;
      if (importGuard) importGuard.hidden = !none || !importConfig.hidden;
      if (dropzone) dropzone.hidden = none || !importConfig.hidden;
    });
  }

  // ── dashboard ──────────────────────────────────────────────────────────────
  var dashHeadline = $('dashHeadline'), dashHeadlineLabel = $('dashHeadlineLabel'),
      dashSub = $('dashSub'), dashSplit = $('dashSplit'), dashChips = $('dashChips');

  function chip(label, value, accent) {
    return '<div class="metric-chip' + (accent ? ' is-accent' : '') + '">'
      + '<span class="metric-label">' + escapeHtml(label) + '</span>'
      + '<span class="metric-val">' + value + '</span></div>';
  }
  function splitCard(person, share, pct, hasValuation, accent) {
    return '<div class="split-card' + (accent ? ' is-accent' : '') + '">'
      + '<span class="split-name">' + escapeHtml(nameOf(person)) + ' · ' + formatPct(pct) + '</span>'
      + '<span class="split-val">' + (hasValuation ? formatMoney(share) : '—') + '</span>'
      + '<span class="split-sub">equity share</span></div>';
  }

  function renderDashboard() {
    return Promise.all([store.listLoanParts(), store.listPayments(), store.listValuations()]).then(function (res) {
      var parts = res[0], pays = res[1], vals = res[2];
      var balance = totalBalance(parts, pays);
      var value = propertyValue(vals);
      var eq = equity(value, balance);
      var split = ownerSplit(eq, settings);
      var pct = ownerPercents(settings);
      var ltv = loanToValue(balance, value);
      var amortized = totalAmortized(parts, pays);
      var interest = totalInterest(pays);
      var deduction = ranteavdrag(interest);
      var hasValuation = vals.length > 0;

      dashHeadlineLabel.textContent = 'Eget kapital · Total equity';
      dashHeadline.textContent = hasValuation ? formatMoney(eq) : '—';
      if (!parts.length) {
        dashSub.textContent = 'Add a loan part and a property value to get started.';
      } else if (!hasValuation) {
        dashSub.textContent = 'Add a property value to see equity · ' + formatMoney(balance) + ' owed across ' + parts.length + ' part' + (parts.length === 1 ? '' : 's') + '.';
      } else {
        dashSub.textContent = formatPct(ltv) + ' loan-to-value · ' + formatMoney(balance) + ' still owed to the bank.';
      }

      dashSplit.innerHTML = splitCard('a', split.a, pct.a, hasValuation, true) + splitCard('b', split.b, pct.b, hasValuation, false);

      var chips = '';
      chips += chip('Remaining debt', formatMoney(balance), true);
      chips += chip('Property value', hasValuation ? formatMoney(value) : '—');
      chips += chip('Loan-to-value', hasValuation ? formatPct(ltv) : '—');
      chips += chip('Total amortised', formatMoney(amortized));
      chips += chip('Interest paid', formatMoney(interest));
      if (settings.ranteavdrag) chips += chip('Ränteavdrag (est.)', formatMoney(deduction));
      dashChips.innerHTML = chips;
    });
  }

  // ── ownership-vs-bank chart (Chart.js) ────────────────────────────────────
  var chartInstance = null;
  function getChartColors() {
    var style = getComputedStyle(document.documentElement);
    var get = function (v) { return style.getPropertyValue(v).trim(); };
    return {
      grid: get('--rule'), tick: get('--ink-soft'),
      tooltipBg: get('--paper-card'), tooltipBorder: get('--rule'),
      tooltipTitle: get('--ink'), tooltipBody: get('--ink-mid'), legend: get('--ink-mid'),
      a: get('--accent'), b: get('--accent-light'), bank: get('--warn-light')
    };
  }
  function hexToRgba(hex, alpha) {
    hex = String(hex || '').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    if (isNaN(n)) return 'rgba(0,0,0,' + alpha + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function renderChart() {
    var canvas = $('equityChart'), empty = $('chartEmpty');
    if (!canvas) return Promise.resolve();
    return Promise.all([store.listLoanParts(), store.listPayments(), store.listValuations()]).then(function (res) {
      var parts = res[0], pays = res[1], vals = res[2];
      var timeline = equityTimeline(parts, pays, vals, settings);
      var renderable = typeof window.Chart !== 'undefined' && timeline.length >= 2 && vals.length > 0;
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
      if (!renderable) {
        canvas.hidden = true;
        empty.hidden = false;
        empty.textContent = typeof window.Chart === 'undefined'
          ? 'Chart unavailable offline.'
          : (vals.length === 0 ? 'Add a property value to chart your equity vs the bank.'
                               : 'Import a few months of payments to see the trend.');
        return;
      }
      canvas.hidden = false;
      empty.hidden = true;
      var cc = getChartColors();
      var ds = function (label, key, color) {
        return {
          label: label,
          data: timeline.map(function (r) { return Math.max(0, r[key]); }),
          borderColor: color, backgroundColor: hexToRgba(color, 0.28),
          borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 10, tension: 0.25, fill: true
        };
      };
      var datasets = [
        ds(nameOf('a') + '’s equity', 'a_equity', cc.a),
        ds(nameOf('b') + '’s equity', 'b_equity', cc.b),
        ds('Banken · Bank', 'bank', cc.bank)
      ];
      chartInstance = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: timeline.map(function (r) { return r.label; }), datasets: datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          animation: { duration: 600, easing: 'easeOutQuart' },
          plugins: {
            legend: { position: 'top', labels: { font: { family: 'Inter', size: 12 }, color: cc.legend, boxWidth: 14, padding: 14, usePointStyle: true, pointStyle: 'rectRounded' } },
            tooltip: {
              backgroundColor: cc.tooltipBg, borderColor: cc.tooltipBorder, borderWidth: 1,
              titleColor: cc.tooltipTitle, bodyColor: cc.tooltipBody,
              titleFont: { family: 'Inter', size: 12, weight: '500' }, bodyFont: { family: 'Inter', size: 12 },
              padding: 10, cornerRadius: 10, boxPadding: 4,
              callbacks: { label: function (item) { return ' ' + item.dataset.label + ': ' + Math.round(item.raw).toLocaleString('sv-SE') + ' kr'; } }
            }
          },
          scales: {
            x: { grid: { color: cc.grid, lineWidth: 0.5 }, ticks: { font: { family: 'Inter', size: 11 }, color: cc.tick, maxTicksLimit: 12 } },
            y: { stacked: true, grid: { color: cc.grid, lineWidth: 0.5 }, ticks: { font: { family: 'Inter', size: 11 }, color: cc.tick, callback: function (v) { return Math.round(v / 1000) + 'k'; } } }
          }
        }
      });
    });
  }

  // ── loan parts ──────────────────────────────────────────────────────────────
  var partsHost = $('partsHost'), partsCount = $('partsCount');
  function renderParts() {
    return Promise.all([store.listLoanParts(), store.listPayments()]).then(function (res) {
      var parts = res[0], pays = res[1];
      partsCount.textContent = parts.length;
      if (!parts.length) {
        partsHost.innerHTML = '<p class="empty">No loan parts yet. Add your lånedelar — one per loan account — to begin.</p>';
        return;
      }
      var total = totalBalance(parts, pays);
      var body = parts.map(function (p) {
        var bal = partBalance(p, pays);
        var pct = total > 0 ? Math.round(bal / total * 100) : 0;
        var rate = p.interest_rate == null ? '—' : formatPct(p.interest_rate);
        return '<tr' + (p.archived ? ' class="is-settled"' : '') + '>'
          + '<td>' + escapeHtml(p.label || '(no name)') + (p.loan_number ? ' <span class="row-note">#' + escapeHtml(p.loan_number) + '</span>' : '') + '</td>'
          + '<td class="num">' + formatMoney(bal) + '</td>'
          + '<td class="num">' + pct + ' %</td>'
          + '<td>' + rate + '</td>'
          + '<td class="col-act">'
          + '<button type="button" class="icon-btn" data-edit-part="' + escapeHtml(p.id) + '" title="Edit" aria-label="Edit">✎</button>'
          + '<button type="button" class="icon-btn" data-del-part="' + escapeHtml(p.id) + '" title="Delete" aria-label="Delete">✕</button>'
          + '</td></tr>';
      }).join('');
      partsHost.innerHTML = '<div class="table-wrap"><table class="data-table">'
        + '<thead><tr><th>Loan part</th><th class="num">Balance</th><th class="num">Share</th><th>Rate</th><th class="col-act"></th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>';
    });
  }

  // ── property valuations ───────────────────────────────────────────────────
  var valuationsHost = $('valuationsHost'), valuationsCount = $('valuationsCount');
  function renderValuations() {
    return store.listValuations().then(function (vals) {
      valuationsCount.textContent = vals.length;
      if (!vals.length) {
        valuationsHost.innerHTML = '<p class="empty">No valuations yet. Add what the home is worth today — update it whenever you re-value.</p>';
        return;
      }
      var chron = vals.slice().sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')); });
      var max = chron.reduce(function (mx, v) { return Math.max(mx, Number(v.value) || 0); }, 0);
      var barsHtml = '';
      if (chron.length > 1) {
        barsHtml = '<div class="bars">' + chron.map(function (v) {
          var pct = max > 0 ? Math.max(2, Math.round((Number(v.value) || 0) / max * 100)) : 0;
          return '<div class="bar-row is-groceries">'
            + '<span class="bar-label">' + escapeHtml(v.date || '—') + '</span>'
            + '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>'
            + '<span class="bar-val num">' + formatMoney(v.value) + '</span></div>';
        }).join('') + '</div>';
      }
      var body = vals.map(function (v) {
        return '<tr>'
          + '<td class="col-date">' + escapeHtml(v.date || '—') + '</td>'
          + '<td class="num">' + formatMoney(v.value) + '</td>'
          + '<td>' + escapeHtml(v.note || '') + '</td>'
          + '<td class="col-act">'
          + '<button type="button" class="icon-btn" data-edit-val="' + escapeHtml(v.id) + '" title="Edit" aria-label="Edit">✎</button>'
          + '<button type="button" class="icon-btn" data-del-val="' + escapeHtml(v.id) + '" title="Delete" aria-label="Delete">✕</button>'
          + '</td></tr>';
      }).join('');
      valuationsHost.innerHTML = barsHtml + '<div class="table-wrap"><table class="data-table">'
        + '<thead><tr><th class="col-date">Date</th><th class="num">Value</th><th>Note</th><th class="col-act"></th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>';
    });
  }

  // ── payments ledger ──────────────────────────────────────────────────────
  var paymentsHost = $('paymentsHost'), paymentsCount = $('paymentsCount'),
      paymentFilterEl = $('paymentFilter'), clearPaymentsBtn = $('clearPaymentsBtn');
  function buildPaymentFilter(parts) {
    var html = '<button type="button" class="seg' + (currentPaymentFilter === 'all' ? ' is-active' : '') + '" data-filter="all" role="radio">All</button>';
    parts.forEach(function (p) {
      html += '<button type="button" class="seg' + (currentPaymentFilter === p.id ? ' is-active' : '') + '" data-filter="' + escapeHtml(p.id) + '" role="radio">' + escapeHtml(p.label || 'part') + '</button>';
    });
    paymentFilterEl.innerHTML = html;
  }
  function renderPayments() {
    return Promise.all([store.listPayments(), store.listLoanParts()]).then(function (res) {
      var pays = res[0], parts = res[1];
      buildPaymentFilter(parts);
      var partName = {};
      parts.forEach(function (p) { partName[p.id] = p.label || '(part)'; });
      var filtered = currentPaymentFilter === 'all' ? pays : pays.filter(function (p) { return p.loan_part_id === currentPaymentFilter; });
      paymentsCount.textContent = filtered.length;
      // "Delete all" is scoped to the active filter: a single loan part when one
      // is selected, everything under "All".
      clearPaymentsBtn.textContent = currentPaymentFilter === 'all' ? 'Delete all' : 'Delete ' + (partName[currentPaymentFilter] || 'part');
      clearPaymentsBtn.disabled = filtered.length === 0;
      if (!filtered.length) {
        paymentsHost.innerHTML = '<p class="empty">' + (pays.length
          ? 'No payments for this loan part.'
          : 'No payments yet. Import a statement above, or add one manually.') + '</p>';
        return;
      }
      var body = filtered.map(function (p) {
        return '<tr>'
          + '<td class="col-date">' + escapeHtml(p.date || '—') + '</td>'
          + '<td>' + escapeHtml(partName[p.loan_part_id] || '—') + '</td>'
          + '<td><span class="kind-tag kind-' + escapeHtml(p.kind || 'other') + '">' + escapeHtml(kindLabel(p.kind)) + '</span></td>'
          + '<td class="num">' + formatMoney(p.amount) + '</td>'
          + '<td class="num">' + (p.balance_after != null ? formatMoney(p.balance_after) : '—') + '</td>'
          + '<td class="col-act">'
          + '<button type="button" class="icon-btn" data-edit-pay="' + escapeHtml(p.id) + '" title="Edit" aria-label="Edit">✎</button>'
          + '<button type="button" class="icon-btn" data-del-pay="' + escapeHtml(p.id) + '" title="Delete" aria-label="Delete">✕</button>'
          + '</td></tr>';
      }).join('');
      paymentsHost.innerHTML = '<div class="table-wrap"><table class="data-table">'
        + '<thead><tr><th class="col-date">Date</th><th>Loan part</th><th>Type</th><th class="num">Amount</th><th class="num">Balance</th><th class="col-act"></th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>';
    });
  }

  function refresh() {
    renderDashboard();
    renderChart();
    renderParts();
    renderValuations();
    renderPayments();
    refreshImportAvailability();
  }

  // ── loan-part dialog ──────────────────────────────────────────────────────
  var partDialog = $('partDialog'), partForm = $('partForm'), partDialogTitle = $('partDialogTitle');
  var pLabel = $('p-label'), pLoanNo = $('p-loanno'), pStart = $('p-start'), pStartDate = $('p-startdate'), pRate = $('p-rate');
  var editingPartId = null;
  function openPartDialog(id) {
    editingPartId = id || null;
    partDialogTitle.textContent = id ? 'Edit loan part' : 'Add loan part';
    function show(p) {
      pLabel.value = (p && p.label) || '';
      pLoanNo.value = (p && p.loan_number) || '';
      pStart.value = p && p.start_balance ? String(p.start_balance) : '';
      pStartDate.value = (p && p.start_date) || todayISO();
      pRate.value = p && p.interest_rate != null ? String(p.interest_rate) : '';
      partDialog.showModal();
    }
    if (id) store.listLoanParts().then(function (parts) { var p = parts.filter(function (x) { return x.id === id; })[0]; if (p) show(p); });
    else show(null);
  }
  function submitPart(e) {
    e.preventDefault();
    var startRaw = clean(pStart.value);
    var rec = makeLoanPart({
      label: clean(pLabel.value) || 'Lånedel',
      loan_number: clean(pLoanNo.value),
      start_balance: startRaw === '' ? 0 : parseAmount(startRaw),
      start_date: clean(pStartDate.value),
      interest_rate: clean(pRate.value) === '' ? null : parseAmount(pRate.value)
    });
    var op = editingPartId ? store.updateLoanPart(editingPartId, rec) : store.addLoanPart(rec);
    op.then(function () { partDialog.close(); refresh(); flashSaved(); toast(editingPartId ? 'Loan part updated.' : 'Loan part added.'); });
  }
  function deletePart(id) {
    if (!window.confirm('Delete this loan part and all its payments? This can’t be undone.')) return;
    store.removeLoanPart(id).then(function () { refresh(); flashSaved(); toast('Loan part deleted.'); });
  }

  // ── valuation dialog ──────────────────────────────────────────────────────
  var valuationDialog = $('valuationDialog'), valuationForm = $('valuationForm'), valuationDialogTitle = $('valuationDialogTitle');
  var vDate = $('v-date'), vValue = $('v-value'), vNote = $('v-note');
  var editingValId = null;
  function openValuationDialog(id) {
    editingValId = id || null;
    valuationDialogTitle.textContent = id ? 'Edit valuation' : 'Add property value';
    function show(v) {
      vDate.value = (v && v.date) || todayISO();
      vValue.value = v && v.value != null ? String(v.value) : '';
      vNote.value = (v && v.note) || '';
      valuationDialog.showModal();
    }
    if (id) store.listValuations().then(function (vals) { var v = vals.filter(function (x) { return x.id === id; })[0]; if (v) show(v); });
    else show(null);
  }
  function submitValuation(e) {
    e.preventDefault();
    var value = parseAmount(vValue.value);
    if (!isFinite(value) || value <= 0) { toast('Enter the property value.'); return; }
    var rec = { date: clean(vDate.value), value: round2(value), note: clean(vNote.value) };
    var op = editingValId ? store.updateValuation(editingValId, rec) : store.addValuation(rec);
    op.then(function () { valuationDialog.close(); refresh(); flashSaved(); toast(editingValId ? 'Valuation updated.' : 'Valuation added.'); });
  }
  function deleteValuation(id) {
    if (!window.confirm('Delete this valuation?')) return;
    store.removeValuation(id).then(function () { refresh(); flashSaved(); toast('Valuation deleted.'); });
  }

  // ── payment dialog ────────────────────────────────────────────────────────
  var paymentDialog = $('paymentDialog'), paymentForm = $('paymentForm'), paymentDialogTitle = $('paymentDialogTitle');
  var payPart = $('pay-part'), payDate = $('pay-date'), payType = $('pay-type'), payAmount = $('pay-amount'), payBalance = $('pay-balance'), payHint = $('pay-hint');
  var editingPayId = null;
  function fillPayHint() {
    var amt = parseAmount(payAmount.value);
    var kind = payType.value;
    var av = isFinite(amt) ? Math.abs(amt) : 0;
    if (!av) { payHint.textContent = ''; return; }
    if (kind === 'interest') payHint.textContent = formatMoney(av) + ' interest — does not reduce the balance.';
    else if (kind === 'amortization') payHint.textContent = formatMoney(av) + ' amortering — reduces the balance.';
    else if (kind === 'loan') payHint.textContent = formatMoney(av) + ' disbursed — sets the part’s original principal.';
    else payHint.textContent = formatMoney(av) + ' ' + kindLabel(kind).toLowerCase() + '.';
  }
  function openPaymentDialog(id) {
    editingPayId = id || null;
    paymentDialogTitle.textContent = id ? 'Edit payment' : 'Add payment';
    store.listLoanParts().then(function (parts) {
      if (!parts.length) { toast('Add a loan part first.'); return; }
      payPart.innerHTML = parts.map(function (p) { return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.label || '(loan part)') + '</option>'; }).join('');
      function show(p) {
        payPart.value = (p && p.loan_part_id) || parts[0].id;
        payDate.value = (p && p.date) || todayISO();
        payType.value = (p && p.kind) || 'interest';
        payAmount.value = p && p.amount != null ? String(p.amount) : '';
        payBalance.value = p && p.balance_after != null ? String(p.balance_after) : '';
        fillPayHint();
        paymentDialog.showModal();
      }
      if (id) store.listPayments().then(function (pays) { var p = pays.filter(function (x) { return x.id === id; })[0]; if (p) show(p); });
      else show(null);
    });
  }
  function submitPayment(e) {
    e.preventDefault();
    var rec = makePayment({
      loan_part_id: payPart.value,
      date: clean(payDate.value),
      kind: payType.value,
      description: kindLabel(payType.value),
      amount: parseAmount(payAmount.value),
      balance_after: clean(payBalance.value) === '' ? null : parseAmount(payBalance.value)
    });
    if (rec.amount === 0 && rec.balance_after == null) { toast('Enter an amount or a balance.'); return; }
    var op = editingPayId
      ? store.updatePayment(editingPayId, { loan_part_id: rec.loan_part_id, date: rec.date, kind: rec.kind, description: rec.description, amount: rec.amount, balance_after: rec.balance_after })
      : store.addPayment(rec);
    op.then(function () { paymentDialog.close(); refresh(); flashSaved(); toast(editingPayId ? 'Payment updated.' : 'Payment added.'); });
  }
  function deletePayment(id) {
    if (!window.confirm('Delete this payment?')) return;
    store.removePayment(id).then(function () { refresh(); flashSaved(); toast('Payment deleted.'); });
  }

  // ── settings dialog ────────────────────────────────────────────────────────
  var settingsDialog = $('settingsDialog'), settingsForm = $('settingsForm'), settingsBtn = $('settingsBtn');
  var sPropName = $('s-propname'), sNameA = $('s-nameA'), sNameB = $('s-nameB'), sMyPct = $('s-mypct'),
      sIam = $('s-iam'), sCurrency = $('s-currency'), sRanteavdrag = $('s-ranteavdrag');
  var exportBtn = $('exportBtn'), importBtn = $('importBtn'), importInput = $('importInput');
  var sMyPctLabel = $('s-mypct-label');
  function refreshPctLabel() {
    if (!sMyPctLabel) return;
    var who = segValue(sIam) === 'b' ? clean(sNameB.value) || 'B' : clean(sNameA.value) || 'A';
    sMyPctLabel.textContent = who + '’s ownership %';
  }
  function openSettings() {
    sPropName.value = settings.property_name || '';
    sNameA.value = settings.owner_a_name;
    sNameB.value = settings.owner_b_name;
    sMyPct.value = settings.my_ownership_pct != null ? String(settings.my_ownership_pct) : '50';
    setSeg(sIam, settings.i_am === 'b' ? 'b' : 'a');
    if (sCurrency) sCurrency.value = settings.currency || 'SEK';
    sRanteavdrag.checked = settings.ranteavdrag !== false;
    applyNames();
    refreshPctLabel();
    settingsDialog.showModal();
  }
  function submitSettings(e) {
    e.preventDefault();
    var pct = parseAmount(sMyPct.value);
    store.saveSettings({
      property_name: clean(sPropName.value),
      owner_a_name: clean(sNameA.value) || 'Alex',
      owner_b_name: clean(sNameB.value) || 'Sam',
      my_ownership_pct: isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 50,
      i_am: (segValue(sIam) || 'a') === 'b' ? 'b' : 'a',
      currency: (sCurrency && sCurrency.value) || 'SEK',
      ranteavdrag: !!sRanteavdrag.checked
    }).then(function (s) {
      settings = s;
      applyNames();
      settingsDialog.close(); flashSaved(); toast('Settings saved.'); refresh();
    });
  }

  // ── JSON backup ─────────────────────────────────────────────────────────────
  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function exportBackup() {
    store.exportJSON().then(function (text) {
      downloadText('bolanekoll-backup-' + todayISO() + '.json', text);
      toast('Backup downloaded.');
    });
  }
  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      store.importJSON(String(reader.result)).then(function (added) {
        toast('Imported ' + added.loan_parts + ' part' + (added.loan_parts === 1 ? '' : 's') + ', ' + added.payments + ' payment' + (added.payments === 1 ? '' : 's') + ', ' + added.valuations + ' valuation' + (added.valuations === 1 ? '' : 's') + '.');
        return store.getSettings().then(function (s) { settings = s; applyNames(); refresh(); flashSaved(); });
      }).catch(function (e) { toast(e.message || 'Could not import that file.'); });
    };
    reader.onerror = function () { toast('Could not read that file.'); };
    reader.readAsText(file);
  }

  function applyNames() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-name="a"]'), function (el) { el.textContent = settings.owner_a_name; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-name="b"]'), function (el) { el.textContent = settings.owner_b_name; });
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('browseBtn').addEventListener('click', function () { fileInput.click(); });
  $('changeFileBtn').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { if (fileInput.files && fileInput.files.length) handleFiles(fileInput.files); });
  $('cancelImport').addEventListener('click', function () { importQueue = []; queueIndex = 0; resetWizard(); });
  $('skipFileBtn').addEventListener('click', advanceQueue);
  confirmBtn.addEventListener('click', confirmImport);
  $('guardAddPartBtn').addEventListener('click', function () { openPartDialog(null); });

  ['dragover', 'dragenter'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('is-drag'); });
  });
  ['dragleave', 'dragend'].forEach(function (ev) {
    dropzone.addEventListener(ev, function () { dropzone.classList.remove('is-drag'); });
  });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('is-drag');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  mapSelects.forEach(function (sel) {
    sel.addEventListener('change', function () {
      if (!parsed) return;
      if (sel === elLoanNo) rebuildImportPartSelect();
      computeTriageMeta(); renderTriage();
    });
  });
  importPartSel.addEventListener('change', function () { if (parsed) { computeTriageMeta(); renderTriage(); } });

  triageBody.addEventListener('click', function (e) {
    var b = e.target.closest('.seg'); if (!b) return;
    var wrap = b.closest('.segmented-sm'); if (!wrap) return;
    var i = parseInt(wrap.getAttribute('data-index'), 10);
    triage[i].classification = b.getAttribute('data-class');
    renderTriage();
  });
  // Bulk-set every row at once. Amount-less rows can't be included, so only
  // rows with an amount flip to "include".
  function setAllTriage(classification) {
    triage.forEach(function (t) { if (t.hasAmount) t.classification = classification; });
    renderTriage();
  }
  $('triageIncludeAll').addEventListener('click', function () { setAllTriage('include'); });
  $('triageSkipAll').addEventListener('click', function () { setAllTriage('skip'); });

  $('addPartBtn').addEventListener('click', function () { openPartDialog(null); });
  $('addValuationBtn').addEventListener('click', function () { openValuationDialog(null); });
  $('addPaymentBtn').addEventListener('click', function () { openPaymentDialog(null); });
  clearPaymentsBtn.addEventListener('click', function () {
    Promise.all([store.listPayments(), store.listLoanParts()]).then(function (res) {
      var pays = res[0], parts = res[1];
      var scopeAll = currentPaymentFilter === 'all';
      var target = scopeAll ? pays : pays.filter(function (p) { return p.loan_part_id === currentPaymentFilter; });
      if (!target.length) { toast('No payments to delete.'); return; }
      var count = target.length, plural = count === 1 ? '' : 's';
      var what;
      if (scopeAll) {
        what = 'all ' + count + ' payment' + plural;
      } else {
        var part = parts.filter(function (p) { return p.id === currentPaymentFilter; })[0];
        what = count + ' payment' + plural + ' for ' + (part ? (part.label || 'this loan part') : 'this loan part');
      }
      if (!window.confirm('Delete ' + what + '? Loan parts and valuations are kept. This can’t be undone.')) return;
      store.removePayments(target.map(function (p) { return p.id; })).then(function (n) {
        refresh(); flashSaved(); toast('Deleted ' + n + ' payment' + (n === 1 ? '' : 's') + '.');
      });
    });
  });

  partsHost.addEventListener('click', function (e) {
    var ed = e.target.closest('[data-edit-part]'); if (ed) { openPartDialog(ed.getAttribute('data-edit-part')); return; }
    var dl = e.target.closest('[data-del-part]'); if (dl) { deletePart(dl.getAttribute('data-del-part')); }
  });
  valuationsHost.addEventListener('click', function (e) {
    var ed = e.target.closest('[data-edit-val]'); if (ed) { openValuationDialog(ed.getAttribute('data-edit-val')); return; }
    var dl = e.target.closest('[data-del-val]'); if (dl) { deleteValuation(dl.getAttribute('data-del-val')); }
  });
  paymentsHost.addEventListener('click', function (e) {
    var ed = e.target.closest('[data-edit-pay]'); if (ed) { openPaymentDialog(ed.getAttribute('data-edit-pay')); return; }
    var dl = e.target.closest('[data-del-pay]'); if (dl) { deletePayment(dl.getAttribute('data-del-pay')); }
  });
  paymentFilterEl.addEventListener('click', function (e) {
    var b = e.target.closest('.seg'); if (!b) return;
    currentPaymentFilter = b.getAttribute('data-filter');
    renderPayments();
  });

  partForm.addEventListener('submit', submitPart);
  valuationForm.addEventListener('submit', submitValuation);
  paymentForm.addEventListener('submit', submitPayment);
  payAmount.addEventListener('input', fillPayHint);
  payType.addEventListener('change', fillPayHint);

  settingsBtn.addEventListener('click', openSettings);
  settingsForm.addEventListener('submit', submitSettings);
  wireSeg(sIam, refreshPctLabel);
  sNameA.addEventListener('input', function () { var el = sIam.querySelector('[data-person="a"]'); if (el) el.textContent = clean(sNameA.value) || 'A'; refreshPctLabel(); });
  sNameB.addEventListener('input', function () { var el = sIam.querySelector('[data-person="b"]'); if (el) el.textContent = clean(sNameB.value) || 'B'; refreshPctLabel(); });
  exportBtn.addEventListener('click', exportBackup);
  importBtn.addEventListener('click', function () { importInput.click(); });
  importInput.addEventListener('change', function () { if (importInput.files[0]) { importBackup(importInput.files[0]); importInput.value = ''; } });

  Array.prototype.forEach.call(document.querySelectorAll('dialog [data-close]'), function (b) {
    b.addEventListener('click', function () { b.closest('dialog').close(); });
  });

  // ── theme toggle (shared key with the rest of Hemma) ──
  var THEME_KEY = 'bostadskalkyl_theme';
  var themeBtn = $('themeToggleBtn');
  function applyThemeIcon() { if (themeBtn) themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? '☾' : '☀'; }
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  }
  if (themeBtn) themeBtn.addEventListener('click', function () {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, document.documentElement.dataset.theme); } catch (_) {}
    applyThemeIcon(); syncThemeColor();
    renderChart();
  });
  applyThemeIcon(); syncThemeColor();

  // ── boot ──
  store.getSettings().then(function (s) {
    settings = s;
    applyNames();
    refresh();
  });
}());

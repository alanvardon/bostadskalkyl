/* manadsavslut.js — Månadsavslut: the household month-end close.

   Two partners put shared spending on their own credit cards through the month;
   at month-end you reconcile who owes whom and settle up. This mirrors the old
   Airtable setup: individual purchases ("items") are linked to a single parent
   "payment" (the net settlement that closes the month).

   This file is the PURE core — CSV parsing, column auto-mapping, the owed-share
   math and the netting/settlement logic. It has no DOM dependency and is shared
   1:1 between the browser (window.App.monthEnd) and the node tests
   (module.exports). The page controller and persistence live elsewhere
   (manadsavslut.js DOM section — added later — and manadsavslut-store.js).

   People are modelled as two keys, 'a' and 'b', with editable display names
   (see defaultSettings). Every shared item is a directed debt:
       debtor (owed_by)  owes  creditor (fronted_by)  the amount.
*/
(function () {
  'use strict';

  // ── Settings ────────────────────────────────────────────────────────────
  // Dummy names by default; both are editable in the UI. Keys 'a'/'b' match the
  // budget tool's person_a_name / person_b_name convention.
  function defaultSettings() {
    return { person_a_name: 'Alex', person_b_name: 'Sam', currency: 'SEK', default_split: true };
  }

  function otherPerson(p) { return p === 'a' ? 'b' : 'a'; }

  // ── CSV parsing ─────────────────────────────────────────────────────────
  // Bank/card exports vary wildly. Swedish banks commonly use ';' as the field
  // delimiter (because ',' is the decimal separator), so we sniff the delimiter
  // from the header line rather than assuming a comma.
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

  // A small RFC-4180-ish parser: handles quoted fields, "" escapes, embedded
  // commas/newlines, a leading BOM and CRLF or LF line endings. Returns the
  // detected delimiter, the header cells, and the data rows as arrays of strings
  // (mapping happens later against indices, so duplicate headers are tolerated).
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
    // Drop blank trailing/interspersed rows (e.g. a file ending in a newline).
    all = all.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });

    return {
      delimiter: delim,
      headers: all.length ? all[0] : [],
      rows: all.slice(1)
    };
  }

  // Parse a money string into a number, robust to locale. Handles space/NBSP
  // thousands separators, comma OR dot decimals, currency suffixes ("1 234 kr"),
  // accounting parentheses for negatives and a unicode minus. The LAST of
  // ','/'.' is treated as the decimal separator; the other is thousands. Returns
  // NaN for blank/garbage so callers can skip the row.
  function parseAmount(raw) {
    if (raw == null) return NaN;
    var s = String(raw).trim();
    if (!s) return NaN;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); } // (1 234) → negative
    s = s.replace(/−/g, '-');           // unicode minus → ascii
    if (s.indexOf('-') !== -1) neg = true;
    s = s.replace(/[^0-9.,]/g, '');          // drop spaces, letters, currency, sign
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

  // ── Column auto-mapping ─────────────────────────────────────────────────
  // Map source headers to our three importable fields. Returns the matched
  // column INDEX for each (or null), so the UI can pre-fill the mapping
  // dropdowns and fall back to manual mapping for anything we miss.
  function autoMapColumns(headers) {
    var H = (headers || []).map(function (h) { return String(h == null ? '' : h).toLowerCase().trim(); });
    function find(re) {
      for (var i = 0; i < H.length; i++) { if (re.test(H[i])) return i; }
      return null;
    }
    return {
      date_purchased: find(/(date|datum|köpdatum|kopdatum|purchase|transaktionsdat|bokf)/),
      description: find(/(desc|beskriv|text|narrativ|merchant|butik|mottagare|referen|namn|specifikation|titel)/),
      enter_amount: find(/(amount|belopp|summa|\bsum\b|debit|värde|varde|transaktionsbelopp|kostnad|pris)/)
    };
  }

  // ── Item math ───────────────────────────────────────────────────────────
  // The share one partner owes the other: half when split 50/50, otherwise the
  // whole amount. Rounded to öre to avoid float drift.
  function computeOwedAmount(enterAmount, split) {
    var n = Number(enterAmount);
    if (!isFinite(n)) return 0;
    return Math.round((split ? n / 2 : n) * 100) / 100;
  }

  // Turn an import triage choice into the item fields it implies, given who
  // fronted the cost. 'exclude' (personal to the card owner) → null = no item.
  // 'split' = shared 50/50; 'full' = the other person owes all of it. Either way
  // the debtor (owed_by) is the partner who did NOT pay the card.
  function classifyToItemFields(classification, frontedBy) {
    if (classification === 'split') return { split: true, owed_by: otherPerson(frontedBy) };
    if (classification === 'full') return { split: false, owed_by: otherPerson(frontedBy) };
    return null; // 'exclude' or anything unrecognised
  }

  // Normalise a partial item into the stored shape (the store stamps id +
  // created_at on top, like a DB default). amount is derived unless given.
  function makeItem(partial) {
    partial = partial || {};
    var enter = Number(partial.enter_amount) || 0;
    var split = partial.split === undefined ? true : !!partial.split;
    var fronted = partial.fronted_by === 'b' ? 'b' : 'a';
    return {
      date_purchased: partial.date_purchased || '',
      description: partial.description || '',
      enter_amount: enter,
      split: split,
      amount: partial.amount === undefined ? computeOwedAmount(enter, split) : Number(partial.amount),
      fronted_by: fronted,
      owed_by: partial.owed_by || otherPerson(fronted),
      paid: !!partial.paid,
      payment_id: partial.payment_id || null,
      note: partial.note || '',
      source: partial.source || 'manual'
    };
  }

  // ── Import: sign inference & duplicate spotting ──────────────────────────
  // Banks disagree on sign: some export purchases as positive, some as negative
  // (with refunds the opposite sign). Infer the "money spent" direction from the
  // majority of non-zero amounts; a row whose sign is OPPOSITE the majority is a
  // refund/credit. Returns +1 or -1 — the sign that means "spent". Ties → +1.
  function inferSpendSign(amounts) {
    var pos = 0, neg = 0;
    (amounts || []).forEach(function (n) {
      n = Number(n);
      if (!isFinite(n) || n === 0) return;
      if (n > 0) pos++; else neg++;
    });
    return neg > pos ? -1 : 1;
  }

  // A stable key for spotting the same row across imports: date + normalised
  // description + signed amount + which card. Deliberately NOT unique — two
  // genuinely separate identical purchases share a fingerprint — so callers must
  // WARN (and let the user decide), never silently drop. The sign is KEPT so a
  // charge and a same-size refund (a credit on the card) aren't treated as each
  // other; amounts are stored sign-normalised (positive = spent) upstream.
  function itemFingerprint(it) {
    it = it || {};
    var date = String(it.date_purchased == null ? '' : it.date_purchased).trim();
    var desc = String(it.description == null ? '' : it.description).trim().toLowerCase().replace(/\s+/g, ' ');
    var amt = Math.round((Number(it.enter_amount) || 0) * 100) / 100;
    var card = it.fronted_by === 'b' ? 'b' : 'a';
    return date + '|' + desc + '|' + amt + '|' + card;
  }

  // Multiplicity-aware duplicate flags for a batch of candidate items against
  // what's already stored. The Nth identical candidate is only flagged once at
  // least N copies already exist, so a legitimate repeat purchase (your second
  // identical coffee) isn't mistaken for a re-import. Falsy candidates (refund /
  // amount-less rows) never flag. Returns a boolean[] parallel to `candidates`.
  function flagDuplicates(existing, candidates) {
    var counts = {};
    (existing || []).forEach(function (it) {
      if (!it) return;
      var k = itemFingerprint(it);
      counts[k] = (counts[k] || 0) + 1;
    });
    return (candidates || []).map(function (c) {
      if (!c) return false;
      var k = itemFingerprint(c);
      if (counts[k] > 0) { counts[k]--; return true; }
      return false;
    });
  }

  // ── Netting & settlement ────────────────────────────────────────────────
  // Net the directed debts across a set of items into a single transfer. Each
  // item: debtor (owed_by) owes creditor (fronted_by) `amount`. Returns who pays
  // whom and how much; { from:null, to:null, amount:0 } when everything cancels.
  function netBalance(items) {
    var net = { a: 0, b: 0 };
    (items || []).forEach(function (it) {
      if (!it) return;
      var amt = Number(it.amount);
      if (!isFinite(amt) || amt === 0) return;
      var creditor = it.fronted_by, debtor = it.owed_by;
      if (!creditor || !debtor || creditor === debtor) return;
      net[creditor] += amt;
      net[debtor] -= amt;
    });
    var a = Math.round(net.a * 100) / 100; // A's net position (>0 = A is owed)
    if (a > 0) return { from: 'b', to: 'a', amount: a };
    if (a < 0) return { from: 'a', to: 'b', amount: Math.round(-a * 100) / 100 };
    return { from: null, to: null, amount: 0 };
  }

  // Build a settlement (parent "payment") draft from the unsettled items: the net
  // transfer plus the list of item ids it closes. The store turns this into a
  // saved payment and flips those items to paid.
  function buildSettlement(items, opts) {
    opts = opts || {};
    var unpaid = (items || []).filter(function (it) { return it && !it.paid; });
    var bal = netBalance(unpaid);
    return {
      from_person: bal.from,
      to_person: bal.to,
      amount: bal.amount,
      item_ids: unpaid.map(function (it) { return it.id; }).filter(Boolean),
      period_label: opts.period_label || '',
      note: opts.note || ''
    };
  }

  // ── Month helpers (for per-month settlement) ─────────────────────────────
  // The calendar month an item belongs to, as 'YYYY-MM'. Built for ISO dates
  // (Swedish banks use YYYY-MM-DD); also tolerates YYYY/MM and DD.MM.YYYY.
  // Returns '' when no month can be read (item still settles under "All open").
  function monthKey(dateStr) {
    var s = String(dateStr == null ? '' : dateStr).trim();
    var m = /(\d{4})[-/](\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2];
    m = /(\d{2})[./](\d{2})[./](\d{4})/.exec(s); // DD.MM.YYYY or DD/MM/YYYY
    if (m) return m[3] + '-' + m[2];
    return '';
  }
  // Human label for a month key: '2026-06' → 'Juni 2026'; '' → "No date".
  function monthLabel(mk) {
    if (!mk) return 'Utan datum · No date';
    var m = /^(\d{4})-(\d{2})$/.exec(mk);
    if (!m) return mk;
    try {
      var s = new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' });
      return s.charAt(0).toUpperCase() + s.slice(1);
    } catch (_) { return mk; }
  }
  // Distinct months of the UNPAID items, newest first ('' / no-date last).
  function monthsWithOpenItems(items) {
    var set = {};
    (items || []).forEach(function (it) { if (it && !it.paid) set[monthKey(it.date_purchased)] = true; });
    return Object.keys(set).sort(function (a, b) {
      if (a === '') return 1; if (b === '') return -1; return b.localeCompare(a);
    });
  }
  function itemsForMonth(items, mk) {
    return (items || []).filter(function (it) { return it && monthKey(it.date_purchased) === mk; });
  }

  // ── Spending categories & analytics ──────────────────────────────────────
  // First matching rule wins; groceries is listed first (and on purpose the most
  // thorough) since it's the headline insight. Matched against the lowercased
  // statement description. Swedish-merchant aware.
  var CATEGORIES = [
    { key: 'groceries', label: 'Groceries', test: /\b(ica|coop|hemköp|hemkop|willys|lidl|city ?gross|citygross|maxi|stormarknad|tempo|matdax|matöppet|matoppet|netto|mathem|linas|matkasse|matkassen|nära|nara|dagligvar|grocer|supermarket)\b/ },
    { key: 'dining', label: 'Dining & café', test: /(restaurang|restaurant|pizz|sushi|mcdonald|\bmax\b|burger|kebab|café|\bcafe\b|espresso|\bbar\b|\bpub\b|foodora|uber ?eats|wolt|bistro|brasserie|\bkök\b|o'?learys|vapiano|sibylla|waynes|barista|gateau)/ },
    { key: 'transport', label: 'Transport & fuel', test: /\b(sl|sj|västtrafik|vasttrafik|skånetrafik|skanetrafik|taxi|uber|bolt|circle ?k|okq8|preem|st1|shell|ingo|tanka|qstar|parker|parkster|easypark|sas|norwegian|flyg|pendel|hyrbil)\b/ },
    { key: 'health', label: 'Health & pharmacy', test: /(apotek|kronans|lloyds|hjärtat|hjartat|vårdcentral|vardcentral|tandläk|tandlak|optiker|\bgym\b|\bsats\b|nordic wellness|fitness24|friskis)/ },
    { key: 'subs', label: 'Subscriptions', test: /(spotify|netflix|\bhbo\b|disney|viaplay|youtube|storytel|audible|prime video|amazon prime|\bcmore\b|c more|tv4 play|dplay|apple\.com|itunes|google ?(one|play|storage)|microsoft|adobe|patreon)/ },
    { key: 'shopping', label: 'Shopping & retail', test: /(h&m|\bhm\b|zara|clas ohlson|ikea|åhlén|ahlen|elgiganten|mediamarkt|media markt|webhall|kjell|stadium|\bxxl\b|intersport|lindex|kappahl|dressmann|nelly|zalando|cdon|amazon|boozt|jollyroom|rusta|jula|biltema|dollarstore|lager 157|gina tricot|monki|weekday)/ },
    { key: 'home', label: 'Home & bills', test: /(\bhyra\b|vattenfall|\beon\b|e\.on|ellevio|telia|telenor|\btre\b|comviq|hallon|bredband|fortum|försäkring|forsakring|elnät|elnat|fjärrvärme|sophämtning|\bbrf\b)/ }
  ];
  function categorize(description) {
    var s = String(description == null ? '' : description).toLowerCase();
    for (var i = 0; i < CATEGORIES.length; i++) { if (CATEGORIES[i].test.test(s)) return CATEGORIES[i].key; }
    return 'other';
  }
  function categoryLabel(key) {
    for (var i = 0; i < CATEGORIES.length; i++) { if (CATEGORIES[i].key === key) return CATEGORIES[i].label; }
    return 'Other';
  }
  function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  // Total CHARGE (full enter_amount = household spend) per category, sorted desc.
  function spendByCategory(items) {
    var map = {};
    (items || []).forEach(function (it) {
      if (!it) return;
      var amt = Number(it.enter_amount) || 0;
      if (amt <= 0) return;
      var key = categorize(it.description);
      if (!map[key]) map[key] = { key: key, label: categoryLabel(key), total: 0, count: 0 };
      map[key].total += amt; map[key].count++;
    });
    return Object.keys(map).map(function (k) { map[k].total = _round2(map[k].total); return map[k]; })
      .sort(function (a, b) { return b.total - a.total; });
  }
  // Grocery charge per month, oldest → newest (for the trend chart).
  function grocerySpendByMonth(items) {
    var map = {};
    (items || []).forEach(function (it) {
      if (!it || categorize(it.description) !== 'groceries') return;
      var amt = Number(it.enter_amount) || 0;
      if (amt <= 0) return;
      var mk = monthKey(it.date_purchased);
      if (!map[mk]) map[mk] = { month: mk, label: monthLabel(mk), total: 0, count: 0 };
      map[mk].total += amt; map[mk].count++;
    });
    return Object.keys(map).map(function (k) { map[k].total = _round2(map[k].total); return map[k]; })
      .sort(function (a, b) { return String(a.month).localeCompare(String(b.month)); });
  }

  // Fill in zero-total entries for any calendar months missing between the first
  // and last month present, so a trend reads continuously instead of skipping
  // empty months. Input/output sorted oldest→newest, rows shaped like
  // grocerySpendByMonth. Undated ('') rows are dropped; <2 dated rows pass through.
  function fillMonthGaps(rows) {
    var dated = (rows || []).filter(function (r) { return r && /^\d{4}-\d{2}$/.test(r.month); })
      .sort(function (a, b) { return String(a.month).localeCompare(String(b.month)); });
    if (dated.length < 2) return dated;
    var byKey = {};
    dated.forEach(function (r) { byKey[r.month] = r; });
    var y = Number(dated[0].month.slice(0, 4)), mo = Number(dated[0].month.slice(5, 7));
    var endY = Number(dated[dated.length - 1].month.slice(0, 4)), endMo = Number(dated[dated.length - 1].month.slice(5, 7));
    var out = [];
    while (y < endY || (y === endY && mo <= endMo)) {
      var mk = y + '-' + (mo < 10 ? '0' : '') + mo;
      out.push(byKey[mk] || { month: mk, label: monthLabel(mk), total: 0, count: 0 });
      mo++; if (mo > 12) { mo = 1; y++; }
    }
    return out;
  }

  var api = {
    defaultSettings: defaultSettings,
    otherPerson: otherPerson,
    detectDelimiter: detectDelimiter,
    parseCsv: parseCsv,
    parseAmount: parseAmount,
    autoMapColumns: autoMapColumns,
    computeOwedAmount: computeOwedAmount,
    classifyToItemFields: classifyToItemFields,
    makeItem: makeItem,
    inferSpendSign: inferSpendSign,
    itemFingerprint: itemFingerprint,
    flagDuplicates: flagDuplicates,
    netBalance: netBalance,
    buildSettlement: buildSettlement,
    monthKey: monthKey,
    monthLabel: monthLabel,
    monthsWithOpenItems: monthsWithOpenItems,
    itemsForMonth: itemsForMonth,
    categorize: categorize,
    categoryLabel: categoryLabel,
    spendByCategory: spendByCategory,
    grocerySpendByMonth: grocerySpendByMonth,
    fillMonthGaps: fillMonthGaps
  };

  // Export for node tests…
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // …and attach to the shared browser namespace.
  if (typeof window !== 'undefined') { window.App = window.App || {}; window.App.monthEnd = api; }

  // ════════════════════════════════════════════════════════════════════════
  // DOM controller — everything below runs only in the browser.
  // ════════════════════════════════════════════════════════════════════════
  if (typeof document === 'undefined') return;

  var store = window.App.monthEndStore;

  // ── tiny helpers ─────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clean(v) { return String(v == null ? '' : v).trim(); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  // Currency suffix per stored setting; falls back to kr. (Number grouping stays
  // sv-SE — this is a Swedish-household tool — only the unit changes.)
  var CURRENCY_SUFFIX = { SEK: 'kr', NOK: 'kr', DKK: 'kr', EUR: '€', USD: '$', GBP: '£' };
  function formatMoney(n) {
    var num = Number(n) || 0;
    var hasOre = Math.abs(num - Math.round(num)) > 0.005;
    var suffix = CURRENCY_SUFFIX[settings && settings.currency] || 'kr';
    return num.toLocaleString('sv-SE', { minimumFractionDigits: hasOre ? 2 : 0, maximumFractionDigits: 2 }) + ' ' + suffix;
  }

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
  var parsed = null;          // { headers, rows, delimiter }
  var triage = [];            // parallel to parsed.rows: { classification, kind, charge, duplicate }
  var frontedBy = 'a';
  var defaultClass = 'split';
  var fileName = '';
  var importExisting = [];     // items already stored, for duplicate spotting on import

  function nameOf(p) { return p === 'b' ? settings.person_b_name : settings.person_a_name; }

  // ── element refs ──────────────────────────────────────────────────────────
  var dropzone = $('dropzone');
  var fileInput = $('fileInput');
  var importConfig = $('importConfig');
  var elDate = $('mapDate'), elDesc = $('mapDesc'), elAmount = $('mapAmount');
  var frontedByEl = $('frontedBy'), defaultClassEl = $('defaultClass');
  var frontedHint = $('frontedHint');
  var triageBody = $('triageBody'), triageSummary = $('triageSummary');
  var confirmBtn = $('confirmImport');
  var itemsHost = $('itemsHost'), itemsCount = $('itemsCount');

  // ── file reading (UTF-8, falling back to Windows-1252 for legacy SE exports) ─
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

  function handleFile(file) {
    if (!file) return;
    readFileAsText(file).then(function (text) {
      var p = parseCsv(text);
      if (!p.headers.length || !p.rows.length) { toast('That file has no rows to import.'); return; }
      parsed = p;
      fileName = file.name || 'statement.csv';
      triage = p.rows.map(function () { return { classification: defaultClass }; });

      populateSelects();
      var auto = autoMapColumns(p.headers);
      setSelect(elDate, auto.date_purchased);
      setSelect(elDesc, auto.description);
      setSelect(elAmount, auto.enter_amount);

      $('fileName').textContent = fileName;
      $('fileMeta').textContent = p.rows.length + ' rows · “' + (p.delimiter === '\t' ? 'tab' : p.delimiter) + '” delimited';
      dropzone.hidden = true;
      importConfig.hidden = false;

      // Pull existing items so we can flag rows that look like a re-import and
      // default those to "Skip" before the first render. Refunds are kept (they
      // offset the matching charge) — only likely re-imports start excluded.
      store.listItems().then(function (items) {
        importExisting = items;
        computeTriageMeta();
        triage.forEach(function (t) {
          t.classification = t.duplicate ? 'exclude' : defaultClass;
        });
        renderTriage();
      });
    }).catch(function (e) { toast(e.message || 'Could not read that file.'); });
  }

  // ── column-mapping selects ────────────────────────────────────────────────
  function populateSelects() {
    var opts = '<option value="">— none —</option>' + parsed.headers.map(function (h, i) {
      return '<option value="' + i + '">' + escapeHtml(h || ('Column ' + (i + 1))) + '</option>';
    }).join('');
    [elDate, elDesc, elAmount].forEach(function (sel) { sel.innerHTML = opts; });
  }
  function setSelect(sel, idx) { sel.value = idx == null ? '' : String(idx); }
  function selectedMapping() {
    function v(sel) { return sel.value === '' ? null : parseInt(sel.value, 10); }
    return { date_purchased: v(elDate), description: v(elDesc), enter_amount: v(elAmount) };
  }
  function cellAt(row, idx) { return idx == null ? '' : (row[idx] == null ? '' : row[idx]); }

  // ── triage table ──────────────────────────────────────────────────────────
  function seg(c, label, active) {
    return '<button type="button" class="seg' + (c === active ? ' is-active' : '') + '" data-class="' + c + '">' + label + '</button>';
  }
  // Classify every parsed row against the current column mapping + chosen card:
  //   kind = 'charge' | 'refund' | 'noamount', charge = signed spend (positive
  //   for a real charge), duplicate = looks like a re-import. Writes onto triage
  //   in place. Re-run whenever the mapping or the card changes (the fingerprint
  //   and the inferred spend-sign both depend on them).
  function computeTriageMeta() {
    var map = selectedMapping();
    var amounts = parsed.rows.map(function (r) {
      return map.enter_amount == null ? NaN : parseAmount(r[map.enter_amount]);
    });
    var spendSign = inferSpendSign(amounts);
    var candidates = parsed.rows.map(function (r, i) {
      var t = triage[i];
      var amt = amounts[i];
      var charge = isFinite(amt) ? round2(amt * spendSign) : NaN;
      if (!isFinite(charge) || charge === 0) { t.kind = 'noamount'; t.charge = 0; return null; }
      t.kind = charge < 0 ? 'refund' : 'charge'; // negative = a credit/refund on the card
      t.charge = charge;
      return {
        date_purchased: clean(cellAt(r, map.date_purchased)),
        description: clean(cellAt(r, map.description)),
        enter_amount: charge,
        fronted_by: frontedBy
      };
    });
    flagDuplicates(importExisting, candidates).forEach(function (f, i) { triage[i].duplicate = !!f; });
  }

  function renderTriage() {
    var map = selectedMapping();
    var html = '';
    parsed.rows.forEach(function (row, i) {
      var t = triage[i];
      var treat, rowClass = '', neg = false, amtCell;
      if (t.kind === 'charge' || t.kind === 'refund') {
        var cls = t.classification;
        treat = '<div class="segmented segmented-sm" data-index="' + i + '">' + seg('split', 'Split', cls) + seg('full', 'All', cls) + seg('exclude', 'Skip', cls) + '</div>';
        if (t.duplicate) rowClass = ' is-dup';
        else if (cls === 'exclude') rowClass = ' is-excluded';
        neg = t.kind === 'refund';
        amtCell = formatMoney(t.charge);
      } else {
        treat = '<span class="treat-na">no amount</span>';
        rowClass = ' is-excluded';
        amtCell = '—';
      }
      var badges = '';
      if (t.kind === 'refund') badges += ' <span class="row-flag row-flag-refund">refund</span>';
      if ((t.kind === 'charge' || t.kind === 'refund') && t.duplicate) badges += ' <span class="row-flag">possible duplicate</span>';
      html += '<tr' + (rowClass ? ' class="' + rowClass.trim() + '"' : '') + '>'
        + '<td class="col-treat">' + treat + '</td>'
        + '<td class="col-date">' + escapeHtml(cellAt(row, map.date_purchased)) + '</td>'
        + '<td>' + escapeHtml(cellAt(row, map.description)) + badges + '</td>'
        + '<td class="num' + (neg ? ' is-neg' : '') + '">' + amtCell + '</td>'
        + '</tr>';
    });
    triageBody.innerHTML = html;
    updateSummary();
  }
  function updateSummary() {
    var map = selectedMapping();
    var add = 0, excl = 0, refundIncl = 0, invalid = 0, dup = 0;
    triage.forEach(function (t) {
      if (t.kind === 'noamount') { invalid++; return; }
      if (t.classification === 'exclude') { excl++; return; }
      add++;
      if (t.kind === 'refund') refundIncl++;
      if (t.duplicate) dup++;
    });
    var parts = [add + ' item' + (add === 1 ? '' : 's') + ' to add'];
    if (refundIncl) parts.push(refundIncl + ' refund' + (refundIncl === 1 ? '' : 's') + ' included');
    if (dup) parts.push(dup + ' possible duplicate' + (dup === 1 ? '' : 's'));
    if (excl) parts.push(excl + ' excluded');
    if (invalid) parts.push(invalid + ' without an amount');
    triageSummary.textContent = parts.join(' · ');
    confirmBtn.textContent = add ? ('Add ' + add + ' item' + (add === 1 ? '' : 's')) : 'Nothing to add';
    confirmBtn.disabled = add === 0 || map.enter_amount == null;
  }

  function segVal(b) { return b.getAttribute('data-person') || b.getAttribute('data-class') || b.getAttribute('data-filter') || b.getAttribute('data-period'); }
  function setSeg(container, val) {
    Array.prototype.forEach.call(container.querySelectorAll('.seg'), function (b) {
      var on = segVal(b) === val;
      b.classList.toggle('is-active', on);
      if (b.hasAttribute('aria-checked')) b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  function segValue(container) {
    var b = container.querySelector('.seg.is-active');
    return b ? segVal(b) : null;
  }
  function wireSeg(container, onChange) {
    container.addEventListener('click', function (e) {
      var b = e.target.closest('.seg');
      if (!b || !container.contains(b)) return;
      var v = segVal(b);
      setSeg(container, v);
      if (onChange) onChange(v);
    });
  }
  function updateFrontedHint() {
    frontedHint.textContent = nameOf(otherPerson(frontedBy)) + ' owes their share of the split / “owes all” rows.';
  }

  // ── confirm: build items and persist ──────────────────────────────────────
  function confirmImport() {
    var map = selectedMapping();
    if (map.enter_amount == null) { toast('Pick the amount column first.'); return; }
    var drafts = [];
    parsed.rows.forEach(function (row, i) {
      var t = triage[i];
      if (t.kind !== 'charge' && t.kind !== 'refund') return; // skip amount-less rows only
      var fields = classifyToItemFields(t.classification, frontedBy);
      if (!fields) return; // excluded
      drafts.push(makeItem({
        date_purchased: clean(cellAt(row, map.date_purchased)),
        description: clean(cellAt(row, map.description)) || '(no description)',
        enter_amount: t.charge,
        split: fields.split,
        fronted_by: frontedBy,
        owed_by: fields.owed_by,
        source: 'import:' + fileName
      }));
    });
    if (!drafts.length) { toast('Nothing selected to add.'); return; }
    store.addItems(drafts).then(function (saved) {
      resetWizard();
      refresh();
      flashSaved();
      toast('Added ' + saved.length + ' item' + (saved.length === 1 ? '' : 's') + '.');
    });
  }

  function resetWizard() {
    parsed = null; triage = []; fileName = '';
    importConfig.hidden = true;
    dropzone.hidden = false;
    fileInput.value = '';
  }

  // ── Phase-3 surface: balance, items table, settlement history ─────────────
  var balanceLabel = $('balanceLabel'), balanceAmount = $('balanceAmount'), balanceSub = $('balanceSub');
  var settleBtn = $('settleBtn'), itemFilterEl = $('itemFilter'), addItemBtn = $('addItemBtn');
  var clearOpenBtn = $('clearOpenBtn');
  var historyHost = $('historyHost'), historyCount = $('historyCount');
  var settingsBtn = $('settingsBtn');
  // dialogs + their fields
  var itemDialog = $('itemDialog'), itemForm = $('itemForm'), itemDialogTitle = $('itemDialogTitle');
  var fDate = $('f-date'), fDesc = $('f-desc'), fAmount = $('f-amount'), fNote = $('f-note'), fHint = $('f-hint');
  var fFronted = $('f-fronted'), fSplit = $('f-split');
  var settleDialog = $('settleDialog'), settleForm = $('settleForm'), settleLine = $('settleLine');
  var fPeriod = $('f-period'), fSettleNote = $('f-settle-note');
  var fSettleMonth = $('f-settle-month'), settleConfirm = $('settleConfirm');
  var insightsHost = $('insightsHost'), insightsPeriodEl = $('insightsPeriod');
  var settingsDialog = $('settingsDialog'), settingsForm = $('settingsForm');
  var sNameA = $('s-nameA'), sNameB = $('s-nameB'), sDefault = $('s-default'), sCurrency = $('s-currency');
  var exportBtn = $('exportBtn'), importBtn = $('importBtn'), importInput = $('importInput');

  var currentFilter = 'open';
  var insightsPeriod = 'all';
  var editingId = null;
  var pendingSettle = null;
  var settleOpenItems = [];

  function todayISO() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function defaultPeriodLabel() {
    try {
      var s = new Date().toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' });
      return s.charAt(0).toUpperCase() + s.slice(1);
    } catch (_) { return ''; }
  }
  function transferText(from, to, amount) {
    if (!from || amount <= 0) return 'Even — no transfer';
    return escapeHtml(nameOf(from)) + ' → ' + escapeHtml(nameOf(to)) + ' · <strong>' + formatMoney(amount) + '</strong>';
  }

  function renderBalance() {
    return store.listItems().then(function (items) {
      var open = items.filter(function (it) { return !it.paid; });
      var bal = netBalance(open);
      settleBtn.disabled = open.length === 0;
      clearOpenBtn.disabled = open.length === 0;
      if (!open.length) {
        balanceLabel.textContent = 'All settled';
        balanceAmount.textContent = '—';
        balanceSub.textContent = 'Nothing outstanding.';
      } else if (!bal.from || bal.amount <= 0) {
        balanceLabel.textContent = 'Even';
        balanceAmount.textContent = formatMoney(0);
        balanceSub.textContent = open.length + ' open item' + (open.length === 1 ? '' : 's') + ' · they cancel out';
      } else {
        balanceLabel.textContent = nameOf(bal.from) + ' owes ' + nameOf(bal.to);
        balanceAmount.textContent = formatMoney(bal.amount);
        balanceSub.textContent = 'across ' + open.length + ' open item' + (open.length === 1 ? '' : 's');
      }
    });
  }

  function renderItems() {
    return store.listItems().then(function (items) {
      var filtered = items.filter(function (it) {
        if (currentFilter === 'open') return !it.paid;
        if (currentFilter === 'a') return it.fronted_by === 'a';
        if (currentFilter === 'b') return it.fronted_by === 'b';
        return true;
      });
      itemsCount.textContent = filtered.length;
      if (!filtered.length) {
        itemsHost.innerHTML = '<p class="empty">' + (items.length
          ? 'No items match this filter.'
          : 'No items yet. Import a statement above, or add one manually.') + '</p>';
        return;
      }
      var body = filtered.map(function (it) {
        var actions = it.paid
          ? '<span class="row-lock" title="Settled — reopen its settlement to edit">🔒</span>'
          : '<button type="button" class="icon-btn" data-edit="' + it.id + '" title="Edit" aria-label="Edit">✎</button>'
            + '<button type="button" class="icon-btn" data-del="' + it.id + '" title="Delete" aria-label="Delete">✕</button>';
        return '<tr' + (it.paid ? ' class="is-settled"' : '') + '>'
          + '<td class="col-date">' + escapeHtml(it.date_purchased) + '</td>'
          + '<td>' + escapeHtml(it.description) + (it.note ? ' <span class="row-note">' + escapeHtml(it.note) + '</span>' : '') + '</td>'
          + '<td>' + escapeHtml(nameOf(it.fronted_by)) + '</td>'
          + '<td>' + escapeHtml(nameOf(it.owed_by)) + '</td>'
          + '<td class="col-type">' + (it.paid
            ? (it.split ? 'Split' : 'All')
            : '<div class="segmented segmented-sm type-toggle" data-id="' + it.id + '" data-enter="' + it.enter_amount + '">'
              + '<button type="button" class="seg' + (it.split ? ' is-active' : '') + '" data-class="split">Split</button>'
              + '<button type="button" class="seg' + (!it.split ? ' is-active' : '') + '" data-class="full">All</button>'
              + '</div>') + '</td>'
          + '<td class="num">' + formatMoney(it.enter_amount) + '</td>'
          + '<td class="num">' + formatMoney(it.amount) + '</td>'
          + '<td>' + (it.paid ? '<span class="tag tag-settled">Settled</span>' : '<span class="tag tag-open">Open</span>') + '</td>'
          + '<td class="col-act">' + actions + '</td>'
          + '</tr>';
      }).join('');
      itemsHost.innerHTML = '<div class="table-wrap"><table class="data-table">'
        + '<thead><tr><th class="col-date">Date</th><th>Item</th><th>Paid by</th><th>Owes</th><th>Type</th>'
        + '<th class="num">Charge</th><th class="num">Owed</th><th>Status</th><th class="col-act"></th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>';
    });
  }

  function renderHistory() {
    return Promise.all([store.listPayments(), store.listItems()]).then(function (res) {
      var pays = res[0], items = res[1];
      historyCount.textContent = pays.length;
      if (!pays.length) {
        historyHost.innerHTML = '<p class="empty">No settlements yet. Settle the open items above to close a month.</p>';
        return;
      }
      var byPay = {};
      items.forEach(function (it) { if (it.payment_id) { (byPay[it.payment_id] = byPay[it.payment_id] || []).push(it); } });
      historyHost.innerHTML = pays.map(function (p) {
        var linked = byPay[p.id] || [];
        var when = (p.created_at || '').slice(0, 10);
        var lines = linked.map(function (it) {
          return '<li><span class="hl-date">' + escapeHtml(it.date_purchased || when) + '</span>'
            + '<span class="hl-desc">' + escapeHtml(it.description) + '</span>'
            + '<span class="hl-amt num">' + formatMoney(it.amount) + '</span></li>';
        }).join('');
        return '<details class="history-item">'
          + '<summary>'
          + '<span class="history-period">' + escapeHtml(p.period_label || when) + '</span>'
          + '<span class="history-transfer">' + transferText(p.from_person, p.to_person, p.amount) + '</span>'
          + '<span class="history-meta">' + linked.length + ' item' + (linked.length === 1 ? '' : 's') + '</span>'
          + '</summary>'
          + '<ul class="history-list">' + lines + '</ul>'
          + (p.note ? '<p class="history-note">' + escapeHtml(p.note) + '</p>' : '')
          + '<div class="history-actions"><button type="button" class="link-btn" data-reopen="' + p.id + '">Reopen settlement</button></div>'
          + '</details>';
      }).join('');
    });
  }

  // ── insights: category breakdown + groceries highlight & trend ────────────
  function bars(rows, max, highlightKey) {
    return '<div class="bars">' + rows.map(function (r) {
      var pct = max > 0 ? Math.max(2, Math.round(r.total / max * 100)) : 0;
      var hl = highlightKey && r.key === highlightKey ? ' is-groceries' : (r.month ? ' is-groceries' : '');
      return '<div class="bar-row' + hl + '">'
        + '<span class="bar-label">' + escapeHtml(r.label) + '</span>'
        + '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>'
        + '<span class="bar-val num">' + formatMoney(r.total) + '</span></div>';
    }).join('') + '</div>';
  }
  // The set of 'YYYY-MM' keys covered by the chosen insights period (this month
  // / last 3 months); 'all' returns everything unfiltered.
  function periodMonthKeys(n) {
    var keys = {}, now = new Date();
    for (var k = 0; k < n; k++) {
      var d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      var mo = d.getMonth() + 1;
      keys[d.getFullYear() + '-' + (mo < 10 ? '0' : '') + mo] = true;
    }
    return keys;
  }
  function periodItems(items) {
    if (insightsPeriod === 'all') return items;
    var keys = periodMonthKeys(insightsPeriod === '3m' ? 3 : 1);
    return items.filter(function (it) { return keys[monthKey(it.date_purchased)]; });
  }

  function renderInsights() {
    return store.listItems().then(function (allItems) {
      var items = periodItems(allItems);
      if (!items.length) {
        insightsHost.innerHTML = '<p class="empty">' + (allItems.length
          ? 'No spending in this period.'
          : 'No spending to analyse yet. Import a statement to see where the money goes.') + '</p>';
        return;
      }
      var cats = spendByCategory(items);
      var total = cats.reduce(function (s, c) { return s + c.total; }, 0);
      var groc = cats.filter(function (c) { return c.key === 'groceries'; })[0];
      var grocTotal = groc ? groc.total : 0;
      var grocPct = total > 0 ? Math.round(grocTotal / total * 100) : 0;
      var byMonth = fillMonthGaps(grocerySpendByMonth(items));

      var html = '';
      if (grocTotal > 0) {
        html += '<div class="insight-highlight">'
          + '<span class="ih-icon" aria-hidden="true">🛒</span>'
          + '<div class="ih-main">'
          + '<span class="ih-label">Groceries</span>'
          + '<span class="ih-amount">' + formatMoney(grocTotal) + '</span>'
          + '<span class="ih-sub">' + grocPct + '% of shared spending · ' + groc.count + ' purchase' + (groc.count === 1 ? '' : 's') + '</span>'
          + '</div></div>';
      }

      html += '<h3 class="insight-h">Spending by category</h3>'
        + bars(cats, cats.length ? cats[0].total : 0, 'groceries');

      if (byMonth.length > 1) {
        var maxM = byMonth.reduce(function (m, x) { return Math.max(m, x.total); }, 0);
        html += '<h3 class="insight-h">Groceries by month</h3>' + bars(byMonth, maxM, null);
      }
      insightsHost.innerHTML = html;
    });
  }

  function refresh() { renderBalance(); renderItems(); renderHistory(); renderInsights(); }

  // ── item add/edit dialog ──────────────────────────────────────────────────
  function fillItemHint() {
    var fronted = segValue(fFronted) || 'a';
    var split = (segValue(fSplit) || 'split') === 'split';
    var amt = parseAmount(fAmount.value);
    var owed = otherPerson(fronted);
    if (!isFinite(amt) || amt === 0) { fHint.textContent = ''; return; }
    var share = computeOwedAmount(amt, split);
    var verb = amt < 0 ? ' is credited ' : ' will owe '; // negative = a refund/credit
    fHint.textContent = nameOf(owed) + verb + formatMoney(Math.abs(share)) + (split ? ' (half of ' + formatMoney(Math.abs(amt)) + ')' : '');
  }
  function openItemDialog(id) {
    editingId = id || null;
    itemDialogTitle.textContent = id ? 'Edit item' : 'Add item';
    function show(it) {
      fDate.value = (it && it.date_purchased) || todayISO();
      fDesc.value = (it && it.description) || '';
      fAmount.value = it && it.enter_amount != null ? String(it.enter_amount) : '';
      fNote.value = (it && it.note) || '';
      setSeg(fFronted, it ? it.fronted_by : 'a');
      setSeg(fSplit, it ? (it.split ? 'split' : 'full') : (defaultClass === 'full' ? 'full' : 'split'));
      fillItemHint();
      itemDialog.showModal();
    }
    if (id) store.listItems().then(function (items) { var it = items.filter(function (x) { return x.id === id; })[0]; if (it) show(it); });
    else show(null);
  }
  function submitItem(e) {
    e.preventDefault();
    var amt = parseAmount(fAmount.value);
    if (!isFinite(amt) || amt === 0) { toast('Enter a valid amount (use a minus for a refund).'); return; }
    var fronted = segValue(fFronted) || 'a';
    var split = (segValue(fSplit) || 'split') === 'split';
    var rec = makeItem({
      date_purchased: clean(fDate.value),
      description: clean(fDesc.value) || '(no description)',
      enter_amount: amt, split: split, fronted_by: fronted, owed_by: otherPerson(fronted),
      note: clean(fNote.value)
    });
    var op = editingId
      ? store.updateItem(editingId, {
          date_purchased: rec.date_purchased, description: rec.description, enter_amount: rec.enter_amount,
          split: rec.split, amount: rec.amount, fronted_by: rec.fronted_by, owed_by: rec.owed_by, note: rec.note
        })
      : store.addItem(rec);
    op.then(function () { itemDialog.close(); refresh(); flashSaved(); toast(editingId ? 'Item updated.' : 'Item added.'); });
  }
  function deleteItem(id) {
    if (!window.confirm('Delete this item?')) return;
    store.removeItem(id).then(function () { refresh(); flashSaved(); toast('Item deleted.'); });
  }

  // ── settle dialog (scoped to a chosen month for a true month-end) ─────────
  function openSettle() {
    store.listItems().then(function (items) {
      settleOpenItems = items.filter(function (it) { return !it.paid; });
      if (!settleOpenItems.length) { toast('No open items to settle.'); return; }
      var months = monthsWithOpenItems(settleOpenItems);
      fSettleMonth.innerHTML = months.map(function (mk) {
        return '<option value="' + escapeHtml(mk) + '">' + escapeHtml(monthLabel(mk))
          + ' (' + itemsForMonth(settleOpenItems, mk).length + ')</option>';
      }).join('') + '<option value="__all__">All open items (' + settleOpenItems.length + ')</option>';
      fSettleMonth.value = months[0]; // newest month → the natural month-end
      fSettleNote.value = '';
      recomputeSettle();
      settleDialog.showModal();
    });
  }
  function recomputeSettle() {
    var month = fSettleMonth.value;
    var scope = month === '__all__' ? settleOpenItems : itemsForMonth(settleOpenItems, month);
    pendingSettle = buildSettlement(scope, {});
    if (!pendingSettle.item_ids.length) {
      settleLine.textContent = 'No open items in this period.';
      settleConfirm.disabled = true;
    } else {
      settleLine.innerHTML = transferText(pendingSettle.from_person, pendingSettle.to_person, pendingSettle.amount)
        + ' — closing ' + pendingSettle.item_ids.length + ' item' + (pendingSettle.item_ids.length === 1 ? '' : 's') + '.';
      settleConfirm.disabled = false;
    }
    fPeriod.value = month === '__all__' ? defaultPeriodLabel() : monthLabel(month);
  }
  function submitSettle(e) {
    e.preventDefault();
    if (!pendingSettle) return;
    pendingSettle.period_label = clean(fPeriod.value);
    pendingSettle.note = clean(fSettleNote.value);
    store.settle(pendingSettle).then(function (p) {
      settleDialog.close(); refresh(); flashSaved();
      toast(p.amount > 0 ? 'Settled — ' + formatMoney(p.amount) + ' closed.' : 'Items closed.');
    });
  }

  // ── settings dialog ───────────────────────────────────────────────────────
  function openSettings() {
    sNameA.value = settings.person_a_name;
    sNameB.value = settings.person_b_name;
    setSeg(sDefault, settings.default_split ? 'split' : 'full');
    if (sCurrency) sCurrency.value = settings.currency || 'SEK';
    settingsDialog.showModal();
  }
  function submitSettings(e) {
    e.preventDefault();
    store.saveSettings({
      person_a_name: clean(sNameA.value) || 'Alex',
      person_b_name: clean(sNameB.value) || 'Sam',
      currency: (sCurrency && sCurrency.value) || 'SEK',
      default_split: (segValue(sDefault) || 'split') !== 'full'
    }).then(function (s) {
      settings = s;
      applyNames();
      defaultClass = s.default_split ? 'split' : 'full';
      setSeg(defaultClassEl, defaultClass);
      settingsDialog.close(); flashSaved(); toast('Settings saved.'); refresh();
    });
  }

  // ── JSON backup ───────────────────────────────────────────────────────────
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
      downloadText('manadsavslut-backup-' + todayISO() + '.json', text);
      toast('Backup downloaded.');
    });
  }
  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      store.importJSON(String(reader.result)).then(function (added) {
        return store.getSettings().then(function (s) {
          settings = s; applyNames();
          defaultClass = s.default_split ? 'split' : 'full';
          setSeg(defaultClassEl, defaultClass);
          refresh(); flashSaved();
          toast('Imported ' + added.items + ' item' + (added.items === 1 ? '' : 's') + ' and ' + added.payments + ' settlement' + (added.payments === 1 ? '' : 's') + '.');
        });
      }).catch(function (e) { toast(e.message || 'Could not import that file.'); });
    };
    reader.onerror = function () { toast('Could not read that file.'); };
    reader.readAsText(file);
  }

  // Refresh every place a person's name is shown.
  function applyNames() {
    [frontedByEl, fFronted].forEach(function (el) {
      el.querySelector('[data-person="a"]').textContent = settings.person_a_name;
      el.querySelector('[data-person="b"]').textContent = settings.person_b_name;
    });
    itemFilterEl.querySelector('[data-filter="a"]').textContent = settings.person_a_name;
    itemFilterEl.querySelector('[data-filter="b"]').textContent = settings.person_b_name;
    updateFrontedHint();
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('browseBtn').addEventListener('click', function () { fileInput.click(); });
  $('changeFileBtn').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
  $('cancelImport').addEventListener('click', resetWizard);
  confirmBtn.addEventListener('click', confirmImport);

  ['dragover', 'dragenter'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('is-drag'); });
  });
  ['dragleave', 'dragend'].forEach(function (ev) {
    dropzone.addEventListener(ev, function () { dropzone.classList.remove('is-drag'); });
  });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('is-drag');
    if (e.dataTransfer && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  [elDate, elDesc, elAmount].forEach(function (sel) {
    sel.addEventListener('change', function () { if (parsed) { computeTriageMeta(); renderTriage(); } });
  });

  frontedByEl.addEventListener('click', function (e) {
    var b = e.target.closest('.seg'); if (!b) return;
    frontedBy = b.getAttribute('data-person');
    setSeg(frontedByEl, frontedBy);
    updateFrontedHint();
    if (parsed) { computeTriageMeta(); renderTriage(); }
  });
  defaultClassEl.addEventListener('click', function (e) {
    var b = e.target.closest('.seg'); if (!b) return;
    defaultClass = b.getAttribute('data-class');
    setSeg(defaultClassEl, defaultClass);
    if (parsed) { triage.forEach(function (t) { t.classification = defaultClass; }); renderTriage(); }
  });
  triageBody.addEventListener('click', function (e) {
    var b = e.target.closest('.seg'); if (!b) return;
    var wrap = b.closest('.segmented-sm'); if (!wrap) return;
    var i = parseInt(wrap.getAttribute('data-index'), 10);
    triage[i].classification = b.getAttribute('data-class');
    renderTriage();
  });

  // Phase-3 wiring: items table, dialogs, filters, settle, history, settings.
  wireSeg(itemFilterEl, function (v) { currentFilter = v; renderItems(); });
  if (insightsPeriodEl) wireSeg(insightsPeriodEl, function (v) { insightsPeriod = v; renderInsights(); });
  addItemBtn.addEventListener('click', function () { openItemDialog(null); });
  clearOpenBtn.addEventListener('click', function () {
    store.listItems().then(function (items) {
      var openIds = items.filter(function (it) { return !it.paid; }).map(function (it) { return it.id; });
      if (!openIds.length) { toast('No open items to delete.'); return; }
      if (!window.confirm('Delete all ' + openIds.length + ' open item' + (openIds.length === 1 ? '' : 's')
        + '? Settled items are kept. This can’t be undone.')) return;
      store.removeItems(openIds).then(function (n) {
        refresh(); flashSaved();
        toast('Deleted ' + n + ' open item' + (n === 1 ? '' : 's') + '.');
      });
    });
  });
  itemsHost.addEventListener('click', function (e) {
    var tg = e.target.closest('.type-toggle .seg');
    if (tg) {
      var wrap = tg.closest('.type-toggle');
      var split = tg.getAttribute('data-class') === 'split';
      var enter = parseFloat(wrap.getAttribute('data-enter')) || 0;
      store.updateItem(wrap.getAttribute('data-id'), { split: split, amount: computeOwedAmount(enter, split) })
        .then(function () { refresh(); flashSaved(); });
      return;
    }
    var ed = e.target.closest('[data-edit]'); if (ed) { openItemDialog(ed.getAttribute('data-edit')); return; }
    var dl = e.target.closest('[data-del]'); if (dl) { deleteItem(dl.getAttribute('data-del')); }
  });
  historyHost.addEventListener('click', function (e) {
    var r = e.target.closest('[data-reopen]'); if (!r) return;
    if (!window.confirm('Reopen this settlement? Its items become open again.')) return;
    store.removePayment(r.getAttribute('data-reopen')).then(function () { refresh(); flashSaved(); toast('Settlement reopened.'); });
  });

  wireSeg(fFronted, fillItemHint);
  wireSeg(fSplit, fillItemHint);
  fAmount.addEventListener('input', fillItemHint);
  itemForm.addEventListener('submit', submitItem);

  settleBtn.addEventListener('click', openSettle);
  settleForm.addEventListener('submit', submitSettle);
  fSettleMonth.addEventListener('change', recomputeSettle);

  settingsBtn.addEventListener('click', openSettings);
  settingsForm.addEventListener('submit', submitSettings);
  wireSeg(sDefault);
  exportBtn.addEventListener('click', exportBackup);
  importBtn.addEventListener('click', function () { importInput.click(); });
  importInput.addEventListener('change', function () { if (importInput.files[0]) { importBackup(importInput.files[0]); importInput.value = ''; } });

  // Every dialog's Cancel button just closes its dialog.
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
  });
  applyThemeIcon(); syncThemeColor();

  // ── boot ──
  store.getSettings().then(function (s) {
    settings = s;
    defaultClass = s.default_split ? 'split' : 'full';
    setSeg(defaultClassEl, defaultClass);
    applyNames();
    refresh();
  });
}());

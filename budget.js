/* budget.js — Hushållsbudget: the household pot.
   Two adults pool every income into one pot, split it equally back,
   then pay joint costs 50/50 and individual costs from their own share.
   The pure math section is exported for node tests; everything below
   the DOM guard only runs in the browser. */
(function () {
  'use strict';

  // ── Pure: categories, defaults & computation ─────────────────────

  var CATEGORIES = [
    { key: 'boende',     label: 'Boende' },
    { key: 'mat',        label: 'Mat & hushåll' },
    { key: 'transport',  label: 'Transport' },
    { key: 'barn',       label: 'Barn' },
    { key: 'forsakring', label: 'Försäkringar' },
    { key: 'abonnemang', label: 'Abonnemang & nöje' },
    { key: 'ovrigt',     label: 'Övrigt' }
  ];

  function defaultState() {
    var id = 0;
    function row(label, amount, owner, category) {
      var r = { id: 'r' + (++id), label: label, amount: amount, owner: owner };
      if (category) r.category = category;
      return r;
    }
    var s = {
      version: 1,
      people: ['Alan', 'Partner'],
      incomes: [
        row('Lön / Salary', 46000, 'a'),
        row('Lön / Salary', 39000, 'b'),
        row('Barnbidrag', 2650, 'joint')
      ],
      costs: [
        row('Bolån (ränta & amortering)', 12775, 'joint', 'boende'),
        row('El / Electricity', 2101, 'joint', 'boende'),
        row('Vatten & avlopp', 231, 'joint', 'boende'),
        row('Fastighetsavgift', 397, 'joint', 'boende'),
        row('Hemunderhåll / buffert', 1000, 'joint', 'boende'),
        row('Matvaror', 9000, 'joint', 'mat'),
        row('Restaurang & takeaway', 3000, 'joint', 'mat'),
        row('Hushållsartiklar', 700, 'joint', 'mat'),
        row('Bilkostnad / leasing', 3500, 'joint', 'transport'),
        row('Bränsle & parkering', 2000, 'joint', 'transport'),
        row('Kollektivtrafik (SL)', 970, 'joint', 'transport'),
        row('Bilförsäkring & skatt', 600, 'joint', 'transport'),
        row('Förskola / fritids', 1700, 'joint', 'barn'),
        row('Barnens aktiviteter', 800, 'joint', 'barn'),
        row('Barnkläder & utrustning', 800, 'joint', 'barn'),
        row('Hem- & bilförsäkring', 905, 'joint', 'forsakring'),
        row('Barnförsäkring', 300, 'joint', 'forsakring'),
        row('Livförsäkring', 250, 'joint', 'forsakring'),
        row('Bredband / Broadband', 235, 'joint', 'abonnemang'),
        row('Spotify Family', 119, 'joint', 'abonnemang'),
        row('Disney+', 37, 'joint', 'abonnemang'),
        row('HBO Max', 22, 'joint', 'abonnemang'),
        row('Mobil', 300, 'a', 'abonnemang'),
        row('Mobil', 300, 'b', 'abonnemang'),
        row('Gym', 500, 'a', 'abonnemang'),
        row('Gym', 450, 'b', 'abonnemang'),
        row('Kläder & skor', 1500, 'joint', 'ovrigt'),
        row('Hälsa & skönhet', 700, 'joint', 'ovrigt'),
        row('Presenter & kalas', 500, 'joint', 'ovrigt'),
        row('Diverse / oförutsett', 2000, 'joint', 'ovrigt')
      ],
      savings: [
        row('Swedish Savings (buffert)', 5000, 'joint'),
        row('Semesterkonto', 4500, 'joint'),
        row('Barnsparande', 1000, 'joint'),
        row('Personal Pension', 4000, 'a'),
        row('Personal Pension', 4000, 'b'),
        row('ISK / fondsparande', 3000, 'a'),
        row('ISK / fondsparande', 3000, 'b')
      ]
    };
    s.seq = id;
    return s;
  }

  function computeBudget(state) {
    state = state || {};
    var incomes = state.incomes || [];
    var costs   = state.costs   || [];
    var savings = state.savings || [];

    function sum(rows, owner) {
      var t = 0;
      for (var i = 0; i < rows.length; i++) {
        if (owner === undefined || rows[i].owner === owner) t += (rows[i].amount || 0);
      }
      return t;
    }

    var incomeA     = sum(incomes, 'a');
    var incomeB     = sum(incomes, 'b');
    var incomeJoint = sum(incomes, 'joint');
    var totalIncome = incomeA + incomeB + incomeJoint;
    var equalShare  = totalIncome / 2;

    var costsJoint = sum(costs, 'joint');
    var costsA     = sum(costs, 'a');
    var costsB     = sum(costs, 'b');
    var totalCosts = costsJoint + costsA + costsB;

    var savingsJoint = sum(savings, 'joint');
    var savingsA     = sum(savings, 'a');
    var savingsB     = sum(savings, 'b');
    var totalSavings = savingsJoint + savingsA + savingsB;

    var byCategory = {};
    for (var c = 0; c < costs.length; c++) {
      var key = costs[c].category || 'ovrigt';
      byCategory[key] = (byCategory[key] || 0) + (costs[c].amount || 0);
    }

    // The single person-to-person transfer that evens out the two salaries:
    // the higher earner sends the other half the gap. Joint income (barnbidrag
    // etc.) is shared 50/50 on top from the pot, so it doesn't change who pays
    // whom — only the final equalShare. transfer + each getting incomeJoint/2
    // lands both people on equalShare.
    var gap = incomeA - incomeB;
    var transfer = {
      amount: Math.abs(gap) / 2,
      from: gap >= 0 ? 'a' : 'b',
      to:   gap >= 0 ? 'b' : 'a'
    };

    // potNet: what flows back to (positive) or stays in (negative) the pot
    // for this person once everyone has taken out the same equal share.
    function person(ownIncome, ownCosts, ownSavings) {
      return {
        ownIncome: ownIncome,
        potNet: equalShare - ownIncome,
        jointCostShare: costsJoint / 2,
        ownCosts: ownCosts,
        jointSavingsShare: savingsJoint / 2,
        ownSavings: ownSavings,
        leftover: equalShare - costsJoint / 2 - ownCosts - savingsJoint / 2 - ownSavings
      };
    }

    return {
      incomeA: incomeA,
      incomeB: incomeB,
      incomeJoint: incomeJoint,
      totalIncome: totalIncome,
      equalShare: equalShare,
      costsJoint: costsJoint,
      costsA: costsA,
      costsB: costsB,
      totalCosts: totalCosts,
      savingsJoint: savingsJoint,
      savingsA: savingsA,
      savingsB: savingsB,
      totalSavings: totalSavings,
      byCategory: byCategory,
      personA: person(incomeA, costsA, savingsA),
      personB: person(incomeB, costsB, savingsB),
      transfer: transfer,
      surplus: totalIncome - totalCosts - totalSavings,
      savingsRate: totalIncome > 0 ? totalSavings / totalIncome : 0
    };
  }

  var api = {
    CATEGORIES: CATEGORIES,
    defaultState: defaultState,
    computeBudget: computeBudget
  };

  if (typeof module !== 'undefined') module.exports = api;
  if (typeof document === 'undefined') return;

  window.App = window.App || {};
  window.App.budget = api;

  // ── Browser only from here on ─────────────────────────────────────

  var STORAGE_KEY = 'bostadskalkyl_budget_v1';
  var TEXT_IDS = ['personAName', 'personBName']; // static-check #5 registry

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || s.version !== 1 || !Array.isArray(s.incomes) || !Array.isArray(s.costs) || !Array.isArray(s.savings)) return null;
      if (!Array.isArray(s.people) || s.people.length !== 2) s.people = ['Alan', 'Partner'];
      return s;
    } catch (_) { return null; }
  }

  var state = loadState() || defaultState();

  var saveTimer = null;
  var savedFlashTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
      var el = document.getElementById('saveState');
      el.classList.add('show');
      clearTimeout(savedFlashTimer);
      savedFlashTimer = setTimeout(function () { el.classList.remove('show'); }, 1400);
    }, 250);
  }

  function nextId() {
    state.seq = (state.seq || 1000) + 1;
    return 'r' + state.seq;
  }

  // ── Formatting ────────────────────────────────────────────────────

  function fmt(n) { return App.calc.formatWithSpaces(Math.round(n)) + ' kr'; }

  function fmtSigned(n) {
    var r = Math.round(n);
    return (r > 0 ? '+' : r < 0 ? '−' : '±') + App.calc.formatWithSpaces(Math.abs(r)) + ' kr';
  }

  function setMoney(id, n, signed) {
    var el = document.getElementById(id);
    el.textContent = signed ? fmtSigned(n) : fmt(n);
  }

  function setPosNeg(el, n) {
    el.classList.toggle('positive', n > 0);
    el.classList.toggle('negative', n < 0);
  }

  function personName(owner) {
    return owner === 'a' ? (state.people[0] || 'A')
         : owner === 'b' ? (state.people[1] || 'B')
         : 'Together';
  }

  function nameStrong(owner) {
    var s = document.createElement('strong');
    s.textContent = personName(owner);
    return s;
  }

  function moneyStrong(text) {
    var s = document.createElement('strong');
    s.classList.add('pot-transfer-amount');
    s.textContent = text;
    return s;
  }

  // ── Row building & list rendering ─────────────────────────────────

  function buildRow(row, kind, withOwner) {
    var el = document.createElement('div');
    el.classList.add('b-row');
    el.dataset.id = row.id;
    el.dataset.kind = kind;

    var label = document.createElement('input');
    label.type = 'text';
    label.value = row.label;
    label.placeholder = 'What is it?';
    label.classList.add('b-row-label');
    label.setAttribute('aria-label', 'Name');
    el.appendChild(label);

    var amount = document.createElement('input');
    amount.type = 'text';
    amount.inputMode = 'numeric';
    amount.value = App.calc.formatWithSpaces(row.amount || 0);
    amount.classList.add('b-row-amount');
    amount.setAttribute('aria-label', 'Amount, kr per month');
    el.appendChild(amount);

    if (withOwner) {
      el.classList.add('has-owner');
      var sel = document.createElement('select');
      sel.classList.add('b-owner');
      sel.setAttribute('aria-label', 'Who pays');
      ['joint', 'a', 'b'].forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o;
        opt.textContent = personName(o);
        sel.appendChild(opt);
      });
      sel.value = row.owner;
      el.appendChild(sel);
    }

    var rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.classList.add('b-row-remove');
    rm.setAttribute('aria-label', 'Remove row');
    el.appendChild(rm);

    return el;
  }

  function renderIncome() {
    ['a', 'b', 'joint'].forEach(function (owner) {
      var list = document.querySelector('.income-list[data-owner="' + owner + '"]');
      list.replaceChildren();
      state.incomes.forEach(function (row) {
        if (row.owner === owner) list.appendChild(buildRow(row, 'income', false));
      });
    });
  }

  function renderCosts() {
    var wrap = document.getElementById('costGroups');
    wrap.replaceChildren();
    CATEGORIES.forEach(function (cat) {
      var group = document.createElement('div');
      group.classList.add('cost-group');

      var head = document.createElement('div');
      head.classList.add('cost-group-head');
      var title = document.createElement('span');
      title.classList.add('cost-group-title');
      title.textContent = cat.label;
      head.appendChild(title);
      if (cat.key === 'boende') {
        var link = document.createElement('a');
        link.classList.add('cost-group-link');
        link.href = 'bostadskalkyl.html';
        link.textContent = 'From Bostadskalkyl ›';
        link.title = 'Calculate your monthly housing cost';
        head.appendChild(link);
      }
      var sub = document.createElement('span');
      sub.classList.add('cost-group-sub');
      sub.dataset.catSub = cat.key;
      head.appendChild(sub);
      group.appendChild(head);

      var list = document.createElement('div');
      list.classList.add('cost-list');
      state.costs.forEach(function (row) {
        if ((row.category || 'ovrigt') === cat.key) list.appendChild(buildRow(row, 'cost', true));
      });
      group.appendChild(list);

      var add = document.createElement('button');
      add.type = 'button';
      add.classList.add('btn', 'btn-ghost', 'row-add-btn');
      add.dataset.addCost = cat.key;
      add.textContent = '+ Add cost';
      group.appendChild(add);

      wrap.appendChild(group);
    });
  }

  function renderSavings() {
    var list = document.getElementById('savingsList');
    list.replaceChildren();
    state.savings.forEach(function (row) {
      list.appendChild(buildRow(row, 'saving', true));
    });
  }

  function renderAll() {
    document.getElementById('personAName').value = state.people[0];
    document.getElementById('personBName').value = state.people[1];
    renderIncome();
    renderCosts();
    renderSavings();
    recalc();
  }

  // Owner-select labels + every place a name is printed
  function refreshNames() {
    document.querySelectorAll('.b-owner').forEach(function (sel) {
      Array.prototype.forEach.call(sel.options, function (opt) {
        opt.textContent = personName(opt.value);
      });
    });
    document.querySelectorAll('[data-name-for]').forEach(function (el) {
      var suffix = el.dataset.nameSuffix || '';
      el.textContent = personName(el.dataset.nameFor) + suffix;
    });
  }

  // ── The doughnut chart ────────────────────────────────────────────

  var costChart = null;
  var CAT_TOKENS = ['--accent', '--copper', '--accent-light', '--warn-light', '--ink-soft', '--warn', '--ink-faint'];

  function updateChart(r) {
    if (!window.Chart) return;
    var cs = getComputedStyle(document.documentElement);
    var labels = [], data = [], colors = [];
    CATEGORIES.forEach(function (cat, i) {
      var v = r.byCategory[cat.key] || 0;
      if (v > 0) {
        labels.push(cat.label);
        data.push(v);
        colors.push(cs.getPropertyValue(CAT_TOKENS[i]).trim());
      }
    });
    var paperCard = cs.getPropertyValue('--paper-card').trim();
    var inkMid = cs.getPropertyValue('--ink-mid').trim();

    if (!costChart) {
      costChart = new Chart(document.getElementById('costChart'), {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{ data: data, backgroundColor: colors, borderColor: paperCard, borderWidth: 2, hoverOffset: 6 }]
        },
        options: {
          maintainAspectRatio: false,
          cutout: '62%',
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: inkMid, boxWidth: 9, boxHeight: 9, padding: 10, font: { family: 'Inter', size: 11 } }
            },
            tooltip: {
              callbacks: {
                label: function (ctx) { return ' ' + fmt(ctx.parsed); }
              }
            }
          }
        }
      });
    } else {
      costChart.data.labels = labels;
      costChart.data.datasets[0].data = data;
      costChart.data.datasets[0].backgroundColor = colors;
      costChart.data.datasets[0].borderColor = paperCard;
      costChart.options.plugins.legend.labels.color = inkMid;
      costChart.update('none');
    }
  }

  // ── Recalculation ─────────────────────────────────────────────────

  function recalc() {
    var r = computeBudget(state);

    // Pot box (section 1)
    setMoney('d-potA', r.incomeA);
    setMoney('d-potB', r.incomeB);
    setMoney('d-potJoint', r.incomeJoint);
    setMoney('d-potTotal', r.totalIncome);
    setMoney('d-equalShare', r.equalShare);

    // Settle-up: one person pays the other to even out their salaries
    var tr = r.transfer;
    var txt = document.getElementById('potTransferText');
    var note = document.getElementById('potTransferNote');
    var transferEl = document.getElementById('potTransfer');
    if (tr.amount < 0.5) {
      transferEl.classList.add('even');
      txt.textContent = 'Incomes are already even — nothing to transfer';
    } else {
      transferEl.classList.remove('even');
      txt.replaceChildren(
        nameStrong(tr.from), document.createTextNode(' pays '),
        nameStrong(tr.to), document.createTextNode(' '),
        moneyStrong(fmt(tr.amount))
      );
    }
    note.textContent = r.incomeJoint > 0
      ? 'Joint income (' + fmt(r.incomeJoint) + ') is then shared 50/50 on top — you each take home ' + fmt(r.equalShare) + '.'
      : '';

    // Income column subtotals
    setMoney('subA', r.incomeA);
    setMoney('subB', r.incomeB);
    setMoney('subJoint', r.incomeJoint);

    // Per-category subtotals + section totals
    CATEGORIES.forEach(function (cat) {
      var el = document.querySelector('[data-cat-sub="' + cat.key + '"]');
      if (el) el.textContent = fmt(r.byCategory[cat.key] || 0);
    });
    setMoney('costsTotal', r.totalCosts);
    setMoney('savingsTotal', r.totalSavings);

    // Summary: left over
    var surplusEl = document.getElementById('s-surplus');
    surplusEl.textContent = fmtSigned(r.surplus);
    setPosNeg(surplusEl, r.surplus);
    setMoney('s-income', r.totalIncome);
    setMoney('s-costs', r.totalCosts);
    setMoney('s-savings', r.totalSavings);

    // Flow bar
    var total = r.totalIncome || 1;
    var pcts = {
      fbJoint: r.costsJoint / total,
      fbOwn: (r.costsA + r.costsB) / total,
      fbSav: r.totalSavings / total,
      fbLeft: Math.max(0, r.surplus) / total
    };
    Object.keys(pcts).forEach(function (k) {
      document.getElementById(k).style.width = (Math.max(0, Math.min(1, pcts[k])) * 100).toFixed(1) + '%';
    });
    document.getElementById('fl-joint').textContent = fmt(r.costsJoint);
    document.getElementById('fl-own').textContent = fmt(r.costsA + r.costsB);
    document.getElementById('fl-sav').textContent = fmt(r.totalSavings);
    document.getElementById('fl-left').textContent = fmt(Math.max(0, r.surplus));

    // Summary: the pot
    setMoney('s-equalShare', r.equalShare);
    setMoney('s-potA', r.incomeA);
    setMoney('s-potB', r.incomeB);
    setMoney('s-potJoint', r.incomeJoint);

    // Summary: person cards
    [['A', r.personA], ['B', r.personB]].forEach(function (pair) {
      var p = pair[1], k = pair[0];
      var left = document.getElementById('pcard' + k + 'Left');
      left.textContent = fmtSigned(p.leftover);
      setPosNeg(left, p.leftover);
      setMoney('pcard' + k + 'Share', p.ownIncome + p.potNet); // == equalShare
      document.getElementById('pcard' + k + 'Joint').textContent = '−' + fmt(p.jointCostShare);
      document.getElementById('pcard' + k + 'Own').textContent = '−' + fmt(p.ownCosts);
      document.getElementById('pcard' + k + 'Sav').textContent = '−' + fmt(p.jointSavingsShare + p.ownSavings);
    });

    // Summary: savings rate
    document.getElementById('s-savingsRate').textContent = (r.savingsRate * 100).toFixed(1) + '%';
    setMoney('s-savJoint', r.savingsJoint);
    setMoney('s-savA', r.savingsA);
    setMoney('s-savB', r.savingsB);

    // Mobile bar
    var mSurplus = document.getElementById('m-surplus');
    mSurplus.textContent = fmtSigned(r.surplus);
    setPosNeg(mSurplus, r.surplus);
    setMoney('m-each', r.equalShare);

    updateChart(r);
  }

  // ── State lookups & mutations ─────────────────────────────────────

  function listFor(kind) {
    return kind === 'income' ? state.incomes : kind === 'cost' ? state.costs : state.savings;
  }

  function findRow(kind, id) {
    var list = listFor(kind);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return { list: list, index: i, row: list[i] };
    }
    return null;
  }

  function addRow(kind, preset) {
    var row = { id: nextId(), label: '', amount: 0, owner: preset.owner };
    if (preset.category) row.category = preset.category;
    listFor(kind).push(row);
    return row;
  }

  // ── Events (delegated) ────────────────────────────────────────────

  document.addEventListener('input', function (e) {
    var t = e.target;
    var rowEl = t.closest('.b-row');
    if (rowEl) {
      var found = findRow(rowEl.dataset.kind, rowEl.dataset.id);
      if (!found) return;
      if (t.classList.contains('b-row-label')) found.row.label = t.value;
      if (t.classList.contains('b-row-amount')) found.row.amount = App.calc.parseFormatted(t.value);
      recalc();
      save();
      return;
    }
    if (t.id === 'personAName' || t.id === 'personBName') {
      state.people[t.id === 'personAName' ? 0 : 1] = t.value.trim() || (t.id === 'personAName' ? 'A' : 'B');
      refreshNames();
      recalc(); // the settle-up sentence is built with the live names
      save();
    }
  });

  document.addEventListener('focusout', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('b-row-amount')) {
      t.value = App.calc.formatWithSpaces(App.calc.parseFormatted(t.value));
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('b-owner')) {
      var rowEl = t.closest('.b-row');
      var found = findRow(rowEl.dataset.kind, rowEl.dataset.id);
      if (!found) return;
      found.row.owner = t.value;
      recalc();
      save();
    }
  });

  document.addEventListener('click', function (e) {
    var t = e.target;

    if (t.classList && t.classList.contains('b-row-remove')) {
      var rowEl = t.closest('.b-row');
      var found = findRow(rowEl.dataset.kind, rowEl.dataset.id);
      if (found) found.list.splice(found.index, 1);
      rowEl.remove();
      recalc();
      save();
      return;
    }

    var addIncome = t.closest('[data-add-income]');
    if (addIncome) {
      var owner = addIncome.dataset.addIncome;
      var row = addRow('income', { owner: owner });
      var list = document.querySelector('.income-list[data-owner="' + owner + '"]');
      var el = buildRow(row, 'income', false);
      list.appendChild(el);
      el.querySelector('.b-row-label').focus();
      save();
      return;
    }

    var addCost = t.closest('[data-add-cost]');
    if (addCost) {
      var cRow = addRow('cost', { owner: 'joint', category: addCost.dataset.addCost });
      var cEl = buildRow(cRow, 'cost', true);
      addCost.parentElement.querySelector('.cost-list').appendChild(cEl);
      cEl.querySelector('.b-row-label').focus();
      save();
      return;
    }

    if (t.id === 'addSavingsBtn' || t.closest('#addSavingsBtn')) {
      var sRow = addRow('saving', { owner: 'joint' });
      var sEl = buildRow(sRow, 'saving', true);
      document.getElementById('savingsList').appendChild(sEl);
      sEl.querySelector('.b-row-label').focus();
      save();
    }
  });

  document.getElementById('resetBtn').addEventListener('click', function () {
    if (!confirm('Reset the budget to the example data? Your current rows will be replaced.')) return;
    state = defaultState();
    renderAll();
    refreshNames();
    save();
  });

  // ── Theme (same storage key as the rest of Hemma) ────────────────

  var THEME_KEY = 'bostadskalkyl_theme';
  var themeBtn = document.getElementById('themeToggleBtn');

  function applyThemeIcon() {
    themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? '☾' : '☀';
  }

  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  }

  themeBtn.addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyThemeIcon();
    syncThemeColor();
    recalc(); // re-reads tokens for the chart colours
  });

  // ── Init ─────────────────────────────────────────────────────────

  applyThemeIcon();
  syncThemeColor();
  renderAll();
  refreshNames();
}());

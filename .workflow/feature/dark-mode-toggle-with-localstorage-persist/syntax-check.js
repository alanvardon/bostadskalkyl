  const fmt = n => Math.round(n).toLocaleString('sv-SE') + ' kr';
  const pct = n => n.toFixed(1) + '%';

  const STORAGE_KEY = 'bostadskalkyl_scenarios';
  const SESSION_KEY = 'bostadskalkyl_session';

  // ── Formatting helpers ──────────────────────────────────────────
  function formatWithSpaces(n) {
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function parseFormatted(str) {
    return parseFloat(String(str).replace(/\s/g, '').replace(/,/g, '.')) || 0;
  }

  function val(id) {
    const el = document.getElementById(id);
    if (!el) return 0;
    if (el.dataset.type === 'currency') return parseFormatted(el.value);
    return parseFloat(el.value) || 0;
  }

  function set(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('positive', 'negative');
    if (cls) el.classList.add(cls);
  }

  // ── Chart colour helper ─────────────────────────────────────────
  function getChartColors() {
    const style = getComputedStyle(document.documentElement);
    const get = v => style.getPropertyValue(v).trim();
    return {
      grid:         get('--rule'),
      tick:         get('--ink-soft'),
      tooltipBg:    get('--paper-card'),
      tooltipBorder:get('--rule'),
      tooltipTitle: get('--ink'),
      tooltipBody:  get('--ink-mid'),
      legend:       get('--ink-mid'),
    };
  }

  // ── State ───────────────────────────────────────────────────────
  let activeScenarioId = null;  // id of loaded scenario, or null
  let isDirty = false;          // unsaved changes since last save/load

  // ── Input IDs ──────────────────────────────────────────────────
  const CURRENCY_IDS = ['salePrice','currentMortgage','agentCost','movingCost','newPrice','deposit','existingPantbrev','propertyTax','driftkostnad'];
  const NUMBER_IDS   = ['amortRate','interestRateA','interestRateB','currentTerm','currentAmortRate','affordThreshold'];
  const TEXT_IDS     = ['bankAName','bankBName','listingUrl'];
  const ALL_IDS      = [...CURRENCY_IDS, ...NUMBER_IDS];

  // ── Read / write all inputs ─────────────────────────────────────
  function readInputs() {
    const data = {};
    ALL_IDS.forEach(id => { data[id] = val(id); });
    TEXT_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) data[id] = el.value;
    });
    data.ranteavdrag = document.getElementById('ranteavdragToggle').checked;
    return data;
  }

  function writeInputs(data) {
    CURRENCY_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el && data[id] !== undefined) el.value = formatWithSpaces(data[id]);
    });
    NUMBER_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el && data[id] !== undefined) el.value = data[id];
    });
    TEXT_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el && data[id] !== undefined) el.value = data[id];
    });
    if (data.ranteavdrag !== undefined) {
      document.getElementById('ranteavdragToggle').checked = data.ranteavdrag;
    }
    calc();
  }

  // ── localStorage helpers ────────────────────────────────────────
  function loadScenarios() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch { return []; }
  }

  function saveScenarios(scenarios) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scenarios));
  }

  function saveSession() {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ inputs: readInputs(), activeScenarioId, isDirty }));
  }

  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (s && s.inputs) {
        writeInputs(s.inputs);
        activeScenarioId = s.activeScenarioId || null;
        isDirty = s.isDirty || false;
        updateHeaderLabel();
      }
    } catch {}
  }

  // ── Header label ───────────────────────────────────────────────
  function updateHeaderLabel() {
    const labelEl = document.getElementById('activeScenarioLabel');
    const saveBtn = document.getElementById('saveBtn');
    const scenarios = loadScenarios();
    const active = scenarios.find(s => s.id === activeScenarioId);

    if (active) {
      labelEl.style.display = 'inline';
      labelEl.innerHTML = `<span class="active-scenario-name">${active.name}</span>${isDirty ? '<span class="unsaved-dot" title="Unsaved changes"></span>' : ''}`;
      saveBtn.textContent = isDirty ? 'Update' : 'Save as new';
    } else {
      labelEl.style.display = isDirty ? 'inline' : 'none';
      labelEl.innerHTML = isDirty ? '<span class="active-scenario-name">Unsaved</span><span class="unsaved-dot"></span>' : '';
      saveBtn.textContent = 'Save';
    }
  }

  // ── Mark dirty on any input change ────────────────────────────
  function markDirty() {
    isDirty = true;
    updateHeaderLabel();
    saveSession();
  }

  // ── Calc ───────────────────────────────────────────────────────
  function calc() {
    const salePrice        = val('salePrice');
    const currentMortgage  = val('currentMortgage');
    const agentCost        = val('agentCost');
    const movingCost       = val('movingCost');
    const newPrice         = val('newPrice');
    const deposit          = val('deposit');
    const existingPantbrev = val('existingPantbrev');
    const amortRate        = val('amortRate');
    const propertyTax      = val('propertyTax');
    const driftkostnad     = val('driftkostnad');
    const interestRateA    = val('interestRateA');
    const interestRateB    = val('interestRateB');
    const affordThreshold  = val('affordThreshold') || 30;
    const ranteavdrag      = document.getElementById('ranteavdragToggle').checked;

    const totalTakeaway     = salePrice - currentMortgage;
    const netProceeds       = totalTakeaway - agentCost - movingCost;
    const loanAmount        = newPrice - deposit;
    const lagfart           = newPrice * 0.015;
    const newPantbrevNeeded = Math.max(0, loanAmount - existingPantbrev);
    const pantbrevCost      = newPantbrevNeeded * 0.02;
    const totalUpfront      = deposit + lagfart + pantbrevCost;
    const movingCosts       = agentCost + movingCost + lagfart + pantbrevCost;
    const cashBalance       = netProceeds - totalUpfront;
    const ltv               = newPrice > 0 ? (loanAmount / newPrice) * 100 : 0;
    const monthlyAmort      = (loanAmount * (amortRate / 100)) / 12;
    const taxMonthly        = propertyTax / 12;
    const threshold         = 100000;

    // Bank A
    const interestA      = (loanAmount * (interestRateA / 100)) / 12;
    const totalA         = interestA + monthlyAmort + taxMonthly + driftkostnad;
    const annualInterestA = interestA * 12;
    const reliefA        = annualInterestA <= threshold
      ? annualInterestA * 0.30
      : threshold * 0.30 + (annualInterestA - threshold) * 0.21;
    const effectiveA     = totalA - reliefA / 12;

    // Bank B
    const interestB      = (loanAmount * (interestRateB / 100)) / 12;
    const totalB         = interestB + monthlyAmort + taxMonthly + driftkostnad;
    const annualInterestB = interestB * 12;
    const reliefB        = annualInterestB <= threshold
      ? annualInterestB * 0.30
      : threshold * 0.30 + (annualInterestB - threshold) * 0.21;
    const effectiveB     = totalB - reliefB / 12;
    const diff           = totalA - totalB;
    const totalMonthly   = totalA;

    // ── Ränteavdrag summary card values ───────────────────────
    const relief           = reliefA;
    const effectiveMonthly = effectiveA;

    // ── Affordability ──────────────────────────────────────────
    const monthlyBase      = ranteavdrag ? effectiveMonthly : totalMonthly;
    const reqSalaryMonthly = monthlyBase / (affordThreshold / 100);

    // ── Equity at key years ───────────────────────────────────
    const annualAmort = loanAmount * (amortRate / 100);
    const equityAt = yr => Math.min(deposit + annualAmort * yr, newPrice);

    // ── Stress slider ──────────────────────────────────────────
    const stressSlider = document.getElementById('stressSlider');
    if (stressSlider.dataset.syncedRate !== String(interestRateA)) {
      stressSlider.value = interestRateA;
      stressSlider.dataset.syncedRate = String(interestRateA);
    }
    const stressRate  = parseFloat(stressSlider.value);
    const stressMI    = (loanAmount * (stressRate / 100)) / 12;
    const stressTotal = stressMI + monthlyAmort + taxMonthly + driftkostnad;
    const stressAnn   = loanAmount * (stressRate / 100);
    const stressRel   = stressAnn <= threshold
      ? stressAnn * 0.30
      : threshold * 0.30 + (stressAnn - threshold) * 0.21;
    const stressAfter = stressTotal - stressRel / 12;
    document.getElementById('stressRateDisplay').textContent = stressRate.toFixed(1) + '%';
    document.getElementById('stressMonthlyInterest').textContent = fmt(stressMI);
    const stressTotalEl = document.getElementById('stressTotalMonthly');
    stressTotalEl.textContent = fmt(stressTotal);
    stressTotalEl.style.color = stressRate > 6 ? 'var(--warn)' : '';
    document.getElementById('stressAfterRelief').textContent = fmt(stressAfter);

    // ── Deposit % hint ───────────────────────────────────────
    const depPct = newPrice > 0 ? ((deposit / newPrice) * 100).toFixed(1) : '0';
    document.getElementById('depositPct').textContent = depPct + '% of purchase price';

    // ── Inline derived ───────────────────────────────────────
    set('d-takeaway',    fmt(totalTakeaway), totalTakeaway >= 0 ? 'positive' : 'negative');
    set('d-netProceeds', fmt(netProceeds),   netProceeds >= 0 ? 'positive' : 'negative');
    set('d-loanAmount',     fmt(loanAmount));
    set('d-lagfart',        fmt(lagfart));
    set('d-newPantbrevAmt', fmt(newPantbrevNeeded));
    set('d-pantbrevCost',   fmt(pantbrevCost));
    set('d-totalUpfront',   fmt(totalUpfront));
    set('d-cashBalance',    (cashBalance >= 0 ? '+' : '') + fmt(cashBalance), cashBalance >= 0 ? 'positive' : 'negative');

    set('d-interestA', fmt(interestA));
    set('d-amortA',    fmt(monthlyAmort));
    set('d-taxA',      fmt(taxMonthly));
    set('d-driftA',    fmt(driftkostnad));
    set('d-totalA',    fmt(totalA));
    set('d-reliefA',   '−' + fmt(reliefA / 12));
    set('d-effectiveA', fmt(effectiveA));

    set('d-interestB', fmt(interestB));
    set('d-amortB',    fmt(monthlyAmort));
    set('d-taxB',      fmt(taxMonthly));
    set('d-driftB',    fmt(driftkostnad));
    set('d-totalB',    fmt(totalB));
    set('d-reliefB',   '−' + fmt(reliefB / 12));
    set('d-effectiveB', fmt(effectiveB));

    const diffEl    = document.getElementById('d-bankDiff');
    const bankAName = document.getElementById('bankAName').value.trim() || 'Bank A';
    const bankBName = document.getElementById('bankBName').value.trim() || 'Bank B';
    document.getElementById('d-bankDiffLabel').textContent = `Difference (${bankAName} vs ${bankBName})`;
    if (diff > 0) {
      diffEl.textContent = `${bankBName} is cheaper by ${fmt(Math.abs(diff))}/mo`;
      diffEl.className = 'derived-value positive';
    } else if (diff < 0) {
      diffEl.textContent = `${bankAName} is cheaper by ${fmt(Math.abs(diff))}/mo`;
      diffEl.className = 'derived-value positive';
    } else {
      diffEl.textContent = 'Same cost';
      diffEl.className = 'derived-value';
    }

    // ── Summary ───────────────────────────────────────────────
    set('s-netProceeds',  fmt(netProceeds), netProceeds >= 0 ? 'positive' : 'negative');
    set('s-takeaway',     fmt(totalTakeaway));
    set('s-costs',        '−' + fmt(agentCost + movingCost));
    set('s-totalUpfront', fmt(totalUpfront));
    set('s-deposit',      fmt(deposit));
    set('s-lagfart',      fmt(lagfart));
    set('s-pantbrev',     fmt(pantbrevCost));
    set('s-loanAmount',   fmt(loanAmount));
    set('s-ltv',          pct(100 - ltv));
    set('s-totalMonthly', fmt(totalMonthly));
    set('s-interest',     fmt(interestA));
    set('s-amort',        fmt(monthlyAmort));
    set('s-tax',          fmt(taxMonthly));
    set('s-drift',        fmt(driftkostnad));

    // Ränteavdrag card
    const rCard = document.getElementById('ranteavdragCard');
    rCard.style.display = '';
    set('s-ranteavdrag',      fmt(relief / 12) + '/mo');
    set('s-annualInterest',   fmt(annualInterestA) + '/yr');
    set('s-skatteverket',     fmt(relief) + '/yr');
    set('s-effectiveMonthly', fmt(effectiveMonthly));

    // Affordability
    set('s-reqSalary', fmt(reqSalaryMonthly) + '/mo');

    // Equity
    set('s-equity5',  fmt(equityAt(5)),  'positive');
    set('s-equity10', fmt(equityAt(10)), 'positive');
    set('s-equity20', fmt(equityAt(20)), 'positive');

    // LTV bar — shows equity (inverse of LTV)
    const equity = 100 - ltv;
    const ltvBar = document.getElementById('ltv-bar');
    ltvBar.style.width = Math.min(Math.max(equity, 0), 100) + '%';
    ltvBar.style.background = equity < 15 ? 'var(--warn)' : equity < 30 ? 'var(--warn-light)' : 'var(--accent)';

    // P&L card
    const savingsTotal  = getSavingsTotal();
    const totalBalance  = cashBalance + savingsTotal;
    const pnlCard = document.getElementById('pnl-card');
    pnlCard.classList.remove('pnl-positive', 'pnl-negative');
    if (totalBalance > 0) pnlCard.classList.add('pnl-positive');
    else if (totalBalance < 0) pnlCard.classList.add('pnl-negative');
    set('s-cashBalance', (totalBalance >= 0 ? '+' : '') + fmt(totalBalance), totalBalance >= 0 ? 'positive' : 'negative');
    set('s-pnl-net',     fmt(netProceeds));
    set('s-pnl-upfront', '−' + fmt(totalUpfront));

    // Savings row in P&L card
    const savingsRow = document.getElementById('s-savings-row');
    if (savingsTotal > 0) {
      savingsRow.style.display = '';
      set('s-savings-total', '+' + fmt(savingsTotal), 'positive');
    } else {
      savingsRow.style.display = 'none';
    }

    // Listing link
    const url = (document.getElementById('listingUrl').value || '').trim();
    const linkWrap = document.getElementById('listingLinkWrap');
    const linkBtn  = document.getElementById('listingLinkBtn');
    if (url) {
      const full = url.startsWith('http') ? url : 'https://' + url;
      linkWrap.style.display = '';
      linkBtn.href = full;
      linkBtn.textContent = full;
    } else {
      linkWrap.style.display = 'none';
    }
  }

  function openListingLink(e) {
    e.preventDefault();
    const url = (document.getElementById('listingUrl').value || '').trim();
    if (!url) return;
    const full = url.startsWith('http') ? url : 'https://' + url;
    window.open(full, '_blank');
  }

  // ── Event listeners ────────────────────────────────────────────
  document.querySelectorAll('input[data-type="currency"]').forEach(el => {
    el.addEventListener('focus', function() {
      this.value = parseFormatted(this.value) || '';
    });
    el.addEventListener('blur', function() {
      const n = parseFormatted(this.value);
      if (!isNaN(n) && this.value !== '') this.value = formatWithSpaces(n);
      calc();
      markDirty();
    });
    el.addEventListener('input', () => { calc(); markDirty(); });
  });

  document.querySelectorAll('input[type="number"]').forEach(el => {
    el.addEventListener('input', () => { calc(); markDirty(); });
  });

  document.querySelectorAll('.bank-name-input').forEach(el => {
    el.addEventListener('input', () => { calc(); markDirty(); });
  });

  document.getElementById('listingUrl').addEventListener('input', () => { calc(); markDirty(); });

  // ── Save flow ──────────────────────────────────────────────────
  let saveMode = 'new'; // 'new' or 'update'

  function handleSaveClick() {
    const scenarios = loadScenarios();
    const active = scenarios.find(s => s.id === activeScenarioId);

    if (active && isDirty) {
      // Offer update or save as new
      openUpdatePrompt(active.name);
    } else {
      openNewSavePrompt();
    }
  }

  function openNewSavePrompt() {
    saveMode = 'new';
    document.getElementById('savePromptTitle').textContent = 'Save scenario';
    document.getElementById('saveNameInput').value = '';
    document.getElementById('savePrompt').classList.add('open');
    setTimeout(() => document.getElementById('saveNameInput').focus(), 50);
  }

  function openUpdatePrompt(name) {
    // Show a choice: update existing or save as new
    saveMode = 'update';
    document.getElementById('savePromptTitle').innerHTML =
      `Update <em>${name}</em> or save as new?`;
    document.getElementById('saveNameInput').value = '';
    document.getElementById('saveNameInput').placeholder = 'Leave blank to update, or enter a new name…';
    document.getElementById('savePrompt').classList.add('open');
    setTimeout(() => document.getElementById('saveNameInput').focus(), 50);
  }

  function closeSavePrompt() {
    document.getElementById('savePrompt').classList.remove('open');
    document.getElementById('saveNameInput').placeholder = 'e.g. Lidingö house, Scenario A…';
  }

  function confirmSave() {
    const nameInput = document.getElementById('saveNameInput').value.trim();
    const scenarios = loadScenarios();

    if (saveMode === 'update' && !nameInput) {
      // Update existing
      const idx = scenarios.findIndex(s => s.id === activeScenarioId);
      if (idx !== -1) {
        scenarios[idx].inputs = readInputs();
        scenarios[idx].savedAt = new Date().toISOString();
        saveScenarios(scenarios);
        isDirty = false;
        updateHeaderLabel();
        saveSession();
      }
    } else {
      // Save as new
      const name = nameInput || 'Unnamed scenario';
      const newScenario = {
        id: Date.now().toString(),
        name,
        savedAt: new Date().toISOString(),
        inputs: readInputs()
      };
      scenarios.push(newScenario);
      saveScenarios(scenarios);
      activeScenarioId = newScenario.id;
      isDirty = false;
      updateHeaderLabel();
      saveSession();
    }

    closeSavePrompt();
  }

  // Enter key in save prompt
  document.getElementById('saveNameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmSave();
    if (e.key === 'Escape') closeSavePrompt();
  });

  // ── Scenarios modal ────────────────────────────────────────────
  function openScenariosModal() {
    renderScenariosModal();
    document.getElementById('scenariosModal').classList.add('open');
  }

  function closeModal() {
    document.getElementById('scenariosModal').classList.remove('open');
  }

  document.getElementById('scenariosModal').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
  });

  function renderScenariosModal() {
    const scenarios = loadScenarios();
    const body = document.getElementById('scenariosBody');

    if (scenarios.length === 0) {
      body.innerHTML = `<div class="modal-empty">No saved scenarios yet.<br>Hit <strong>Save</strong> to store your first calculation.</div>`;
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'scenario-grid';

    scenarios.forEach(s => {
      const card = document.createElement('div');
      card.className = 'scenario-card' + (s.id === activeScenarioId ? ' active-card' : '');

      // Compute preview stats
      const d        = s.inputs;
      const loanAmt  = (d.newPrice || 0) - (d.deposit || 0);
      const monthly  = ((loanAmt * ((d.interestRateA || 0) / 100)) / 12)
                     + ((loanAmt * ((d.amortRate || 0) / 100)) / 12)
                     + ((d.propertyTax || 0) / 12)
                     + (d.driftkostnad || 0);
      const takeaway = (d.salePrice || 0) - (d.currentMortgage || 0);
      const netProc  = takeaway - (d.agentCost || 0) - (d.movingCost || 0);
      const lagfart  = (d.newPrice || 0) * 0.015;
      const newPb    = Math.max(0, loanAmt - (d.existingPantbrev || 0));
      const upfront  = (d.deposit || 0) + lagfart + newPb * 0.02;
      const cash     = netProc - upfront;

      const dateStr = new Date(s.savedAt).toLocaleDateString('sv-SE', { day:'numeric', month:'short', year:'numeric' });

      card.innerHTML = `
        <div class="scenario-card-name">${s.name}</div>
        <div class="scenario-card-date">Saved ${dateStr}</div>
        <div class="scenario-card-stats">
          <div class="scenario-stat">
            <span class="scenario-stat-label">New property</span>
            <span class="scenario-stat-val">${fmt(d.newPrice||0)}</span>
          </div>
          <div class="scenario-stat">
            <span class="scenario-stat-label">Monthly cost</span>
            <span class="scenario-stat-val">${fmt(monthly)}</span>
          </div>
          <div class="scenario-stat">
            <span class="scenario-stat-label">Cash surplus / shortfall</span>
            <span class="scenario-stat-val ${cash >= 0 ? 'pos' : 'neg'}">${(cash >= 0 ? '+' : '') + fmt(cash)}</span>
          </div>
        </div>
        <div class="scenario-card-actions">
          <button class="btn btn-ghost" onclick="loadScenario('${s.id}')">Load</button>
          <button class="btn btn-danger" onclick="deleteScenario('${s.id}', event)">Delete</button>
        </div>
      `;

      grid.appendChild(card);
    });

    body.innerHTML = '';
    body.appendChild(grid);
  }

  function loadScenario(id) {
    const scenarios = loadScenarios();
    const s = scenarios.find(sc => sc.id === id);
    if (!s) return;
    writeInputs(s.inputs);
    activeScenarioId = id;
    isDirty = false;
    updateHeaderLabel();
    saveSession();
    closeModal();
  }

  function deleteScenario(id, e) {
    e.stopPropagation();
    const scenarios = loadScenarios().filter(s => s.id !== id);
    saveScenarios(scenarios);
    if (activeScenarioId === id) {
      activeScenarioId = null;
      isDirty = true;
    }
    updateHeaderLabel();
    saveSession();
    renderScenariosModal();
  }

  // ── Amortisation modal ─────────────────────────────────────────
  let amortChartInstance = null;
  let lumpSums = []; // [{year, amount}]

  function openAmortModal() {
    document.getElementById('amortModal').classList.add('open');
    renderAmortChart();
  }

  function closeAmortModal() {
    document.getElementById('amortModal').classList.remove('open');
  }

  document.getElementById('amortModal').addEventListener('click', function(e) {
    if (e.target === this) closeAmortModal();
  });

  function buildAmortSchedule(startBalance, annualAmortRate, lumpPayments, termCap) {
    const yearlyAmort = startBalance * (annualAmortRate / 100);
    let balance = startBalance;
    const points = [{ year: 0, balance }];
    let year = 0;
    const limit = termCap || 200;
    while (balance > 0 && year < limit) {
      year++;
      const lump = lumpPayments
        .filter(p => p.year === year)
        .reduce((s, p) => s + p.amount, 0);
      balance = Math.max(0, balance - yearlyAmort - lump);
      points.push({ year, balance });
      if (balance === 0) break;
    }
    return points;
  }

  function renderAmortChart() {
    const currentBalance  = val('currentMortgage');
    const currentAmort    = val('currentAmortRate');
    const currentTerm     = val('currentTerm');
    const newBalance      = val('newPrice') - val('deposit');
    const newAmortRate    = val('amortRate');

    if (newAmortRate <= 0 || currentAmort <= 0) return;

    // Build schedules
    const currentSchedule = buildAmortSchedule(currentBalance, currentAmort, [], currentTerm);
    const newSchedule     = buildAmortSchedule(newBalance, newAmortRate, lumpSums);

    // X axis: union of all years up to max
    const maxYear = Math.max(
      currentSchedule[currentSchedule.length - 1].year,
      newSchedule[newSchedule.length - 1].year
    );
    const years = Array.from({ length: maxYear + 1 }, (_, i) => i);

    const getBalance = (schedule, year) => {
      const pt = schedule.find(p => p.year === year);
      if (pt) return pt.balance;
      return schedule[schedule.length - 1].year < year ? 0 : null;
    };

    const currentData = years.map(y => getBalance(currentSchedule, y));
    const newData     = years.map(y => getBalance(newSchedule, y));

    const currentPayoffPt = currentSchedule.find(p => p.balance === 0);
    const currentPayoff = currentPayoffPt
      ? currentPayoffPt.year
      : (currentTerm > 0 ? currentTerm : null);
    const newPayoff = newSchedule.find(p => p.balance === 0)?.year;

    // Meta stats
    document.getElementById('amortMeta').innerHTML = `
      <div class="amort-meta-row">
        <div class="amort-stat">
          <span class="amort-stat-label">Current balance</span>
          <span class="amort-stat-val">${fmt(currentBalance)}</span>
        </div>
        <div class="amort-stat">
          <span class="amort-stat-label">Amort rate</span>
          <span class="amort-stat-val">${currentAmort}%</span>
        </div>
        <div class="amort-stat">
          <span class="amort-stat-label">Payoff</span>
          <span class="amort-stat-val">${currentPayoff != null ? currentPayoff + ' yrs' : '—'}</span>
        </div>
      </div>
      <div class="amort-meta-row">
        <div class="amort-stat">
          <span class="amort-stat-label">New balance</span>
          <span class="amort-stat-val">${fmt(newBalance)}</span>
        </div>
        <div class="amort-stat">
          <span class="amort-stat-label">Amort rate</span>
          <span class="amort-stat-val">${newAmortRate}%</span>
        </div>
        <div class="amort-stat">
          <span class="amort-stat-label">Payoff</span>
          <span class="amort-stat-val">${newPayoff != null ? newPayoff + ' yrs' : '—'}</span>
        </div>
      </div>
    `;

    const ctx = document.getElementById('amortChart').getContext('2d');
    if (amortChartInstance) amortChartInstance.destroy();

    const cc = getChartColors();

    const datasets = [
      {
        label: 'Current mortgage',
        data: currentData,
        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--warn-light').trim(),
        backgroundColor: 'rgba(184,122,42,0.06)',
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.3,
        fill: false,
      },
      {
        label: 'New mortgage',
        data: newData,
        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        backgroundColor: 'rgba(45,90,61,0.08)',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.3,
        fill: false,
      }
    ];

    amortChartInstance = new Chart(ctx, {
      type: 'line',
      data: { labels: years, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              font: { family: 'DM Sans', size: 12 },
              color: cc.legend,
              boxWidth: 14,
              padding: 16,
            }
          },
          tooltip: {
            backgroundColor: cc.tooltipBg,
            borderColor: cc.tooltipBorder,
            borderWidth: 1,
            titleColor: cc.tooltipTitle,
            bodyColor: cc.tooltipBody,
            titleFont: { family: 'DM Sans', size: 12, weight: '500' },
            bodyFont: { family: 'DM Sans', size: 12 },
            padding: 10,
            callbacks: {
              title: items => `Year ${items[0].label}`,
              label: item => {
                const v = item.raw;
                if (v === null || v === undefined) return null;
                return ` ${item.dataset.label}: ${Math.round(v).toLocaleString('sv-SE')} kr`;
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'Years from now', font: { family: 'DM Sans', size: 12 }, color: cc.tick },
            grid: { color: cc.grid, lineWidth: 0.5 },
            ticks: { font: { family: 'DM Sans', size: 11 }, color: cc.tick, maxTicksLimit: 15 }
          },
          y: {
            title: { display: true, text: 'Remaining balance (kr)', font: { family: 'DM Sans', size: 12 }, color: cc.tick },
            grid: { color: cc.grid, lineWidth: 0.5 },
            ticks: {
              font: { family: 'DM Sans', size: 11 },
              color: cc.tick,
              callback: v => (v / 1000000).toFixed(1) + ' Mkr'
            }
          }
        }
      }
    });
  }

  // ── Lump sums ──────────────────────────────────────────────────
  function addLumpSum() {
    lumpSums.push({ year: 5, amount: 100000 });
    renderLumpSums();
    renderAmortChart();
  }

  function removeLumpSum(i) {
    lumpSums.splice(i, 1);
    renderLumpSums();
    renderAmortChart();
  }

  function renderLumpSums() {
    const list = document.getElementById('lumpSumList');
    list.innerHTML = '';
    lumpSums.forEach((ls, i) => {
      const row = document.createElement('div');
      row.className = 'lump-row';
      row.innerHTML = `
        <div class="field">
          <label>Year</label>
          <div class="input-wrap">
            <input type="number" min="1" max="100" step="1" value="${ls.year}"
              onchange="lumpSums[${i}].year = Math.max(1, parseInt(this.value)||1); renderAmortChart()">
          </div>
        </div>
        <div class="field">
          <label>Amount</label>
          <div class="input-wrap has-suffix">
            <input type="text" inputmode="numeric" value="${formatWithSpaces(ls.amount)}"
              onfocus="this.value = parseFormatted(this.value) || ''"
              onblur="this.value = formatWithSpaces(parseFormatted(this.value) || 0); lumpSums[${i}].amount = parseFormatted(this.value); renderAmortChart()"
              oninput="lumpSums[${i}].amount = parseFormatted(this.value); renderAmortChart()">
            <span class="suffix">kr</span>
          </div>
        </div>
        <button class="lump-remove" onclick="removeLumpSum(${i})" title="Remove">×</button>
      `;
      list.appendChild(row);
    });
  }

  function calcTargetLumpSum() {
    const newBalance    = val('newPrice') - val('deposit');
    const newAmortRate  = val('amortRate');
    const targetYear    = parseInt(document.getElementById('targetPayoffYear').value) || 0;
    const paymentYear   = 1;
    const resultEl      = document.getElementById('targetResult');
    const lumpField     = document.getElementById('targetLumpResult');

    lumpField.value = '';
    resultEl.className = 'amort-target-result';
    resultEl.innerHTML = '';

    if (!targetYear || targetYear <= 0) {
      resultEl.className = 'amort-target-result no-solution';
      resultEl.innerHTML = 'Enter a target payoff year.';
      return;
    }

    const testSchedule = candidate => buildAmortSchedule(
      newBalance, newAmortRate, [{ year: paymentYear, amount: candidate }]
    );

    // Check if no lump sum already achieves it
    const noLumpSchedule = buildAmortSchedule(newBalance, newAmortRate, []);
    const noLumpPayoff = noLumpSchedule.find(p => p.balance === 0)?.year;
    if (noLumpPayoff && noLumpPayoff <= targetYear) {
      lumpField.value = '0';
      resultEl.className = 'amort-target-result has-result';
      resultEl.innerHTML = `Already paid off by year ${noLumpPayoff} — no lump sum needed.`;
      return;
    }

    // Check if even full balance pays off in time
    const fullPayoff = testSchedule(newBalance);
    const fullPayoffYear = fullPayoff.find(p => p.balance === 0)?.year;
    if (!fullPayoffYear || fullPayoffYear > targetYear) {
      resultEl.className = 'amort-target-result no-solution';
      resultEl.innerHTML = 'Not achievable — try a later target year or earlier payment year.';
      return;
    }

    // Binary search
    let lo = 0, hi = newBalance, mid, found = null;
    for (let i = 0; i < 60; i++) {
      mid = (lo + hi) / 2;
      const sched = testSchedule(mid);
      const payoff = sched.find(p => p.balance === 0)?.year;
      if (payoff && payoff <= targetYear) { found = mid; hi = mid; }
      else lo = mid;
    }

    if (found === null) {
      resultEl.className = 'amort-target-result no-solution';
      resultEl.innerHTML = 'Could not find a solution. Try a later target year.';
      return;
    }

    const lumpAmount = Math.ceil(found / 1000) * 1000;
    const annualExtra = Math.round(lumpAmount / targetYear);
    lumpField.value = formatWithSpaces(lumpAmount);
    resultEl.className = 'amort-target-result has-result';
    resultEl.innerHTML = `Pay in year 1 → mortgage-free by year ${targetYear}. That's an extra ${fmt(annualExtra)} / year spread over the term.`;
  }

  // ── Driftkostnad modal ─────────────────────────────────────────
  const DRIFT_STORAGE_KEY = 'bostadskalkyl_drift_items';
  const DEFAULT_DRIFT = [
    { id: 'drift_0', label: 'Electricity',     amount: 0 },
    { id: 'drift_1', label: 'Vatten / avlopp', amount: 0 },
    { id: 'drift_2', label: 'Renhållning',     amount: 0 },
    { id: 'drift_3', label: 'Home insurance',  amount: 0 },
    { id: 'drift_4', label: 'Internet',        amount: 0 },
  ];

  let driftItems   = [];
  let driftYearly  = false;

  function loadDriftItems() {
    try {
      const stored = JSON.parse(localStorage.getItem(DRIFT_STORAGE_KEY));
      driftItems = stored && stored.length ? stored : JSON.parse(JSON.stringify(DEFAULT_DRIFT));
    } catch { driftItems = JSON.parse(JSON.stringify(DEFAULT_DRIFT)); }
  }

  function saveDriftItems() {
    localStorage.setItem(DRIFT_STORAGE_KEY, JSON.stringify(driftItems));
  }

  function openDriftModal() {
    loadDriftItems();
    driftYearly = localStorage.getItem('bostadskalkyl_drift_yearly') === 'true';
    document.getElementById('driftYearlyToggle').checked = driftYearly;
    renderDriftItems();
    document.getElementById('driftModal').classList.add('open');
  }

  function closeDriftModal() {
    document.getElementById('driftModal').classList.remove('open');
  }

  document.getElementById('driftModal').addEventListener('click', function(e) {
    if (e.target === this) closeDriftModal();
  });

  function toggleDriftMode() {
    driftYearly = document.getElementById('driftYearlyToggle').checked;
    localStorage.setItem('bostadskalkyl_drift_yearly', driftYearly);
    renderDriftItems();
  }

  function addDriftItem() {
    const id = 'drift_' + Date.now();
    driftItems.push({ id, label: '', amount: 0 });
    saveDriftItems();
    renderDriftItems();
    // Focus the new label input
    const inputs = document.querySelectorAll('.drift-item-label-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function removeDriftItem(id) {
    driftItems = driftItems.filter(d => d.id !== id);
    saveDriftItems();
    renderDriftItems();
    updateDriftTotal();
  }

  function renderDriftItems() {
    const list  = document.getElementById('driftItemList');
    const label = driftYearly ? 'kr/yr' : 'kr/mo';
    list.innerHTML = '';

    driftItems.forEach((item, idx) => {
      const displayVal = item.amount > 0
        ? formatWithSpaces(driftYearly ? item.amount * 12 : item.amount)
        : '';
      const row = document.createElement('div');
      row.className = 'drift-item-row';
      row.innerHTML = `
        <input type="text" class="drift-item-label-input" placeholder="Category name"
          value="${item.label}"
          onchange="driftItems[${idx}].label = this.value; saveDriftItems();">
        <div class="input-wrap has-suffix">
          <input type="text" inputmode="numeric" value="${displayVal}" placeholder="0"
            data-drift-idx="${idx}"
            onfocus="this.value = parseFormatted(this.value) || ''"
            onblur="this.value = this.value ? formatWithSpaces(parseFormatted(this.value)) : ''; updateDriftAmount(${idx}, parseFormatted(this.value)); updateDriftTotal();"
            oninput="updateDriftTotal()">
          <span class="suffix">${label}</span>
        </div>
        <button class="drift-delete" onclick="removeDriftItem('${item.id}')" title="Remove">×</button>
      `;
      list.appendChild(row);
    });

    updateDriftTotal();
  }

  function updateDriftAmount(idx, inputVal) {
    const monthly = driftYearly ? inputVal / 12 : inputVal;
    driftItems[idx].amount = monthly;
    saveDriftItems();
  }

  function updateDriftTotal() {
    // Sum from live inputs (not stale driftItems) so it updates while typing
    let total = 0;
    document.querySelectorAll('input[data-drift-idx]').forEach(el => {
      const idx    = parseInt(el.dataset.driftIdx);
      const rawVal = parseFormatted(el.value) || 0;
      total += driftYearly ? rawVal / 12 : rawVal;
    });

    document.getElementById('driftModalTotal').textContent = fmt(total);

    // Push into Section 3
    if (total > 0) {
      const driftEl = document.getElementById('driftkostnad');
      driftEl.value = formatWithSpaces(total);
      calc();
      markDirty();
    }
  }

  // ── Fullscreen chart ───────────────────────────────────────────
  let fullscreenChartInstance = null;

  function openFullscreenChart() {
    if (!amortChartInstance) return;
    const backdrop = document.getElementById('chartFullscreen');
    backdrop.classList.add('open');

    const src = amortChartInstance;
    const ctx  = document.getElementById('amortChartFull').getContext('2d');
    if (fullscreenChartInstance) fullscreenChartInstance.destroy();

    const cc = getChartColors();

    // Build fresh options using theme-aware colours rather than cloning frozen hex values
    fullscreenChartInstance = new Chart(ctx, {
      type: src.config.type,
      data: JSON.parse(JSON.stringify(src.config.data)),
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              font: { family: 'DM Sans', size: 12 },
              color: cc.legend,
              boxWidth: 14,
              padding: 16,
            }
          },
          tooltip: {
            backgroundColor: cc.tooltipBg,
            borderColor: cc.tooltipBorder,
            borderWidth: 1,
            titleColor: cc.tooltipTitle,
            bodyColor: cc.tooltipBody,
            titleFont: { family: 'DM Sans', size: 12, weight: '500' },
            bodyFont: { family: 'DM Sans', size: 12 },
            padding: 10,
            callbacks: {
              title: items => `Year ${items[0].label}`,
              label: item => {
                const v = item.raw;
                if (v === null || v === undefined) return null;
                return ` ${item.dataset.label}: ${Math.round(v).toLocaleString('sv-SE')} kr`;
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'Years from now', font: { family: 'DM Sans', size: 12 }, color: cc.tick },
            grid: { color: cc.grid, lineWidth: 0.5 },
            ticks: { font: { family: 'DM Sans', size: 11 }, color: cc.tick, maxTicksLimit: 15 }
          },
          y: {
            title: { display: true, text: 'Remaining balance (kr)', font: { family: 'DM Sans', size: 12 }, color: cc.tick },
            grid: { color: cc.grid, lineWidth: 0.5 },
            ticks: {
              font: { family: 'DM Sans', size: 11 },
              color: cc.tick,
              callback: v => (v / 1000000).toFixed(1) + ' Mkr'
            }
          }
        }
      }
    });
  }

  function closeFullscreenChart() {
    const backdrop = document.getElementById('chartFullscreen');
    backdrop.classList.remove('open');
    setTimeout(() => {
      if (fullscreenChartInstance) { fullscreenChartInstance.destroy(); fullscreenChartInstance = null; }
    }, 250);
  }

  document.getElementById('chartFullscreen').addEventListener('click', function(e) {
    if (e.target === this) closeFullscreenChart();
  });

  // ── Savings modal ──────────────────────────────────────────────
  const SAVINGS_STORAGE_KEY = 'bostadskalkyl_savings_items';

  let savingsItems = [];

  function loadSavingsItems() {
    try {
      const stored = JSON.parse(localStorage.getItem(SAVINGS_STORAGE_KEY));
      savingsItems = stored && stored.length ? stored : [];
    } catch { savingsItems = []; }
  }

  function saveSavingsItems() {
    localStorage.setItem(SAVINGS_STORAGE_KEY, JSON.stringify(savingsItems));
  }

  function getSavingsTotal() {
    try {
      const stored = JSON.parse(localStorage.getItem(SAVINGS_STORAGE_KEY));
      return (stored || []).reduce((sum, item) => sum + (item.amount || 0), 0);
    } catch { return 0; }
  }

  function openSavingsModal() {
    loadSavingsItems();
    renderSavingsItems();
    document.getElementById('savingsModal').classList.add('open');
  }

  function closeSavingsModal() {
    document.getElementById('savingsModal').classList.remove('open');
  }

  document.getElementById('savingsModal').addEventListener('click', function(e) {
    if (e.target === this) closeSavingsModal();
  });

  function addSavingsItem() {
    savingsItems.push({ id: 'sav_' + Date.now(), label: '', amount: 0 });
    saveSavingsItems();
    renderSavingsItems();
    const inputs = document.querySelectorAll('.savings-label-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function removeSavingsItem(id) {
    savingsItems = savingsItems.filter(s => s.id !== id);
    saveSavingsItems();
    renderSavingsItems();
    updateSavingsTotal();
  }

  function renderSavingsItems() {
    const list = document.getElementById('savingsItemList');
    list.innerHTML = '';
    savingsItems.forEach((item, idx) => {
      const displayVal = item.amount > 0 ? formatWithSpaces(item.amount) : '';
      const row = document.createElement('div');
      row.className = 'drift-item-row';
      row.innerHTML = `
        <input type="text" class="drift-item-label-input savings-label-input" placeholder="e.g. ISK savings"
          value="${item.label}"
          onchange="savingsItems[${idx}].label = this.value; saveSavingsItems();">
        <div class="input-wrap has-suffix">
          <input type="text" inputmode="numeric" value="${displayVal}" placeholder="0"
            data-savings-idx="${idx}"
            onfocus="this.value = parseFormatted(this.value) || ''"
            onblur="this.value = this.value ? formatWithSpaces(parseFormatted(this.value)) : ''; savingsItems[${idx}].amount = parseFormatted(this.value); saveSavingsItems(); updateSavingsTotal();"
            oninput="updateSavingsTotal()">
          <span class="suffix">kr</span>
        </div>
        <button class="drift-delete" onclick="removeSavingsItem('${item.id}')" title="Remove">×</button>
      `;
      list.appendChild(row);
    });
    updateSavingsTotal();
  }

  function updateSavingsTotal() {
    let total = 0;
    document.querySelectorAll('input[data-savings-idx]').forEach(el => {
      total += parseFormatted(el.value) || 0;
    });
    document.getElementById('savingsModalTotal').textContent = fmt(total);
    calc();
  }

  loadSavingsItems();

  // ── Theme ──────────────────────────────────────────────────────
  function initTheme() {
    const stored = localStorage.getItem('bostadskalkyl_theme');
    const theme = stored === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = theme === 'dark' ? '☾' : '☀';
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme;
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('bostadskalkyl_theme', next);
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = next === 'dark' ? '☾' : '☀';
    if (amortChartInstance) renderAmortChart();
  }

  // ── Boot ───────────────────────────────────────────────────────
  initTheme();
  loadDriftItems();
  loadSession();
  if (!localStorage.getItem(SESSION_KEY)) calc();
  updateHeaderLabel();

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const m = require('./mortgagetracker.js');

// ── mortgagetracker-store.js is a browser IIFE (window.App.mortgageStore, no
// module.exports), so we run its source in a vm sandbox that supplies the
// browser globals it touches. Each call gets a fresh in-memory localStorage.
const STORE_SRC = fs.readFileSync(path.join(__dirname, 'mortgagetracker-store.js'), 'utf8');
function freshStore() {
  const mem = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem(k, v) { mem[k] = String(v); },
    removeItem(k) { delete mem[k]; }
  };
  const sandbox = { window: { App: {} }, localStorage };
  vm.runInNewContext(STORE_SRC, sandbox);
  return { store: sandbox.window.App.mortgageStore, localStorage };
}

// ───────────────────────── CSV layer ─────────────────────────

test('detectDelimiter sniffs comma, semicolon and tab', () => {
  assert.equal(m.detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(m.detectDelimiter('Bokföringsdag;Specifikation;Belopp\n2025-03-31;Ränta;-4.323,00'), ';');
  assert.equal(m.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
});

test('parseCsv handles a quoted semicolon file with a trailing newline', () => {
  const text = '"Bokföringsdag";"Specifikation";"Belopp";"Saldo"\r\n"2025-03-31";"Ränta";"-4.323,00";"-1.204.323,00"\r\n';
  const out = m.parseCsv(text);
  assert.equal(out.delimiter, ';');
  assert.deepEqual(out.headers, ['Bokföringsdag', 'Specifikation', 'Belopp', 'Saldo']);
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rows[0], ['2025-03-31', 'Ränta', '-4.323,00', '-1.204.323,00']);
});

test('parseAmount copes with dot thousands and comma decimals (and negatives)', () => {
  assert.equal(m.parseAmount('4.323,00'), 4323);
  assert.equal(m.parseAmount('-1.200.000,00'), -1200000);
  assert.equal(m.parseAmount('-1.204.323,00'), -1204323);
  assert.equal(m.parseAmount('1 234,56'), 1234.56);
  assert.ok(Number.isNaN(m.parseAmount('')));
});

test('autoMapColumns maps the bank ledger header', () => {
  const map = m.autoMapColumns(['Bokföringsdag', 'Specifikation', 'Belopp', 'Saldo', 'Status', 'Avstämt']);
  assert.equal(map.date, 0);
  assert.equal(map.specification, 1);
  assert.equal(map.amount, 2);
  assert.equal(map.balance, 3);
  assert.equal(map.loan_number, null);
});

test('classifyKind reads the Specifikation text', () => {
  assert.equal(m.classifyKind('Ränta'), 'interest');
  assert.equal(m.classifyKind('Betalning'), 'payment');
  assert.equal(m.classifyKind('Amortering'), 'amortization');
  assert.equal(m.classifyKind('Avbetalning'), 'amortization');
  assert.equal(m.classifyKind('Lån'), 'loan');
  assert.equal(m.classifyKind('Aviavgift'), 'fee');
  assert.equal(m.classifyKind('Whatever'), 'other');
});

// ───────────────────────── row builders ─────────────────────────

test('makeLoanPart normalises a draft', () => {
  const p = m.makeLoanPart({ label: 'Del 1', start_balance: 1200000, interest_rate: 3.54 });
  assert.equal(p.start_balance, 1200000);
  assert.equal(p.interest_rate, 3.54);
  assert.equal(p.archived, false);
  assert.equal(m.makeLoanPart({}).interest_rate, null, 'a blank rate stays null');
});

test('makePayment classifies, keeps magnitudes and derives the kind', () => {
  const p = m.makePayment({ date: '2025-03-31', description: 'Ränta', amount: -4323, balance_after: -1204323 });
  assert.equal(p.kind, 'interest');
  assert.equal(p.amount, 4323);
  assert.equal(p.balance_after, 1204323, 'debt stored as a positive magnitude');
  assert.equal(p.source, 'manual');
  const explicit = m.makePayment({ kind: 'payment', amount: 4323 });
  assert.equal(explicit.kind, 'payment');
  assert.equal(explicit.balance_after, null);
});

// ───────────────────────── mortgage math ─────────────────────────

test('partBalance trusts the latest settled Saldo', () => {
  const part = { id: 'p1' };
  const pays = [
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'payment', amount: 4323, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'interest', amount: 4323, balance_after: 1204323 },
    { loan_part_id: 'p1', date: '2025-02-28', kind: 'payment', amount: 3537, balance_after: 1200000 }
  ];
  assert.equal(m.partBalance(part, pays), 1200000, 'interest-charge row does not inflate the balance');
});

test('partBalance falls back to start minus amortization without a Saldo', () => {
  const part = { id: 'p1', start_balance: 100000, start_date: '2025-01-01' };
  const pays = [{ loan_part_id: 'p1', date: '2025-02-01', kind: 'amortization', amount: 2000 }];
  assert.equal(m.partBalance(part, pays), 98000);
});

test('totalInterest sums only the interest-kind rows', () => {
  const pays = [
    { kind: 'interest', amount: 4323 },
    { kind: 'payment', amount: 4323 },
    { kind: 'interest', amount: 3537 },
    { kind: 'loan', amount: 1200000 }
  ];
  assert.equal(m.totalInterest(pays), 7860);
});

test('partAmortized is original principal minus current balance', () => {
  const part = { id: 'p1' };
  const interestOnly = [
    { loan_part_id: 'p1', date: '2024-07-24', kind: 'loan', amount: 1200000, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'payment', amount: 4323, balance_after: 1200000 }
  ];
  assert.equal(m.partOriginal(part, interestOnly), 1200000);
  assert.equal(m.partAmortized(part, interestOnly), 0, 'interest-only loan amortises nothing');
  assert.equal(m.totalAmortized([part], interestOnly), 0);

  const amortising = [
    { loan_part_id: 'p1', date: '2024-07-01', kind: 'loan', amount: 1000000, balance_after: 1000000 },
    { loan_part_id: 'p1', date: '2025-01-01', kind: 'payment', amount: 5000, balance_after: 970000 }
  ];
  assert.equal(m.partAmortized(part, amortising), 30000);
});

test('totalBalance sums active parts only', () => {
  const parts = [
    { id: 'p1', start_balance: 100000 },
    { id: 'p2', start_balance: 50000 },
    { id: 'p3', start_balance: 25000, archived: true }
  ];
  assert.equal(m.totalBalance(parts, []), 150000);
});

test('ranteavdrag applies 30% up to 100k then 21%', () => {
  assert.equal(m.ranteavdrag(80000), 24000);
  assert.equal(m.ranteavdrag(120000), 34200);
  assert.equal(m.ranteavdrag(0), 0);
});

test('equity and loanToValue', () => {
  assert.equal(m.equity(3000000, 1200000), 1800000);
  assert.equal(m.loanToValue(1200000, 3000000), 40);
  assert.equal(m.loanToValue(1200000, 0), 0);
});

test('ownerSplit and ownerPercents divide by ownership and respect who I am', () => {
  assert.deepEqual(m.ownerSplit(1800000, { i_am: 'a', my_ownership_pct: 60 }), { a: 1080000, b: 720000 });
  assert.deepEqual(m.ownerSplit(1800000, { i_am: 'b', my_ownership_pct: 60 }), { b: 1080000, a: 720000 });
  assert.deepEqual(m.ownerPercents({ i_am: 'a', my_ownership_pct: 60 }), { a: 60, b: 40 });
  assert.deepEqual(m.ownerPercents({ i_am: 'b', my_ownership_pct: 60 }), { b: 60, a: 40 });
});

test('myShareEquity clamps out-of-range ownership', () => {
  assert.equal(m.myShareEquity(1000000, 50), 500000);
  assert.equal(m.myShareEquity(1000000, 150), 1000000);
  assert.equal(m.myShareEquity(1000000, -10), 0);
});

test('latestValuation returns the newest on/before asOf', () => {
  const vals = [{ date: '2026-01-01', value: 3000000 }, { date: '2026-04-01', value: 3200000 }];
  assert.equal(m.latestValuation(vals).value, 3200000);
  assert.equal(m.propertyValue(vals, '2026-02-01'), 3000000);
  assert.equal(m.propertyValue([], '2026-02-01'), 0);
});

test('assignPaymentsToPart matches loan numbers, else falls back', () => {
  const parts = [{ id: 'p1', loan_number: '111' }, { id: 'p2', loan_number: '222' }];
  assert.deepEqual(
    m.assignPaymentsToPart(['111', '999'], parts, { auto: true, selectedPartId: 'p2' }),
    [{ loan_part_id: 'p1', matched: true }, { loan_part_id: 'p2', matched: false }]
  );
  assert.deepEqual(
    m.assignPaymentsToPart(['111'], parts, { auto: false, selectedPartId: 'p2' }),
    [{ loan_part_id: 'p2', matched: false }]
  );
});

test('flagDuplicates keys on date, part, kind and amount', () => {
  const existing = [{ date: '2025-03-31', loan_part_id: 'p1', kind: 'interest', amount: 4323 }];
  const incoming = [
    { date: '2025-03-31', loan_part_id: 'p1', kind: 'interest', amount: 4323 }, // re-import → dup
    { date: '2025-03-31', loan_part_id: 'p1', kind: 'payment', amount: 4323 }    // same amount, other kind → not a dup
  ];
  assert.deepEqual(m.flagDuplicates(existing, incoming), [true, false]);
});

// ───────────────────────── timelines ─────────────────────────

test('balanceTimeline carries the settled Saldo forward, gap-filled', () => {
  const parts = [{ id: 'p1' }];
  const pays = [
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'payment', amount: 4061, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'payment', amount: 4323, balance_after: 1200000 }
  ];
  const tl = m.balanceTimeline(parts, pays);
  assert.deepEqual(tl.map((r) => r.month), ['2025-01', '2025-02', '2025-03']);
  assert.deepEqual(tl.map((r) => r.balance), [1200000, 1200000, 1200000], 'February carries January forward');
});

test('equityTimeline splits equity between both owners', () => {
  const parts = [{ id: 'p1' }];
  const pays = [
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'payment', amount: 1, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-02-28', kind: 'payment', amount: 1, balance_after: 1200000 }
  ];
  const vals = [{ date: '2025-01-01', value: 3000000 }];
  const tl = m.equityTimeline(parts, pays, vals, { my_ownership_pct: 60, i_am: 'a' });
  assert.equal(tl[0].equity, 1800000);
  assert.equal(tl[0].a_equity, 1080000);
  assert.equal(tl[0].b_equity, 720000);
  assert.equal(tl[0].bank, 1200000);
});

// ───────────────────────── store ─────────────────────────

test('addLoanPart stamps id + created_at and writes a versioned envelope', async () => {
  const { store, localStorage } = freshStore();
  const saved = await store.addLoanPart(m.makeLoanPart({ label: 'Del 1', start_balance: 1200000 }));
  assert.ok(saved.id && saved.created_at);
  const raw = JSON.parse(localStorage.getItem(store.STORAGE_KEY));
  assert.equal(raw.version, 1);
  assert.equal(raw.loan_parts.length, 1);
});

test('addPayments bulk-inserts and listPayments returns newest date first', async () => {
  const { store } = freshStore();
  await store.addPayments([
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'payment', amount: 1 },
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'payment', amount: 1 }
  ]);
  const rows = await store.listPayments();
  assert.deepEqual(rows.map((r) => r.date), ['2025-03-31', '2025-01-31']);
});

test('updatePayment patches a row and resolves it', async () => {
  const { store } = freshStore();
  const saved = await store.addPayment({ loan_part_id: 'p1', date: '2025-02-01', kind: 'interest', amount: 4061 });
  const updated = await store.updatePayment(saved.id, { amount: 4200 });
  assert.equal(updated.amount, 4200);
  assert.equal(await store.updatePayment('missing', { amount: 1 }), null);
});

test('removePayment and removePayments delete by id', async () => {
  const { store } = freshStore();
  const a = await store.addPayment({ loan_part_id: 'p1', date: '2025-02-01', kind: 'interest', amount: 1 });
  const b = await store.addPayment({ loan_part_id: 'p1', date: '2025-03-01', kind: 'interest', amount: 1 });
  assert.equal(await store.removePayment(a.id), 1);
  assert.equal(await store.removePayments([b.id]), 1);
  assert.deepEqual(await store.listPayments(), []);
});

test('removeLoanPart cascade-deletes its payments', async () => {
  const { store } = freshStore();
  const p = await store.addLoanPart({ label: 'P' });
  await store.addPayment({ loan_part_id: p.id, date: '2025-02-01', kind: 'interest', amount: 4061 });
  await store.addPayment({ loan_part_id: 'other', date: '2025-02-01', kind: 'interest', amount: 1 });
  const remaining = await store.removeLoanPart(p.id);
  assert.equal(remaining, 0);
  const pays = await store.listPayments();
  assert.equal(pays.length, 1);
  assert.equal(pays[0].loan_part_id, 'other');
});

test('valuation CRUD round-trips', async () => {
  const { store } = freshStore();
  const v = await store.addValuation({ date: '2025-01-01', value: 3000000 });
  const upd = await store.updateValuation(v.id, { value: 3200000 });
  assert.equal(upd.value, 3200000);
  assert.equal(await store.removeValuation(v.id), 0);
});

test('settings default and saveSettings patches without clobbering', async () => {
  const { store } = freshStore();
  assert.deepEqual(await store.getSettings(), {
    property_name: '', owner_a_name: 'Alex', owner_b_name: 'Sam',
    my_ownership_pct: 50, i_am: 'a', currency: 'SEK', ranteavdrag: true
  });
  const saved = await store.saveSettings({ owner_a_name: 'Mia', my_ownership_pct: 65 });
  assert.equal(saved.owner_a_name, 'Mia');
  assert.equal(saved.my_ownership_pct, 65);
  assert.equal(saved.currency, 'SEK');
});

test('a corrupt stored value yields an empty store instead of throwing', async () => {
  const { store, localStorage } = freshStore();
  localStorage.setItem(store.STORAGE_KEY, '{ not json');
  assert.deepEqual(await store.listLoanParts(), []);
  assert.deepEqual(await store.listPayments(), []);
  assert.deepEqual(await store.listValuations(), []);
});

test('exportJSON / importJSON round-trip and merge idempotently by id', async () => {
  const { store } = freshStore();
  await store.addLoanPart({ id: 'p1', label: 'P', created_at: '2025-01-01T00:00:00.000Z' });
  await store.addPayment({ id: 'pay1', loan_part_id: 'p1', date: '2025-02-01', kind: 'interest', amount: 4061, created_at: '2025-02-01T00:00:00.000Z' });
  await store.addValuation({ id: 'v1', date: '2025-01-01', value: 3000000, created_at: '2025-01-01T00:00:00.000Z' });
  const dump = await store.exportJSON();

  const fresh = freshStore();
  const added = await fresh.store.importJSON(dump);
  assert.deepEqual(added, { loan_parts: 1, payments: 1, valuations: 1 });
  const again = await fresh.store.importJSON(dump);
  assert.deepEqual(again, { loan_parts: 0, payments: 0, valuations: 0 });

  await assert.rejects(() => fresh.store.importJSON('{ not json'), /valid JSON/);
  await assert.rejects(() => fresh.store.importJSON(JSON.stringify({ nope: true })), /No Bolånekoll data/);
});

// ──────────────── end-to-end: the real bank ledger CSV ────────────────

test('the real Fastighetshypotek ledger imports correctly (interest-only)', async () => {
  const lines = [
    '"Bokföringsdag";"Specifikation";"Belopp";"Saldo";"Status";"Avstämt"',
    '"2025-03-31";"Betalning";"4.323,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2025-03-31";"Ränta";"-4.323,00";"-1.204.323,00";"Utförd";"Nej"',
    '"2025-02-28";"Betalning";"3.537,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2025-02-28";"Ränta";"-3.537,00";"-1.203.537,00";"Utförd";"Nej"',
    '"2025-01-31";"Betalning";"4.061,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2025-01-31";"Ränta";"-4.061,00";"-1.204.061,00";"Utförd";"Nej"',
    '"2024-12-30";"Betalning";"3.668,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2024-12-30";"Ränta";"-3.668,00";"-1.203.668,00";"Utförd";"Nej"',
    '"2024-12-02";"Betalning";"4.061,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2024-12-02";"Ränta";"-4.061,00";"-1.204.061,00";"Utförd";"Nej"',
    '"2024-10-31";"Betalning";"4.061,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2024-10-31";"Ränta";"-4.061,00";"-1.204.061,00";"Utförd";"Nej"',
    '"2024-09-30";"Betalning";"3.668,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2024-09-30";"Ränta";"-3.668,00";"-1.203.668,00";"Utförd";"Nej"',
    '"2024-09-02";"Betalning";"4.978,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2024-09-02";"Ränta";"-4.978,00";"-1.204.978,00";"Utförd";"Nej"',
    '"2024-07-24";"Lån";"-1.200.000,00";"-1.200.000,00";"Utförd";"Nej"'
  ];
  const parsed = m.parseCsv(lines.join('\n') + '\n');
  const map = m.autoMapColumns(parsed.headers);
  assert.equal(parsed.rows.length, 17);

  const { store } = freshStore();
  const part = await store.addLoanPart(m.makeLoanPart({ label: 'FastHypotek' }));
  const drafts = parsed.rows.map((r) => m.makePayment({
    loan_part_id: part.id,
    date: r[map.date],
    description: r[map.specification],
    amount: m.parseAmount(r[map.amount]),
    balance_after: m.parseAmount(r[map.balance]),
    source: 'import:bank.csv'
  }));
  await store.addPayments(drafts);

  const pays = await store.listPayments();
  const parts = await store.listLoanParts();
  assert.equal(pays.length, 17);
  assert.equal(m.totalInterest(pays), 32357, 'sum of the eight Ränta rows');
  assert.equal(m.totalBalance(parts, pays), 1200000, 'interest-only → principal stays at 1.2M');
  assert.equal(m.totalAmortized(parts, pays), 0, 'nothing amortised');
});

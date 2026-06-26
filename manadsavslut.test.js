'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const m = require('./manadsavslut.js');

// ── manadsavslut-store.js is a browser IIFE (window.App.monthEndStore, no
// module.exports), so we run its source in a vm sandbox that supplies the
// browser globals it touches. Each call gets a fresh in-memory localStorage so
// tests don't bleed state. (window.crypto omitted → exercises the _id fallback.)
const STORE_SRC = fs.readFileSync(path.join(__dirname, 'manadsavslut-store.js'), 'utf8');
function freshStore() {
  const mem = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem(k, v) { mem[k] = String(v); },
    removeItem(k) { delete mem[k]; }
  };
  const sandbox = { window: { App: {} }, localStorage };
  vm.runInNewContext(STORE_SRC, sandbox);
  return { store: sandbox.window.App.monthEndStore, localStorage };
}

// ───────────────────────── pure calc ─────────────────────────

test('detectDelimiter sniffs comma, semicolon and tab from the header line', () => {
  assert.equal(m.detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(m.detectDelimiter('Datum;Text;Belopp\n2026-06-01;ICA;-249,90'), ';');
  assert.equal(m.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
});

test('parseCsv handles a semicolon file, BOM and a trailing newline', () => {
  const text = '﻿Datum;Text;Belopp\r\n2026-06-01;ICA Maxi;-249,90\r\n2026-06-02;SL;-39,00\r\n';
  const out = m.parseCsv(text);
  assert.equal(out.delimiter, ';');
  assert.deepEqual(out.headers, ['Datum', 'Text', 'Belopp']);
  assert.equal(out.rows.length, 2, 'trailing newline does not add a blank row');
  assert.deepEqual(out.rows[0], ['2026-06-01', 'ICA Maxi', '-249,90']);
});

test('parseCsv handles quoted fields with embedded comma, quote and newline', () => {
  const text = 'Item,Amount\n"Dinner, drinks",500\n"He said ""hi""",10\n"two\nlines",20';
  const out = m.parseCsv(text);
  assert.equal(out.delimiter, ',');
  assert.deepEqual(out.rows[0], ['Dinner, drinks', '500']);
  assert.deepEqual(out.rows[1], ['He said "hi"', '10']);
  assert.deepEqual(out.rows[2], ['two\nlines', '20']);
});

test('parseAmount copes with Swedish and international money formats', () => {
  assert.equal(m.parseAmount('1 234,56'), 1234.56);   // space thousands, comma decimal
  assert.equal(m.parseAmount('1.234,56'), 1234.56);   // dot thousands, comma decimal
  assert.equal(m.parseAmount('1,234.56'), 1234.56);   // comma thousands, dot decimal
  assert.equal(m.parseAmount('1234.56'), 1234.56);
  assert.equal(m.parseAmount('49,90'), 49.9);
  assert.equal(m.parseAmount('1 234 kr'), 1234);      // currency suffix + NBSP-ish space
  assert.equal(m.parseAmount('-49,90'), -49.9);
  assert.equal(m.parseAmount('−12,00'), -12);         // unicode minus
  assert.equal(m.parseAmount('(50)'), -50);           // accounting parentheses
  assert.ok(Number.isNaN(m.parseAmount('')));
  assert.ok(Number.isNaN(m.parseAmount('   ')));
});

test('autoMapColumns matches Swedish and English headers, null when missing', () => {
  assert.deepEqual(
    m.autoMapColumns(['Bokföringsdatum', 'Text', 'Belopp']),
    { date_purchased: 0, description: 1, enter_amount: 2 }
  );
  assert.deepEqual(
    m.autoMapColumns(['Date', 'Description', 'Amount']),
    { date_purchased: 0, description: 1, enter_amount: 2 }
  );
  const noAmount = m.autoMapColumns(['Datum', 'Beskrivning']);
  assert.equal(noAmount.enter_amount, null);
});

test('computeOwedAmount halves a split and keeps a full charge whole', () => {
  assert.equal(m.computeOwedAmount(500, true), 250);
  assert.equal(m.computeOwedAmount(500, false), 500);
  assert.equal(m.computeOwedAmount(99.99, true), 50);   // rounded to öre
  assert.equal(m.computeOwedAmount(-200, true), -100);  // a refund splits as a credit
  assert.equal(m.computeOwedAmount(-200, false), -200);
});

test('classifyToItemFields maps triage choices; debtor is the non-card owner', () => {
  assert.deepEqual(m.classifyToItemFields('split', 'a'), { split: true, owed_by: 'b' });
  assert.deepEqual(m.classifyToItemFields('full', 'b'), { split: false, owed_by: 'a' });
  assert.equal(m.classifyToItemFields('exclude', 'a'), null);
});

test('makeItem normalises a draft and derives the owed amount', () => {
  const it = m.makeItem({ description: 'Groceries', enter_amount: 400, split: true, fronted_by: 'a' });
  assert.equal(it.amount, 200);
  assert.equal(it.owed_by, 'b');
  assert.equal(it.paid, false);
  assert.equal(it.payment_id, null);
  assert.equal(it.source, 'manual');
});

test('netBalance nets directed debts into one transfer', () => {
  // a fronted 300 split (b owes 150); b fronted 100 split (a owes 50) → b owes a 100
  const items = [
    { amount: 150, fronted_by: 'a', owed_by: 'b' },
    { amount: 50, fronted_by: 'b', owed_by: 'a' }
  ];
  assert.deepEqual(m.netBalance(items), { from: 'b', to: 'a', amount: 100 });
});

test('netBalance returns a null transfer when everything cancels', () => {
  const items = [
    { amount: 100, fronted_by: 'a', owed_by: 'b' },
    { amount: 100, fronted_by: 'b', owed_by: 'a' }
  ];
  assert.deepEqual(m.netBalance(items), { from: null, to: null, amount: 0 });
});

test('netBalance offsets a refund (negative amount) against the charge it credits', () => {
  // b owed a 100; a 40 refund lands on a's card and is split → b owes 40 less
  const items = [
    { amount: 100, fronted_by: 'a', owed_by: 'b' },
    { amount: -40, fronted_by: 'a', owed_by: 'b' }
  ];
  assert.deepEqual(m.netBalance(items), { from: 'b', to: 'a', amount: 60 });
});

test('buildSettlement nets only unpaid items and links their ids', () => {
  const items = [
    { id: 'i1', amount: 150, fronted_by: 'a', owed_by: 'b', paid: false },
    { id: 'i2', amount: 50, fronted_by: 'a', owed_by: 'b', paid: false },
    { id: 'i3', amount: 999, fronted_by: 'b', owed_by: 'a', paid: true } // already settled → ignored
  ];
  const s = m.buildSettlement(items, { period_label: '2026-06' });
  assert.deepEqual(s.item_ids, ['i1', 'i2']);
  assert.equal(s.from_person, 'b');
  assert.equal(s.to_person, 'a');
  assert.equal(s.amount, 200);
  assert.equal(s.period_label, '2026-06');
});

// ──────────────────── "ask later" (pending) triage ────────────────────

test('classifyToItemFields flags an "ask later" row as pending (provisional split)', () => {
  assert.deepEqual(m.classifyToItemFields('pending', 'a'), { split: true, owed_by: 'b', pending: true });
  assert.deepEqual(m.classifyToItemFields('pending', 'b'), { split: true, owed_by: 'a', pending: true });
});

test('makeItem defaults pending to false and carries an explicit pending flag', () => {
  assert.equal(m.makeItem({ enter_amount: 400, fronted_by: 'a' }).pending, false);
  const p = m.makeItem({ enter_amount: 400, split: true, fronted_by: 'a', pending: true });
  assert.equal(p.pending, true);
  assert.equal(p.amount, 200, 'provisional half retained while pending');
});

test('buildSettlement ignores pending items so an undecided charge never settles', () => {
  const items = [
    { id: 'i1', amount: 150, fronted_by: 'a', owed_by: 'b', paid: false },
    { id: 'i2', amount: 100, fronted_by: 'a', owed_by: 'b', paid: false, pending: true }
  ];
  const s = m.buildSettlement(items, {});
  assert.deepEqual(s.item_ids, ['i1'], 'the pending id is not part of the settlement');
  assert.equal(s.amount, 150, 'the pending 100 is not summed');

  const allPending = [{ id: 'p1', amount: 100, fronted_by: 'a', owed_by: 'b', paid: false, pending: true }];
  const empty = m.buildSettlement(allPending, {});
  assert.deepEqual(empty.item_ids, []);
  assert.deepEqual(
    { from: empty.from_person, to: empty.to_person, amount: empty.amount },
    { from: null, to: null, amount: 0 }
  );
});

test('a pending refund keeps a negative provisional amount but stays out of the math', () => {
  const it = m.makeItem({ enter_amount: -200, split: true, fronted_by: 'a', pending: true });
  assert.equal(it.amount, -100);
  assert.equal(it.pending, true);
  const s = m.buildSettlement([Object.assign({ id: 'r1' }, it)], {});
  assert.deepEqual(s.item_ids, []);
  assert.equal(s.amount, 0);
});

// ──────────────────── month helpers & analytics ────────────────────

test('monthKey reads ISO dates (and a couple of fallbacks), else empty', () => {
  assert.equal(m.monthKey('2026-06-02'), '2026-06');
  assert.equal(m.monthKey('2026/06/02'), '2026-06');
  assert.equal(m.monthKey('02.06.2026'), '2026-06');
  assert.equal(m.monthKey(''), '');
  assert.equal(m.monthKey('n/a'), '');
});

test('monthsWithOpenItems lists distinct unpaid months newest-first', () => {
  const items = [
    { date_purchased: '2026-06-01', paid: false },
    { date_purchased: '2026-04-15', paid: false },
    { date_purchased: '2026-06-20', paid: false },
    { date_purchased: '2026-05-01', paid: true } // settled → excluded
  ];
  assert.deepEqual(m.monthsWithOpenItems(items), ['2026-06', '2026-04']);
});

test('itemsForMonth filters by calendar month', () => {
  const items = [
    { id: 'a', date_purchased: '2026-06-01' },
    { id: 'b', date_purchased: '2026-05-30' },
    { id: 'c', date_purchased: '2026-06-29' }
  ];
  assert.deepEqual(m.itemsForMonth(items, '2026-06').map((i) => i.id), ['a', 'c']);
});

test('categorize maps Swedish merchants; groceries wins for ICA MAXI', () => {
  assert.equal(m.categorize('ICA MAXI STORMARKNAD'), 'groceries');
  assert.equal(m.categorize('Coop Nära'), 'groceries');
  assert.equal(m.categorize('WILLYS HEMMA'), 'groceries');
  assert.equal(m.categorize('MAX BURGERS'), 'dining');     // \bmax\b, not "maxi"
  assert.equal(m.categorize('SL ACCESS'), 'transport');
  assert.equal(m.categorize('Spotify AB'), 'subs');
  assert.equal(m.categorize('H&M'), 'shopping');
  assert.equal(m.categorize('Some Random Shop'), 'other');
});

test('spendByCategory sums full charges and sorts biggest-first', () => {
  const items = [
    { description: 'ICA', enter_amount: 800 },
    { description: 'Coop', enter_amount: 200 },
    { description: 'SL', enter_amount: 300 },
    { description: 'Mystery', enter_amount: 0 } // zero ignored
  ];
  const cats = m.spendByCategory(items);
  assert.equal(cats[0].key, 'groceries');
  assert.equal(cats[0].total, 1000);
  assert.equal(cats[0].count, 2);
  assert.equal(cats[1].key, 'transport');
  assert.equal(cats[1].total, 300);
});

test('grocerySpendByMonth groups grocery charges by month, chronological', () => {
  const items = [
    { description: 'ICA', enter_amount: 500, date_purchased: '2026-06-02' },
    { description: 'Willys', enter_amount: 300, date_purchased: '2026-05-20' },
    { description: 'ICA Nära', enter_amount: 100, date_purchased: '2026-06-28' },
    { description: 'SL', enter_amount: 999, date_purchased: '2026-06-01' } // not groceries
  ];
  const byMonth = m.grocerySpendByMonth(items);
  assert.deepEqual(byMonth.map((x) => [x.month, x.total]), [['2026-05', 300], ['2026-06', 600]]);
});

test('monthKey also reads slash D/M/Y dates', () => {
  assert.equal(m.monthKey('14/06/2026'), '2026-06'); // DD/MM/YYYY
  assert.equal(m.monthKey('14.06.2026'), '2026-06'); // DD.MM.YYYY
});

test('monthKey reads single-digit day/month (day-first), pads, rejects bad months', () => {
  assert.equal(m.monthKey('25/5/2026'), '2026-05');  // D/M/YYYY, single-digit month
  assert.equal(m.monthKey('5/5/2026'), '2026-05');   // single-digit day AND month
  assert.equal(m.monthKey('2026/6/2'), '2026-06');   // year-first, single-digit month
  assert.equal(m.monthKey('2026-6-2'), '2026-06');   // ISO-ish, single-digit month
  assert.equal(m.monthKey('5/25/2026'), '');         // month 25 impossible → no date, not '2026-25'
});

test('fillMonthGaps inserts zero months between first and last, drops undated', () => {
  const rows = [
    { month: '2026-03', label: 'Mars 2026', total: 300, count: 1 },
    { month: '2026-06', label: 'Juni 2026', total: 600, count: 2 }
  ];
  assert.deepEqual(m.fillMonthGaps(rows).map((r) => [r.month, r.total]), [
    ['2026-03', 300], ['2026-04', 0], ['2026-05', 0], ['2026-06', 600]
  ]);
  assert.equal(m.fillMonthGaps([{ month: '2026-06', total: 1 }]).length, 1); // <2 dated → unchanged
  assert.deepEqual(m.fillMonthGaps([{ month: '', total: 5 }]), []);            // undated dropped
});

// ─────────────────── import: sign & duplicate spotting ───────────────────

test('inferSpendSign reads the majority sign as "money spent"', () => {
  assert.equal(m.inferSpendSign([249, 39, 1200]), 1);            // purchases positive
  assert.equal(m.inferSpendSign([-249, -39, -1200, 500]), -1);  // bank exports spend as negative
  assert.equal(m.inferSpendSign([100, -100]), 1);               // tie → positive
  assert.equal(m.inferSpendSign([]), 1);
});

test('itemFingerprint ignores case/spacing but keeps sign and card', () => {
  const a = m.itemFingerprint({ date_purchased: '2026-06-01', description: 'ICA  Maxi', enter_amount: 249.9, fronted_by: 'a' });
  const b = m.itemFingerprint({ date_purchased: '2026-06-01', description: 'ica maxi', enter_amount: 249.9, fronted_by: 'a' });
  assert.equal(a, b, 'normalised desc → same key');
  const refund = m.itemFingerprint({ date_purchased: '2026-06-01', description: 'ica maxi', enter_amount: -249.9, fronted_by: 'a' });
  assert.notEqual(a, refund, 'a charge and a same-size refund are NOT duplicates of each other');
  const otherCard = m.itemFingerprint({ date_purchased: '2026-06-01', description: 'ica maxi', enter_amount: 249.9, fronted_by: 'b' });
  assert.notEqual(a, otherCard);
});

test('flagDuplicates is multiplicity-aware: only the N+1th identical row flags', () => {
  const existing = [{ date_purchased: '2026-06-01', description: 'ICA', enter_amount: 100, fronted_by: 'a' }];
  const incoming = [
    { date_purchased: '2026-06-01', description: 'ICA', enter_amount: 100, fronted_by: 'a' }, // matches stored
    { date_purchased: '2026-06-01', description: 'ICA', enter_amount: 100, fronted_by: 'a' }  // genuinely new
  ];
  assert.deepEqual(m.flagDuplicates(existing, incoming), [true, false]);
  assert.deepEqual(m.flagDuplicates([], incoming), [false, false], 'nothing stored → nothing flagged');
  assert.deepEqual(m.flagDuplicates(existing, [null]), [false], 'refund/no-amount rows never flag');
});

// ───────────────────────── store ─────────────────────────

test('addItem stamps id + created_at and writes a versioned envelope', async () => {
  const { store, localStorage } = freshStore();
  const saved = await store.addItem(m.makeItem({ description: 'X', enter_amount: 100, fronted_by: 'a' }));
  assert.ok(saved.id && saved.created_at);
  const raw = JSON.parse(localStorage.getItem(store.STORAGE_KEY));
  assert.equal(raw.version, 1);
  assert.equal(raw.items.length, 1);
  assert.equal(raw.items[0].description, 'X');
});

test('addItems bulk-inserts (CSV import) and listItems returns newest-first', async () => {
  const { store } = freshStore();
  await store.addItems([
    { description: 'old', created_at: '2026-06-01T00:00:00.000Z' },
    { description: 'new', created_at: '2026-06-09T00:00:00.000Z' }
  ]);
  const rows = await store.listItems();
  assert.deepEqual(rows.map((r) => r.description), ['new', 'old']);
});

test('updateItem patches a row (e.g. mark paid) and resolves it', async () => {
  const { store } = freshStore();
  const saved = await store.addItem({ description: 'Y', paid: false });
  const updated = await store.updateItem(saved.id, { paid: true, note: 'done' });
  assert.equal(updated.paid, true);
  assert.equal(updated.note, 'done');
  assert.equal(await store.updateItem('missing', { paid: true }), null);
});

test('removeItem deletes by id and resolves the remaining count', async () => {
  const { store } = freshStore();
  const a = await store.addItem({ description: 'a' });
  await store.addItem({ description: 'b' });
  assert.equal(await store.removeItem(a.id), 1);
});

test('removeItems bulk-deletes by id (e.g. all open) and resolves how many went', async () => {
  const { store } = freshStore();
  const o1 = await store.addItem({ description: 'open1', paid: false });
  const o2 = await store.addItem({ description: 'open2', paid: false });
  const settled = await store.addItem({ description: 'settled', paid: true });
  const removed = await store.removeItems([o1.id, o2.id]);
  assert.equal(removed, 2);
  const rows = await store.listItems();
  assert.deepEqual(rows.map((r) => r.description), ['settled'], 'only the settled item remains');
  assert.equal(await store.removeItems([]), 0, 'empty id list removes nothing');
});

test('settle saves a payment and flips its linked items to paid', async () => {
  const { store } = freshStore();
  const i1 = await store.addItem(m.makeItem({ enter_amount: 300, split: true, fronted_by: 'a' })); // b owes 150
  const i2 = await store.addItem(m.makeItem({ enter_amount: 100, split: false, fronted_by: 'a' })); // b owes 100
  const draft = m.buildSettlement([i1, i2], { period_label: '2026-06' });
  const payment = await store.settle(draft);
  assert.equal(payment.amount, 250);
  assert.equal(payment.from_person, 'b');
  const items = await store.listItems();
  assert.ok(items.every((it) => it.paid && it.payment_id === payment.id), 'both items closed under the payment');
  const pays = await store.listPayments();
  assert.equal(pays.length, 1);
});

test('resolving a pending item via updateItem clears the flag and recomputes the amount', async () => {
  const { store } = freshStore();
  const saved = await store.addItem(m.makeItem({ enter_amount: 400, fronted_by: 'a', pending: true }));
  assert.equal(saved.pending, true);
  assert.equal(saved.amount, 200, 'provisional split-half while pending');
  const resolved = await store.updateItem(saved.id, {
    split: false, amount: m.computeOwedAmount(400, false), pending: false
  });
  assert.equal(resolved.pending, false);
  assert.equal(resolved.amount, 400, 'resolving to "owes all" recomputes the owed amount');
});

test('settling leaves a pending item untouched and out of the transfer', async () => {
  const { store } = freshStore();
  const decided = await store.addItem(m.makeItem({ enter_amount: 300, split: false, fronted_by: 'a' })); // b owes 300
  const pending = await store.addItem(m.makeItem({ enter_amount: 100, fronted_by: 'a', pending: true }));
  const draft = m.buildSettlement([decided, pending], { period_label: '2026-06' });
  const payment = await store.settle(draft);
  assert.equal(payment.amount, 300, 'pending 100 (provisional 50) excluded from the transfer');
  const items = await store.listItems();
  const stillPending = items.filter(function (it) { return it.id === pending.id; })[0];
  assert.equal(stillPending.paid, false, 'pending item stays open');
  assert.equal(stillPending.pending, true, 'and stays pending after the settlement');
});

test('removePayment deletes the settlement and reopens its items', async () => {
  const { store } = freshStore();
  const i1 = await store.addItem(m.makeItem({ enter_amount: 200, split: true, fronted_by: 'a' }));
  const payment = await store.settle(m.buildSettlement([i1]));
  const remaining = await store.removePayment(payment.id);
  assert.equal(remaining, 0);
  const items = await store.listItems();
  assert.equal(items[0].paid, false);
  assert.equal(items[0].payment_id, null);
});

test('settings round-trip and default to the dummy names', async () => {
  const { store } = freshStore();
  assert.deepEqual(await store.getSettings(), { person_a_name: 'Alex', person_b_name: 'Sam', currency: 'SEK', default_split: true });
  const saved = await store.saveSettings({ person_a_name: 'Mia', person_b_name: 'Hugo' });
  assert.equal(saved.person_a_name, 'Mia');
  assert.equal(saved.person_b_name, 'Hugo');
  assert.equal(saved.currency, 'SEK', 'untouched fields keep their value');
});

test('saveSettings persists a chosen currency', async () => {
  const { store } = freshStore();
  const saved = await store.saveSettings({ currency: 'EUR' });
  assert.equal(saved.currency, 'EUR');
  assert.equal(saved.person_a_name, 'Alex', 'unset fields keep defaults');
});

test('a corrupt stored value yields an empty store instead of throwing', async () => {
  const { store, localStorage } = freshStore();
  localStorage.setItem(store.STORAGE_KEY, '{ not json');
  assert.deepEqual(await store.listItems(), []);
  assert.deepEqual(await store.listPayments(), []);
});

test('exportJSON / importJSON round-trip and merge idempotently by id', async () => {
  const { store } = freshStore();
  await store.addItem({ id: 'i1', description: 'kept', created_at: '2026-06-01T00:00:00.000Z' });
  await store.settle({ id: 'p1', item_ids: ['i1'], amount: 100, from_person: 'b', to_person: 'a', created_at: '2026-06-30T00:00:00.000Z' });
  const dump = await store.exportJSON();

  const fresh = freshStore();
  const added = await fresh.store.importJSON(dump);
  assert.deepEqual(added, { items: 1, payments: 1 });
  const again = await fresh.store.importJSON(dump);
  assert.deepEqual(again, { items: 0, payments: 0 }, 're-importing the same backup adds nothing');

  await assert.rejects(() => fresh.store.importJSON('{ not json'), /valid JSON/);
  await assert.rejects(() => fresh.store.importJSON(JSON.stringify({ nope: true })), /No Månadsavslut data/);
});

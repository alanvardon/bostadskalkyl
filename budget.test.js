'use strict';
const test = require('node:test');
const assert = require('node:assert');
const budget = require('./budget.js');

function st(over) {
  return Object.assign({ incomes: [], costs: [], savings: [] }, over);
}

test('defaultState is internally consistent', () => {
  const s = budget.defaultState();
  assert.equal(s.version, 1);
  assert.equal(s.people.length, 2);
  assert.ok(s.incomes.length > 0 && s.costs.length > 0 && s.savings.length > 0);
  // every cost row carries a category that exists in CATEGORIES
  const keys = new Set(budget.CATEGORIES.map(c => c.key));
  for (const row of s.costs) assert.ok(keys.has(row.category), 'unknown category ' + row.category);
});

test('pools all income and splits it equally', () => {
  const r = budget.computeBudget(st({
    incomes: [
      { amount: 36000, owner: 'a' },
      { amount: 30000, owner: 'b' },
      { amount: 2650, owner: 'joint' }
    ]
  }));
  assert.equal(r.totalIncome, 68650);
  assert.equal(r.equalShare, 34325);
  // higher earner contributes to the pot (negative), lower earner receives
  assert.equal(r.personA.potNet, 34325 - 36000); // -1675
  assert.equal(r.personB.potNet, 34325 - 30000); // +4325
  // the two net transfers always cancel the joint income between them
  assert.equal(r.personA.potNet + r.personB.potNet, 2650);
});

test('settle-up transfer evens the salaries; higher earner pays the lower', () => {
  const r = budget.computeBudget(st({
    incomes: [
      { amount: 46000, owner: 'a' },
      { amount: 39000, owner: 'b' },
      { amount: 2650, owner: 'joint' }
    ]
  }));
  // half the salary gap, higher earner -> lower earner
  assert.equal(r.transfer.amount, (46000 - 39000) / 2); // 3500
  assert.equal(r.transfer.from, 'a');
  assert.equal(r.transfer.to, 'b');
  // transfer + each getting half the joint income lands both on equalShare
  assert.equal(46000 - r.transfer.amount + r.incomeJoint / 2, r.equalShare);
  assert.equal(39000 + r.transfer.amount + r.incomeJoint / 2, r.equalShare);
});

test('lower earner b pays direction flips; equal incomes => no transfer', () => {
  const flipped = budget.computeBudget(st({
    incomes: [{ amount: 30000, owner: 'a' }, { amount: 40000, owner: 'b' }]
  }));
  assert.equal(flipped.transfer.from, 'b');
  assert.equal(flipped.transfer.to, 'a');
  assert.equal(flipped.transfer.amount, 5000);

  const even = budget.computeBudget(st({
    incomes: [{ amount: 35000, owner: 'a' }, { amount: 35000, owner: 'b' }]
  }));
  assert.equal(even.transfer.amount, 0);
});

test('joint costs split 50/50, individual costs hit only their owner', () => {
  const r = budget.computeBudget(st({
    incomes: [{ amount: 40000, owner: 'a' }, { amount: 40000, owner: 'b' }],
    costs: [
      { amount: 20000, owner: 'joint', category: 'boende' },
      { amount: 500, owner: 'a', category: 'abonnemang' },
      { amount: 300, owner: 'b', category: 'abonnemang' }
    ]
  }));
  assert.equal(r.costsJoint, 20000);
  assert.equal(r.costsA, 500);
  assert.equal(r.costsB, 300);
  assert.equal(r.totalCosts, 20800);
  // each pays half the joint pot plus their own
  assert.equal(r.personA.jointCostShare, 10000);
  assert.equal(r.personB.jointCostShare, 10000);
  assert.equal(r.personA.leftover, 40000 - 10000 - 500); // 29500, no savings
  assert.equal(r.personB.leftover, 40000 - 10000 - 300); // 29700
});

test('leftover accounts for joint + own savings', () => {
  const r = budget.computeBudget(st({
    incomes: [{ amount: 30000, owner: 'a' }, { amount: 30000, owner: 'b' }],
    costs: [{ amount: 10000, owner: 'joint', category: 'mat' }],
    savings: [
      { amount: 4000, owner: 'joint' },
      { amount: 1000, owner: 'a' }
    ]
  }));
  assert.equal(r.equalShare, 30000);
  assert.equal(r.totalSavings, 5000);
  // A: 30000 − 5000 joint cost − 2000 joint savings − 1000 own savings = 22000
  assert.equal(r.personA.leftover, 22000);
  // B: 30000 − 5000 − 2000 − 0 = 23000
  assert.equal(r.personB.leftover, 23000);
});

test('byCategory groups costs and surplus is income − costs − savings', () => {
  const r = budget.computeBudget(st({
    incomes: [{ amount: 50000, owner: 'a' }, { amount: 50000, owner: 'b' }],
    costs: [
      { amount: 8000, owner: 'joint', category: 'boende' },
      { amount: 2000, owner: 'joint', category: 'boende' },
      { amount: 5000, owner: 'joint', category: 'mat' }
    ],
    savings: [{ amount: 10000, owner: 'joint' }]
  }));
  assert.equal(r.byCategory.boende, 10000);
  assert.equal(r.byCategory.mat, 5000);
  assert.equal(r.surplus, 100000 - 15000 - 10000); // 75000
  assert.equal(r.savingsRate, 10000 / 100000); // 0.1
});

test('empty state yields all zeros and no divide-by-zero', () => {
  const r = budget.computeBudget(st());
  assert.equal(r.totalIncome, 0);
  assert.equal(r.equalShare, 0);
  assert.equal(r.surplus, 0);
  assert.equal(r.savingsRate, 0);
  assert.deepEqual(r.byCategory, {});
});

test('handles missing arrays and rows without amounts', () => {
  const r = budget.computeBudget({});
  assert.equal(r.totalIncome, 0);
  const r2 = budget.computeBudget(st({
    incomes: [{ owner: 'a' }, { amount: 1000, owner: 'b' }]
  }));
  assert.equal(r2.totalIncome, 1000);
});

import { describe, it, expect } from 'vitest'
import { classifyToItemFields, makeItem, buildSettlement } from './manadsavslut'
import type { Item } from './manadsavslut'

// A full Item with overridable fields, so settlement tests stay type-safe.
const item = (over: Partial<Item>): Item => ({
  id: 'x', created_at: '', date_purchased: '', description: '', enter_amount: 0,
  split: true, amount: 0, fronted_by: 'a', owed_by: 'b', paid: false, pending: false,
  payment_id: null, note: '', source: 'manual', ...over,
})

// ── "ask later" (pending) triage — mirrors the vanilla manadsavslut.test.js ──
describe('pending ("ask later") triage', () => {
  it('classifyToItemFields flags a pending row with a provisional split', () => {
    expect(classifyToItemFields('pending', 'a')).toEqual({ split: true, owed_by: 'b', pending: true })
    expect(classifyToItemFields('pending', 'b')).toEqual({ split: true, owed_by: 'a', pending: true })
  })

  it('makeItem defaults pending to false and carries an explicit flag', () => {
    expect(makeItem({ enter_amount: 400, fronted_by: 'a' }).pending).toBe(false)
    const p = makeItem({ enter_amount: 400, split: true, fronted_by: 'a', pending: true })
    expect(p.pending).toBe(true)
    expect(p.amount).toBe(200) // provisional half retained while pending
  })

  it('buildSettlement ignores pending items so an undecided charge never settles', () => {
    const s = buildSettlement([
      item({ id: 'i1', amount: 150 }),
      item({ id: 'i2', amount: 100, pending: true }),
    ], {})
    expect(s.item_ids).toEqual(['i1'])
    expect(s.amount).toBe(150)

    const empty = buildSettlement([item({ id: 'p1', amount: 100, pending: true })], {})
    expect(empty.item_ids).toEqual([])
    expect({ from: empty.from_person, to: empty.to_person, amount: empty.amount })
      .toEqual({ from: null, to: null, amount: 0 })
  })

  it('a pending refund keeps a negative provisional amount but stays out of the math', () => {
    const refund = makeItem({ enter_amount: -200, split: true, fronted_by: 'a', pending: true })
    expect(refund.amount).toBe(-100)
    expect(refund.pending).toBe(true)
    const s = buildSettlement([item({ id: 'r1', amount: -100, pending: true })], {})
    expect(s.item_ids).toEqual([])
    expect(s.amount).toBe(0)
  })
})

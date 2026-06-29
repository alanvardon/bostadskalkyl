import { describe, it, expect } from 'vitest'
import { makePayment } from './mortgage'
import type { Payment } from './mortgage'

const source: Payment = {
  id: 'pay-src', created_at: '2026-06-01T00:00:00Z',
  loan_part_id: 'part-1', date: '2026-06-01', kind: 'interest',
  description: 'Ränta', amount: 5000, balance_after: 890000,
  paid_by: 'joint', source: 'manual',
}

function copyPaymentToParts(src: Payment, targetIds: string[]) {
  return targetIds.map(partId => makePayment({ ...src, loan_part_id: partId, balance_after: null }))
}

describe('copy-to-parts batch record construction', () => {
  it('produces one record per target part', () => {
    const records = copyPaymentToParts(source, ['part-2', 'part-3', 'part-4'])
    expect(records).toHaveLength(3)
  })

  it('clears balance_after on every copy', () => {
    const records = copyPaymentToParts(source, ['part-2', 'part-3'])
    records.forEach(r => expect(r.balance_after).toBeNull())
  })

  it('assigns the correct loan_part_id to each copy', () => {
    const targets = ['part-2', 'part-3', 'part-4']
    const records = copyPaymentToParts(source, targets)
    expect(records.map(r => r.loan_part_id)).toEqual(targets)
  })

  it('copies date, amount, kind and description from the source', () => {
    const records = copyPaymentToParts(source, ['part-2', 'part-3'])
    records.forEach(r => {
      expect(r.date).toBe(source.date)
      expect(r.amount).toBe(source.amount)
      expect(r.kind).toBe(source.kind)
      expect(r.description).toBe(source.description)
    })
  })

  it('produces zero records when no parts are checked', () => {
    expect(copyPaymentToParts(source, [])).toHaveLength(0)
  })
})

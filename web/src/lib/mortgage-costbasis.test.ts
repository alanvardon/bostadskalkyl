import { describe, it, expect } from 'vitest'
import {
  purchaseValuation, purchasePrice, costBasisEquity, costBasisOwnedPct,
  derivedDeposit, costBasisSplit, insatsPayments, totalAmortized, defaultSettings,
  contributionSplit, makePayment,
} from './mortgage'
import type { LoanPart, Payment, Valuation, Contribution } from './mortgage'

// ── Fixtures ────────────────────────────────────────────────────────────────
// Bought for 5,000,000 with a 1,000,000 deposit → 4,000,000 original loan.
// Amortised 500,000 (balance now 3,500,000). Market value has risen to 7,300,000.

const part: LoanPart = {
  id: 'part-1', created_at: '2021-09-01T00:00:00Z', label: 'Lånedel 1',
  loan_number: '', start_balance: 4_000_000, start_date: '2021-09-01', archived: false,
}

const payments: Payment[] = [
  { id: 'p-a', created_at: '', loan_part_id: 'part-1', date: '2023-06-01', kind: 'amortization',
    description: '', amount: 300_000, balance_after: null, paid_by: 'a', source: 'manual', is_insats: true },
  { id: 'p-b', created_at: '', loan_part_id: 'part-1', date: '2024-01-01', kind: 'amortization',
    description: '', amount: 200_000, balance_after: 3_500_000, paid_by: 'b', source: 'manual' },
]

const valuations: Valuation[] = [
  { id: 'v-buy', created_at: '', date: '2021-09-01', value: 5_000_000, note: 'Köp', is_purchase: true },
  { id: 'v-now', created_at: '', date: '2025-01-01', value: 7_300_000, note: 'Booli' },
]

const contributions: Contribution[] = [
  { id: 'c-a', created_at: '', owner: 'a', date: '2021-09-01', amount: 600_000, note: 'Down payment' },
  { id: 'c-b', created_at: '', owner: 'b', date: '2021-09-01', amount: 400_000, note: 'Down payment' },
]

const settings = { ...defaultSettings(), i_am: 'a' as const, my_ownership_pct: 50, track_contributions: true }
const balance = 3_500_000 // partBalance driven by the latest Saldo row above

// ── purchase-price flag selection ───────────────────────────────────────────

describe('purchaseValuation / purchasePrice', () => {
  it('picks the valuation flagged is_purchase, not the latest', () => {
    expect(purchaseValuation(valuations)?.id).toBe('v-buy')
    expect(purchasePrice(valuations)).toBe(5_000_000)
  })
  it('returns null / 0 when no valuation is flagged', () => {
    const unflagged = valuations.map(v => ({ ...v, is_purchase: false }))
    expect(purchaseValuation(unflagged)).toBeNull()
    expect(purchasePrice(unflagged)).toBe(0)
  })
})

// ── cost-basis equity ───────────────────────────────────────────────────────

describe('costBasisEquity / costBasisOwnedPct', () => {
  it('is purchase price minus current debt', () => {
    expect(costBasisEquity(5_000_000, balance)).toBe(1_500_000)
  })
  it('equals derived deposit + total amortised (the invariant)', () => {
    const deposit = derivedDeposit(5_000_000, [part], payments)
    const amort = totalAmortized([part], payments)
    expect(deposit).toBe(1_000_000)
    expect(amort).toBe(500_000)
    expect(costBasisEquity(5_000_000, balance)).toBe(deposit + amort)
  })
  it('expresses ownership as a share of the purchase price', () => {
    expect(costBasisOwnedPct(5_000_000, balance)).toBe(30) // 1.5M / 5M
  })
  it('is 0 when no purchase price is set', () => {
    expect(costBasisEquity(0, balance)).toBe(0)
    expect(costBasisOwnedPct(0, balance)).toBe(0)
  })
})

// ── derived deposit ─────────────────────────────────────────────────────────

describe('derivedDeposit', () => {
  it('is purchase price minus the original loans', () => {
    expect(derivedDeposit(5_000_000, [part], payments)).toBe(1_000_000)
  })
})

// ── per-owner funded split ──────────────────────────────────────────────────

describe('costBasisSplit', () => {
  it('splits cost-basis equity by funded percentages (deposit + amortering by owner)', () => {
    // a: 600k deposit + 300k amort = 900k (60%); b: 400k + 200k = 600k (40%)
    const split = costBasisSplit(5_000_000, balance, payments, contributions, settings)
    expect(split.a_pct).toBe(60)
    expect(split.b_pct).toBe(40)
    expect(split.a).toBe(900_000)
    expect(split.b).toBe(600_000)
  })
  it('halves always sum to the cost-basis total', () => {
    const split = costBasisSplit(5_000_000, balance, payments, contributions, settings)
    expect(split.a + split.b).toBe(costBasisEquity(5_000_000, balance))
  })
})

// ── flagged extra payments ──────────────────────────────────────────────────

describe('insatsPayments', () => {
  it('returns only payments flagged is_insats', () => {
    const flagged = insatsPayments(payments)
    expect(flagged.map(p => p.id)).toEqual(['p-a'])
  })
})

// ── per-payment co-funding split ────────────────────────────────────────────

describe('contributionSplit honours a per-payment paid_split', () => {
  const base = { id: 'x', created_at: '', loan_part_id: 'part-1', date: '2024-01-01', kind: 'amortization' as const, description: '', balance_after: null, source: 'manual' }

  it('allocates one co-funded payment across both owners', () => {
    const pays: Payment[] = [{ ...base, amount: 200_000, paid_by: 'joint', paid_split: { a: 120_000, b: 80_000 } }]
    const cs = contributionSplit(pays, [], settings)
    expect(cs.a).toBe(120_000)
    expect(cs.b).toBe(80_000)
  })

  it('falls back to paid_by when there is no split', () => {
    const pays: Payment[] = [{ ...base, amount: 200_000, paid_by: 'a' }]
    const cs = contributionSplit(pays, [], settings)
    expect(cs.a).toBe(200_000)
    expect(cs.b).toBe(0)
  })

  it('makePayment normalises a provided paid_split', () => {
    const p = makePayment({ amount: 200_000, kind: 'amortization', paid_split: { a: 120_000, b: 80_000 } })
    expect(p.paid_split).toEqual({ a: 120_000, b: 80_000 })
    const plain = makePayment({ amount: 5_000, kind: 'interest' })
    expect(plain.paid_split).toBeNull()
  })
})

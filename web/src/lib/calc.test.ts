import { describe, it, expect } from 'vitest'
import {
  lagfart,
  pantbrevCost,
  ranteavdrag,
  fastighetsavgiftCap,
  equityPct,
  derive,
  DEFAULT_INPUTS,
} from './calc'

// ── Ported from the vanilla calc.test.js ────────────────────────────
describe('pure functions', () => {
  it('lagfart: 2 000 000 kr property', () => expect(lagfart(2_000_000)).toBe(30_000))
  it('lagfart: zero property price', () => expect(lagfart(0)).toBe(0))
  it('pantbrevCost: loan exceeds existing pantbrev', () =>
    expect(pantbrevCost(1_500_000, 1_000_000)).toBe(10_000))
  it('pantbrevCost: loan within existing pantbrev', () =>
    expect(pantbrevCost(800_000, 1_000_000)).toBe(0))
  it('ranteavdrag: below threshold (80 000)', () => expect(ranteavdrag(80_000)).toBe(24_000))
  it('ranteavdrag: at threshold (100 000)', () => expect(ranteavdrag(100_000)).toBe(30_000))
  it('ranteavdrag: above threshold (150 000)', () => expect(ranteavdrag(150_000)).toBe(40_500))
  it('equityPct: standard case', () => expect(equityPct(1_500_000, 2_000_000)).toBe(75))
  it('equityPct: zero price returns 0', () => expect(equityPct(0, 0)).toBe(0))
  it('fastighetsavgiftCap: above cap (9 725)', () => expect(fastighetsavgiftCap(12_000)).toBe(9_725))
  it('fastighetsavgiftCap: below cap', () => expect(fastighetsavgiftCap(6_000)).toBe(6_000))
})

// ── derive() — replaces the old summarize() tests ───────────────────
describe('derive', () => {
  it('standard scenario core figures', () => {
    const f = derive(DEFAULT_INPUTS)
    expect(f.loanAmount).toBe(5_850_000)
    expect(f.totalTakeaway).toBe(2_500_000)
    expect(f.netProceeds).toBe(2_360_000)
    expect(f.totalUpfront).toBe(650_000 + 97_500 + 77_000)
    expect(f.cashBalance).toBe(2_360_000 - 824_500)
    const expectedMonthly =
      (5_850_000 * 0.035) / 12 + (5_850_000 * 0.02) / 12 + 9_725 / 12 + 3_000
    expect(f.bankA.total).toBeCloseTo(expectedMonthly, 6)
  })

  it('all-zero money inputs yield zeros', () => {
    const f = derive({
      ...DEFAULT_INPUTS,
      salePrice: 0,
      currentMortgage: 0,
      agentCost: 0,
      movingCost: 0,
      newPrice: 0,
      deposit: 0,
      existingPantbrev: 0,
      propertyTax: 0,
      driftkostnad: 0,
      interestRateA: 0,
      interestRateB: 0,
    })
    expect(f.loanAmount).toBe(0)
    expect(f.totalMonthly).toBe(0)
    expect(f.cashBalance).toBe(0)
  })

  it('ränteavdrag toggle only changes the affordability figure', () => {
    const off = derive({ ...DEFAULT_INPUTS, ranteavdrag: false })
    const on = derive({ ...DEFAULT_INPUTS, ranteavdrag: true })
    expect(on.totalMonthly).toBe(off.totalMonthly) // monthly cost unchanged
    expect(on.reqSalaryMonthly).toBeLessThan(off.reqSalaryMonthly) // relief lowers it
  })
})

// ── GOLDEN regression ───────────────────────────────────────────────
// Exact figures shown for the default inputs, captured from the live vanilla
// app on 2026-06-23. If derive() ever drifts from the legacy recalc() math,
// these fail — the numerical half of the "pixel-match today" guarantee.
describe('golden figures — default inputs match the live vanilla app', () => {
  const f = derive(DEFAULT_INPUTS)
  const r = (n: number) => Math.round(n)

  it('net from sale 2 360 000', () => expect(r(f.netProceeds)).toBe(2_360_000))
  it('loan amount 5 850 000', () => expect(r(f.loanAmount)).toBe(5_850_000))
  it('lagfart 97 500', () => expect(r(f.lagfart)).toBe(97_500))
  it('new pantbrev cost 77 000', () => expect(r(f.pantbrevCost)).toBe(77_000))
  it('total upfront 824 500', () => expect(r(f.totalUpfront)).toBe(824_500))
  it('cash surplus +1 535 500', () => expect(r(f.cashBalance)).toBe(1_535_500))
  it('bank A monthly 30 623', () => expect(r(f.bankA.total)).toBe(30_623))
  it('bank B monthly 32 573', () => expect(r(f.bankB.total)).toBe(32_573))
  it('bank A cheaper by 1 950/mo', () => expect(r(Math.abs(f.bankDiff))).toBe(1_950))
  it('ränteavdrag 4 333/mo', () => expect(r(f.relief / 12)).toBe(4_333))
  it('back from Skatteverket 51 998/yr', () => expect(r(f.relief)).toBe(51_998))
  it('effective monthly 26 290', () => expect(r(f.effectiveMonthly)).toBe(26_290))
  it('required gross salary 102 076/mo', () => expect(r(f.reqSalaryMonthly)).toBe(102_076))
  it('equity at 5y 1 235 000', () => expect(r(f.equity.y5)).toBe(1_235_000))
  it('equity at 10y 1 820 000', () => expect(r(f.equity.y10)).toBe(1_820_000))
  it('equity at 20y 2 990 000', () => expect(r(f.equity.y20)).toBe(2_990_000))
})

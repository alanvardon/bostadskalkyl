// Pure house-purchase math — ported from the vanilla calc.js + the recalc()
// body in app.js, now typed. `derive(inputs)` is the single source of truth:
// it returns every figure the UI renders, so React components stay dumb.

export const FASTIGHETSAVGIFT_CAP = 9725 // småhus cap, income year 2025
const RANTEAVDRAG_THRESHOLD = 100_000

// ── Standalone pure functions (also used by charts / previews) ──────
export function lagfart(price: number): number {
  return price * 0.015
}

export function pantbrevCost(loan: number, existingPantbrev: number): number {
  return Math.max(0, loan - existingPantbrev) * 0.02
}

export function ranteavdrag(annualInterest: number): number {
  if (annualInterest <= RANTEAVDRAG_THRESHOLD) return annualInterest * 0.3
  return RANTEAVDRAG_THRESHOLD * 0.3 + (annualInterest - RANTEAVDRAG_THRESHOLD) * 0.21
}

export function fastighetsavgiftCap(propertyTax: number): number {
  return Math.min(propertyTax, FASTIGHETSAVGIFT_CAP)
}

export function equityPct(loanAmount: number, price: number): number {
  if (price === 0) return 0
  return (loanAmount / price) * 100
}

export interface AmortPoint {
  year: number
  balance: number
}
export interface LumpPayment {
  year: number
  amount: number
}

export function buildAmortSchedule(
  startBalance: number,
  annualAmortRate: number,
  lumpPayments: LumpPayment[] = [],
  termCap = 200,
): AmortPoint[] {
  const yearlyAmort = startBalance * (annualAmortRate / 100)
  let balance = startBalance
  const points: AmortPoint[] = [{ year: 0, balance }]
  let year = 0
  while (balance > 0 && year < termCap) {
    year++
    const lump = lumpPayments
      .filter((p) => p.year === year)
      .reduce((s, p) => s + p.amount, 0)
    balance = Math.max(0, balance - yearlyAmort - lump)
    points.push({ year, balance })
    if (balance === 0) break
  }
  return points
}

// ── The input model + derived figures ──────────────────────────────
export interface Inputs {
  // Section 1 — selling the current property
  salePrice: number
  currentMortgage: number
  agentCost: number
  movingCost: number
  currentTerm: number // remaining years (used by the amort chart, Phase 5)
  currentAmortRate: number // % (used by the amort chart, Phase 5)
  // Section 2 — buying the new property
  newPrice: number
  deposit: number
  existingPantbrev: number
  // Section 3 — monthly costs
  amortRate: number
  propertyTax: number
  driftkostnad: number
  interestRateA: number
  interestRateB: number
  bankAName: string
  bankBName: string
  // Toggles
  ranteavdrag: boolean // include tax relief in the affordability figure
  affordThreshold: number // monthly cost as % of gross salary
}

export interface BankFigures {
  interest: number // monthly
  amort: number // monthly
  tax: number // monthly
  drift: number // monthly
  total: number // monthly total
  annualInterest: number
  relief: number // annual ränteavdrag
  effective: number // total − relief/12
}

export interface Figures {
  // Section 1
  totalTakeaway: number
  netProceeds: number
  // Section 2
  loanAmount: number
  lagfart: number
  newPantbrevNeeded: number
  pantbrevCost: number
  totalUpfront: number
  cashBalance: number
  ltv: number // loan / price, %
  equityShare: number // 100 − ltv, %
  depositPct: number
  // Monthly
  monthlyAmort: number
  taxMonthly: number
  bankA: BankFigures
  bankB: BankFigures
  bankDiff: number // bankA.total − bankB.total
  totalMonthly: number // = bankA.total
  relief: number // = bankA.relief (annual)
  effectiveMonthly: number // = bankA.effective
  // Affordability
  reqSalaryMonthly: number
  // Equity projection
  equity: { y5: number; y10: number; y20: number }
}

function bankFigures(
  loanAmount: number,
  ratePct: number,
  monthlyAmort: number,
  taxMonthly: number,
  drift: number,
): BankFigures {
  const interest = (loanAmount * (ratePct / 100)) / 12
  const total = interest + monthlyAmort + taxMonthly + drift
  const annualInterest = interest * 12
  const relief = ranteavdrag(annualInterest)
  return {
    interest,
    amort: monthlyAmort,
    tax: taxMonthly,
    drift,
    total,
    annualInterest,
    relief,
    effective: total - relief / 12,
  }
}

/** Consolidates the legacy recalc() into one pure function. */
export function derive(i: Inputs): Figures {
  const totalTakeaway = i.salePrice - i.currentMortgage
  const netProceeds = totalTakeaway - i.agentCost - i.movingCost

  const loanAmount = i.newPrice - i.deposit
  const lagfartAmt = lagfart(i.newPrice)
  const newPantbrevNeeded = Math.max(0, loanAmount - i.existingPantbrev)
  const pantbrevCostAmt = pantbrevCost(loanAmount, i.existingPantbrev)
  const totalUpfront = i.deposit + lagfartAmt + pantbrevCostAmt
  const cashBalance = netProceeds - totalUpfront

  const ltv = equityPct(loanAmount, i.newPrice)
  const equityShare = 100 - ltv
  const depositPct = i.newPrice > 0 ? (i.deposit / i.newPrice) * 100 : 0

  const monthlyAmort = (loanAmount * (i.amortRate / 100)) / 12
  const taxMonthly = i.propertyTax / 12

  const bankA = bankFigures(loanAmount, i.interestRateA, monthlyAmort, taxMonthly, i.driftkostnad)
  const bankB = bankFigures(loanAmount, i.interestRateB, monthlyAmort, taxMonthly, i.driftkostnad)
  const totalMonthly = bankA.total
  const relief = bankA.relief
  const effectiveMonthly = bankA.effective

  const monthlyBase = i.ranteavdrag ? effectiveMonthly : totalMonthly
  const reqSalaryMonthly = i.affordThreshold > 0 ? monthlyBase / (i.affordThreshold / 100) : 0

  const annualAmort = loanAmount * (i.amortRate / 100)
  const equityAt = (yr: number) => Math.min(i.deposit + annualAmort * yr, i.newPrice)

  return {
    totalTakeaway,
    netProceeds,
    loanAmount,
    lagfart: lagfartAmt,
    newPantbrevNeeded,
    pantbrevCost: pantbrevCostAmt,
    totalUpfront,
    cashBalance,
    ltv,
    equityShare,
    depositPct,
    monthlyAmort,
    taxMonthly,
    bankA,
    bankB,
    bankDiff: bankA.total - bankB.total,
    totalMonthly,
    relief,
    effectiveMonthly,
    reqSalaryMonthly,
    equity: { y5: equityAt(5), y10: equityAt(10), y20: equityAt(20) },
  }
}

export interface StressFigures {
  monthlyInterest: number
  total: number
  afterRelief: number
}

/** Interest-rate stress test at an arbitrary rate (the slider, Phase 2/5). */
export function stressAt(i: Inputs, ratePct: number): StressFigures {
  const loanAmount = i.newPrice - i.deposit
  const monthlyAmort = (loanAmount * (i.amortRate / 100)) / 12
  const taxMonthly = i.propertyTax / 12
  const monthlyInterest = (loanAmount * (ratePct / 100)) / 12
  const total = monthlyInterest + monthlyAmort + taxMonthly + i.driftkostnad
  const annual = loanAmount * (ratePct / 100)
  return { monthlyInterest, total, afterRelief: total - ranteavdrag(annual) / 12 }
}

// Default scenario — mirrors the value="" attributes in bostadskalkyl.html,
// reused as the initial form state (Phase 2) and by the golden test.
export const DEFAULT_INPUTS: Inputs = {
  salePrice: 4_500_000,
  currentMortgage: 2_000_000,
  agentCost: 120_000,
  movingCost: 20_000,
  currentTerm: 48,
  currentAmortRate: 2,
  newPrice: 6_500_000,
  deposit: 650_000,
  existingPantbrev: 2_000_000,
  amortRate: 2,
  propertyTax: 9_725,
  driftkostnad: 3_000,
  interestRateA: 3.5,
  interestRateB: 3.9,
  bankAName: 'Bank A',
  bankBName: 'Bank B',
  ranteavdrag: false,
  affordThreshold: 30,
}

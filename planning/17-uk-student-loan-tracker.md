# Plan 17 — UK Student Loan tracker (new tool, Hemma·OS `web/`)

**Status:** new-tool plan · **Owner model:** Opus for the projection/solver engine
+ test design; Sonnet for the route/CSS once the calc is specified. ·
**Relationship:** new route in the hub; reuses the stress-slider + AnimatedNumber
+ visx chart patterns. Feeds idea #8 (cross-tool insights) later.

## Goal

A tool that answers one question: **"When, if ever, is it best to pay off my UK
student loan in full — and at what point does paying monthly stop making
financial sense?"** The core mechanic is a **total-lifetime-cost comparison**
across repayment strategies, hinging on the **write-off date**, because Plan 1
loans are written off and overpaying a soon-written-off balance is money lost.

## Loan facts (locked from grilling)

- **Plan type:** UK **Plan 1, Post-2006** (England/Wales).
- **Regime:** currently **overseas (Sweden resident)** — repaid to the SLC on
  **income assessed in GBP** against a **Sweden-adjusted threshold**, ≈ **9% of
  income above that threshold**, paid monthly. (Past UK-PAYE repayments are sunk;
  they're already reflected in today's starting balance.)
- **Write-off:** **derived** = (April first due to repay) **+ 25 years**. No
  age-65 path (that's pre-2006 only). Input = course-end / first-repayment-due
  year → write-off year = that + 25 (first due = April after course end).
- **Interest:** lower of RPI or (BoE base + 1%) — entered as a current base rate
  **+ a stress slider** (the verdict is highly rate-sensitive; reuse the
  Bostadskalkyl bank-stress UI).
- **Currency:** **dual GBP + SEK everywhere** (FX rate is a core input; SEK
  figures = GBP × rate, for display).

## The model (`lib/studentloan.ts`, pure + unit-tested)

**Inputs**
- `balance_gbp` (current), `interest_rate` (base) + `rate_stress` (slider).
- `first_due_year` → `writeoff_year = first_due_year + 25`.
- `income_sek`, `fx_sek_per_gbp` → `income_gbp`; `salary_growth_pct`.
- `se_threshold_gbp` (SLC sets per country, yearly — input with a default + a
  "verify from your overseas income-assessment letter" note).
- Optional later: a **fixed-monthly override** for the "no income provided → SLC
  applies a default" overseas case (model income-assessed as primary).

**Projection (monthly or annual steps to the write-off year)**
- Each year: `repayment = 0.09 * max(0, income_gbp − se_threshold_gbp)`, spread
  monthly; `income_gbp` grows by `salary_growth_pct`; `se_threshold_gbp` may be
  held flat or grown (assumption, documented).
- Balance accrues interest at `rate + stress`, less repayments, each step.
- Terminates when balance ≤ 0 (**cleared**) or year = `writeoff_year`
  (**written off** — remaining balance forgiven).

**Strategies compared (total lifetime cash out of pocket)**
1. **Ride it out** — pay only the mandated monthly until cleared-or-written-off.
   Total = sum of monthly repayments made.
2. **Pay off now** — Total = current `balance_gbp`.
3. **Pay off at date D** — mandated monthly until D, then lump the remaining
   balance. Total = repayments to D + balance at D.

**Solver (the engine behind the verdict)**
- Scan candidate payoff dates D from now → write-off; compute each strategy's
  total lifetime cost; pick the **minimum**. That date (or "never — let it be
  written off") is the recommendation.
- Edge logic that produces the headline insight: if projected balance **never
  clears before write-off** under the ride-it-out path, *paying off is always a
  loss* → "never pay off, you save £X by riding to write-off in {year}."

## UI (route `/student-loan`, English-named — UK-specific tool)

- **Hero (verdict):** the recommendation + £ at stake, e.g. *"Don't pay it off —
  written off {year}, you'd repay only £X of £Y; clearing now wastes £Z"* or
  *"Clear it now — you'll clear before write-off, saving £Z interest."* GBP + SEK,
  via `AnimatedNumber` (pairs with plan 13's hero roll-in).
- **Chart (proof):** balance-over-time line per strategy (ride / pay-now /
  pay-at-optimal), write-off year marked — reuse `LineAreaChart`/visx.
- **Inputs column:** balance, first-due year (→ derived write-off shown), rate +
  **stress slider**, income (SEK) + FX, salary-growth %, Sweden threshold.
- **Optimal-date readout:** the solver's chosen payoff date + its total cost vs
  the alternatives.
- Hub tool-card added to `Home.tsx` (whoosh transition like the others).

## Persistence
- localStorage settings blob (loan params), snake_case, Promise-API store
  (`lib/studentloan-store.ts`) matching the existing pattern → **Supabase-ready**
  for plan 16. Key: `bostadskalkyl_studentloan_v1` (legacy prefix per plan 15).
- Optional: a **balance-snapshot log** (record real balance over time to compare
  actual vs projected) — nice-to-have, defer.

## Constants to verify before/at build (don't trust memory)
- Current **Sweden overseas Plan 1 threshold** (GBP) — from the SLC per-country
  table / the user's assessment letter.
- Current **Plan 1 interest rate** (RPI vs base+1% — whichever is lower now).
- The 9% rate + the "first due = April after course end" + "+25 years" rule for
  Post-2006 Plan 1. *(Web-search/confirm at implementation; the user owns ground
  truth for their own loan.)*

## Out of scope
- Plan 2/4/5 or pre-2006 loans (age-65 rule) — Post-2006 Plan 1 only.
- Modelling future RPI/base-rate paths beyond the flat-base + stress slider.
- Tax/PAYE mechanics (overseas = direct to SLC, not PAYE).

## Definition of done
- `studentloan.ts` projects balance to write-off, compares the three strategies,
  and the solver returns the optimal payoff date (or "never"); **unit-tested**
  incl. the never-clears / written-off edge.
- Route renders hero verdict (GBP+SEK) + strategy chart + stress slider; tool card
  on the hub; persists via a Supabase-ready store; `build`/`oxlint`/`vitest` green.

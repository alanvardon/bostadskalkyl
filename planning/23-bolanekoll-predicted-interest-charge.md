# Plan 23 — Bolånekoll predicted interest / "expected next charge" (forecast + reconcile) (Hemma `web/`)

**Status:** feature — drafted (pre-grill; recommend a grill pass before build) ·
**Owner model:** Sonnet-suitable, but **test-first on the math** (the charge
formula is the heart of it, and it must reconcile against real bank rows). ·
**Relationship:** `lib/mortgage.ts` (new pure forecast/reconcile fns alongside
`projectBalance`/`derivedRate`), `routes/Bolanekoll.tsx` (Prognos card + an
import reconcile badge), `styles/mortgage.css`. **No store/schema change** —
reuses the existing `Payment.source` string for the optional confirm-to-log path.
Standalone; complements Plan 21 (copy-to-parts) and the roadmap's #2/#3/#9.
**Req:** chat — *"would it be possible to create something that accurately
predicts future payments interest so I wouldn't have to enter the data manually."*

## The need (from the conversation)

Each month the household imports a bank CSV of `Ränta` (interest) + `Amortering`
rows. For a flat **interest-only** loan that entry is nearly identical every
month, so the ask is to **compute the upcoming charge instead of typing/importing
it**. The honest framing locked in chat: this is **arithmetic, not forecasting** —
`interest = balance × annual_rate × days/365` — and Bolånekoll already stores
both inputs (`partBalanceAsOf`, `rate_periods`/`effectiveRate`). The only genuinely
uncertain piece is a **future rörlig (variable) rate move**; a **bunden (fixed)**
part is exact until its villkorsändringsdag.

**Design stance (locked in chat): predict-then-reconcile, not predict-instead-of.**
The bank's `Saldo` stays the ground truth (the code already trusts it over any
derived figure), and ränteavdrag/Skatteverket numbers must reflect *real* interest
paid. So the import is never replaced — it becomes a **confirm/reconcile** step, and
prediction removes the manual chore only for the steady months.

## The math — one pure helper, calibrated against history

The cadence and day-count come from the part's **own** interest history — exactly
the structure [`derivedRate`](../web/src/lib/mortgage.ts#L534) already walks
(consecutive `interest` rows, real day gaps, balance as-of the prior charge).

```ts
// lib/mortgage.ts — pure, no DOM. asOf defaults to the part's last interest date.
export interface ExpectedCharge {
  loan_part_id: string
  next_date: string          // last interest date + typical gap
  days: number               // actual days in the projected period
  balance: number            // partBalanceAsOf(part, payments, lastDate)
  rate: number | null        // effectiveRate at next_date (%)
  rate_type: 'rörlig' | 'bunden' | null
  interest: number           // balance × rate/100 × days/365
  amortization: number       // monthlyAmortizationRate-derived (0 for interest-only)
  gross: number              // interest + amortization
  confidence: 'exact' | 'assumed' | 'unknown'   // bunden-in-binding | rörlig | no rate
  calibration_gap: number | null // formula rate − derivedRate (pp); how well it matches reality
}

export function expectedCharge(part, periods, payments): ExpectedCharge | null
export function expectedCharges(parts, periods, payments):
  { rows: ExpectedCharge[]; total_interest: number; total_gross: number }
```

- **balance** = [`partBalanceAsOf`](../web/src/lib/mortgage.ts#L413) at the last
  interest date (interest-only ⇒ flat ⇒ also the current balance).
- **rate** = [`effectiveRate`](../web/src/lib/mortgage.ts#L512) at `next_date`.
  `confidence`: `bindingStatus(...).bound && !expired` ⇒ **`exact`**; `rörlig`
  (held flat) ⇒ **`assumed`**; no rate period ⇒ **`unknown`** (fall back to
  `derivedRate` if available, else null).
- **cadence** = median gap between the part's interest rows (handles monthly *and*
  quarterly/kvartalsvis billing); `days` = actual days for that next gap.
- **calibration_gap** = formula `rate` − `derivedRate(part, payments)` — the
  trust signal. Near-zero ⇒ the formula matches what the bank actually charges; a
  gap means an unlogged rate change or a different day-count convention to fix
  before relying on the number.

**Worked** — part balance 1 000 000 kr, rörlig 3.5 %, quarterly (~91 days):
`1 000 000 × 0.035 × 91/365 = 8 726 kr`, `confidence: assumed`. Same part bunden
until 2027 → identical figure, `confidence: exact`. Monthly cadence (31 days):
`1 000 000 × 0.035 × 31/365 = 2 973 kr`.

### Forward annual view (feeds ränteavdrag planning)
```ts
export function forecastInterest(parts, periods, payments, months = 12):
  { interest: number; deduction: number; net: number; assumed: boolean }
```
Rolls `expectedCharge` forward `months`, holding balance + rate flat, and runs the
total through [`ranteavdrag`](../web/src/lib/mortgage.ts) for a forward tax-deduction
estimate. `assumed: true` if any part is rörlig. Mirrors how
[`monthlyCost`](../web/src/lib/mortgage.ts#L483) summarises the *backward* view.

### Reconcile (expected vs actual) — mirrors `reconcileBalance`
```ts
export function reconcileCharge(expected: ExpectedCharge, actualInterest: number):
  { expected: number; actual: number; drift: number; ok: boolean }  // ok = |drift| ≤ max(50, 1%)
```
On import, match each new `interest` row to its part's `expectedCharge`. **Green**
when within tolerance; **flag** when not — which is exactly the signal that a rate
reset, fee, or extra amortering happened (the thing you'd otherwise miss). Reuses
the dismissible-banner pattern designed for roadmap #9.

## UI

1. **Prognos card** ([Bolanekoll.tsx:840-865](../web/src/routes/Bolanekoll.tsx#L840-L865))
   — add an **"Expected next charge"** block above the existing payoff chips:
   - Total chip: `Nästa avi ~8 726 kr` with a sub-line `interest 8 726 · amort 0`.
   - Per-part rows: `Del 2 · 3.50 % · ~2 973 kr` with an **`≈ exact`** / **`≈ est.`**
     badge from `confidence`, and an amber note when `calibration_gap` is large
     (`formula 3.50 % vs ledger 3.62 % — check the rate period`).
   - A muted forward line: `~104 700 kr interest over 12 mo · ~73 290 kr after avdrag`
     from `forecastInterest`, tagged *(assumes rates hold)* when `assumed`.
2. **Import reconcile badge** — in the import flow where drafts are built
   ([Bolanekoll.tsx:630](../web/src/routes/Bolanekoll.tsx#L630)), run `reconcileCharge`
   on each incoming interest row and show a per-part **✓ matched / ⚠ drift X kr**
   chip in the triage summary. Non-destructive — never edits the imported amount.
3. **(Phase C, optional) "Looks right → log it"** — a one-click button on the
   Expected-next-charge block that calls
   [`makePayment`](../web/src/lib/mortgage.ts#L170) with the predicted `interest`
   amount, carried-forward `balance_after`, and **`source: 'predicted'`** (existing
   string field — **no schema change**), then `Store.addPayment`. The row renders
   with a distinct *predicted* tag and is the first thing `reconcileCharge` checks
   (and offers to correct) when the real CSV later lands. This is the literal
   "don't enter it manually" win for steady months — gated behind the predict-then-
   reconcile stance so actuals always supersede a prediction.

## Decisions locked (from chat)

1. **Predict-then-reconcile**, never predict-instead-of — `Saldo` stays ground
   truth; import is a confirm/reconcile step, not removed.
2. **Arithmetic, not ML** — `balance × rate × days/365`, reusing stored balance +
   rate periods; no new data entry to forecast.
3. **Confidence is explicit** — `exact` for bunden-in-binding, `assumed` for rörlig
   (rate held flat), `unknown` with no rate; the UI never hides the assumption.
4. **Calibrate against `derivedRate`** — surface formula-vs-ledger gap so the user
   trusts/corrects the rate before relying on predictions.
5. **Cadence from the part's own history** (median interest-row gap) — supports
   monthly and quarterly billing without a new setting.
6. **No schema change** — Phase C reuses `Payment.source = 'predicted'`.
7. **Reconcile tolerance** = `max(50 kr, 1%)`; outside it = flag (rate reset / fee).
8. **Phase C (confirm-to-log) is optional and last** — Phases A/B are read-only and
   carry all the planning value with zero write risk.

## Verify (test-first on the math)

- **Unit (new `lib/mortgage-forecast.test.ts`, mirrors `mortgage-copy.test.ts`):**
  - `expectedCharge` — monthly vs quarterly cadence; bunden ⇒ `exact`, rörlig ⇒
    `assumed`, no period ⇒ `unknown`; `interest = balance × rate/100 × days/365` to
    the øre; `calibration_gap` ≈ 0 when fed a clean synthetic history.
  - `forecastInterest` — 12-mo total = 12× a monthly charge (flat case); `deduction`
    matches `ranteavdrag(total)`; `assumed` true iff any rörlig part.
  - `reconcileCharge` — within tolerance ⇒ `ok`; a rate bump or fee ⇒ `drift` flagged.
  - Round-trip sanity: predicting then "paying" the predicted amount leaves
    `partBalanceAsOf` unchanged for interest-only.
- **UI:** with seeded parts + rate periods, Prognos shows the expected-charge block
  with correct per-part figures + badges; import of a matching CSV shows ✓, a
  mismatching one shows ⚠ drift; (Phase C) confirm-to-log inserts one `predicted`
  row that a later real import reconciles against.
- `npm run build` / `oxlint` / `vitest` green.

## Out of scope

- **Predicting future *rate* moves** (Riksbank path) — rörlig is held flat and
  labelled `assumed`; no forecasting of the rate itself.
- **Auto-importing from the bank** (Open Banking / scraping) — manual CSV stays the
  source of truth; this only removes the *re-typing*, not the bank connection.
- Replacing the import or auto-overwriting actuals (Decision 1).
- Amortising-schedule modelling beyond the trailing-average `amortization` already
  used by `projectBalance` (interest-only is the real case).

## Build order

- **Phase A — forecast (read-only, no schema):** `expectedCharge`/`expectedCharges`
  /`forecastInterest` + the Prognos card block. Highest value, zero write risk.
- **Phase B — reconcile:** `reconcileCharge` + the import triage badge (roadmap #9
  applied to the interest flow).
- **Phase C — confirm-to-log (optional):** the one-click `predicted` row. Do last;
  it's the only part that writes data.

## Definition of done

- Bolånekoll computes the upcoming interest charge per part (and a 12-month forward
  total + ränteavdrag estimate) from stored balance + rate periods, labelled exact
  vs assumed and calibrated against the ledger's own derived rate; an import
  reconciles real rows against the prediction and flags drift; the math is
  unit-tested and reconciles to the øre; `Saldo` remains ground truth; no schema
  change; checks green.
```

# Plan 10 — Standardization & naming cleanup (Hemma `web/`)

**Status:** assessment + plan · **Owner model:** Sonnet-suitable (mostly
mechanical) · **Relationship:** complements plan 09. Some items synergize with
it (see *Sequencing*).

## Goal

The app grew tool-by-tool, so each tool brought its own conventions. This is a
prioritized cleanup of **naming collisions, split conventions, and copy-pasted
patterns** found by auditing `web/src`. Each item is independent; do the
high-value ones, skip or defer the marginal ones.

> Discipline: one branch `ui/standardization` (or one branch per item if you
> prefer smaller PRs), base = `main`, no stacking. Pure refactors — **behaviour
> must not change**; `npm run build && npx oxlint src && npx vitest run` green
> after each item, plus a quick click-through of the touched tools.

---

## Findings (evidence-backed)

| # | Candidate | What's wrong | Evidence | Value | Effort |
|---|---|---|---|---|---|
| 1 | **`bk-` prefix collision** | `bk-` means **both** Bolånekoll and Bostadskalkyl | `.bk-dialog/.bk-root/.bk-chart/.bk-toast` (Bolånekoll) vs `.bk-page-root/.bk-vt` (Bostadskalkyl) | High | Low–Med |
| 2 | **Shared `PageHeader`** | back-link + title + tagline + actions copy-pasted in all 7 routes | `hub-link` ×7 routes; `page-header/header-brand/tagline` ×3 in each of 7 | High | Med |
| 3 | **Store location/naming split** | Bostadskalkyl store in `store/useStore.ts`; others in `lib/*-store.ts`; `mortgage-store` ≠ tool name | `store/useStore.ts` vs `lib/{hushallsbudget,manadsavslut,mortgage,salary}-store.ts` | Med | Med |
| 4 | **Duplicated `Segmented`** | same generic control defined inline twice | `Bolanekoll.tsx:53`, `Manadsavslut.tsx:42` | Med | Low |
| 5 | **Two dialog patterns** | shared `AnimatedDialog` vs native `<dialog>` | `AnimatedDialog` used by 4 Bostadskalkyl modals; raw `<dialog>` in `Bolanekoll.tsx`, `Manadsavslut.tsx` | Med | Med |
| 6 | **Field inputs duplicated** | `components/fields.tsx` used by Bostadskalkyl; Konsult/Löneväxling re-roll their own | `fields.tsx` imported by InputsColumn/LineItemRow/AmortPlanner only; Konsult/Löneväxling have inline field render + shared `field*` CSS | Med | Med |
| 7 | **CSS namespacing inconsistent** | some tools prefix (`hb-` 33, `ma-` 43, `bk-` 69), Konsult/Löneväxling use unprefixed shared classes (`ko-`/`lv-` = 0) | prefix counts | Low–Med | Med |
| 8 | **Calc-file naming** | `calc.ts`=Bostadskalkyl, `mortgage.ts`=Bolånekoll don't match tool names | `lib/{calc,mortgage,konsult,...}.ts` | Low | Med (wide imports) |
| 9 | **`AnimatedNumber` bypass** | one component imports `NumberFlow` directly instead of the wrapper | `ScenarioCard.tsx` imports `@number-flow`; everything else uses `AnimatedNumber` | Low | Low |
| 10 | **Inline number formatting** | 21 inline `sv-SE`/`toLocaleString`/`Intl.NumberFormat` outside `format.ts` | 9 files | Low | Low–Med |

---

## Do these (high value)

### 1. Resolve the `bk-` prefix collision  *(coordinate with plan 09)*
`bk-` is overloaded. After plan 09 renames the **transition** classes
(`bk-card`→`tool-card`, `.bk-vt`→`.vt-card`/`.vt-page`), the remaining
Bostadskalkyl `bk-` classes are `.bk-page-root` (the dashboard root) and any
`.bk-*` in `ScenariosDashboard`/`Bostadskalkyl`. Bolånekoll owns the rest
(`.bk-dialog`, `.bk-root`, `.bk-chart*`, `.bk-toast`).

**Recommendation:** give each a distinct, unambiguous prefix:
- Bostadskalkyl → `bsk-` (or fold its root into the generic `.vt-page` + a neutral
  `.scenarios-root`).
- Bolånekoll → keep `bk-` (it's the more natural fit for "**B**olåne**k**oll") OR
  move to `bol-` if you want every tool to be visually distinct.
Pick one scheme and apply it in `styles/bolanekoll.css` + `Bolanekoll.tsx` +
`EquityStackChart.tsx` (Bolånekoll's `bk-`) and `styles/transitions.css`/
`dashboard.css` + the two Bostadskalkyl routes. Mechanical find-replace per file,
scoped so the two tools never share a token again.

### 2. Extract a shared `<PageHeader>`  *(synergizes with plan 09)*
All 7 routes hand-roll the same header shell (`‹ Hemma` `hub-link`, `<h1>`,
`tagline`, an actions slot). Extract `components/PageHeader.tsx`:
```tsx
<PageHeader backTo="/" title="Konsultkalkyl" tagline="…" actions={<…/>} />
```
Big win: it **centralizes the back-link**, so plan 09's
`viewTransition` + `markVtTransition(path,'back')` wiring lives in **one** place
instead of being added to 5 tool files. → If you do this, do it **before** plan
09's Phase 4 and have `PageHeader` take the tool `path` so the back-link wiring
is automatic per tool.

### 3. Extract `Segmented`
`Bolanekoll.tsx:53` and `Manadsavslut.tsx:42` define the same generic
`Segmented<T extends string>`. Move to `components/Segmented.tsx` (keep the
superset signature — Månadsavslut's has `ariaLabel`), import in both. Reconcile
the CSS (`.segmented`/`.seg` already shared) into one place.

### 4. Consolidate the stores
Move `lib/{hushallsbudget,manadsavslut,mortgage,salary}-store.ts` →
`store/`, and rename for consistency with `store/useStore.ts`:
- `store/useBudgetStore.ts`, `store/useSettlementStore.ts`,
  `store/useMortgageStore.ts` (note: this is **Bolånekoll** — decide whether the
  file/exports say `mortgage` or `bolanekoll`; pick the domain noun and use it
  everywhere, including `lib/mortgage.ts`).
- `salary-store` belongs to the budget page — fold it into the budget store or
  name it `store/useSalaryStore.ts` consistently.
Update imports. No logic change. (The `salary-store` is already isolated as a
Promise API for the planned Supabase swap — preserve that boundary.)

---

## Worth doing (medium value)

### 5. Converge on one dialog pattern
Bolånekoll & Månadsavslut use native `<dialog>` (`.bk-dialog`/`.ma-dialog`); the
Bostadskalkyl modals use `components/AnimatedDialog` (Radix + Motion). Decide one:
- If you want the Motion-animated, focus-trapped dialog everywhere → migrate the
  two native ones to `AnimatedDialog`.
- If the native `<dialog>` is intentionally lighter for those tools → at least
  share one `<ToolDialog>` wrapper + one CSS block instead of `.bk-`/`.ma-` twins.
Verify focus/escape/backdrop behaviour after — this is the one item with real
a11y surface, so test it.

### 6. Consolidate field inputs
`components/fields.tsx` is the shared field renderer (Bostadskalkyl ecosystem),
but Konsultkalkyl & Löneväxling re-roll their own field JSX over the same
`field*` CSS classes. If the shapes match, route them through `fields.tsx` (or a
small shared `<Field>`); if they diverge meaningfully, leave them but note why.

### 7. Pick one CSS namespacing rule
Decide and document: either **every** tool namespaces its tool-specific classes
(`bsk-`, `hb-`, `ma-`, `kk-`, `lv-`, `bol-`) and only truly shared atoms stay
unprefixed (`field`, `hub-link`, `btn`, `page-header`), or none do. Today it's
half-and-half (Konsult/Löneväxling unprefixed). This mostly falls out of #1, #2,
#3 — capture the rule in a one-paragraph note at the top of `styles/`.

---

## Optional / low value (don't over-invest)

- **#8 Calc-file renames** (`calc.ts`→domain name, `mortgage.ts`→`bolanekoll.ts`):
  `calc.ts` is imported widely (chartData, tests, multiple components) — high
  churn for a cosmetic win. Defer unless you're already touching those files.
- **#9 `ScenarioCard` → `AnimatedNumber`:** swap the raw `NumberFlow` import for
  the wrapper for consistency. Trivial, do it if you touch the file.
- **#10 Inline formatting:** most of the 21 hits are NumberFlow `format={{…}}`
  props (inherently inline) or chart axis formatters. Only consolidate the ones
  that re-implement `fmt`/`fmtCompact`; don't force NumberFlow props into helpers.

---

## Sequencing vs plan 09
1. **Land plan 09** (transition propagation) OR interleave #1 and #2 with it:
   - #2 `PageHeader` is best done **as part of / just before** plan 09 Phase 4 so
     the back-link transition wiring is written once.
   - #1 `bk-` disambiguation should be coordinated so plan 09's rename and this
     cleanup don't both touch `transitions.css`/`bolanekoll.css` in conflicting
     ways — do plan 09's VT rename first, then this resolves the *leftover* `bk-`.
2. Everything else (#3–#10) is independent of plan 09 and can land any time.

## Recommended order (by value ÷ effort)
**#4 (Segmented) → #2 (PageHeader, with plan 09) → #1 (bk- collision) →
#4-stores → #5 (dialogs) → #6 (fields) → #7 (namespacing note).** Skip/defer
#8–#10.

## Definition of done
- No CSS prefix is shared by two tools; convention documented.
- Header and `Segmented` exist once; back-link wiring lives in `PageHeader`.
- All stores in `store/`, named consistently; domain nouns match tool names.
- `npm run build` / `oxlint` / `vitest` green; every touched tool clicks through
  identically (pure refactor).

# Planning — Hemma / Bostadskalkyl feature batch

Six requests reviewed on 2026-06-27. All six are implementable; each has its own
doc. **Files are numbered 01–06 in recommended build order**; the **Req** column
maps each back to your original request list. The **Decisions locked** section at
the top of each doc is the source of truth (and each doc's title keeps its
original request number, e.g. "#3", which the cross-references rely on).

## The six (in build order)

| File | Req | Summary | Effort | Depends on |
|------|-----|---------|--------|------------|
| [01-ci-pin-ubuntu.md](01-ci-pin-ubuntu.md) | 6 | Pin CI runner `ubuntu-latest` → `ubuntu-24.04`. | XS | — |
| [02-chart-morph-jank-fix.md](02-chart-morph-jank-fix.md) | 4 | Fix chart jank on minimize — defer mounting the heavy visx chart until the morph settles. | S–M | — |
| [03-hushallsbudget-lock-names.md](03-hushallsbudget-lock-names.md) | 5 | Lock Hushållsbudget item/category names behind a per-row pen-edit toggle. | S | — |
| [04-scenarios-dashboard.md](04-scenarios-dashboard.md) | 3 | Bostadskalkyl scenarios become a full-page dashboard you land on; calculator moves to `/bostadskalkyl/:id`. Hybrid save (named cards auto-save; "New" = scratch draft). | M–L | — (foundation) |
| [05-bostadskalkyl-editable-constants.md](05-bostadskalkyl-editable-constants.md) | 2 | Settings panel for the statutory constants (fastighetsavgift cap, 15% min, lagfart, pantbrev, ränteavdrag, amort rules). Per-scenario override; amort rate auto-derives. | M | Req 3 |
| [06-tool-card-expand-animation.md](06-tool-card-expand-animation.md) | 1 | Hub tool card "expands into the page" via the native View Transitions API (RR v7 `viewTransition`). Bostadskalkyl card first. | S–M | Req 3 |

## Dependency graph

```
Req 3 scenarios dashboard (file 04) ──┬──► Req 2 editable constants (file 05)  (constants ride inside the scenario record)
                                      └──► Req 1 card expand anim   (file 06)  (morph destination = the dashboard)

Req 4 chart jank (file 02) ── independent
Req 5 lock names (file 03) ── independent
Req 6 CI pin     (file 01) ── independent
```

## Build order = file order

1. **01 — CI pin** (Req 6) — trivial, ship it first (one PR, two lines).
2. **02 — chart jank** (Req 4) + **03 — lock names** (Req 5) — independent,
   self-contained polish; either order.
3. **04 — scenarios dashboard** (Req 3) — the foundation; restructures routing +
   the store.
4. **05 — editable constants** (Req 2) — rides on 04's per-scenario model and the
   `calc.ts` refactor.
5. **06 — card expand animation** (Req 1) — its morph lands on the 04 dashboard,
   so do it with/after 04.

Each remains its own branch + PR (`ui/<slug>`), base `main`, landed one at a time.

## Out of scope / parked (raised during review, not requested)

- Scenario **comparison** view on the dashboard (natural extension; not asked for).
- Extending the card-expand animation to the **other 5 tools** (deliberately scoped to Bostadskalkyl first as a proof-of-concept).
- Moving drift/savings line items from session-global to per-scenario (currently session-level by design).
- SHA-pinning GitHub Actions (considered in 01, deferred).

# Playwright MCP for qa.md

**Verdict:** Worth doing. High value-to-effort for a calculator app.

## Why this is a strong fit

`qa.md` today is a *static* reviewer:
- `node --check` on the inline `<script>` block (catches syntax only)
- a checklist that pattern-matches the diff (catches conventions only)

Neither check ever loads `index.html`, runs `calc()`, or asserts that a
known input produces the expected output. Every calculation regression
ships as long as the syntax is valid and CSS variables are used.

Playwright MCP closes exactly that gap: load the page in a real browser,
type values into inputs, read computed outputs.

## What a "viable" version looks like

A small fixture file — e.g. `.workflow/qa-fixtures.json` — with 3–5
golden scenarios:

```json
[
  {
    "name": "baseline-buy-sell",
    "inputs": { "salePrice": 5000000, "purchasePrice": 6000000, ... },
    "expected": { "downpaymentNeeded": 900000, "monthlyCost_A": 18500, ... }
  }
]
```

qa drives Playwright MCP to:
1. Open `file:///…/index.html`
2. Fill inputs (by id)
3. Read `textContent` of the summary cards
4. Compare to expected within a tolerance (e.g. ±1 kr to absorb rounding)

Add one new checklist item: **Golden scenarios match expected output**.

## Tradeoffs / risks

- **Fixture maintenance.** When intentional calc changes ship, fixtures
  need updating. Mitigate by keeping the set small (3–5) and re-recording
  via a flag rather than hand-editing numbers.
- **MCP availability.** Playwright MCP needs to be installed and listed
  in `.claude/settings.json`. One-time setup.
- **Headless cost.** Chromium launch is ~1s; trivial for a five-scenario
  run.

## Rough plan (for the deeper planning pass)

1. Install/enable Playwright MCP, add to project settings
2. Author `qa-fixtures.json` with 3 representative scenarios
3. Add a "Golden scenarios" section to `qa.md`'s checklist and a
   "Functional check" subsection mirroring the existing "Syntax check"
4. Decide failure format — likely: list per-scenario `expected vs got`
   diffs in `QA_FAILURES_FILE`

## Related

- [[02-qa-agent-handoff]] — current qa scope and rationale

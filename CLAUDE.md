# Bostadskalkyl

A personal Swedish house purchase calculator. Single-file HTML application 
that runs locally in the browser. No build step, no dependencies except 
Chart.js loaded via CDN.

## File structure

Everything lives in `index.html`:
- CSS in `<style>` block in `<head>`
- HTML structure in `<body>`
- JavaScript in `<script>` block before `</body>`

## Architecture

### Layout
Two-column layout with independent scroll:
- Left: inputs column (sections 1–4)
- Right: summary column (fixed-width, 360px)

### Sections
- Section 1: Selling current property
- Section 2: Buying new property
- Section 3: Monthly costs — dual bank comparison with ränteavdrag
- Section 4: Interest rate stress test table

### Key functions
- `calc()` — master calculation function, runs on every input change, 
  updates all derived values and summary panel
- `set(id, text, cls)` — safely updates a DOM element's text and 
  colour class without wiping other classes
- `val(id)` — reads a numeric value from any input (handles currency 
  formatting and number inputs)
- `formatWithSpaces(n)` — formats a number with Swedish space separators
- `parseFormatted(str)` — parses a space-formatted string back to a number

### Modals
Each modal follows the same pattern:
- Backdrop div with class `modal-backdrop`, opened with `.open` class
- `open[Name]Modal()` and `close[Name]Modal()` functions
- Click-outside-to-close on the backdrop element

Current modals:
- `scenariosModal` — saved scenarios
- `savePrompt` — save/update scenario prompt
- `amortModal` — mortgage payoff comparison chart
- `chartFullscreen` — fullscreen version of the amort chart
- `driftModal` — itemised driftkostnad breakdown
- `savingsModal` — savings entries

### localStorage keys
- `bostadskalkyl_scenarios` — saved scenario objects
- `bostadskalkyl_session` — current session state (inputs + active scenario)
- `bostadskalkyl_drift_items` — driftkostnad line items
- `bostadskalkyl_drift_yearly` — monthly/yearly toggle preference
- `bostadskalkyl_savings_items` — savings entries

### Input types
- Currency inputs: `type="text"` with `data-type="currency"` — 
  formatted with space separators, stripped on focus
- Number inputs: `type="number"` — used for rates, years, percentages
- Text inputs: bank names, listing URL, modal label fields

### Saved inputs
Three arrays drive save/restore:
- `CURRENCY_IDS` — currency text inputs
- `NUMBER_IDS` — number inputs
- `TEXT_IDS` — plain text inputs (bank names, listing URL)
The ranteavdrag toggle is saved separately as `data.ranteavdrag`.

## Swedish property conventions
- Lagfart: 1.5% of purchase price
- Pantbrev cost: 2% of new pantbrev amount needed
- New pantbrev needed: loan amount minus existing pantbrev held
- Ränteavdrag: 30% tax relief on first 100 000 kr/yr interest, 
  21% above that
- Fastighetsavgift: capped at 9 287 kr/yr (2024)
- Amortisation: set as annual % of loan, not a fixed term
- LTV displayed as inverse (equity %) — green ≥30%, amber 15–30%, 
  red <15%

## Design system
- Fonts: DM Serif Display (headings), DM Sans (body)
- Colour palette defined as CSS variables in `:root`
- Key colours: `--accent` (green #2d5a3d), `--warn` (amber/brown #8b4a1a)
- Positive values: `--accent` green
- Negative values: `--warn` amber-brown
- Cards: `sum-card` class, clickable variant adds `sum-card-clickable`
- Currency always formatted with `sv-SE` locale via `fmt()` helper

## Git workflow
- Never commit directly to main
- Create a branch for every change: `feature/*`, `fix/*`, `refactor/*`
- Write a clear, specific commit message describing what changed and why
- Push the branch and open a PR — do not merge without review
- One logical change per PR — don't bundle unrelated changes

## Things to never do
- Never remove or rename `calc()` — everything depends on it
- Never use `el.className = ...` to set classes — use `classList` to 
  avoid wiping existing classes (this was a past bug)
- Never hardcode colours — always use CSS variables
- Never add `position: fixed` inside modals — breaks iframe height
- Never commit API keys, tokens or sensitive data
- Never force push to any branch
- Never merge to main without a PR
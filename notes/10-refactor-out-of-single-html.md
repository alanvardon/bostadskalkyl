# Refactoring out of a single HTML file

**Verdict:** Go straight to Tier 2 (light modularisation, no build
step). `index.html` is already at ~2800 lines, past the threshold
where Tier 1 alone would still leave one uncomfortably large `app.js`.
A full framework rewrite is not yet warranted.

## What CLAUDE.md says today

> Single-file HTML application that runs locally in the browser. No
> build step, no dependencies except Chart.js loaded via CDN.

That constraint exists for real reasons:
- Open the file → it works. No `npm install`, no dev server.
- Trivial to send the file to anyone (see [[09-remote-sharing-with-partner]]).
- Diffing is straightforward; agents reason about one file.

Any refactor must preserve at least the "open it and it works"
property — otherwise the cost is real and the benefit is style points.

## Three tiers of refactor

### Tier 1 — file split, no build step (low risk)

Split into three sibling files referenced from `index.html`:
- `index.html` — structure only
- `styles.css` — the `<style>` contents
- `app.js` — the inline `<script>` contents

Pros:
- Editor support improves (CSS linter, JS linter natively work)
- `qa.md`'s syntax extraction step disappears — just `node --check app.js`
- "Open the file" still works (browsers load relative `<link>`/`<script>`)

Cons:
- Some browsers refuse `file://` cross-origin for ES modules — stay on
  classic script tags
- CLAUDE.md needs updating; agent prompts that reference "the inline
  `<script>` block" need to point at `app.js`

This tier is mostly mechanical and high value.

### Tier 2 — light modularisation (medium risk)

Split `app.js` itself into a handful of classic-script files. See
**Target structure** under Recommended path for the concrete layout
and ownership rules. The shape: pure math separate from DOM helpers
separate from storage, with `app.js` as the orchestrator.

No bundler, no modules — just multiple `<script>` tags. Still
"open and works." A `// @ts-check` JSDoc layer becomes feasible.

Cons:
- Global namespace pollution if not careful — wrap each in an IIFE or
  an explicit `window.App = {…}` namespace
- More files for agents to track

### Tier 3 — framework / build step (high risk for this app)

Candidates, ranked by how well they preserve "open it and it works":

1. **Lit** — web components, ESM, loadable from a CDN. No build step
   strictly required; can keep `file://`-equivalent behaviour with a
   trivial dev server (`python3 -m http.server`). Lowest-friction
   Tier 3 if the constraint stays sacred.
2. **SolidJS** — fine-grained reactivity, closest mental model to the
   current imperative `calc()` (signals = `calc()`'s implicit deps,
   made explicit). Needs Vite.
3. **Svelte** — best DX, biggest semantic jump. Needs Vite + a
   compiler pass; "send the file" becomes "send the built bundle."

All three add:
- `npm install` step (kills the "send the file" property unless we
  build before shipping)
- Component model for the four sections + the modals
- Tooling — Vite, types, lint

Only worth it if the *complexity* of the app outgrows imperative
`calc()` — many more sections, deeper interaction, or multiple
"pages." We're not there yet, but the sequencing section below
assumes we will be (Supabase migration triggers the framework move).

## Recommended path

Go directly to Tier 2. The file is already 2809 lines — splitting CSS
and JS out (Tier 1) leaves an `app.js` of roughly 2000 lines, which
crosses the "can't find `calc()` without ctrl-F" threshold on day one.
Doing Tier 1 as an intermediate commit is fine, but don't stop there.

### Target structure

Flat layout next to `index.html`, no subdirectories:

```
bostadskalkyl/
├── index.html        # structure only — <link> + <script> tags in order.
│                     #   No inline onclick/onchange handlers — all events
│                     #   wire up from app.js
├── styles.css        # everything from the current <style> block. Stays
│                     #   one file at ~600–800 lines; split into
│                     #   base/sections/modals only if it crosses ~1500
├── calc.js           # PURE math + formatters — no DOM. lagfart(),
│                     #   pantbrev(), ranteavdrag(), monthlyCost(),
│                     #   fmt(), parseFormatted(), formatWithSpaces()
├── dom.js            # set(id, text, cls), val(id) — the only files that
│                     #   touch the DOM directly (besides modals/charts)
├── storage.js        # all localStorage read/write (scenarios, session,
│                     #   drift items, savings items, toggle prefs).
│                     #   Async public API from day one (see Supabase section)
├── modals.js         # open/close for every modal (scenarios, save,
│                     #   amort, fullscreen, drift, savings)
├── charts.js         # Chart.js wiring (amort chart + fullscreen)
└── app.js            # master orchestrator App.recalc() (reads via val(),
                      #   calls App.calc.*, writes via set()), event
                      #   listeners, boot — loaded last
```

Script load order in `index.html` is the dependency graph:
`calc.js → dom.js → storage.js → modals.js → charts.js → app.js`.

Use a single `window.App = {}` namespace (or per-file IIFEs) to avoid
polluting globals. No bundler, no ES modules — keeps `file://` working
and preserves "open it and it works."

**Namespace ownership rule:** every `window.App.*` key has exactly
one writer. `calc.js` owns `App.calc`, `storage.js` owns `App.storage`,
`dom.js` owns `App.dom`, `modals.js` owns `App.modals`, `charts.js`
owns `App.charts`, `app.js` owns `App.recalc` (the orchestrator). No
file mutates another file's namespace. This rule is what makes the
eventual ESM conversion a mechanical find-and-replace.

**DOM ownership rule:** `dom.js` is the only file that exposes the
*generic* `set()` / `val()` helpers — every cross-section input read
and summary write goes through them. Modals own their own modal DOM
(open/close, backdrop classes, list items inside the modal) and
`charts.js` owns the canvas. Anything outside those scopes routes
through `dom.js`.

**Namespace pattern (sync file example, mirror of the async storage
example below):**

```js
// calc.js
(function () {
  const lagfart = (price) => price * 0.015;
  const pantbrev = (loan, existing) => Math.max(0, loan - existing) * 0.02;
  const fmt = (n) => n.toLocaleString('sv-SE');
  window.App = window.App || {};
  window.App.calc = { lagfart, pantbrev, fmt };
})();
```

The master orchestrator (today named `calc()` in the single file) is
renamed to `window.App.recalc()` in `app.js` — it's wiring, not math,
and depends on every other module. The "never rename `calc()`" rule
in CLAUDE.md is the single-file-era guarantee; the Tier 2 refactor is
the explicit moment that retires it, and CLAUDE.md gets updated in
the same PR.

### Designing Tier 2 to bridge to Tier 3

We know a framework migration is coming eventually. Tier 2 should make
that migration mechanical, not a second rewrite. How each file maps:

| Tier 2 file   | Lit                 | Solid / Svelte         |
|---------------|---------------------|------------------------|
| `calc.js`     | utility module      | derived signals / store|
| `dom.js`      | absorbed by bindings| absorbed by bindings   |
| `storage.js`  | utility module      | persisted store        |
| `modals.js`   | `<x-modal>` elements| `<Modal />` components |
| `charts.js`   | `<x-chart>` element | `<Chart />` component  |
| `app.js`      | host `<x-app>`      | root component         |

`dom.js` disappears in Tier 3 because frameworks own the
DOM-read/DOM-write seam. That's fine — its only consumers are
`app.js`, `modals.js`, and `charts.js`, all of which get rewritten
anyway.

Concrete rules that make the migration easy (the namespace and DOM
ownership rules above are the foundation; this section adds the
dependency-shape rules):

- **Dependency direction is one-way, both leaves independent:**
  ```
  storage  ← (nothing)
  calc     ← (nothing — pure)
  modals   ← calc, storage, dom, App.recalc
  charts   ← calc, dom
  app      ← everything; owns App.recalc (the orchestrator)
  ```
  `calc` and `storage` are both leaves and never import each other.
  This matches how stores compose in every framework.
- **How modals trigger re-render:** modals call `App.recalc()`
  directly after any state change that affects the main view (e.g.
  drift modal save → `await App.storage.saveDriftItems(...)` →
  `App.recalc()`). Do not rely on `storage.onChange` for this — that's
  for *cross-tab/cross-client* updates, not local user actions.
  Stating the convention explicitly avoids each modal reinventing it.
- **`calc.js` is pure.** No DOM, no localStorage, no Chart.js. Every
  function takes inputs and returns outputs. This is what makes the
  unit tests trivial and the framework migration mechanical.

### Designing for the Supabase migration too

[[09-remote-sharing-with-partner]] plans to swap localStorage for
Supabase (async DAL, realtime subscriptions). `storage.js` is the
seam that change lands on, so build it to absorb the swap:

- **Make `storage.js`'s public API async from day one.** Every
  function returns a Promise, even though the body is sync localStorage
  today. Callers `await` from the start. When Supabase lands, only the
  body of `storage.js` changes.
  ```js
  // Today
  window.App.storage.loadScenarios = async () =>
    JSON.parse(localStorage.getItem('bostadskalkyl_scenarios_v1') || '[]');
  // Tomorrow: same signature, body becomes `await supabase.from(...)`
  ```
  Boot consequence: the bootstrap in `app.js` becomes async (`await
  storage.restoreSession()` → populate inputs → `calc()`). To avoid a
  flash of empty inputs, hide the inputs column (`visibility: hidden`)
  until first `calc()` completes, then reveal.
- **Expose a change-event API.** Pub/sub keyed by storage key:
  ```js
  window.App.storage.onChange('scenarios', (newValue) => {
    // re-render scenarios list
  });
  ```
  Trigger semantics (pin these down to avoid loops):
  - Fires *only when the underlying value changes*, not on every
    save call. Compare against the previous value before dispatching.
  - Does **not** fire for writes initiated by the local tab itself
    (those callers already know the new state). Today this means
    "never fires"; tomorrow it means "fires on Supabase realtime
    events originating from another client."
  - Callbacks receive the new value; subscribers are responsible for
    their own re-render (typically calling `App.recalc()` or
    refreshing a modal list).
  Without this API in place now, every caller that needs to react to
  remote updates becomes a touch site during the Supabase migration.
- **Version the localStorage schema.** Use a `_v1` suffix on every key
  (e.g. `bostadskalkyl_scenarios_v1`). On first read, if the unversioned
  key exists and the `_v1` key doesn't, copy unversioned → `_v1` and
  delete the old key. That migration runs once per user; the Supabase
  upload then reads only `_v1` keys.
- **`session_state` sync needs a policy decision.** Shared session
  state means your partner sees fields change as you type. Debounce
  writes, or scope `session_state` per-user and only share `scenarios`
  + `drift_items` + `savings_items`. Defer the decision, but leave a
  `// FUTURE: per-user vs household` marker on the session save path.
- **A future `auth.js` joins the structure before `storage.js`.** Auth
  provides the user/household context that `storage.js` needs to scope
  queries — auth must be loaded and resolved before storage runs. Not
  built now, but reserve the slot: load order becomes `calc → dom →
  auth → storage → modals → charts → app`.

### Tier 3 and Supabase are coupled, sequence accordingly

The day Supabase lands, the `file://` property dies (network + auth
required to open the app). That's also the day the main argument
against ESM evaporates, which makes a framework migration cheap.
Likely sequencing:

1. **Now:** Tier 2 split (this plan)
2. **Later:** Supabase migration → drop classic scripts, switch to
   ESM in the same commit (cheap mechanical sed pass given the
   namespace pattern)
3. **Shortly after:** Tier 3 framework adoption (Lit / Solid / Svelte)
   while the codebase is already ESM and async-DAL'd

Doing Supabase *without* flipping to ESM would mean carrying classic
scripts forward unnecessarily — the constraint that justified them is
gone. Doing Tier 3 *before* Supabase means rewriting the data layer
twice. Bundle the ESM flip with Supabase; line up Tier 3 right after.

### Why not ES modules from day one

ES modules would convert to a framework with zero ceremony, but
`<script type="module">` triggers CORS for `file://` opens — killing
the "double-click to run" property. Sticking with classic scripts
keeps that property; the namespace pattern above means converting
`window.App.calc.lagfart` → `import { lagfart } from './calc.js'` is
a mechanical find-and-replace when Tier 3 lands. The cost of
deferring is one sed pass; the benefit is keeping `file://` for the
years until then.

If at any point the dev server becomes acceptable (e.g. partner stops
needing the file emailed), flip to ESM immediately — there's no
reason to wait for Tier 3 once that constraint relaxes.

### Alternative structure considered (and rejected)

A `css/` + `js/` subdirectory layout with per-modal files
(`drift.js`, `savings.js`, `scenarios.js`) was suggested. Rejected
because:

- **Subdirectories add navigation friction** with no benefit at this
  scale — seven files is fine flat.
- **Per-modal files over-split.** Drift and savings logic will each
  be ~80–150 lines; splitting them creates orphan singletons that are
  harder to navigate than one consolidated `modals.js`.
- **`scenarios.js` conflates UI and storage.** Other features
  (session, drift items, savings items) also touch localStorage —
  centralising in `storage.js` is cleaner.
- **No explicit entry point.** Without an `app.js` loaded last, init
  and event wiring get scattered across feature files.

## Tradeoffs / risks

- **Visible UX regression: async boot delay.** Today the page loads
  with restored inputs instantly (sync localStorage read). After
  Tier 2, the bootstrap is async (`await storage.restoreSession()`),
  meaning a brief "no inputs visible" gap on every reload. Mitigation:
  hide the inputs column with `visibility: hidden` until the first
  `App.recalc()` completes, then reveal. This is the only behaviour
  change a user can observe — surface it explicitly so it doesn't
  show up as a "regression bug" report.
- **Agent prompt drift.** Specifically audit these files for "inline
  `<script>`", "single-file", or `calc()`-as-master-function
  references:
  - `.claude/agents/*.md` (every agent definition)
  - `notes/02-qa-agent-handoff.md`
  - any other `notes/*.md` that names the file structure
  Update before the carve, not after.
- **Deployment.** Tier 1 still works on Netlify (just upload the
  files). Add a `.netlifyignore` (or equivalent) listing `*.test.js`
  so tests don't ship. Tier 3 requires a build step in the deploy.
- **Keep `calc` and `storage` as independent leaves.** Neither
  imports the other. `app.js` is the only file that talks to both
  (reads inputs via `dom.val`, calls `App.calc.*` pure functions, then
  hands results to `App.storage.save*` if needed). If you find yourself
  reaching from `calc` into `storage` or vice versa, the orchestration
  belongs in `app.js`.
- **Namespace bloat on `window.App`.** Easy to dump every helper
  there. Keep it to the file-level exports each module wants to
  expose; private helpers stay scoped inside the IIFE. One writer per
  `App.*` key (see Namespace ownership rule).
- **Chart.js global vs import.** Currently `Chart` is a CDN global.
  `charts.js` should alias it at the top (`const Chart = window.Chart;`)
  so the dep is visible and the Tier 3 swap to
  `import Chart from 'chart.js'` is a single-line change.
- **`App.recalc()` stays synchronous.** Pure DOM-read → pure-math →
  DOM-write. The only async paths are boot restore (`await`ed once)
  and save calls (fire-and-forget — modals don't await
  `saveDriftItems` before calling `App.recalc()`). Keeping recalc sync
  means input changes feel instant; making it async would introduce
  per-keystroke awaits with no benefit.

## Side benefits worth claiming during Tier 2

- **`// @ts-check` + JSDoc on `calc.js` and `storage.js`.** Catches
  type bugs in your editor today; carries verbatim into Svelte-TS /
  Solid-TS / Lit-TS later. Optional, can land after the split.
- **Documented localStorage schema in `storage.js`.** A single file
  listing every key, its shape, and its version. Future migrations
  (framework or otherwise) need this, and it's free to write now.

(Note: `calc.test.js` is *not* in this list — it's a prerequisite for
the split itself, see the Rough plan below.)

## Rough plan (Tier 2)

Done in small, independently revertable commits. Tests land first as
the safety net; mechanical split second; per-file carves third.

### Commit 0 — Behavioural safety net (prerequisite)

1. Identify the headline pure calculations inside `<script>`: lagfart,
   pantbrev, ränteavdrag (both brackets), monthly cost, fastighetsavgift
   cap, LTV/equity %.
2. Extract them as pure functions inline (still in the single file).
3. Write `calc.test.js` (sibling of the eventual `calc.js`, at repo
   root) with `node --test` covering each, including edge cases (zero
   loan, interest above 100k threshold, fastighetsavgift at and above
   cap). Add `*.test.js` to `.netlifyignore` (or equivalent) so tests
   don't ship.
   *Tests only cover pure math.* UI regressions (modals, persistence,
   chart rendering) are caught by the definition-of-done checklist
   below, not by `calc.test.js`.
4. Capture the **definition of done** for the whole refactor — these
   must all pass byte-identical after the split:
   - [ ] Save a scenario → reload page → scenario still listed
   - [ ] Load a scenario → all inputs repopulate, all outputs match
   - [ ] Drift modal → add/edit/delete item → persists across reload
   - [ ] Savings modal → same
   - [ ] Amort chart renders; fullscreen variant renders
   - [ ] Session state restores on reload (all inputs)
   - [ ] Ränteavdrag toggle persists
   - [ ] Listing URL persists
   - [ ] All 4 sections recalculate on every input change
   - [ ] No console errors on load or interaction

### Commit 1 — Tier 1 mechanical extract

1. Rename `bostadskalkyl.html` → `index.html` (the convention for "the
   main HTML file in this folder"; the entire plan assumes this name).
2. Extract `<style>` → `styles.css`, replace with `<link rel="stylesheet">`
3. Extract `<script>` → `app.js`, replace with `<script src="app.js">`
4. Run `calc.test.js`; verify definition-of-done checklist in browser.

### Commits 2a–2f — Per-file carves out of `app.js`

One commit per file so each is independently reviewable and revertable.
After each, re-run tests + checklist.

- **2a — `calc.js`** (pure math + formatters). Easiest first; already
  extracted as pure functions in Commit 0, just move them out and
  attach to `window.App.calc`.
- **2b — `dom.js`** (`set`, `val`). Tiny but unblocks future seams.
- **2c — `storage.js`** with **async** Promise-returning helpers
  (bodies still sync localStorage today) and `onChange(key, cb)` pub/sub.
  Includes the unversioned → `_v1` migration on first read.
- **2d — `modals.js`** — every `open*Modal` / `close*Modal` plus
  backdrop click handlers. Modals call `App.recalc()` directly after
  any save that affects the main view. Add `// FUTURE: extract to
  drift.js once >200 lines` markers above drift/savings sections.
- **2e — `charts.js`** — Chart.js instantiation + update logic. Alias
  the global at the top: `const Chart = window.Chart;`. Keeps using
  the CDN script; the alias makes the Tier 3 swap to
  `import Chart from 'chart.js'` a one-line change.
- **2f — clean `app.js`** — what remains: `window.App = {}` init,
  `App.recalc()` orchestrator, event listener wiring, async boot
  (`await storage.restoreSession()` → first `App.recalc()` → reveal
  inputs column). Reorder `<script>` tags in `index.html`: `calc →
  dom → storage → modals → charts → app`.

### Cross-cutting (do alongside the carves)

- Move any inline `onclick="..."` / `onchange="..."` in `index.html`
  to `addEventListener` calls in `app.js` or `modals.js`. None should
  remain after Tier 2.
- Update `.claude/agents/qa.md`'s syntax-check step to `node --check`
  each `.js` file plus `node --test calc.test.js`.
- Update CLAUDE.md's "File structure" and "Key functions" sections to
  reflect new file homes; retire the "never rename `calc()`" rule
  (replaced by `App.recalc()` in `app.js`) and document the
  one-writer-per-`App.*`-key rule.
- Audit `.claude/agents/*.md`, `notes/02-qa-agent-handoff.md`, and any
  other `notes/*.md` that references the single-file structure.

### Optional follow-up commits

- Add `// @ts-check` + JSDoc to `calc.js` and `storage.js`.
- Extend `calc.test.js` to cover the amortisation schedule and stress
  test table once the headline calculations are pinned.

## Related

- [[09-remote-sharing-with-partner]] — Supabase migration lands
  cleanly on `storage.js`; design that file to absorb the swap
- [[11-ui-ux-frameworks]] — framework question; sequencing
  recommendation is to land it just after Supabase, not before
- [[02-qa-agent-handoff]] — qa's syntax check simplifies after Tier 1

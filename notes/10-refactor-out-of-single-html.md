# Refactoring out of a single HTML file

**Verdict:** Tier 2 — light modularisation — confirmed as the plan (2026-05-20).
A full framework rewrite is not warranted.

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

Split `app.js` itself into a few classic-script files loaded in order:
- `calc.js` — `calc()`, `val()`, `set()`, formatters
- `storage.js` — localStorage read/write
- `modals.js` — open/close functions
- `charts.js` — Chart.js wiring
- `app.js` — wiring + event listeners (loaded last)

No bundler, no modules — just multiple `<script>` tags. Still
"open and works." A `// @ts-check` JSDoc layer becomes feasible.

Cons:
- Global namespace pollution if not careful — wrap each in an IIFE or
  an explicit `window.app = {…}` namespace
- More files for agents to track

### Tier 3 — framework / build step (high risk for this app)

Svelte, SolidJS, or even Lit. Adds:
- `npm install` step (kills the "send the file" property unless we
  build before shipping)
- Component model for the four sections + the modals
- Tooling — Vite, types, lint

Only worth it if the *complexity* of the app outgrows imperative
`calc()` — many more sections, deeper interaction, or multiple
"pages." We're not there.

## Confirmed plan: Tier 2

## Tradeoffs / risks

- **Agent prompt drift.** Every agent file that mentions the inline
  script needs updating. Audit before, not after.
- **Deployment.** Multi-file still works on Netlify (upload all files).
  Tier 3 would require a build step.
- **Name collisions.** 7+ global script files share one namespace.
  Mitigation: IIFEs or a `window.app` namespace. Start flat; fix if needed.

## Implementation plan

1. Audit CLAUDE.md and any agent files — update all references to the
   inline `<script>` block before touching any code
2. Create `css/` and `js/` subdirectories
3. Extract `<style>` → `css/styles.css`, replace with `<link>`
4. Extract and split the `<script>` block into the files below, in order:
   - `js/calc.js` — `calc()`, `val()`, `set()`, formatters
   - `js/storage.js` — localStorage read/write helpers
   - `js/modals.js` — generic open/close + click-outside pattern
   - `js/drift.js` — driftkostnad state + its modal
   - `js/savings.js` — savings state + its modal
   - `js/scenarios.js` — scenario save/load/render
   - `js/charts.js` — Chart.js wiring
   - `js/app.js` — event listeners, init (loaded last)
5. Replace the single `<script>` tag with 8 `<script src="js/...">` tags
   in the load order above
6. Update `qa.md`'s syntax-check step to run `node --check` on each `.js` file
7. Update CLAUDE.md's "File structure" section
8. Verify in browser: open `index.html` directly, every feature still works

## File structure (confirmed 2026-05-20)

Feature-based split, refined to add a missing `app.js` entry point and
a `storage.js` for shared localStorage helpers:

```
├── index.html
├── css/
│   └── styles.css
└── js/
    ├── calc.js        # calc(), val(), set(), formatters
    ├── storage.js     # localStorage read/write helpers (session, drift, savings keys)
    ├── scenarios.js   # scenario save/load/render
    ├── modals.js      # generic open/close + click-outside pattern
    ├── drift.js       # driftkostnad state + its modal
    ├── savings.js     # savings state + its modal
    ├── charts.js      # Chart.js wiring
    └── app.js         # event listeners, init — loaded last
```

**Load order** (script tags in this sequence, no ES modules):
`calc.js` → `storage.js` → `modals.js` → `drift.js`, `savings.js`,
`scenarios.js`, `charts.js` → `app.js`

**Why `drift.js` and `savings.js` are separate from `modals.js`:**
Both manage their own item-list state, so they're more than open/close
wrappers and warrant their own files.

**Why `storage.js` is needed:**
`scenarios.js` only covers save/load of scenarios. Session state
(`bostadskalkyl_session`) and drift/savings localStorage keys don't
belong there — a shared `storage.js` avoids duplication.

**Risk:** With 7+ global script files and no bundler, name collisions
across files are possible. Mitigation: wrap each file in an IIFE, or
expose a single `window.app` namespace. Start flat; fix collisions if
they appear.

## Related

- [[11-ui-ux-frameworks]] — frameworks question is adjacent but
  separable; can be answered independently
- [[02-qa-agent-handoff]] — qa's syntax check simplifies after this refactor

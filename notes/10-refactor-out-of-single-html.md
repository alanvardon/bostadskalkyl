# Refactoring out of a single HTML file

**Verdict:** A *light* split is worth doing once `index.html` crosses a
maintainability threshold. A full framework rewrite is not yet
warranted.

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

## Recommended path

Do Tier 1 now. Stop. Re-evaluate Tier 2 once `app.js` is uncomfortable
to navigate (rough threshold: >1500 lines, or you can't find `calc()`
without ctrl-F'ing).

## Tradeoffs / risks

- **Agent prompt drift.** Every agent file that mentions the inline
  script needs updating. Audit before, not after.
- **Deployment.** Tier 1 still works on Netlify (just upload the three
  files). Tier 3 requires a build step in the deploy.

## Rough plan (Tier 1)

1. Extract `<style>` → `styles.css`, replace with `<link>`
2. Extract `<script>` → `app.js`, replace with `<script src="app.js">`
3. Update `qa.md`'s syntax-check step to `node --check app.js` directly
4. Update CLAUDE.md's "File structure" section
5. Verify in browser: open the file, every feature still works

## Related

- [[11-ui-ux-frameworks]] — frameworks question is adjacent but
  separable; can be answered independently
- [[02-qa-agent-handoff]] — qa's syntax check simplifies after Tier 1

# Handoff — Bostadskalkyl React pilot, next up: Phase 4 (motion)

_Written 2026-06-24. Next session focus: **Phase 4 — motion** (NumberFlow + Motion)._

## What this project is (1 paragraph)
Migrating the `bostadskalkyl` calculator from zero-build vanilla JS to **React + Vite + TypeScript**, as a **maximum-craft** exercise (NOT job-hunting). Piloting this one tool in `web/`; the live vanilla suite (root `*.html`) is untouched. Full context, locked decisions, stack, phase list, and source→React mapping live in **[bostadskalkyl-react-pilot.md](../bostadskalkyl-react-pilot.md)** — read it first. Memory also has a ⚠ direction-change block in `project_hemma_ui_revamp.md`.

## Progress (phases shipped as one-PR-each)
- Phase 0 scaffold → PR #144 (merged) · Phase 1 pure `calc.ts`+`derive()`+golden tests → #145 (merged) · Phase 2 UI parity → #146 (merged) · **Phase 3 persistence+scenarios → PR #147 (OPEN at handoff)**.
- Diffs/commit messages on those PRs describe exactly what changed — don't re-summarise, read them if needed.

## ⚠ Do this BEFORE starting Phase 4
1. **Verify PR #147 is merged.** Phase 4 depends on Phase 3's store. If not merged, ask the user to merge, then continue.
2. `git checkout main && git pull` → confirm `web/src/store/useStore.ts` exists on main.
3. **Branch first:** `git checkout -b ui/bostadskalkyl-react-phase4`. NEVER edit/commit on `main`.

## Hard-won workflow rules (violating these cost time this run)
- **Branch-first, always.** Phase 1 got committed straight to `main` once → had to move it to a branch and force-push `main` back. Re-check the branch after every merge.
- **One PR per phase, base = `main`, no stacking** (phases depend on each other → wait for the prior PR to merge, then branch off fresh `main`).
- **Commits:** `git commit --author="Claude <claude@anthropic.com>" …` — NO `Co-Authored-By` footer (user preference). PR bodies DO end with the Claude Code footer.
- **Destructive git as separate, explicit commands.** Compound commands containing `rm -rf` / `reset --hard` / `push --force` get permission-denied. Split them; prefer `git branch -f` + `git push --force-with-lease` over `reset --hard`.
- Stage scoped (`git add web .gitignore`), never `git add .` (root has untracked `node_modules/`, screenshots, unrelated work).

## Phase 4 task — motion (the #1 UX gap)
Plan is in the roadmap; the essentials:
- **NumberFlow** on every rendered figure so values animate on change. Biggest impact-per-effort.
- **Motion** (ex-Framer-Motion) for section/derived-row entrance + transitions; gate with `useReducedMotion`.
- Keep it tasteful — the identity is "keep & elevate", not redesign.

### Verified library facts (gathered via Context7 this run — easy to get wrong from memory)
- **Motion**: install `motion` (NOT `framer-motion`); import `{ motion, useReducedMotion, useMotionValue, animate }` from **`motion/react`**.
- **NumberFlow**: install `@number-flow/react`; `import NumberFlow from '@number-flow/react'`; `<NumberFlow value={n} format={{ style:'currency', currency:'SEK', trailingZeroDisplay:'stripIfInteger' }} />`. **`respectMotionPreference` defaults true** (honours `prefers-reduced-motion` automatically). Tune `transformTiming`/`spinTiming`.
- Re-fetch current APIs with Context7 before wiring (see suggested skills).

### Where the figures are (wire NumberFlow here)
- `web/src/components/SummaryColumn.tsx` — `.sum-big` values + `.sum-row-val` rows (all `fmt(...)` calls).
- `web/src/components/InputsColumn.tsx` — `DerivedRow` values (derived box, bank breakdown, stress results).
- `web/src/App.tsx` — mobile-bar figures.
- Note: figures are currently rendered as `fmt(n)` strings (e.g. `"30 623 kr"`). NumberFlow takes a number + `format`/`suffix`; you'll pass the raw number and let NumberFlow format (or use `suffix=" kr"` + decimal style to match the sv-SE spaced thousands).

## Dev / verify loop
- Dev server: `npm run dev --prefix web` → http://localhost:5174/ (runs in background; **it dies between sessions — restart it**; wait-for-up by polling curl, foreground `sleep` is blocked).
- Gates (all must stay green): `npm run build --prefix web` (tsc -b + vite), `npm test --prefix web` (vitest, **36 tests** incl. golden figures — don't break `derive`), `npm run lint --prefix web` (oxlint).
- Visual: Playwright MCP. Baselines captured this run (`react-phase2-*.png`, `react-phase3-*.png`, original `bk-*.png`) are **gitignored**; re-shoot as needed. For Phase 4 also verify the reduced-motion path.

## Conventions / landmines
- **Styling:** global CSS in `web/src/styles/{tokens,global,components,modals}.css`, class names ported **verbatim** from the vanilla `styles.css` for pixel parity. NOT Tailwind, NOT CSS Modules (yet). Keep this approach.
- **Radix** uses the unified package: `import { Dialog } from 'radix-ui'`.
- **localStorage keys must stay identical** to the vanilla app (`bostadskalkyl_session_v1`, `_scenarios_v1`, `_theme`) — data continuity + one-file Supabase swap. Persistence is isolated in `web/src/lib/storage.ts`.
- Repo PreToolUse hook `inspect-script.sh` blocks executing raw script files; npm-script-driven vite/vitest are fine.
- **Deferred (Phase 3b):** drift + savings itemisation modals — not built; driftkostnad is a direct input, savings P&L augmentation = 0.
- **Known minor (Phase 3):** one-frame flash of default inputs before async `hydrate()` restores a saved session. Could be gated on a `hydrated` flag — fine to fix opportunistically.

## Suggested skills
- **context7-mcp** — fetch current Motion (`/websites/motion_dev`) + NumberFlow (`/barvian/number-flow`) docs before wiring; APIs change.
- **verify** — drive the running app (Playwright) to confirm numbers animate AND the `prefers-reduced-motion` path is respected, before opening the PR.
- **code-review** — review the Phase 4 diff for correctness/quality before PR.
- (Playwright MCP tools are already used directly for screenshots/interaction.)

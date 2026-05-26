# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bostadskalkyl is a local-first, no-build-step web calculator for buying a house in Sweden. It models lagfart, pantbrev, amortisation, ränteavdrag, bank rate comparisons, and driftkostnad — with saved scenarios and payoff charts. All data lives in `localStorage`.

## Commands

**Run the app** — open `index.html` directly in a browser (no server needed).

**Run tests** (pure-calc unit tests only):
```
node --test calc.test.js
```

**Run static checks** (HTML integrity gate used by QA and implementation agents):
```
bash .claude/skills/static-checks/static-checks.sh
```

**Orchestrator CLI** (debug / standalone):
```
cd orchestrator
implement-feature "your feature request here"
```

**Orchestrator via MCP** — the preferred path from Claude Code chat; three tools are registered: `implement_feature`, `approve_plan`, `resume_run`.

## Frontend architecture

There is no build step. `index.html` loads six scripts in this fixed order — load order is a hard constraint:

```
calc.js → dom.js → storage.js → modals.js → charts.js → app.js
```

Each file is an IIFE that writes to a single namespace slot on `window.App`. The one-writer rule: **each `window.App.*` key has exactly one file that writes it.**

| File | Namespace | Responsibility |
|---|---|---|
| `calc.js` | `App.calc` | Pure math functions; no DOM |
| `dom.js` | `App.dom` | `set(id, text, cls)` and `val(id)` — the only DOM read/write API |
| `storage.js` | `App.storage` | `localStorage` with versioned keys (`bostadskalkyl_*_v1`) |
| `modals.js` | `App.modals` | Modal state, drift/savings item logic, scenario save/load UI |
| `charts.js` | `App.charts` | Amortisation payoff chart (Chart.js) |
| `app.js` | `App.recalc` | Orchestrates a full recalculation pass; reads all inputs and sets all output DOM nodes |

**`App.recalc()` is the single recalculation entry point.** Every input change calls it. All new derived values must be calculated and set inside `App.recalc()`. All new inputs must be read inside `App.recalc()` using `val()`.

### Input arrays in `app.js`

New inputs must be registered in the correct array or they won't be persisted:
- `CURRENCY_IDS` — inputs with `data-type="currency"` (parsed via `parseFormatted`)
- `NUMBER_IDS` — numeric inputs (parsed via `parseFloat`)
- `TEXT_IDS` — plain text inputs

### CSS rules

- Always use CSS variables from `:root` — never hardcode colours or fonts.
- Only use `DM Sans` or `DM Serif Display`.
- Use `classList.add()` / `classList.remove()` — never assign `el.className`.

### Modal open/close pattern

Every modal must follow this exact pattern:
- Open: `element.classList.add('open')` on the backdrop element
- Close: `element.classList.remove('open')` on the backdrop element
- Every modal must have a click-outside-to-close handler on the backdrop and a `×` close button (`modal-close` class)

### localStorage conventions

- Key names: `bostadskalkyl_<name>_v1` (versioned)
- New keys must be handled in both `readInputs()` and `writeInputs()` in `app.js`

## Orchestrator

The `orchestrator/` subdirectory is a separate Python package (`bostadskalkyl-orchestrator`) that automates the plan → implement → QA → PR pipeline. It is **not** part of the web app.

**Runtime:** Python 3.12, pyenv virtualenv `bk-orchestrator-env`. The MCP server must always be invoked via the full path `/Users/avardon/.pyenv/versions/bk-orchestrator-env/bin/python` — pyenv auto-activation does not apply to MCP subprocess spawns.

**Key modules:**
- `orchestrator/workflow.py` — LangGraph `@entrypoint` with three `@task` units: planning → implementation → QA, with an impl/QA retry loop (up to `max_retries`, default 3). Phase 15 split commit/push/PR into three separate `@task`s for idempotent resumability.
- `orchestrator/agents/planning.py` — calls Claude via Anthropic SDK with structured output (forced tool use) to produce a `PlanResult`
- `orchestrator/agents/implementation.py` — spawns a Claude agent (claude-agent-sdk) to edit files per the plan; supports `implement` and `fix` modes
- `orchestrator/agents/qa.py` — read-only Claude agent that checks the uncommitted diff against the plan; emits PASS or FAIL
- `orchestrator/mcp_server.py` — FastMCP server exposing `implement_feature`, `approve_plan`, `resume_run` to Claude Code
- `orchestrator/config.py` — loads `orchestrator.toml` from the project root; all fields optional with defaults
- `orchestrator/git_ops.py` — deterministic git operations (branch, commit, push, PR creation)
- `orchestrator/run_artifacts.py` — writes plan/implementation/QA outputs to per-run folders in `.orchestrator/runs/`

**Checkpointing:** `AsyncSqliteSaver` writes to `.orchestrator/checkpoints.db`. On mid-run crash, re-run with the same `thread_id` to resume. Completed `@task`s are skipped (their outputs are replayed from the checkpoint).

**Config file:** `orchestrator.toml` at the project root. Controls `max_retries`, model IDs per agent, `human_in_loop` gates (plan approval, branch, impl, QA failure, PR), branch slug length, and PR settings.

**MCP tool flow:**
1. `implement_feature(request)` — starts a workflow, always pauses at plan approval, returns `{status: "awaiting_approval", thread_id, plan}`
2. Show `plan.plan_text` to the user; ask for approval or feedback
3. `approve_plan(thread_id, "yes")` — proceeds through branch creation, implementation (5+ min), QA, commit, push, PR
4. `approve_plan(thread_id, "<feedback>")` — regenerates the plan with the feedback; loop until "yes"
5. `resume_run(thread_id)` — use after fixing an underlying error (push failure, auth issue) to continue without re-running completed tasks

## Agent system

`.claude/agents/` holds the sub-agent definitions used by Claude Code directly (not the orchestrator Python agents):
- `planning.md` — produces structured implementation plans; read-only
- `implementation.md` — executes plans; writes files, self-gates with `static-checks`
- `qa.md` — reviews uncommitted diffs; reports PASS/FAIL; does not fix

The `/implement` slash command (`/.claude/commands/implement.md`) invokes the orchestrator MCP tools via Claude Code chat.

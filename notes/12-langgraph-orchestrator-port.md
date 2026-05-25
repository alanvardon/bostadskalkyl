# LangGraph orchestrator port — session handoff

**Status:** Plan complete, nothing built yet. The full build plan lives at
[orchestrator/PLAN.md](../orchestrator/PLAN.md) — read that first.

## What this is

A pedagogical port of the existing Claude Code coordinator workflow
(`.claude/agents/coordinator.md` + sibling subagents) into a Python
LangGraph orchestrator exposed to Claude Code via an MCP server.

User's stated motivation: **learning production-grade agent orchestration
patterns** that transfer to work, with this project as the testbed. Not
"build the smallest thing that works" — the goal is to internalise the
shape of a real production system.

## Why this came up

User opened the conversation pointing at their existing coordinator and
saying "due to LLMs' non-deterministic nature I believe what I have is not
robust enough." Investigation surfaced concrete fragility:

- Sentinel matching done by LLM with no parser (vibes-based).
- `state.json` mutated by hand through Read → modify → Write.
- Dual-write rule for `progress.log` already drifted in their own logs
  (duplicate `implementation invoked` lines in the tier-2 refactor run).
- Branch-name derivation duplicated between coordinator.md and
  create-feature-branch.md skill.
- Abort path described in prose but never actually exercised — no
  `aborted` stage appears in any past run.
- "Rebuild state from progress.log" is aspirational, no tool exists.

The recurring root cause: **rules enforced by prose telling an LLM what to
do, instead of by code the LLM calls into.** Every step is a coin flip.

## Key decisions locked in

1. **LangGraph Functional API** (not Graph API) for the single-feature
   workflow — their flow is mostly linear with one retry loop. Graph API
   reserved for future parallel-features work.
2. **Pattern C — MCP server** as the Claude Code integration (not slash
   command + bash shell-out). Two tools exposed: `implement_feature` and
   `approve_plan`.
3. **Human-in-loop option 3** — approval handled as a tool call. Workflow
   hits `interrupt()`, returns plan + thread_id to Claude, user replies in
   chat, Claude calls `approve_plan(thread_id, response)` to resume.
4. **pyenv + pyenv-virtualenv** with `.python-version` auto-activation.
   Dedicated env `bostadskalkyl-orchestrator` (separate from the parent
   bostadskalkyl env).
5. **Project lives at `orchestrator/`** subdirectory (not sibling repo).
6. **End state: replace the current Claude Code coordinator workflow** —
   production-quality target, not throwaway.
7. **`pyproject.toml` + `pip install -e .`** (Option A) for dependency
   management — needed anyway for the `implement-feature` CLI entry point.
8. **Drop the custom `progress.log`** in the new system. LangSmith covers
   traces; the SQLite checkpointer covers state. No third overlapping store.

## What's been done

- The 12-phase plan written to [orchestrator/PLAN.md](../orchestrator/PLAN.md).
- An empty `orchestrator/` directory created. **Nothing else.**
- No code, no env, no dependencies, no API keys set up yet.

## Where to pick up

Phase 0 of the plan. Verify pyenv-virtualenv is installed and the shell
init lines are in `~/.zshrc`, then walk the user through the setup steps.
Stop at the hello-Claude sanity check and confirm it works before moving
on. The plan is deliberately sequenced — each phase has a "run this and
see X" gate and the user has agreed not to skip ahead.

## Hard-won context that's NOT in PLAN.md

- **The user explicitly wants to be taught, not handed solutions.** They
  asked questions throughout ("what does X mean?", "is it not possible to
  use Y?") and the conversation worked best when each answer included
  reasoning + trade-offs, not just the recommended path. Maintain that mode.
- **They have an existing parent virtualenv on bostadskalkyl/.** We agreed
  to leave it alone and create a dedicated child env for orchestrator/.
  Auto-activation works via nested `.python-version` files.
- **`.claude/hooks/block-secrets-pretool.sh` actively scans Write/Edit
  payloads** for realistic-looking key prefixes. It blocked one of my
  writes because the example `.env` snippet contained an Anthropic-style
  placeholder prefix. The plan now uses descriptive text placeholders.
  When generating docs, .env templates, or example configs, always use
  generic placeholder text like `<your API key>`, never anything that
  looks like a real key fragment.
- **The user uses pip not uv** despite uv being faster. Don't suggest
  switching; they know the trade-off and chose pyenv+pip for familiarity.
- **The plan deliberately defers parallelism, cost caps, custom retries,
  and migrating old `.workflow/` runs.** These came up in discussion and
  were explicitly pushed out of the first build pass.
- **User's existing workflow runs sit under `.workflow/`.** They contain
  real PR history (e.g.
  [.workflow/refactor/tier-2-modular-split-calc-dom-storage-modals-chart/](../.workflow/refactor/tier-2-modular-split-calc-dom-storage-modals-chart/))
  and are worth reading to understand what the new orchestrator needs to
  replicate behaviourally.

## Open design questions surfaced but not decided

These will come up during the build and the user should answer them in
context, not up front:

1. Planning prompt on revision — append feedback to original request
   (current behaviour) or always fresh? Surfaces in Phase 8.
2. QA failures — interruptible (surface to user) or always auto-retry
   3 times (current behaviour)? Surfaces in Phase 7.
3. Long-running implementation tasks — does Claude Code need MCP progress
   notifications? Surfaces in Phase 11.
4. Worktree-per-feature — design now for future parallelism or retrofit
   later? Surfaces if/when parallel work is tackled.

## Tone calibration

- Pedagogical, not prescriptive.
- Concrete examples over abstract concepts.
- Honest trade-offs (don't oversell the framework or the SDK).
- Short responses for direct questions; longer with structure when
  walking through a concept.
- User likes file references in markdown link format. Watch for the
  IDE's `<ide_opened_file>` hints but don't over-index on them.

## Suggested skills

Next session should likely invoke:

- **claude-api** — once Phase 1 begins, the user will be calling the
  Anthropic SDK directly. The skill covers structured outputs via
  tool-use, prompt caching, model selection (Haiku for cheap tests,
  Sonnet for planning/QA). Almost certainly relevant from Phase 1 onward.
- **update-config** — Phase 12 adds an `.mcp.json` to register the
  orchestrator server with Claude Code. The skill covers settings.json
  mechanics and the restart-required gotcha.
- **fewer-permission-prompts** — once the user is actively running the
  CLI (Phase 10) and the MCP inspector (Phase 11), there will be
  repeated bash invocations worth allowlisting.
- **verify** — at the end of Phases 6, 7, 10, and 12, verify the
  orchestrator actually does what it's supposed to on a tiny real
  feature against this codebase.

## Related notes

- [[10-refactor-out-of-single-html]] — context for the existing modular
  split that the orchestrator will be implementing changes against.
- [[08-logging-tightening]] — earlier thinking on the coordinator's
  logging. Some of those concerns are what this port is solving.

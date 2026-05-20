# Tightening progress logging — agent vs hook

**Verdict:** Don't add a logging *agent*. Use a **hook** (or a small
shared library) to enforce the format. Mechanical work doesn't need
fresh context or a different model.

## Current state

Each agent appends two lines to `PROGRESS_LOG_FILE`:
- `<iso-ts> <agent> invoked`
- `<iso-ts> <agent> emitted — <sentinel>`

The coordinator writes its own `confirmed`, `stage`, `halt` entries
after parsing agent output. Format is enforced by *copy-pasting the same
echo pattern* into every agent file — easy to drift.

## Why not an agent

Apply the four-reasons-to-spawn-an-agent heuristic (same one used in
[[01-pr-agent-handoff]]):

| Criterion | Logging? |
|---|---|
| Needs fresh context | No |
| Needs different tools | No |
| Needs a different model | No |
| Needs parallelisation | No |

Zero of four. Logging is a one-line side effect; making it a separate
agent adds latency and indirection without buying anything.

## Two viable approaches

### A. PostToolUse / Stop hook normalises the log

A hook reads each agent's output and writes the canonical log lines.
- Pro: agents stop carrying log boilerplate
- Con: hooks see raw tool I/O; mapping that back to "invoked vs emitted"
  is fragile

### B. Shared snippet referenced from every agent

A single fragment like `.claude/snippets/logging.md` that each agent
includes by reference, plus a tiny `bin/log-line` shell helper:

```bash
bin/log-line "$PROGRESS_LOG_FILE" "qa" "invoked"
bin/log-line "$PROGRESS_LOG_FILE" "qa" "emitted — QA RESULT: PASS"
```

- Pro: one source of truth for format, agents stay simple
- Pro: works with the existing agent shape — no harness change
- Con: still requires each agent to *call* the helper (vs. automatic)

**Recommended:** B first (low-risk, immediate consistency win). Move to
A only if log integrity ever becomes load-bearing for automation.

## What "tighter" should actually mean

Define this before building anything:
- Single canonical timestamp format (already `YYYY-MM-DDTHH:MM:SSZ`)
- One file per workflow run, named `.workflow/<branch>/progress.log`
- A documented set of allowed event types
  (`invoked | emitted | confirmed | stage | halt | …`)
- Maybe: a `bin/log-tail` that pretty-prints the log for humans

## Rough plan

1. Audit current log line variants across `qa.md`, `pr.md`,
   `implementation.md`, `coordinator.md` — list every echo
2. Choose the canonical event vocabulary
3. Add `bin/log-line` helper
4. Replace inline echoes in each agent with calls to the helper
5. (Optional later) add `bin/log-tail` for humans

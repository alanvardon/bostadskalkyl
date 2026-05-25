# Orchestrator engineering notes

A running log of non-obvious decisions, gotchas, and patterns built up
while implementing the orchestrator. Things you'd want to know when
debugging, extending, or onboarding someone else — but that aren't
visible from a casual read of the code.

Updated incrementally as new phases land. If you find yourself surprised
by something while debugging, add it here.

---

## Async / sync boundaries

### `asyncio.to_thread` bridges sync subprocess into async @task

LangGraph requires `@task`-decorated functions to be `async`, but
`subprocess.run` is blocking. Calling it directly inside an `async def`
freezes the event loop until the command exits — fine for one task at a
time, fatal once anything else needs to run concurrently (LangSmith
streaming, MCP progress notifications, etc.).

The fix is `asyncio.to_thread(sync_fn, *args)` — it runs the sync
function in a worker thread, releasing the event loop. See
[workflow.py: create_branch_task](orchestrator/workflow.py).

### Sync function in `git_ops.py`, async @task in `workflow.py`

The deterministic operations (branch creation, eventually commit/PR) are
written as plain sync functions in `git_ops.py`. The `@task` wrapper
lives in `workflow.py` and bridges them to async via `to_thread`.

Why the split:
- `git_ops.py` is testable in isolation without any LangGraph or asyncio
  machinery. `python -m orchestrator.git_ops "title" feature` exercises
  the real subprocess plumbing without the framework.
- `workflow.py` owns all the framework integration in one place. The
  sync functions don't know they're running inside LangGraph.

If you ever want to call `create_branch` from a non-LangGraph context
(a one-off script, a test, a different orchestrator), you import the
sync function. The `@task` is just decoration on top.

---

## Crash recovery

### Default Ctrl-C poisons the checkpoint

`asyncio.run()` catches SIGINT and raises `CancelledError` *inside* the
running coroutine. LangGraph catches that and writes the workflow's task
as `[errored]` — a *terminal* failure state. Resume then has nothing
left to pick up.

Fix in [crash_demo.py](orchestrator/crash_demo.py): install a SIGINT
handler that calls `os._exit(130)`. That terminates the process without
running any Python cleanup, leaving the checkpoint at the last
successful task — exactly the state resume expects.

Real production crashes (OOM kill, SIGKILL, hardware failure, container
termination) also skip cleanup. `os._exit` is the more faithful crash
simulation.

### Resume with `ainvoke(None, ...)`, not the original input

```python
await workflow.ainvoke(None, config={"configurable": {"thread_id": "..."}})
```

The `None` is the signal to LangGraph: continue an existing thread from
its last checkpoint, don't start a new run. A non-None input always
starts a new execution on that thread_id.

Caveat: `ainvoke(None, ...)` is *primarily* the resume signal for
`interrupt()` pauses (Phase 8). For crash recovery on the Functional
API, the @task cache also kicks in when re-invoking with the original
input — but `None` is the cleaner intent.

### `state.values` is always `None` in the Functional API

`inspect_state` originally printed `state.values` and it was always
`None`, which looked broken. It isn't — `state.values` is a StateGraph
concept (the shared state dict between nodes). The Functional API
doesn't have one. Task results live in `state.tasks[].result`.

Mental model:
- StateGraph: shared state, mutated by nodes → inspect `values`
- Functional API: regular functions, returns flow through awaits →
  inspect `tasks`

---

## Serialization / durability

### `_ALLOWED_MSGPACK_MODULES` registers types that cross the disk boundary

Anything a `@task` returns gets serialized into the SQLite checkpoint.
Built-in types (str, int, dict, datetime) are wired in automatically.
Custom Pydantic models — `PlanResult`, soon `ImplementationResult`,
`QaResult` — need to be on the allowlist at the top of `workflow.py`.

Today: unregistered types log a deserialization warning. Tomorrow
(strict-mode default): they refuse to load, breaking resume entirely.

This is the same pickle-style risk: deserializing arbitrary classes
means importing arbitrary modules. The allowlist is the security gate.

**Action when adding a new @task that returns a custom model**: append
`(module_path, class_name)` to `_ALLOWED_MSGPACK_MODULES`.

### Renaming or moving a Pydantic model breaks old checkpoints

Old serialized blobs hard-code the class's full module path. If you
rename `PlanResult` to `PlanSpec`, or move it to `orchestrator.models`,
checkpoints written before the change can't be loaded. Either keep an
alias at the old name, or wipe `.orchestrator/checkpoints.db`. For a
personal tool, wiping is fine.

### The serde override is post-construction

`AsyncSqliteSaver.from_conn_string` doesn't accept a `serde` kwarg, so
we override `.serde` and `.jsonplus_serde` after the saver yields. Both
need swapping — `serde` is the public attribute, `jsonplus_serde` is an
internal one the SQLite saver uses on some write paths. See
[workflow.py](orchestrator/workflow.py).

---

## Workflow construction

### `@asynccontextmanager build_workflow()` exists because of the checkpointer lifecycle

`@entrypoint(checkpointer=...)` captures the checkpointer at *definition
time*. But `AsyncSqliteSaver` is itself an async context manager — its
connection only exists between `__aenter__` and `__aexit__`. So the
workflow must be defined *inside* the `async with` block, which means a
factory pattern: callers do `async with build_workflow() as workflow`.

You can't have a module-level `workflow` decorated function with an
AsyncSqliteSaver. Tried it; the connection isn't open yet.

### `load_dotenv()` must run before any LangSmith import

LangSmith reads `LANGSMITH_*` env vars at module load time. If you import it
before `load_dotenv()` runs, it captures empty values and won't pick up
later changes. Top of `main.py` / `crash_demo.py` puts `load_dotenv()`
above the LangGraph/LangSmith imports for this reason.

---

## LLM patterns

### Tool-use-as-structured-output replaces sentinel parsing

Instead of asking the model to emit `PLAN COMPLETE: title=X` as free
text and parsing the string, declare a "tool" whose `input_schema` matches
the desired Pydantic model and force `tool_choice` to that tool. The
model's "tool call" *is* the structured output, parsed and validated by
Pydantic. See [planning.py](orchestrator/agents/planning.py).

This is the single biggest robustness win over the old coordinator
contract. There is no parse failure mode.

### Two structured-output mechanisms — single call vs agent loop

| Where | Mechanism | Why |
|---|---|---|
| Single LLM call (planning, QA) | Force `tool_choice` on a fake tool | One round-trip, model must respond with the tool call. Direct. |
| Agent loop (implementation) | In-process SDK MCP tool the agent calls when done | Agent runs many turns first (read files, edit, iterate). Forcing tool_choice on every turn would break the loop. Giving the agent a tool to call at the end lets it work freely, then signal completion. |

The conceptual win is identical (no sentinel parsing) but the mechanism
differs because the agent loop is a different shape. See
[implementation.py](orchestrator/agents/implementation.py).

### Capturing agent-loop output via closure

The MCP tool is in-process — same Python process, same address space —
so the tool handler can write into a `captured: dict` in the enclosing
function's closure. After `query()` returns, the orchestrator reads
`captured` to get the structured output back.

```python
captured: dict[str, str] = {}

@tool("emit_result", "...", {"summary": str, ...})
async def emit(args):
    captured["summary"] = args["summary"]
    return {"content": [{"type": "text", "text": "ok"}]}
```

This is only safe because the SDK MCP server runs in-process. If you
ever move to an external MCP server (separate subprocess), this pattern
breaks — you'd need IPC.

### `mcp__<server>__<tool>` is the allowed-tools naming

When you pass an `mcp_servers` dict to `ClaudeAgentOptions`, the tools
inside each server are exposed to the agent as `mcp__<server>__<tool>`.
The `allowed_tools` list uses that full prefixed name, e.g.
`"mcp__orchestrator__emit_implementation_result"`. The SDK docstrings
sometimes show bare tool names — go by the prefixed form for safety.

### `permission_mode="acceptEdits"` runs the agent unattended

Without it, the agent stops at every edit to ask for approval, which
breaks an orchestrator's whole point. With it, the agent edits freely
within the bounds of `allowed_tools` and project-level deny rules in
`.claude/settings.json` (which still apply via `setting_sources=["project"]`).

The deny list is the safety floor. Don't rely on `acceptEdits` to keep
the agent away from `.env` or secrets — those need explicit denies in
settings.

### The agent loop has no implicit turn budget

`ClaudeAgentOptions` defaults `max_turns=None`, which means the agent
can run indefinitely. For a runaway agent (stuck retrying, hallucinating
needed work, looping on a non-existent file) this is unbounded API
spend. Currently left unset in `implement()` to avoid premature cutoffs
while behaviour is unknown. Once typical implementation runs have been
observed, set `max_turns` to ~1.5× the observed P95 — high enough not
to false-cut, low enough to bound the worst case.

There's also `max_budget_usd` on the same options — same idea, denominated
in money. Either or both is a reasonable safety net.

### If the agent doesn't call `emit_implementation_result`, the task fails

The closure-captured holder dict is the *only* path for the agent's
structured output to reach the orchestrator. If the agent finishes its
turn budget, decides to stop early, or misreads the prompt and never
calls the tool, `captured` stays empty and `implement()` raises
`RuntimeError`. Planning and create_branch are still checkpointed, so
re-running picks up from implementation — but the implementation work
needs to happen again from scratch.

If you see this fail in practice, the fix is almost always in the
system prompt: make the requirement to call the tool more emphatic,
or restructure the prompt so the tool call is the natural endpoint.

---

## Vestigial code (to clean up eventually)

### `step_two_task` in workflow.py

A Phase 4 placeholder that simulated a long-running task so `crash_demo`
had a window to Ctrl-C during. Phase 6b's `implementation_task` provides
a much longer crash window (minutes vs. 5 seconds), so `step_two_task`
is no longer wired into the entrypoint chain. The @task definition still
exists in `workflow.py` so this file's history is preserved in one
glance — delete when convenient.

---

## Path resolution

### `REPO_ROOT` is resolved from `__file__`, not process cwd

```python
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
```

Means git commands run in the right directory whether you launch the
orchestrator from `orchestrator/`, the project root, a different shell,
or — critically — as an MCP subprocess (Phase 11) where the cwd is
controlled by Claude Code's `.mcp.json`, not by you.

Don't use `os.getcwd()` for anything that needs to find the repo.

---

## User-facing output

### CLI is a *debug surface*, not the production UX

`main.py` and (eventually) `cli.py` print to stdout because you, the
developer, are the user there. In production, the user is in the Claude
Code chat — they never see the orchestrator's stdout.

Production output goes through MCP tool returns (structured data, the
LLM formats it) plus MCP progress notifications during long tasks.
Don't add print statements to tasks expecting users to read them.

### Things the orchestrator owns vs things the LLM owns

| Output | Owner |
|---|---|
| What happened (the plan, PR URL, QA result) | Orchestrator — structured return |
| How to tell the user about it | LLM — prose in chat |
| Progress during long tasks | Orchestrator — MCP progress events |
| Internal observability for the dev | LangSmith |
| Errors | Orchestrator — structured; LLM explains them |

---

## Maintenance

This file should grow as phases land. When something surprises you while
debugging, write it down here while it's fresh. Empty sections are fine
— they signal "we haven't hit this yet" rather than "we don't care."

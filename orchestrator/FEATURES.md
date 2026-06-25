# Orchestrator — In-Depth Feature Guide

An exhaustive, example-driven reference for the orchestrator, written against the code as
it stands (**`WORKFLOW_VERSION 2.8.0`**). Every capability is catalogued and explained
with a concrete example — the marquee features and the robustness machinery alike
(idempotent git, crash recovery, schema versioning, cost accounting, the scripted-QA gate,
slug clamping, `--force-with-lease` resume-safety, transcript error recovery, …).

**How to read this.** [§0](#0-a-worked-run-end-to-end) is a full run narrated end to end
with the real JSON and console output each feature produces — read it first and the rest
of the guide is "here is each of those pieces in depth." Then groups **A–L** cover every
feature: each gets **What it is**, a **worked example**, **How to use it**, and **Why it
exists**. The [feature index](#feature-index) lists all ~80 up front.

Companion docs (under [.misc_notes/](.misc_notes/)):
[ARCHITECTURE.md](.misc_notes/ARCHITECTURE.md) (how it runs) ·
[WRITEUP.md](.misc_notes/WRITEUP.md) (narrative) · [NOTES.md](.misc_notes/NOTES.md) (gotchas) ·
[README.md](README.md) (install) · [CHANGELOG.md](CHANGELOG.md) (phase history).

---

## Feature index

| Group | Features |
|-------|----------|
| **A · Interfaces** | [Debug CLI](#a1--the-debug-cli) · [MCP server](#a2--the-mcp-server) · [Per-invocation overrides](#a3--per-invocation-overrides--precedence) |
| **B · Lifecycle** | [Plan-approval loop](#b1--plan-approval--the-approve_plan-loop) · [Resume](#b2--resume-from-failure) · [Cancel](#b3--cancel-between-tasks) · [Background + poll](#b4--background-runs--run_status) · [Idempotency keys](#b5--idempotency-keys) · [Auto-approval](#b6--auto-approval--the-auto_approved-event) · [Human-gate catalogue](#b7--the-full-catalogue-of-human-gates) · [Growable retry budget](#b8--growable-retry-budget) · [Resume-compat gates](#b9--resume-compatibility-gates) · [Empty-decomposition guard](#b10--empty-decomposition-guard) · [Empty-diff guard](#b11--empty-diff-guard) |
| **C · Durability** | [SQLite checkpointing](#c1--sqlite-checkpointing--task-replay) · [Crash recovery](#c2--crash-recovery) · [Serde allowlist](#c3--the-serde-allowlist) · [Schema versioning](#c4--result-schema-versioning) · [`WORKFLOW_VERSION`](#c5--workflow_version-discipline) |
| **D · Engine** | [Functional API](#d1--langgraph-functional-api) · [Deterministic/cognitive split](#d2--deterministic-vs-cognitive-split) · [Two model-call styles](#d3--two-model-call-styles--fail-closed) · [async↔sync bridge](#d4--asyncsync-bridging) · [Portable paths](#d5--portable-path-resolution) |
| **E · Config-as-data** | [Declarative pipeline](#e1--the-declarative-v2-pipeline) · [Flow parser](#e2--the-flow-string-parser) · [Pluggable steps](#e3--pluggable-steps) · [Locked rails](#e4--locked-git-rails) · [`summarize` required](#e5--summarize-required) · [v1 rejection](#e6--v1-config-rejection) · [Unknown-key rejection](#e7--unknown-key-rejection) · [`orchestrator.toml`](#e8--orchestratortoml-full-reference) · [Model/tool precedence](#e9--modeltool-precedence-chain) · [Prompt overrides](#e10--prompt-overrides--frontmatter) |
| **F · Planning** | [Planning](#f1--planning) · [Decomposition (Ralph)](#f2--task-decomposition--the-ralph-loop-lineage) · [Complexity budget](#f3--complexity-based-task-budgeting) · [Testability tagging](#f4--per-task-testability-tagging) · [TDD-aware decompose](#f5--tdd-aware-decompose) |
| **G · Build & QA** | [Retry block](#g1--the-retry-block) · [Implementation agent](#g2--the-implementation-agent) · [Per-task station](#g3--the-per-task-station) · [LLM QA gate](#g4--the-llm-qa-gate) · [Scripted-QA gate](#g5--the-scripted-qa-gate) · [Whole-diff QA stage](#g6--the-whole-diff-qa-stage) · [`on_exhausted`](#g7--on_exhausted-policies) |
| **H · TDD station** | [Red-green walkthrough](#h1--the-red-green-station-step-by-step) · [Separate author](#h2--separate-test-author) · [Diff-gate freeze](#h3--the-diff-gate-test-freeze) · [Coverage critic](#h4--coverage-critic-on-haiku) · [Red-review](#h5--red-review--re-author) · [Degrade](#h6--born-green--untestable-degrade) · [Autonomous TDD](#h7--autonomous-tdd) · [Testability gate](#h8--testability-gate) · [Manual checks](#h9--manual-checks) |
| **I · Autonomy** | [Autonomous mode](#i1--fully-autonomous-mode) · [Ceilings](#i2--wall-clock--cost-ceilings) · [Unpriced warning](#i3--unpriced-model-warning) |
| **J · Observability** | [Token/cost accounting](#j1--token--cost-accounting) · [Audit log](#j2--the-audit-log) · [Run log](#j3--the-run-log-runsjsonl) · [Run-artifacts](#j4--the-run-artifacts-folder) · [LangSmith](#j5--langsmith-cost-in-trace) · [Transcript recovery](#j6--transcript-error-recovery) · [CLI heartbeat](#j7--cli-heartbeat--task-titles) · [MCP progress](#j8--mcp-progress--live-stage) |
| **K · Git** | [The rails](#k1--the-git-rails) · [Slug clamp](#k2--slug-length-clamp) · [Auto-rebase/force-lease](#k3--auto-rebase--force-with-lease) · [PR draft/reviewers](#k4--pr-draft--reviewers) · [Pre-hooks](#k5--pre-hooks) |
| **L · Errors** | [Taxonomy](#l1--the-three-class-taxonomy) · [Billing reclass](#l2--billing-error-reclassification) · [Status vocabulary](#l3--status-vocabulary) |

---

## 0 · A worked run, end to end

This is one run, from request to merged PR, with the actual outputs each step emits. Every
later section is a deep-dive on one piece of this.

**1. Start it** (from chat, the MCP path). Claude calls:

```python
implement_feature(request="add a tooltip showing what LTV means")
```

Planning + decomposition run (~10s), then the workflow hits its first `interrupt()` and the
tool returns:

```json
{
  "status": "awaiting_approval",
  "thread_id": "run-7f3a9b1c",
  "plan": {
    "title": "Add an LTV tooltip",
    "type": "feature",
    "plan_text": "Add an info icon next to the LTV figure in the results panel...\n..."
  },
  "tasks": [
    {"id": "add-tooltip-markup", "title": "Add tooltip markup + icon", "testable": false,
     "acceptance_criteria": "An info icon renders next to the LTV row..."},
    {"id": "wire-tooltip-copy", "title": "Wire the LTV explanation copy", "testable": true,
     "acceptance_criteria": "Hovering the icon shows the text 'Loan-to-value...'"}
  ],
  "ask": "Proceed with this plan? Reply 'yes', or send feedback to revise.",
  "next": "Show the plan_text to the user. Ask whether they approve..."
}
```

**2. Approve it** — in the chat, Claude shows the plan, the user says yes, Claude calls
`approve_plan` with `background=True` because the next leg is long:

```python
approve_plan(thread_id="run-7f3a9b1c", response="yes", background=True)
# → {"status": "started", "thread_id": "run-7f3a9b1c", "next": "Poll run_status..."}
```

**3. Poll it** — every ~20s Claude calls `run_status` and prints the update:

```json
{"status": "running", "thread_id": "run-7f3a9b1c", "elapsed_seconds": 84.2,
 "stage": "implementation",
 "last_event": {"event_type": "task_start", "task_name": "implementation",
                "timestamp": "2026-06-23T10:32:40.118Z"},
 "next": "Still working. Poll run_status again in ~20s."}
```

**4. It finishes** — the final poll returns the terminal dict:

```json
{"status": "succeeded", "thread_id": "run-7f3a9b1c",
 "branch": "feature/add-an-ltv-tooltip",
 "pr_url": "https://github.com/you/bostadskalkyl/pull/42",
 "qa": {"result": "PASS"},
 "usage": {"total": {"input_tokens": 258050, "output_tokens": 12930, "cost_usd": 0.903}}}
```

**5. What it left on disk** — the same run via the CLI prints a banner, and either path
writes a full evidence trail:

```text
============================================================
Workflow complete
============================================================
  Branch:    feature/add-an-ltv-tooltip
  PR:        https://github.com/you/bostadskalkyl/pull/42
  thread_id: run-7f3a9b1c
============================================================

============================================================
Token usage
============================================================
  planning              12,340 in  /     820 out  ($0.049)
  decompose              8,210 in  /     410 out  ($0.031)
  implementation       180,400 in  /   9,200 out  ($0.654)
  qa                    42,100 in  /   1,900 out  ($0.155)
  summarize             15,000 in  /     600 out  ($0.014)
------------------------------------------------------------
  TOTAL                258,050 in  /  12,930 out  ($0.903)
============================================================
```

```text
.orchestrator/
├── runs.jsonl                         # 2 lines: run start + run_end rollup
├── audit.log                          # ~20 JSONL events for this thread
└── runs/run-7f3a9b1c-feature-add-an-ltv-tooltip/
    ├── plan.md  decomposition.md  qa.md  summary.md  usage.json
    └── task-02-wire-tooltip-copy/
        ├── test-author/   (authored suite + RED run + freeze hash)
        └── impl/attempt-1/  (full test run + freeze MATCH/MISMATCH)
```

Keep this run in mind; the rest of the guide explains every box.

---

## A · Interfaces & invocation

Two doors, one engine. Both build the LangGraph config `{"configurable": {"thread_id": …}}`
and drive the identical compiled workflow.

### A1 · The debug CLI

**What.** A one-shell-command entry point (the `implement-feature` console script, or
`python -m orchestrator.cli`) that runs the whole pipeline synchronously and prints
progress to stderr/stdout. See [orchestrator/cli.py](orchestrator/cli.py).

**Example.**
```bash
implement-feature "add a tooltip showing what LTV means"
# thread_id: cli-f3a9b1c2
# request:   add a tooltip showing what LTV means
#   done: verify_clean_tree (0s)
#   done: planning (4s)
#   done: decompose (3s)
#   --- Plan for approval (thread_id: cli-f3a9b1c2) ---
#   Add an info icon next to the LTV figure...
#   Proceed? Reply 'yes'.
#   > yes
#   done: create_branch (0s)
#   ... running implementation (45s elapsed)
#   done: implementation (132s)
#   ...
```

| Flag | Default | Effect |
|------|---------|--------|
| `--no-approve-plan` | config decides | Skip the plan-approval pause; run straight to PR. |
| `--base-branch <name>` | config / `main` | Override the PR base branch for this run. |
| `<request>` | `"add a dark mode toggle"` | Trailing text (`argparse.REMAINDER`); **flags must precede it**. |

```bash
# Unattended, against a release branch:
implement-feature --no-approve-plan --base-branch release/2.0 "bump the footer year to 2026"
```

**How — env vars.** `ORCHESTRATOR_DEBUG=1` prints the full traceback on failure;
`HEARTBEAT_INTERVAL=30` slows the "still running" pings.

**Why.** It's a *debug surface*, not the production UX — for answering "is the orchestrator
itself broken?" without the Claude Code + MCP indirection. In production the user lives in
chat and never sees this stdout, so don't add `print`s expecting users to read them.

### A2 · The MCP server

**What.** The production interface: five MCP tools exposed to Claude Code, all keyed by
`thread_id`. See [orchestrator/mcp_server.py](orchestrator/mcp_server.py).

| Tool | Purpose | Signature |
|------|---------|-----------|
| `implement_feature` | Start a run | `(request, approve_plan=None, base_branch=None, idempotency_key=None, background=False)` |
| `approve_plan` | Reply to a plan/gate | `(thread_id, response, background=False)` |
| `resume_run` | Recover a failed run | `(thread_id, force=False, background=False)` |
| `cancel_run` | Signal cancellation | `(thread_id)` |
| `run_status` | Poll a backgrounded run | `(thread_id)` |

**Example** — the canonical loop a chat agent runs (from `approve_plan`'s own docstring):

```python
result = await implement_feature("add a dark-mode toggle")
while result["status"] == "awaiting_approval":
    # show result["plan"]["plan_text"] to the user, collect their reply
    result = await approve_plan(result["thread_id"], reply)
# result["status"] is now "succeeded" / "failed" / "no_changes"
```

**Why the docstrings are long.** A tool's docstring *is part of the prompt* — Claude reads
it to decide whether/when/how to call the tool. Each is written like a system prompt (note
the explicit "Do NOT call this again to retry — that starts a fresh workflow"). **Launch
landmine:** start the server via the full env-scoped Python path
(`/Users/.../bk-orchestrator-env/bin/python -m orchestrator.mcp_server`), never the bare
`python` shim — pyenv auto-activation doesn't apply to subprocesses.

### A3 · Per-invocation overrides & precedence

**What.** A handful of settings can be set per run without editing config, resolved
**flag/kwarg → env var → `orchestrator.toml` value**. Each override defaults to `None`,
which is the signal to fall through to the next source. See `apply_overrides` in
[orchestrator/config.py](orchestrator/config.py).

**Example.** Three equivalent ways to skip the plan pause for one run:

```bash
implement-feature --no-approve-plan "..."          # 1. CLI flag
ORCHESTRATOR_APPROVE_PLAN=false implement-feature "..."   # 2. env var
```
```python
implement_feature("...", approve_plan=False)        # 3. MCP kwarg
```

Boolean env vars accept `true/1/yes/on` and `false/0/no/off`; anything else is a load-time
error (`ORCHESTRATOR_APPROVE_PLAN='maybe' is not a valid boolean`). The override surface:
`ORCHESTRATOR_APPROVE_PLAN`, `ORCHESTRATOR_BASE_BRANCH`, `ORCHESTRATOR_FULLY_AUTONOMOUS`,
`ORCHESTRATOR_AUTONOMOUS_MAX_SECONDS`, `ORCHESTRATOR_AUTONOMOUS_MAX_COST_USD`.

**Why.** CI wants `--no-approve-plan` and a per-job base branch without a committed config
edit; a one-off experiment wants an env var; the durable default lives in TOML. The
precedence keeps all three honest.

---

## B · Run lifecycle / control plane

The `thread_id` is the run's identity — the checkpoint-DB key, the run-artifacts folder
name, and the handle for everything below.

### B1 · Plan-approval & the `approve_plan` loop

**What.** Before any code is written, the workflow pauses (a LangGraph `interrupt()`) and
returns an `awaiting_approval` dict carrying the plan *and* the decomposed task list. You
show it, the user replies, you call `approve_plan`.

**Example** — `"yes"` proceeds; any other reply is **feedback** that re-plans *and*
re-decomposes, returning another `awaiting_approval`:

```python
r = implement_feature("add a tooltip")            # → awaiting_approval
r = approve_plan(r["thread_id"], "make it keyboard-accessible too")  # → awaiting_approval (revised)
r = approve_plan(r["thread_id"], "yes")           # → proceeds to branch/impl/QA/PR
```

**Why re-plan on any non-"yes".** The plan and its decomposition are generated as a pair;
feedback regenerates both so they can never drift. And `interrupt()` makes the pause
*durable* — it survives a process restart and resumes typed, unlike an ad-hoc stop-and-wait.

### B2 · Resume from failure

**What.** `resume_run(thread_id)` continues a failed run from its last checkpoint:
completed `@task`s replay from cache, and **only the failed task and anything downstream
re-run**. Use it *after* fixing the underlying cause.

**Example** — `gh` wasn't authenticated, so `pr_create` failed:

```python
r = approve_plan("run-7f3a9b1c", "yes")
# → {"status": "user_action_required",
#    "error": "gh pr create failed: not authenticated",
#    "action": "Run `gh auth login`, then call resume_run."}
# ...you run `gh auth login`...
resume_run("run-7f3a9b1c")
# → {"status": "succeeded", "pr_url": "...", ...}
#   commit + push are served from cache; only pr_create re-runs.
```

| Param | Default | Effect |
|-------|---------|--------|
| `force` | `False` | A cancelled thread is refused (`refused_cancelled`) unless `force=True`, which clears the cancel flag first. |
| `background` | `False` | Run the recovery leg as a tracked task; poll `run_status`. |

**Why — the headline reliability feature.** `commit`, `push`, `pr_create` are three
*independent* idempotent `@tasks`. A real dogfood run committed locally then failed before
`git push`; the old monolithic commit+push+PR task re-ran on retry, hit its empty-tree
guard, and raised "no changes to commit" — work done, unrecoverable. Splitting them made
the partial state resumable. **`@task` checkpoint granularity *is* resume granularity** —
if you need partial recovery, you must size your tasks to it.

### B3 · Cancel between tasks

**What.** `cancel_run(thread_id)` drops a marker the workflow checks **between `@task`
boundaries**; it exits cleanly as `status="cancelled"`.

**Example.**
```python
cancel_run("run-7f3a9b1c")
# → {"status": "cancellation_signalled",
#    "next": "The workflow will exit at the next task boundary..."}
```

The currently-executing task finishes first (the Agent SDK can't be interrupted mid-task),
and **spent tokens are not refunded** — "cancel" means "stop after the current task," not
"abort instantly." There are deliberately **no cancel checks once the commit lands** —
aborting then would leave a half-shipped branch. Resume a cancelled thread with
`resume_run(thread_id, force=True)`. See [orchestrator/cancellation.py](orchestrator/cancellation.py).

### B4 · Background runs & `run_status`

**What.** `implement_feature` / `approve_plan` / `resume_run` accept `background=True`:
they kick the run off as a tracked asyncio task and return `{"status": "started"}` at once.
The chat then polls `run_status(thread_id)` (~every 20s).

**Example** — the poll loop and the three shapes it can return:

```python
r = approve_plan(tid, "yes", background=True)        # → {"status": "started"}
while r["status"] in ("started", "running"):
    sleep(20)
    r = run_status(tid)
    # running:  {"status":"running","stage":"qa","elapsed_seconds":210.4,"last_event":{...}}
    # paused:   {"status":"awaiting_approval","kind":"red_review","red_output":"...",...}
    # done:     {"status":"succeeded","pr_url":"...",...}
```

**Why & the lock-aware detail.** The post-approval leg runs 5+ minutes during which Claude
Code chat renders *nothing* (MCP progress notifications are advisory per spec). A live run
holds the SQLite **write-lock**, so `run_status` reads progress from the filesystem
audit-log tail (a lock-free read) and the final result from the in-memory `_BG_RUNS`
registry — touching `aget_state` only when no task is live (e.g. after a server restart).
A strong ref is held so a 5-min run isn't garbage-collected between tool calls.

### B5 · Idempotency keys

**What.** Pass `idempotency_key` to `implement_feature`. The first call claims it; a second
call with the **same key** returns the *existing* run with `replayed: true` instead of
starting a second. Keys match `[A-Za-z0-9._-]+`, ≤128 chars. See
[orchestrator/idempotency.py](orchestrator/idempotency.py).

**Example** — a CI job that might fire twice:

```python
implement_feature("regenerate the changelog", idempotency_key="ci-build-4821")
# first call:  starts run-aaa, returns awaiting_approval
# retry/double-fire with the SAME key:
#   → {"status": "awaiting_approval", "thread_id": "run-aaa", "replayed": true, ...}
#   no second run, same thread_id.
```

**Why.** The claim happens *before* any other side effect (run-log entry, workflow build),
so a duplicate trigger writes nothing new — no double commit, no second PR.

### B6 · Auto-approval & the `auto_approved` event

**What.** When `approve_plan=False` (or the env/config equivalent) the plan pause is
skipped — and an `auto_approved` event is written to the audit log, so the trail records
that no human signed off.

**Example** audit line:
```json
{"timestamp":"2026-06-23T10:30:01Z","thread_id":"run-7f3a9b1c","event_type":"auto_approved","task_name":"plan","payload":{}}
```

**Why.** Skipping approval is a real change in the run's risk profile; making it an explicit
audited event (not just an *absence* of an approval event) keeps the audit trail honest.

### B7 · The full catalogue of human gates

**What.** Plan approval is one of *several* configurable pauses, all suppressed under
`fully_autonomous`:

| Gate | Where configured | Reply contract |
|------|------------------|----------------|
| Plan approval | `[stage.builtin.plan].human_in_loop` (default on) | `yes` / feedback |
| Pre-branch pause | `[branch].human_in_loop` | abort word / proceed |
| Pre-PR pause | `[pr].human_in_loop` | abort word / proceed |
| After-producer | a build's `human_in_loop.after_producer` | abort word / proceed |
| On-gate-fail | a build's `human_in_loop.on_gate_fail` | abort word / retry |
| TDD red-review | `tdd_red_review` (default on) | `yes` / feedback / abort |
| `approval_gate` step | a pluggable step | abort word / proceed |

**Example** — pause before the PR is opened, with two reviewers requested:
```toml
[pr]
human_in_loop = true
reviewers = ["alice", "bob"]
```
An "abort word" is `abort`, `no`, or `stop` (case-insensitive). See `HumanInLoopConfig` in
[orchestrator/manifest.py](orchestrator/manifest.py).

**Why.** Different teams want the human at different seams — some only at the plan, some
also before code touches `main`. Each gate is independently switchable.

### B8 · Growable retry budget

**What.** When a build's `on_exhausted="approval_gate"`, exhausting `retry.max` doesn't
fail — it pauses and lets a human **grant more attempts by replying with a number**. The
budget grows dynamically (optionally capped by `retry.max_total_attempts`). See
[orchestrator/retry_block.py](orchestrator/retry_block.py).

**Example.**
```python
# QA failed 3 times, budget exhausted → awaiting_approval with kind "build_gate_failed"
approve_plan(tid, "2")     # grant 2 more attempts
# ...if it passes within those, it proceeds; if not, it asks again.
approve_plan(tid, "abort") # or stop here
```

**Why.** "Three strikes and fail" throws away a run that's one nudge from passing. Letting
a human extend the budget — bounded by a hard ceiling so it can't run away — keeps a
nearly-good run alive without a full restart.

### B9 · Resume-compatibility gates

**What.** Before doing anything, a resume checks two stored values against the live code:
the `WORKFLOW_VERSION` and a **hash of the resolved pipeline**. If either changed since the
run started, the resume is refused rather than risking a corrupt mid-run replay.

**Example** — you edited `orchestrator.toml`'s `flow` while a run was paused:
```python
resume_run("run-7f3a9b1c")
# → {"status": "incompatible_pipeline",
#    "stored_hash": "a1b2c3d4e5f6a7b8", "current_hash": "9f8e7d6c5b4a3210",
#    "next": "The pipeline in orchestrator.toml changed since this run started...
#             Revert the change to resume, or start a fresh implement_feature."}
```

**Why.** LangGraph keys cached tasks by position; if the graph or the resolved config
shifted underneath a half-finished run, replaying cached results into the new shape is
unsafe. Failing loud with both hashes beats a confusing deserialization error mid-run.

### B10 · Empty-decomposition guard

**What.** An *approved* plan that decomposes to **zero** tasks raises
`EmptyDecompositionError` before the branch is created — fail-loud instead of silently
shipping nothing.

**Example** result: `{"status": "failed", "error": "decomposition produced no tasks"}`
(and nothing is branched or committed). The guard sits between approval and
`create_branch`, so it's caught while everything is still reversible.

**Why.** A zero-task run that returned `no_changes` *looked* successful but did nothing —
a silent failure. Raising makes the "the plan didn't turn into work" case visible.

### B11 · Empty-diff guard

**What.** If the build region produced no actual changes, the workflow returns
`status="no_changes"` — no empty commit, no no-op PR.

**Example.**
```json
{"status": "no_changes", "branch": "feature/tweak-copy",
 "next": "...The working tree was clean; no commit and no PR were created."}
```

**Why.** A QA-passing build that happened to change nothing (e.g. the requested change was
already present) shouldn't manufacture an empty PR. Distinct from `failed` — it's not an
error, so the CLI exits 0.

---

## C · Durability & state

### C1 · SQLite checkpointing & `@task` replay

**What.** An **`AsyncSqliteSaver`** writes to `.orchestrator/checkpoints.db`. Every `@task`
return value is serialized and keyed by `(function name, call position)`. Re-invoke with
the same `thread_id` and completed tasks return their cached result instantly — no LLM
call, no git command.

**Example.** The factory pattern this forces (the checkpointer's connection only exists
inside its `async with`, so the workflow must be *defined* inside it):
```python
async with build_workflow() as workflow:          # opens the DB connection
    result = await workflow.ainvoke(request, config={"configurable": {"thread_id": tid}})
# crash here, rerun with the same tid → planning/decompose/branch replay from cache,
# execution fast-forwards to the first unfinished @task.
```

**Why.** This one library choice replaces the old coordinator's `state.json` +
`progress.log` + hand-written replay logic, and underwrites pause, resume, and crash
recovery at once. (Corollary gotcha: `state.values` is always `None` here — that's a
StateGraph concept; task results live in `state.tasks[].result`.)

### C2 · Crash recovery

**What.** Kill the process mid-run and restart with the same `thread_id`; the run continues
from the last completed `@task`. The faithful way to *simulate* a crash is `os._exit`.

**Example** — why `os._exit`, not Ctrl-C:
```python
# Ctrl-C → asyncio raises CancelledError INSIDE the coroutine → LangGraph writes the
#          task [errored] (a terminal state) → resume has nothing to pick up.
# os._exit(130) → process dies with NO Python cleanup → checkpoint left at the last
#          successful task → resume continues cleanly. Real crashes (OOM, SIGKILL,
#          container kill) also skip cleanup, so os._exit is the honest model.
```

**Why.** Tested by `os._exit`-ing during the multi-minute `implementation` task and
confirming the resume picks up from there. See [.misc_notes/NOTES.md](.misc_notes/NOTES.md)
→ *Crash recovery*.

### C3 · The serde allowlist

**What.** Every Pydantic model that crosses the checkpoint boundary is registered in
`_ALLOWED_MSGPACK_MODULES` at the top of [orchestrator/workflow.py](orchestrator/workflow.py).

**Example.**
```python
_ALLOWED_MSGPACK_MODULES = [
    ("orchestrator.agents.planning", "PlanResult"),
    ("orchestrator.agents.decompose", "DecompositionResult"),
    ("orchestrator.agents.qa", "QaResult"),
    ("orchestrator.agents.test_author", "TestAuthorResult"),
    # ... add a new @task that returns a custom model → add it here.
]
```

**Why.** Deserializing arbitrary classes means importing arbitrary modules — the same
pickle-style risk. A future strict-mode LangGraph refuses to load unlisted types, so an
unregistered model works today and breaks resume tomorrow. (Renaming or moving a registered
model also invalidates old checkpoints, since the blob hard-codes the module path.)

### C4 · Result schema-versioning

**What.** Checkpointed result models carry a `schema_version`. When the shape changes
incompatibly, the version is bumped so an old blob is refused by the resume gate rather
than failing mid-run on a `ValidationError`.

**Example** — `DecompositionResult` is at v2 because `Task.acceptance_criteria` became
required:
```python
class DecompositionResult(_DecompositionSchema):
    schema_version: int = 2     # v1→v2: acceptance_criteria went from optional to required
```
A pre-v2 checkpoint can hold a task with no criteria that no longer deserializes; the gate
refuses that resume cleanly. (Purely *additive* optional fields — `Task.testable`,
`complexity` — don't need a bump, so they stay resume-safe.)

**Why.** It separates "safe to resume" from "must start fresh" mechanically, instead of
hoping an old blob happens to still validate.

### C5 · `WORKFLOW_VERSION` discipline

**What.** `WORKFLOW_VERSION` (in [orchestrator/workflow.py](orchestrator/workflow.py)) is
the version of the `@entrypoint` **body**. It's bumped only on **incompatible** changes —
reordered/removed tasks, a new *required* task, changed control flow — that a half-finished
checkpoint can't safely resume into. Pure additions (a new trailing task legacy checkpoints
never reached) don't require a bump.

**Example** from [CHANGELOG.md](CHANGELOG.md): adding the per-task `test_author_task`
(`2.0.0 → 2.1.0`) bumped it because the body could now emit a new task; a graph-preserving
refactor that only renamed helpers (Phase 58) did *not*.

**Why.** It's the lever behind [§B9](#b9--resume-compatibility-gates): the stored version
vs. the live constant is what decides whether a resume is safe.

---

## D · Engine / framework

### D1 · LangGraph functional API

**What.** No node graph. The whole run is the body of one async `workflow(request)` wrapped
by **`@entrypoint`**; checkpointable units are **`@task`** functions; pausing is
**`interrupt()`** in the body.

**Example** — the three distinct continuation modes (a frequent source of bugs):
```python
workflow.ainvoke(request, config)            # 1. start a NEW run on this thread
workflow.ainvoke(None, config)               # 2. RESUME from the last checkpoint (crash recovery)
workflow.ainvoke(Command(resume="yes"), config)  # 3. resume from an interrupt() with a reply
```

**Invariant:** `@task` order and names are fixed — the cache key is `(name, position)`, so
reordering replays the wrong results.

**Why.** The work is a mostly-linear pipeline with a couple of pauses, not a branchy state
machine — the functional API lets it read as ordinary `await`s while still getting
checkpoint/resume for free.

### D2 · Deterministic vs. cognitive split

**What.** Every unit of work is deliberately one of two kinds, and **~half have no LLM call
at all**:

| Cognition (LLM) | Control (subprocess) |
|-----------------|----------------------|
| plan, decompose, implement, QA, test-author, critic, summarize, docs | verify-tree, branch, commit, push, PR, pre-hooks, scripted QA |
| probabilistic, slow, costly; fails "the model was wrong" | deterministic, fast, free; fails "gh isn't authed" |

**Example.** The deterministic ops are plain sync functions in
[orchestrator/git_ops.py](orchestrator/git_ops.py), independently runnable:
```bash
python -m orchestrator.git_ops "Add an LTV tooltip" feature   # exercises real git, no LLM, no LangGraph
```

**Why.** The two are different *kinds* of failure; you never have to wonder which you're
dealing with, because the task itself carries the label and the LangSmith trace shows it at
a glance.

### D3 · Two model-call styles + fail-closed

**What.** All LLM calls go through [orchestrator/agents/runner.py](orchestrator/agents/runner.py)
in one of two styles:

| Style | Function | Used by | Mechanism |
|-------|----------|---------|-----------|
| Single completion | `run_structured_completion` | planning, decompose | One forced-tool-use call; no file access. The model *must* call a fake "emit" tool whose schema is the result type. |
| Agent loop | `run_structured_agent` | implementation, QA, test-author, critic, summarize, docs, user `ai_agent` | A full Agent-SDK loop with file tools; the agent works freely, then calls an in-process **emit** tool to signal done. |

**Example — fail-closed.** If the agent finishes without calling emit, the runner raises:
```python
# captured stays empty → 
raise FatalError("agent finished without calling emit_qa_result")
```
A gate that never reports a verdict never silently passes.

**Why.** Forcing `tool_choice` on a single call guarantees the shape with no parse-failure
mode. But the implementation agent runs *many* turns — forcing a tool call every turn would
break the loop — so it gets an emit tool to call *at the end* instead. Same robustness
contract (no sentinel-string parsing), different mechanism for the loop shape.

### D4 · async↔sync bridging

**What.** Blocking `subprocess.run` is wrapped in `asyncio.to_thread` so a long git command
doesn't freeze the event loop.

**Example.**
```python
@task
async def create_branch_task(title, type_):
    return await asyncio.to_thread(create_branch, title, type_)   # sync fn in git_ops.py
```

**Why.** LangGraph wants async `@task`s, but calling blocking `subprocess.run` directly
inside an `async def` freezes the loop until it exits — fatal once anything else needs to
run concurrently (LangSmith streaming, MCP progress). `to_thread` releases the loop.

### D5 · Portable path resolution

**What.** `find_project_root()` walks up from CWD to the first `.git` and returns that —
the single source of truth for every runtime path. See [orchestrator/paths.py](orchestrator/paths.py).

**Example.**
```python
def find_project_root() -> Path:
    current = Path.cwd().resolve()
    for path in [current, *current.parents]:
        if (path / ".git").exists():
            return path
    return current
```

**Why.** Two install models work off this one function: **drop-in** (copy `orchestrator/`
into a repo) and **pip/`site-packages`**. A `__file__`-based resolver would point into
`site-packages` once installed (total breakage); `Path.cwd()` would break if you run from a
subdirectory. Walking up to `.git` handles both.

---

## E · Pipeline & configuration (config-as-data)

### E1 · The declarative v2 pipeline

**What.** The stage sequence is config, not code. Two axes place everything:

|                          | **Built-in**           | **Yours**            |
|--------------------------|------------------------|----------------------|
| **In the flow (stage)**  | `[stage.builtin.<id>]` | `[stage.user.<id>]`  |
| **Reusable (part)**      | `[builtin.<id>]`       | `[defs.<id>]`        |

A **stage** is a step in the flow (id = the header's last segment); a **part** is a
reusable producer/gate referenced via `builtin:<id>` / `defs:<id>`. Built-in stages:
`plan`, `decompose`, `task-build`, `docs`, `summarize`, `qa`; built-in parts:
`implementation`, `qa`. See [orchestrator/pipeline.py](orchestrator/pipeline.py).

**Example** — insert a security scan after the build, before summarize:
```toml
flow = "plan >> decompose >> task-build >> gitleaks >> docs >> summarize"

[stage.user.gitleaks]
type = "script"
path = "scripts/run-gitleaks.sh"   # non-zero exit fails the run
```

**Why.** A new stage is a TOML table + a script/prompt — no Python edit. This is what turns
the orchestrator from "the bostadskalkyl coordinator" into a general harness.

### E2 · The `flow` string parser

**What.** [orchestrator/flow.py](orchestrator/flow.py) parses an Airflow-style string: `>>`
is a sequential edge, `[a, b]` a parallel group.

**Example.**
```python
parse("plan >> decompose >> [docs, gitleaks] >> summarize")
# → groups: (("plan",), ("decompose",), ("docs", "gitleaks"), ("summarize",))
```
The executor runs everything sequentially today (parallel groups in declared order), but
the parsed shape records the parallelism for a future concurrent runner. Validation is
strict — empty segments, unbalanced brackets, and **a duplicate id** all raise
`FlowSyntaxError`:
```python
parse("plan >> plan")   # FlowSyntaxError: stage 'plan' appears more than once
```

**Why.** One readable line expresses the whole order; encoding parallelism now (even if run
serially) means a concurrent runner needs no config-language change later.

### E3 · Pluggable steps

**What.** Four injectable step types you declare as your own stages/parts. Each runtime step
is a plain async function in [orchestrator/steps.py](orchestrator/steps.py); `workflow.py`
wraps it in a `@task` so it inherits checkpointing/tracing/cancel/usage at the boundary.

| Type | Behaviour |
|------|-----------|
| `script` | Run an executable; non-zero exit raises `StepError`. As a gate, exit code is the verdict. `timeout` (default 60s). |
| `ai_agent` | A markdown agent (`path`/`agent` file = system prompt) via the Agent SDK; optional `model`, `allowed_tools`, `disallowed_tools`, `timeout`, `human_in_loop`. |
| `build` | A produce⇄gate retry loop (§G1); needs ≥1 `gate` unless `ungated=true`; own `retry` + `human_in_loop`. |
| `approval_gate` | A pause with an `ask`; reply `abort`/`no`/`stop` to stop, else proceed. |

**Example** — a custom review agent run as a gate over a build:
```toml
[defs.security-review]
type = "ai_agent"
path = "agents/security-review.md"
allowed_tools = ["Read", "Grep"]      # read-only gate

[stage.user.harden]
type = "build"
produce = ["builtin:implementation"]
gate = ["defs:security-review"]
retry = { max = 2, on_exhausted = "abort" }
```

**Why.** A linter loop, a scan, a bespoke reviewer — all become config + a file, with the
durability/observability plumbing supplied for free.

### E4 · Locked git rails

**What.** `verify-clean-tree`, `branch`, `commit`, `push`, `open-pr` are implicit, locked
anchors. They wrap every pipeline and may **never** appear in `flow` or be a stage id.

**Example** — trying to name one is a load error:
```toml
flow = "plan >> commit"
# PipelineError: flow references 'commit', which is a locked git rail — rails are
# implicit and must not appear in `flow`.
```

**Why.** Shipping semantics (clean-tree precondition up front; one commit/push/PR at the
end; cancel honoured only before the commit) are invariants, not things a config should be
able to reorder away.

### E5 · `summarize` required

**What.** `assert_shippable` rejects any pipeline without a `summarize` stage at load time.

**Example.**
```toml
flow = "plan >> decompose >> task-build"
# PipelineError: the pipeline has no `summarize` stage, but every run ships
# (commit / push / open-pr) and needs the commit/PR summary it produces.
```

**Why.** Every run ships, and the commit message + PR body come from `summarize`. A
pipeline that can't produce them is fail-loud rather than silently committing with an empty
message.

### E6 · v1-config rejection

**What.** A pre-v2 `[workflow.*]` / `[[steps.work]]` config is rejected at load with a
migration message.

**Example.**
```toml
[workflow]
model = "claude-sonnet-4-6"
# ValueError: This looks like a v1 orchestrator.toml ([workflow.*] / [[steps.work]]).
# The config format is now v2 (flow + [stage.*] + [builtin.*] + [defs.*]).
```

**Why.** A v1 file would be *partially* understood by a v2 loader and behave
surprisingly; an explicit rejection with the new shape named is safer than silent drift.

### E7 · Unknown-key rejection

**What.** `extra="forbid"` on every config model — a typo'd key fails loud at load.

**Example.**
```toml
default_modle = "claude-opus-4-8"   # typo
# ValueError: unknown top-level key(s) in orchestrator.toml: ['default_modle'].
# Allowed: ['audit', 'autonomous_max_cost_usd', 'branch', 'db_path', 'default_model', ...]
```

**Why.** A silently-ignored typo'd key looks like it took effect but didn't — the worst
kind of config bug. Failing at load with the allowed list turns it into a one-line fix.

### E8 · `orchestrator.toml` full reference

**Top-level scalar dials:**

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `default_model` | str | `claude-sonnet-4-6` | Fallback model for any stage not overriding it. |
| `db_path` | str | `.orchestrator/checkpoints.db` | The checkpoint file. |
| `fully_autonomous` | bool | `false` | No human pauses + safety ceilings (§I). |
| `autonomous_max_seconds` | int | `0` (off) | Wall-clock ceiling under autonomous mode. |
| `autonomous_max_cost_usd` | float | `0.0` (off) | Dollar ceiling under autonomous mode. |
| `tdd` | bool | `false` | Enable the red-green station (§H). |
| `test_paths` | list[str] | `[]` | **Required when `tdd`** — the globset the diff-gate freezes. |
| `test_author_path` | str\|None | `None` | Optional explicit test-author prompt path. |
| `tdd_red_review` | bool | `true` | Supervised pause to review RED tests before implementing. |
| `tdd_coverage_critic` | bool | `true` | Run the test-meaningfulness critic. |
| `tdd_critic_max_attempts` | int | `2` | Max critic-driven re-author rounds. |
| `tdd_autonomous_reauthor_max` | int | `2` | (Autonomous TDD) max auto re-author rounds before failing. |

**Infra / rail tables** (with their defaults):
```toml
[branch]   max_slug_length = 50 ; human_in_loop = false
[git]      auto_rebase = true
[pr]       base_branch = "main" ; draft = false ; reviewers = [] ; human_in_loop = false
[pre_hooks] dir = ".orchestrator/pre-hooks" ; timeout = 30
[qa]       scripts_dir = ".orchestrator/qa" ; scripts_timeout = 60
[audit]    enabled = true ; log_path = ".orchestrator/audit.log" ; include_content = false
```
The full default pipeline is in the [appendix](#appendix-1-the-default-pipeline-as-toml).

### E9 · Model/tool precedence chain

**What.** For a stage/part's `model` and tools: explicit value in `orchestrator.toml` **>**
the agent prompt file's YAML frontmatter **>** the code default (`_merge_builtin_frontmatter`
in [orchestrator/config.py](orchestrator/config.py)).

**Example** — three ways to put the docs agent on Opus, highest-priority first:
```toml
# 1. TOML wins over everything:
[stage.builtin.docs]
model = "claude-opus-4-8"
```
```yaml
# 2. .orchestrator/prompts/docs.md frontmatter (used when TOML doesn't set model):
---
model: claude-opus-4-8
---
```
```text
# 3. neither set → the code default (Haiku for docs).
```

**Why.** You can retune an agent's model or toolset by editing its prompt's frontmatter —
no TOML, no Python — while a project that *does* set TOML still overrides cleanly.

### E10 · Prompt overrides & frontmatter

**What.** System prompts load from `.orchestrator/prompts/<name>.md` (project override) or
the bundled defaults in [orchestrator/prompts/](orchestrator/prompts/). YAML frontmatter
supplies `model`, `allowed_tools`, `disallowed_tools`, `timeout`; it's stripped from the
prompt body. See [orchestrator/prompt_loader.py](orchestrator/prompt_loader.py),
[orchestrator/agent_frontmatter.py](orchestrator/agent_frontmatter.py).

**Example** — override how QA reasons, just for your repo:
```markdown
<!-- .orchestrator/prompts/qa.md -->
---
model: claude-sonnet-4-6
allowed_tools: ["Read", "Grep"]
---
You are a strict reviewer for a Swedish mortgage calculator. Reject any change that...
```

**Why.** Behaviour lives in editable text, not Python — drop a prompt into a target repo
and the orchestrator package stays a swappable black box.

---

## F · Planning & decomposition

### F1 · Planning

**What.** `planning_task` turns the request into a typed `PlanResult` (`title`, `type` ∈
{feature, fix, refactor}, `plan_text`) via a single forced-tool-use call. The model's tool
call *is* the structured output. See [orchestrator/agents/planning.py](orchestrator/agents/planning.py).

**Example** — old vs new contract:
```python
# OLD coordinator: "PLAN COMPLETE: title=Add tooltip, type=feature"  ← regex-parsed, fragile
# NEW: the model is forced to call emit_plan, validated by Pydantic:
PlanResult(title="Add an LTV tooltip", type="feature", plan_text="Add an info icon...")
```

**Why.** One stray newline or a paraphrased "Plan Complete:" broke the old chain silently.
Now there's no "plan-shaped but slightly wrong" middle state — it validates or raises.

### F2 · Task decomposition & the Ralph-loop lineage

**What.** A separate `decompose_task` turns the plan into a **fixed, ordered checklist of
`Task`s**; the per-task station runs them one at a time, each seeing earlier edits through
the working tree (**order is the dependency** — no DAG).

**Example** `decomposition.md` (the readable mirror of the checkpointed list):
```markdown
# Task decomposition

**Complexity:** moderate

## 1. Add tooltip markup + icon  (`add-tooltip-markup`)
Add an info icon next to the LTV row in the results panel.
**Acceptance:** An info icon renders next to the LTV figure.

## 2. Wire the LTV explanation copy  (`wire-tooltip-copy`)
Show the explanation text on hover/focus.
**Acceptance:** Hovering the icon shows "Loan-to-value: your loan ÷ the property value."
```

**Why — Ralph, reframed for checkpointing.** The "AFK coding" Ralph loop
(`while :; cat PROMPT.md | claude; done`) is the same checkbox idea. **Kept:** fresh context
per task, tests as the cheap inner gate, one expensive whole-diff QA at the end.
**Rejected:** a runtime-mutable list (it fights checkpointing — the list is **frozen after
planning**), per-iteration commits (the build region is pre-commit; one PR at the end), and
a repo `PROMPT.md` the agent greps (the ratchet is checkpointed orchestrator state — the
agent never self-ticks its own boxes). See [orchestrator/agents/decompose.py](orchestrator/agents/decompose.py).

### F3 · Complexity-based task budgeting

**What.** The decomposer emits a run-level `complexity` (`trivial`/`moderate`/`complex`)
*before* the split, which sizes the task count.

**Example** mapping (from the field's own description): `trivial` → 1 task (a copy/CSS
tweak, a rename sweep); `moderate` → 1–3 tasks; `complex` → split by behaviour, as many as
the plan needs.

**Why.** It anchors the model to commit to a size, then fill that budget — guidance, not a
mechanical clamp (under-splitting costs more in retries than one extra clean task; each
task is a fresh agent with its own QA round, so splitting is never free).

### F4 · Per-task testability tagging

**What.** Under TDD, the decomposer marks each `Task.testable` — `false` for
presentation/copy, markup, CSS, docs, config, or pure renames/moves; biased to `true` when
in doubt. Consumed by the testability gate ([§H8](#h8--testability-gate)).

**Example.**
```json
{"id": "add-tooltip-markup", "testable": false}   // markup → skip the test-author
{"id": "wire-tooltip-copy",  "testable": true}    // behaviour → full red-green station
```

**Why.** Markup/CSS/docs tests pass on the first run and prove nothing — paying a full
Sonnet test-author leg (~$0.45) to discover that is waste. The tag lets the station skip it.

### F5 · TDD-aware decompose

**What.** Under `tdd`, a note is appended to the decomposer's *user message* forbidding
standalone "write tests" / "add tests" tasks (the test-author owns tests).

**Example** — without the note the decomposer might emit a redundant final task:
```text
3. Write the unit tests for cashToClose      ← under TDD this runs AFTER the code exists,
                                                can't go red, and degrades. The note kills it.
```
It's a prompt-level instruction only — the decomposer still reads only `plan_text` with no
repo access, so with TDD *off* the message, behaviour, and result are byte-for-byte
unchanged.

**Why.** A real dogfood run (Phase 75) split a feature into "implement X" + "write the
tests for X" and had to be re-planned by hand. The note prevents that class of split.

---

## G · Build & QA

### G1 · The retry block

**What.** Every "do work, check it, retry on failure" loop runs through `run_retry_block`
([orchestrator/retry_block.py](orchestrator/retry_block.py)), given **producers** (mutate
the tree) and **gates** (judge it, return pass/fail + feedback):

```text
repeat up to retry.max times:
    run producers (injecting the last failing gate's feedback)
    run gates in order; the FIRST to fail stops the attempt
    all pass → success ; else → remember feedback, loop
on exhaustion → abort | proceed | ask a human (approval_gate)
```

**Example — feedback injection.** On a retry the failing gate's `detail` is appended to the
producer's prompt under a standard heading, so the implementer targets the fix:
```text
## Feedback from the previous attempt
QA FAIL: the tooltip is not keyboard-focusable; add tabindex and a key handler.
```

**Why.** One tested engine drives the per-task station, user `build` stages, and the TDD
diff-gate. **Gates fail closed** — a gate that returns no verdict is a config error, not a
silent pass. Hooks (`on_attempt`, `on_gate_failed`, `on_producers_done`) let callers record
evidence or insert pauses without the engine knowing.

### G2 · The implementation agent

**What.** The built-in producer: an Agent-SDK loop with file tools, run unattended.

**Example** config and the safety model:
```toml
[builtin.implementation]
allowed_tools = ["Read", "Edit", "Write", "Bash"]
```
It runs with `permission_mode="acceptEdits"` so it edits without stopping to ask. The
project deny-list in `.claude/settings.json` (applied via `setting_sources=["project"]`) is
the **safety floor** — that, not `acceptEdits`, is what keeps it off `.env` and secrets.

**Why.** An orchestrator that paused at every edit would defeat its own purpose; the deny
list is the real guardrail, so the loop can run freely inside it.

### G3 · The per-task station

**What.** `_run_task_loop` runs one produce⇄gate build per decomposed task, in order, the
cumulative diff carried in the working tree. With TDD off it's just implement⇄QA per task;
with TDD on it's the red-green station (§H).

**Example** flow for the worked run: task 1 (`add-tooltip-markup`, testable:false) → classic
build + a manual check; task 2 (`wire-tooltip-copy`, testable:true) → full red-green. Task 2
sees task 1's markup already in the tree.

**Why.** Small, independently-QA'd slices beat one big coding pass — each is sized for the
agent to do well, and a crash resumes at the failed task with earlier ones free.

### G4 · The LLM QA gate

**What.** The built-in `qa` gate: a (mostly) read-only agent that judges the diff PASS/FAIL
with feedback, and records what it reviewed. See [orchestrator/agents/qa.py](orchestrator/agents/qa.py).

**Example** `qa.md`:
```markdown
# QA Result: PASS

## Checks performed
- Static checks (index.html): ✓ PASS
- "icon renders next to LTV row": ✓ PASS
- "hover shows explanation copy": ✓ PASS

## Failures
(none)
```

**Why.** A separate read-only judge over the diff catches what the implementer (who's
invested in its own change) won't. `qa.md` is *strictly* the QA agent's record — the TDD
red-green results live in the per-task `test-author/` + `impl/` folders, so the two never
have to be disambiguated.

### G5 · The scripted-QA gate

**What.** If `.orchestrator/qa/` exists, every executable inside runs in **lexicographic
order before** the LLM QA agent; a non-zero exit aborts QA immediately (the agent is never
called). Output is captured into the failure report. See
[orchestrator/qa_scripts.py](orchestrator/qa_scripts.py).

**Example.**
```bash
.orchestrator/qa/
├── 01-eslint.sh        # exit 1 here → QA fails now, the LLM judge never runs
└── 02-unit-tests.sh
```

**Why.** Deterministic checks are free and unambiguous — run them first and don't spend an
LLM call when a linter already says no. (Windows caveat: the gate falls back to file
extensions `.sh/.bat/.ps1/.py` since there's no executable bit.)

### G6 · The whole-diff QA stage

**What.** An optional `qa` *stage* (distinct from the per-task gate) runs one QA pass over
the **entire** change via `_run_qa_stage` — useful as a final review after all tasks land.

**Example.**
```toml
flow = "plan >> decompose >> task-build >> qa >> docs >> summarize"
```

**Why.** Per-task QA judges each slice; a whole-diff pass catches cross-task interactions
(task 2 broke task 1) that no single-task review sees.

### G7 · `on_exhausted` policies

**What.** What happens when a build burns its `retry.max`:

| Policy | Behaviour |
|--------|-----------|
| `abort` (default) | Raise `BuildFailed` → `status="failed"`. |
| `proceed` | Give up gating and continue anyway (rare; for non-critical gates). |
| `approval_gate` | Pause and let a human grant more attempts ([§B8](#b8--growable-retry-budget)). |

**Example.**
```toml
[stage.builtin.task-build]
retry = { max = 3, on_exhausted = "approval_gate", max_total_attempts = 9 }
```

**Why.** A flaky-but-fixable build wants `approval_gate`; a hard gate (security scan) wants
`abort`; a best-effort gate (a style nudge) might `proceed`.

---

## H · TDD red-green station

Active when `tdd=true` (which **requires** `test_paths`). The whole point is to separate the
test-author from the implementer and freeze the tests so the implementer can't game them.

### H1 · The red-green station, step by step

For each *testable* task:

1. **Testability gate** — a `testable:false` task skips the station entirely (§H8).
2. **Author tests** — a separate agent writes *failing* tests for the acceptance criteria.
3. **Confirm red** — run them; require a green→red transition. Born-green / not-unit-testable → degrade (§H6).
4. **Coverage critic** — judge whether the tests *meaningfully* pin behaviour (§H4).
5. **Red-review pause** — a human reviews the failing tests (§H5).
6. **Freeze (diff-gate)** — hash the test files; prepend a `builtin:diff-gate` so "green" only counts if tests are unchanged (§H3).
7. **Implement** — the retry block, first attempt handed the RED output; the diff-gate keeps tests frozen, the suite runs, QA judges the diff.

**Example** config:
```toml
tdd = true
test_paths = ["**/*.test.js"]
```

**Why.** Under automation the agent that writes the spec and the one that satisfies it must
be different processes, and the spec must be immutable once frozen — otherwise an agent can
write a test it knows will pass, or weaken it on retry.

### H2 · Separate test-author

**What.** A distinct agent ([orchestrator/agents/test_author.py](orchestrator/agents/test_author.py))
writes the failing tests — never the implementer.

**Example** evidence written per task under `test-author/`: the authored test file(s)
verbatim, `results-test-run.md` (the complete RED run — proof the suite actually ran red),
`test-snapshot-hash.md` (the freeze baseline), and `summary.md` (testable verdict, critic
verdicts, re-author rounds, red-review outcome).

**Why.** If the implementer wrote the tests it could trivially make them pass. A separate
author is the integrity boundary.

### H3 · The diff-gate (test freeze)

**What.** After authoring, the test files are hashed (`_hash_test_paths`) and a synthetic
`builtin:diff-gate` is **prepended to the gates**. On every implement attempt the gate
re-hashes and a "green" only counts if the hash **matches** the frozen baseline.

**Example** `impl/attempt-1/snapshot-hash.md`:
```text
Frozen baseline: 7c1d…  
This attempt:    7c1d…   → MATCH ✓     (implementer did not touch the tests)
# a MISMATCH ✗ is the evidence of WHY the diff-gate failed an attempt.
```

**Why.** It makes "make the tests pass by editing the tests" literally impossible — the
single guarantee that makes automated TDD trustworthy.

### H4 · Coverage critic (on Haiku)

**What.** A read-only agent ([orchestrator/agents/coverage_critic.py](orchestrator/agents/coverage_critic.py))
judges whether the authored tests *meaningfully* pin behaviour (vs tautological/vacuous). A
weak verdict re-authors with feedback, bounded by `tdd_critic_max_attempts`; still weak →
proceed + a manual check (it never wedges).

**Example** — it runs on **every** testable task, so it's pinned to Haiku via its prompt
frontmatter (a classification task Haiku handles well; the lever is price, not token count):
```yaml
# orchestrator/prompts/coverage-critic.md
---
model: haiku
---
```

**Why.** A green→red gate proves a test *fails then passes*, but not that it tests anything
real (`expect(true).toBe(true)` goes red→green just fine). The critic is the
meaningfulness backstop.

### H5 · Red-review & re-author

**What.** In supervised mode, after red is confirmed the run pauses (a `red_review`
interrupt) for a human to review the failing tests *before* any implementation.

**Example** `run_status` / tool reply at the pause:
```json
{"status": "awaiting_approval", "kind": "red_review", "task_id": "wire-tooltip-copy",
 "red_output": "FAIL wire-tooltip-copy › shows explanation on hover\n  expected 'Loan-to-value...'",
 "summary": "2 failing tests authored for the hover copy",
 "next": "...reply 'yes' to implement against these tests, feedback to re-author, 'abort' to stop."}
```

**Why.** The cheapest moment to catch a wrong spec is before any code is written against
it. `yes` implements, feedback re-authors, `abort` stops.

### H6 · Born-green / untestable degrade

**What.** If the authored tests *pass on the first run* ("born green") or the behaviour
isn't unit-testable, the task **degrades** to the classic implement→QA path and records a
manual check — it never forces a meaningless suite through.

**Example** `manual-checks.md` entry:
```markdown
- [ ] wire-tooltip-copy — tests were born-green (no red baseline); verify the hover copy by hand.
```

**Why.** Not every task *should* have tests; forcing one wastes money and produces a
green-from-the-start suite that proves nothing. Degrading + flagging beats faking it.

### H7 · Autonomous TDD

**What.** With `tdd` + `fully_autonomous`, the human guards are replaced by machinery:
red-confirm becomes a **hard gate** (a born-green/non-green-baseline verdict aborts the task
rather than silently degrading), and a bounded auto-re-author cycle
(`tdd_autonomous_reauthor_max`, default 2) replaces the human red-review.

**Example** — an over-constrained frozen test the implementer can't satisfy:
```text
attempt budget exhausted → auto re-author round 1 (the tests may be wrong) → re-freeze →
implement again → ... → after tdd_autonomous_reauthor_max rounds: status="failed"
(NOT loop a wrong frozen test to the autonomous_max_* ceiling).
```

**Why.** With no human to grant attempts or fix a wrong test, the run needs a deterministic
escape so a bad frozen suite can't burn the whole cost ceiling.

### H8 · Testability gate

**What.** A `testable:false` task (set by the decomposer, §F4) **skips the whole TDD
station** — no test-author, no critic — runs the classic build, and records a manual check.

**Example** — task 1 of the worked run (`add-tooltip-markup`, markup) takes this path: it's
implemented + QA'd like a non-TDD task, and `manual-checks.md` notes "verify the icon
renders" for a human.

**Why.** This is the Phase 81 cost fix: paying a full Sonnet test-author leg per
markup/CSS/docs task — only to discover it's born-green — was ~40% of the spend on
presentation-heavy features. Gating on the decomposer's tag avoids it.

### H9 · Manual checks

**What.** Degraded/non-testable tasks accumulate into `manual-checks.md` so a human knows
exactly what to verify by hand. See `write_manual_checks` in
[orchestrator/run_artifacts.py](orchestrator/run_artifacts.py).

**Example.**
```markdown
# Manual checks
- [ ] add-tooltip-markup — markup task (not unit-testable); confirm the icon renders next to LTV.
- [ ] wire-tooltip-copy — coverage critic flagged thin assertions; eyeball the hover text.
```

**Why.** "We couldn't auto-test this" should never be silent — it's surfaced as an explicit
checklist the reviewer works through.

---

## I · Autonomy & safety

### I1 · Fully-autonomous mode

**What.** `fully_autonomous=true` runs with **no human pauses** (plan/branch/PR/red-review
all suppressed).

**Example.**
```bash
ORCHESTRATOR_FULLY_AUTONOMOUS=true \
ORCHESTRATOR_AUTONOMOUS_MAX_SECONDS=1800 \
ORCHESTRATOR_AUTONOMOUS_MAX_COST_USD=5.00 \
implement-feature --no-approve-plan "tidy the footer markup"
```

**Why.** For unattended/CI use — but only safe paired with the ceilings below and the
autonomous-TDD machinery (§H7), since there's no human to catch a runaway.

### I2 · Wall-clock & cost ceilings

**What.** Two budgets checked at the same between-task boundary as cancellation; crossing
either exits cleanly as `status="cancelled"`.

| Ceiling | Key | Default |
|---------|-----|---------|
| Wall-clock | `autonomous_max_seconds` | `0` (off) |
| Dollar | `autonomous_max_cost_usd` | `0.0` (off) |

**Example.** With `autonomous_max_cost_usd = 5.00`, once cumulative cost crosses $5 the run
stops before the next task rather than continuing to spend.

**Why.** Autonomous mode runs the retry block with an effectively infinite attempt budget,
so the ceilings are the real backstop against a stuck loop.

### I3 · Unpriced-model warning

**What.** When the cost ceiling is on but a `TaskUsage` has no price-table entry
(`cost_usd()` is `None`), a one-time WARNING per model is logged — so you know the ceiling
is *degraded* rather than silently treating unknown spend as 0.

**Example** log line:
```text
WARNING orchestrator.workflow: autonomous_max_cost_usd is set but model
'claude-experimental-9' has no price entry — its spend counts as $0 toward the ceiling.
```

**Why.** A cost ceiling that silently ignores an unpriced model gives false safety. The
warning makes the gap visible so you add the price (§J1) or pin a known model.

---

## J · Observability & logging

A run leaves a thorough, multi-sink paper trail. This is ~8 distinct features.

### J1 · Token & cost accounting

**What.** A `TaskUsage` is captured per LLM call, carrying **all four token categories**
(input, output, cache-read, cache-creation). Cost resolves in priority order:
**(1)** the SDK's reported cost → **(2)** `litellm.model_cost` if litellm is installed →
**(3)** the hardcoded `PRICES_USD_PER_MTOKEN` table. See [orchestrator/usage.py](orchestrator/usage.py).

**Example** — the real price table (USD per million tokens):

| Model | input | output | cache_read | cache_write |
|-------|------:|-------:|-----------:|------------:|
| `claude-opus-4-8` | 15.00 | 75.00 | 1.50 | 18.75 |
| `claude-sonnet-4-6` | 3.00 | 15.00 | 0.30 | 3.75 |
| `claude-haiku-4-5` | 0.80 | 4.00 | 0.08 | 1.00 |

`usage.json` (per-task + run total):
```json
{"by_task": {
   "planning": {"input_tokens": 12340, "output_tokens": 820, "cost_usd": 0.049},
   "implementation": {"input_tokens": 180400, "output_tokens": 9200, "cost_usd": 0.654}},
 "total": {"input_tokens": 258050, "output_tokens": 12930, "cost_usd": 0.903}}
```

**Why cache-awareness matters.** Cache-read was ~90% of one real run's 4.08M tokens. A naive
input-rate estimate (cache-read priced as input) overstates cost ~10× — so cost is computed
against the real per-category prices, and `total_cost_usd` from the SDK is *not* trusted on
the sdk-py path (it's null there).

### J2 · The audit log

**What.** `.orchestrator/audit.log` — a structured JSONL event stream
([orchestrator/audit.py](orchestrator/audit.py)). Vocabulary: `task_start`,
`task_complete`, `task_failed`, `interrupt`, `resume`, `cancel`, `auto_approved`, `usage`.
Events are emitted from **inside** each spine task, so a replayed task on resume isn't
re-logged.

**Example** lines:
```json
{"timestamp":"2026-06-23T10:32:40Z","thread_id":"run-7f3a9b1c","event_type":"task_start","task_name":"implementation","payload":{}}
{"timestamp":"2026-06-23T10:34:52Z","thread_id":"run-7f3a9b1c","event_type":"task_complete","task_name":"implementation","payload":{}}
{"timestamp":"2026-06-23T10:35:10Z","thread_id":"run-7f3a9b1c","event_type":"task_failed","task_name":"qa","payload":{"error_type":"FatalError","message":"...error result: success","cause":{"error":"billing_error","api_status":400,"text":"Credit balance is too low"}}}
```

**Why.** LangSmith is for debugging; this is the *audit* trail — independent, greppable,
content-scrubbed by default (set `[audit].include_content = true` to log plan/request text).
The `task_failed` payload carries the real `cause` (§J6), and it's the lock-free source
`run_status` tails for live progress (§B4).

### J3 · The run log (`runs.jsonl`)

**What.** `.orchestrator/runs.jsonl` — append-only, one **start** line per run plus one
**end-rollup** line. Lets you recover a `thread_id` and a run's spend without scrollback.
See [orchestrator/run_log.py](orchestrator/run_log.py).

**Example** — the two lines for the worked run:
```json
{"thread_id":"run-7f3a9b1c","request":"add a tooltip showing what LTV means","started_at":"2026-06-23T10:29:50Z","source":"mcp"}
{"thread_id":"run-7f3a9b1c","event":"run_end","status":"succeeded","ended_at":"2026-06-23T10:36:02Z","tokens":{"input_tokens":258050,"output_tokens":12930,"cache_read_tokens":4100000,"cache_creation_tokens":52000},"cost_usd":0.903}
```
```bash
grep '"idempotency_key":"ci-build-4821"' .orchestrator/runs.jsonl   # find a run by CI job
grep '"event":"run_end"' .orchestrator/runs.jsonl | tail            # recent spend
```

**Why.** Close the terminal mid-run and you'd lose the `thread_id` needed to resume; the
start line preserves it, and the rollup makes per-run spend durable and greppable (the
figures used to require hand-reconstruction from subprocess transcripts).

### J4 · The run-artifacts folder

**What.** `.orchestrator/runs/<thread>-<slug>/` — the full human-readable record. See
[orchestrator/run_artifacts.py](orchestrator/run_artifacts.py).

**Example** layout for a TDD run:
```text
runs/run-7f3a9b1c-feature-add-an-ltv-tooltip/
├── plan.md            # "# Add an LTV tooltip\n**Type:** feature\n..."
├── decomposition.md   # the task list (see §F2)
├── qa.md              # the QA agent's verdict (see §G4)
├── summary.md         # the commit/PR body
├── manual-checks.md   # things to verify by hand (see §H9)
├── error.md           # only if the run failed (see §J6)
├── usage.json         # per-task + total tokens/cost (see §J1)
└── task-02-wire-tooltip-copy/
    ├── test-author/   # authored suite + RED run + freeze hash + summary
    └── impl/attempt-1/  # full test run + snapshot MATCH/MISMATCH
```
The folder is renamed to include the branch slug once the branch is created
(`rename_with_branch`).

**Why.** The checkpoint DB is machine state; this is the *human* evidence — every plan, test
suite, QA verdict, and implementation attempt, browsable after the fact.

### J5 · LangSmith cost-in-trace

**What.** Our model calls aren't auto-instrumented (we use a bare Anthropic client + an
Agent-SDK subprocess), so `emit_llm_run` attaches an LLM child run carrying **our** computed
cost into the active trace. See [orchestrator/tracing.py](orchestrator/tracing.py).

**Example.** Enable with the standard env vars (which must be set *before* any LangSmith
import — `load_dotenv()` runs at the top of the entry points for exactly this):
```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=ls__...
```
The header then rolls up cost from `llm` child runs; without `emit_llm_run`, LangSmith's
price map (which lacks our model ids) would show $0 or double-count.

**Why.** `wrap_anthropic` gives $0/double-count, and `configure_claude_agent_sdk` never
fires for the `query()` subprocess path — so injecting our own cost-bearing child run is the
only way the trace shows real spend.

### J6 · Transcript error recovery

**What.** When an agent subprocess dies (e.g. a billing error), the Agent SDK **collapses
the real cause to a useless string** (`…error result: success`) and may raise before any
result message. The real message lives only in the Claude Code CLI transcript JSONL. This
module reads `~/.claude/projects/<key>/<session>.jsonl`, pulls the last `isApiErrorMessage`
record into a structured `cause`, and threads it everywhere. See
[orchestrator/transcript.py](orchestrator/transcript.py).

**Example** — the recovered cause, and where it lands:
```json
{"error": "billing_error", "api_status": 400, "text": "Your credit balance is too low"}
```
→ `error.md` (artifact) + `task_failed` audit payload (§J2) + the `run_status`/tool reply,
which reshapes it to a **resumable** `billing` status (§L2).

**Why.** Without this you'd see only `status: fatal / "error result: success"` and have no
idea a top-up + `resume_run` would fix it. It turns an opaque dead-end into an actionable,
recoverable error.

### J7 · CLI heartbeat & task-titles

**What.** The CLI predicts the currently-running stage every `HEARTBEAT_INTERVAL` seconds
(so a 5-minute leg doesn't look hung) and, after decompose, prints the produced task titles.
See [orchestrator/cli.py](orchestrator/cli.py).

**Example.**
```text
  done: decompose (3s)
    → 2 tasks: Add tooltip markup + icon · Wire the LTV explanation copy
  ... running implementation (45s elapsed)
  ... running implementation (60s elapsed)
```

**Why.** The task titles are the one signal that tells a waiting user whether the plan was
interpreted sensibly; the heartbeat predicts what's running *now* (it disambiguates QA:
PASS→commit, FAIL→another implementation attempt) rather than echoing what just finished.

### J8 · MCP progress & live stage

**What.** MCP-aware clients get progress notifications during long tasks
([orchestrator/mcp_progress.py](orchestrator/mcp_progress.py)); `run_status` reports
`stage`/`elapsed_seconds`/`last_event` from the audit tail (§B4).

**Example** — `run_status` mid-run again, showing the live-stage fields:
```json
{"status":"running","stage":"qa","elapsed_seconds":210.4,
 "last_event":{"event_type":"task_start","task_name":"qa","timestamp":"2026-06-23T10:33:20Z"}}
```

**Why.** Two channels for two clients: notifications for MCP-aware ones, the poll-able
audit-tail for Claude Code chat (which ignores notifications). Either way the user sees the
run is alive.

---

## K · Git & shipping

### K1 · The git rails

**What.** [orchestrator/git_ops.py](orchestrator/git_ops.py) owns all git interaction —
deterministic, no LLM, each its own **idempotent** `@task`:

| Rail | Behaviour |
|------|-----------|
| `verify_clean_tree` | The tree must be clean before starting (first thing the run does). |
| `create_branch` | Branch from the plan title, slugified, length-capped. The **first side effect** — everything before it is reversible. |
| `commit` | Idempotent: tree clean + branch ahead of base → return the existing HEAD SHA (no re-commit). |
| `push` | Git-native idempotency; optional auto-rebase; `--force-with-lease` after a rebase. |
| `pr_create` | `gh pr view <branch>` first → return the existing URL if a PR exists, else create. |

**Example — idempotent `pr_create`** on a resume after a network blip:
```python
# pr_create_task re-runs on resume, but the PR already exists:
existing = gh("pr", "view", branch)   # returns the URL
return existing_url                   # no duplicate PR
```

**Why.** Idempotency is the *function's* responsibility (a re-run re-invokes with the same
inputs), not LangGraph's — without it you'd get duplicate commits, double-pushed branches,
or a "PR already exists" error from `gh`. This is what makes [§B2](#b2--resume-from-failure)
work between any two rails.

### K2 · Slug-length clamp

**What.** The branch-slug budget is clamped to `max(8, max_slug_length - len(suffix))`.

**Example** — without the clamp, a tiny `max_slug_length` goes negative and `s[:negative]`
silently slices from the *end* of the slug:
```python
# max_slug_length = 5, suffix = "-a1b2" (len 5) → budget = max(8, 0) = 8, not 0 or negative.
create_branch("Add an LTV tooltip", "feature")  # → feature/add-an-l-a1b2 (sane), never empty
```

**Why.** A small operator-configured cap shouldn't be able to produce a garbage or empty
branch name. A code-review-batch edge case (Phase 65), but exactly the kind that bites once.

### K3 · Auto-rebase & `--force-with-lease`

**What.** `push` optionally rebases onto the base when behind (`[git].auto_rebase`, default
on), and after a successful rebase uses `--force-with-lease` so the resume-after-failure
path isn't rejected as non-fast-forward.

**Example** sequence on a resume where the branch was already pushed once:
```bash
git rebase origin/main                     # branch had drifted behind base
git push --force-with-lease -u origin HEAD  # lease = "only if no one else pushed" — safe force
```

**Why.** A bare `git push` after a rebase is rejected (non-fast-forward), wedging the
resume; `--force-with-lease` is the *safe* force — it refuses if the remote moved under you,
so it fixes the resume path without clobbering someone else's push.

### K4 · PR draft & reviewers

**What.** `[pr].draft = true` opens a draft PR; `[pr].reviewers = [...]` requests reviewers
on creation.

**Example.**
```toml
[pr]
draft = true
reviewers = ["alice", "team/frontend"]
```
→ `gh pr create --draft --reviewer alice --reviewer team/frontend ...`

**Why.** Teams that gate on human review want the PR to land as a draft with the right
people pinged, not as a ready-to-merge surprise.

### K5 · Pre-hooks

**What.** User executables under `[pre_hooks].dir` run **before** the LLM work starts; a
non-zero exit aborts the run with a `PreHookError`. Also `@task`-wrapped, so checkpointed
and resumable. See [orchestrator/pre_hooks.py](orchestrator/pre_hooks.py).

**Example.**
```bash
.orchestrator/pre-hooks/
└── 01-require-clean-deps.sh   # exit 1 → run aborts before any planning/cost is spent
```
A failure surfaces with the hook name, exit code, captured output, and a suggested action.

**Why.** A cheap deterministic precondition (deps installed, env present) should fail the
run *before* you spend a cent on planning — fail-fast at the front door.

---

## L · Error model

### L1 · The three-class taxonomy

**What.** Every failure is one of three classes under `OrchestratorError`
([orchestrator/errors.py](orchestrator/errors.py)); the entry points shape each into a clean
status dict instead of a traceback:

| Class | Meaning | Recovery |
|-------|---------|----------|
| `RetriableError` | Transient (network blip). | `resume_run` immediately. |
| `UserActionError` | Needs you to act first; carries an `action` string. | Fix, then `resume_run`. |
| `FatalError` | Non-retriable (mis-wired step, agent never emitted). | Fix root cause, start fresh. |

**Example** — the `action` field tells the user exactly what to do:
```json
{"status": "user_action_required", "thread_id": "run-7f3a9b1c",
 "error": "gh pr create failed: not authenticated",
 "action": "Run `gh auth login`, then call resume_run(thread_id)."}
```
The body also maps known terminal conditions: `BuildFailed` → `failed`, `StepGateAborted` →
`aborted`, `WorkflowCancelled` → `cancelled`.

**Why.** Different *kinds* of failure want different recovery, and the caller (a human at
the CLI, or Claude in chat) shouldn't read a traceback to tell which. The class *is* the
recovery instruction.

### L2 · Billing-error reclassification

**What.** A credit/billing `FatalError` is *not* really fatal — the run is checkpointed, so
a top-up + `resume_run` re-runs only the failed leg. The MCP server reshapes it from
`fatal` to a resumable **`billing`** status.

**Example.**
```json
{"status": "billing", "thread_id": "run-7f3a9b1c",
 "cause": {"error": "billing_error", "api_status": 400, "text": "Credit balance is too low"},
 "next": "Top up at https://console.anthropic.com/settings/billing, then call
          resume_run(thread_id) — only the failed leg re-runs. Do NOT start fresh."}
```

**Why.** "Fatal — start fresh" would throw away a fully-checkpointed run over a temporary
balance issue. Reclassifying it to a resumable status with the top-up link is the correct,
non-wasteful recovery.

### L3 · Status vocabulary

| Status | Meaning |
|--------|---------|
| `awaiting_approval` | Paused at a gate (plan / red_review / approval_gate). |
| `started` / `running` | Backgrounded run kicked off / still working. |
| `succeeded` | Done — `branch`, `pr_url`, `usage`. |
| `no_changes` | QA passed but no diff — no commit, no PR. |
| `failed` | A build exhausted its retries (`qa_failures`). |
| `aborted` | A human declined at an approval gate (nothing committed). |
| `cancelled` / `cancellation_signalled` | Cancel/ceiling tripped / cancel accepted, exits at next boundary. |
| `refused_cancelled` | `resume_run` on a cancelled thread without `force=True`. |
| `user_action_required` / `retriable_error` / `fatal` | The three error families. |
| `billing` | Credit too low — **resumable** after top-up. |
| `incompatible_checkpoint` / `incompatible_pipeline` | Version or pipeline changed mid-run. |
| `in_progress` (+ `replayed: true`) | An idempotency-key replay surfaced an existing run. |

---

## Appendix 1 · The default pipeline as TOML

The built-in default used when no `orchestrator.toml` is present:

```toml
flow = "plan >> decompose >> task-build >> docs >> summarize"

[stage.builtin.plan]
type = "ai_agent"
human_in_loop = true

[stage.builtin.decompose]
type = "ai_agent"

[stage.builtin.task-build]
produce = ["builtin:implementation"]
gate    = ["builtin:qa"]
retry   = { max = 3, on_exhausted = "approval_gate" }

[stage.builtin.docs]
type = "ai_agent"
model = "claude-haiku-4-5-20251001"
timeout = 120

[stage.builtin.summarize]
type = "ai_agent"
model = "claude-haiku-4-5-20251001"
allowed_tools = ["Read", "Bash", "Grep"]
timeout = 120

[builtin.implementation]
allowed_tools = ["Read", "Edit", "Write", "Bash"]

[builtin.qa]
allowed_tools = ["Read", "Grep", "Bash"]
```

The git rails (`verify-clean-tree`, `branch`, `commit`, `push`, `open-pr`) wrap this
implicitly and never appear in `flow`.

## Appendix 2 · All environment variables

| Env var | Read by | Effect |
|---------|---------|--------|
| `ANTHROPIC_API_KEY` | everywhere | Required — the model API key. |
| `LANGCHAIN_TRACING_V2` / `LANGCHAIN_API_KEY` | LangSmith | `true` enables tracing / the key. |
| `ORCHESTRATOR_DEBUG` | CLI | Full traceback on failure. |
| `HEARTBEAT_INTERVAL` | CLI | Seconds between heartbeat pings (default 15). |
| `ORCHESTRATOR_APPROVE_PLAN` | config | Override the plan-approval gate. |
| `ORCHESTRATOR_BASE_BRANCH` | config | Override the PR base branch. |
| `ORCHESTRATOR_FULLY_AUTONOMOUS` | config | Run with no human pauses. |
| `ORCHESTRATOR_AUTONOMOUS_MAX_SECONDS` / `_MAX_COST_USD` | config | Autonomous wall-clock / dollar ceilings. |

## Appendix 3 · On-disk layout

State lives at the **project root** (next to `.git/`), not inside `orchestrator/`, so the
package stays a swappable black box (`find_project_root()` walks up to `.git`).

```text
<project-root>/
├── orchestrator.toml                 # optional config (defaults if absent)
└── .orchestrator/
    ├── checkpoints.db                # SQLite checkpointer (resume state)
    ├── audit.log                     # JSONL event stream
    ├── runs.jsonl                    # one start + one rollup line per run
    ├── prompts/<name>.md             # optional prompt overrides
    ├── pre-hooks/                    # optional pre-LLM executables
    ├── qa/                           # optional scripted QA checks
    └── runs/<thread>-<slug>/         # human-readable run artifacts
        ├── plan.md  decomposition.md  qa.md  summary.md
        ├── manual-checks.md  error.md  usage.json
        └── task-NN-<id>/
            ├── test-author/          # authored suite + RED run + freeze hash
            └── impl/attempt-N/       # each attempt's output + freeze check
```

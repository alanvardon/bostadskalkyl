# Bostadskalkyl Orchestrator — Phase Explainer

A companion to `PLAN.md`. Where the plan tells you _what to do_, this document
explains _what is actually happening_ at each phase, and why each decision was
made. Use it to explain the system to someone new, or to reason about changes.

---

## The problem being solved

The existing coordinator is a Markdown file (`.claude/agents/coordinator.md`)
that Claude reads and follows as instructions. It coordinates a multi-step
workflow: plan → branch → implement → QA → commit → PR.

This works but has several weaknesses:

- **State is fragile.** Progress is tracked in `state.json` and `progress.log`
  — plain files written by different steps. If a step crashes mid-way, you have
  to manually figure out where to restart.
- **Communication via sentinels.** Steps signal completion by printing strings
  like `PLAN COMPLETE: title=X, type=feature`. The coordinator parses these with
  string matching. One typo or extra space and the whole chain breaks.
- **No audit trail.** To debug what went wrong, you read log files. You can't
  easily see what prompt was sent to the LLM, what the model actually returned,
  or how long each step took.
- **No real human-in-loop.** The "approval" step is awkward because there's no
  clean pause/resume mechanism.

The goal of this port is to replace all of that with proper engineering
primitives: structured data types, a database for state, a tracing platform for
observability, and a protocol (MCP) for clean integration with Claude Code.

---

## Phase 0 — Setup

### What is happening

You are creating an isolated Python environment and confirming that it can talk
to the Anthropic API. Nothing more.

### Why a separate virtual environment

Python virtual environments are isolated dependency sets. If you install
packages into the global Python installation, different projects interfere with
each other (version conflicts, unexpected upgrades). `pyenv-virtualenv` creates
a dedicated env for this project so the orchestrator's dependencies don't
interact with anything else on your machine.

The `.python-version` file tells pyenv "when someone enters this directory,
activate this virtual environment automatically." It's the mechanism that means
you don't have to remember to type `source activate` every time.

### Why `pyproject.toml` and not `requirements.txt`

`pyproject.toml` is the modern Python packaging standard. It declares your
project name, version, required Python version, and dependencies in one file.
When you run `pip install -e .`, the `-e` flag means "editable install" — Python
treats the current directory as if it were an installed package, which means
changes you make to the code are immediately reflected without reinstalling.

### What the `.env` file does

Environment variables are how you pass secrets to a running process without
hardcoding them in source code. The `python-dotenv` library reads `.env` on
startup and injects those values into the process environment. The file is in
`.gitignore` so it never enters version control.

### What the hello-Claude check proves

It proves the entire chain: Python is running, the package is installed, the
`.env` is loading, the API key is valid, and Anthropic's servers are reachable.
All of these can fail silently in different ways. Getting a real response from
Claude now means none of those failures are lurking.

---

## Phase 1 — Structured outputs

### What is happening

You write a function that calls the Anthropic API and returns a Python object
with typed fields (`title`, `type`, `plan_text`) — not a string.

### Why this matters more than it looks

The current coordinator receives planning results as a string that looks like:
```
PLAN COMPLETE: title=Add tooltip, type=feature
```
Then it parses that string. This is called a "sentinel" pattern — a magic string
that acts as a protocol. It breaks the moment there's an unexpected newline, a
different word, or a model that paraphrases.

Structured outputs work differently. You define a Pydantic model (a class that
declares what fields exist and what types they should be), then use Anthropic's
tool-use mechanism to force the model to return data in exactly that shape.
Anthropic validates the response against the schema before returning it to you.
The result is that `plan()` either returns a valid `PlanResult` object, or it
raises an exception — there is no middle state where you got "something
plan-shaped but slightly wrong."

### What Pydantic does

Pydantic is a library for data validation. When you define:
```python
class PlanResult(BaseModel):
    title: str
    type: Literal["feature", "fix", "refactor"]
    plan_text: str
```
You're saying: this object must have exactly these three fields, `title` must be
a string, and `type` must be one of those three exact words (not "bug-fix",
not "Feature"). Pydantic enforces this at runtime and raises a clear error if
the data doesn't match.

### Why tool-use for structured output

The Anthropic API's structured output mechanism works by presenting the schema
as a "tool" — the model is told "you must call this tool with these exact
parameters." This causes the model to produce JSON that matches the schema, which
the API validates. It's effectively a way of using the tool-call machinery as a
type-safe return mechanism.

---

## Phase 2 — First LangGraph wrapper

### What is happening

You wrap the `plan()` function in LangGraph decorators (`@task` and
`@entrypoint`) and run it through LangGraph's workflow engine instead of calling
it directly.

### What LangGraph is

LangGraph is a Python library for building stateful, multi-step workflows where
each step may be a LLM call, a tool call, or arbitrary code. The key
abstraction is:

- **`@task`**: a unit of work. Can be async. LangGraph tracks when it was run
  and what it returned.
- **`@entrypoint`**: the top-level function that defines the workflow. It calls
  tasks and coordinates their outputs. The checkpointer is attached here.
- **`thread_id`**: a unique identifier for "one run" of the workflow. Think of
  it like a job ID. All checkpoints for a run are stored under this ID.

### Why nothing changes yet

Functionally, wrapping planning in LangGraph doesn't change what it does — you
call planning, you get a result. The point of this phase is to see that LangGraph
is _just a harness_. It doesn't replace the LLM call; it wraps it in a
system that can save state, resume from interrupts, and produce a trace. The
cognitive work (calling Claude, parsing results) is still in the same place.

### What `MemorySaver` is

`MemorySaver` is an in-memory checkpointer. Checkpoints disappear when the
process exits. It's used here because it requires zero setup. Phase 3 replaces
it with a real database.

---

## Phase 3 — SQLite checkpointer

### What is happening

You replace the in-memory checkpointer with one that writes to a SQLite
database file. Then you run the workflow twice with the same `thread_id` and
observe that the second run doesn't make an API call.

### What the checkpointer does

After every `@task` completes, LangGraph serialises the task's output and writes
it to the checkpoint store, keyed by `(thread_id, step_number)`. On the next
invocation with the same `thread_id`, LangGraph reads the checkpoints and skips
any tasks whose outputs are already stored. This is called **memoisation**.

### Why this replaces `state.json` and `progress.log`

Your current coordinator writes `state.json` to track which step it's on, and
`progress.log` to record what happened. These are two separate files, written by
different code, that can get out of sync. The SQLite checkpointer is a single
source of truth. It stores both what step the workflow is at (state) and what
each step returned (progress), in a format you can query with standard SQL
tools.

### What you see in the database

The `checkpoints` table has rows like: `(thread_id, step_index, task_name,
serialised_output)`. When LangGraph decides whether to re-run a task, it queries
this table. The database is the complete memory of every workflow run.

---

## Phase 4 — Resume from crash

### What is happening

You deliberately terminate a workflow mid-run (Ctrl-C), then restart it with
the same `thread_id`. LangGraph replays only the steps that didn't complete.

### Why this is important

The current coordinator has no crash recovery. If it crashes during
implementation (a common failure — LLM calls time out, file edits fail, API
rate limits hit), you're left with an indeterminate state. You have to read
`progress.log`, figure out where it got to, and either restart from scratch
or manually clean up and re-run from a checkpoint.

With LangGraph checkpointing, restart is free. The workflow reads the
checkpoint, finds the last completed step, and continues from there. Steps that
already succeeded are not re-run. No manual intervention needed.

### The key insight about `None` input on resume

When you resume with `workflow.ainvoke(None, config=...)`, you're saying "don't
start fresh with a new input — continue from where the thread left off." The
`None` is intentional: LangGraph reads the existing state from the database and
resumes from the last uncompleted task.

---

## Phase 5 — LangSmith tracing

### What is happening

By setting the `LANGCHAIN_TRACING_V2=true` environment variable, every workflow
run is automatically recorded in LangSmith. You visit the web UI and explore the
trace.

### What a trace shows

A trace is a structured log of a workflow run. For each step, it records:

- The exact prompt sent to the LLM
- The exact response received
- Token counts (input and output)
- Latency (how long each step took)
- Whether the step succeeded or failed
- Nested structure (which tasks called which)

### Why this is better than log files

Log files tell you what happened. Traces tell you _what was sent to and received
from the LLM_, which is almost always what you need when debugging. "The
planning step failed" is much less useful than "the planning step sent this
prompt, received this malformed JSON, and threw this parse error."

### What you don't need to build

Nothing. The tracing is automatic once the env vars are set. LangSmith hooks
into LangGraph's internal callback system. This phase costs 15 minutes because
you're just learning to read traces, not writing any code.

---

## Phase 6 — The remaining workflow tasks

### What is happening

You build the other four tasks (branch creation, implementation, QA, commit/PR),
one at a time, testing each in isolation before integrating it.

### The LLM-vs-deterministic split

This phase makes a distinction that is easy to miss:

- **Deterministic tasks** (`create_branch_task`, `commit_and_pr_task`) run
  `subprocess.run(["git", ...])` or `subprocess.run(["gh", ...])`. They don't
  call the LLM at all. They just execute shell commands and return structured
  results. These tasks are fast, cheap, and testable.
- **LLM tasks** (`implementation_task`, `qa_task`) call Claude and get
  back structured results. These are probabilistic, slow, and expensive.

Separating these two categories makes the system easier to debug. When
`create_branch_task` fails, it's a Git problem (wrong branch name, network
issue, already exists). When `implementation_task` fails, it's an LLM problem
(bad prompt, model hallucination, token limit). You never have to wonder which
kind of failure you're dealing with.

### Why `implementation_task` needs the Claude Agent SDK

The raw Anthropic API (`messages.create`) is a single-turn call: you send a
prompt, you get a response. Implementation requires the model to do multiple
things: read files, edit files, check the result, maybe edit again. This is
an agentic loop — multiple rounds of tool use until the task is complete.

The Claude Agent SDK (`claude-agent-sdk`) is a Python library that runs this
loop for you. It keeps calling the model with tool results until the model
signals it's done, then returns the final state. You give it a prompt, a list
of allowed tools, and a working directory; it handles the back-and-forth.

### Why QA uses read-only tools

The QA agent's job is to review what was changed, not to change anything itself.
Giving it write access would let it "fix" QA failures by editing the code
directly, bypassing the retry logic. Restricting it to `Read` and `Bash` (for
`git diff`) keeps it honest: it can only look and report.

---

## Phase 7 — The retry loop

### What is happening

You add a loop around implementation + QA that retries up to three times if QA
fails, passing the failure reasons back to implementation as context for the fix.

### Why this lives in the entrypoint and not in a task

The retry loop is _control flow_, not cognition. It decides whether to call
`implementation_task` again — it doesn't do any LLM work itself. Control flow
belongs in the entrypoint (orchestration layer), not inside tasks (cognition
layer). This is the separation the architecture is built around.

### What changes on retries

The first implementation call uses `mode="implement"`. Subsequent retries use
`mode="fix"` and also pass `qa_failures` — the text of what QA found wrong.
This gives the implementation agent context: "you tried this, QA said it was
wrong for these reasons, now fix it."

### What the `for/else` construct does

Python's `for/else` runs the `else` block if the loop completes _without_ a
`break`. In this workflow, `break` happens on `QA PASS`. So if the loop runs
all three attempts without a pass, the `else` block fires and returns a failure
result. This avoids a common bug: forgetting to check whether the loop exhausted
all retries.

---

## Phase 8 — Human-in-loop interrupt

### What is happening

You add an `interrupt()` call after planning that pauses the workflow and waits
for a human response before proceeding.

### What `interrupt()` does mechanically

`interrupt(value)` serialises `value` to the checkpoint store, raises a special
`GraphInterrupt` exception, and stops execution. The workflow is now paused in
the database — it's not running anywhere, it's just a row in `checkpoints.db`
waiting to be resumed.

When someone later calls `workflow.ainvoke(Command(resume="yes"), config=...)`
with the same `thread_id`, LangGraph restores the state, re-enters the task that
called `interrupt()`, and this time the `interrupt()` call returns the resume
value instead of raising an exception. Execution continues from that line.

### The critical rule about side effects

Because `interrupt()` causes its task to re-run from the top on resume, any
code before `interrupt()` runs twice. If "before" includes "create a Git
branch" or "write a file", you now have a duplicate side effect — a double-
created branch, a double-written file.

The rule is: **all side effects must come after `interrupt()`**. Before the
interrupt, only pure reads and LLM calls (which are idempotent from LangGraph's
memoisation perspective). After the interrupt, the writing.

### How this replaces the current approval flow

The current coordinator pauses by stopping and asking the user a question in
the chat. There's no formal mechanism — it just doesn't do the next step until
the user types something. With `interrupt()`, the pause is durable (survives
process restarts), the resume value is typed (the response is a structured
`Command`), and the state is stored in the database so you can inspect exactly
where the workflow is paused.

---

## Phase 9 — Progress logging decision

### What is happening

You decide whether to add a custom progress log file. The recommendation is
to not add one.

### Why this is a full phase

The instinct to add "just a quick progress.log" is strong, and it's wrong. You
already have two sources of truth for workflow state: LangSmith (every step,
every prompt, every token) and the SQLite checkpoint store (every task output,
resumable at any point). Adding a third that tries to summarise the other two
creates a consistency problem. When they diverge — and they will — which one
do you trust?

The lesson: when you already have a complete, queryable audit trail, a
hand-written log file is a liability, not an asset. Only add it if a specific
tool needs to consume it and can't read from the existing sources.

---

## Phase 10 — CLI debug interface

### What is happening

You wrap the workflow in a command-line interface so you can run
`implement-feature "add a tooltip"` from a terminal.

### Why this is separate from the MCP server

The CLI is a debug surface. When something goes wrong with the full Claude
Code + MCP + orchestrator stack, you want to be able to test the orchestrator
in isolation. The CLI lets you invoke the entire workflow — planning, interrupt,
implementation, QA, commit — without Claude Code or the MCP layer being
involved.

This means that if `implement-feature` works in the CLI but fails when invoked
via Claude Code, the bug is in the MCP layer or the Claude Code integration.
If it fails in the CLI, the bug is in the orchestrator itself. The isolation
is what makes debugging fast.

### How it handles the interrupt

The CLI's `run()` function catches `GraphInterrupt`, prints the plan to stdout,
reads a response from stdin with `input()`, and resumes the workflow with that
response. This is exactly what the MCP server does, but in the terminal instead
of through Claude Code. Same workflow, different surface.

---

## Phase 11 — MCP server

### What is happening

You expose the orchestrator as an MCP server — a small HTTP-like service that
Claude Code can call as a tool. The server provides two tools:
`implement_feature` (starts a workflow) and `approve_plan` (resumes it after
the human-in-loop interrupt).

### What MCP is

MCP (Model Context Protocol) is an open protocol for connecting Claude Code
to external services. From Claude Code's perspective, an MCP tool is identical
to a built-in tool like `Read` or `Edit`. Claude Code calls it by name with
arguments, gets back a result, and continues. The fact that the implementation
is a subprocess running a Python server is invisible.

MCP servers communicate over stdin/stdout (for subprocess servers) or HTTP. The
`FastMCP` library provides a decorator-based API for defining tools, similar to
FastAPI for HTTP endpoints.

### How the two tools map to the workflow's structure

`implement_feature` starts a new workflow run. It runs until `interrupt()` fires
at the plan-approval step, then catches the `GraphInterrupt` and returns the
plan to Claude Code along with the `thread_id` needed to resume.

`approve_plan` takes a `thread_id` and a human response. It calls
`workflow.ainvoke(Command(resume=response), ...)` to resume the paused workflow.
If another interrupt fires (e.g., the plan was revised and needs re-approval),
it catches that too and returns the new plan. If the workflow completes, it
returns the final result including the PR URL.

The pattern: interrupt → surface to user → capture response → resume → repeat
until complete.

### Why tool docstrings matter more than usual

The docstring on each `@mcp.tool()` function is sent to Claude as part of the
tool description. Claude reads it when deciding whether and how to call the
tool. A vague docstring ("runs the workflow") means Claude might call it at the
wrong time, with wrong arguments, or not call it when it should. The docstring
is effectively a prompt and should be written with the same care.

### Why the full Python path is required

MCP servers run as subprocesses launched by Claude Code. When Claude Code starts
the subprocess, it doesn't inherit your shell's pyenv configuration, so the
`python` command resolves to the system Python, not your virtualenv. Using the
full absolute path (`/Users/you/.pyenv/versions/env-name/bin/python`) bypasses
pyenv entirely and ensures the subprocess uses exactly the right Python with
exactly the right packages installed.

---

## Phase 12 — Register with Claude Code

### What is happening

You create `.mcp.json` at the project root to tell Claude Code where to find
the MCP server, then optionally add a `/implement` slash command as a shortcut.

### What `.mcp.json` does

When Claude Code starts, it reads `.mcp.json` and launches each server listed
under `mcpServers` as a subprocess. The server runs alongside Claude Code for
the session. Claude Code discovers the tools the server exposes (via the MCP
protocol handshake) and adds them to its tool list. You can verify this with
`/mcp` in the chat.

### What the slash command does

The slash command (`.claude/commands/implement.md`) is a prompt template. When
you type `/implement add a tooltip`, Claude Code substitutes your request into
the template and sends it as a message. The template tells Claude to call
`implement_feature`, show the plan, call `approve_plan`, and loop until
complete. Without the slash command you could still type the same thing
manually — the command is just ergonomic sugar.

### What to do with the old coordinator

Archive `.claude/agents/coordinator.md` by moving it to
`.claude/agents/_archive/`. Don't delete it — it's a reference for the prompts
and logic that informed the new implementation. Once the new orchestrator has
run several successful features end-to-end, the archive copy can be removed.

---

## How the phases fit together

```
Phase 0  — you can call Claude from Python
Phase 1  — you get typed data back from Claude, not strings
Phase 2  — you run that call inside LangGraph (nothing changes yet)
Phase 3  — LangGraph remembers what ran (SQLite replaces state.json)
Phase 4  — LangGraph can recover from crashes (durability proof)
Phase 5  — you can see exactly what happened in every run (LangSmith)
Phase 6  — you build all the workflow steps (the full pipeline exists)
Phase 7  — the pipeline can retry failed steps automatically
Phase 8  — the pipeline can pause and wait for a human
Phase 9  — you decide not to add redundant logging (discipline)
Phase 10 — you can run the pipeline from a terminal (debug surface)
Phase 11 — Claude Code can invoke the pipeline as a tool (MCP)
Phase 12 — the full integration is live and the old coordinator is retired
```

Each phase adds exactly one thing. By design, you can explain what any phase
does in one sentence, because each phase is _about_ one concept.

---

## Concepts reference

| Concept | What it is | Why it's here |
|---|---|---|
| `@task` | A LangGraph decorator marking a unit of work | Makes steps checkpointable and traceable |
| `@entrypoint` | The top-level workflow function | Holds control flow; checkpointer is attached here |
| `thread_id` | Unique ID for one workflow run | Namespaces checkpoints so runs don't collide |
| `MemorySaver` | In-memory checkpoint store | Zero-setup; used in Phase 2 only |
| `AsyncSqliteSaver` | SQLite checkpoint store | Persists across restarts; production checkpointer |
| `interrupt()` | Pause the workflow and wait for a human | Human-in-loop approval mechanism |
| `Command(resume=...)` | Resume a paused workflow | Passes human response back to the workflow |
| `GraphInterrupt` | Exception raised by `interrupt()` | Signals the workflow is paused; caught by caller |
| Pydantic `BaseModel` | Python class with typed, validated fields | Replaces sentinel strings with structured data |
| `FastMCP` | Library for building MCP servers | Exposes Python functions as Claude Code tools |
| MCP | Model Context Protocol | Standard for Claude Code ↔ external service integration |
| Claude Agent SDK | Runs an agentic loop (multiple tool-use turns) | Needed for implementation (file reads + edits) |
| LangSmith | Observability platform for LLM workflows | Records every prompt, response, token, and latency |

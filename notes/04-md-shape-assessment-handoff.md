# Md-shape assessment & refactor — a skill + an agent that work together

**Verdict:** Build both, in the right order. A **skill** holds the criteria
framework. An **agent** uses the skill to actually refactor a target file
into the right layers (script / skill / agent / hook). The skill is also
useful on its own for quick "should this be a skill or an agent?" questions
during design.

## The two parts

### Part 1 — The skill (`.claude/skills/assess-md-shape.md`)

Holds the framework: how to look at a `.md` file and decide which parts
belong where. The skill is *advice for the current model*, loaded into
context. Use it when you're designing a new file or sanity-checking an
existing one.

### Part 2 — The agent (`.claude/agents/md-shape-refactor.md` or a coordinator-routed planner)

Does the actual refactor: reads a target file, applies the skill's criteria,
splits it across multiple files, creates the new files, and updates anything
that referenced the original. The agent **reads the skill** as its framework —
it doesn't re-invent the criteria.

## Why this is two artifacts, not one

This is the DRY-across-agents pattern. The criteria framework belongs
somewhere that multiple consumers can read it — you'll use it manually in
design conversations, the refactor agent will use it, and a future
batch-audit agent could use it too. Putting it in a skill keeps it in one
place.

The agent is the worker that has to:
- Read multiple files (target + dependencies)
- Write multiple files (the splits)
- Trace references across `.claude/` and `.workflow/`
- Maintain cross-file consistency after the refactor

That's substantial mutation across the codebase — it needs fresh context
(reason 1 for agent), Write/Edit access (reason 2 — tools), and benefits
from the coordinator's plan-approval gate. So it's genuinely agent-shaped.

## Why the agent isn't *just* the skill

When we first discussed this, the natural answer was "make it a skill."
That was right *if* the scope was assessment-only — produce a recommendation
the user can read and act on manually. But you escalated the scope to
"identify components, create the new files, update dependencies, ensure
the agent still works." That ticks every agent heuristic:

| Heuristic | Assessment-only | Full refactor |
|---|---|---|
| Needs fresh context? | No | **Yes** — heavy reading and writing |
| Different tools? | No (just Read) | **Yes** — Read, Grep, Write, Edit |
| Acts or recommends? | Recommends | **Acts** |
| Cross-file invariants? | No | **Yes** — references must stay consistent |
| Costly to undo? | No | **Yes** — multiple files written |

Three+ of these flip. That's agent territory.

## The architectural choice — two options

### Option A: Standalone refactor agent

One self-contained agent does everything. Simpler to build. New file at
`.claude/agents/md-shape-refactor.md`.

```yaml
---
name: md-shape-refactor
description: Split a .claude/ markdown file into the right layers (script,
  skill, agent, hook), update dependencies, and report changes.
tools: Read, Grep, Glob, Write, Edit, Bash
model: opus
---
```

Inside the system prompt:
1. Read target file (path passed in)
2. Read `.claude/skills/assess-md-shape.md` (criteria reference)
3. Classify each component of the target
4. Trace references: `grep -r "<target-filename>" .claude/ .workflow/`
5. Emit a plan sentinel and wait for approval
6. On approval: execute writes
7. Emit result sentinel

### Option B: Reuse your coordinator with a specialised planner (recommended)

Add a sibling to your existing planner:

```
.claude/agents/
├── coordinator.md         (unchanged)
├── planning.md            (existing — for index.html changes)
├── planning-md-shape.md   (new — for .claude/ refactors)
├── implementation.md      (unchanged, hopefully generic enough)
├── qa.md                  (unchanged, hopefully generic enough)
└── pr.md                  (unchanged)
```

Add a routing line at the top of `coordinator.md`'s step 1:
> If the request targets a file under `.claude/`, invoke `planning-md-shape`.
> Otherwise invoke `planning`.

**Why this is better:**
- You get plan approval for free (coordinator already does this).
- You get the QA loop for free (qa just needs to learn about `.claude/` files).
- You get a reviewable PR per refactor — easy to revert if the split is wrong.
- It stress-tests whether your coordinator is genuinely generic or accidentally
  Bostadskalkyl-specific. Both outcomes teach you something.

**Cost:** you may need to generalise `implementation.md` and `qa.md` slightly,
or branch on file path inside them. If the branching gets ugly, fall back to
Option A — that *is* the learning ("my coordinator was less generic than I
thought, here's exactly where").

## Recommended build order

Resist the urge to write the agent first. Do this:

1. **Write the skill** (`.claude/skills/assess-md-shape.md`). Spend time on
   the criteria — they're the foundation everything else uses.

2. **Run the skill manually on `qa.md`.** Invoke it in a Claude session
   while reading qa.md. Does its verdict match what you'd do by hand? If not,
   refine the skill until it does. The skill is your *executable spec* for
   the refactor work.

3. **Hand-refactor qa.md** following the skill's verdict (see
   [02-qa-agent-handoff.md](./02-qa-agent-handoff.md) — the verdicts will
   match). This gives you a reference implementation: "this is what good
   output looks like."

4. **Only then write the agent** that automates what you did by hand. You'll
   know exactly what success looks like, which makes debugging the agent
   tractable instead of recursive.

This order matters. If you write the agent first you'll spend your time
unable to tell whether the agent is broken *or* whether the framework
underneath it is wrong.

## What the skill should contain (sketch)

```markdown
---
name: assess-md-shape
description: Decide whether a .md file in .claude/ should be a skill, agent,
  slash command, hook, or standalone script. Use when designing or reviewing
  any file under .claude/agents/, .claude/skills/, or .claude/commands/.
---

# Assessing the shape of a Claude config file

Read the target file. Work through the checks in order — the first "yes"
determines the shape for that component.

## 1. Is the work deterministic and procedural?
If a component is mostly shell commands, grep patterns, file scans, or
pattern checks with clear pass/fail outputs → that component is a **script**
(or **hook** if it should fire automatically on a tool event).

Signals: literal bash, grep patterns, exit codes, file paths, no judgment.

## 2. Does the work need a fresh context window?
Reasons it might:
- Bias-prevention (reviewer shouldn't have written what they review)
- Context-window protection (heavy reading would pollute main)
- Different model (cost or capability)
- Different tool scope (security: only this thing can git-push)
- Parallelization (multiple instances at once)

If at least one applies → **agent**.

## 3. Is this an explicit user entry point with a short command?
→ **slash command** wrapping whatever is underneath.

## 4. Otherwise → **skill**.

## Output format

### Per-component classification
For each major section of the target file, output:
- Section name (from the target's headings)
- Verdict: script | skill | agent | hook | keep-here
- Reasoning: one sentence citing which heuristic applied

### Suggested file structure
List the files to create/modify/delete and what goes in each.

### Dependency impact
Files that reference the target — what needs updating.

### Anti-recommendations
Common mistakes the user might make ("don't keep this as an agent just
because the framework is structured — structure is orthogonal").
```

## What the agent should do (sketch)

When invoked with `TARGET: .claude/agents/qa.md`:

1. Read the target file
2. Read `.claude/skills/assess-md-shape.md` (criteria)
3. Classify each major section per the skill
4. Run `grep -r "qa.md\|qa agent\|invoke.*qa" .claude/ .workflow/` to find
   references
5. Compose a refactor plan: new files to create (with contents), files to
   modify (with diffs), files to leave alone
6. Emit `REFACTOR PLAN: <summary>` and stop — wait for approval
7. On approval: execute the writes
8. Emit `REFACTOR RESULT: <files-changed-list>`

If you go with Option B (coordinator-routed), step 6 just emits the same
`PLAN COMPLETE:` sentinel as your existing planner, and the coordinator's
existing approval flow handles it.

## Action items

1. Write `.claude/skills/assess-md-shape.md`. Test it manually by asking
   Claude to apply it to `qa.md`. Refine until the verdict matches what you'd
   do by hand.
2. Hand-refactor `qa.md` per the verdict (cross-reference
   [02-qa-agent-handoff.md](./02-qa-agent-handoff.md)). This is your
   reference implementation.
3. Decide between Option A and Option B. If unsure, start with A — it's
   smaller and you can always migrate to B later.
4. Write the agent.
5. Test on a second file (e.g. one of the inspirational skills you have
   that's unused — `refactor.md` or `docs.md`). If it makes sensible
   recommendations on a file it's never seen, the framework is solid.

## What to watch for

- **Don't skip step 2 (hand-refactor first).** Building the automation before
  you know what good output looks like is the #1 way to waste time on agent
  development.
- **The skill is the contract.** If you find yourself disagreeing with the
  skill's verdict on a real file, update the *skill*, not the agent. The
  skill is the executable spec.
- **Resist scope creep on the agent.** It refactors `.claude/` files. It
  does not refactor index.html, run tests, or open PRs (the coordinator
  handles that). Keep the agent narrow.
- **Test on diverse inputs.** A refactor agent that only works on `qa.md` is
  useless. Run it against `planning.md`, `pr.md`, and the unused skills
  before you trust it.

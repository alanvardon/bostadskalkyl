# qa.md — split mechanical work into a script, keep judgment as an agent

**Verdict:** Refactor. Extract the deterministic checks into a script, leave
qa.md as a thinner agent that focuses on judgment-only review.

## Context

`qa.md` currently does two kinds of work mixed together:

1. **Mechanical checks** — `node --check` for syntax, grep for `.className =`,
   grep for hex colours, verify new IDs appear in `CURRENCY_IDS`/`NUMBER_IDS`/
   `TEXT_IDS`, verify localStorage keys start with `bostadskalkyl_`.
2. **Judgment checks** — did the implementer follow every step of the plan's
   Implementation order? Was any unrelated code touched? Was a derived value
   actually placed inside `calc()` and not somewhere it looks like it is?

The mechanical half doesn't need a model. The judgment half does.

## Why the split

**Mechanical work belongs in a script.** A check that asks "does pattern X
appear in the diff?" is what `grep` exists for. Putting it inside an agent's
system prompt means you pay a model round-trip and risk the model
mis-interpreting the check. Scripts are deterministic, testable, runnable
outside Claude, and version cleanly.

**Judgment work belongs in an agent — specifically *this* agent.** Comparing
plan intent against diff requires reading both with understanding. Crucially,
the qa agent benefits from **fresh context** — it shouldn't have just written
the code it's reviewing. That bias-prevention is the textbook reason to use
an agent.

So: extract the script, thin the agent, win on both axes.

## Concrete plan

### Files to create

**`scripts/static-checks.sh`** — runs all mechanical checks. Exits 0 on pass,
non-zero on fail, prints violations to stderr.

Contents (sketch):
- Extract inline JS from index.html, run `node --check`
- `git diff HEAD` and grep added lines for `\.className\s*=`
- Grep added lines for hex colours outside `:root`
- For each new `id=` in the diff: verify it's in the right ID array
- Verify any new localStorage key starts with `bostadskalkyl_`

**`.claude/skills/static-checks.md`** — a thin skill that tells the model when
to run the script and how to interpret the output. ~10 lines.

```markdown
---
name: static-checks
description: Mechanical correctness checks for index.html. Run before declaring
  implementation complete or as the first step of QA review.
---

Run `bash scripts/static-checks.sh`. Exit 0 means pass; non-zero means fail
and stderr contains a list of violations.

On non-zero:
- Read each violation
- Fix it in index.html (if invoked from implementation)
- OR report it as ✗ FAIL (if invoked from qa)
```

### Files to modify

**`.claude/agents/qa.md`** — remove the syntax-check section, remove the
mechanical items from the checklist (Code quality, Data persistence). Keep
only:
- Plan adherence (every step executed, nothing extra touched)
- Calculation integrity (calc() intact, derived values inside it semantically)
- Modal pattern adherence (if a modal was added)

Add at the top of "When invoked":
> 2a. Run the static-checks skill at .claude/skills/static-checks.md. Record
> each result. Then proceed to plan adherence checks.

**Optional: `.claude/agents/implementation.md`** — add to the "When done" section:
> 2a. Run the static-checks skill before emitting SUMMARY. If any check fails,
> fix it. Do not declare done until the script exits 0.

This is the "shift-left" pattern — catch mechanical failures earlier, save a
fix-loop iteration.

## What "mechanical vs judgment" actually means

Mechanical = a yes/no answer that doesn't require understanding the code's
meaning. A spell-checker is the analogy.

Judgment = comparing intent against result, or reasoning about semantics.

Examples to anchor the distinction:

| Check | Mechanical or judgment? | Why |
|---|---|---|
| "Does the file parse?" | Mechanical | `node --check` returns yes/no |
| "Did anyone write `.className =`?" | Mechanical | grep |
| "Are new derived values inside calc()?" | **Borderline** — knowing what's "inside calc()" is mechanical (brace counting), but "is this a derived value?" is judgment |
| "Did the implementer do step 4 of the plan?" | Judgment | requires reading both plan and diff |
| "Was unrelated code touched?" | Judgment | requires understanding "related" |

When a check is borderline, default to script + leave a judgment confirmation
in the agent. The script catches the easy violations; the agent catches the
ones that require reading meaning.

## Action items

1. Write `scripts/static-checks.sh`. Test it manually on a recent diff.
2. Write `.claude/skills/static-checks.md`. Keep it thin.
3. Thin out `qa.md`. Remove the mechanical checklist items and the syntax
   check section. Add the skill invocation step.
4. Optionally update `implementation.md` to call the skill as a self-gate.
5. Test the full workflow end-to-end on a small feature to verify nothing
   broke.

## What to watch for

- **Don't put bash logic inside the skill itself.** Skills are for telling the
  model *when* to do something and *how to interpret* it. The doing belongs
  in the script.
- **Resist re-inflating qa.md** when you find a new mechanical check you want.
  Add it to the script instead. The script is the right home for any new
  deterministic check, forever.
- **The implementation self-gate is optional but valuable.** It's the
  cheapest place to catch mechanical regressions — before QA even runs.

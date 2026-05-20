# pr.md — split into two skills

**Verdict:** Split into two skills. The coordinator invokes them at the
appropriate workflow points. Delete pr.md.

This verdict is the *revised* answer. The original recommendation in this
doc was "keep as an agent" — see [How this recommendation evolved](#how-this-recommendation-evolved)
below for the full arc, which is itself the most important lesson in this
doc.

## Context

`pr.md` currently has two modes:

- **Mode 1 (create-branch)** — verifies clean tree, switches to main, derives
  a kebab-case branch name, runs `git checkout -b`.
- **Mode 2 (commit-and-pr)** — verifies branch, composes commit message,
  pushes, opens a PR via `gh`.

Almost everything in both modes is mechanical: deterministic git/gh commands
plus a small string transform. The only judgment is inferring `<scope>` from
the diff in Mode 2 and deciding whether to include the optional "why" bullet
in the commit body.

## Why two skills, not an agent

Apply the four-reasons-to-use-an-agent heuristic:

| Criterion | Applies to pr.md? |
|---|---|
| Needs fresh context (bias-prevention, context-window protection) | No |
| Needs different tools / scoped capability | No — permissions are the real enforcement layer |
| Needs a different model | No |
| Needs parallelisation | No |

Zero of four. The work is mechanical, doesn't need isolation, doesn't benefit
from a different model, doesn't parallelise. By the heuristic this is a skill.

Mode 1 and Mode 2 are invoked at completely different workflow points (start
vs. end) and have nothing in common except that they both shell out to git.
So **two skills, not one** — keeping them separate means each is loaded into
context only when needed.

## The shape

### New files

**`.claude/skills/create-feature-branch.md`** — invoked at the start of the
workflow. Holds the Mode 1 logic: clean-tree check, switch to main, pull,
kebab-case the title, check the branch doesn't exist, `git checkout -b`,
emit the `BRANCH RESULT:` sentinel.

**`.claude/skills/commit-and-open-pr.md`** — invoked at the end of the
workflow. Holds the Mode 2 logic: branch verification, empty-diff guard,
compose the commit message from inputs, `git add`/`commit`/`push`, run
`gh pr create` with the heredoc template, emit `PR_URL:`.

### File to delete

**`.claude/agents/pr.md`** — gone. Its content is split across the two skills.

### File to modify

**`.claude/agents/coordinator.md`** — steps 2 and 5 currently invoke the
`pr` sub-agent in Mode 1 and Mode 2 respectively. Change them to invoke the
two skills directly. The coordinator already has Bash, so it can run the
underlying commands as part of following the skill's instructions.

The sentinel contract barely changes — `BRANCH RESULT:` and `PR_URL:` are
still emitted, just by the coordinator inline rather than by a sub-agent.
Update the logging contract table in coordinator.md accordingly (the writer
for those sentinel-confirmation lines is still "coordinator," but the
"emitted" lines from the pr agent disappear).

## How this recommendation evolved

This is the most important part of the doc. The arc — first answer, why it
got overridden, why that override was wrong — is the actual lesson.

### First-pass: two skills

Apply the heuristic *"does this need to think?"* and pr.md mostly fails it.
Mode 1 is `git status` + a kebab-case transform + `git checkout -b`. Mode 2
is `git commit` + `git push` + `gh pr create` with a template. The only
judgment is inferring `<scope>` from the diff in Mode 2.

By that reading: extract two skills, each thin, each called by the
coordinator. The coordinator already has Bash. No agent needed. This is
internally consistent and correct.

### Detour: "but security" — keep it as an agent

The argument was: skills loaded into the coordinator mean the coordinator
becomes an actor that can git-push. The agent boundary confines push
capability to a single named actor — auditable, scoped, defence in depth
alongside the permissions allowlist.

This *sounded* defensible but was wrong, because it conflated two
fundamentally different things:

| Thing | What enforces it |
|---|---|
| **Enforcement** — *can this command actually run?* | `settings.json` permissions, hooks |
| **Organisation** — *where in the system does the logic live?* | Agent / skill / script boundaries |

The agent boundary doesn't *enforce* anything at the command level. If
`git push --force` is denied in settings.json, it's denied regardless of
whether a skill invoked it, an agent invoked it, or the model typed it
directly. Permissions don't care about which actor pulled the trigger.

The claim that "skills spread capability through the system" was also weak.
Skills don't auto-load into random subagents. The `planning` agent has no
reason to invoke a `commit-and-open-pr` skill — its scope is producing a
plan, full stop. The model doesn't randomly grep skills folders looking for
things to do. Each subagent has its own scoped system prompt.

So the agent boundary was buying organisational clarity (one greppable home
for git logic), not security. Dressing that up as a security argument is a
common mistake — and the more important version of the mistake is using
it to justify reaching for agents in *other* projects where the work doesn't
warrant one.

### Final: back to two skills, for the right reasons

The work is mechanical, no agent criterion applies, the smaller artifact is
correct. The organisational benefit of "one file for git logic" still
exists, but it exists equally well in two skill files in
`.claude/skills/` — and the skills are lighter than an agent
because there's no model round-trip.

## The principle this teaches

> Distinguish enforcement from organisation. Permissions and hooks enforce
> what can run. Agent/skill/script boundaries organise where the logic
> lives and how it's invoked. Conflating them leads to over-using agents
> as if they were security primitives.

If you ever catch yourself reaching for an agent boundary "for security"
without the work also benefiting from one of the four agent criteria
(fresh context / tools / model / parallelisation), stop and ask: *is this
actually a permissions question?* The answer is usually yes — and the
right tool is a deny rule, a hook, or a path-pinned allowlist entry, not
a subagent.

## What still does the security work

The script-bypass concern you originally raised is real — but the defences
are unchanged regardless of whether pr.md is an agent or two skills:

1. **Path-pinned allowlist** — `Bash(bash scripts/static-checks.sh)` exactly,
   not `Bash(bash scripts/*)`.
2. **Deny writes to script and config dirs** — `Write(scripts/**)`,
   `Edit(scripts/**)`, `Write(.claude/**)`, `Edit(.claude/**)`.
3. **PreToolUse hook** that inspects script contents
   (see [03-pretool-script-inspector-hook-handoff.md](./03-pretool-script-inspector-hook-handoff.md)).
4. **block-secrets as a PreToolUse hook** on Write/Edit.

These all work the same whether `commit-and-open-pr` lives in a skill file
or an agent file. The migration to skills doesn't weaken any of them.

## Migration plan

Order the work small-to-large to minimise risk:

1. **Read the existing pr.md carefully.** Note exactly what each step does
   and which sentinels it emits.
2. **Write `.claude/skills/create-feature-branch.md`.** Translate Mode 1
   directly. Keep the `BRANCH RESULT:` sentinel format identical.
3. **Write `.claude/skills/commit-and-open-pr.md`.** Translate Mode 2
   directly. Keep the `PR_URL:` and `COMMIT RESULT:` sentinel formats
   identical.
4. **Modify `coordinator.md` step 2** to invoke the create-feature-branch
   skill instead of `pr` Mode 1. The coordinator now runs the git commands
   itself by following the skill's instructions.
5. **Modify `coordinator.md` step 5** to invoke the commit-and-open-pr
   skill instead of `pr` Mode 2.
6. **Update the logging contract table in coordinator.md.** The `pr emitted`
   lines disappear. The `coordinator confirmed` and `stage` lines stay,
   because the coordinator still observes the sentinels — they just come
   from inline output now, not from a sub-agent.
7. **Delete `.claude/agents/pr.md`.**
8. **Run an end-to-end test on a small feature** to verify the workflow
   still completes cleanly. Check `progress.log` looks sensible.

## Is the migration worth doing?

The cost is real and the current shape works. The reason to do it anyway
is **pedagogical**:

- You'll feel the difference between *delegating to a sub-agent* and
  *invoking a skill inline*. That tactile sense is what makes the
  skill-vs-agent decision automatic in future work.
- It stress-tests whether your coordinator is genuinely generic. If
  absorbing the git-flow logic via skills is clean, the orchestration layer
  is solid. If it's awkward (the sentinel contract assumes a sub-agent
  emits, the log writers assume separate identities), that's a useful
  crack to find.

If this were a production project with deadlines, leave it alone — the
existing agent works, and migration churn isn't worth it for a stylistic
preference. In your context (learning, deliberately over-engineered),
**migrate**.

## What to watch for

- **Don't reintroduce the security framing as you migrate.** If you find
  yourself missing the agent boundary, ask honestly: do you actually need
  it for one of the four reasons, or do you just want the organisational
  clarity? If it's the latter, the two skill files give you that.
- **Keep the sentinel formats identical.** Coordinator parses them; any
  drift breaks the workflow. The literal strings `BRANCH RESULT: CREATED — `
  and `PR_URL: ` should not change.
- **Verify the logging contract still holds.** `progress.log` is the source
  of truth — if the migration accidentally drops a log line, future-you
  can't replay state.
- **If the migration feels harder than expected**, that's data. Note what
  was hard. The likely culprits are (a) the coordinator's sentinel contract
  silently assuming a sub-agent's output stream, or (b) the logging contract
  assuming separate writers. Either is a sign your orchestration layer
  isn't quite as generic as it looked — useful information either way.

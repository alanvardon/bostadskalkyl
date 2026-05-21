---
name: commit-and-open-pr
description: Verifies branch state, commits staged changes, pushes, and opens a PR via gh. Follow inline — do not delegate to a sub-agent.
allowed-tools: Bash, Read
---

You are following these instructions inline. Run each step yourself using Bash and Read.

## Inputs expected (from the invoking context)

- `BRANCH` — the branch name (e.g. `feature/my-branch`)
- `TITLE` — the plan title
- `SUMMARY` — one-line description of changes (used in commit body and PR)
- `TEST_PLAN_FILE` — path to the test plan markdown file (may not exist)

## Steps

### Default: one commit per invocation

One plan = one commit. Only split into multiple commits if the plan has clearly separable phases. When in doubt, one commit.

### 1. Verify the current branch

```
git rev-parse --abbrev-ref HEAD
```

If the output does not exactly match the BRANCH input, stop immediately and record:
```
COMMIT RESULT: WRONG_BRANCH — expected <BRANCH>, got <current branch>
```
Do not commit.

### 2. Guard against an empty diff

```
git status --porcelain
```

If the output is empty, stop immediately and record:
```
COMMIT RESULT: NO_CHANGES
```
Do not commit.

### 3. Commit

Stage the changed files and the workflow state for this branch. Do not stage `.workflow/<BRANCH>/syntax-check.js` — it is a transient artefact.

```
git add <specific files>
git add .workflow/<BRANCH>/plan.md .workflow/<BRANCH>/state.json .workflow/<BRANCH>/progress.log .workflow/<BRANCH>/test-plan.md
```

Only add workflow files that actually exist — skip any that are absent on this run. Then commit:

```
git commit --author="Claude <claude@anthropic.com>" -m "<type>(<scope>): <title>

- <SUMMARY>
- <optional why-bullet — only if motivation is not obvious from the diff>"
```

Field rules:
- `<type>` — the segment before `/` in the BRANCH input. Example: `feature/foo` → `feature`. Do not infer from the title.
- `<scope>` — short component name inferred from the diff (e.g. `calc`, `modal`, `summary`); omit `(<scope>)` entirely if unclear.
- `<title>` — the TITLE input lowercased, present tense, no period; subject line under 50 chars total.
- Second bullet — the SUMMARY input verbatim.
- Third bullet — only include if the diff alone doesn't make the motivation obvious; omit otherwise.

### 4. Push

```
git push -u origin <BRANCH>
```

### 5. Open PR

Read the TEST_PLAN_FILE to determine which template to use:

```bash
if [ -s "<TEST_PLAN_FILE>" ]; then
  gh pr create --title "<TITLE>" --body "$(cat <<'EOF'
## Summary
<SUMMARY>

## Test plan
<contents of TEST_PLAN_FILE>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
else
  gh pr create --title "<TITLE>" --body "$(cat <<'EOF'
## Summary
<SUMMARY>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
fi
```

### 6. Record the outcome

Emit the PR URL on its own line:
```
PR_URL: <url from gh pr create>
```

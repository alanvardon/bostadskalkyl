---
name: create-feature-branch
description: Verifies a clean working tree, switches to main, derives a kebab-case branch name from a title and type, and creates the branch. Follow inline — do not delegate to a sub-agent.
allowed-tools: Bash
---

You are following these instructions inline. Run each step yourself using Bash.

## Inputs expected (from the invoking context)

- `TITLE` — the plan title (plain text)
- `TYPE` — one of: `feature`, `fix`, `refactor`, `docs`, `chore`

## Steps

1. **Check the working tree is clean:**
   ```
   git status --porcelain
   ```
   If the output is non-empty, stop immediately and record:
   ```
   BRANCH RESULT: DIRTY — <list of uncommitted files>
   ```
   Do not continue.

2. **Switch to main and pull the latest:**
   ```
   git checkout main
   git pull
   ```
   If either command exits non-zero, stop immediately and record:
   ```
   BRANCH RESULT: CANNOT_REACH_MAIN — <reason from the failing command>
   ```
   Do not continue.

3. **Derive the branch name:** `<TYPE>/` + the TITLE converted to lowercase kebab-case, truncated to 50 characters (the slug only, not counting the type prefix).
   - Example: title "Stress test for variable rate scenario", type "feature" → `feature/stress-test-for-variable-rate-scenario`
   - Example: title "LTV calculation rounding error", type "fix" → `fix/ltv-calculation-rounding-error`

4. **Check if the branch already exists:**
   ```
   git branch --list <derived-branch-name>
   ```
   If the output is non-empty, stop immediately and record:
   ```
   BRANCH RESULT: EXISTS — <derived-branch-name>
   ```
   Do not create the branch.

5. **Create the branch from main:**
   ```
   git checkout -b <derived-branch-name>
   ```

6. **Record the outcome:**
   ```
   BRANCH RESULT: CREATED — <derived-branch-name>
   ```

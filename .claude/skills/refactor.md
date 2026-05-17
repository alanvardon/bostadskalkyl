---
name: refactor
description: Refactor code while preserving behavior. Use when user mentions 
  "refactor", "clean up", "simplify", or "restructure".
allowed-tools: Read, Write, Edit, Bash(npm test *), Bash(npx tsc *)
---

1. Read the target file(s) completely
2. Run existing tests to establish baseline (all must pass)
3. Plan refactoring changes WITHOUT changing external behavior
4. Apply changes incrementally, one logical step at a time
5. Run tests after EACH step
6. Run type check after final step

Refactoring targets (in priority order):
- Extract duplicated code into shared functions
- Simplify complex conditionals
- Reduce function length (under 30 lines ideal)
- Improve naming clarity
- Remove dead code
- Fix type safety issues

Rules:
- NEVER change function signatures without checking all callers
- NEVER change behavior, only structure
- If tests fail after a change, revert and try a different approach
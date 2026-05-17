---
name: review
description: Review code for bugs, security issues, and style violations. 
  Use when reviewing PRs, checking code quality, or when user mentions 
  "review", "PR", "code quality".
allowed-tools: Read, Grep, Glob, Bash(git diff *)
---

Review the current diff or specified files for:

1. **Bugs**: logic errors, off-by-one, null handling, race conditions
2. **Security**: OWASP Top 10, hardcoded secrets, SQL injection, XSS
3. **Performance**: N+1 queries, unnecessary re-renders, blocking calls
4. **Style**: naming conventions, dead code, TODOs left behind

Output format:
- Group findings by severity: CRITICAL / WARNING / INFO
- Each finding: file, line, issue, suggested fix
- End with a summary: "X critical, Y warnings, Z info"

If no diff exists, ask which files to review.
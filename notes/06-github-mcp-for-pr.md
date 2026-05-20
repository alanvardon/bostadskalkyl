# GitHub MCP for pr.md

**Verdict:** Low priority. `gh` already does the job cleanly; the upside
is marginal.

## What pr.md does today

Mode 2 (commit-and-pr) shells out to `git push` and `gh pr create` with
a HEREDOC body. Mode 1 (create-branch) uses only `git`. Both are pure
shell — no GitHub-side judgment.

## What GitHub MCP would change

It would let pr (or another agent) call structured tools instead of
parsing CLI output:
- `create_pull_request` returns a JSON object — no string-scraping a URL
- `list_pull_requests`, `get_pull_request_comments` — needed *only if*
  agents start reacting to PR review comments
- `add_comment`, `merge_pull_request` — only if we want auto-merge or
  auto-reply flows

For the current pr.md scope (create branch, commit, push, open PR), the
`gh` CLI is equivalent and already works.

## Where it could actually pay off

Not in pr.md — in a future **review-handler** flow:
- on PR review comment, an agent reads the comment, applies the fix,
  pushes
- agent replies "fixed in <sha>" via `add_comment`

That workflow benefits from structured access (filter unresolved
comments, paginate, etc.), which is awkward via `gh api`.

## Tradeoffs / risks

- **Permissions surface.** GitHub MCP needs a token. Scope it to the
  single repo, no admin.
- **Two ways to do the same thing.** If we add the MCP but keep `gh` in
  pr.md, future contributors won't know which to use. Pick one per
  workflow.

## Rough plan

Defer until a concrete workflow needs structured access (review-comment
handler is the obvious candidate). When that arrives:
1. Install GitHub MCP, scope token to this repo
2. Build the new agent on top of it
3. Leave pr.md on `gh` — no need to migrate

## Related

- [[01-pr-agent-handoff]] — current pr.md scope

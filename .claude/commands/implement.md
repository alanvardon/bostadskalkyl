---
description: Run the LangGraph orchestrator on a feature request
---

Use the `implement_feature` MCP tool from the orchestrator server with
the user's request: $ARGUMENTS

The tool returns `{"status": "awaiting_approval", "thread_id": ..., "plan": ...}`.
Show the plan's `plan_text` to the user in a clearly formatted block,
then ask whether they approve or want changes.

When the user replies, call `approve_plan` with the same `thread_id`
and their response:
- If they approve, pass `"yes"` as the response.
- If they want changes, pass their feedback verbatim — the planner will
  regenerate the plan with the feedback incorporated, and you'll get
  another `awaiting_approval` to surface for review.

Loop this approval cycle until `approve_plan` returns a status of
`"succeeded"` (with a `pr_url`) or `"failed"` (the QA loop exhausted
three attempts). Surface the result to the user — the PR URL on
success, the QA failures on failure.

Do NOT call `implement_feature` a second time to "retry" — that starts
a fresh workflow with a new thread_id and loses the user's review
context. Always continue an in-flight run via `approve_plan` against
the original thread_id.

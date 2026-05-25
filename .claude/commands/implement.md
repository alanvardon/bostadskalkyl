---
description: Run the LangGraph orchestrator on a feature request
---

Use the `implement_feature` MCP tool from the orchestrator server with
the user's request: $ARGUMENTS

The tool returns `{"status": "awaiting_approval", "thread_id": ..., "plan": ...}`.
Show the plan's `plan_text` to the user in a clearly formatted block,
then ask whether they approve or want changes.

**Always surface the `thread_id` in your reply to the user — on every
message in this flow, not just the first one.** Phase 15 added a
`resume_run` MCP tool that needs the thread_id to recover from
mid-task failures (e.g. `git push` auth error, gh not authenticated).
If the user only sees the id once and the run fails three turns
later, they can't recover without scrolling back. Include it as a
small footer like "thread_id: run-xxxxxxxx" on every assistant turn
in this conversation.

When the user replies, call `approve_plan` with the same `thread_id`
and their response:
- If they approve, pass `"yes"` as the response.
- If they want changes, pass their feedback verbatim — the planner will
  regenerate the plan with the feedback incorporated, and you'll get
  another `awaiting_approval` to surface for review.

Loop this approval cycle until `approve_plan` returns a status of
`"succeeded"` (with a `pr_url`) or `"failed"` (the QA loop exhausted
three attempts). Surface the result to the user — the PR URL on
success, the QA failures on failure. Include the `thread_id` in
either case.

**If `approve_plan` raises an error** (e.g. push failed, gh pr create
failed): the workflow stalled mid-task but the work done so far is
preserved in the checkpointer. Tell the user what failed, surface the
`thread_id`, and explain they can recover by asking you to run
`resume_run` with that thread_id after they've fixed the underlying
issue (network restored, gh auth fixed, etc.). Do NOT auto-retry by
calling `implement_feature` again — that starts a fresh workflow with
a new thread_id and abandons the work already done.

Do NOT call `implement_feature` a second time to "retry" mid-flow —
that starts a fresh workflow with a new thread_id and loses the
user's review context. Always continue an in-flight run via
`approve_plan` (for plan revisions) or `resume_run` (for failed
tasks) against the original thread_id.

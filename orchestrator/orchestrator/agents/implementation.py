"""Implementation agent — runs Claude Agent SDK in a loop to edit files.

This is the first task that needs the *agent loop* rather than a single
LLM call. Why: implementation requires reading files, deciding what to
change, editing, re-reading, possibly running checks, iterating. That's
the agent harness pattern, and the Claude Agent SDK is what gives it to
us in Python (same loop Claude Code uses, exposed as a library).

The structured-output story differs from planning.py:
  - planning.py uses tool-use-as-structured-output on a single
    messages.create call (force tool_choice, parse tool input)
  - implementation needs the agent to run many turns before producing
    its final result. So instead of forcing tool_choice on the model,
    we *give the agent a custom MCP tool* called
    `emit_implementation_result`. The agent calls it once when it's
    done. We capture the args via a closure into a holder dict.

Same conceptual win — no sentinel parsing — different mechanism because
the agent loop is different shape.
"""

from dotenv import load_dotenv

load_dotenv()

import asyncio
import sys

from anthropic import AsyncAnthropic
from claude_agent_sdk import (
    ClaudeAgentOptions,
    create_sdk_mcp_server,
    query,
    tool,
)
from pydantic import BaseModel

from orchestrator.agents.planning import PlanResult
from orchestrator.git_ops import REPO_ROOT


# Adapted from .claude/agents/implementation.md. Key edits from the
# coordinator-era version:
#   - File-path inputs (PLAN_FILE, TEST_PLAN_FILE, etc.) removed — we
#     pass the plan directly via the user message
#   - Logging-to-file section removed — LangSmith captures the trace
#   - SUMMARY: sentinel section removed — replaced by the MCP tool
#   - "Do not commit / push / create a branch" instruction kept
#     (still true, just enforced by tool allowlist now too)
#
# Everything else — CLAUDE.md, rules, escape hatch, "When done" — ports
# almost verbatim.
IMPLEMENTATION_SYSTEM_PROMPT = """\
You are an implementation agent for Bostadskalkyl, a Swedish house purchase calculator. You receive an approved plan and execute it precisely. You do not deviate from the plan. You do not commit. You do not push. You do not create branches — the orchestrator handles all git operations around your work.

## Inputs and modes

You receive the plan and mode in the user message. The mode is one of:

- **implement** — fresh execution. Carry out the full plan's Implementation order, in order.
- **fix** — a previous implementation passed back QA failures. You also receive the failure text. Apply only the targeted fixes needed to address each ✗ FAIL item. Do not re-do work that already passed. Do not deviate from the plan's intent.

## Escape hatch

If after reading CLAUDE.md and the plan you determine the plan is unworkable, internally contradictory, or will break existing functionality:

- Make no changes
- Call `emit_implementation_result` with `summary="REPLAN NEEDED: <one-line reason>"` and `test_plan=""`
- Stop

Use this sparingly — only when execution is genuinely unsafe, not when you simply prefer a different approach.

## When invoked

1. Read CLAUDE.md
2. Read the plan in the user message carefully
3. In Fix mode, read the QA failures in the user message carefully
4. Verify the plan is workable (see escape hatch above)
5. Execute the work (full plan in Implement mode, targeted fixes in Fix mode)
6. Call `emit_implementation_result` to finalize (see "When done")
7. Stop

## Rules you must never break

### CSS
- Always use CSS variables from :root — never hardcode colours or fonts
- Only use DM Sans or DM Serif Display

### JavaScript
- Use classList.add() and classList.remove() — never el.className =
- All new derived values must be calculated and set inside App.recalc()
- All new inputs must be read inside App.recalc() using val()
- New currency inputs must have data-type='currency' attribute
- New currency inputs must be added to CURRENCY_IDS array
- New number inputs must be added to NUMBER_IDS array
- New text inputs must be added to TEXT_IDS array
- New localStorage keys must follow the bostadskalkyl_* naming convention
- New localStorage keys must be handled in readInputs() and writeInputs()
- New localStorage keys must use the bostadskalkyl_*_v1 versioned naming
- Each window.App.* key must have exactly one writer file (one-writer rule)

### Modals
- Follow the open/close pattern in CLAUDE.md exactly
- Every modal must have click-outside-to-close on the backdrop
- Every modal must have a × close button

### Scope
- Only change what the plan specifies
- Do not touch unrelated code

## When done

1. Confirm every change you made to yourself, organised by section: CSS, HTML, JS.

2. If `.claude/skills/static-checks/SKILL.md` exists, run the static checks per that skill. If any check fails, fix the violation and re-run until the script exits 0. Do not proceed until all checks pass.

3. Call the `emit_implementation_result` tool with:
   - `summary`: one-line description of what changed
   - `test_plan`: markdown checklist bullets covering the key user flows to verify manually, any regression checks for related code, and calc() correctness if numeric output changed

   Example test_plan content:
   ```
   - [ ] Open the new stress test modal and verify each scenario rate
   - [ ] Confirm existing scenarios still render correctly
   - [ ] Verify App.recalc() still updates summary panel on every input change
   ```

This call is how the orchestrator captures your output. If you don't call it, the workflow has nothing to record and will fail.
"""


class ImplementationResult(BaseModel):
    # One-line description of what changed. Goes into the commit message
    # (Phase 6d) and the PR title via the planning agent's title.
    summary: str

    # Markdown checklist for manual verification. Becomes the PR's
    # "Test plan" section.
    test_plan: str


def _build_user_message(
    plan: PlanResult,
    mode: str,
    qa_failures: str | None,
) -> str:
    """Compose the per-run user message for the agent.

    Mirrors the coordinator's old "MODE: implement / PLAN_FILE: ..."
    format but with the actual content inline rather than file paths,
    because the orchestrator passes data, not paths.
    """
    parts = [f"MODE: {mode}", "", "## Plan", "", plan.plan_text]
    if mode == "fix":
        if not qa_failures:
            raise ValueError("fix mode requires qa_failures")
        parts += ["", "## QA failures to address", "", qa_failures]
    return "\n".join(parts)


async def implement(
    plan: PlanResult,
    mode: str = "implement",
    qa_failures: str | None = None,
) -> ImplementationResult:
    """Run the implementation agent and return its structured result.

    Mode is "implement" for the first attempt, "fix" on retries after
    QA failures (Phase 7). qa_failures is the failure text from QA's
    last verdict; required in fix mode.
    """
    if mode not in ("implement", "fix"):
        raise ValueError(f"unknown mode: {mode!r}")

    # Closure-captured holder for the agent's final structured output.
    # The @tool below writes into it; we read it after query() returns.
    captured: dict[str, str] = {}

    # Define the structured-output tool. The agent calls this exactly
    # once when it's done; the call's arguments ARE the structured
    # output. We acknowledge to the agent so it knows the orchestrator
    # received the result.
    @tool(
        "emit_implementation_result",
        "Emit the final implementation result. Call this exactly once when "
        "the work is complete. After calling, stop and do not make further "
        "edits — the orchestrator takes over from here.",
        {"summary": str, "test_plan": str},
    )
    async def emit_implementation_result(args: dict) -> dict:
        captured["summary"] = args["summary"]
        captured["test_plan"] = args["test_plan"]
        return {
            "content": [
                {"type": "text", "text": "Result captured. You may stop now."}
            ]
        }

    # In-process MCP server holding our single tool. No subprocess, no
    # IPC — runs in the same Python process as the orchestrator, which
    # is how the captured dict above can leak state out of the tool.
    orchestrator_mcp = create_sdk_mcp_server(
        name="orchestrator",
        version="1.0.0",
        tools=[emit_implementation_result],
    )

    options = ClaudeAgentOptions(
        system_prompt=IMPLEMENTATION_SYSTEM_PROMPT,
        # File-editing tools the agent needs, plus our custom tool. The
        # MCP-namespaced name format is mcp__<server-name>__<tool-name>.
        # Note: no Git, no commit, no PR tools — the orchestrator owns
        # those entirely.
        allowed_tools=[
            "Read",
            "Edit",
            "Write",
            "Bash",
            "Glob",
            "Grep",
            "mcp__orchestrator__emit_implementation_result",
        ],
        mcp_servers={"orchestrator": orchestrator_mcp},
        # cwd must be the bostadskalkyl repo root — the agent edits
        # files there, not in the orchestrator/ subdirectory.
        cwd=str(REPO_ROOT),
        # acceptEdits = skip per-edit human approval. We're running
        # unattended; the orchestrator already approved the plan with
        # the user. Project-level deny rules in .claude/settings.json
        # still apply (.env, secrets, etc.).
        permission_mode="acceptEdits",
        # Pin the model so behaviour is stable across SDK upgrades.
        model="claude-sonnet-4-6",
        # Read CLAUDE.md and the project's .claude/settings.json so
        # the agent inherits project rules and permission deny lists.
        setting_sources=["project"],
    )

    user_message = _build_user_message(plan, mode, qa_failures)

    # Drive the agent loop. We don't need to inspect intermediate
    # messages here — LangSmith captures them via the SDK's tracing,
    # and the structured output comes through the tool call. We just
    # need to consume the iterator so the loop actually runs.
    async for _ in query(prompt=user_message, options=options):
        pass

    if "summary" not in captured:
        # The agent finished its turn budget or hit an error without
        # calling emit_implementation_result. Either the prompt failed
        # to make the tool's necessity clear, or the agent ran out of
        # turns mid-work. Either way we have nothing to return.
        raise RuntimeError(
            "implementation agent did not call emit_implementation_result"
        )

    return ImplementationResult(
        summary=captured["summary"],
        test_plan=captured["test_plan"],
    )


# Standalone test:
#   python -m orchestrator.agents.implementation "tiny test"
# Creates a fake minimal plan, runs the agent, prints the structured
# result. Will actually edit files in the bostadskalkyl repo, so:
#   - run on a branch you don't mind being modified
#   - have a clean tree first
if __name__ == "__main__":
    request = " ".join(sys.argv[1:]) or "add a comment '// hello from orchestrator' at the top of app.js"

    async def _main() -> None:
        # Fake plan for standalone testing — bypasses the planning agent.
        # In the real workflow the plan comes from planning_task.
        fake_plan = PlanResult(
            title="standalone implementation test",
            type="feature",
            plan_text=request,
        )
        result = await implement(fake_plan)
        print(result.model_dump_json(indent=2))

    asyncio.run(_main())

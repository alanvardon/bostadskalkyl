"""QA agent — runs Claude Agent SDK to review uncommitted changes.

Like implementation.py this is an *agent loop*, not a single LLM call:
QA needs to read CLAUDE.md, read the plan, run `git diff HEAD`, inspect
specific files, and possibly run static checks before producing its
verdict. Multiple tool calls across multiple turns — that's the agent
loop shape.

What differs from implementation.py:
  - **Read-only tools.** No Edit, no Write. The QA agent must not be
    able to modify the working tree, even by accident. The allowlist is
    the hard gate; the system prompt's "do not fix anything" is the soft
    one.
  - **Structured output is a verdict, not a description.**
    `QaResult { result: Literal["PASS", "FAIL"], failures: str | None }`
    replaces the old `QA RESULT: PASS / QA RESULT: FAIL` sentinel and
    the separate `qa_failures.md` file. Both pieces of information now
    travel together as one typed object.

Same closure-capture pattern as implementation.py — the in-process MCP
tool writes the verdict into a dict the orchestrator reads after
`query()` returns.
"""

from dotenv import load_dotenv

load_dotenv()

import asyncio
import sys

from claude_agent_sdk import (
    ClaudeAgentOptions,
    create_sdk_mcp_server,
    query,
    tool,
)
from pydantic import BaseModel
from typing import Literal

from orchestrator.agents.planning import PlanResult
from orchestrator.git_ops import REPO_ROOT


# Adapted from .claude/agents/qa.md. Key edits from the coordinator-era
# version:
#   - File-path inputs (PLAN_FILE, QA_FAILURES_FILE, PROGRESS_LOG_FILE)
#     removed — plan comes inline via the user message; the failure
#     report comes back through the MCP tool, not a written file
#   - Logging section removed — LangSmith captures the trace
#   - `QA RESULT: PASS/FAIL` sentinel removed — replaced by the MCP
#     tool's `result` argument
#   - "Output format" reframed: the agent reports each check inline
#     during its reasoning, then calls emit_qa_result once at the end
#
# Everything else — CLAUDE.md, checklist, no-fixing rule — ports
# almost verbatim.
QA_SYSTEM_PROMPT = """\
You are a QA agent for Bostadskalkyl, a Swedish house purchase calculator. You review uncommitted changes against the approved plan and report PASS or FAIL for every check. You do not fix anything. You only report.

## Inputs

You receive the approved plan in the user message. Read it carefully — every QA check is judged against it.

## When invoked

1. Read CLAUDE.md
2. Read the plan in the user message carefully
3. Run `git diff HEAD` to see all uncommitted changes (staged and unstaged)
4. If `.claude/skills/static-checks/SKILL.md` exists, run the static checks per that skill. Record each result as `✓ PASS` or `✗ FAIL`. Do not fix anything.
5. Work through every item in the checklist below, recording `✓ PASS` or `✗ FAIL` for each
6. Call `emit_qa_result` with the overall verdict (see "When done")

## Checklist

### Calculation integrity
- [ ] App.recalc() function is intact and callable (was renamed from calc() in the modular split)
- [ ] All new derived values are set inside App.recalc()
- [ ] All new inputs are read inside App.recalc() using val()

### Modals (if a modal was added)
- [ ] Follows open/close pattern from CLAUDE.md
- [ ] Has click-outside-to-close on backdrop
- [ ] Has × close button

### Plan adherence
- [ ] Every item in the plan's "Implementation order" was carried out
- [ ] No changes made outside the approved plan
- [ ] No unrelated code touched

## When done

Call `emit_qa_result` exactly once with:

- `result`: `"PASS"` if every check passed, `"FAIL"` if any failed
- `failures`: empty string when PASS; when FAIL, a markdown report of all failing checks with this structure:
  ```
  # QA failures

  ## <check name>
  <exact description of the problem and its location — file path, line number, code snippet if helpful>

  ## <next failing check>
  ...

  ## Suggested next steps
  <if the fix is obvious, describe it; otherwise omit this section>
  ```

This call is how the orchestrator captures your verdict. If you don't call it, the workflow has nothing to record and will fail. Do not modify any files — your only output is the `emit_qa_result` call.
"""


class QaResult(BaseModel):
    # PASS = every check passed. FAIL = one or more failed. Pydantic's
    # Literal validation is the hard gate — anything else raises at
    # construction time.
    result: Literal["PASS", "FAIL"]

    # Markdown failure report when result == "FAIL". None when PASS.
    # Feeds back into implementation_task as `qa_failures` on the next
    # retry attempt (Phase 7's fix loop).
    failures: str | None = None


def _build_user_message(plan: PlanResult) -> str:
    """Compose the per-run user message for the QA agent.

    QA only needs the plan — the diff comes from `git diff HEAD` which
    the agent runs itself via Bash. No mode switch (unlike
    implementation): QA always does the same thing.
    """
    return "\n".join(["## Plan", "", plan.plan_text])


async def qa(plan: PlanResult) -> QaResult:
    """Run the QA agent and return its structured verdict.

    Read-only: the agent has Read, Bash, Glob, Grep — explicitly no
    Edit or Write. The orchestrator (not the agent) decides what
    happens after a FAIL.
    """
    # Closure-captured holder for the agent's final structured output.
    # Same pattern as implementation.py — the @tool below writes into
    # it, we read it after query() returns.
    captured: dict[str, str] = {}

    # Structured-output tool. Schema uses plain `str` for `result`
    # because the SDK's @tool decorator takes simple Python types;
    # the Literal["PASS", "FAIL"] validation happens at QaResult
    # construction. The agent sees the description as part of the
    # prompt — keep it precise.
    @tool(
        "emit_qa_result",
        "Emit the final QA verdict. Call this exactly once when review is "
        "complete. `result` must be the exact string 'PASS' or 'FAIL'. "
        "`failures` is an empty string on PASS, or a markdown failure report "
        "on FAIL. After calling, stop — the orchestrator takes over.",
        {"result": str, "failures": str},
    )
    async def emit_qa_result(args: dict) -> dict:
        captured["result"] = args["result"]
        captured["failures"] = args.get("failures", "") or ""
        return {
            "content": [
                {"type": "text", "text": "QA verdict captured. You may stop now."}
            ]
        }

    orchestrator_mcp = create_sdk_mcp_server(
        name="orchestrator",
        version="1.0.0",
        tools=[emit_qa_result],
    )

    options = ClaudeAgentOptions(
        system_prompt=QA_SYSTEM_PROMPT,
        # Read-only set. Bash is here so the agent can run `git diff HEAD`
        # and the static-checks skill — both of which are read-only in
        # practice. The project's .claude/settings.json deny rules
        # (loaded via setting_sources=["project"]) still apply, blocking
        # destructive bash even if the agent tried.
        allowed_tools=[
            "Read",
            "Bash",
            "Glob",
            "Grep",
            "mcp__orchestrator__emit_qa_result",
        ],
        mcp_servers={"orchestrator": orchestrator_mcp},
        # Same repo root as implementation — QA reviews changes in the
        # bostadskalkyl tree, not the orchestrator/ subdirectory.
        cwd=str(REPO_ROOT),
        # acceptEdits is moot here (no Edit/Write in allowed_tools) but
        # keep it set for consistency. The real safety floor is the
        # tool allowlist plus project deny rules.
        permission_mode="acceptEdits",
        model="claude-sonnet-4-6",
        setting_sources=["project"],
    )

    user_message = _build_user_message(plan)

    async for _ in query(prompt=user_message, options=options):
        pass

    if "result" not in captured:
        raise RuntimeError("qa agent did not call emit_qa_result")

    # Empty string → None for the failures field. Cleaner downstream:
    # the retry loop (Phase 7) can `if qa.failures:` rather than
    # checking truthy strings.
    failures = captured["failures"] or None

    # Pydantic's Literal["PASS", "FAIL"] raises ValidationError here if
    # the agent emitted anything else — that's the hard gate.
    return QaResult(result=captured["result"], failures=failures)


# Standalone test:
#   python -m orchestrator.agents.qa "tiny test"
# Builds a fake plan, runs QA against whatever uncommitted changes are
# in the bostadskalkyl tree right now, prints the verdict. Useful for
# iterating on the QA prompt without going through the whole workflow.
if __name__ == "__main__":
    request = " ".join(sys.argv[1:]) or "review whatever's currently uncommitted"

    async def _main() -> None:
        fake_plan = PlanResult(
            title="standalone qa test",
            type="feature",
            plan_text=request,
        )
        result = await qa(fake_plan)
        print(result.model_dump_json(indent=2))

    asyncio.run(_main())

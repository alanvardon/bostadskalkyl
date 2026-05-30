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

from pydantic import BaseModel
from typing import Literal

from orchestrator.errors import FatalError
from orchestrator.usage import TaskUsage
from orchestrator.prompt_loader import load_prompt

from orchestrator.agents.planning import PlanResult
from orchestrator.config import load_config
from orchestrator.git_ops import REPO_ROOT
from orchestrator.qa_scripts import run_qa_scripts
from orchestrator.steps import run_structured_agent
from orchestrator.tool_profile import load_tool_profile


_QA_SYSTEM_PROMPT = load_prompt("qa")


class QaResult(BaseModel):
    # Phase 20: bump on incompatible shape changes (renamed/removed fields);
    # pure additions of optional fields don't need a bump.
    schema_version: int = 1
    result: Literal["PASS", "FAIL"]
    failures: str | None = None
    usage: TaskUsage | None = None


def _build_user_message(plan: PlanResult) -> str:
    """Compose the per-run user message for the QA agent.

    QA only needs the plan — the diff comes from `git diff HEAD` which
    the agent runs itself via Bash. No mode switch (unlike
    implementation): QA always does the same thing.
    """
    return "\n".join(["## Plan", "", plan.plan_text])


async def qa(plan: PlanResult, model: str = "claude-sonnet-4-6") -> QaResult:
    """Run the QA agent and return its structured verdict.

    Scripted gate runs first (before any LLM call). If any executable
    script in `qa_scripts_dir` exits non-zero, a FAIL is returned
    immediately with the script output embedded in `failures`.

    Read-only: the LLM agent has Read, Bash, Glob, Grep — explicitly no
    Edit or Write. The orchestrator (not the agent) decides what
    happens after a FAIL.
    """
    # --- Scripted QA gate (Phase 28) ------------------------------------
    # Run before the LLM. Any non-zero exit from a script short-circuits
    # the whole QA phase: no prompt is built, no model is called.
    _config = load_config()
    _scripted_outcome = run_qa_scripts(
        repo_root=REPO_ROOT,
        qa_scripts_dir=_config.qa_scripts_dir,
        timeout=_config.qa_scripts_timeout,
    )
    if not _scripted_outcome.passed:
        return QaResult(
            result="FAIL",
            failures=_scripted_outcome.failure_report,
        )
    # --- End scripted gate ----------------------------------------------

    # Phase 39: the agent-loop plumbing lives in steps.run_structured_agent.
    # This wrapper owns only the QA-specific contract: read-only tools, the
    # verdict emit tool, and the typed QaResult (whose Literal["PASS","FAIL"]
    # is validated at construction in the factory below).
    #
    # Read-only: the profile gives Read/Grep/Bash — no Edit/Write. The project's
    # .claude/settings.json deny rules (loaded via setting_sources=["project"]
    # inside the runner) still apply, blocking destructive bash even if tried.
    # The pinned MCP tool for the verdict is appended by the runner.
    #
    # Fail-closed is preserved: run_structured_agent raises FatalError("qa agent
    # did not call emit_qa_result") if the agent never emits a verdict, so a
    # missing verdict is a loud crash, never a silent pass.
    _profile = load_tool_profile("qa")
    return await run_structured_agent(
        system_prompt=_QA_SYSTEM_PROMPT,
        user_message=_build_user_message(plan),
        model=model,
        allowed_tools=_profile.allowed_tools,
        disallowed_tools=_profile.disallowed_tools,
        # Same repo root as implementation — QA reviews changes in the target
        # repo's tree, not the orchestrator/ subdirectory.
        cwd=REPO_ROOT,
        emit_tool_name="emit_qa_result",
        emit_tool_description=(
            "Emit the final QA verdict. Call this exactly once when review is "
            "complete. `result` must be the exact string 'PASS' or 'FAIL'. "
            "`failures` is an empty string on PASS, or a markdown failure report "
            "on FAIL. After calling, stop — the orchestrator takes over."
        ),
        emit_tool_fields={"result": str, "failures": str},
        result_factory=lambda c, u: QaResult(
            result=c["result"],
            failures=(c.get("failures") or None),
            usage=u,
        ),
        agent_label="qa agent",
        missing_exc=FatalError,
    )


# Standalone test:
#   python -m orchestrator.agents.qa "tiny test"
# Builds a fake plan, runs QA against whatever uncommitted changes are
# in the target repo right now, prints the verdict. Useful for
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

"""Runtime execution of injected steps (Phase 33).

Plain async functions, one per executable step type. workflow.py wraps each
in a @task so they inherit checkpointing, tracing, and cancel/usage handling
at the @task boundary — the user's step never touches that plumbing.

- execute_script: run an executable; non-zero exit raises StepError.
- execute_llm_agent: run a markdown-defined agent (.orchestrator/agents/
  <agent>.md as the system prompt) via the Claude Agent SDK, same loop shape
  as the planning/implementation/qa agents.

human_gate steps have no runner here — they're a pause (interrupt()) handled
inline in workflow.run_seam, since interrupt() must run in the entrypoint
body, not inside a @task.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
from collections.abc import Callable
from pathlib import Path

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ResultMessage,
    create_sdk_mcp_server,
    query,
    tool,
)

from orchestrator.manifest import LlmAgentStep, ScriptStep, StepResult
from orchestrator.usage import TaskUsage


class StepError(RuntimeError):
    """Raised when an injected step fails (non-zero script exit, timeout, or
    a missing agent file). Propagates out of the workflow and aborts it."""


def _logger(step_id: str) -> logging.Logger:
    # Child logger per step so injected-step output is attributable without
    # the user adding any logging of their own.
    return logging.getLogger(f"orchestrator.steps.{step_id}")


def _run_script_sync(step: ScriptStep, repo_root: Path) -> StepResult:
    log = _logger(step.id)
    script = repo_root / step.path
    log.info("running script step %r: %s", step.id, step.path)
    try:
        proc = subprocess.run(
            [str(script)],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=step.timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise StepError(
            f"script step {step.id!r} timed out after {step.timeout}s"
        ) from exc
    except OSError as exc:
        raise StepError(
            f"script step {step.id!r} could not be executed ({step.path}): {exc}"
        ) from exc

    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.stdout:
        log.info("[%s] stdout:\n%s", step.id, out)
    if proc.stderr:
        log.info("[%s] stderr:\n%s", step.id, err)

    if proc.returncode != 0:
        # The script's own output is the abort reason (like pre-hooks).
        report = err or out or "(no output)"
        raise StepError(
            f"script step {step.id!r} failed (exit {proc.returncode}):\n{report}"
        )

    # Keep a short tail of stdout as the human-readable detail.
    detail = out[-500:] if out else "ok"
    return StepResult(step_id=step.id, kind="script", ok=True, detail=detail)


async def execute_script(step: ScriptStep, repo_root: Path) -> StepResult:
    """Run a script step off the event loop (subprocess.run is blocking)."""
    return await asyncio.to_thread(_run_script_sync, step, repo_root)


def _load_agent_prompt(project_root: Path, agent: str) -> str:
    """Read the agent's markdown file, stripping any YAML frontmatter.

    The body is the system prompt. Frontmatter (a leading `---` block) is
    optional and ignored for v1 — the step config already carries the model,
    and the agent reads the diff itself via Bash, so reads/writes injection
    isn't needed yet.
    """
    path = project_root / ".orchestrator" / "agents" / f"{agent}.md"
    if not path.exists():
        raise StepError(
            f"agent file not found at .orchestrator/agents/{agent}.md"
        )
    text = path.read_text(encoding="utf-8")
    return _strip_frontmatter(text)


def _strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        # Split on the closing fence: lines[0] == "---", find the next "---".
        parts = text.split("\n")
        for i in range(1, len(parts)):
            if parts[i].strip() == "---":
                return "\n".join(parts[i + 1 :]).lstrip("\n")
    return text


def _extract_usage(result_msg: ResultMessage | None, model: str) -> TaskUsage | None:
    """Build a TaskUsage from a ResultMessage, or None if no usage was reported.

    Phase 39: shared by every agent that drives the Claude Agent SDK loop — the
    mapping from the SDK's usage dict to our TaskUsage was previously copied
    verbatim into implementation.py, qa.py, and execute_llm_agent.
    """
    if result_msg is None or not result_msg.usage:
        return None
    u = result_msg.usage
    return TaskUsage(
        model=model,
        input_tokens=u.get("input_tokens", 0),
        output_tokens=u.get("output_tokens", 0),
        cache_read_tokens=u.get("cache_read_input_tokens", 0),
        cache_creation_tokens=u.get("cache_creation_input_tokens", 0),
        reported_cost_usd=result_msg.total_cost_usd,
    )


async def run_structured_agent(
    *,
    system_prompt: str,
    user_message: str,
    model: str,
    allowed_tools: list[str],
    disallowed_tools: list[str],
    cwd: Path,
    emit_tool_name: str,
    emit_tool_description: str,
    emit_tool_fields: dict[str, type],
    result_factory: Callable[[dict, TaskUsage | None], object],
    agent_label: str,
    missing_exc: type[Exception] = StepError,
    permission_mode: str = "acceptEdits",
) -> object:
    """Run one Claude Agent SDK loop with a closure-captured structured-output tool.

    The single shared agent-loop runner (Phase 39). Implementation, QA, and
    every pluggable llm_agent step funnel through it, so the loop plumbing — the
    emit tool, the in-process MCP server, the ClaudeAgentOptions assembly, the
    query() drain, the fail-closed guard, and usage extraction — lives in
    exactly one place.

    What stays per-agent is only the *contract*: the emit tool's fields and a
    `result_factory(captured, usage)` that turns the captured tool args into the
    agent's own typed result model. The result type is deliberately NOT unified —
    the workflow branches on it (e.g. QaResult.result).

    Fail-closed: if the agent never calls the emit tool, `captured` stays empty
    and we raise `missing_exc` (so a gate like QA can never silently pass). The
    caller supplies `agent_label` and `missing_exc` so the error message and type
    match exactly what each agent raised before this refactor.
    """
    captured: dict = {}

    @tool(emit_tool_name, emit_tool_description, emit_tool_fields)
    async def _emit(args: dict) -> dict:
        captured.update(args)
        return {"content": [{"type": "text", "text": "Result captured. You may stop now."}]}

    orchestrator_mcp = create_sdk_mcp_server(
        name="orchestrator", version="1.0.0", tools=[_emit]
    )

    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        allowed_tools=list(allowed_tools) + [f"mcp__orchestrator__{emit_tool_name}"],
        disallowed_tools=list(disallowed_tools),
        mcp_servers={"orchestrator": orchestrator_mcp},
        cwd=str(cwd),
        permission_mode=permission_mode,
        model=model,
        setting_sources=["project"],
    )

    result_msg: ResultMessage | None = None
    async for msg in query(prompt=user_message, options=options):
        if isinstance(msg, ResultMessage):
            result_msg = msg

    if not captured:
        raise missing_exc(f"{agent_label} did not call {emit_tool_name}")

    usage = _extract_usage(result_msg, model)
    return result_factory(captured, usage)


async def execute_llm_agent(
    step: LlmAgentStep, project_root: Path, plan_text: str
) -> StepResult:
    """Run a markdown-defined agent against the current working tree.

    Phase 39: a thin wrapper over run_structured_agent. It loads the agent's
    markdown prompt, names the emit tool, and builds a StepResult from the
    captured summary. The agent gets the plan in the user message and runs
    `git diff HEAD` itself to see the changes (like the qa agent).
    """
    log = _logger(step.id)
    system_prompt = _load_agent_prompt(project_root, step.agent)

    log.info("running llm_agent step %r (agent=%s)", step.id, step.agent)
    return await run_structured_agent(
        system_prompt=system_prompt,
        user_message="\n".join(["## Plan", "", plan_text]),
        model=step.model,
        allowed_tools=["Read", "Edit", "Write", "Bash", "Grep"],
        disallowed_tools=[],
        cwd=project_root,
        emit_tool_name="emit_step_result",
        emit_tool_description=(
            "Emit the final result of this step. Call exactly once when done, "
            "with a one-line `summary` of what you did. After calling, stop."
        ),
        emit_tool_fields={"summary": str},
        result_factory=lambda c, u: StepResult(
            step_id=step.id,
            kind="llm_agent",
            ok=True,
            detail=c.get("summary", "") or "",
            usage=u,
        ),
        agent_label=f"llm_agent step {step.id!r}",
        missing_exc=StepError,
    )

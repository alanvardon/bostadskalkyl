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


async def execute_llm_agent(
    step: LlmAgentStep, project_root: Path, plan_text: str
) -> StepResult:
    """Run a markdown-defined agent against the current working tree.

    Same closure-capture structured-output pattern as the other agents: the
    agent calls emit_step_result once with a summary; we read it back after
    query() returns. The agent gets the plan in the user message and runs
    `git diff HEAD` itself to see the changes (like the qa agent).
    """
    log = _logger(step.id)
    system_prompt = _load_agent_prompt(project_root, step.agent)

    captured: dict[str, str] = {}

    @tool(
        "emit_step_result",
        "Emit the final result of this step. Call exactly once when done, "
        "with a one-line `summary` of what you did. After calling, stop.",
        {"summary": str},
    )
    async def emit_step_result(args: dict) -> dict:
        captured["summary"] = args.get("summary", "") or ""
        return {"content": [{"type": "text", "text": "Captured. Stop now."}]}

    orchestrator_mcp = create_sdk_mcp_server(
        name="orchestrator", version="1.0.0", tools=[emit_step_result]
    )

    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        allowed_tools=[
            "Read", "Edit", "Write", "Bash", "Grep",
            "mcp__orchestrator__emit_step_result",
        ],
        mcp_servers={"orchestrator": orchestrator_mcp},
        cwd=str(project_root),
        permission_mode="acceptEdits",
        model=step.model,
        setting_sources=["project"],
    )

    user_message = "\n".join(["## Plan", "", plan_text])

    log.info("running llm_agent step %r (agent=%s)", step.id, step.agent)
    result_msg: ResultMessage | None = None
    async for msg in query(prompt=user_message, options=options):
        if isinstance(msg, ResultMessage):
            result_msg = msg

    if "summary" not in captured:
        raise StepError(
            f"llm_agent step {step.id!r} did not call emit_step_result"
        )

    usage: TaskUsage | None = None
    if result_msg is not None and result_msg.usage:
        u = result_msg.usage
        usage = TaskUsage(
            model=step.model,
            input_tokens=u.get("input_tokens", 0),
            output_tokens=u.get("output_tokens", 0),
            cache_read_tokens=u.get("cache_read_input_tokens", 0),
            cache_creation_tokens=u.get("cache_creation_input_tokens", 0),
            reported_cost_usd=result_msg.total_cost_usd,
        )

    return StepResult(
        step_id=step.id,
        kind="llm_agent",
        ok=True,
        detail=captured["summary"],
        usage=usage,
    )

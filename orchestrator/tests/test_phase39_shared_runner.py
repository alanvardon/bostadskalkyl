"""Phase 39 — shared agent-loop runner.

Phase 39 extracted the duplicated Claude Agent SDK loop plumbing out of
implementation.py, qa.py, and execute_llm_agent into a single
steps.run_structured_agent helper, plus a shared steps._extract_usage.

These tests cover the behaviours that are *new* to the shared helper:

  - fail-closed: if the agent never calls the emit tool, the runner raises
    the caller-supplied exception type with the caller-supplied label, so a
    gate like QA can never silently pass.
  - usage extraction: the SDK usage dict maps onto TaskUsage correctly, and
    a missing/empty usage degrades to None.
  - the QA scripted gate still short-circuits to FAIL *before* the runner is
    ever invoked (deterministic floor preserved).

The happy path (agent emits, factory builds the typed result) is already
covered transitively by the existing test_phase33 suite, which drives
execute_llm_agent — now a thin wrapper over run_structured_agent.
"""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from orchestrator.errors import FatalError
from orchestrator.steps import StepError, _extract_usage, run_structured_agent


# --- _extract_usage --------------------------------------------------------


def test_extract_usage_maps_sdk_dict_to_taskusage():
    result_msg = SimpleNamespace(
        usage={
            "input_tokens": 100,
            "output_tokens": 20,
            "cache_read_input_tokens": 5,
            "cache_creation_input_tokens": 3,
        },
        total_cost_usd=0.42,
    )
    usage = _extract_usage(result_msg, "claude-sonnet-4-6")
    assert usage is not None
    assert usage.model == "claude-sonnet-4-6"
    assert usage.input_tokens == 100
    assert usage.output_tokens == 20
    assert usage.cache_read_tokens == 5
    assert usage.cache_creation_tokens == 3
    assert usage.reported_cost_usd == 0.42


def test_extract_usage_none_result_msg_is_none():
    assert _extract_usage(None, "claude-sonnet-4-6") is None


def test_extract_usage_empty_usage_is_none():
    result_msg = SimpleNamespace(usage={}, total_cost_usd=None)
    assert _extract_usage(result_msg, "claude-sonnet-4-6") is None


# --- run_structured_agent: fail-closed -------------------------------------


def _patch_empty_query(monkeypatch):
    """Patch steps.query with an async generator that yields no messages.

    Mirrors an agent that runs but never calls the emit tool: `captured`
    stays empty, so run_structured_agent must raise.
    """

    async def fake(*args, **kwargs):
        if False:  # pragma: no cover - makes this an async generator
            yield None

    monkeypatch.setattr("orchestrator.steps.query", fake)


def test_run_structured_agent_raises_when_agent_never_emits(monkeypatch):
    _patch_empty_query(monkeypatch)

    with pytest.raises(StepError, match="my step did not call emit_thing"):
        asyncio.run(
            run_structured_agent(
                system_prompt="x",
                user_message="y",
                model="claude-sonnet-4-6",
                allowed_tools=["Read"],
                disallowed_tools=[],
                cwd=Path("."),
                emit_tool_name="emit_thing",
                emit_tool_description="desc",
                emit_tool_fields={"summary": str},
                result_factory=lambda c, u: c,
                agent_label="my step",
                missing_exc=StepError,
            )
        )


def test_run_structured_agent_missing_exc_type_is_caller_chosen(monkeypatch):
    _patch_empty_query(monkeypatch)

    # A gate (QA) passes FatalError; the runner must raise *that* type, not
    # the StepError default — proving the fail-closed exception is per-caller.
    with pytest.raises(FatalError, match="qa agent did not call emit_qa_result"):
        asyncio.run(
            run_structured_agent(
                system_prompt="x",
                user_message="y",
                model="claude-sonnet-4-6",
                allowed_tools=["Read"],
                disallowed_tools=[],
                cwd=Path("."),
                emit_tool_name="emit_qa_result",
                emit_tool_description="desc",
                emit_tool_fields={"result": str, "failures": str},
                result_factory=lambda c, u: c,
                agent_label="qa agent",
                missing_exc=FatalError,
            )
        )


# --- QA scripted gate short-circuits before the runner ---------------------


def test_qa_scripted_gate_fail_skips_runner(monkeypatch):
    """A failing scripted gate returns FAIL without ever invoking the LLM loop."""
    from orchestrator.agents import qa as qa_mod
    from orchestrator.agents.planning import PlanResult

    # Scripted gate fails.
    monkeypatch.setattr(
        qa_mod,
        "run_qa_scripts",
        lambda **kwargs: SimpleNamespace(passed=False, failure_report="boom"),
    )

    # If the runner's query is reached, blow up — proves we short-circuited.
    def _explode(*args, **kwargs):
        raise AssertionError("query must not be called when scripted gate fails")

    monkeypatch.setattr("orchestrator.steps.query", _explode)

    plan = PlanResult(title="t", type="feature", plan_text="p")
    result = asyncio.run(qa_mod.qa(plan))

    assert result.result == "FAIL"
    assert result.failures == "boom"

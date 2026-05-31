"""Phase 42 Part B — the built-in retry block's approval gates.

After the impl→QA loop moved onto the generic retry engine, the two optional
approval gates that used to be inline in the loop are now *injected closures*:

- ``on_producers_done`` → the ``implementation_approval`` interrupt (fires after
  the producer, before QA), gated by ``workflow.implementation.human_in_loop``.
- ``on_gate_failed`` → the ``qa_failure`` interrupt (fires after a failing QA
  gate), gated by ``workflow.qa.human_in_loop``; an "abort" reply stops the run.

``on_exhausted`` is hard-locked to "abort" for the built-in block, so a run that
never passes QA always ends ``failed`` — committing failed-QA code is not
reachable from config. These tests drive the full workflow with those gates
enabled and assert the interrupt/resume flow, LLM- and git-free.
"""

import uuid
from pathlib import Path

import pytest
from langgraph.types import Command

from orchestrator.agents.planning import PlanResult
from orchestrator.agents.qa import QaResult
from orchestrator.config import (
    OrchestratorConfig,
    WorkflowConfig,
    WorkflowQaConfig,
    WorkflowStepConfig,
)
from orchestrator.manifest import StepResult


class _Stubs:
    def __init__(self, qa_verdicts: list[QaResult]) -> None:
        self.qa_verdicts = qa_verdicts
        self.impl_calls: list[str | None] = []
        self.qa_call_count = 0
        self.commit_called = False

    async def plan(self, request, model="claude-sonnet-4-6") -> PlanResult:
        return PlanResult(title="t", type="feature", plan_text="p")

    def create_branch(self, plan, max_slug_length=50, thread_id="") -> str:
        return "feature/test"

    async def implementation_task(self, plan_text, feedback=None, model="claude-sonnet-4-6") -> StepResult:
        self.impl_calls.append(feedback)
        return StepResult(step_id="implementation", kind="llm_agent", ok=True)

    async def qa(self, plan, model="claude-sonnet-4-6") -> QaResult:
        verdict = self.qa_verdicts[self.qa_call_count]
        self.qa_call_count += 1
        return verdict

    def commit(self, branch, title, summary, base_branch="main") -> str:
        return "abc123"

    def push(self, branch, base_branch="main", auto_rebase=True) -> None:
        pass

    def pr_create(self, branch, title, summary, test_plan, base_branch="main", draft=False, reviewers=None, labels=None) -> str:
        self.commit_called = True
        return "https://github.com/test/pr/1"

    def verify_clean_tree(self) -> None:
        pass

    def ensure_on_main(self, base_branch: str = "main") -> None:
        pass


def _patch(stubs: _Stubs, monkeypatch) -> None:
    monkeypatch.setattr("orchestrator.workflow.plan", stubs.plan)
    monkeypatch.setattr("orchestrator.workflow.create_branch", stubs.create_branch)
    # Fake the INNER producer (not implementation_task itself) so the real @task
    # wrapper still checkpoints/replays: these tests resume mid-loop, and a faked
    # plain fn would re-run on every resume, inflating the call count. The real
    # @task replays its cached StepResult, so the agent call happens exactly once
    # per distinct attempt — exactly what the production workflow does.
    monkeypatch.setattr(
        "orchestrator.workflow._run_implementation_producer", stubs.implementation_task
    )
    monkeypatch.setattr("orchestrator.workflow.qa", stubs.qa)
    monkeypatch.setattr("orchestrator.workflow.commit", stubs.commit)
    monkeypatch.setattr("orchestrator.workflow.push", stubs.push)
    monkeypatch.setattr("orchestrator.workflow.pr_create", stubs.pr_create)
    monkeypatch.setattr("orchestrator.workflow.verify_clean_tree", stubs.verify_clean_tree)
    monkeypatch.setattr("orchestrator.workflow.ensure_on_main", stubs.ensure_on_main)


def _qa_gate_config() -> OrchestratorConfig:
    """QA step pauses for a human on failure (workflow.qa.human_in_loop)."""
    return OrchestratorConfig(
        workflow=WorkflowConfig(
            qa=WorkflowQaConfig(allowed_tools=["Read", "Grep", "Bash"], human_in_loop=True)
        )
    )


def _impl_gate_config() -> OrchestratorConfig:
    """Implementation step pauses for a human before QA (impl.human_in_loop)."""
    return OrchestratorConfig(
        workflow=WorkflowConfig(implementation=WorkflowStepConfig(human_in_loop=True))
    )


def _config_dict() -> dict:
    return {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}


@pytest.mark.asyncio
async def test_qa_failure_gate_abort_fails_run(monkeypatch, tmp_path):
    """QA fails, the qa_failure gate fires, and an 'abort' reply ends the run
    as failed — no commit, no PR."""
    stubs = _Stubs([QaResult(result="FAIL", failures="boom")])
    _patch(stubs, monkeypatch)

    from orchestrator.workflow import build_workflow

    config = _config_dict()
    async with build_workflow(db_path=str(tmp_path / "ckpt.db"), config=_qa_gate_config()) as workflow:
        result = await workflow.ainvoke("req", config=config)
        assert result["__interrupt__"][0].value["kind"] == "plan_approval"

        # Approve the plan → impl runs → QA fails → qa_failure gate fires.
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
        assert result["__interrupt__"][0].value["kind"] == "qa_failure"
        assert result["__interrupt__"][0].value["failures"] == "boom"

        # Abort instead of retrying.
        result = await workflow.ainvoke(Command(resume="abort"), config=config)

    assert result["status"] == "failed"
    assert result["qa_failures"] == "boom"
    assert "pr_url" not in result
    assert stubs.impl_calls == [None]  # ran once, never retried
    assert stubs.qa_call_count == 1
    assert stubs.commit_called is False


@pytest.mark.asyncio
async def test_qa_failure_gate_retry_then_pass(monkeypatch, tmp_path):
    """QA fails, the qa_failure gate fires, a 'yes' reply retries; the failing
    feedback is injected into the retry; the second attempt passes → succeeds."""
    stubs = _Stubs([QaResult(result="FAIL", failures="boom"), QaResult(result="PASS")])
    _patch(stubs, monkeypatch)

    from orchestrator.workflow import build_workflow

    config = _config_dict()
    async with build_workflow(db_path=str(tmp_path / "ckpt.db"), config=_qa_gate_config()) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan_approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
        assert result["__interrupt__"][0].value["kind"] == "qa_failure"

        # Retry: the gate's feedback is threaded into the next producer call.
        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"
    assert result["pr_url"] == "https://github.com/test/pr/1"
    assert stubs.impl_calls == [None, "boom"]
    assert stubs.qa_call_count == 2
    assert stubs.commit_called is True


@pytest.mark.asyncio
async def test_implementation_approval_gate_then_pass(monkeypatch, tmp_path):
    """With impl.human_in_loop, the implementation_approval gate fires after the
    producer and before QA; resuming proceeds to QA and on to success."""
    stubs = _Stubs([QaResult(result="PASS")])
    _patch(stubs, monkeypatch)

    from orchestrator.workflow import build_workflow

    config = _config_dict()
    async with build_workflow(db_path=str(tmp_path / "ckpt.db"), config=_impl_gate_config()) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan_approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
        assert result["__interrupt__"][0].value["kind"] == "implementation_approval"
        assert stubs.qa_call_count == 0  # gate fired BEFORE QA

        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"
    assert stubs.impl_calls == [None]
    assert stubs.qa_call_count == 1
    assert stubs.commit_called is True

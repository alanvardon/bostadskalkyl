"""Phase 52 — grant more retries from the exhaustion approval gate.

When a build's retry budget runs out without the gate passing, a human at the
on_exhausted="approval_gate" prompt may now reply with a COUNT to grant N more
attempts and keep looping, instead of only choosing abort vs proceed-as-is.

Two slices:
1. Engine unit tests (fake producer/gate + a scripted interrupt_fn) — the
   dynamic-budget loop, the extend reply grammar, the max_total_attempts clamp,
   the ask text, and the suppressed double-prompt on the final budgeted attempt.
2. Integration — a declared build at a seam driven through real interrupts,
   including the headline resume-across-extend case (prior attempts replay from
   the checkpoint; only the newly-granted attempts run).
"""

import uuid

import pytest
from langgraph.types import Command

from orchestrator.manifest import RetryConfig, StepResult, WorkflowManifest
from orchestrator.retry_block import (
    RetryBlock,
    _parse_extend,
    run_retry_block,
)


# --------------------------- engine-level fakes ---------------------------


def _producer(calls):
    async def run_producer(step_id, feedback):
        calls.append((step_id, feedback))
        return StepResult(step_id=step_id, kind="ai_agent", ok=True)
    return run_producer


def _gate(verdicts, calls):
    it = iter(verdicts)
    async def run_gate(step_id):
        calls.append(step_id)
        passed, detail = next(it)
        return StepResult(
            step_id=step_id, kind="script", ok=True, passed=passed, detail=detail
        )
    return run_gate


def _scripted_interrupt(replies):
    """An interrupt_fn that records each payload and returns the next scripted
    reply. Mimics LangGraph re-firing the same call site across extensions."""
    it = iter(replies)
    asks: list[dict] = []
    def interrupt_fn(payload):
        asks.append(payload)
        return next(it)
    interrupt_fn.asks = asks
    return interrupt_fn


def _fail(n):
    return [(False, f"f{i}") for i in range(1, n + 1)]


# --------------------------- _parse_extend grammar ---------------------------


@pytest.mark.parametrize(
    "reply,expected",
    [
        ("2", 2),
        ("+2", 2),
        ("retry 2", 2),
        ("retry2", 2),
        ("more 2", 2),
        ("  3 ", 3),
        ("2 attempts", 2),
        ("1 attempt", 1),
        ("0", None),       # not positive
        ("-1", None),      # not a bare positive int
        ("yes", None),
        ("abort", None),
        ("proceed", None),
        ("", None),
        ("2.5", None),     # not an integer
        ("v2", None),
        (2, None),         # non-string
        (None, None),
    ],
)
def test_parse_extend_grammar(reply, expected):
    assert _parse_extend(reply) == expected


# --------------------------- dynamic budget ---------------------------


@pytest.mark.asyncio
async def test_extend_then_pass_counts_total_attempts():
    pcalls, gcalls = [], []
    block = RetryBlock(
        producers=["impl"], gates=["qa"], max_retries=1, on_exhausted="approval_gate"
    )
    # attempt 1 fails → exhaust → grant 2 → attempts 2,3; gate passes on attempt 3.
    result = await run_retry_block(
        block=block,
        run_producer=_producer(pcalls),
        run_gate=_gate([(False, "f1"), (False, "f2"), (True, "")], gcalls),
        interrupt_fn=_scripted_interrupt(["2"]),
    )
    assert result.ok and result.proceed
    assert result.attempts == 3                  # counts across the extension
    assert pcalls == [("impl", None), ("impl", "f1"), ("impl", "f2")]


@pytest.mark.asyncio
async def test_extend_exhaust_again_then_abort():
    pcalls, gcalls = [], []
    block = RetryBlock(
        producers=["impl"], gates=["qa"], max_retries=1, on_exhausted="approval_gate"
    )
    intr = _scripted_interrupt(["1", "abort"])
    result = await run_retry_block(
        block=block,
        run_producer=_producer(pcalls),
        run_gate=_gate(_fail(2), gcalls),
        interrupt_fn=intr,
    )
    assert not result.ok and not result.proceed  # aborted → failed run
    assert result.attempts == 2
    assert len(intr.asks) == 2                    # the gate re-fired after extend


@pytest.mark.asyncio
async def test_extend_then_proceed_ships_as_is():
    pcalls, gcalls = [], []
    block = RetryBlock(
        producers=["impl"], gates=["qa"], max_retries=1, on_exhausted="approval_gate"
    )
    result = await run_retry_block(
        block=block,
        run_producer=_producer(pcalls),
        run_gate=_gate(_fail(2), gcalls),
        interrupt_fn=_scripted_interrupt(["1", "yes"]),
    )
    assert not result.ok and result.proceed       # proceeds despite never passing
    assert result.attempts == 2


@pytest.mark.parametrize("form", ["2", "+2", "retry 2", "more 2"])
@pytest.mark.asyncio
async def test_extend_reply_forms_all_grant(form):
    pcalls, gcalls = [], []
    block = RetryBlock(
        producers=["impl"], gates=["qa"], max_retries=1, on_exhausted="approval_gate"
    )
    result = await run_retry_block(
        block=block,
        run_producer=_producer(pcalls),
        run_gate=_gate([(False, "f1"), (False, "f2"), (True, "")], gcalls),
        interrupt_fn=_scripted_interrupt([form]),
    )
    assert result.ok and result.attempts == 3


# --------------------------- regression: today's replies ---------------------------


@pytest.mark.asyncio
async def test_non_numeric_reply_proceeds_as_today():
    block = RetryBlock(
        producers=["impl"], gates=["qa"], max_retries=1, on_exhausted="approval_gate"
    )
    result = await run_retry_block(
        block=block,
        run_producer=_producer([]),
        run_gate=_gate([(False, "f1")], []),
        interrupt_fn=_scripted_interrupt(["looks fine, go"]),
    )
    assert not result.ok and result.proceed       # anything non-numeric → proceed
    assert result.attempts == 1


# --------------------------- max_total_attempts cap ---------------------------


@pytest.mark.asyncio
async def test_max_total_attempts_clamps_and_blocks_at_cap():
    pcalls, gcalls = [], []
    block = RetryBlock(
        producers=["impl"], gates=["qa"], max_retries=2,
        on_exhausted="approval_gate", max_total_attempts=3,
    )
    # attempts 1,2 exhaust (remaining 1) → grant "5" clamps to 1 → attempt 3
    # exhausts at the cap (remaining 0) → "2" can't extend → proceed.
    intr = _scripted_interrupt(["5", "2"])
    result = await run_retry_block(
        block=block,
        run_producer=_producer(pcalls),
        run_gate=_gate(_fail(3), gcalls),
        interrupt_fn=intr,
    )
    assert not result.ok and result.proceed
    assert result.attempts == 3                    # clamped to the cap, no further
    # The first ask advertises the headroom; the second (at the cap) does not.
    assert intr.asks[0]["remaining"] == 1
    assert "up to 1 more" in intr.asks[0]["ask"]
    assert intr.asks[1]["remaining"] == 0
    assert "number" not in intr.asks[1]["ask"]


@pytest.mark.asyncio
async def test_unbounded_ask_advertises_the_number_option():
    intr = _scripted_interrupt(["abort"])
    block = RetryBlock(
        producers=["impl"], gates=["qa"], max_retries=1, on_exhausted="approval_gate"
    )
    await run_retry_block(
        block=block,
        run_producer=_producer([]),
        run_gate=_gate([(False, "f1")], []),
        interrupt_fn=intr,
    )
    assert intr.asks[0]["remaining"] is None
    assert "reply a number N" in intr.asks[0]["ask"]


# --------------------------- on_gate_failed double-prompt suppression ---------------------------


@pytest.mark.asyncio
async def test_gate_fail_pause_suppressed_on_final_budget_attempt_under_approval_gate():
    """Phase 51's per-attempt on_gate_failed pause must NOT fire on the final
    budgeted attempt when on_exhausted='approval_gate' — the richer exhaustion
    prompt owns that moment (no double prompt). It still fires on earlier
    attempts, and again after an extension grows the budget."""
    seen = []

    async def on_gate_failed(attempt, feedback):
        seen.append(attempt)
        return True

    block = RetryBlock(
        producers=["impl"], gates=["qa"], max_retries=2, on_exhausted="approval_gate"
    )
    # attempts 1,2 fail (budget 2). Pause fires on attempt 1 only (2 is the final
    # budgeted attempt → suppressed). Grant 1 → attempt 3 is the new final → also
    # suppressed. Then abort.
    await run_retry_block(
        block=block,
        run_producer=_producer([]),
        run_gate=_gate(_fail(3), []),
        on_gate_failed=on_gate_failed,
        interrupt_fn=_scripted_interrupt(["1", "abort"]),
    )
    assert seen == [1]


@pytest.mark.asyncio
async def test_gate_fail_pause_still_fires_on_final_attempt_under_abort():
    """Under on_exhausted='abort' there is no exhaustion prompt to own the
    moment, so the per-attempt pause keeps firing on every failing attempt
    (today's behaviour, unchanged)."""
    seen = []

    async def on_gate_failed(attempt, feedback):
        seen.append(attempt)
        return True

    block = RetryBlock(
        producers=["impl"], gates=["qa"], max_retries=2, on_exhausted="abort"
    )
    await run_retry_block(
        block=block,
        run_producer=_producer([]),
        run_gate=_gate(_fail(2), []),
        on_gate_failed=on_gate_failed,
    )
    assert seen == [1, 2]


# --------------------------- config plumbing ---------------------------


def test_retry_config_accepts_max_total_attempts():
    cfg = RetryConfig(max=3, on_exhausted="approval_gate", max_total_attempts=9)
    assert cfg.max_total_attempts == 9


def test_retry_config_max_total_attempts_defaults_unbounded():
    assert RetryConfig().max_total_attempts is None


# =========================== integration (real interrupts) ===========================


def _approval_block_manifest(max_retries=2, max_total_attempts=None) -> WorkflowManifest:
    from orchestrator.manifest import BuildStep, ScriptStep

    return WorkflowManifest(
        steps={
            "work": [
                BuildStep(
                    id="loop",
                    produce=["fix"],
                    gate=["check"],
                    retry=RetryConfig(
                        max=max_retries,
                        on_exhausted="approval_gate",
                        max_total_attempts=max_total_attempts,
                    ),
                )
            ]
        },
        defs={
            "fix": ScriptStep(id="fix", path="fix.sh"),
            "check": ScriptStep(id="check", path="check.sh"),
        },
    )


async def _drive(monkeypatch, tmp_path, manifest, fake, replies, *, reopen=False):
    """Drive a declared build through plan approval + each exhaustion interrupt.

    `replies` is fed one per pause (first is the plan-approval 'yes'). With
    reopen=True every step runs in a FRESH workflow context off the same
    checkpoint db — exercising cross-process resume (replay of prior @tasks)."""
    from tests.conftest import with_standard_build
    from tests.test_phase42_declarative_blocks import _Stubs, _patch_spine
    from orchestrator.workflow import build_workflow

    stubs = _Stubs()
    _patch_spine(stubs, monkeypatch)
    monkeypatch.setattr(
        "orchestrator.workflow.load_manifest",
        lambda *a, **k: with_standard_build(manifest),
    )
    monkeypatch.setattr("orchestrator.workflow.execute_script", fake)

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    db = str(tmp_path / "ckpt.db")
    inputs = ["req"] + [Command(resume=r) for r in replies]

    result, interrupts = None, []
    if reopen:
        for inp in inputs:
            async with build_workflow(db_path=db) as wf:
                result = await wf.ainvoke(inp, config=config)
            if "__interrupt__" in result:
                interrupts.append(result["__interrupt__"][0].value)
    else:
        async with build_workflow(db_path=db) as wf:
            for inp in inputs:
                result = await wf.ainvoke(inp, config=config)
                if "__interrupt__" in result:
                    interrupts.append(result["__interrupt__"][0].value)
    return result, interrupts


@pytest.mark.asyncio
async def test_integration_extend_then_pass_resumes_across_extend(monkeypatch, tmp_path):
    from tests.test_phase42_declarative_blocks import _fake_execute_script_factory

    # gate passes on the 4th run: budget 2 exhausts → grant 2 → attempts 3,4 →
    # pass. reopen=True so the granted attempts replay prior ones from checkpoint.
    fake, calls = _fake_execute_script_factory(gate_passes_on_attempt=4)
    result, interrupts = await _drive(
        monkeypatch, tmp_path, _approval_block_manifest(max_retries=2),
        fake, replies=["yes", "2"], reopen=True,
    )
    assert result["status"] == "succeeded"
    # Plan approval, then the exhaustion prompt advertising the number option.
    assert interrupts[-1]["kind"] == "retry_exhausted"
    assert "number" in interrupts[-1]["ask"]
    # Prior attempts replayed (no re-spend): producer + gate each ran 4 times total.
    assert sum(1 for c in calls if c == ("fix", False)) == 4
    assert sum(1 for c in calls if c == ("check", True)) == 4


@pytest.mark.asyncio
async def test_integration_extend_exhaust_then_abort(monkeypatch, tmp_path):
    from tests.test_phase42_declarative_blocks import _fake_execute_script_factory

    fake, calls = _fake_execute_script_factory(gate_passes_on_attempt=None)
    result, interrupts = await _drive(
        monkeypatch, tmp_path, _approval_block_manifest(max_retries=1),
        fake, replies=["yes", "1", "abort"],
    )
    assert result["status"] == "failed"
    assert result["qa_failures"] == "lint failed"
    assert "pr_url" not in result
    # Two exhaustion prompts (initial + after the extension), then abort.
    assert [i["kind"] for i in interrupts] == [
        "plan_approval", "retry_exhausted", "retry_exhausted",
    ]
    assert sum(1 for c in calls if c == ("fix", False)) == 2


@pytest.mark.asyncio
async def test_integration_extend_then_proceed_ships(monkeypatch, tmp_path):
    from tests.test_phase42_declarative_blocks import _fake_execute_script_factory

    fake, calls = _fake_execute_script_factory(gate_passes_on_attempt=None)
    result, _ = await _drive(
        monkeypatch, tmp_path, _approval_block_manifest(max_retries=1),
        fake, replies=["yes", "1", "proceed"],
    )
    assert result["status"] == "succeeded"          # ships the failed-gate code
    assert sum(1 for c in calls if c == ("fix", False)) == 2


@pytest.mark.asyncio
async def test_integration_max_total_attempts_clamps(monkeypatch, tmp_path):
    from tests.test_phase42_declarative_blocks import _fake_execute_script_factory

    fake, calls = _fake_execute_script_factory(gate_passes_on_attempt=None)
    # cap=3, budget=2: exhaust → grant "5" clamps to 1 → attempt 3 at the cap →
    # a numeric reply can no longer extend → proceed.
    result, interrupts = await _drive(
        monkeypatch, tmp_path,
        _approval_block_manifest(max_retries=2, max_total_attempts=3),
        fake, replies=["yes", "5", "2"],
    )
    assert result["status"] == "succeeded"
    assert interrupts[1]["remaining"] == 1
    assert interrupts[2]["remaining"] == 0
    assert sum(1 for c in calls if c == ("fix", False)) == 3   # clamped to the cap

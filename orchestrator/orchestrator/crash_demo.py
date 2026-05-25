"""Phase 4 demo: crash a workflow mid-flight, then resume it.

The workflow runs planning_task (an LLM call), then step_two_task (a 5s
sleep). The window to interrupt is during the sleep — after planning has
been checkpointed but before step_two finishes.

Two-step usage:

    # 1. Start fresh. Hit Ctrl-C during the 5-second sleep.
    python -m orchestrator.crash_demo

    # 2. Resume from where you crashed.
    python -m orchestrator.crash_demo --resume

What you should observe:
  - On resume, planning_task does NOT re-call Claude (its output was loaded
    from the SQLite checkpoint).
  - step_two_task runs from the top (it had no completed output to load).
  - The final result is identical to a clean run.

The mechanism that makes this work is the `None` argument to ainvoke. With
a non-None input, ainvoke starts a new run on this thread_id. With None,
it tells LangGraph: don't start a new run, continue the existing thread
from its last checkpoint. The fixed thread_id ("crash-demo") is what links
the two invocations — same thread_id = same workflow run.
"""

import asyncio
import os
import signal
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from orchestrator.workflow import build_workflow


THREAD_ID = "crash-demo"


def _hard_exit_on_sigint(signum, frame) -> None:
    """Simulate a real crash on Ctrl-C.

    Default asyncio behaviour on SIGINT is to raise CancelledError inside
    the running coroutine. LangGraph catches that and writes it to the
    checkpoint as `workflow [errored]` — which puts the thread in a
    *terminal* failed state. Resume then has nothing to pick up.

    Real production crashes (SIGKILL, OOM kill, container termination,
    power loss) don't run Python's cleanup paths. os._exit() mimics that:
    it terminates the process immediately without unwinding the stack, so
    LangGraph never gets a chance to persist the cancellation. The
    checkpoint stays at the last successful task — exactly the state
    resume is designed to recover from.
    """
    print("\n[crash_demo] simulating crash (os._exit — no cleanup)")
    os._exit(130)


signal.signal(signal.SIGINT, _hard_exit_on_sigint)


async def run() -> None:
    resume = "--resume" in sys.argv
    config = {"configurable": {"thread_id": THREAD_ID}}
    Path(".orchestrator").mkdir(exist_ok=True)

    async with build_workflow() as workflow:
        if resume:
            print(f"Resuming thread_id={THREAD_ID!r} (ainvoke(None, ...))...")
            result = await workflow.ainvoke(None, config=config)
        else:
            request = "add a dark mode toggle"
            print(f"Starting thread_id={THREAD_ID!r} with request: {request!r}")
            print("Hit Ctrl-C during the 5s sleep to test resume.\n")
            result = await workflow.ainvoke(request, config=config)
        print(result)


if __name__ == "__main__":
    asyncio.run(run())

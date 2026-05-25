import asyncio
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from orchestrator.workflow import build_workflow


async def run() -> None:
    request = " ".join(sys.argv[1:]) or "add a dark mode toggle"

    # thread_id is the unit of "one workflow run". The checkpointer keys
    # all state by thread_id, so two invocations with the same id share
    # state. Important nuance: calling ainvoke(input, ...) twice with the
    # same thread_id does NOT replay the cached result — it starts a new
    # run. The durability win is for *interrupted* runs: pass `None` as
    # input on the second call and LangGraph resumes from the last
    # checkpoint instead of starting over. See crash_demo.py for that flow.
    config = {"configurable": {"thread_id": "demo-1"}}

    # The checkpointer DB lives in .orchestrator/ — create the directory if
    # it doesn't exist yet. .orchestrator/ is in .gitignore so it never
    # gets committed.
    Path(".orchestrator").mkdir(exist_ok=True)

    # build_workflow is now an async context manager (Phase 3) — it opens
    # the SQLite connection on enter and closes it on exit. The workflow
    # itself is only valid inside this block.
    async with build_workflow() as workflow:
        result = await workflow.ainvoke(request, config=config)
        print(result)


if __name__ == "__main__":
    asyncio.run(run())

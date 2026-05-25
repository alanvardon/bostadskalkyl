"""Walk the checkpointer state history for a given thread_id.

Useful for Phase 3 to see what the checkpointer actually stores — and for
later phases to debug paused, failed, or completed runs without firing up
SQLite directly.

Usage:
    python -m orchestrator.inspect_state               # defaults to demo-1
    python -m orchestrator.inspect_state run-7f3a      # specific thread
"""

import asyncio
import sys

from dotenv import load_dotenv

load_dotenv()

from orchestrator.workflow import build_workflow


async def main() -> None:
    thread_id = sys.argv[1] if len(sys.argv) > 1 else "demo-1"
    config = {"configurable": {"thread_id": thread_id}}

    async with build_workflow() as workflow:
        print(f"State history for thread_id={thread_id!r}:\n")

        # aget_state_history yields one StateSnapshot per checkpoint, newest
        # first. Each snapshot has .values (the workflow's current value),
        # .next (what would run next on resume), and .metadata (step number,
        # source of the write, etc).
        count = 0
        async for state in workflow.aget_state_history(config):
            count += 1
            step = state.metadata.get("step", "?")
            source = state.metadata.get("source", "?")
            print(f"  checkpoint {count}  step={step}  source={source}")
            # NB: state.values is meaningful in StateGraph workflows but is
            # always None for Functional API entrypoints — the return value
            # is stored as the `workflow` task's result, not in values. Skip
            # it to avoid noise.
            if state.next:
                print(f"    next:   {state.next!r}")
            # `tasks` shows tasks scheduled/running/done at this checkpoint.
            # Each PregelTask has .name, .id, .result (if completed), .error.
            # This is where you can see that planning_task ran even when
            # values is still None (the entrypoint hasn't returned yet).
            if state.tasks:
                print(f"    tasks:")
                for t in state.tasks:
                    status = "done" if t.result is not None else (
                        "errored" if t.error else "pending/running"
                    )
                    print(f"      - {t.name}  [{status}]")
                    if t.result is not None:
                        # Truncate long results so the trace stays readable.
                        result_repr = repr(t.result)
                        if len(result_repr) > 120:
                            result_repr = result_repr[:117] + "..."
                        print(f"        result: {result_repr}")
                    if t.error:
                        print(f"        error:  {t.error!r}")
            # `writes` (in metadata) records what each task wrote back to
            # the checkpoint at this step. Useful to see the cache contents
            # for resume.
            writes = state.metadata.get("writes")
            if writes:
                print(f"    writes: {list(writes.keys())}")
            print()

        if count == 0:
            print(f"  (no checkpoints — has the workflow ever run with thread_id={thread_id!r}?)")


if __name__ == "__main__":
    asyncio.run(main())

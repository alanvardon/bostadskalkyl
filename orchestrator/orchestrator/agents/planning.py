# load_dotenv reads the .env file in the current working directory and sets
# environment variables. AsyncAnthropic() with no args picks up ANTHROPIC_API_KEY
# from os.environ, so this is how the key reaches the SDK.
from dotenv import load_dotenv
load_dotenv()

import asyncio
import sys

# AsyncAnthropic is the async-IO variant of the Anthropic client. We use it
# because LangGraph (later phases) runs tasks concurrently in an asyncio loop;
# committing to async now means no rewrites when the framework arrives.
from anthropic import AsyncAnthropic



# Pydantic is a data-validation library. BaseModel gives us automatic
# type coercion and a clean __repr__ — no need to write __init__ or validate
# fields manually. The model acts as a typed contract between the planning
# agent and anything that consumes its output.
from pydantic import BaseModel

# Literal constrains a field to a fixed set of string values at *type-check*
# time (mypy / pyright) AND at runtime when Pydantic validates the object.
# Anything outside the allowed set raises a ValidationError immediately.
from typing import Literal

from orchestrator.usage import TaskUsage




# The system prompt is the agent's persistent instructions — sent on every
# call, separate from the per-request user message. Copied from
# .claude/agents/planning.md with the PLAN COMPLETE sentinel section removed
# (structured output replaces it). The "coordinator" reference is renamed to
# "orchestrator" to match the new system.
PLANNING_SYSTEM_PROMPT = """\
You are a planning agent for Bostadskalkyl, a Swedish house purchase calculator.

Your only job is to produce an implementation plan. You do not write code. You do not make changes.

## Inputs

You receive the user's change request as free text. On a revision, the orchestrator appends the user's feedback to the original request. Treat the most recent feedback as authoritative — the user has already seen the prior plan and is asking for changes.

## When invoked
1. Read CLAUDE.md thoroughly
2. Read index.html and the relevant JS files (calc.js, dom.js, storage.js, modals.js, charts.js, app.js) to understand the current structure
3. Analyse the request

Output a structured plan covering:

### Title
One short line describing the change, kebab-case friendly. This drives the branch name and PR title.
Do not begin the title with the type verb — the branch prefix already carries the type.
- Feature: `Stress test for variable rate scenario` (not "Add stress test...")
- Fix: `LTV calculation rounding error` (not "Fix LTV...")
- Refactor: `Amortisation chart rendering logic` (not "Refactor amortisation...")

### Type
One of: `feature`, `fix`, `refactor`. This drives the branch prefix.
- `feature` — new functionality
- `fix` — corrects a bug or broken behaviour
- `refactor` — restructures existing code without changing behaviour

### Affected areas
- Which part of the CSS block needs changing
- Which part of the HTML needs changing
- Which part of the JS needs changing

### Functions impacted
- Which existing functions are modified
- Which new functions are needed
- Any impact on App.recalc() specifically
- Which App.* namespace is the correct home for any new functions

### localStorage
- Any new keys needed following the bostadskalkyl_* convention
- Which existing keys are affected

### New DOM elements
- New IDs needed
- New CSS classes needed

### Implementation order
Step by step in the exact order changes should be made

### Risks
- What could break
- What to watch carefully during QA

Do not write any code. Do not make any changes.
"""


# PlanResult is the structured output the planning agent returns.
# Wrapping the agent's response in a model means callers never have to
# inspect raw strings or dicts — they work with validated, typed attributes.
# Schema used as the emit_plan tool's input_schema. Excludes `usage` so
# the model is never asked to fill in token-count data.
class _PlanSchema(BaseModel):
    title: str
    type: Literal["feature", "fix", "refactor"]
    plan_text: str


class PlanResult(_PlanSchema):
    # Populated after the API call returns; not part of the LLM tool schema.
    usage: TaskUsage | None = None


async def plan(request: str, model: str = "claude-sonnet-4-6") -> PlanResult:
    """Ask Claude to produce a plan, return it as a validated PlanResult.

    Uses Anthropic's tool-use-as-structured-output pattern:
      1. We declare a fake tool ("emit_plan") whose input schema matches
         PlanResult exactly.
      2. We force tool_choice to that tool, so the model MUST respond by
         "calling" it with arguments matching the schema.
      3. The tool's input is the validated structured output. No string
         parsing, no sentinel matching, no chance of malformed responses
         surviving past this function.

    This is the single biggest robustness win over the old coordinator,
    which relied on the model emitting `PLAN COMPLETE: title=X, type=Y` as
    free text and hoping the regex matched.
    """
    client = AsyncAnthropic()
    response = await client.messages.create(
        model=model,
        max_tokens=4096,
        system=PLANNING_SYSTEM_PROMPT,
        tools=[
            {
                "name": "emit_plan",
                "description": "Emit the structured implementation plan for the requested change.",
                "input_schema": _PlanSchema.model_json_schema(),
            }
        ],
        # tool_choice forces the model to call emit_plan rather than reply
        # with free text. This guarantees the response shape.
        tool_choice={"type": "tool", "name": "emit_plan"},
        messages=[{"role": "user", "content": request}],
    )
    tool_use = next(block for block in response.content if block.type == "tool_use")
    result = PlanResult.model_validate(tool_use.input)
    u = response.usage
    result.usage = TaskUsage(
        model=model,
        input_tokens=u.input_tokens,
        output_tokens=u.output_tokens,
        cache_read_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_creation_tokens=getattr(u, "cache_creation_input_tokens", 0) or 0,
    )
    return result


# Allow `python -m orchestrator.agents.planning "add dark mode"` to run the
# function from the terminal. asyncio.run drives the async function from
# synchronous entry-point code.
if __name__ == "__main__":
    user_request = " ".join(sys.argv[1:]) or "add a dark mode toggle"
    result = asyncio.run(plan(user_request))
    print(result.model_dump_json(indent=2))

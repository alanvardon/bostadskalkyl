"""Prompt loader (Phase 26).

Resolution order for load_prompt(name):
  1. .orchestrator/prompts/{name}.md in the target repo (cwd at runtime)
  2. orchestrator/prompts/{name}.md bundled with this package

This lets any repo override the default prompts by dropping files into
.orchestrator/prompts/ without touching the orchestrator package itself.

The tool-call footer ("When done") is always appended by this module
after loading — it is NOT part of the prompt file. This means overrides
are genuinely plug-and-play: write your custom persona/rules/checklist
and the orchestrator handles the structured-output wiring automatically.
"""

from pathlib import Path

from orchestrator.agent_frontmatter import (
    AgentFrontmatter,
    parse_agent_frontmatter,
    split_frontmatter,
)
from orchestrator.paths import find_project_root

# Bundled defaults live next to this file in orchestrator/prompts/.
_BUNDLED_DIR = Path(__file__).parent / "prompts"


def _resolve_prompt_path(name: str) -> Path | None:
    """The file load_prompt(name) reads: the repo override if present, else the
    bundled default. None if neither exists."""
    override = find_project_root() / ".orchestrator" / "prompts" / f"{name}.md"
    if override.exists():
        return override
    bundled = _BUNDLED_DIR / f"{name}.md"
    return bundled if bundled.exists() else None

# Tool-call footers appended unconditionally after the prompt body.
# These tell the agent how to return its result to the orchestrator.
# They are intentionally generic — no project-specific content.
_IMPLEMENTATION_FOOTER = """\
## When done

1. Confirm every change you made to yourself, organised by the areas the plan touches.

2. If `.claude/skills/static-checks/SKILL.md` exists, run the static checks per that skill. If any check fails, fix the violation and re-run until the script exits 0. Do not proceed until all checks pass.

3. Call the `emit_step_result` tool with:
   - `summary`: a one-line description of what you changed

This call is how the orchestrator captures your output. If you don't call it, the workflow has nothing to record and will fail.

You do NOT produce the PR summary or test plan — those are generated separately, after QA passes, from your diff. Your only structured output is the one-line `summary` above.
"""

_QA_FOOTER = """\
## When done

Call `emit_qa_result` exactly once with:

- `result`: `"PASS"` if every check passed, `"FAIL"` if any failed
- `failures`: empty string when PASS; when FAIL, a markdown report of all failing checks with this structure:
  ```
  # QA failures

  ## <check name>
  <exact description of the problem and its location — file path, line number, code snippet if helpful>

  ## <next failing check>
  ...

  ## Suggested next steps
  <if the fix is obvious, describe it; otherwise omit this section>
  ```

This call is how the orchestrator captures your verdict. If you don't call it, the workflow has nothing to record and will fail. Do not modify any files — your only output is the `emit_qa_result` call.
"""

_FOOTERS: dict[str, str] = {
    "implementation": _IMPLEMENTATION_FOOTER,
    "qa": _QA_FOOTER,
}


def load_prompt(name: str) -> str:
    """Return the full prompt for `name` ('planning', 'implementation', 'qa').

    Loads the body from the target repo override or the bundled default,
    then appends the tool-call footer for agents that require one.
    Raises FileNotFoundError if neither source exists (broken package).
    """
    path = _resolve_prompt_path(name)
    if path is None:
        raise FileNotFoundError(f"no prompt found for {name!r} (override or bundled)")
    # A prompt file may be downloaded from anywhere; strip any leading `---`
    # frontmatter so its metadata never leaks into the prompt body. The
    # frontmatter's model/tools are honoured separately via load_prompt_frontmatter.
    body = split_frontmatter(path.read_text(encoding="utf-8"))[1]

    footer = _FOOTERS.get(name, "")
    return body.rstrip() + "\n\n" + footer if footer else body


def load_prompt_frontmatter(name: str) -> AgentFrontmatter:
    """The frontmatter config (model/tools) of a built-in agent's prompt file.

    Resolves the same override-then-bundled path as load_prompt, so a prompt
    downloaded into .orchestrator/prompts/<name>.md drives the built-in agent's
    model and tools (config.load_config merges this in, with [workflow.<step>]
    overriding). Returns an empty AgentFrontmatter when there's no file or no
    frontmatter — i.e. today's behaviour, defaults untouched."""
    path = _resolve_prompt_path(name)
    if path is None:
        return AgentFrontmatter()
    return parse_agent_frontmatter(path.read_text(encoding="utf-8"))[0]

"""Prompt loader (Phase 26).

Resolution order for load_prompt(name):
  1. .orchestrator/prompts/{name}.md in the target repo (cwd at runtime)
  2. orchestrator/prompts/{name}.md bundled with this package

This lets any repo override the default prompts by dropping files into
.orchestrator/prompts/ without touching the orchestrator package itself.

Landmine: bundled prompts contain structured-output instructions that
the agent loop depends on. Each file starts with a warning comment;
user-supplied overrides that omit those instructions will silently
break the workflow (Pydantic validation failure, retries, eventual abort).
"""

from pathlib import Path

# Bundled defaults live next to this file in orchestrator/prompts/.
_BUNDLED_DIR = Path(__file__).parent / "prompts"

# Target-repo override directory, resolved relative to cwd at call time
# so it picks up whichever repo the orchestrator is running inside.
_OVERRIDE_SUBDIR = Path(".orchestrator") / "prompts"


def load_prompt(name: str) -> str:
    """Return the prompt text for `name` ('planning', 'implementation', 'qa').

    Checks the target repo's .orchestrator/prompts/{name}.md first;
    falls back to the bundled default. Raises FileNotFoundError if
    neither exists (which means the package is broken).
    """
    override = _OVERRIDE_SUBDIR / f"{name}.md"
    if override.exists():
        return override.read_text(encoding="utf-8")

    bundled = _BUNDLED_DIR / f"{name}.md"
    return bundled.read_text(encoding="utf-8")

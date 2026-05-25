"""Deterministic git operations used by workflow tasks.

The orchestrator has a hard split:
  - cognition (planning, implementation, QA) → LLM-driven, probabilistic
  - control  (branch creation, commit, PR)   → subprocess, deterministic

This module owns the deterministic side. No prompts, no models, no
structured output — just shell commands wrapped in Python. Port of
.claude/skills/create-feature-branch.md (Phase 6a) and eventually
.claude/skills/commit-and-pr.md (Phase 6d).
"""

import re
import subprocess
import sys
from pathlib import Path

from orchestrator.agents.planning import PlanResult


# Where to run git commands. The bostadskalkyl repo is the parent of the
# orchestrator/ subproject. Resolving from __file__ rather than process
# cwd so this works whether you launch from orchestrator/, the project
# root, or anywhere else.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent


class BranchCreationError(RuntimeError):
    """Raised when create_branch can't safely create a new branch.

    Three distinct cases all collapse into this exception: dirty tree,
    cannot-reach-main, and branch-already-exists. The message carries the
    detail. The orchestrator treats this as a terminal workflow failure
    — planning's checkpoint is preserved so you can fix the underlying
    issue and re-trigger without re-paying for the LLM call.
    """


def _slugify(title: str, max_len: int = 50) -> str:
    """Convert a plan title into a kebab-case branch slug.

    Rules (matching .claude/skills/create-feature-branch.md):
      - lowercase
      - non-alphanumeric runs → single hyphen
      - strip leading/trailing hyphens
      - truncate to max_len, and strip a trailing hyphen if the cut
        landed mid-word (otherwise you'd get `feature/some-title-`).

    Example: "LTV calculation rounding error" → "ltv-calculation-rounding-error"
    """
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s[:max_len].rstrip("-")


def _run(args: list[str]) -> subprocess.CompletedProcess:
    """Run a git command in REPO_ROOT, raising on non-zero exit.

    capture_output keeps git's chatter off the orchestrator's stdout —
    workflow output shouldn't be mixed with raw shell noise. The caller
    reads .stdout / .stderr if it needs them.
    """
    return subprocess.run(
        args,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )


def create_branch(plan: PlanResult) -> str:
    """Create a feature branch from main based on the plan's title and type.

    Returns the branch name on success. Raises BranchCreationError if:
      - the working tree is dirty (would lose uncommitted changes)
      - main can't be reached (offline, fetch failure, ...)
      - the derived branch already exists

    Leaves HEAD on the new branch. Subsequent tasks (implementation,
    commit) assume that.

    Direct port of .claude/skills/create-feature-branch.md. Same five
    steps in the same order — review them side by side once.
    """
    # 1. Working tree must be clean. We can't safely switch branches
    # otherwise — uncommitted work would either be lost or carried into
    # the new branch (both bad).
    status = _run(["git", "status", "--porcelain"])
    if status.stdout.strip():
        raise BranchCreationError(
            f"working tree is dirty:\n{status.stdout.strip()}"
        )

    # 2. Sync with origin/main first. Branching from a stale local main
    # is how you end up with PRs that conflict from day one.
    try:
        _run(["git", "checkout", "main"])
        _run(["git", "pull"])
    except subprocess.CalledProcessError as e:
        raise BranchCreationError(
            f"cannot reach main: {(e.stderr or e.stdout).strip()}"
        ) from e

    # 3. Derive the branch name. `<type>/<kebab-slug>` — same scheme as
    # your current coordinator.
    slug = _slugify(plan.title)
    branch_name = f"{plan.type}/{slug}"

    # 4. Refuse to clobber an existing branch. If the user retries a
    # request that already produced a branch, they need to either delete
    # it first or pick a different title.
    existing = _run(["git", "branch", "--list", branch_name])
    if existing.stdout.strip():
        raise BranchCreationError(f"branch already exists: {branch_name}")

    # 5. Create and switch.
    _run(["git", "checkout", "-b", branch_name])
    return branch_name


if __name__ == "__main__":
    # Standalone test:
    #   python -m orchestrator.git_ops "Stress test for variable rates" feature
    # No LLM call; doesn't touch the checkpointer. Just exercises the
    # subprocess plumbing against your real repo.
    title = sys.argv[1] if len(sys.argv) > 1 else "test branch creation"
    branch_type = sys.argv[2] if len(sys.argv) > 2 else "feature"
    fake_plan = PlanResult(title=title, type=branch_type, plan_text="(test)")
    try:
        print(f"created: {create_branch(fake_plan)}")
    except BranchCreationError as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)

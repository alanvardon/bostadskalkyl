"""Shared pytest fixtures.

Two autouse fixtures keep the workflow tests hermetic:

- _isolate_runs_dir redirects run-artifact writes into
  .orchestrator/runs/developer_tests/ so they don't mix with real runs.
  Without it, tests that drive build_workflow would leak `test-<uuid>/`
  folders alongside the real `run-<uuid>-<slug>/` ones.

- _isolate_manifest makes load_manifest() return an EMPTY manifest by
  default, so the suite never depends on whatever pluggable steps happen
  to be configured in the real orchestrator.toml. Without it, enabling a
  live llm_agent step in orchestrator.toml would make full-workflow tests
  spawn a real Claude agent at the before_commit seam (slow, flaky, and a
  network dependency). Tests that exercise specific steps (Phase 20/33)
  override this with their own monkeypatch inside the test, which runs
  after this fixture and wins.
"""

import pytest

from orchestrator.manifest import WorkflowManifest
from orchestrator.paths import find_project_root


@pytest.fixture(autouse=True)
def _isolate_runs_dir(monkeypatch):
    runs = find_project_root() / ".orchestrator" / "runs" / "developer_tests"
    monkeypatch.setattr(
        "orchestrator.run_artifacts._runs_dir",
        lambda: runs,
    )


@pytest.fixture(autouse=True)
def _isolate_manifest(monkeypatch):
    monkeypatch.setattr(
        "orchestrator.workflow.load_manifest",
        lambda *a, **k: WorkflowManifest(),
    )

"""Phase 54 — a downloaded agent's frontmatter drives the BUILT-IN spine agents.

Phase 53 made frontmatter drive generic [steps.defs.*]/seam ai_agents. This
extends the same plug-and-play rule to the built-ins (planning/implementation/
qa/docs/summarize): drop a prompt into .orchestrator/prompts/<step>.md and its
frontmatter `model`/`tools` become that built-in's defaults, with an explicit
[workflow.<step>] key still overriding. No frontmatter → today's defaults.

The merge lives in config.load_config, so every consumer (which resolves model
via config.resolved_model and reads tools via load_config().workflow.<step>)
picks it up. branch/commit run no agent, so they're untouched.
"""

from pathlib import Path

import pytest

import orchestrator.config as config_mod
import orchestrator.prompt_loader as pl
from orchestrator.agent_frontmatter import AgentFrontmatter
from orchestrator.config import load_config


def _repo(tmp_path: Path, prompts: dict[str, str] | None = None, toml: str | None = None) -> Path:
    """Build a repo with optional .orchestrator/prompts/<name>.md files and an
    optional orchestrator.toml. Returns the toml path for load_config(path=…)."""
    pdir = tmp_path / ".orchestrator" / "prompts"
    pdir.mkdir(parents=True, exist_ok=True)
    for name, body in (prompts or {}).items():
        (pdir / f"{name}.md").write_text(body, encoding="utf-8")
    toml_path = tmp_path / "orchestrator.toml"
    if toml is not None:
        toml_path.write_text(toml, encoding="utf-8")
    return toml_path


@pytest.fixture
def at_root(tmp_path, monkeypatch):
    """Point the prompt-frontmatter lookup at tmp_path."""
    monkeypatch.setattr(pl, "find_project_root", lambda: tmp_path)
    return tmp_path


# --------------------------- load_prompt_frontmatter ---------------------------


def test_override_frontmatter_is_read(at_root):
    _repo(at_root, prompts={"qa": "---\nmodel: opus\ntools: Read, Grep\n---\nBody.\n"})
    fm = pl.load_prompt_frontmatter("qa")
    assert fm.model == "claude-opus-4-8"
    assert fm.allowed_tools == ["Read", "Grep"]


def test_bundled_prompts_have_no_frontmatter(at_root):
    # The shipped prompts stay frontmatter-free, so the merge is a no-op for a
    # repo that doesn't override them.
    for name in ("planning", "implementation", "qa", "docs", "summarize"):
        assert pl.load_prompt_frontmatter(name) == AgentFrontmatter()


# --------------------------- merge into built-in config ---------------------------


def test_dropped_in_qa_drives_model_and_tools(at_root):
    toml = _repo(
        at_root,
        prompts={"qa": "---\nname: strict\nmodel: opus\ntools: Read, Grep\n---\nQA prompt.\n"},
        toml="",  # empty toml → only frontmatter speaks
    )
    cfg = load_config(path=toml)
    assert cfg.resolved_model(cfg.workflow.qa) == "claude-opus-4-8"
    assert cfg.workflow.qa.allowed_tools == ["Read", "Grep"]


def test_no_toml_file_still_applies_frontmatter(at_root):
    # A repo with a dropped-in agent but no orchestrator.toml at all.
    _repo(at_root, prompts={"implementation": "---\nmodel: opus\n---\nImpl.\n"})
    cfg = load_config(path=at_root / "orchestrator.toml")  # file does not exist
    assert cfg.resolved_model(cfg.workflow.implementation) == "claude-opus-4-8"
    # tools the frontmatter didn't set keep their code default.
    assert cfg.workflow.implementation.allowed_tools == ["Read", "Edit", "Write", "Bash"]


def test_workflow_toml_overrides_frontmatter(at_root):
    toml = _repo(
        at_root,
        prompts={"qa": "---\nmodel: opus\ntools: Read, Grep\n---\nQA.\n"},
        toml='[workflow.qa]\nmodel = "claude-sonnet-4-6"\n',
    )
    cfg = load_config(path=toml)
    assert cfg.resolved_model(cfg.workflow.qa) == "claude-sonnet-4-6"  # TOML wins
    assert cfg.workflow.qa.allowed_tools == ["Read", "Grep"]           # tools still frontmatter


def test_no_frontmatter_keeps_defaults(at_root):
    toml = _repo(at_root, prompts={"qa": "Just a QA prompt, no frontmatter.\n"}, toml="")
    cfg = load_config(path=toml)
    # Untouched WorkflowQaConfig defaults.
    assert cfg.workflow.qa.allowed_tools == ["Read", "Grep", "Bash"]
    assert cfg.resolved_model(cfg.workflow.qa) == cfg.default_model


def test_docs_and_summarize_models_overridable_by_frontmatter(at_root):
    toml = _repo(
        at_root,
        prompts={
            "docs": "---\nmodel: opus\n---\nDocs.\n",
            "summarize": "---\nmodel: sonnet\n---\nSummarize.\n",
        },
        toml="",
    )
    cfg = load_config(path=toml)
    assert cfg.resolved_model(cfg.workflow.docs) == "claude-opus-4-8"
    assert cfg.resolved_model(cfg.workflow.summarize) == "claude-sonnet-4-6"


def test_frontmatter_human_in_loop_is_ignored_for_builtins(at_root):
    # human_in_loop is NOT a built-in frontmatter dial — so a dropped-in qa agent
    # carrying it must NOT trip the Phase 51 guard or change the flag.
    toml = _repo(
        at_root,
        prompts={"qa": "---\nmodel: opus\nhuman_in_loop: true\n---\nQA.\n"},
        toml="",
    )
    cfg = load_config(path=toml)  # no ValueError
    assert cfg.workflow.qa.human_in_loop is False


def test_explicit_workflow_human_in_loop_still_guarded(at_root):
    # The Phase 51 guard is unaffected by the merge.
    toml = _repo(at_root, toml="[workflow.qa]\nhuman_in_loop = true\n")
    with pytest.raises(ValueError, match="human_in_loop"):
        load_config(path=toml)

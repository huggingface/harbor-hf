"""Launch inspection must resolve native plans without executing agent code."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from harbor.models.job.config import DatasetConfig, JobConfig
from harbor.models.trial.config import TaskConfig

from harbor_hf_agents import launch

ROOT = Path(__file__).resolve().parents[3] / "presets"
SHA = "a" * 40
HASH = "sha256:" + "b" * 64
URL = "https://github.com/example-org/example-task.git"


def config() -> JobConfig:
    return JobConfig.model_validate(
        {
            "datasets": [{"repo": f"{URL}@{SHA}", "path": "tasks"}],
            "agents": [
                {
                    "import_path": "harbor_hf_agents.pi.agent:PiAgent",
                    "model_name": "huggingface/example/model:provider",
                    "kwargs": {"version": "0.84.4"},
                }
            ],
            "environment": {
                "import_path": (
                    "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment"
                ),
                "kwargs": {"flavor": "cpu-basic", "run_label": "test"},
            },
        }
    )


def test_catalog_uses_native_schemas_and_does_not_construct_agents() -> None:
    result = launch.catalog(ROOT)
    entries = result["agents"]
    assert isinstance(entries, list)
    assert len(entries) >= 3
    assert result["harbor_revision"] == launch.REVISION
    assert any(entry["label"].startswith("pi (") for entry in entries)
    assert any(entry["label"].startswith("openclaw (") for entry in entries)
    assert any(entry["label"] == "acp" for entry in entries)
    launch.check_agents(config(), result, [])
    wrong_route = config()
    wrong_route.agents[0].model_name = "openai/example/model:provider"
    with pytest.raises(ValueError, match="Model route"):
        launch.check_agents(wrong_route, result, [])


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/a/b",
        "https://localhost/a",
        "file:///tmp/repo",
        "https://user:pass@github.com/a/b",
        "https://github.com:443/a/b",
        "https://github.com/a/b?token=x",
    ],
)
def test_private_or_credential_sources_rejected(url: str) -> None:
    with pytest.raises(ValueError):
        launch.public_git(url)


@pytest.mark.parametrize(
    "path", ["../task", "/tmp/task", "~/.config", "tasks/../../task", "tasks\\task"]
)
def test_paths_cannot_escape_repo(path: str) -> None:
    with pytest.raises(ValueError):
        launch.relative_path(path)


def test_native_git_and_package_sources() -> None:
    launch.check_sources(config())
    launch.check_dataset(DatasetConfig(name="example-org/example-dataset", ref=HASH))
    launch.check_task(TaskConfig(name="example-org/example-task", ref=HASH))
    launch.check_task(TaskConfig(git_url=URL, git_commit_id=SHA, path=Path("task")))


@pytest.mark.parametrize(
    "source",
    [
        {"repo": URL},
        {"repo": f"{URL}@main"},
        {"path": "/tmp/tasks"},
        {"name": "example-org/example-dataset", "ref": "latest"},
        {"repo": f"{URL}@{SHA}", "download_dir": "/tmp/tasks"},
    ],
)
def test_sources_require_immutable_remote_refs(source: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        launch.check_dataset(DatasetConfig.model_validate(source))


@pytest.mark.parametrize(
    "task",
    [
        {"path": "/tmp/task"},
        {"git_url": URL},
        {"git_url": URL, "git_commit_id": "main"},
        {"name": "example-org/example-task", "ref": "latest"},
        {"name": "example-org/example-task", "ref": HASH, "download_dir": "/tmp/task"},
    ],
)
def test_tasks_require_immutable_remote_refs(task: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        launch.check_task(TaskConfig.model_validate(task))


@pytest.mark.parametrize(
    "kwargs",
    [
        {"version": "latest"},
        {"version": "0.1;id"},
        {"version": "0.84.4", "thinking": "not-valid"},
        {"version": "0.84.4", "prompt_template_path": "/tmp/template"},
    ],
)
def test_agent_options_are_native_and_restricted(kwargs: dict[str, object]) -> None:
    job = config()
    job.agents[0].kwargs = kwargs
    with pytest.raises(ValueError):
        launch.check_agents(job, launch.catalog(ROOT), [])


def test_unknown_import_rejected_before_factory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    available = launch.catalog(ROOT)
    job = config()
    job.agents[0].import_path = "unreviewed.module:Agent"
    factory = Mock(side_effect=AssertionError("must not import request code"))
    monkeypatch.setattr(launch.AgentFactory, "get_agent_class_from_config", factory)
    with pytest.raises(ValueError, match="reviewed installed catalog"):
        launch.check_agents(job, available, [])
    factory.assert_not_called()


def test_custom_source_requires_exact_approval() -> None:
    source = {
        "repo_url": URL,
        "ref": SHA,
        "source_dir": ".",
        "manifest_path": "harbor-agent.json",
    }
    with pytest.raises(ValueError, match="operator-approved"):
        launch.check_acp_source(source, [])
    launch.check_acp_source(source, [source])
    changed = {**source, "ref": "c" * 40}
    with pytest.raises(ValueError):
        launch.check_acp_source(changed, [source])
    with pytest.raises(ValueError, match="immutable"):
        launch.check_acp_source({**source, "ref": "main"}, [{**source, "ref": "main"}])


@pytest.mark.asyncio
async def test_metrics_rejected_before_planning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = SimpleNamespace(
        get_dataset_metadata=AsyncMock(
            return_value=SimpleNamespace(files=["metric.py"], metrics=[])
        )
    )
    monkeypatch.setattr(launch.RegistryClientFactory, "create", lambda **_: client)
    with pytest.raises(ValueError, match="executable metrics"):
        await launch.check_metrics(config())


@pytest.mark.asyncio
async def test_inspection_reports_native_counts_and_checks_not_performed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = config()
    job.n_attempts = 2
    task = TaskConfig(git_url=URL, git_commit_id=SHA, path=Path("task"))
    monkeypatch.setattr(launch, "check_metrics", AsyncMock())
    monkeypatch.setattr(
        launch.JobPlan, "resolve_task_configs", AsyncMock(return_value=[task])
    )
    monkeypatch.setattr(launch.JobPlan, "resolve_metrics", AsyncMock(return_value={}))
    downloads = {"task": SimpleNamespace(path=Path("task"))}
    monkeypatch.setattr(
        launch.JobPlan, "cache_tasks", AsyncMock(return_value=downloads)
    )
    monkeypatch.setattr(
        launch.JobPlan,
        "from_resolved",
        lambda *_args, **_kwargs: SimpleNamespace(
            task_configs=[task], trial_configs=[1, 2], task_download_results=downloads
        ),
    )
    monkeypatch.setattr(
        launch,
        "Task",
        lambda _, **_kwargs: SimpleNamespace(
            config=SimpleNamespace(
                environment=SimpleNamespace(
                    docker_image="test-image@sha256:" + "d" * 64
                )
            )
        ),
    )
    result = await launch.inspect(job.model_dump(mode="json"), ROOT, [])
    assert result["tasks"] == 1
    assert result["trials"] == 2
    assert "Model inference" in result["not_performed"]
    assert "effective_config" not in result


@pytest.mark.asyncio
async def test_resolved_task_urls_are_checked_before_download(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(launch, "check_metrics", AsyncMock())
    monkeypatch.setattr(
        launch.JobPlan,
        "resolve_task_configs",
        AsyncMock(
            return_value=[
                TaskConfig(
                    git_url="https://localhost/private",
                    git_commit_id=SHA,
                    path=Path("task"),
                )
            ]
        ),
    )
    download = AsyncMock()
    monkeypatch.setattr(launch.JobPlan, "cache_tasks", download)
    with pytest.raises(ValueError, match="public GitHub"):
        await launch.inspect(config().model_dump(mode="json"), ROOT, [])
    download.assert_not_called()


@pytest.mark.asyncio
async def test_real_native_plan_expands_agents_and_attempts_without_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from harbor.tasks.client import TaskDownloadResult

    task_dir = tmp_path / "task"
    task_dir.mkdir()
    (task_dir / "task.toml").write_text(
        'version = "1.0"\n[environment]\ndocker_image = "example-image:fixed"\n'
    )
    (task_dir / "instruction.md").write_text("Test instruction.")
    (task_dir / "tests").mkdir()
    (task_dir / "tests" / "test.sh").write_text("exit 99\n")
    task = TaskConfig(git_url=URL, git_commit_id=SHA, path=Path("task"))
    job = config()
    job.datasets = []
    job.tasks = [task]
    job.agents.append(job.agents[0].model_copy(deep=True))
    job.agents[1].kwargs["version"] = "0.84.3"
    job.n_attempts = 2
    download = TaskDownloadResult(
        path=task_dir, download_time_sec=0, cached=True, resolved_git_commit_id=SHA
    )
    monkeypatch.setattr(
        launch.JobPlan,
        "cache_tasks",
        AsyncMock(return_value={task.get_task_id(): download}),
    )
    result = await launch.inspect(job.model_dump(mode="json"), ROOT, [])
    assert (result["tasks"], result["agents"], result["trials"]) == (1, 2, 4)
    job.n_concurrent_trials = 1
    assert (await launch.inspect(job.model_dump(mode="json"), ROOT, []))["trials"] == 4


def test_installed_revision_is_attested() -> None:
    launch.check_revision()


def test_revision_mismatch_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        launch.importlib.metadata,
        "distribution",
        lambda _: SimpleNamespace(
            read_text=lambda _: '{"vcs_info":{"commit_id":"wrong"}}'
        ),
    )
    with pytest.raises(ValueError, match="revision"):
        launch.check_revision()

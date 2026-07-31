from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest

import harbor_hf.benchmark_source as benchmark_source
from harbor_hf.benchmark_source import (
    BenchmarkSourceLock,
    PackageBenchmarkSourceLock,
    anonymous_git_environment,
    bundle_prefix,
    bundle_uri,
    known_credential_values,
    load_source_lock,
    prepare_benchmark_source,
    resolve_benchmark_source,
    resolved_experiment,
    source_lock_bytes,
    source_lock_digest,
    source_lock_from_spec,
    source_lock_json_schema,
    verify_anonymous_git_source,
)
from harbor_hf.campaigns import (
    CampaignLock,
    build_campaign_lock,
    build_campaign_plan,
    build_wave_lock,
)
from harbor_hf.control import CampaignSubmittedPayload, new_event
from harbor_hf.harbor_adapter import build_execution_request
from harbor_hf.models import (
    BundleBenchmarkSource,
    DirectoryBenchmarkSource,
    ExperimentSpec,
    GitBenchmarkSource,
)
from harbor_hf.reconciler import plan_reconciliation
from harbor_hf.runs import build_run_lock


def _with_source(spec: ExperimentSpec, source: object) -> ExperimentSpec:
    raw = spec.model_dump(mode="python")
    raw["benchmark"]["dataset"] = "shellbench/local"
    raw["benchmark"]["source"] = source
    raw["benchmark"].pop("dataset_digest", None)
    return ExperimentSpec.model_validate(raw)


def test_directory_resolution_is_content_addressed_and_path_independent(
    remote_spec: ExperimentSpec,
    tmp_path: Path,
) -> None:
    first = tmp_path / "first" / "tasks"
    second = tmp_path / "second" / "tasks"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    (first / "task.toml").write_text("name='same'\n", encoding="utf-8")
    (second / "task.toml").write_text("name='same'\n", encoding="utf-8")
    first_manifest = tmp_path / "first" / "campaign.yaml"
    second_manifest = tmp_path / "second" / "campaign.yaml"
    first_manifest.write_text("campaign\n", encoding="utf-8")
    second_manifest.write_text("campaign\n", encoding="utf-8")
    spec = _with_source(
        remote_spec,
        DirectoryBenchmarkSource(path="tasks").model_dump(mode="python"),
    )

    first_resolution = resolve_benchmark_source(
        spec, first_manifest, tmp_path / "workspace-one"
    )
    second_resolution = resolve_benchmark_source(
        spec, second_manifest, tmp_path / "workspace-two"
    )

    assert first_resolution.lock == second_resolution.lock
    assert source_lock_digest(first_resolution.lock) == source_lock_digest(
        second_resolution.lock
    )
    assert first_resolution.bundle is not None
    assert second_resolution.bundle is not None
    assert "first" not in source_lock_bytes(first_resolution.lock).decode()
    assert "second" not in source_lock_bytes(second_resolution.lock).decode()
    resolved = resolved_experiment(spec, first_resolution.lock)
    assert isinstance(resolved.benchmark.source, BundleBenchmarkSource)
    assert resolved.benchmark.dataset_digest == resolved.benchmark.source.content_digest


@pytest.mark.parametrize(
    "path",
    ["/absolute", ".", "tasks/../private", "tasks\\private", "tasks\0private"],
)
def test_git_source_rejects_unsafe_paths(path: str) -> None:
    with pytest.raises(ValueError, match="safely relative"):
        GitBenchmarkSource(
            repository="ShellBench/public-tasks",
            revision="8" * 40,
            path=path,
        )


def test_source_lock_is_canonical_and_supports_package_git_and_bundle(
    remote_spec: ExperimentSpec,
    tmp_path: Path,
) -> None:
    package = source_lock_from_spec(remote_spec)
    assert isinstance(package.source, PackageBenchmarkSourceLock)
    assert package.source.reference == "harbor/terminal-bench@sha256:" + "1" * 64

    git = GitBenchmarkSource(
        repository="https://github.com/ShellBench/public-tasks.git",
        revision="8" * 40,
        path="tasks/115-tasks",
    )
    git_spec = _with_source(remote_spec, git.model_dump(mode="python"))
    git_lock = resolve_benchmark_source(
        git_spec,
        tmp_path / "campaign.yaml",
        tmp_path / "git-workspace",
        verify_git=False,
    ).lock
    assert git_lock.source == git

    bundle = BundleBenchmarkSource(
        content_digest="sha256:" + "2" * 64,
        manifest_sha256="3" * 64,
    )
    bundle_spec = _with_source(remote_spec, bundle.model_dump(mode="python"))
    assert source_lock_from_spec(bundle_spec).source == bundle
    assert (
        bundle_prefix(bundle.content_digest) == "benchmark-bundles/sha256/" + "2" * 64
    )
    assert bundle_uri("osolmaz", bundle.content_digest) == (
        "hf://buckets/osolmaz/jobs-artifacts/benchmark-bundles/sha256/" + "2" * 64
    )

    path = tmp_path / "source.lock.json"
    path.write_bytes(source_lock_bytes(git_lock))
    assert load_source_lock(path) == git_lock
    value = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")
    with pytest.raises(ValueError, match="canonical JSON"):
        load_source_lock(path)


def test_checked_in_source_lock_schema_matches_the_model() -> None:
    path = (
        Path(__file__).parents[1]
        / "schemas"
        / "benchmark-source-lock-v1alpha1.schema.json"
    )
    assert json.loads(path.read_text(encoding="utf-8")) == source_lock_json_schema()


def test_source_identity_changes_run_shard_trial_and_wave_ids(
    remote_spec: ExperimentSpec,
) -> None:
    first_source = GitBenchmarkSource(
        repository="ShellBench/public-tasks",
        revision="8" * 40,
        path="tasks/115-tasks",
    )
    second_source = first_source.model_copy(update={"revision": "9" * 40})
    first_spec = _with_source(remote_spec, first_source.model_dump(mode="python"))
    second_spec = _with_source(remote_spec, second_source.model_dump(mode="python"))
    first_lock = build_campaign_lock(build_campaign_plan(first_spec), "same-campaign")
    second_lock = build_campaign_lock(build_campaign_plan(second_spec), "same-campaign")

    first_run = first_lock.runs[0]
    second_run = second_lock.runs[0]
    assert first_run.run_id != second_run.run_id
    assert first_run.shards[0].shard_id != second_run.shards[0].shard_id
    assert (
        first_run.shards[0].trials[0].trial_id
        != second_run.shards[0].trials[0].trial_id
    )

    def wave_id(campaign: CampaignLock, spec: ExperimentSpec) -> str:
        submitted = new_event(
            subject_type="campaign",
            subject_id=campaign.campaign_id,
            kind="campaign.submitted",
            producer="cli",
            payload=CampaignSubmittedPayload(plan_digest=campaign.plan_digest),
        )
        action = plan_reconciliation(campaign, [submitted])[1].actions[0]
        return build_wave_lock(campaign, spec, action).wave_id

    assert wave_id(first_lock, first_spec) != wave_id(second_lock, second_spec)


def test_source_resolution_rejects_a_changed_request(
    remote_spec: ExperimentSpec,
) -> None:
    requested = GitBenchmarkSource(
        repository="ShellBench/public-tasks",
        revision="8" * 40,
        path="tasks/115-tasks",
    )
    spec = _with_source(remote_spec, requested.model_dump(mode="python"))
    changed = BenchmarkSourceLock(
        source=requested.model_copy(update={"revision": "9" * 40})
    )

    with pytest.raises(ValueError, match="changed the request"):
        resolved_experiment(spec, changed)


def test_anonymous_git_environment_removes_ambient_authentication() -> None:
    environment = anonymous_git_environment(
        {
            "PATH": "/bin",
            "GITHUB_TOKEN": "github-secret",
            "GH_TOKEN": "gh-secret",
            "SSH_AUTH_SOCK": "/tmp/agent",
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "http.extraHeader",
            "GIT_CONFIG_VALUE_0": "Authorization: secret",
            "GIT_CONFIG_PARAMETERS": "'credential.helper'='bad'",
        }
    )

    assert environment["PATH"] == "/bin"
    assert environment["GITHUB_TOKEN"] == ""
    assert environment["GH_TOKEN"] == ""
    assert environment["SSH_AUTH_SOCK"] == ""
    assert environment["GIT_TERMINAL_PROMPT"] == "0"
    assert environment["GIT_CONFIG_NOSYSTEM"] == "1"
    assert environment["GIT_CONFIG_GLOBAL"] == "/dev/null"
    assert environment["GIT_CONFIG_SYSTEM"] == "/dev/null"
    assert environment["GIT_CONFIG_COUNT"] == "0"
    assert "GIT_CONFIG_KEY_0" not in environment
    assert "GIT_CONFIG_VALUE_0" not in environment
    assert environment["GIT_CONFIG_PARAMETERS"] == ""


def test_anonymous_git_preflight_checks_exact_commit_and_tree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = GitBenchmarkSource(
        repository="ShellBench/public-tasks",
        revision="8" * 40,
        path="tasks/115-tasks",
    )
    calls: list[tuple[list[str], dict[str, str]]] = []
    results = iter(
        [
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout=source.revision + "\n", stderr=""),
            SimpleNamespace(returncode=0, stdout="tree\n", stderr=""),
            SimpleNamespace(
                returncode=0,
                stdout="100644 blob 0123456789abcdef\ttasks/115-tasks/task.toml\n",
                stderr="",
            ),
        ]
    )

    def run(command: list[str], **kwargs: object) -> object:
        environment = cast(dict[str, str], kwargs["env"])
        calls.append((command, environment))
        return next(results)

    monkeypatch.setenv("GITHUB_TOKEN", "must-not-leak")
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "http.extraHeader")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "Authorization: must-not-leak")
    monkeypatch.setattr(benchmark_source.subprocess, "run", run)

    verify_anonymous_git_source(source)

    assert len(calls) == 5
    assert calls[1][0][-2:] == [
        "https://github.com/ShellBench/public-tasks.git",
        source.revision,
    ]
    assert calls[2][0][-2:] == ["rev-parse", "FETCH_HEAD"]
    assert calls[3][0][-2:] == ["-t", "FETCH_HEAD:tasks/115-tasks"]
    assert calls[4][0][-2:] == ["--", "tasks/115-tasks"]
    for _command, environment in calls:
        assert "must-not-leak" not in repr(environment)
        assert environment["GIT_CONFIG_COUNT"] == "0"


def test_anonymous_git_preflight_rejects_a_missing_tree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = GitBenchmarkSource(
        repository="ShellBench/public-tasks",
        revision="8" * 40,
        path="tasks/missing",
    )
    results = iter(
        [
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout=source.revision + "\n", stderr=""),
            SimpleNamespace(returncode=1, stdout="", stderr="missing"),
            SimpleNamespace(returncode=0, stdout="", stderr=""),
        ]
    )
    monkeypatch.setattr(
        benchmark_source.subprocess,
        "run",
        lambda *_args, **_kwargs: next(results),
    )

    with pytest.raises(ValueError, match="path is not a directory"):
        verify_anonymous_git_source(source)


def test_anonymous_git_preflight_rejects_submodules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = GitBenchmarkSource(
        repository="ShellBench/public-tasks",
        revision="8" * 40,
        path="tasks/115-tasks",
    )
    results = iter(
        [
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout=source.revision + "\n", stderr=""),
            SimpleNamespace(returncode=0, stdout="tree\n", stderr=""),
            SimpleNamespace(
                returncode=0,
                stdout=(
                    "160000 commit 0123456789abcdef"
                    "\ttasks/115-tasks/private-dependency\n"
                ),
                stderr="",
            ),
        ]
    )
    monkeypatch.setattr(
        benchmark_source.subprocess,
        "run",
        lambda *_args, **_kwargs: next(results),
    )

    with pytest.raises(ValueError, match="cannot contain submodules"):
        verify_anonymous_git_source(source)


def test_bundle_loading_extracts_and_renders_a_local_harbor_dataset(
    remote_spec: ExperimentSpec,
    tmp_path: Path,
) -> None:
    source = tmp_path / "tasks"
    source.mkdir()
    (source / "task.toml").write_text("name='local'\n", encoding="utf-8")
    spec = _with_source(
        remote_spec,
        DirectoryBenchmarkSource(path=str(source)).model_dump(mode="python"),
    )
    resolution = resolve_benchmark_source(
        spec, tmp_path / "campaign.yaml", tmp_path / "workspace"
    )
    assert resolution.bundle is not None
    extracted = prepare_benchmark_source(
        resolution.lock,
        mounted_bundle_root=resolution.bundle.bundle_root,
        destination=tmp_path / "extracted",
    )
    assert extracted == tmp_path / "extracted"
    assert extracted is not None
    resolved = resolved_experiment(spec, resolution.lock)
    lock = build_run_lock(resolved, run_id="bundle-run")
    request = build_execution_request(
        lock,
        tmp_path / "jobs",
        "https://endpoint.example",
        task_names=lock.benchmark_tasks,
        attempts=1,
        concurrency=1,
        expected_task_digests=lock.benchmark_task_digests,
        benchmark_root=extracted,
    )

    datasets = request.harbor_config["datasets"]
    assert isinstance(datasets, list)
    assert datasets == [
        {"path": str(extracted.resolve()), "task_names": lock.benchmark_tasks}
    ]


def test_remote_git_preparation_repeats_anonymous_preflight(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = GitBenchmarkSource(
        repository="ShellBench/public-tasks",
        revision="8" * 40,
        path="tasks/115-tasks",
    )
    observed: list[GitBenchmarkSource] = []
    monkeypatch.setattr(
        benchmark_source,
        "verify_anonymous_git_source",
        observed.append,
    )

    result = prepare_benchmark_source(
        BenchmarkSourceLock(source=source),
        mounted_bundle_root=tmp_path / "unused",
        destination=tmp_path / "unused-destination",
    )

    assert result is None
    assert observed == [source]


def test_known_credential_values_selects_only_credential_like_environment() -> None:
    assert known_credential_values(
        {
            "PATH": "/ordinary/path",
            "SHORT_TOKEN": "short",
            "HARBOR_HF_JOB_TOKEN": "purpose-scoped-value",
            "SERVICE_PASSWORD": "password-value",
            "UNRELATED": "not-selected",
        }
    ) == ("purpose-scoped-value", "password-value")

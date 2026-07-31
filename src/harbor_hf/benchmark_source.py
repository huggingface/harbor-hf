from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from harbor_hf.benchmark_bundle import (
    PreparedBenchmarkBundle,
    build_benchmark_bundle,
    extract_benchmark_bundle,
    validate_benchmark_bundle,
)
from harbor_hf.models import (
    BenchmarkSpec,
    BundleBenchmarkSource,
    DirectoryBenchmarkSource,
    ExperimentSpec,
    GitBenchmarkSource,
    pinned_harbor_dataset_reference,
)

_SOURCE_LOCK_SCHEMA = "harbor-hf/benchmark-source-lock/v1alpha1"
_BUNDLE_PREFIX = "benchmark-bundles/sha256"
_CREDENTIAL_ENVIRONMENT_MARKERS = (
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "API_KEY",
    "PRIVATE_KEY",
    "CREDENTIAL",
)
_GIT_AUTH_ENVIRONMENT = {
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
}


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PackageBenchmarkSourceLock(FrozenModel):
    type: Literal["package"] = "package"
    reference: str = Field(
        pattern=(
            r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*"
            r"@sha256:[0-9a-f]{64}$"
        )
    )


ResolvedBenchmarkSource = Annotated[
    GitBenchmarkSource | BundleBenchmarkSource | PackageBenchmarkSourceLock,
    Field(discriminator="type"),
]


class BenchmarkSourceLock(FrozenModel):
    schema_version: Literal["harbor-hf/benchmark-source-lock/v1alpha1"] = (
        _SOURCE_LOCK_SCHEMA
    )
    source: ResolvedBenchmarkSource


@dataclass(frozen=True)
class BenchmarkSourceResolution:
    lock: BenchmarkSourceLock
    bundle: PreparedBenchmarkBundle | None = None


class GitRunner(Protocol):
    def __call__(self, source: GitBenchmarkSource) -> None: ...


class BundleBuilder(Protocol):
    def __call__(
        self,
        source_root: Path,
        destination: Path,
        *,
        known_secrets: tuple[str, ...] = (),
    ) -> PreparedBenchmarkBundle: ...


def source_lock_json_schema() -> dict[str, object]:
    return BenchmarkSourceLock.model_json_schema()


def source_lock_bytes(lock: BenchmarkSourceLock) -> bytes:
    return (
        json.dumps(
            lock.model_dump(mode="json"),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        + "\n"
    ).encode("utf-8")


def source_lock_digest(lock: BenchmarkSourceLock) -> str:
    return "sha256:" + hashlib.sha256(source_lock_bytes(lock)).hexdigest()


def bundle_prefix(content_digest: str) -> str:
    return f"{_BUNDLE_PREFIX}/{content_digest.removeprefix('sha256:')}"


def bundle_uri(namespace: str, content_digest: str) -> str:
    return f"hf://buckets/{namespace}/jobs-artifacts/{bundle_prefix(content_digest)}"


def resolve_benchmark_source(
    spec: ExperimentSpec,
    manifest_path: Path,
    workspace: Path,
    *,
    verify_git: bool = True,
    git_runner: GitRunner = lambda source: verify_anonymous_git_source(source),
    bundle_builder: BundleBuilder = build_benchmark_bundle,
    known_secrets: tuple[str, ...] | None = None,
) -> BenchmarkSourceResolution:
    source = spec.benchmark.source
    if source is None:
        reference = pinned_harbor_dataset_reference(
            spec.benchmark.dataset, spec.benchmark.dataset_digest
        )
        return BenchmarkSourceResolution(
            BenchmarkSourceLock(source=PackageBenchmarkSourceLock(reference=reference))
        )
    if isinstance(source, GitBenchmarkSource):
        if verify_git:
            git_runner(source)
        return BenchmarkSourceResolution(BenchmarkSourceLock(source=source))
    if isinstance(source, BundleBenchmarkSource):
        return BenchmarkSourceResolution(BenchmarkSourceLock(source=source))
    if not isinstance(source, DirectoryBenchmarkSource):
        raise ValueError("benchmark source type is not supported")
    requested = Path(source.path)
    source_root = (
        requested if requested.is_absolute() else manifest_path.parent / requested
    )
    bundle = bundle_builder(
        source_root,
        workspace / "benchmark-bundle",
        known_secrets=(
            known_credential_values() if known_secrets is None else known_secrets
        ),
    )
    resolved = BundleBenchmarkSource(
        content_digest=bundle.manifest.content_digest,
        manifest_sha256=bundle.manifest_sha256,
    )
    return BenchmarkSourceResolution(
        BenchmarkSourceLock(source=resolved),
        bundle=bundle,
    )


def source_lock_from_spec(spec: ExperimentSpec) -> BenchmarkSourceLock:
    source = spec.benchmark.source
    if source is None:
        reference = pinned_harbor_dataset_reference(
            spec.benchmark.dataset, spec.benchmark.dataset_digest
        )
        return BenchmarkSourceLock(
            source=PackageBenchmarkSourceLock(reference=reference)
        )
    if isinstance(source, DirectoryBenchmarkSource):
        raise ValueError("directory benchmark source must be resolved before planning")
    return BenchmarkSourceLock(source=source)


def resolved_experiment(
    spec: ExperimentSpec,
    lock: BenchmarkSourceLock,
) -> ExperimentSpec:
    requested = spec.benchmark.source
    resolved = lock.source
    _validate_source_resolution(spec, requested, resolved)
    if not isinstance(requested, DirectoryBenchmarkSource):
        return spec
    assert isinstance(resolved, BundleBenchmarkSource)
    benchmark = BenchmarkSpec.model_validate(
        {
            **spec.benchmark.model_dump(
                mode="python", exclude={"source", "dataset_digest"}
            ),
            "source": resolved.model_dump(mode="python"),
            "dataset_digest": resolved.content_digest,
        }
    )
    return ExperimentSpec.model_validate(
        {
            **spec.model_dump(mode="python", exclude={"benchmark"}),
            "benchmark": benchmark.model_dump(mode="python"),
        }
    )


def _validate_source_resolution(
    spec: ExperimentSpec,
    requested: object,
    resolved: ResolvedBenchmarkSource,
) -> None:
    if requested is None:
        if not isinstance(resolved, PackageBenchmarkSourceLock):
            raise ValueError("package benchmark resolved to a different source type")
        expected = pinned_harbor_dataset_reference(
            spec.benchmark.dataset, spec.benchmark.dataset_digest
        )
        if resolved.reference != expected:
            raise ValueError("package benchmark source lock changed its reference")
        return
    if isinstance(requested, (GitBenchmarkSource, BundleBenchmarkSource)):
        if resolved != requested:
            raise ValueError("benchmark source lock changed the request")
        return
    if not isinstance(requested, DirectoryBenchmarkSource) or not isinstance(
        resolved, BundleBenchmarkSource
    ):
        raise ValueError("directory benchmark did not resolve to a bundle")


def prepare_benchmark_source(
    lock: BenchmarkSourceLock,
    *,
    mounted_bundle_root: Path,
    destination: Path,
) -> Path | None:
    if isinstance(lock.source, GitBenchmarkSource):
        verify_anonymous_git_source(lock.source)
        return None
    if not isinstance(lock.source, BundleBenchmarkSource):
        return None
    validate_bundle_for_lock(mounted_bundle_root, lock)
    return extract_benchmark_bundle(mounted_bundle_root, destination)


def validate_bundle_for_lock(
    root: Path,
    lock: BenchmarkSourceLock,
) -> None:
    source = lock.source
    if not isinstance(source, BundleBenchmarkSource):
        raise ValueError("benchmark source lock does not select a bundle")
    manifest = validate_benchmark_bundle(root)
    manifest_bytes = (root / "bundle.json").read_bytes()
    if manifest.content_digest != source.content_digest:
        raise ValueError("mounted benchmark bundle content digest changed")
    if hashlib.sha256(manifest_bytes).hexdigest() != source.manifest_sha256:
        raise ValueError("mounted benchmark bundle manifest digest changed")


def verify_anonymous_git_source(source: GitBenchmarkSource) -> None:
    environment = anonymous_git_environment()
    repository = f"https://github.com/{source.repository}.git"
    try:
        with tempfile.TemporaryDirectory(prefix="harbor-hf-public-git-") as name:
            root = Path(name)
            repository_root = root / "repository"
            isolated_home = root / "home"
            isolated_home.mkdir()
            environment.update(
                {"HOME": str(isolated_home), "XDG_CONFIG_HOME": str(isolated_home)}
            )
            initialized = subprocess.run(
                ["git", "init", "--bare", str(repository_root)],
                text=True,
                capture_output=True,
                timeout=30,
                env=environment,
            )
            if initialized.returncode != 0:
                raise ValueError("public Git anonymous preflight could not initialize")
            fetched = subprocess.run(
                [
                    "git",
                    "-C",
                    str(repository_root),
                    "-c",
                    "credential.helper=",
                    "fetch",
                    "--depth",
                    "1",
                    "--filter=blob:none",
                    repository,
                    source.revision,
                ],
                text=True,
                capture_output=True,
                timeout=120,
                env=environment,
            )
            if fetched.returncode != 0:
                raise ValueError(
                    "Git benchmark must be anonymously readable at its full commit"
                )
            resolved = subprocess.run(
                ["git", "-C", str(repository_root), "rev-parse", "FETCH_HEAD"],
                text=True,
                capture_output=True,
                timeout=30,
                env=environment,
            )
            source_tree = subprocess.run(
                [
                    "git",
                    "-C",
                    str(repository_root),
                    "cat-file",
                    "-t",
                    f"FETCH_HEAD:{source.path}",
                ],
                text=True,
                capture_output=True,
                timeout=30,
                env=environment,
            )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("public Git anonymous preflight could not run") from error
    if resolved.returncode != 0 or resolved.stdout.strip() != source.revision:
        raise ValueError("Git benchmark anonymous preflight returned another revision")
    if source_tree.returncode != 0 or source_tree.stdout.strip() != "tree":
        raise ValueError("Git benchmark path is not a directory at its locked revision")


def known_credential_values(
    environment: Mapping[str, str] | None = None,
) -> tuple[str, ...]:
    selected = os.environ if environment is None else environment
    return tuple(
        dict.fromkeys(
            value
            for name, value in selected.items()
            if len(value) >= 8
            and any(
                marker in name.upper() for marker in _CREDENTIAL_ENVIRONMENT_MARKERS
            )
        )
    )


def anonymous_git_environment(
    base: dict[str, str] | None = None,
) -> dict[str, str]:
    environment = dict(os.environ if base is None else base)
    for name in tuple(environment):
        if name in _GIT_AUTH_ENVIRONMENT or name.startswith("GIT_CONFIG_"):
            environment.pop(name, None)
    askpass = shutil.which("false")
    if askpass is None:
        raise ValueError("anonymous Git requires an executable false command")
    environment.update(
        {
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_COUNT": "0",
            "GIT_CONFIG_PARAMETERS": "",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_ASKPASS": askpass,
            "SSH_ASKPASS": askpass,
            "SSH_AUTH_SOCK": "",
            "GITHUB_TOKEN": "",
            "GH_TOKEN": "",
        }
    )
    return environment


def load_source_lock(path: Path) -> BenchmarkSourceLock:
    lock = BenchmarkSourceLock.model_validate_json(path.read_text(encoding="utf-8"))
    if path.read_bytes() != source_lock_bytes(lock):
        raise ValueError("benchmark source lock is not canonical JSON")
    return lock

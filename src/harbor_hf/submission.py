from __future__ import annotations

import hashlib
import os
import re
import shlex
import tempfile
import uuid
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol, cast

from huggingface_hub import CommitOperationAdd
from huggingface_hub.errors import HfHubHTTPError
from pydantic import BaseModel, ConfigDict

from harbor_hf.benchmark_bundle import PreparedBenchmarkBundle
from harbor_hf.benchmark_source import (
    BenchmarkSourceLock,
    PackageBenchmarkSourceLock,
    bundle_uri,
    load_source_lock,
    source_lock_digest,
)
from harbor_hf.benchmark_staging import (
    BenchmarkBundleReceipt,
    BucketStagingApi,
    stage_benchmark_bundle,
    verify_staged_benchmark_bundle,
)
from harbor_hf.controller_status import (
    ControllerAttemptReservation,
    ControllerLaunchClaim,
    ControllerLaunchReceipt,
    ControllerLaunchUnavailable,
    ControllerStateStore,
    controller_launch_receipt_path,
)
from harbor_hf.coordination import bucket_id, coordination_repository
from harbor_hf.credentials import configured_job_hf_token
from harbor_hf.executions import ExecutionLock
from harbor_hf.judge_recorder import JUDGE_RECORDER_PORT
from harbor_hf.models import (
    BundleBenchmarkSource,
    DeploymentProfile,
    EndpointRef,
    ExperimentSpec,
    SourcePin,
    pinned_harbor_dataset_reference,
)
from harbor_hf.process import ProcessError
from harbor_hf.provider_models import ProviderTarget
from harbor_hf.run_input import write_run_input
from harbor_hf.runs import EndpointWaveTarget, RunLock, WaveLock

_JOB_ID = re.compile(r"(?<![a-f0-9])[a-f0-9]{24}(?![a-f0-9])")
_GITHUB_REPOSITORY = re.compile(
    r"^(?:https://github\.com/)?"
    r"(?P<owner>[A-Za-z0-9_.-]+)/(?P<name>[A-Za-z0-9_.-]+?)(?:\.git)?/?$"
)
_JOB_INPUT_BUCKET_NAME = "jobs-artifacts"
_COORDINATION_INITIALIZATION_PATH = ".harbor-hf-initialized"
_COORDINATION_INITIALIZATION_PAYLOAD = b"harbor-hf coordination repository\n"
_CONTROLLER_LAUNCH_LEASE = timedelta(minutes=30)
_PHYSICAL_JOB_STARTED_AT_ENV = "HARBOR_HF_JOB_STARTED_AT"
_PROHIBITED_GIT_SECRET_NAMES = {
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
}
_REMOTE_SECRET_SOURCES = {
    "HF_TOKEN": "HARBOR_HF_JOB_TOKEN",
    "HF_INFERENCE_TOKEN": "HARBOR_HF_JOB_INFERENCE_TOKEN",
    "OPENAI_API_KEY": "HARBOR_HF_JOB_OPENAI_API_KEY",
    "GEMINI_API_KEY": "HARBOR_HF_JOB_GEMINI_API_KEY",
}


class TextRunner(Protocol):
    def run_text(self, command: list[str]) -> str: ...


class BucketApi(Protocol):
    def create_bucket(self, bucket_id: str, **kwargs: object) -> object: ...

    def bucket_info(self, bucket_id: str) -> object: ...

    def batch_bucket_files(
        self,
        bucket_id: str,
        *,
        add: list[tuple[str | Path | bytes, str]],
        **kwargs: object,
    ) -> object: ...

    def create_repo(self, repo_id: str, **kwargs: object) -> object: ...

    def repo_info(self, repo_id: str, **kwargs: object) -> object: ...

    def create_commit(
        self, repo_id: str, operations: list[object], **kwargs: object
    ) -> object: ...


class Submission(BaseModel):
    model_config = ConfigDict(frozen=True)

    execution_id: str
    artifact_prefix: str
    job_id: str | None
    source_lock_digest: str
    bundle: BenchmarkBundleReceipt | None = None
    command: list[str]


class WaveSubmission(BaseModel):
    model_config = ConfigDict(frozen=True)

    wave_id: str
    artifact_prefix: str
    job_id: str | None
    command: list[str]


class RunControllerSubmission(BaseModel):
    model_config = ConfigDict(frozen=True)

    run_id: str
    plan_digest: str
    input_digest: str
    input_uri: str
    job_id: str | None
    attempt: int
    launch_receipt: str
    source_lock: BenchmarkSourceLock
    source_lock_digest: str
    secret_names: list[str]
    bundle: BenchmarkBundleReceipt | None = None
    command: list[str]


class ControllerJobsApi(Protocol):
    def list_jobs(self, **kwargs: object) -> Iterable[object]: ...


def github_archive(repository: str, revision: str) -> str:
    return f"{github_repository(repository)}/archive/{revision}.zip"


def github_repository(repository: str) -> str:
    match = _GITHUB_REPOSITORY.fullmatch(repository)
    if match is None:
        raise ValueError("source repository must be a GitHub owner/name or HTTPS URL")
    return f"https://github.com/{match['owner']}/{match['name']}"


def locked_source_command(source: SourcePin, *arguments: str) -> list[str]:
    repository = shlex.quote(github_repository(source.repository))
    revision = shlex.quote(source.revision)
    script = (
        "set -euo pipefail\n"
        f'export {_PHYSICAL_JOB_STARTED_AT_ENV}="$(date -u +%Y-%m-%dT%H:%M:%SZ)"\n'
        "unset GITHUB_TOKEN GH_TOKEN SSH_AUTH_SOCK GIT_SSH GIT_SSH_COMMAND "
        "GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_CONFIG_SYSTEM\n"
        "export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 "
        "GIT_CONFIG_GLOBAL=/dev/null GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false\n"
        "repo_dir=$(mktemp -d)\n"
        "git_home=$(mktemp -d)\n"
        'HOME="$git_home" XDG_CONFIG_HOME="$git_home" '
        "git -c credential.helper= clone --filter=blob:none --no-checkout "
        f'{repository} "$repo_dir"\n'
        'HOME="$git_home" XDG_CONFIG_HOME="$git_home" '
        f'git -C "$repo_dir" -c credential.helper= fetch --depth 1 origin {revision}\n'
        'HOME="$git_home" XDG_CONFIG_HOME="$git_home" '
        f'git -C "$repo_dir" -c credential.helper= checkout --detach {revision}\n'
        'test ! -f "$repo_dir/.gitmodules"\n'
        'exec uv run --project "$repo_dir" --locked --no-dev "$@"\n'
    )
    return ["bash", "-lc", script, "locked-source", *arguments]


def bucket_uri(bucket: str) -> str:
    if bucket.startswith("hf://buckets/"):
        return bucket
    return f"hf://buckets/{bucket.removeprefix('buckets/')}"


def ensure_private_coordination_repository(
    namespace: str, *, api: BucketApi | None = None
) -> str:
    if api is None:
        from huggingface_hub import HfApi

        api = cast(BucketApi, HfApi())
    repository = coordination_repository(namespace)
    api.create_repo(
        repository,
        repo_type="dataset",
        private=True,
        exist_ok=True,
    )
    info = api.repo_info(repository, repo_type="dataset")
    if getattr(info, "private", None) is not True:
        raise ValueError(f"coordination repository {repository} must be private")
    if _commit_identity(info) is None:
        _initialize_coordination_repository(repository, api)
    return repository


def _initialize_coordination_repository(repository: str, api: BucketApi) -> None:
    initialization_error: HfHubHTTPError | None = None
    try:
        api.create_commit(
            repository,
            [
                CommitOperationAdd(
                    path_in_repo=_COORDINATION_INITIALIZATION_PATH,
                    path_or_fileobj=_COORDINATION_INITIALIZATION_PAYLOAD,
                )
            ],
            commit_message="chore: initialize coordination repository",
            repo_type="dataset",
            revision="main",
        )
    except HfHubHTTPError as error:
        initialization_error = error
    info = api.repo_info(repository, repo_type="dataset", revision="main")
    if _commit_identity(info) is not None:
        return
    if initialization_error is not None:
        raise initialization_error
    raise ValueError(f"coordination repository {repository} has no commit identity")


def _commit_identity(info: object) -> str | None:
    revision = getattr(info, "sha", None)
    return revision if isinstance(revision, str) and revision else None


def ensure_private_job_input_bucket(namespace: str, *, api: BucketApi) -> str:
    bucket = f"{namespace}/{_JOB_INPUT_BUCKET_NAME}"
    api.create_bucket(bucket, private=True, exist_ok=True)
    if getattr(api.bucket_info(bucket), "private", None) is not True:
        raise ValueError(f"Job input bucket {bucket} must be private")
    return bucket


def stage_job_input(
    input_dir: Path,
    *,
    bucket: str,
    identity: str,
    api: BucketApi,
) -> str:
    """Upload a content-addressed input bundle and return its HF mount URI."""
    files = sorted(path for path in input_dir.rglob("*") if path.is_file())
    if not files:
        raise ValueError("Job input directory must contain at least one file")
    digest = hashlib.sha256()
    additions: list[tuple[str | Path | bytes, str]] = []
    staged: list[tuple[str, bytes]] = []
    for path in files:
        relative = path.relative_to(input_dir).as_posix()
        content = path.read_bytes()
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
        staged.append((relative, content))
    prefix = f"job-inputs/{identity}/{digest.hexdigest()}"
    additions.extend((content, f"{prefix}/{relative}") for relative, content in staged)
    api.batch_bucket_files(bucket, add=additions)
    return f"hf://buckets/{bucket}/{prefix}"


def require_private_bucket(bucket: str, *, api: BucketApi) -> str:
    normalized = bucket_id(bucket)
    if getattr(api.bucket_info(normalized), "private", None) is not True:
        raise ValueError(f"artifact bucket {normalized} must be private")
    return normalized


def prepare_benchmark_bundle_input(
    source: object,
    *,
    bundle: PreparedBenchmarkBundle | None,
    namespace: str,
    bucket: str,
    api: BucketApi,
) -> BenchmarkBundleReceipt | None:
    if not isinstance(source, BundleBenchmarkSource):
        if bundle is not None:
            raise ValueError("prepared benchmark bundle has no bundle source lock")
        return None
    staging_api = cast(BucketStagingApi, api)
    if bundle is None:
        return verify_staged_benchmark_bundle(
            content_digest=source.content_digest,
            manifest_sha256=source.manifest_sha256,
            namespace=namespace,
            bucket=bucket,
            api=staging_api,
        )
    if (
        bundle.manifest.content_digest != source.content_digest
        or bundle.manifest_sha256 != source.manifest_sha256
    ):
        raise ValueError("prepared benchmark bundle changed its source lock")
    return stage_benchmark_bundle(
        bundle,
        namespace=namespace,
        bucket=bucket,
        api=staging_api,
    )


def _benchmark_bundle_volume(
    source: object,
    *,
    namespace: str,
) -> list[str]:
    if not isinstance(source, BundleBenchmarkSource):
        return []
    return [
        "--volume",
        f"{bundle_uri(namespace, source.content_digest)}:/benchmark-source:ro",
    ]


def _wave_benchmark_bundle_volume(lock: WaveLock) -> list[str]:
    # Deduplicate by content digest: BundleBenchmarkSource is a pydantic model
    # without a hash, so collecting the models themselves in a set raises
    # TypeError. The digest is the bundle's identity.
    sources: dict[str, BundleBenchmarkSource] = {}
    for run in lock.executions:
        source = run.configuration.benchmark_source
        if isinstance(source, BundleBenchmarkSource):
            sources[source.content_digest] = source
    if not sources:
        return []
    if len(sources) != 1:
        raise ValueError("wave executions must use one benchmark bundle")
    return _benchmark_bundle_volume(
        next(iter(sources.values())), namespace=lock.remote.job.namespace
    )


def endpoint_lease_label(lock: ExecutionLock) -> str:
    endpoint = _endpoint_binding(lock)
    return endpoint_lease_label_for(endpoint.namespace, endpoint.name)


def endpoint_lease_label_for(namespace: str, name: str) -> str:
    identity = f"{namespace}/{name}".encode()
    return hashlib.sha256(identity).hexdigest()[:32]


def job_secret_names(lock: ExecutionLock | WaveLock) -> list[str]:
    names = {lock.remote.job.token_secret_name}
    execution_locks = (
        [lock]
        if isinstance(lock, ExecutionLock)
        else [run.configuration for run in lock.executions]
    )
    for execution_lock in execution_locks:
        if isinstance(execution_lock.deployment, ProviderTarget):
            names.add(execution_lock.deployment.token_secret_name)
        judge = execution_lock.benchmark_judge
        if judge is not None:
            names.add(judge.api_key_secret_name)
    token_name = lock.remote.job.token_secret_name
    return [token_name, *sorted(names - {token_name})]


def _secret_arguments(lock: ExecutionLock | WaveLock) -> list[str]:
    return [
        argument for name in job_secret_names(lock) for argument in ("--secrets", name)
    ]


@contextmanager
def _materialized_job_secrets(
    lock: ExecutionLock | WaveLock, command: list[str]
) -> Iterator[list[str]]:
    with _materialized_named_job_secrets(job_secret_names(lock), command) as rendered:
        yield rendered


def reject_git_secret_names(names: Iterable[str]) -> None:
    prohibited = sorted(set(names) & _PROHIBITED_GIT_SECRET_NAMES)
    if prohibited:
        raise ValueError(
            "Git credential secret names cannot be forwarded to remote Jobs: "
            + ", ".join(prohibited)
        )


def remote_job_secret_values(names: list[str]) -> dict[str, str]:
    reject_git_secret_names(names)
    source_names = {
        name: _REMOTE_SECRET_SOURCES.get(name, f"HARBOR_HF_JOB_{name}")
        for name in names
    }
    values: dict[str, str] = {}
    for name, source_name in source_names.items():
        if name == "HF_TOKEN":
            values[name] = configured_job_hf_token() or ""
        else:
            values[name] = os.environ.get(source_name, "")
    missing = [source_names[name] for name, value in values.items() if not value]
    if missing:
        hint = ""
        if "HARBOR_HF_JOB_TOKEN" in missing:
            hint = (
                "; set HARBOR_HF_JOB_TOKEN or run "
                "`harbor-hf auth add-job-token TOKEN_NAME`"
            )
        raise ValueError(
            "required purpose-scoped Job secret sources are unavailable: "
            + ", ".join(sorted(missing))
            + hint
        )
    return values


@contextmanager
def _materialized_named_job_secrets(
    names: list[str], command: list[str]
) -> Iterator[list[str]]:
    values = remote_job_secret_values(names)
    if any("\n" in value or "\r" in value for value in values.values()):
        raise ValueError("Job secrets must be single-line values")
    path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix="harbor-hf-job-secrets-",
            delete=False,
        ) as stream:
            path = Path(stream.name)
            os.fchmod(stream.fileno(), 0o600)
            for name, value in values.items():
                stream.write(f"{name}={value}\n")
        rendered: list[str] = []
        index = 0
        while index < len(command):
            if (
                command[index] == "--secrets"
                and index + 1 < len(command)
                and command[index + 1] in values
            ):
                index += 2
                continue
            rendered.append(command[index])
            index += 1
        option_end = rendered.index("--")
        rendered[option_end:option_end] = ["--secrets-file", str(path)]
        yield rendered
    finally:
        if path is not None:
            path.unlink(missing_ok=True)


def build_submit_command(
    lock: ExecutionLock,
    *,
    input_dir: Path | str,
    bucket: str,
) -> list[str]:
    if lock.judge_required_tasks:
        raise ValueError(
            "judge-required executions must use run-managed per-trial execution"
        )
    job = lock.remote.job
    return [
        "hf",
        "jobs",
        "run",
        "--detach",
        "--namespace",
        job.namespace,
        "--flavor",
        job.flavor,
        "--timeout",
        f"{job.timeout_seconds}s",
        *_secret_arguments(lock),
        "--label",
        f"harbor-hf-execution={lock.execution_id}",
        "--label",
        f"harbor-hf-endpoint={endpoint_lease_label(lock)}",
        "--volume",
        f"{input_dir}:/input:ro",
        *_benchmark_bundle_volume(
            lock.benchmark_source, namespace=lock.remote.job.namespace
        ),
        "--volume",
        f"{bucket_uri(bucket)}:/output:rw",
        "--",
        job.image,
        *locked_source_command(
            lock.remote.worker,
            "harbor-hf",
            "worker",
            "/input/manifest.yaml",
            "/input/execution.lock.json",
            "--output-root",
            "/output",
        ),
    ]


def build_submit_wave_command(
    lock: WaveLock,
    *,
    input_dir: Path | str,
    bucket: str,
) -> list[str]:
    if not isinstance(lock.target, EndpointWaveTarget):
        raise ValueError(
            "provider wave locks must run inside their owning run controller"
        )
    job = lock.remote.job
    labels = [
        "--label",
        f"harbor-hf-wave={lock.wave_id}",
        "--label",
        "harbor-hf-endpoint="
        + endpoint_lease_label_for(
            lock.target.endpoint.namespace, lock.target.endpoint.name
        ),
    ]
    exposed_ports: list[str] = []
    if any(run.configuration.judge_required_tasks for run in lock.executions):
        exposed_ports.extend(["--expose", str(JUDGE_RECORDER_PORT)])
    return [
        "hf",
        "jobs",
        "run",
        "--detach",
        "--namespace",
        job.namespace,
        "--flavor",
        job.flavor,
        "--timeout",
        f"{job.timeout_seconds}s",
        *exposed_ports,
        *_secret_arguments(lock),
        *labels,
        "--volume",
        f"{input_dir}:/input:ro",
        *_wave_benchmark_bundle_volume(lock),
        "--volume",
        f"{bucket_uri(bucket)}:/output:rw",
        "--",
        job.image,
        *locked_source_command(
            lock.remote.worker,
            "harbor-hf",
            "wave-worker",
            "/input/manifest.yaml",
            "/input/run.lock.json",
            "/input/wave.lock.json",
            "--output-root",
            "/output",
        ),
    ]


def build_submit_run_controller_command(
    lock: RunLock,
    spec: ExperimentSpec,
    *,
    input_dir: Path | str,
    bucket: str,
    attempt: int,
) -> list[str]:
    if spec.remote is None or lock.controller_policy is None:
        raise ValueError("run controller submission requires provider settings")
    if attempt < 1 or attempt > lock.controller_policy.max_attempts:
        raise ValueError("run controller attempt is outside its locked limit")
    job = spec.remote.job
    exposed_ports: list[str] = []
    if spec.benchmark.judge is not None:
        exposed_ports.extend(["--expose", str(JUDGE_RECORDER_PORT)])
    return [
        "hf",
        "jobs",
        "run",
        "--detach",
        "--namespace",
        job.namespace,
        "--flavor",
        job.flavor,
        "--timeout",
        f"{job.timeout_seconds}s",
        *exposed_ports,
        *[
            argument
            for name in run_job_secret_names(spec)
            for argument in ("--secrets", name)
        ],
        "--label",
        "harbor-hf-role=run-controller",
        "--label",
        f"harbor-hf-run={lock.run_id}",
        "--label",
        f"harbor-hf-plan={lock.plan_digest.removeprefix('sha256:')[:16]}",
        "--label",
        f"harbor-hf-controller-attempt={attempt}",
        "--volume",
        f"{input_dir}:/input:ro",
        *_benchmark_bundle_volume(lock.source_lock.source, namespace=job.namespace),
        "--volume",
        f"{bucket_uri(bucket)}:/output:rw",
        "--",
        job.image,
        *locked_source_command(
            spec.remote.worker,
            "harbor-hf",
            "run-controller",
            "/input/manifest.yaml",
            "/input/run.lock.json",
            "--attempt",
            str(attempt),
            *(["--prior-job-terminal"] if attempt > 1 else []),
            "--output-root",
            "/output",
        ),
    ]


def require_run_job_secret_sources(spec: ExperimentSpec) -> None:
    remote_job_secret_values(run_job_secret_names(spec))


def run_job_secret_names(spec: ExperimentSpec) -> list[str]:
    if spec.remote is None:
        raise ValueError("run controller requires remote execution")
    names = {spec.remote.job.token_secret_name}
    names.update(
        deployment.token_secret_name
        for deployment in spec.matrix.deployments
        if isinstance(deployment, ProviderTarget)
    )
    if spec.benchmark.judge is not None:
        names.add(spec.benchmark.judge.api_key_secret_name)
    token_name = spec.remote.job.token_secret_name
    return [token_name, *sorted(names - {token_name})]


def _endpoint_binding(lock: ExecutionLock) -> EndpointRef:
    deployment = lock.deployment
    if not isinstance(deployment, DeploymentProfile) or deployment.endpoint is None:
        raise ValueError("execution lock has no endpoint binding")
    return deployment.endpoint


def submit(
    lock: ExecutionLock,
    *,
    input_dir: Path,
    bucket: str,
    runner: TextRunner,
    source_lock: BenchmarkSourceLock,
    bucket_api: BucketApi | None = None,
    bundle: PreparedBenchmarkBundle | None = None,
) -> Submission:
    _validate_execution_source_input(lock, source_lock, input_dir)
    remote_job_secret_values(job_secret_names(lock))
    if bucket_api is None:
        from huggingface_hub import HfApi

        bucket_api = cast(BucketApi, HfApi())
    ensure_private_coordination_repository(lock.remote.job.namespace, api=bucket_api)
    input_bucket = ensure_private_job_input_bucket(
        lock.remote.job.namespace, api=bucket_api
    )
    require_private_bucket(bucket, api=bucket_api)
    bundle_receipt = prepare_benchmark_bundle_input(
        lock.benchmark_source,
        bundle=bundle,
        namespace=lock.remote.job.namespace,
        bucket=input_bucket,
        api=bucket_api,
    )
    input_source = stage_job_input(
        input_dir,
        bucket=input_bucket,
        identity=lock.execution_id,
        api=bucket_api,
    )
    command = build_submit_command(lock, input_dir=input_source, bucket=bucket)
    with _materialized_job_secrets(lock, command) as runtime_command:
        output = runner.run_text(runtime_command)
    match = _JOB_ID.search(output)
    if match is None:
        raise ValueError("HF Jobs submission did not return a job ID")
    return Submission(
        execution_id=lock.execution_id,
        artifact_prefix=lock.artifact_prefix,
        job_id=match.group(),
        source_lock_digest=source_lock_digest(source_lock),
        bundle=bundle_receipt,
        command=command,
    )


def _validate_execution_source_input(
    lock: ExecutionLock,
    source_lock: BenchmarkSourceLock,
    input_dir: Path,
) -> None:
    if load_source_lock(input_dir / "source.lock.json") != source_lock:
        raise ValueError("staged benchmark source lock changed before submission")
    source = source_lock.source
    if isinstance(source, PackageBenchmarkSourceLock):
        expected = pinned_harbor_dataset_reference(
            lock.benchmark_dataset, lock.benchmark_dataset_digest
        )
        if lock.benchmark_source is not None or source.reference != expected:
            raise ValueError("benchmark source lock does not match the execution lock")
    elif lock.benchmark_source != source:
        raise ValueError("benchmark source lock does not match the execution lock")


def submit_run_controller(
    lock: RunLock,
    spec: ExperimentSpec,
    *,
    request: bytes,
    bucket: str,
    runner: TextRunner,
    bucket_api: BucketApi,
    jobs_api: ControllerJobsApi,
    state_store: ControllerStateStore,
    bundle: PreparedBenchmarkBundle | None = None,
    attempt: int = 1,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    identifier: Callable[[], str] = lambda: uuid.uuid4().hex,
) -> RunControllerSubmission:
    if spec.remote is None or lock.controller_policy is None:
        raise ValueError("run controller submission requires provider settings")
    remote_job_secret_values(run_job_secret_names(spec))
    ensure_private_coordination_repository(spec.remote.job.namespace, api=bucket_api)
    input_bucket = ensure_private_job_input_bucket(
        spec.remote.job.namespace, api=bucket_api
    )
    require_private_bucket(bucket, api=bucket_api)
    bundle_receipt = prepare_benchmark_bundle_input(
        lock.source_lock.source,
        bundle=bundle,
        namespace=spec.remote.job.namespace,
        bucket=input_bucket,
        api=bucket_api,
    )
    with tempfile.TemporaryDirectory(prefix="harbor-hf-run-input-") as name:
        staging = Path(name)
        input_manifest = write_run_input(
            staging,
            request=request,
            lock=lock,
        )
        input_uri = stage_job_input(
            staging,
            bucket=input_bucket,
            identity=lock.run_id,
            api=bucket_api,
        )
    existing = state_store.read_attempt(lock.run_id, attempt)
    reservation = ControllerAttemptReservation(
        run_id=lock.run_id,
        plan_digest=lock.plan_digest,
        input_digest=input_manifest.input_digest,
        input_uri=input_uri,
        output_uri=bucket_uri(bucket),
        worker_revision=spec.remote.worker.revision,
        attempt=attempt,
        reserved_at=(
            existing.reserved_at if existing is not None else clock().astimezone(UTC)
        ),
    )
    if existing is not None and existing != reservation:
        raise ValueError("existing controller attempt changed the launch contract")
    state_store.reserve_attempt(reservation)
    command = build_submit_run_controller_command(
        lock,
        spec,
        input_dir=input_uri,
        bucket=bucket,
        attempt=attempt,
    )
    labels = _controller_labels(lock, attempt)
    job_id = _launch_or_adopt_controller(
        jobs_api=jobs_api,
        namespace=spec.remote.job.namespace,
        labels=labels,
        runner=runner,
        command=command,
        secret_names=run_job_secret_names(spec),
        reservation=reservation,
        state_store=state_store,
        clock=clock,
        identifier=identifier,
    )
    return RunControllerSubmission(
        run_id=lock.run_id,
        plan_digest=lock.plan_digest,
        input_digest=input_manifest.input_digest,
        input_uri=input_uri,
        job_id=job_id,
        attempt=attempt,
        launch_receipt=controller_launch_receipt_path(lock.run_id, attempt),
        source_lock=lock.source_lock,
        source_lock_digest=source_lock_digest(lock.source_lock),
        secret_names=run_job_secret_names(spec),
        bundle=bundle_receipt,
        command=command,
    )


def launch_reserved_run_controller(
    lock: RunLock,
    spec: ExperimentSpec,
    reservation: ControllerAttemptReservation,
    *,
    runner: TextRunner,
    jobs_api: ControllerJobsApi,
    state_store: ControllerStateStore,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    identifier: Callable[[], str] = lambda: uuid.uuid4().hex,
) -> RunControllerSubmission:
    if spec.remote is None:
        raise ValueError("run controller requires remote execution")
    remote_job_secret_values(run_job_secret_names(spec))
    if (
        reservation.run_id != lock.run_id
        or reservation.plan_digest != lock.plan_digest
        or reservation.worker_revision != spec.remote.worker.revision
    ):
        raise ValueError("controller attempt reservation changed the launch contract")
    command = build_submit_run_controller_command(
        lock,
        spec,
        input_dir=reservation.input_uri,
        bucket=reservation.output_uri,
        attempt=reservation.attempt,
    )
    job_id = _launch_or_adopt_controller(
        jobs_api=jobs_api,
        namespace=spec.remote.job.namespace,
        labels=_controller_labels(lock, reservation.attempt),
        runner=runner,
        command=command,
        secret_names=run_job_secret_names(spec),
        reservation=reservation,
        state_store=state_store,
        clock=clock,
        identifier=identifier,
    )
    return RunControllerSubmission(
        run_id=lock.run_id,
        plan_digest=lock.plan_digest,
        input_digest=reservation.input_digest,
        input_uri=reservation.input_uri,
        job_id=job_id,
        attempt=reservation.attempt,
        launch_receipt=controller_launch_receipt_path(lock.run_id, reservation.attempt),
        source_lock=lock.source_lock,
        source_lock_digest=source_lock_digest(lock.source_lock),
        secret_names=run_job_secret_names(spec),
        bundle=None,
        command=command,
    )


def _launch_or_adopt_controller(
    *,
    jobs_api: ControllerJobsApi,
    namespace: str,
    labels: Mapping[str, str],
    runner: TextRunner,
    command: list[str],
    secret_names: list[str],
    reservation: ControllerAttemptReservation,
    state_store: ControllerStateStore,
    clock: Callable[[], datetime],
    identifier: Callable[[], str],
) -> str:
    adopted = _existing_controller_launch(
        state_store, reservation, jobs_api, namespace, labels
    )
    if adopted is not None:
        return adopted
    acquired_at = clock().astimezone(UTC)
    claim = ControllerLaunchClaim(
        run_id=reservation.run_id,
        plan_digest=reservation.plan_digest,
        attempt=reservation.attempt,
        launcher_id=identifier(),
        acquired_at=acquired_at,
        expires_at=acquired_at + _CONTROLLER_LAUNCH_LEASE,
    )
    try:
        state_store.acquire_launch(claim)
    except ControllerLaunchUnavailable:
        adopted = _existing_controller_launch(
            state_store, reservation, jobs_api, namespace, labels
        )
        if adopted is not None:
            return adopted
        raise
    adopted = _existing_controller_launch(
        state_store, reservation, jobs_api, namespace, labels
    )
    job_id = (
        adopted
        if adopted is not None
        else _run_controller_launch(
            state_store,
            reservation,
            jobs_api,
            namespace,
            labels,
            runner,
            command,
            secret_names,
        )
    )
    state_store.release_launch(claim)
    return job_id


def _existing_controller_launch(
    state_store: ControllerStateStore,
    reservation: ControllerAttemptReservation,
    jobs_api: ControllerJobsApi,
    namespace: str,
    labels: Mapping[str, str],
) -> str | None:
    recorded = state_store.read_launch(reservation.run_id, reservation.attempt)
    if recorded is not None:
        return _validated_launch_receipt(recorded, reservation)
    existing = _find_controller_jobs(jobs_api, namespace, labels)
    if not existing:
        return None
    return _record_controller_launch(state_store, reservation, existing[0])


def _run_controller_launch(
    state_store: ControllerStateStore,
    reservation: ControllerAttemptReservation,
    jobs_api: ControllerJobsApi,
    namespace: str,
    labels: Mapping[str, str],
    runner: TextRunner,
    command: list[str],
    secret_names: list[str],
) -> str:
    try:
        with _materialized_named_job_secrets(secret_names, command) as runtime_command:
            output = runner.run_text(runtime_command)
    except ProcessError:
        adopted = _find_controller_jobs(jobs_api, namespace, labels)
        if not adopted:
            raise
        return _record_controller_launch(state_store, reservation, adopted[0])
    match = _JOB_ID.search(output)
    if match is not None:
        return _record_controller_launch(state_store, reservation, match.group())
    adopted = _find_controller_jobs(jobs_api, namespace, labels)
    if not adopted:
        raise ValueError("HF Jobs controller submission did not return a job ID")
    return _record_controller_launch(state_store, reservation, adopted[0])


def _record_controller_launch(
    state_store: ControllerStateStore,
    reservation: ControllerAttemptReservation,
    job_id: str,
) -> str:
    receipt = ControllerLaunchReceipt(
        run_id=reservation.run_id,
        plan_digest=reservation.plan_digest,
        input_digest=reservation.input_digest,
        attempt=reservation.attempt,
        job_id=job_id,
    )
    state_store.write_launch(receipt)
    return job_id


def _validated_launch_receipt(
    receipt: ControllerLaunchReceipt,
    reservation: ControllerAttemptReservation,
) -> str:
    expected = (
        reservation.run_id,
        reservation.plan_digest,
        reservation.input_digest,
        reservation.attempt,
    )
    observed = (
        receipt.run_id,
        receipt.plan_digest,
        receipt.input_digest,
        receipt.attempt,
    )
    if observed != expected:
        raise ValueError("controller launch receipt changed the launch contract")
    return receipt.job_id


def _controller_labels(lock: RunLock, attempt: int) -> dict[str, str]:
    return {
        "harbor-hf-role": "run-controller",
        "harbor-hf-run": lock.run_id,
        "harbor-hf-plan": lock.plan_digest.removeprefix("sha256:")[:16],
        "harbor-hf-controller-attempt": str(attempt),
    }


def _find_controller_jobs(
    api: ControllerJobsApi,
    namespace: str,
    labels: Mapping[str, str],
) -> list[str]:
    resources = list(api.list_jobs(labels=dict(labels), namespace=namespace))
    identifiers: list[str] = []
    for resource in resources:
        identifier = getattr(resource, "id", None)
        observed_labels = getattr(resource, "labels", None)
        if not isinstance(identifier, str) or _JOB_ID.fullmatch(identifier) is None:
            raise ValueError("HF Job response has no valid controller ID")
        if not isinstance(observed_labels, Mapping) or any(
            observed_labels.get(key) != value for key, value in labels.items()
        ):
            raise ValueError("HF Job response has the wrong controller labels")
        identifiers.append(identifier)
    if len(identifiers) > 1:
        raise ValueError("multiple HF Jobs have one controller attempt identity")
    return identifiers


def submit_wave(
    lock: WaveLock,
    *,
    input_dir: Path,
    bucket: str,
    runner: TextRunner,
    bucket_api: BucketApi | None = None,
) -> WaveSubmission:
    if bucket_api is None:
        from huggingface_hub import HfApi

        bucket_api = cast(BucketApi, HfApi())
    ensure_private_coordination_repository(lock.remote.job.namespace, api=bucket_api)
    input_bucket = ensure_private_job_input_bucket(
        lock.remote.job.namespace, api=bucket_api
    )
    require_private_bucket(bucket, api=bucket_api)
    input_source = stage_job_input(
        input_dir,
        bucket=input_bucket,
        identity=lock.wave_id,
        api=bucket_api,
    )
    command = build_submit_wave_command(lock, input_dir=input_source, bucket=bucket)
    with _materialized_job_secrets(lock, command) as runtime_command:
        output = runner.run_text(runtime_command)
    match = _JOB_ID.search(output)
    if match is None:
        raise ValueError("HF Jobs wave submission did not return a job ID")
    return WaveSubmission(
        wave_id=lock.wave_id,
        artifact_prefix=lock.artifact_prefix,
        job_id=match.group(),
        command=command,
    )

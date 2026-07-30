from __future__ import annotations

import hashlib
import os
import re
import shlex
import tempfile
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol, cast

from huggingface_hub import CommitOperationAdd
from huggingface_hub.errors import HfHubHTTPError
from pydantic import BaseModel, ConfigDict

from harbor_hf.campaign_input import write_campaign_input
from harbor_hf.campaigns import CampaignLock, EndpointWaveTarget, WaveLock
from harbor_hf.controller_status import (
    ControllerAttemptReservation,
    ControllerStateStore,
)
from harbor_hf.coordination import bucket_id, coordination_repository
from harbor_hf.judge_recorder import JUDGE_RECORDER_PORT
from harbor_hf.models import (
    DeploymentProfile,
    EndpointRef,
    ExperimentSpec,
    SourcePin,
)
from harbor_hf.process import ProcessError
from harbor_hf.provider_proxy import PROVIDER_RECORDER_PORT
from harbor_hf.runs import RunLock

_JOB_ID = re.compile(r"(?<![a-f0-9])[a-f0-9]{24}(?![a-f0-9])")
_GITHUB_REPOSITORY = re.compile(
    r"^(?:https://github\.com/)?"
    r"(?P<owner>[A-Za-z0-9_.-]+)/(?P<name>[A-Za-z0-9_.-]+?)(?:\.git)?/?$"
)
_JOB_INPUT_BUCKET_NAME = "jobs-artifacts"
_COORDINATION_INITIALIZATION_PATH = ".harbor-hf-initialized"
_COORDINATION_INITIALIZATION_PAYLOAD = b"harbor-hf coordination repository\n"


class TextRunner(Protocol):
    def run_text(self, command: list[str]) -> str: ...


class BucketApi(Protocol):
    def create_bucket(self, bucket_id: str, **kwargs: object) -> object: ...

    def bucket_info(self, bucket_id: str) -> object: ...

    def batch_bucket_files(
        self,
        bucket_id: str,
        *,
        add: list[tuple[bytes, str]],
        **kwargs: object,
    ) -> object: ...

    def create_repo(self, repo_id: str, **kwargs: object) -> object: ...

    def repo_info(self, repo_id: str, **kwargs: object) -> object: ...

    def create_commit(
        self, repo_id: str, operations: list[object], **kwargs: object
    ) -> object: ...


class Submission(BaseModel):
    model_config = ConfigDict(frozen=True)

    run_id: str
    artifact_prefix: str
    job_id: str | None
    command: list[str]


class WaveSubmission(BaseModel):
    model_config = ConfigDict(frozen=True)

    wave_id: str
    artifact_prefix: str
    job_id: str | None
    command: list[str]


class CampaignControllerSubmission(BaseModel):
    model_config = ConfigDict(frozen=True)

    campaign_id: str
    plan_digest: str
    input_digest: str
    input_uri: str
    job_id: str | None
    attempt: int
    launch_receipt: str
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
        "repo_dir=$(mktemp -d)\n"
        f'git clone --filter=blob:none --no-checkout {repository} "$repo_dir"\n'
        f'git -C "$repo_dir" fetch --depth 1 origin {revision}\n'
        f'git -C "$repo_dir" checkout --detach {revision}\n'
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
    additions: list[tuple[bytes, str]] = []
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


def endpoint_lease_label(lock: RunLock) -> str:
    endpoint = _endpoint_binding(lock)
    return endpoint_lease_label_for(endpoint.namespace, endpoint.name)


def endpoint_lease_label_for(namespace: str, name: str) -> str:
    identity = f"{namespace}/{name}".encode()
    return hashlib.sha256(identity).hexdigest()[:32]


def job_secret_names(lock: RunLock | WaveLock) -> list[str]:
    names = {lock.remote.job.token_secret_name}
    run_locks = (
        [lock]
        if isinstance(lock, RunLock)
        else [run.configuration for run in lock.runs]
    )
    for run_lock in run_locks:
        source = run_lock.benchmark_source
        if source is not None and source.credentials is not None:
            names.add(source.credentials.secret_name)
        judge = run_lock.benchmark_judge
        if judge is not None:
            names.add(judge.api_key_secret_name)
    token_name = lock.remote.job.token_secret_name
    return [token_name, *sorted(names - {token_name})]


def _secret_arguments(lock: RunLock | WaveLock) -> list[str]:
    return [
        argument for name in job_secret_names(lock) for argument in ("--secrets", name)
    ]


def _source_secret_names(lock: RunLock | WaveLock) -> list[str]:
    run_locks = (
        [lock]
        if isinstance(lock, RunLock)
        else [run.configuration for run in lock.runs]
    )
    names = {
        source.credentials.secret_name
        for run_lock in run_locks
        if (source := run_lock.benchmark_source) is not None
        and source.credentials is not None
    }
    return sorted(names)


def require_source_secrets(lock: RunLock | WaveLock) -> None:
    for name in _source_secret_names(lock):
        if not os.environ.get(name, ""):
            raise ValueError(f"required secret {name} is not available")


@contextmanager
def _materialized_job_secrets(
    lock: RunLock | WaveLock, command: list[str]
) -> Iterator[list[str]]:
    with _materialized_named_job_secrets(job_secret_names(lock), command) as rendered:
        yield rendered


@contextmanager
def _materialized_named_job_secrets(
    names: list[str], command: list[str]
) -> Iterator[list[str]]:
    values = {name: value for name in names if (value := os.environ.get(name))}
    if not values:
        yield command
        return
    if any("\n" in value or "\r" in value for value in values.values()):
        raise ValueError("source secrets must be single-line values")
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
    lock: RunLock,
    *,
    input_dir: Path | str,
    bucket: str,
) -> list[str]:
    if lock.judge_required_tasks:
        raise ValueError(
            "judge-required runs must use campaign execution for per-trial evidence"
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
        f"harbor-hf-run={lock.run_id}",
        "--label",
        f"harbor-hf-endpoint={endpoint_lease_label(lock)}",
        "--volume",
        f"{input_dir}:/input:ro",
        "--volume",
        f"{bucket_uri(bucket)}:/output:rw",
        "--",
        job.image,
        *locked_source_command(
            lock.remote.worker,
            "harbor-hf",
            "worker",
            "/input/manifest.yaml",
            "/input/run.lock.json",
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
    job = lock.remote.job
    labels = ["--label", f"harbor-hf-wave={lock.wave_id}"]
    exposed_ports: list[str] = []
    if isinstance(lock.target, EndpointWaveTarget):
        labels.extend(
            (
                "--label",
                "harbor-hf-endpoint="
                + endpoint_lease_label_for(
                    lock.target.endpoint.namespace, lock.target.endpoint.name
                ),
            )
        )
    else:
        exposed_ports.extend(["--expose", str(PROVIDER_RECORDER_PORT)])
        labels.extend(
            (
                "--label",
                "harbor-hf-provider="
                + hashlib.sha256(lock.target.provider.service.encode()).hexdigest()[
                    :32
                ],
            )
        )
    if any(run.configuration.judge_required_tasks for run in lock.runs):
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
        "--volume",
        f"{bucket_uri(bucket)}:/output:rw",
        "--",
        job.image,
        *locked_source_command(
            lock.remote.worker,
            "harbor-hf",
            "wave-worker",
            "/input/manifest.yaml",
            "/input/campaign.lock.json",
            "/input/wave.lock.json",
            "--output-root",
            "/output",
        ),
    ]


def build_submit_campaign_controller_command(
    lock: CampaignLock,
    spec: ExperimentSpec,
    *,
    input_dir: Path | str,
    bucket: str,
    attempt: int,
) -> list[str]:
    if spec.remote is None or lock.controller_policy is None:
        raise ValueError("campaign controller submission requires provider settings")
    if attempt < 1 or attempt > lock.controller_policy.max_attempts:
        raise ValueError("campaign controller attempt is outside its locked limit")
    job = spec.remote.job
    exposed_ports = ["--expose", str(PROVIDER_RECORDER_PORT)]
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
            for name in campaign_job_secret_names(spec)
            for argument in ("--secrets", name)
        ],
        "--label",
        "harbor-hf-role=campaign-controller",
        "--label",
        f"harbor-hf-campaign={lock.campaign_id}",
        "--label",
        f"harbor-hf-plan={lock.plan_digest.removeprefix('sha256:')[:16]}",
        "--label",
        f"harbor-hf-controller-attempt={attempt}",
        "--volume",
        f"{input_dir}:/input:ro",
        "--volume",
        f"{bucket_uri(bucket)}:/output:rw",
        "--",
        job.image,
        *locked_source_command(
            spec.remote.worker,
            "harbor-hf",
            "campaign-controller",
            "/input/manifest.yaml",
            "/input/campaign.lock.json",
            "--attempt",
            str(attempt),
            *(["--prior-job-terminal"] if attempt > 1 else []),
            "--output-root",
            "/output",
        ),
    ]


def campaign_job_secret_names(spec: ExperimentSpec) -> list[str]:
    if spec.remote is None:
        raise ValueError("campaign controller requires remote execution")
    names = {spec.remote.job.token_secret_name}
    if (
        spec.benchmark.source is not None
        and spec.benchmark.source.credentials is not None
    ):
        names.add(spec.benchmark.source.credentials.secret_name)
    if spec.benchmark.judge is not None:
        names.add(spec.benchmark.judge.api_key_secret_name)
    token_name = spec.remote.job.token_secret_name
    return [token_name, *sorted(names - {token_name})]


def _endpoint_binding(lock: RunLock) -> EndpointRef:
    deployment = lock.deployment
    if not isinstance(deployment, DeploymentProfile) or deployment.endpoint is None:
        raise ValueError("run lock has no endpoint binding")
    return deployment.endpoint


def submit(
    lock: RunLock,
    *,
    input_dir: Path,
    bucket: str,
    runner: TextRunner,
    bucket_api: BucketApi | None = None,
) -> Submission:
    require_source_secrets(lock)
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
        identity=lock.run_id,
        api=bucket_api,
    )
    command = build_submit_command(lock, input_dir=input_source, bucket=bucket)
    with _materialized_job_secrets(lock, command) as runtime_command:
        output = runner.run_text(runtime_command)
    match = _JOB_ID.search(output)
    if match is None:
        raise ValueError("HF Jobs submission did not return a job ID")
    return Submission(
        run_id=lock.run_id,
        artifact_prefix=lock.artifact_prefix,
        job_id=match.group(),
        command=command,
    )


def submit_campaign_controller(
    lock: CampaignLock,
    spec: ExperimentSpec,
    *,
    request: bytes,
    bucket: str,
    runner: TextRunner,
    bucket_api: BucketApi,
    jobs_api: ControllerJobsApi,
    state_store: ControllerStateStore,
    attempt: int = 1,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> CampaignControllerSubmission:
    if spec.remote is None or lock.controller_policy is None:
        raise ValueError("campaign controller submission requires provider settings")
    for name in campaign_job_secret_names(spec):
        if name != spec.remote.job.token_secret_name and not os.environ.get(name, ""):
            raise ValueError(f"required secret {name} is not available")
    ensure_private_coordination_repository(spec.remote.job.namespace, api=bucket_api)
    input_bucket = ensure_private_job_input_bucket(
        spec.remote.job.namespace, api=bucket_api
    )
    require_private_bucket(bucket, api=bucket_api)
    with tempfile.TemporaryDirectory(prefix="harbor-hf-campaign-input-") as name:
        staging = Path(name)
        input_manifest = write_campaign_input(
            staging,
            request=request,
            lock=lock,
        )
        input_uri = stage_job_input(
            staging,
            bucket=input_bucket,
            identity=lock.campaign_id,
            api=bucket_api,
        )
    reservation = ControllerAttemptReservation(
        campaign_id=lock.campaign_id,
        plan_digest=lock.plan_digest,
        input_digest=input_manifest.input_digest,
        input_uri=input_uri,
        output_uri=bucket_uri(bucket),
        worker_revision=spec.remote.worker.revision,
        attempt=attempt,
        reserved_at=clock().astimezone(UTC),
    )
    state_store.reserve_attempt(reservation)
    command = build_submit_campaign_controller_command(
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
        secret_names=campaign_job_secret_names(spec),
    )
    return CampaignControllerSubmission(
        campaign_id=lock.campaign_id,
        plan_digest=lock.plan_digest,
        input_digest=input_manifest.input_digest,
        input_uri=input_uri,
        job_id=job_id,
        attempt=attempt,
        launch_receipt=(
            f"campaigns/{lock.campaign_id}/controller-attempts/{attempt}.json"
        ),
        command=command,
    )


def launch_reserved_campaign_controller(
    lock: CampaignLock,
    spec: ExperimentSpec,
    reservation: ControllerAttemptReservation,
    *,
    runner: TextRunner,
    jobs_api: ControllerJobsApi,
) -> CampaignControllerSubmission:
    if spec.remote is None:
        raise ValueError("campaign controller requires remote execution")
    if (
        reservation.campaign_id != lock.campaign_id
        or reservation.plan_digest != lock.plan_digest
        or reservation.worker_revision != spec.remote.worker.revision
    ):
        raise ValueError("controller attempt reservation changed the launch contract")
    command = build_submit_campaign_controller_command(
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
        secret_names=campaign_job_secret_names(spec),
    )
    return CampaignControllerSubmission(
        campaign_id=lock.campaign_id,
        plan_digest=lock.plan_digest,
        input_digest=reservation.input_digest,
        input_uri=reservation.input_uri,
        job_id=job_id,
        attempt=reservation.attempt,
        launch_receipt=(
            f"campaigns/{lock.campaign_id}/controller-attempts/"
            f"{reservation.attempt}.json"
        ),
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
) -> str:
    existing = _find_controller_jobs(jobs_api, namespace, labels)
    if existing:
        return existing[0]
    try:
        with _materialized_named_job_secrets(secret_names, command) as runtime_command:
            output = runner.run_text(runtime_command)
    except ProcessError:
        adopted = _find_controller_jobs(jobs_api, namespace, labels)
        if not adopted:
            raise
        return adopted[0]
    match = _JOB_ID.search(output)
    if match is not None:
        return match.group()
    adopted = _find_controller_jobs(jobs_api, namespace, labels)
    if adopted:
        return adopted[0]
    raise ValueError("HF Jobs controller submission did not return a job ID")


def _controller_labels(lock: CampaignLock, attempt: int) -> dict[str, str]:
    return {
        "harbor-hf-role": "campaign-controller",
        "harbor-hf-campaign": lock.campaign_id,
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
    require_source_secrets(lock)
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

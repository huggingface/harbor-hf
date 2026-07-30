from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import cast

from conftest import with_provider_controller
from test_submission import FakeBucketApi, FakeRunner

from harbor_hf.campaigns import CampaignLock, build_campaign_lock, build_campaign_plan
from harbor_hf.controller_status import (
    ControllerAttemptReservation,
    ControllerStateStore,
)
from harbor_hf.models import ExperimentSpec
from harbor_hf.provider_models import ProviderTarget
from harbor_hf.submission import (
    build_submit_campaign_controller_command,
    submit_campaign_controller,
)

NOW = datetime(2026, 7, 30, tzinfo=UTC)


def _campaign(remote_spec: ExperimentSpec) -> tuple[ExperimentSpec, CampaignLock]:
    model = remote_spec.matrix.models[0]
    provider = ProviderTarget(id="provider-one", model=model.repo)
    agent = remote_spec.matrix.agents[0].model_copy(
        update={
            "import_path": "harbor_hf_agents.openclaw.agent:OpenClawAgent",
            "parameters": {"openclaw_config": {}},
        }
    )
    spec = remote_spec.model_copy(
        update={
            "matrix": remote_spec.matrix.model_copy(
                update={"deployments": [provider], "agents": [agent]}
            )
        }
    )
    spec = with_provider_controller(spec)
    lock = build_campaign_lock(build_campaign_plan(spec), "campaign-one")
    return spec, lock


class StateStore:
    def __init__(self) -> None:
        self.reservations: list[ControllerAttemptReservation] = []

    def reserve_attempt(self, reservation: ControllerAttemptReservation) -> None:
        self.reservations.append(reservation)


class Jobs:
    def __init__(self, values: list[object] | None = None) -> None:
        self.values = values or []
        self.requests: list[dict[str, object]] = []

    def list_jobs(self, **kwargs: object) -> list[object]:
        self.requests.append(kwargs)
        return self.values


def test_controller_command_runs_the_campaign_without_child_wave_jobs(
    remote_spec: ExperimentSpec,
) -> None:
    spec, lock = _campaign(remote_spec)

    command = build_submit_campaign_controller_command(
        lock,
        spec,
        input_dir="hf://buckets/org/input/digest",
        bucket="org/output",
        attempt=1,
    )
    rendered = " ".join(command)

    assert "harbor-hf-role=campaign-controller" in rendered
    assert "harbor-hf-campaign=campaign-one" in rendered
    assert (
        "campaign-controller /input/manifest.yaml /input/campaign.lock.json" in rendered
    )
    assert "wave-worker" not in rendered
    assert "--expose 8000" in rendered
    assert "--prior-job-terminal" not in command


def test_controller_submission_stages_exact_input_and_reserves_before_launch(
    remote_spec: ExperimentSpec,
    remote_manifest: Path,
) -> None:
    spec, lock = _campaign(remote_spec)
    api = FakeBucketApi()
    jobs = Jobs()
    state = StateStore()
    runner = FakeRunner("Job started: 0123456789abcdef01234567\n")

    result = submit_campaign_controller(
        lock,
        spec,
        request=remote_manifest.read_bytes(),
        bucket=spec.artifacts.bucket,
        runner=runner,
        bucket_api=api,
        jobs_api=jobs,
        state_store=cast(ControllerStateStore, state),
        clock=lambda: NOW,
    )

    assert result.job_id == "0123456789abcdef01234567"
    assert result.input_digest == state.reservations[0].input_digest
    assert result.input_uri == state.reservations[0].input_uri
    staged_paths = [path for _content, path in api.bucket_batches[-1][1]]
    assert {path.rsplit("/", maxsplit=1)[-1] for path in staged_paths} == {
        "campaign.lock.json",
        "input-manifest.json",
        "manifest.yaml",
    }
    assert spec.remote is not None
    assert jobs.requests[0]["namespace"] == spec.remote.job.namespace


def test_repeated_submission_adopts_the_exact_controller_attempt(
    remote_spec: ExperimentSpec,
    remote_manifest: Path,
) -> None:
    spec, lock = _campaign(remote_spec)
    labels = {
        "harbor-hf-role": "campaign-controller",
        "harbor-hf-campaign": lock.campaign_id,
        "harbor-hf-plan": lock.plan_digest.removeprefix("sha256:")[:16],
        "harbor-hf-controller-attempt": "1",
    }
    jobs = Jobs(
        [
            SimpleNamespace(
                id="0123456789abcdef01234567",
                labels=labels,
            )
        ]
    )
    state = StateStore()

    class RejectRunner:
        def run_text(self, command: list[str]) -> str:
            del command
            raise AssertionError("adopted controller must not be launched again")

    result = submit_campaign_controller(
        lock,
        spec,
        request=remote_manifest.read_bytes(),
        bucket=spec.artifacts.bucket,
        runner=RejectRunner(),
        bucket_api=FakeBucketApi(),
        jobs_api=jobs,
        state_store=cast(ControllerStateStore, state),
        clock=lambda: NOW,
    )

    assert result.job_id == "0123456789abcdef01234567"
    assert len(state.reservations) == 1

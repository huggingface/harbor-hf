from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from conftest import with_provider_controller
from test_submission import FakeBucketApi, FakeRunner

from harbor_hf.campaigns import CampaignLock, build_campaign_lock, build_campaign_plan
from harbor_hf.controller_status import (
    ControllerAttemptReservation,
    ControllerLaunchClaim,
    ControllerLaunchReceipt,
    ControllerLaunchUnavailable,
    ControllerStateStore,
)
from harbor_hf.models import ExperimentSpec
from harbor_hf.process import ProcessError
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
        self.launch_claim: ControllerLaunchClaim | None = None
        self.launches: dict[int, ControllerLaunchReceipt] = {}

    def read_attempt(
        self, campaign_id: str, attempt: int
    ) -> ControllerAttemptReservation | None:
        return next(
            (
                reservation
                for reservation in self.reservations
                if reservation.campaign_id == campaign_id
                and reservation.attempt == attempt
            ),
            None,
        )

    def reserve_attempt(self, reservation: ControllerAttemptReservation) -> None:
        observed = self.read_attempt(reservation.campaign_id, reservation.attempt)
        if observed is None:
            self.reservations.append(reservation)
        else:
            assert observed == reservation

    def acquire_launch(self, claim: ControllerLaunchClaim) -> None:
        if (
            self.launch_claim is not None
            and self.launch_claim != claim
            and self.launch_claim.expires_at > claim.acquired_at
        ):
            raise ControllerLaunchUnavailable("launch is in progress")
        self.launch_claim = claim

    def release_launch(self, claim: ControllerLaunchClaim) -> None:
        assert self.launch_claim == claim
        self.launch_claim = None

    def read_launch_claim(
        self, campaign_id: str, attempt: int
    ) -> ControllerLaunchClaim | None:
        if self.launch_claim is None:
            return None
        assert self.launch_claim.campaign_id == campaign_id
        assert self.launch_claim.attempt == attempt
        return self.launch_claim

    def write_launch(self, receipt: ControllerLaunchReceipt) -> None:
        observed = self.launches.get(receipt.attempt)
        if observed is not None:
            assert observed == receipt
        self.launches[receipt.attempt] = receipt

    def read_launch(
        self, campaign_id: str, attempt: int
    ) -> ControllerLaunchReceipt | None:
        del campaign_id
        return self.launches.get(attempt)


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


def test_repeated_submission_reuses_the_initial_attempt_after_launch_failure(
    remote_spec: ExperimentSpec,
    remote_manifest: Path,
) -> None:
    spec, lock = _campaign(remote_spec)
    state = StateStore()
    api = FakeBucketApi()

    class FailingRunner:
        def run_text(self, command: list[str]) -> str:
            del command
            raise ProcessError("launch failed")

    with pytest.raises(ProcessError, match="launch failed"):
        submit_campaign_controller(
            lock,
            spec,
            request=remote_manifest.read_bytes(),
            bucket=spec.artifacts.bucket,
            runner=FailingRunner(),
            bucket_api=api,
            jobs_api=Jobs(),
            state_store=cast(ControllerStateStore, state),
            clock=lambda: NOW,
        )

    result = submit_campaign_controller(
        lock,
        spec,
        request=remote_manifest.read_bytes(),
        bucket=spec.artifacts.bucket,
        runner=FakeRunner("Job started: 0123456789abcdef01234567\n"),
        bucket_api=api,
        jobs_api=Jobs(),
        state_store=cast(ControllerStateStore, state),
        clock=lambda: NOW + timedelta(minutes=31),
    )

    assert result.job_id == "0123456789abcdef01234567"
    assert len(state.reservations) == 1
    assert state.reservations[0].reserved_at == NOW
    assert state.launch_claim is None
    assert state.launches[1].job_id == "0123456789abcdef01234567"


def test_concurrent_submission_does_not_launch_while_attempt_is_owned(
    remote_spec: ExperimentSpec,
    remote_manifest: Path,
) -> None:
    spec, lock = _campaign(remote_spec)
    state = StateStore()
    state.launch_claim = ControllerLaunchClaim(
        campaign_id=lock.campaign_id,
        plan_digest=lock.plan_digest,
        attempt=1,
        launcher_id="other-launcher",
        acquired_at=NOW,
        expires_at=NOW + timedelta(minutes=30),
    )

    class RejectRunner:
        def run_text(self, command: list[str]) -> str:
            del command
            raise AssertionError("a competing launch must not run")

    with pytest.raises(ControllerLaunchUnavailable, match="in progress"):
        submit_campaign_controller(
            lock,
            spec,
            request=remote_manifest.read_bytes(),
            bucket=spec.artifacts.bucket,
            runner=RejectRunner(),
            bucket_api=FakeBucketApi(),
            jobs_api=Jobs(),
            state_store=cast(ControllerStateStore, state),
            clock=lambda: NOW + timedelta(minutes=1),
        )


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

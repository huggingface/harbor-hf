from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from huggingface_hub import CommitOperationAdd, CommitOperationDelete

from harbor_hf.controller_status import (
    ControllerAttemptReservation,
    ControllerClaim,
    ControllerEndedReceipt,
    ControllerLaunchClaim,
    ControllerLaunchReceipt,
    ControllerLaunchUnavailable,
    ControllerOwnershipConflict,
    ControllerProjectionCounts,
    ControllerRecoveryDecision,
    ControllerStartedReceipt,
    ControllerStatus,
    ControllerStatusError,
    HubControllerStateStore,
    ProviderCapacityClaim,
    ProviderCapacityUnavailable,
    provider_capacity_claim_path,
)

NOW = datetime(2026, 7, 30, tzinfo=UTC)


class FakeControllerApi:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.revision = 1
        self.files: dict[str, bytes] = {}
        self.commits: list[tuple[str, list[str]]] = []

    def repo_info(self, repo_id: str, **kwargs: object) -> object:
        assert repo_id == "org/harbor-hf-coordination"
        return SimpleNamespace(sha=str(self.revision))

    def get_paths_info(
        self, repo_id: str, paths: str | list[str], **kwargs: object
    ) -> list[object]:
        del repo_id, kwargs
        values = [paths] if isinstance(paths, str) else paths
        return [SimpleNamespace(path=path) for path in values if path in self.files]

    def hf_hub_download(self, repo_id: str, filename: str, **kwargs: object) -> str:
        del repo_id, kwargs
        path = self.root / str(self.revision) / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.files[filename])
        return str(path)

    def create_commit(
        self, repo_id: str, operations: list[object], **kwargs: object
    ) -> object:
        del repo_id
        assert kwargs["parent_commit"] == str(self.revision)
        changed: list[str] = []
        for operation in operations:
            if isinstance(operation, CommitOperationAdd):
                source = operation.path_or_fileobj
                if isinstance(source, bytes):
                    content = source
                elif isinstance(source, (str, Path)):
                    content = Path(source).read_bytes()
                else:
                    content = source.read()
                self.files[operation.path_in_repo] = content
                changed.append(operation.path_in_repo)
            elif isinstance(operation, CommitOperationDelete):
                self.files.pop(operation.path_in_repo, None)
                changed.append(operation.path_in_repo)
            else:
                raise AssertionError("unexpected operation")
        self.revision += 1
        self.commits.append((str(kwargs["commit_message"]), changed))
        return SimpleNamespace(oid=str(self.revision))


def _claim(job_id: str = "job-one", attempt: int = 1) -> ControllerClaim:
    return ControllerClaim(
        campaign_id="campaign-one",
        job_id=job_id,
        plan_digest="sha256:" + "1" * 64,
        attempt=attempt,
        acquired_at=NOW,
        heartbeat_at=NOW,
        expires_at=NOW + timedelta(minutes=10),
    )


def _status(claim: ControllerClaim, heartbeat: datetime = NOW) -> ControllerStatus:
    return ControllerStatus(
        campaign_id=claim.campaign_id,
        plan_digest=claim.plan_digest,
        job_id=claim.job_id,
        attempt=claim.attempt,
        state="running",
        heartbeat_at=heartbeat,
        lease_expires_at=heartbeat + timedelta(minutes=10),
        physical_deadline=NOW + timedelta(hours=1),
        remaining_seconds=3_600,
        projection=ControllerProjectionCounts(
            logical_trials=690,
            terminal_trials=2,
            active_trials=1,
            physical_executions=3,
        ),
    )


def test_controller_claim_is_exclusive_renewable_and_reversible(tmp_path: Path) -> None:
    api = FakeControllerApi(tmp_path)
    store = HubControllerStateStore("org", "token", api=api)
    first = _claim()

    store.acquire(first, prior_job_terminal=False)
    assert store.read_claim(first.campaign_id) == first
    with pytest.raises(ControllerOwnershipConflict):
        store.acquire(_claim("job-two"), prior_job_terminal=False)

    renewed = first.model_copy(
        update={
            "heartbeat_at": NOW + timedelta(minutes=1),
            "expires_at": NOW + timedelta(minutes=11),
        }
    )
    store.heartbeat(first, renewed)
    assert store.read_claim(first.campaign_id) == renewed
    store.release(renewed)
    assert store.read_claim(first.campaign_id) is None


def test_expired_claim_still_requires_terminal_job_proof(tmp_path: Path) -> None:
    store = HubControllerStateStore("org", "token", api=FakeControllerApi(tmp_path))
    first = _claim().model_copy(update={"expires_at": NOW + timedelta(seconds=1)})
    store.acquire(first, prior_job_terminal=False)
    replacement = ControllerClaim(
        campaign_id=first.campaign_id,
        job_id="job-two",
        plan_digest=first.plan_digest,
        attempt=2,
        acquired_at=NOW + timedelta(minutes=1),
        heartbeat_at=NOW + timedelta(minutes=1),
        expires_at=NOW + timedelta(minutes=11),
    )

    with pytest.raises(ControllerOwnershipConflict):
        store.acquire(replacement, prior_job_terminal=False)
    store.acquire(replacement, prior_job_terminal=True)
    assert store.read_claim(first.campaign_id) == replacement


def test_controller_launch_is_serialized_and_has_an_immutable_receipt(
    tmp_path: Path,
) -> None:
    store = HubControllerStateStore("org", "token", api=FakeControllerApi(tmp_path))
    first = ControllerLaunchClaim(
        campaign_id="campaign-one",
        plan_digest="sha256:" + "1" * 64,
        attempt=1,
        launcher_id="launcher-one",
        acquired_at=NOW,
        expires_at=NOW + timedelta(minutes=30),
    )
    competing = first.model_copy(
        update={
            "launcher_id": "launcher-two",
            "acquired_at": NOW + timedelta(minutes=1),
            "expires_at": NOW + timedelta(minutes=31),
        }
    )

    store.acquire_launch(first)
    with pytest.raises(ControllerLaunchUnavailable, match="in progress"):
        store.acquire_launch(competing)
    assert store.read_launch_claim(first.campaign_id, first.attempt) == first

    takeover = competing.model_copy(
        update={
            "acquired_at": NOW + timedelta(minutes=31),
            "expires_at": NOW + timedelta(minutes=61),
        }
    )
    store.acquire_launch(takeover)
    receipt = ControllerLaunchReceipt(
        campaign_id=first.campaign_id,
        plan_digest=first.plan_digest,
        input_digest="sha256:" + "2" * 64,
        attempt=1,
        job_id="a" * 24,
    )
    store.write_launch(receipt)
    store.write_launch(receipt)
    assert store.read_launch(first.campaign_id, 1) == receipt
    with pytest.raises(ControllerStatusError, match="immutable"):
        store.write_launch(receipt.model_copy(update={"job_id": "b" * 24}))
    store.release_launch(takeover)
    assert store.read_launch_claim(first.campaign_id, 1) is None


def test_provider_capacity_is_exclusive_and_released_exactly(tmp_path: Path) -> None:
    store = HubControllerStateStore("org", "token", api=FakeControllerApi(tmp_path))
    first = ProviderCapacityClaim(
        provider="hf-inference-providers",
        campaign_id="campaign-one",
        plan_digest="sha256:" + "1" * 64,
        job_id="job-one",
        attempt=1,
        action_id="act-one",
        acquired_at=NOW,
    )
    competing = first.model_copy(
        update={"campaign_id": "campaign-two", "job_id": "job-two"}
    )

    store.acquire_provider_capacity(first)
    store.acquire_provider_capacity(first)
    assert store.read_provider_capacity(first.provider) == first
    with pytest.raises(ProviderCapacityUnavailable, match="occupied"):
        store.acquire_provider_capacity(competing)
    with pytest.raises(ControllerStatusError, match="ownership"):
        store.release_provider_capacity(competing)

    store.release_provider_capacity(first)
    assert store.read_provider_capacity(first.provider) is None
    assert provider_capacity_claim_path(first.provider).startswith(
        "claims/provider-capacity/"
    )


def test_replacement_recovers_only_its_terminal_predecessor_provider_claim(
    tmp_path: Path,
) -> None:
    store = HubControllerStateStore("org", "token", api=FakeControllerApi(tmp_path))
    capacity = ProviderCapacityClaim(
        provider="hf-inference-providers",
        campaign_id="campaign-one",
        plan_digest="sha256:" + "1" * 64,
        job_id="job-one",
        attempt=1,
        action_id="act-one",
        acquired_at=NOW,
    )
    replacement = _claim("job-two", attempt=2).model_copy(
        update={
            "acquired_at": NOW + timedelta(minutes=1),
            "heartbeat_at": NOW + timedelta(minutes=1),
            "expires_at": NOW + timedelta(minutes=11),
        }
    )
    store.acquire_provider_capacity(capacity)

    with pytest.raises(ControllerStatusError, match="cannot be recovered safely"):
        store.recover_provider_capacity(
            capacity.provider, replacement, prior_job_terminal=False
        )
    store.recover_provider_capacity(
        capacity.provider, replacement, prior_job_terminal=True
    )
    assert store.read_provider_capacity(capacity.provider) is None


def test_controller_status_and_receipts_reject_backward_or_conflicting_writes(
    tmp_path: Path,
) -> None:
    api = FakeControllerApi(tmp_path)
    store = HubControllerStateStore("org", "token", api=api)
    claim = _claim()
    status = _status(claim)

    store.write_status(status)
    store.write_status(status)
    assert store.read_status(claim.campaign_id) == status
    with pytest.raises(ControllerStatusError, match="moved backwards"):
        store.write_status(_status(claim, NOW - timedelta(seconds=1)))

    started = ControllerStartedReceipt(
        campaign_id=claim.campaign_id,
        plan_digest=claim.plan_digest,
        input_digest="sha256:" + "2" * 64,
        worker_revision="3" * 40,
        job_id=claim.job_id,
        attempt=1,
        started_at=NOW,
    )
    ended = ControllerEndedReceipt(
        campaign_id=claim.campaign_id,
        plan_digest=claim.plan_digest,
        job_id=claim.job_id,
        attempt=1,
        state="completed",
        ended_at=NOW + timedelta(minutes=2),
    )
    store.write_started(started)
    store.write_ended(ended)
    store.write_started(started)

    conflict = started.model_copy(update={"input_digest": "sha256:" + "4" * 64})
    with pytest.raises(ControllerStatusError, match="immutable"):
        store.write_started(conflict)


def test_controller_attempt_reservations_are_sequential_and_immutable(
    tmp_path: Path,
) -> None:
    store = HubControllerStateStore("org", "token", api=FakeControllerApi(tmp_path))
    first = ControllerAttemptReservation(
        campaign_id="campaign-one",
        plan_digest="sha256:" + "1" * 64,
        input_digest="sha256:" + "2" * 64,
        input_uri="hf://buckets/org/input/path",
        output_uri="hf://buckets/org/output",
        worker_revision="3" * 40,
        attempt=1,
        reserved_at=NOW,
    )
    store.reserve_attempt(first)
    assert store.read_attempt(first.campaign_id, 1) == first

    third = first.model_copy(update={"attempt": 3})
    with pytest.raises(ControllerStatusError, match="predecessor"):
        store.reserve_attempt(third)

    second = first.model_copy(
        update={"attempt": 2, "reserved_at": NOW + timedelta(minutes=1)}
    )
    store.reserve_attempt(second)
    assert store.read_attempt(first.campaign_id, 2) == second

    recovery = ControllerRecoveryDecision(
        campaign_id=first.campaign_id,
        plan_digest=first.plan_digest,
        prior_job_id="job-one",
        prior_attempt=1,
        replacement_attempt=2,
        checkpoint_revision="commit-one",
        category="lost",
        decided_at=second.reserved_at,
    )
    store.write_recovery(recovery)
    assert store.read_recovery(first.campaign_id, 2) == recovery

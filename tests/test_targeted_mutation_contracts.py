from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import httpx
import pytest
from test_endpoints import FakePort, FakeTime, _desired, _snapshot
from test_hf_endpoints import _http_error
from test_run_terminal_evidence_mutation_contracts import (
    _attempt_lock_for_wave,
    _run,
    _wave,
)

from harbor_hf.endpoints import (
    AmbiguousEndpointCreate,
    AmbiguousEndpointDelete,
    AmbiguousEndpointPause,
    EndpointConfigurationMismatch,
    EndpointIdentityMismatch,
    EndpointProviderError,
    EndpointProvisioner,
    EndpointProvisioningError,
    EndpointSnapshot,
    effective_configuration_mismatches,
    verify_exact_endpoint,
)
from harbor_hf.hf_endpoints import (
    _access_type,
    _mapping,
    _provider_call,
    _scaling_measure,
    _string_list,
    _string_mapping,
)
from harbor_hf.models import ExperimentSpec
from harbor_hf.result_publisher import (
    HubDatasetPublisher,
    IndexReceipt,
    ResultReceipt,
    publisher_lease_path,
)
from harbor_hf.results import (
    GlobalIndexRow,
    build_index_window_file,
    read_index_file,
)
from harbor_hf.run_observer import (
    _attempt_control_events,
    _legacy_failure_category,
    _wave_events,
)
from harbor_hf.runs import estimated_partial_wave_cost
from harbor_hf.wave_worker import AttemptLock


@pytest.mark.parametrize(
    ("error_type", "message", "expected"),
    [
        ("AuthenticationError", None, "authentication"),
        (None, "401 unauthorized", "authentication"),
        (None, "request forbidden", "authentication"),
        ("RateLimitError", None, "rate-limit"),
        (None, "rate_limit exceeded", "rate-limit"),
        (None, "provider status=429", "rate-limit"),
        ("QuotaError", "allocation consumed", "quota"),
        ("TimeoutError", None, "transient"),
        (None, "connection reset", "transient"),
        (None, "provider status=503", "transient"),
        ("ConfigurationError", None, "configuration"),
        ("BadRequestError", None, "configuration"),
        (None, "endpoint NotFound", "configuration"),
        (None, None, "benchmark"),
        (17, {"unexpected": True}, "benchmark"),
    ],
)
def test_legacy_failure_categories_preserve_historical_classification(
    error_type: object, message: object, expected: str
) -> None:
    assert _legacy_failure_category(error_type, message) == expected


def test_observer_wave_and_execution_event_projection_is_exact(
    remote_spec: ExperimentSpec,
) -> None:
    run = _run(remote_spec)
    wave = _wave(run, remote_spec).model_copy(
        update={"estimated_cost_microusd": 765_432}
    )
    records: list[dict[str, object]] = [
        {"event": "wave_started", "at": "2026-07-14T09:10:00+08:00"},
        {"event": "wave_succeeded", "at": "2026-07-14T01:15:00+00:00"},
        {"event": "endpoint_pause_requested", "at": "2026-07-14T01:16:00+00:00"},
    ]

    wave_events = _wave_events(run, wave, "_SUCCESS", records)

    assert [event.kind for event in wave_events] == [
        "wave.active",
        "wave.cleaning",
        "wave.closed",
    ]
    assert [event.observed_at for event in wave_events] == [
        datetime(2026, 7, 14, 1, 10, tzinfo=UTC),
        datetime(2026, 7, 14, 1, 16, tzinfo=UTC),
        datetime(2026, 7, 14, 1, 16, 0, 1, tzinfo=UTC),
    ]
    assert wave_events[0].payload.model_dump(mode="json") == {
        "deployment_digest": wave.deployment_digest,
        "provider": "hf-inference-endpoints",
        "shard_ids": wave.shard_ids,
        "estimated_cost_microusd": 765_432,
    }
    assert wave_events[2].event_id == (
        "evt-"
        + hashlib.sha256(
            f"{run.run_id}:{wave.wave_id}:closed:_SUCCESS".encode()
        ).hexdigest()[:32]
    )

    trial = run.executions[0].shards[0].trials[0]
    execution = AttemptLock.model_validate_json(
        _attempt_lock_for_wave(run, wave, trial.trial_id, "execution-contract")
    )
    attempt_events = _attempt_control_events(
        run,
        execution,
        "_FAILED",
        [
            {"event": "attempt_started", "at": "2026-07-14T01:11:00+00:00"},
            {"event": "attempt_failed", "at": "2026-07-14T01:12:00+00:00"},
        ],
        "provider connection reset",
        "transient",
    )
    assert [event.kind for event in attempt_events] == [
        "attempt.started",
        "attempt.failed",
    ]
    assert attempt_events[0].payload.model_dump(mode="json") == {
        "trial_id": trial.trial_id,
        "shard_id": execution.shard_id,
        "physical_attempt": 1,
        "wave_id": wave.wave_id,
        "estimated_cost_microusd": 0,
    }
    assert attempt_events[1].payload.model_dump(mode="json") == {
        "trial_id": trial.trial_id,
        "physical_attempt": 1,
        "category": "transient",
        "spend_microusd": 0,
        "retry_after_seconds": None,
        "message": "provider connection reset",
    }


def test_retry_wave_observation_records_prorated_cost(
    remote_spec: ExperimentSpec,
) -> None:
    run = _run(remote_spec)
    wave = _wave(run, remote_spec)
    trial_id = run.executions[0].shards[0].trials[0].trial_id
    retry = wave.model_copy(
        update={
            "action_kind": "retry-shard",
            "trial_ids": [trial_id],
            "estimated_cost_microusd": 765_432,
        }
    )
    records: list[dict[str, object]] = [
        {"event": "wave_started", "at": "2026-07-14T01:10:00+00:00"},
        {"event": "wave_succeeded", "at": "2026-07-14T01:15:00+00:00"},
        {"event": "endpoint_pause_requested", "at": "2026-07-14T01:16:00+00:00"},
    ]

    events = _wave_events(run, retry, "_SUCCESS", records)

    assert events[0].payload.model_dump(mode="json")[
        "estimated_cost_microusd"
    ] == estimated_partial_wave_cost(
        run, retry.deployment_digest, retry.estimated_cost_microusd, 1
    )


def _endpoint_provisioner(port: FakePort) -> EndpointProvisioner:
    clock = FakeTime()
    return EndpointProvisioner(
        port,
        sleep=clock.sleep,
        monotonic=clock.monotonic,
    )


def test_endpoint_identity_and_nested_configuration_contracts_are_exact(
    remote_spec: ExperimentSpec,
) -> None:
    desired = _desired(remote_spec)
    missing_tag = desired.configuration.model_copy(
        update={"tags": ["benchmark", *desired.identity.tags[1:]]}
    )
    foreign = EndpointSnapshot(
        namespace="foreign",
        name=desired.identity.name,
        configuration=missing_tag,
        status=_snapshot(desired).status,
    )
    with pytest.raises(
        EndpointIdentityMismatch, match="deterministic managed identity"
    ):
        verify_exact_endpoint(desired, foreign)

    changed_model = desired.configuration.model.model_copy(
        update={
            "environment": {"A": "1", "B": "2"},
            "arguments": ["--different", "2"],
        }
    )
    changed = desired.configuration.model_copy(
        update={"model": changed_model, "cache_http_responses": False}
    )
    mismatches = effective_configuration_mismatches(desired.configuration, changed)
    assert [item.model_dump(mode="json") for item in mismatches] == [
        {
            "path": "configuration.cache_http_responses",
            "expected": "true",
            "observed": "false",
        },
        {
            "path": "configuration.model.arguments",
            "expected": (
                '["--model","/repository","--max-model-len","65536",'
                '"--kv-cache-dtype","fp8"]'
            ),
            "observed": '["--different","2"]',
        },
        {
            "path": "configuration.model.environment.A",
            "expected": "null",
            "observed": '"1"',
        },
        {
            "path": "configuration.model.environment.B",
            "expected": "null",
            "observed": '"2"',
        },
        {
            "path": "configuration.model.environment.VLLM_USE_FLASHINFER_MOE_FP4",
            "expected": '"1"',
            "observed": "null",
        },
    ]
    with pytest.raises(EndpointConfigurationMismatch) as captured:
        verify_exact_endpoint(desired, _snapshot(desired, configuration=changed))
    assert captured.value.mismatches == mismatches


def test_endpoint_create_pause_and_delete_have_exact_side_effect_sequences(
    remote_spec: ExperimentSpec,
) -> None:
    desired = _desired(remote_spec)
    running = _snapshot(desired, state="running", ready=1, target=2)
    paused = _snapshot(desired, state="paused", ready=0, target=2)
    created_port = FakePort(
        inspections=[None, running, paused],
        create_result=running,
        pause_result=running,
    )
    created = _endpoint_provisioner(created_port).create_or_adopt(
        desired, timeout_seconds=5, poll_seconds=1
    )
    identity = desired.identity.name
    assert created.action == "created"
    assert created.snapshot == paused
    assert created_port.calls == [
        f"inspect:{identity}",
        f"create:{identity}",
        f"inspect:{identity}",
        f"pause:{identity}",
        f"inspect:{identity}",
    ]

    delete_port = FakePort(
        inspections=[paused, None],
        delete_error=AmbiguousEndpointDelete("uncertain"),
    )
    assert _endpoint_provisioner(delete_port).delete(desired) is True
    assert delete_port.calls == [
        f"inspect:{identity}",
        f"delete:{identity}",
        f"inspect:{identity}",
    ]


def test_ambiguous_endpoint_create_is_adopted_then_verified_paused(
    remote_spec: ExperimentSpec,
) -> None:
    desired = _desired(remote_spec)
    paused = _snapshot(desired, target=2)
    port = FakePort(
        inspections=[None, None, paused, paused],
        create_result=AmbiguousEndpointCreate("uncertain"),
    )

    result = _endpoint_provisioner(port).create_or_adopt(
        desired, timeout_seconds=5, poll_seconds=1
    )

    identity = desired.identity.name
    assert result.action == "adopted"
    assert result.snapshot == paused
    assert port.calls == [
        f"inspect:{identity}",
        f"create:{identity}",
        f"inspect:{identity}",
        f"inspect:{identity}",
        f"inspect:{identity}",
    ]


@pytest.mark.parametrize(
    ("value", "expected"),
    [("public", "public"), ("authenticated", "authenticated"), ("private", "private")],
)
def test_hf_endpoint_access_types_are_preserved(value: str, expected: str) -> None:
    assert _access_type(value) == expected


@pytest.mark.parametrize("value", [None, "", "PUBLIC", "protected", 1, True])
def test_hf_endpoint_access_type_rejects_noncontract_values(value: object) -> None:
    with pytest.raises((TypeError, ValueError)):
        _access_type(value)


def test_hf_endpoint_boundary_collection_parsers_are_strict() -> None:
    assert dict(_mapping({"key": 1}, "root")) == {"key": 1}
    assert _string_list(["a", "b"], "items") == ["a", "b"]
    assert _string_mapping({"a": "1", "b": "2"}, "values") == {
        "a": "1",
        "b": "2",
    }
    for value in (None, [], {1: "value"}):
        with pytest.raises(TypeError):
            _mapping(value, "root")
    for value in (None, {}, ["a", 2], "a"):
        with pytest.raises(TypeError):
            _string_list(value, "items")
    for value in (None, [], {"a": 1}):
        with pytest.raises(TypeError):
            _string_mapping(value, "values")


def test_hf_endpoint_scaling_measure_contract_is_exact() -> None:
    assert _scaling_measure(None) == (None, None)
    assert _scaling_measure({"pendingRequests": 2}) == ("pendingRequests", 2.0)
    assert _scaling_measure({"hardwareUsage": 0.75}) == ("hardwareUsage", 0.75)
    assert _scaling_measure({"pendingRequests": None}) == (None, None)
    for value in (
        {},
        {"pendingRequests": 1, "hardwareUsage": 2},
        {"unknown": 1},
        {"pendingRequests": True},
        {"pendingRequests": "1"},
    ):
        with pytest.raises((TypeError, ValueError)):
            _scaling_measure(value)


@pytest.mark.parametrize(
    ("operation", "status", "error_type", "message"),
    [
        ("create", 400, EndpointProviderError, "create failed: HTTP 400"),
        ("pause", 409, AmbiguousEndpointPause, "pause outcome is ambiguous: HTTP 409"),
        (
            "create",
            500,
            AmbiguousEndpointCreate,
            "create outcome is ambiguous: HTTP 500",
        ),
        (
            "delete",
            404,
            AmbiguousEndpointDelete,
            "delete outcome is ambiguous: HTTP 404",
        ),
        ("delete", 403, EndpointProviderError, "delete failed: HTTP 403"),
    ],
)
def test_hf_endpoint_provider_http_error_classification_is_exact(
    operation: str,
    status: int,
    error_type: type[Exception],
    message: str,
) -> None:
    def request() -> None:
        raise _http_error(status)

    ambiguous: type[EndpointProvisioningError] = {
        "create": AmbiguousEndpointCreate,
        "pause": AmbiguousEndpointPause,
        "delete": AmbiguousEndpointDelete,
    }[operation]
    with pytest.raises(error_type, match=message):
        _provider_call(operation, request, ambiguous=ambiguous)


@pytest.mark.parametrize(
    ("operation", "ambiguous"),
    [
        ("create", AmbiguousEndpointCreate),
        ("pause", AmbiguousEndpointPause),
        ("delete", AmbiguousEndpointDelete),
    ],
)
def test_hf_endpoint_transport_errors_are_always_ambiguous(
    operation: str, ambiguous: type[EndpointProvisioningError]
) -> None:
    def request() -> None:
        raise httpx.ConnectError("connection lost")

    with pytest.raises(ambiguous, match="ambiguous before a response"):
        _provider_call(operation, request, ambiguous=ambiguous)


class _LeaseStub:
    def acquire(self, path: str, owner: dict[str, str]) -> None:
        del path, owner

    def release(self, path: str, owner: dict[str, str]) -> None:
        del path, owner


class _ApiStub:
    def list_repo_files(self, repo_id: str, **kwargs: object) -> list[str]:
        del repo_id, kwargs
        return []


def _index_row(
    publication_id: str,
    completed_at: datetime,
    revision: str,
    *,
    execution_id: str | None = None,
) -> GlobalIndexRow:
    return GlobalIndexRow(
        publication_id=publication_id,
        execution_id=execution_id or f"run-{publication_id}",
        run_id="run-one",
        evaluation_id="evaluation-one",
        publication_role="final",
        component_kind=None,
        benchmark="shellbench",
        result_kind="ordinary",
        outcome="complete",
        quality="clean",
        completed_at=completed_at,
        model_repo="org/model",
        model_revision="a" * 40,
        agent_name="agent",
        agent_revision="1.2.3",
        result_dataset="org/results",
        result_revision=revision,
        source_checksum="sha256:" + "b" * 64,
        control_commit="c" * 40,
    )


def test_result_index_windows_are_deduplicated_sorted_and_power_sized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 7, 14, tzinfo=UTC)
    old = _index_row("pub-old", now, "1" * 40)
    same_time_later_id = _index_row("pub-z", now + timedelta(minutes=1), "2" * 40)
    prior_contract = _index_row(
        "pub-prior-contract",
        now + timedelta(minutes=2),
        "3" * 40,
        execution_id="execution-rotated",
    )
    replacement = _index_row(
        "pub-new",
        now + timedelta(minutes=3),
        "4" * 40,
        execution_id="execution-rotated",
    )
    publisher = HubDatasetPublisher(
        publisher_id="publisher-one",
        leases=_LeaseStub(),
        api=cast(Any, _ApiStub()),
    )
    monkeypatch.setattr(publisher, "_exists", lambda *args: False)
    monkeypatch.setattr(
        publisher,
        "_individual_index_rows",
        lambda *args: [same_time_later_id, prior_contract, old],
    )

    windows = publisher._index_windows("org/index", "d" * 40, replacement)

    assert [item.path for item in windows] == [
        f"data/index/schema=v1/windows/{2**power:04d}.parquet" for power in range(12)
    ]
    expected_ids = ["pub-new", "pub-z", "pub-old"]
    assert [row.publication_id for row in read_index_file(windows[0].content)] == [
        "pub-new"
    ]
    assert [row.publication_id for row in read_index_file(windows[1].content)] == [
        "pub-new",
        "pub-z",
    ]
    assert [row.publication_id for row in read_index_file(windows[2].content)] == (
        expected_ids
    )
    assert [row.result_revision for row in read_index_file(windows[-1].content)] == [
        "4" * 40,
        "2" * 40,
        "1" * 40,
    ]


def test_result_index_window_prefers_consolidated_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 7, 14, tzinfo=UTC)
    existing = [_index_row("pub-existing", now, "1" * 40)]
    consolidated = build_index_window_file(existing, 2048)
    publisher = HubDatasetPublisher(
        publisher_id="publisher-one",
        leases=_LeaseStub(),
        api=cast(Any, _ApiStub()),
    )
    monkeypatch.setattr(
        publisher,
        "_exists",
        lambda dataset, path, revision: (
            dataset == "org/index"
            and path == consolidated.path
            and revision == "d" * 40
        ),
    )
    monkeypatch.setattr(
        publisher,
        "_read",
        lambda dataset, path, revision: consolidated.content,
    )
    monkeypatch.setattr(
        publisher,
        "_individual_index_rows",
        lambda *args: pytest.fail("individual files must not be read"),
    )

    windows = publisher._index_windows(
        "org/index",
        "d" * 40,
        _index_row("pub-new", now + timedelta(seconds=1), "2" * 40),
    )

    assert [row.publication_id for row in read_index_file(windows[-1].content)] == [
        "pub-new",
        "pub-existing",
    ]


def test_publication_receipts_and_lease_identity_are_canonical() -> None:
    row = _index_row("pub-receipt", datetime(2026, 7, 14, tzinfo=UTC), "1" * 40)
    index_file = build_index_window_file([row], 1)
    receipt = HubDatasetPublisher._index_receipt(row, index_file)
    assert receipt == IndexReceipt(
        publication_id="pub-receipt",
        result_dataset="org/results",
        result_revision="1" * 40,
        index_path="data/index/schema=v1/windows/0001.parquet",
        index_sha256=("sha256:" + hashlib.sha256(index_file.content).hexdigest()),
    )
    assert publisher_lease_path("org/results") == (
        "coordination/publishers/"
        "eb1ce4ea9e1b25394e2cff859f3d086d3afab316fc7519d7b3f901940d22e697.json"
    )
    result = ResultReceipt(
        publication_id="pub-receipt",
        execution_id="execution-one",
        source_checksum="sha256:" + "a" * 64,
        files={"data/executions.parquet": "sha256:" + "b" * 64},
    )
    assert json.loads(result.model_dump_json()) == {
        "schema_version": "harbor-hf/result-publication/v1",
        "publication_id": "pub-receipt",
        "execution_id": "execution-one",
        "source_checksum": "sha256:" + "a" * 64,
        "files": {"data/executions.parquet": "sha256:" + "b" * 64},
    }


def test_result_index_file_rejects_invalid_bytes_and_nonpositive_windows() -> None:
    with pytest.raises(ValueError, match="window size must be positive"):
        build_index_window_file([], 0)
    with pytest.raises(ValueError, match="global index Parquet is invalid"):
        read_index_file(b"not parquet")

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import httpx
import pytest
from huggingface_hub import BucketFile, BucketFolder

import harbor_hf.run_native_profile_migration as migration_module
from harbor_hf.run_native_profile_migration import (
    MAX_IMAGE_BYTES,
    MAX_IMAGE_ENTRIES,
    PREPARATION_COMMAND,
    PROFILE_PREFIX,
    TRIAL_COMMAND,
    ConfirmationError,
    InventoryError,
    JsonObject,
    JsonValue,
    ManifestError,
    ProfileDigestRemap,
    ProfileMigrationError,
    RecordShapeError,
    ResumableApplyError,
    StaleInventoryError,
    VerificationError,
    apply_migration,
    build_migration_plan,
    canonical_bytes,
    deterministic_id,
    main,
    read_manifest,
    read_profile_snapshot,
    run_dry_run,
    sha256,
)

_BUCKET_ID = "example-org/artifact-bucket"
_JOB_IMAGE = f"ghcr.io/example/trial-worker@sha256:{'1' * 64}"
_OLD_JOB_IMAGE = f"ghcr.io/example/old-worker@sha256:{'2' * 64}"
_WORKER_REVISION = "3" * 40
_NOW = datetime(2026, 8, 24, 12, 0, tzinfo=UTC)
_CREATED_AT = "2026-08-24T12:00:00Z"


def _xet_hash(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


class FakeHfApi:
    """In-memory implementation of the installed Bucket method signatures."""

    def __init__(self, contents: dict[str, bytes]) -> None:
        self.contents = dict(contents)
        self.list_calls = 0
        self.batch_calls: list[tuple[str, tuple[str, ...]]] = []
        self.list_mutations: dict[int, Callable[[], None]] = {}
        self.partial_add_once: int | None = None
        self.partial_add_call: int | None = None
        self.add_call_count = 0
        self.partial_delete_once: int | None = None
        self.skip_adds = False
        self.skip_deletes = False

    def list_bucket_tree(
        self,
        bucket_id: str,
        prefix: str | None = None,
        *,
        recursive: bool | None = None,
        token: str | bool | None = None,
    ) -> Iterable[BucketFile | BucketFolder]:
        assert bucket_id == _BUCKET_ID
        assert prefix == PROFILE_PREFIX
        assert recursive is True
        assert token is None
        self.list_calls += 1
        if self.list_calls in self.list_mutations:
            self.list_mutations[self.list_calls]()
        entries = [
            BucketFile(
                type="file",
                path=key,
                size=len(content),
                xetHash=_xet_hash(content),
                mtime=None,
                uploadedAt=None,
            )
            for key, content in sorted(self.contents.items())
        ]
        return cast(list[BucketFile | BucketFolder], entries)

    def get_bucket_paths_info(
        self,
        bucket_id: str,
        paths: Iterable[str],
        *,
        token: str | bool | None = None,
    ) -> Iterable[BucketFile]:
        assert bucket_id == _BUCKET_ID
        assert token is None
        output: list[BucketFile] = []
        for key in paths:
            try:
                content = self.contents[key]
            except KeyError:
                continue
            output.append(
                BucketFile(
                    type="file",
                    path=key,
                    size=len(content),
                    xetHash=_xet_hash(content),
                    mtime=None,
                    uploadedAt=None,
                )
            )
        return output

    def download_bucket_files(
        self,
        bucket_id: str,
        files: list[tuple[str | BucketFile, str | Path]],
        *,
        raise_on_missing_files: bool = False,
        token: str | bool | None = None,
    ) -> None:
        assert bucket_id == _BUCKET_ID
        assert raise_on_missing_files is True
        assert token is None
        for remote, destination in files:
            assert isinstance(remote, BucketFile)
            Path(destination).write_bytes(self.contents[remote.path])

    def batch_bucket_files(
        self,
        bucket_id: str,
        *,
        add: list[tuple[str | Path | bytes, str]] | None = None,
        copy: list[tuple[str, str, str, str]] | None = None,
        delete: list[str] | None = None,
        token: str | bool | None = None,
    ) -> None:
        assert bucket_id == _BUCKET_ID
        assert copy is None
        assert token is None
        if add is not None:
            assert delete is None
            keys = tuple(key for _, key in add)
            self.batch_calls.append(("add", keys))
            self._add(add)
            return
        assert delete is not None
        self.batch_calls.append(("delete", tuple(delete)))
        self._delete(delete)

    def _add(self, additions: list[tuple[str | Path | bytes, str]]) -> None:
        if self.skip_adds:
            return
        self.add_call_count += 1
        should_interrupt = self.partial_add_call in (None, self.add_call_count)
        stop_after = self.partial_add_once if should_interrupt else None
        if should_interrupt:
            self.partial_add_once = None
            self.partial_add_call = None
        for index, (source, key) in enumerate(additions, start=1):
            assert isinstance(source, bytes)
            self.contents[key] = source
            if stop_after == index:
                raise _transport_error()

    def _delete(self, deletions: list[str]) -> None:
        if self.skip_deletes:
            return
        stop_after = self.partial_delete_once
        self.partial_delete_once = None
        for index, key in enumerate(deletions, start=1):
            del self.contents[key]
            if stop_after == index:
                raise _transport_error()


@dataclass(frozen=True)
class SourceFixture:
    contents: dict[str, bytes]
    capacity: JsonObject
    deployment: JsonObject
    model: JsonObject
    model_raw: bytes


def _transport_error() -> httpx.ConnectError:
    request = httpx.Request("POST", "https://huggingface.invalid")
    return httpx.ConnectError("interrupted", request=request)


def _clock() -> datetime:
    return _NOW


def _apply(
    api: FakeHfApi,
    dry_run_path: Path,
    verification_path: Path,
    expected_plan_digest: str | None,
    *,
    confirmed: bool = True,
    worker_revision: str = _WORKER_REVISION,
) -> JsonObject:
    return apply_migration(
        api=api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=worker_revision,
        confirmed=confirmed,
        expected_plan_digest=expected_plan_digest,
        dry_run_manifest_path=dry_run_path,
        verification_manifest_path=verification_path,
        clock=_clock(),
    )


def _profile(profile_kind: str, name: str, spec: JsonObject) -> JsonObject:
    return {
        "schema_version": "v1",
        "kind": "profile.object",
        "record_id": deterministic_id(
            "profile",
            profile_kind,
            name,
            sha256(canonical_bytes(spec)),
        ),
        "created_at": "2026-08-18T00:00:00Z",
        "actor": {"subject": "source", "role": "service"},
        "profile_kind": profile_kind,
        "name": name,
        "spec": spec,
    }


def _promotion(
    profile: JsonObject,
    *,
    record_id: str,
    alias: str,
) -> JsonObject:
    return {
        "schema_version": "v1",
        "kind": "profile.promotion",
        "record_id": record_id,
        "created_at": "2026-08-19T00:00:00Z",
        "actor": {"subject": "operator", "role": "operator"},
        "profile_kind": profile["profile_kind"],
        "alias": alias,
        "profile_id": sha256(canonical_bytes(profile)),
        "promotion_state": "approved",
        "reason": "reviewed",
        "evidence": [f"sha256:{'4' * 64}"],
    }


def _record_path(record: JsonObject) -> str:
    if record["kind"] == "profile.object":
        return (
            f"{PROFILE_PREFIX}objects/{record['profile_kind']}/"
            f"{record['record_id']}.json"
        )
    return (
        f"{PROFILE_PREFIX}promotions/{record['profile_kind']}/{record['alias']}/"
        f"{record['record_id']}.json"
    )


def _pretty_bytes(record: JsonObject) -> bytes:
    return (json.dumps(record, indent=2, ensure_ascii=False) + "\n").encode()


def _resign_manifest(manifest: JsonObject) -> None:
    unsigned = dict(manifest)
    del unsigned["plan_digest"]
    manifest["plan_digest"] = sha256(canonical_bytes(unsigned))


def _legacy_capacity_spec() -> JsonObject:
    return {
        "namespace": "shared",
        "max_active_sandboxes": 16,
        "hardware_limits": [
            {"hardware": "cpu-basic", "max_active_sandboxes": 12},
            {"hardware": "cpu-upgrade", "max_active_sandboxes": 4},
        ],
        "start_burst": 8,
        "start_refill_tokens": 2,
        "start_refill_period_seconds": 30,
    }


def _legacy_deployment_spec() -> JsonObject:
    return {
        "route": "hf_job",
        "models": ["model-one"],
        "harnesses": ["harness-one"],
        "job_image": _OLD_JOB_IMAGE,
        "preparation_job_command": ["/bin/sh", "-lc", "old prepare"],
        "job_command": ["/bin/sh", "-lc", "old trial"],
        "hardware": "cpu-upgrade",
        "active_hourly_cost_microusd": 30_000,
        "timeout_seconds": 14_400,
        "trusted_worker": True,
        "inference_token": "forbidden",
        "inference_provider": "provider",
        "input_price_microusd_per_million_tokens": 140_000,
        "output_price_microusd_per_million_tokens": 280_000,
        "harbor_version": "0.22.0",
        "worker_revision": "5" * 40,
        "context_window": 131_072,
        "preparation": "required",
        "preparation_timeout_seconds": 3_600,
        "worker_concurrency": 2,
        "worker_max_tasks_per_job": 2,
        "sandbox_template": {
            "flavors": [
                {
                    "hardware": "cpu-basic",
                    "cpus": 2,
                    "memory_mb": 16_384,
                    "storage_mb": 102_400,
                    "gpus": 0,
                    "active_hourly_cost_microusd": 10_000,
                }
            ],
            "inference_token": "required",
            "inference_upstream": "https://router.huggingface.co/v1",
            "inference_model": "example/model",
            "inference_api": "chat-completions",
            "inference_max_requests": 512,
            "inference_max_concurrency": 2,
            "inference_max_total_concurrency": 8,
            "inference_timeout_seconds": 1_800,
            "inference_max_output_tokens": 32_768,
            "root_bootstrap_command": ["/bin/sh", "-lc", "old bootstrap"],
            "max_sandboxes": 4,
            "max_commands": 512,
            "max_command_seconds": 28_800,
            "max_transfer_bytes": 67_108_864,
            "allowed_roots": ["/tmp", "/solution"],
            "default_cpus": 1,
            "default_memory_mb": 2_048,
            "default_storage_mb": 10_240,
            "default_gpus": 0,
            "max_timeout_seconds": 43_200,
            "lifetime_overhead_seconds": 900,
            "idle_timeout_overhead_seconds": 0,
        },
    }


def _legacy_sandbox_delegating_spec() -> JsonObject:
    return {
        "route": "hf_job",
        "models": ["control-smoke"],
        "harnesses": ["control-smoke"],
        "job_image": _OLD_JOB_IMAGE,
        "job_command": ["/bin/sh", "-lc", "old sandbox smoke"],
        "hardware": "cpu-basic",
        "active_hourly_cost_microusd": 10_000,
        "timeout_seconds": 900,
        "trusted_worker": True,
        "inference_token": "forbidden",
        "sandbox": {
            "image": _OLD_JOB_IMAGE,
            "hardware": "cpu-basic",
            "timeout_seconds": 600,
            "idle_timeout_seconds": 300,
            "max_sandboxes": 1,
            "max_commands": 8,
            "max_command_seconds": 120,
            "max_transfer_bytes": 1_048_576,
            "allowed_roots": ["/tmp"],
            "reservation_microusd": 2_000,
            "active_hourly_cost_microusd": 10_000,
            "inference_token": "forbidden",
        },
    }


def _legacy_launch_policy_spec() -> JsonObject:
    return {
        "max_infrastructure_attempts": 3,
        "reservation_microusd": 50_000,
        "max_campaign_ceiling_microusd": 10_600_000,
        "success_without_worker_receipt": False,
        "publication_role": "diagnostic",
        "preparation_reservation_microusd": 10_000,
        "max_preparation_attempts": 2,
        "required_positive_metrics": ["input_tokens", "output_tokens"],
    }


def _source_fixture() -> SourceFixture:
    capacity = _profile("capacity", "capacity-one", _legacy_capacity_spec())
    deployment = _profile("deployment", "deployment-one", _legacy_deployment_spec())
    model = _profile(
        "model",
        "model-one",
        {"model_id": "example/model", "revision": "revision-one"},
    )
    capacity_promotion = _promotion(
        capacity,
        record_id="promotion-capacity-one",
        alias="current",
    )
    model_promotion = _promotion(
        model,
        record_id="promotion-model-one",
        alias="recommended",
    )
    contents = {
        _record_path(capacity): _pretty_bytes(capacity),
        _record_path(deployment): _pretty_bytes(deployment),
        _record_path(model): canonical_bytes(model),
        _record_path(capacity_promotion): canonical_bytes(capacity_promotion),
        _record_path(model_promotion): canonical_bytes(model_promotion),
    }
    return SourceFixture(
        contents=contents,
        capacity=capacity,
        deployment=deployment,
        model=model,
        model_raw=contents[_record_path(model)],
    )


def _add_current_model(api: FakeHfApi, name: str) -> None:
    profile = _profile(
        "model",
        name,
        {"model_id": f"example/{name}", "revision": "revision-two"},
    )
    api.contents[_record_path(profile)] = canonical_bytes(profile)


def _promotion_tie_fixture() -> tuple[dict[str, bytes], JsonObject]:
    fixture = _source_fixture()
    current_capacity = _profile(
        "capacity",
        "capacity-two",
        {
            "namespace": "shared",
            "max_active_jobs": 8,
            "hardware_limits": [],
            "start_burst": 4,
            "start_refill_tokens": 1,
            "start_refill_period_seconds": 30,
        },
    )
    older = _promotion(
        fixture.capacity,
        record_id="promotion-capacity-a",
        alias="shared",
    )
    newer = _promotion(
        fixture.capacity,
        record_id="promotion-capacity-b",
        alias="shared",
    )
    active = _promotion(
        current_capacity,
        record_id="promotion-capacity-z",
        alias="shared",
    )
    older["created_at"] = "2026-08-19T00:30:00Z"
    newer["created_at"] = "2026-08-19T00:30:00Z"
    active["created_at"] = "2026-08-19T01:00:00+02:00"
    contents = dict(fixture.contents)
    for record in (current_capacity, older, newer, active):
        contents[_record_path(record)] = canonical_bytes(record)
    return contents, current_capacity


def test_canonical_json_and_deterministic_id_match_typescript() -> None:
    assert (
        canonical_bytes({"z": 9_007_199_254_740_991, "a": [True, None, "é"]})
        == '{"a":[true,null,"é"],"z":9007199254740991}\n'.encode()
    )
    assert (
        deterministic_id(
            "profile",
            "deployment",
            "example",
            f"sha256:{'a' * 64}",
        )
        == "profile-85c1fd20a01c1106f5f30d8c"
    )
    assert canonical_bytes({"value": 1.5}) == b'{"value":1.5}\n'


def test_plan_transforms_profiles_and_remaps_only_related_promotion() -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    snapshot = read_profile_snapshot(api, _BUCKET_ID)

    plan = build_migration_plan(
        snapshot,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        created_at=_CREATED_AT,
    )

    assert plan.transformed_capacity_count == 1
    assert plan.transformed_deployment_count == 1
    assert plan.transformed_launch_policy_count == 0
    assert plan.transformed_promotion_count == 1
    assert len(plan.remaps) == 2
    values = [record.value for record in plan.target]
    capacity = next(
        value
        for value in values
        if value["kind"] == "profile.object" and value["profile_kind"] == "capacity"
    )
    capacity_spec = cast(JsonObject, capacity["spec"])
    assert capacity_spec == {
        "namespace": "shared",
        "max_active_jobs": 16,
        "hardware_limits": [
            {"hardware": "cpu-basic", "max_active_jobs": 12},
            {"hardware": "cpu-upgrade", "max_active_jobs": 4},
        ],
        "start_burst": 8,
        "start_refill_tokens": 2,
        "start_refill_period_seconds": 30,
    }
    deployment = next(
        value
        for value in values
        if value["kind"] == "profile.object" and value["profile_kind"] == "deployment"
    )
    deployment_spec = cast(JsonObject, deployment["spec"])
    assert deployment_spec["job_image"] == _JOB_IMAGE
    assert deployment_spec["worker_revision"] == _WORKER_REVISION
    assert deployment_spec["preparation_job_command"] == list(PREPARATION_COMMAND)
    assert deployment_spec["job_command"] == list(TRIAL_COMMAND)
    assert deployment_spec["active_hourly_cost_microusd"] == 30_000
    assert "sandbox_template" not in deployment_spec
    assert "worker_concurrency" not in deployment_spec
    assert "worker_max_tasks_per_job" not in deployment_spec
    template = cast(JsonObject, deployment_spec["trial_job_template"])
    legacy_template = cast(
        JsonObject, cast(JsonObject, fixture.deployment["spec"])["sandbox_template"]
    )
    assert template["flavors"] == legacy_template["flavors"]
    assert template == {
        "flavors": legacy_template["flavors"],
        "inference_upstream": "https://router.huggingface.co/v1",
        "inference_api": "chat-completions",
        "inference_timeout_seconds": 1_800,
        "inference_max_output_tokens": 32_768,
        "default_cpus": 1,
        "default_memory_mb": 2_048,
        "default_storage_mb": 10_240,
        "default_gpus": 0,
        "max_timeout_seconds": 43_200,
        "lifetime_overhead_seconds": 900,
        "max_image_bytes": MAX_IMAGE_BYTES,
        "max_image_entries": MAX_IMAGE_ENTRIES,
        "max_jobs": 4,
    }
    for removed in (
        "inference_token",
        "inference_model",
        "inference_max_requests",
        "inference_max_concurrency",
        "inference_max_total_concurrency",
        "root_bootstrap_command",
        "max_sandboxes",
        "max_commands",
        "max_command_seconds",
        "max_transfer_bytes",
        "allowed_roots",
        "idle_timeout_overhead_seconds",
    ):
        assert removed not in template
    expected_record_id = deterministic_id(
        "profile",
        "deployment",
        "deployment-one",
        sha256(canonical_bytes(deployment_spec)),
    )
    assert deployment["record_id"] == expected_record_id

    model_target = next(
        record
        for record in plan.target
        if record.value["kind"] == "profile.object"
        and record.value["profile_kind"] == "model"
    )
    assert model_target.raw == fixture.model_raw
    promotions = [value for value in values if value["kind"] == "profile.promotion"]
    capacity_promotion = next(
        value for value in promotions if value["profile_kind"] == "capacity"
    )
    model_promotion = next(
        value for value in promotions if value["profile_kind"] == "model"
    )
    assert capacity_promotion["created_at"] == "2026-08-24T12:00:00.000000Z"
    assert capacity_promotion["profile_id"] == next(
        remap.target for remap in plan.remaps if remap.profile_kind == "capacity"
    )
    assert (
        capacity_promotion["reason"]
        == "Migrated to the approved Run-native profile replacement."
    )
    assert model_promotion["record_id"] == "promotion-model-one"
    model_source = next(
        record
        for record in snapshot.records
        if record.value["kind"] == "profile.promotion"
        and record.value["profile_kind"] == "model"
    )
    model_target_promotion = next(
        record
        for record in plan.target
        if record.value["kind"] == "profile.promotion"
        and record.value["profile_kind"] == "model"
    )
    assert model_target_promotion.raw == model_source.raw


def test_plan_preserves_lexical_promotion_winner_with_timestamp_offsets() -> None:
    contents, current_capacity = _promotion_tie_fixture()
    snapshot = read_profile_snapshot(FakeHfApi(contents), _BUCKET_ID)

    plan = build_migration_plan(
        snapshot,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        created_at=_CREATED_AT,
    )

    migrated = sorted(
        (
            record.value
            for record in plan.target
            if record.value["kind"] == "profile.promotion"
            and record.value["profile_kind"] == "capacity"
            and record.value["alias"] == "shared"
        ),
        key=lambda value: (value["created_at"], value["record_id"]),
    )
    assert plan.transformed_promotion_count == 4
    assert len(migrated) == 3
    assert migrated[-1]["profile_id"] == sha256(canonical_bytes(current_capacity))
    assert len({value["created_at"] for value in migrated}) == 3


@pytest.mark.parametrize("add_call", [1, 2, 3])
def test_apply_resumes_each_partial_add_phase(
    tmp_path: Path,
    add_call: int,
) -> None:
    contents, _ = _promotion_tie_fixture()
    api = FakeHfApi(contents)
    dry_run_path = tmp_path / "dry-run.json"
    verification_path = tmp_path / "verification.json"
    manifest = run_dry_run(
        api=api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=dry_run_path,
        clock=_clock(),
    )
    api.partial_add_once = 1
    api.partial_add_call = add_call

    with pytest.raises(ResumableApplyError, match="add phase stopped safely"):
        _apply(
            api,
            dry_run_path,
            verification_path,
            cast(str, manifest["plan_digest"]),
        )

    verification = _apply(
        api,
        dry_run_path,
        verification_path,
        cast(str, manifest["plan_digest"]),
    )
    assert verification["status"] == "verified"


def test_plan_rejects_noncanonical_current_records() -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    current = _profile(
        "model",
        "noncanonical-model",
        {"model_id": "example/noncanonical", "revision": "revision-two"},
    )
    api.contents[_record_path(current)] = _pretty_bytes(current)
    snapshot = read_profile_snapshot(api, _BUCKET_ID)

    with pytest.raises(RecordShapeError, match="non-canonical"):
        build_migration_plan(
            snapshot,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            created_at=_CREATED_AT,
        )


def test_plan_preserves_retired_sandbox_deployment_as_direct_job_history() -> None:
    fixture = _source_fixture()
    retired = _profile(
        "deployment",
        "retired-sandbox-smoke",
        _legacy_sandbox_delegating_spec(),
    )
    contents = dict(fixture.contents)
    contents[_record_path(retired)] = canonical_bytes(retired)
    snapshot = read_profile_snapshot(FakeHfApi(contents), _BUCKET_ID)

    plan = build_migration_plan(
        snapshot,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        created_at=_CREATED_AT,
    )

    migrated = next(
        record.value
        for record in plan.target
        if record.value["kind"] == "profile.object"
        and record.value["profile_kind"] == "deployment"
        and record.value["name"] == "retired-sandbox-smoke"
    )
    spec = cast(JsonObject, migrated["spec"])
    assert "sandbox" not in spec
    assert "inference_token" not in spec
    assert spec["job_image"] == _OLD_JOB_IMAGE
    assert spec["job_command"] == ["/bin/sh", "-lc", "old sandbox smoke"]
    assert plan.transformed_deployment_count == 2


def test_plan_rejects_unknown_retired_sandbox_shape() -> None:
    fixture = _source_fixture()
    spec = _legacy_sandbox_delegating_spec()
    sandbox = cast(JsonObject, spec["sandbox"])
    sandbox["unknown"] = True
    retired = _profile("deployment", "unknown-sandbox", spec)
    contents = dict(fixture.contents)
    contents[_record_path(retired)] = canonical_bytes(retired)
    snapshot = read_profile_snapshot(FakeHfApi(contents), _BUCKET_ID)

    with pytest.raises(RecordShapeError, match="sandbox.*unknown legacy shape"):
        build_migration_plan(
            snapshot,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            created_at=_CREATED_AT,
        )


def test_plan_collapses_legacy_profiles_with_identical_targets(
    tmp_path: Path,
) -> None:
    earlier = _profile(
        "deployment",
        "retired-sandbox",
        _legacy_sandbox_delegating_spec(),
    )
    earlier["created_at"] = "2026-08-18T01:30:00+02:00"
    later_spec = _legacy_sandbox_delegating_spec()
    later_sandbox = cast(JsonObject, later_spec["sandbox"])
    later_sandbox["idle_timeout_seconds"] = 301
    later = _profile("deployment", "retired-sandbox", later_spec)
    later["created_at"] = "2026-08-18T00:00:00Z"
    contents = {
        _record_path(earlier): canonical_bytes(earlier),
        _record_path(later): canonical_bytes(later),
    }
    snapshot = read_profile_snapshot(FakeHfApi(contents), _BUCKET_ID)

    plan = build_migration_plan(
        snapshot,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        created_at=_CREATED_AT,
    )

    targets = [
        record for record in plan.target if record.value["kind"] == "profile.object"
    ]
    assert len(targets) == 1
    assert targets[0].value["created_at"] == earlier["created_at"]
    assert len(plan.remaps) == 2
    assert {remap.target for remap in plan.remaps} == {targets[0].content_digest}
    manifest = migration_module.dry_run_manifest(
        plan,
        bucket_identity_digest=migration_module._bucket_identity_digest(_BUCKET_ID),
        created_at=_CREATED_AT,
    )
    assert manifest["add_count"] == 1
    assert manifest["delete_count"] == 2
    manifest_path = tmp_path / "dry-run.json"
    migration_module.write_manifest(manifest_path, manifest)
    assert read_manifest(manifest_path).add_count == 1


def test_plan_renames_legacy_launch_policy_and_remaps_its_promotion() -> None:
    fixture = _source_fixture()
    launch_policy = _profile(
        "launch_policy",
        "diagnostic-policy",
        _legacy_launch_policy_spec(),
    )
    promotion = _promotion(
        launch_policy,
        record_id="promotion-launch-policy",
        alias="diagnostic",
    )
    contents = dict(fixture.contents)
    for record in (launch_policy, promotion):
        contents[_record_path(record)] = canonical_bytes(record)
    snapshot = read_profile_snapshot(FakeHfApi(contents), _BUCKET_ID)

    plan = build_migration_plan(
        snapshot,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        created_at=_CREATED_AT,
    )

    migrated = next(
        record.value
        for record in plan.target
        if record.value["kind"] == "profile.object"
        and record.value["profile_kind"] == "launch_policy"
    )
    spec = cast(JsonObject, migrated["spec"])
    assert "max_campaign_ceiling_microusd" not in spec
    assert spec["max_run_ceiling_microusd"] == 10_600_000
    remap = next(item for item in plan.remaps if item.profile_kind == "launch_policy")
    migrated_promotion = next(
        record.value
        for record in plan.target
        if record.value["kind"] == "profile.promotion"
        and record.value["profile_kind"] == "launch_policy"
    )
    assert migrated_promotion["profile_id"] == remap.target
    assert migrated_promotion["actor"] == {
        "subject": "run-native-profile-migration",
        "role": "service",
    }
    assert (
        migrated_promotion["reason"]
        == "Migrated to the approved Run-native profile replacement."
    )
    assert migrated_promotion["evidence"] == [sha256(canonical_bytes(promotion))]
    assert plan.transformed_launch_policy_count == 1


def test_dry_run_writes_authenticated_secret_free_manifest(tmp_path: Path) -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    path = tmp_path / "dry-run.json"

    manifest = run_dry_run(
        api=api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=path,
        clock=_clock(),
    )

    assert manifest["profile_count"] == 3
    assert manifest["promotion_count"] == 2
    assert manifest["add_count"] == 3
    assert manifest["delete_count"] == 3
    assert manifest[
        "bucket_identity_digest"
    ] == migration_module._bucket_identity_digest(_BUCKET_ID)
    assert read_manifest(path).plan_digest == manifest["plan_digest"]
    text = path.read_text(encoding="utf-8")
    for private_value in (
        _BUCKET_ID,
        "capacity-one",
        "deployment-one",
        "model-one",
        "promotion-capacity-one",
        "recommended",
    ):
        assert private_value not in text
    assert api.batch_calls == []


def test_apply_adds_then_deletes_and_verifies_exact_target(tmp_path: Path) -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    dry_run_path = tmp_path / "dry-run.json"
    verification_path = tmp_path / "verification.json"
    manifest = run_dry_run(
        api=api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=dry_run_path,
        clock=_clock(),
    )

    verification = _apply(
        api,
        dry_run_path,
        verification_path,
        cast(str, manifest["plan_digest"]),
    )

    assert [operation for operation, _ in api.batch_calls] == [
        "add",
        "add",
        "delete",
    ]
    assert len(api.batch_calls[0][1]) == 2
    assert len(api.batch_calls[1][1]) == 1
    assert len(api.batch_calls[2][1]) == 3
    assert verification["status"] == "verified"
    assert verification["final_count"] == 5
    assert verification["final_inventory_digest"] == manifest["target_inventory_digest"]
    assert _record_path(fixture.model) in api.contents
    assert api.contents[_record_path(fixture.model)] == fixture.model_raw
    assert all(
        source_path not in api.contents
        for source_path in (
            _record_path(fixture.capacity),
            _record_path(fixture.deployment),
        )
    )
    verification_text = verification_path.read_text(encoding="utf-8")
    assert _BUCKET_ID not in verification_text
    assert "capacity-one" not in verification_text


def test_apply_requires_all_confirmation_inputs(tmp_path: Path) -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    dry_run_path = tmp_path / "dry-run.json"
    manifest = run_dry_run(
        api=api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=dry_run_path,
        clock=_clock(),
    )
    plan_digest = cast(str, manifest["plan_digest"])
    verification_path = tmp_path / "verification.json"

    with pytest.raises(ConfirmationError, match="--yes"):
        _apply(
            api,
            dry_run_path,
            verification_path,
            plan_digest,
            confirmed=False,
        )
    with pytest.raises(ConfirmationError, match="valid --expected-plan-digest"):
        _apply(api, dry_run_path, verification_path, None)
    with pytest.raises(ConfirmationError, match="--dry-run-manifest"):
        apply_migration(
            api=api,
            bucket_id=_BUCKET_ID,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            confirmed=True,
            expected_plan_digest=plan_digest,
            dry_run_manifest_path=None,
            verification_manifest_path=verification_path,
            clock=_clock(),
        )
    with pytest.raises(ConfirmationError, match="does not match"):
        _apply(
            api,
            dry_run_path,
            verification_path,
            f"sha256:{'0' * 64}",
        )
    with pytest.raises(ConfirmationError, match="runtime inputs"):
        _apply(
            api,
            dry_run_path,
            verification_path,
            plan_digest,
            worker_revision="6" * 40,
        )
    with pytest.raises(ConfirmationError, match="destination Bucket"):
        apply_migration(
            api=api,
            bucket_id="example-org/other-bucket",
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            confirmed=True,
            expected_plan_digest=plan_digest,
            dry_run_manifest_path=dry_run_path,
            verification_manifest_path=verification_path,
            clock=_clock(),
        )
    assert api.batch_calls == []


def test_snapshot_and_apply_reject_concurrent_changes(tmp_path: Path) -> None:
    first_fixture = _source_fixture()
    changing_api = FakeHfApi(first_fixture.contents)
    changing_api.list_mutations[2] = lambda: _add_current_model(
        changing_api, "concurrent-one"
    )
    with pytest.raises(StaleInventoryError, match="during download"):
        read_profile_snapshot(changing_api, _BUCKET_ID)

    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    dry_run_path = tmp_path / "dry-run.json"
    manifest = run_dry_run(
        api=api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=dry_run_path,
        clock=_clock(),
    )
    api.list_calls = 0
    api.list_mutations[3] = lambda: _add_current_model(api, "concurrent-two")
    with pytest.raises(StaleInventoryError, match="immediately before mutation"):
        _apply(
            api,
            dry_run_path,
            tmp_path / "verification.json",
            cast(str, manifest["plan_digest"]),
        )
    assert api.batch_calls == []


def test_apply_resumes_after_partial_add_and_delete(tmp_path: Path) -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    dry_run_path = tmp_path / "dry-run.json"
    manifest = run_dry_run(
        api=api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=dry_run_path,
        clock=_clock(),
    )
    plan_digest = cast(str, manifest["plan_digest"])
    verification_path = tmp_path / "verification.json"
    api.partial_add_once = 1
    with pytest.raises(ResumableApplyError, match="add phase"):
        _apply(api, dry_run_path, verification_path, plan_digest)
    assert [operation for operation, _ in api.batch_calls] == ["add"]

    api.partial_delete_once = 1
    with pytest.raises(ResumableApplyError, match="delete phase"):
        _apply(api, dry_run_path, verification_path, plan_digest)
    assert [operation for operation, _ in api.batch_calls] == [
        "add",
        "add",
        "add",
        "delete",
    ]

    verification = _apply(api, dry_run_path, verification_path, plan_digest)
    assert verification["status"] == "verified"
    assert [operation for operation, _ in api.batch_calls] == [
        "add",
        "add",
        "add",
        "delete",
        "delete",
    ]
    completed_calls = list(api.batch_calls)
    assert _apply(api, dry_run_path, verification_path, plan_digest)["status"] == (
        "verified"
    )
    assert api.batch_calls == completed_calls


def test_apply_fails_verification_if_delete_does_not_land(tmp_path: Path) -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    dry_run_path = tmp_path / "dry-run.json"
    manifest = run_dry_run(
        api=api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=dry_run_path,
        clock=_clock(),
    )
    api.skip_deletes = True

    with pytest.raises(VerificationError, match="superseded records remain"):
        _apply(
            api,
            dry_run_path,
            tmp_path / "verification.json",
            cast(str, manifest["plan_digest"]),
        )


def test_apply_fails_verification_if_add_does_not_land(tmp_path: Path) -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    dry_run_path = tmp_path / "dry-run.json"
    manifest = run_dry_run(
        api=api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=dry_run_path,
        clock=_clock(),
    )
    api.skip_adds = True

    with pytest.raises(VerificationError, match="not fully verified"):
        _apply(
            api,
            dry_run_path,
            tmp_path / "verification.json",
            cast(str, manifest["plan_digest"]),
        )
    assert [operation for operation, _ in api.batch_calls] == ["add"]


def test_malformed_records_and_manifest_fail_closed(tmp_path: Path) -> None:
    bad_id = _profile("capacity", "capacity-one", _legacy_capacity_spec())
    bad_id["record_id"] = "profile-wrong"
    api = FakeHfApi({_record_path(bad_id): _pretty_bytes(bad_id)})
    snapshot = read_profile_snapshot(api, _BUCKET_ID)
    with pytest.raises(RecordShapeError, match="content-derived"):
        build_migration_plan(
            snapshot,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            created_at=_CREATED_AT,
        )

    unknown_spec = _legacy_capacity_spec()
    unknown_spec["unknown"] = True
    unknown_profile = _profile("capacity", "capacity-two", unknown_spec)
    api = FakeHfApi({_record_path(unknown_profile): _pretty_bytes(unknown_profile)})
    snapshot = read_profile_snapshot(api, _BUCKET_ID)
    with pytest.raises(RecordShapeError, match="unknown legacy shape"):
        build_migration_plan(
            snapshot,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            created_at=_CREATED_AT,
        )

    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    manifest_path = tmp_path / "dry-run.json"
    run_dry_run(
        api=api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=manifest_path,
        clock=_clock(),
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["add_count"] += 1
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ManifestError, match="plan digest"):
        read_manifest(manifest_path)


def test_promotion_must_reference_an_available_matching_profile() -> None:
    fixture = _source_fixture()
    records = dict(fixture.contents)
    capacity_promotion_path = next(
        path for path in records if "/promotions/capacity/" in path
    )
    promotion = cast(JsonObject, json.loads(records[capacity_promotion_path].decode()))
    promotion["profile_id"] = f"sha256:{'9' * 64}"
    records[capacity_promotion_path] = _pretty_bytes(promotion)
    api = FakeHfApi(records)
    snapshot = read_profile_snapshot(api, _BUCKET_ID)

    with pytest.raises(RecordShapeError, match="unavailable profile"):
        build_migration_plan(
            snapshot,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            created_at=_CREATED_AT,
        )


def test_operator_cli_runs_dry_run_and_apply_with_explicit_confirmation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    monkeypatch.setattr(migration_module, "HfApi", lambda: api)
    dry_run_path = tmp_path / "dry-run.json"
    verification_path = tmp_path / "verification.json"
    common = [
        "--bucket",
        _BUCKET_ID,
        "--job-image",
        _JOB_IMAGE,
        "--worker-revision",
        _WORKER_REVISION,
    ]

    assert main([*common, "--manifest", str(dry_run_path)]) == 0
    plan_digest = read_manifest(dry_run_path).plan_digest
    assert (
        main(
            [
                *common,
                "--apply",
                "--yes",
                "--expected-plan-digest",
                plan_digest,
                "--dry-run-manifest",
                str(dry_run_path),
                "--verification-manifest",
                str(verification_path),
            ]
        )
        == 0
    )
    assert verification_path.is_file()


def test_operator_cli_rejects_apply_only_flags_in_dry_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)
    monkeypatch.setattr(migration_module, "HfApi", lambda: api)

    assert (
        main(
            [
                "--bucket",
                _BUCKET_ID,
                "--job-image",
                _JOB_IMAGE,
                "--worker-revision",
                _WORKER_REVISION,
                "--yes",
            ]
        )
        == 1
    )
    assert api.batch_calls == []


@pytest.mark.parametrize(
    ("raw", "match"),
    [
        (b"{", "malformed JSON"),
        (b"[]", "must be a JSON object"),
        (b'{"value":NaN}', "non-finite number"),
        (b'{"value":9007199254740992}', "not JSON-safe"),
        (b'{"record_id":"record-one"}', "kind is missing"),
        (b'{"kind":"unsupported"}', "unsupported record kind"),
        (
            b'{"kind":"profile.object","record_id":"profile-one"}',
            "profile object fields",
        ),
        (
            b'{"kind":"profile.promotion","record_id":"promotion-one"}',
            "promotion fields",
        ),
    ],
)
def test_snapshot_rejects_malformed_record_content(raw: bytes, match: str) -> None:
    path = f"{PROFILE_PREFIX}objects/model/profile-one.json"
    api = FakeHfApi({path: raw})

    with pytest.raises(RecordShapeError, match=match):
        read_profile_snapshot(api, _BUCKET_ID)


def test_snapshot_rejects_invalid_identity_and_path() -> None:
    invalid_id = _profile(
        "model",
        "model-one",
        {"model_id": "example/model", "revision": "revision-one"},
    )
    invalid_id["record_id"] = "INVALID"
    invalid_path = f"{PROFILE_PREFIX}objects/model/INVALID.json"
    with pytest.raises(RecordShapeError, match="identifier"):
        read_profile_snapshot(
            FakeHfApi({invalid_path: _pretty_bytes(invalid_id)}),
            _BUCKET_ID,
        )

    valid = _profile(
        "model",
        "model-two",
        {"model_id": "example/model-two", "revision": "revision-two"},
    )
    wrong_path = f"{PROFILE_PREFIX}objects/model/profile-wrong.json"
    with pytest.raises(RecordShapeError, match="path does not match"):
        read_profile_snapshot(
            FakeHfApi({wrong_path: _pretty_bytes(valid)}),
            _BUCKET_ID,
        )


def test_snapshot_rejects_listing_failures_and_invalid_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api = FakeHfApi({})

    def fail_listing(*_args: object, **_kwargs: object) -> Iterable[object]:
        raise ValueError("failed")

    monkeypatch.setattr(api, "list_bucket_tree", fail_listing)
    with pytest.raises(InventoryError, match="listing failed"):
        read_profile_snapshot(api, _BUCKET_ID)

    invalid_api = FakeHfApi({})

    def invalid_listing(*_args: object, **_kwargs: object) -> Iterable[object]:
        return [SimpleNamespace(type="link")]

    monkeypatch.setattr(invalid_api, "list_bucket_tree", invalid_listing)
    with pytest.raises(InventoryError, match="unknown entry type"):
        read_profile_snapshot(invalid_api, _BUCKET_ID)

    metadata_path = f"{PROFILE_PREFIX}bad.json"
    metadata_api = FakeHfApi({metadata_path: b"{}"})

    def invalid_metadata(*_args: object, **_kwargs: object) -> Iterable[object]:
        return [
            BucketFile(
                type="file",
                path=metadata_path,
                size=-1,
                xetHash="invalid",
                mtime=None,
                uploadedAt=None,
            )
        ]

    monkeypatch.setattr(metadata_api, "get_bucket_paths_info", invalid_metadata)
    with pytest.raises(InventoryError, match="metadata lookup returned invalid"):
        read_profile_snapshot(metadata_api, _BUCKET_ID)

    directory_api = FakeHfApi({})

    def directory_listing(*_args: object, **_kwargs: object) -> Iterable[object]:
        return [SimpleNamespace(type="directory")]

    monkeypatch.setattr(directory_api, "list_bucket_tree", directory_listing)
    assert read_profile_snapshot(directory_api, _BUCKET_ID).records == ()


def test_snapshot_wraps_download_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = _source_fixture()
    api = FakeHfApi(fixture.contents)

    def fail_download(*_args: object, **_kwargs: object) -> None:
        raise OSError("failed")

    monkeypatch.setattr(api, "download_bucket_files", fail_download)
    with pytest.raises(InventoryError, match="download failed"):
        read_profile_snapshot(api, _BUCKET_ID)


def test_canonical_encoder_failures_are_wrapped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def cannot_start(*_args: object, **_kwargs: object) -> None:
        raise OSError("missing")

    monkeypatch.setattr(migration_module.subprocess, "run", cannot_start)
    with pytest.raises(ProfileMigrationError, match="could not start"):
        canonical_bytes({"value": 1})

    monkeypatch.setattr(
        migration_module.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=1, stdout=b""),
    )
    with pytest.raises(ProfileMigrationError, match="encoder failed"):
        canonical_bytes({"value": 1})

    monkeypatch.setattr(
        migration_module.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout=b"{}"),
    )
    with pytest.raises(ProfileMigrationError, match="invalid data"):
        canonical_bytes({"value": 1})

    monkeypatch.setattr(
        migration_module.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout=b"[]"),
    )
    with pytest.raises(ProfileMigrationError, match="wrong count"):
        canonical_bytes({"value": 1})


def test_legacy_profile_validation_rejects_unrecognized_or_invalid_shapes() -> None:
    def require_rejection(profile: JsonObject, match: str) -> None:
        api = FakeHfApi({_record_path(profile): _pretty_bytes(profile)})
        snapshot = read_profile_snapshot(api, _BUCKET_ID)
        with pytest.raises(RecordShapeError, match=match):
            build_migration_plan(
                snapshot,
                job_image=_JOB_IMAGE,
                worker_revision=_WORKER_REVISION,
                created_at=_CREATED_AT,
            )

    require_rejection(
        _profile("model", "invalid-model", {"unknown": True}),
        "unknown legacy shape",
    )

    capacity_spec = _legacy_capacity_spec()
    limits = cast(list[JsonValue], capacity_spec["hardware_limits"])
    limit = cast(JsonObject, limits[0])
    limit["unknown"] = True
    require_rejection(
        _profile("capacity", "invalid-capacity-limit", capacity_spec),
        "hardware limit",
    )

    excessive_capacity = _legacy_capacity_spec()
    excessive_capacity["max_active_sandboxes"] = 2_048
    require_rejection(
        _profile("capacity", "invalid-capacity-value", excessive_capacity),
        "violates the current control schema",
    )

    missing_worker = _legacy_deployment_spec()
    del missing_worker["worker_concurrency"]
    require_rejection(
        _profile("deployment", "missing-worker", missing_worker),
        "worker limits are missing",
    )

    invalid_worker = _legacy_deployment_spec()
    invalid_worker["worker_concurrency"] = 0
    require_rejection(
        _profile("deployment", "invalid-worker", invalid_worker),
        "positive integer",
    )

    invalid_idle = _legacy_deployment_spec()
    invalid_idle_template = cast(JsonObject, invalid_idle["sandbox_template"])
    invalid_idle_template["idle_timeout_overhead_seconds"] = -1
    require_rejection(
        _profile("deployment", "invalid-idle", invalid_idle),
        "idle timeout overhead",
    )

    invalid_roots = _legacy_deployment_spec()
    invalid_roots_template = cast(JsonObject, invalid_roots["sandbox_template"])
    invalid_roots_template["allowed_roots"] = []
    require_rejection(
        _profile("deployment", "invalid-roots", invalid_roots),
        "allowed roots",
    )


def test_known_remap_validation_rejects_conflicts() -> None:
    fixture = _source_fixture()
    snapshot = read_profile_snapshot(FakeHfApi(fixture.contents), _BUCKET_ID)
    plan = build_migration_plan(
        snapshot,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        created_at=_CREATED_AT,
    )
    remap = plan.remaps[0]

    with pytest.raises(ManifestError, match="duplicate sources"):
        build_migration_plan(
            snapshot,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            created_at=_CREATED_AT,
            known_remaps=(remap, remap),
        )
    with pytest.raises(ManifestError, match="does not change"):
        build_migration_plan(
            snapshot,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            created_at=_CREATED_AT,
            known_remaps=(
                ProfileDigestRemap(
                    profile_kind=remap.profile_kind,
                    source=remap.source,
                    target=remap.source,
                ),
            ),
        )
    with pytest.raises(ManifestError, match="unsupported kind"):
        build_migration_plan(
            snapshot,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            created_at=_CREATED_AT,
            known_remaps=(
                ProfileDigestRemap(
                    profile_kind="model",
                    source=remap.source,
                    target=remap.target,
                ),
            ),
        )
    with pytest.raises(StaleInventoryError, match="remap changed"):
        build_migration_plan(
            snapshot,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            created_at=_CREATED_AT,
            known_remaps=(
                ProfileDigestRemap(
                    profile_kind=remap.profile_kind,
                    source=remap.source,
                    target=f"sha256:{'8' * 64}",
                ),
            ),
        )


def test_manifest_semantic_validation_rejects_tampering(tmp_path: Path) -> None:
    fixture = _source_fixture()
    path = tmp_path / "dry-run.json"
    run_dry_run(
        api=FakeHfApi(fixture.contents),
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=path,
        clock=_clock(),
    )
    base = cast(JsonObject, json.loads(path.read_text(encoding="utf-8")))

    def reject(
        changes: JsonObject,
        match: str,
        index: int,
    ) -> None:
        candidate = cast(JsonObject, json.loads(json.dumps(base)))
        candidate.update(changes)
        _resign_manifest(candidate)
        candidate_path = tmp_path / f"invalid-{index}.json"
        candidate_path.write_text(json.dumps(candidate), encoding="utf-8")
        with pytest.raises((ManifestError, RecordShapeError), match=match):
            read_manifest(candidate_path)

    reject({"extra": True}, "fields do not match", 1)
    reject({"mode": "verification"}, "version or mode", 2)
    reject({"add_count": -1}, "count is invalid", 3)
    source_digests = cast(list[str], base["source_content_digests"])
    reject(
        {"source_content_digests": cast(JsonValue, list(reversed(source_digests)))},
        "not unique and sorted",
        4,
    )
    reject(
        {"profile_digest_remaps": [{"profile_kind": "capacity"}]},
        "remap is malformed",
        5,
    )

    remaps = cast(list[JsonObject], base["profile_digest_remaps"])
    duplicate_first = dict(remaps[0])
    duplicate_second = dict(remaps[1])
    duplicate_second["source"] = duplicate_first["source"]
    duplicate_targets: list[JsonValue] = [duplicate_first, duplicate_second]
    reject(
        {"profile_digest_remaps": duplicate_targets},
        "remap sources are not unique",
        6,
    )
    invalid_first = dict(remaps[0])
    invalid_second = dict(remaps[1])
    invalid_first["profile_kind"] = "model"
    invalid_kind: list[JsonValue] = [invalid_first, invalid_second]
    reject(
        {"profile_digest_remaps": invalid_kind},
        "remap kind is invalid",
        7,
    )
    reject({"profile_count": 99}, "operation counts", 8)

    transformed = cast(list[JsonValue], base["transformed_source_content_digests"])
    unknown_transformed = sorted(
        sha256(f"unknown-{index}".encode()) for index in range(len(transformed))
    )
    reject(
        {"transformed_source_content_digests": cast(JsonValue, unknown_transformed)},
        "transformed identities",
        9,
    )

    source = list(cast(list[JsonValue], base["source_content_digests"]))
    targets = cast(list[JsonValue], base["target_content_digests"])
    colliding_transformed = list(transformed)
    source[0] = targets[0]
    colliding_transformed[0] = targets[0]
    reject(
        {
            "source_content_digests": sorted(source),
            "transformed_source_content_digests": sorted(colliding_transformed),
        },
        "source and target identities collide",
        10,
    )


def test_batch_bound_and_runtime_inputs_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    with pytest.raises(ConfirmationError, match="single-batch bound"):
        migration_module._require_batch_bound(1_001)
    with pytest.raises(ConfirmationError, match="job image"):
        migration_module._validate_runtime_inputs("latest", _WORKER_REVISION)
    with pytest.raises(ConfirmationError, match="worker revision"):
        migration_module._validate_runtime_inputs(_JOB_IMAGE, "main")

    fixture = _source_fixture()
    dry_run_path = tmp_path / "dry-run.json"
    source_api = FakeHfApi(fixture.contents)
    raw_manifest = run_dry_run(
        api=source_api,
        bucket_id=_BUCKET_ID,
        job_image=_JOB_IMAGE,
        worker_revision=_WORKER_REVISION,
        manifest_path=dry_run_path,
        clock=_clock(),
    )
    oversized = replace(read_manifest(dry_run_path), add_count=1_001)
    monkeypatch.setattr(
        migration_module,
        "read_manifest",
        lambda _path: oversized,
    )
    apply_api = FakeHfApi(fixture.contents)
    with pytest.raises(ConfirmationError, match="single-batch bound"):
        apply_migration(
            api=apply_api,
            bucket_id=_BUCKET_ID,
            job_image=_JOB_IMAGE,
            worker_revision=_WORKER_REVISION,
            confirmed=True,
            expected_plan_digest=cast(str, raw_manifest["plan_digest"]),
            dry_run_manifest_path=dry_run_path,
            verification_manifest_path=tmp_path / "verification.json",
            clock=_clock(),
        )
    assert apply_api.list_calls == 0
    assert apply_api.batch_calls == []
    with pytest.raises(ManifestError, match="timestamp is invalid"):
        migration_module._parse_utc_timestamp("not-a-time")
    with pytest.raises(ManifestError, match="must use UTC"):
        migration_module._parse_utc_timestamp("2026-08-24T12:00:00")
    with pytest.raises(ManifestError, match="clock must return"):
        migration_module._utc_timestamp(datetime(2026, 8, 24, 12, 0))

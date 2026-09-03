from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import math
import re
import subprocess
from collections.abc import Iterable, Sequence
from contextlib import suppress
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from datetime import UTC, datetime, timedelta
from functools import cache
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Protocol, cast

import httpx
from huggingface_hub import BucketFile, BucketFolder, HfApi
from huggingface_hub.errors import HfHubHTTPError
from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.protocols import Validator

LOGGER = logging.getLogger(__name__)

PROFILE_PREFIX = "control/schema=v1/profiles/"
SCHEMA_VERSION = "harbor-hf/run-native-profile-migration/v2"
DEFAULT_DRY_RUN_MANIFEST = Path("run-native-profile-migration-dry-run.json")
DEFAULT_VERIFICATION_MANIFEST = Path("run-native-profile-migration-verification.json")
MAX_BATCH_OPERATIONS = 1000
MAX_IMAGE_BYTES = 20 * 1024**3
MAX_IMAGE_ENTRIES = 500_000
PREPARATION_COMMAND = (
    "python",
    "-m",
    "harbor_hf_agents.support.control_prepare_worker",
)
TRIAL_COMMAND = (
    "python",
    "-m",
    "harbor_hf_agents.support.control_trial_job_worker",
)

_DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_JOB_IMAGE_PATTERN = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
_REVISION_PATTERN = re.compile(r"^[0-9a-f]{40}$")
_XET_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")

type JsonValue = (
    None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]
)
type JsonObject = dict[str, JsonValue]
type Clock = datetime


class ProfileMigrationError(RuntimeError):
    """Base exception for rejected or failed profile migrations."""


class InventoryError(ProfileMigrationError):
    """Raised when the exact profile-prefix inventory cannot be trusted."""


class RecordShapeError(ProfileMigrationError):
    """Raised when a profile-prefix object has an unknown or malformed shape."""


class ManifestError(ProfileMigrationError):
    """Raised when a local migration manifest is malformed."""


class ConfirmationError(ProfileMigrationError):
    """Raised when apply confirmation or its expected digest is incomplete."""


class StaleInventoryError(ProfileMigrationError):
    """Raised when current Bucket contents differ from the reviewed plan."""


class ResumableApplyError(ProfileMigrationError):
    """Raised after a safe partial operation that the same apply can resume."""


class VerificationError(ProfileMigrationError):
    """Raised when the final profile inventory does not match the plan."""


class BucketProfileApi(Protocol):
    """Installed huggingface_hub methods used by the operator migration."""

    def list_bucket_tree(
        self,
        bucket_id: str,
        prefix: str | None = None,
        *,
        recursive: bool | None = None,
        token: str | bool | None = None,
    ) -> Iterable[BucketFile | BucketFolder]: ...

    def download_bucket_files(
        self,
        bucket_id: str,
        files: list[tuple[str | BucketFile, str | Path]],
        *,
        raise_on_missing_files: bool = False,
        token: str | bool | None = None,
    ) -> None: ...

    def get_bucket_paths_info(
        self,
        bucket_id: str,
        paths: Iterable[str],
        *,
        token: str | bool | None = None,
    ) -> Iterable[BucketFile]: ...

    def batch_bucket_files(
        self,
        bucket_id: str,
        *,
        add: list[tuple[str | Path | bytes, str]] | None = None,
        copy: list[tuple[str, str, str, str]] | None = None,
        delete: list[str] | None = None,
        token: str | bool | None = None,
    ) -> None: ...


@dataclass(frozen=True, order=True)
class BucketEntry:
    """Stable metadata for one file under the profile prefix."""

    key: str
    size: int
    xet_hash: str
    remote: BucketFile = dataclass_field(compare=False, repr=False)


@dataclass(frozen=True)
class StoredRecord:
    """One downloaded and parsed profile-prefix record."""

    entry: BucketEntry
    raw: bytes
    value: JsonObject
    canonical: bytes
    content_digest: str


@dataclass(frozen=True)
class ProfileSnapshot:
    """One stable download of the complete profile-prefix inventory."""

    entries: tuple[BucketEntry, ...]
    records: tuple[StoredRecord, ...]
    inventory_digest: str


@dataclass(frozen=True, order=True)
class ProfileDigestRemap:
    """Opaque profile digest replacement used by promotion migration."""

    profile_kind: str
    source: str
    target: str


@dataclass(frozen=True)
class PlannedRecord:
    """One exact record expected in the final profile inventory."""

    key: str
    raw: bytes
    value: JsonObject
    content_digest: str


@dataclass(frozen=True)
class MigrationPlan:
    """Complete deterministic transformation of one observed inventory."""

    source: ProfileSnapshot
    target: tuple[PlannedRecord, ...]
    transformed_sources: tuple[StoredRecord, ...]
    remaps: tuple[ProfileDigestRemap, ...]
    job_image: str
    worker_revision: str
    transformed_capacity_count: int
    transformed_deployment_count: int
    transformed_launch_policy_count: int
    transformed_promotion_count: int

    @property
    def target_inventory_digest(self) -> str:
        """Return the exact path, size, and content digest identity."""
        return _inventory_digest(
            (item.key, len(item.raw), item.content_digest) for item in self.target
        )

    @property
    def target_content_digests(self) -> tuple[str, ...]:
        """Return sorted opaque content identities for all final records."""
        return tuple(sorted(item.content_digest for item in self.target))


@dataclass(frozen=True)
class _PendingProfile:
    record: StoredRecord
    transformed_spec: JsonObject
    source_profile_id: str


@dataclass(frozen=True)
class _ProfilePlan:
    target: tuple[PlannedRecord, ...]
    transformed_sources: tuple[StoredRecord, ...]
    remaps: dict[str, ProfileDigestRemap]
    profile_kind_by_id: dict[str, str]
    capacity_count: int
    deployment_count: int
    launch_policy_count: int


@dataclass(frozen=True)
class DryRunManifest:
    """Validated local plan used to authorize an apply or safe resume."""

    created_at: str
    bucket_identity_digest: str
    job_image: str
    worker_revision: str
    profile_count: int
    promotion_count: int
    transformed_capacity_count: int
    transformed_deployment_count: int
    transformed_launch_policy_count: int
    transformed_promotion_count: int
    add_count: int
    delete_count: int
    source_inventory_digest: str
    target_inventory_digest: str
    source_content_digests: tuple[str, ...]
    target_content_digests: tuple[str, ...]
    transformed_source_content_digests: tuple[str, ...]
    profile_digest_remaps: tuple[ProfileDigestRemap, ...]
    plan_digest: str


_PROFILE_FIELDS = {
    "schema_version",
    "kind",
    "record_id",
    "created_at",
    "actor",
    "profile_kind",
    "name",
    "spec",
}
_PROMOTION_FIELDS = {
    "schema_version",
    "kind",
    "record_id",
    "created_at",
    "actor",
    "profile_kind",
    "alias",
    "profile_id",
    "promotion_state",
    "reason",
    "evidence",
}
_LEGACY_CAPACITY_FIELDS = {
    "namespace",
    "max_active_sandboxes",
    "hardware_limits",
    "start_burst",
    "start_refill_tokens",
    "start_refill_period_seconds",
}
_LEGACY_DEPLOYMENT_FIELDS = {
    "route",
    "models",
    "harnesses",
    "job_image",
    "job_command",
    "hardware",
    "active_hourly_cost_microusd",
    "timeout_seconds",
    "trusted_worker",
    "inference_token",
    "inference_upstream",
    "inference_model",
    "inference_api",
    "inference_max_requests",
    "inference_max_concurrency",
    "inference_timeout_seconds",
    "inference_max_output_tokens",
    "inference_provider",
    "input_price_microusd_per_million_tokens",
    "output_price_microusd_per_million_tokens",
    "harbor_version",
    "worker_revision",
    "worker_concurrency",
    "worker_max_tasks_per_job",
    "context_window",
    "preparation",
    "preparation_job_command",
    "preparation_timeout_seconds",
    "sandbox_template",
}
_LEGACY_DEPLOYMENT_REQUIRED_FIELDS = {
    "route",
    "models",
    "harnesses",
    "job_image",
    "job_command",
    "hardware",
    "timeout_seconds",
    "trusted_worker",
    "sandbox_template",
}
_LEGACY_SANDBOX_DELEGATING_REQUIRED_FIELDS = {
    "route",
    "models",
    "harnesses",
    "job_image",
    "job_command",
    "hardware",
    "timeout_seconds",
    "trusted_worker",
    "inference_token",
    "sandbox",
}
_LEGACY_SANDBOX_DELEGATING_OPTIONAL_FIELDS = {
    "active_hourly_cost_microusd",
}
_LEGACY_SINGLE_SANDBOX_FIELDS = {
    "image",
    "hardware",
    "timeout_seconds",
    "idle_timeout_seconds",
    "max_sandboxes",
    "max_commands",
    "max_command_seconds",
    "max_transfer_bytes",
    "allowed_roots",
    "reservation_microusd",
    "active_hourly_cost_microusd",
    "inference_token",
}
_LEGACY_LAUNCH_POLICY_REQUIRED_FIELDS = {
    "max_infrastructure_attempts",
    "reservation_microusd",
    "success_without_worker_receipt",
    "publication_role",
    "max_campaign_ceiling_microusd",
}
_LEGACY_LAUNCH_POLICY_OPTIONAL_FIELDS = {
    "preparation_reservation_microusd",
    "max_preparation_attempts",
    "required_positive_metrics",
}
_LEGACY_SANDBOX_REQUIRED_FIELDS = {
    "flavors",
    "max_sandboxes",
    "max_commands",
    "max_command_seconds",
    "max_transfer_bytes",
    "allowed_roots",
    "default_cpus",
    "default_memory_mb",
    "default_storage_mb",
    "default_gpus",
    "max_timeout_seconds",
    "lifetime_overhead_seconds",
    "idle_timeout_overhead_seconds",
}
_LEGACY_SANDBOX_OPTIONAL_FIELDS = {
    "inference_token",
    "inference_upstream",
    "inference_model",
    "inference_api",
    "inference_max_requests",
    "inference_max_concurrency",
    "inference_max_total_concurrency",
    "inference_timeout_seconds",
    "inference_max_output_tokens",
    "root_bootstrap_command",
}
_TRIAL_TEMPLATE_PRESERVED_FIELDS = (
    "flavors",
    "inference_upstream",
    "inference_api",
    "inference_timeout_seconds",
    "inference_max_output_tokens",
    "default_cpus",
    "default_memory_mb",
    "default_storage_mb",
    "default_gpus",
    "max_timeout_seconds",
    "lifetime_overhead_seconds",
)
_RETIRED_DEPLOYMENT_INFERENCE_FIELDS = (
    "inference_token",
    "inference_model",
    "inference_max_requests",
    "inference_max_concurrency",
)


def sha256(value: bytes) -> str:
    """Return the repository's tagged SHA-256 representation."""
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _bucket_identity_digest(bucket_id: str) -> str:
    if (
        not bucket_id
        or bucket_id.strip() != bucket_id
        or any(character in bucket_id for character in ("\n", "\r", "\0"))
    ):
        raise ConfirmationError("destination Bucket identifier is invalid")
    return sha256(bucket_id.encode())


def deterministic_id(prefix: str, *parts: str) -> str:
    """Match TypeScript deterministicId for string parts exactly."""
    digest = hashlib.sha256("\0".join(parts).encode()).hexdigest()[:24]
    return f"{prefix}-{digest}"


def canonical_bytes_many(values: Sequence[JsonValue]) -> tuple[bytes, ...]:
    """Encode values with the authoritative TypeScript canonical JSON module."""
    repository = Path(__file__).resolve().parents[2]
    script = repository / "scripts" / "control-service" / "canonical-json.mjs"
    if not script.is_file():
        raise ProfileMigrationError("authoritative canonical JSON encoder is missing")
    request = json.dumps(
        {"values": values},
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode()
    try:
        completed = subprocess.run(
            ["node", str(script)],
            cwd=repository,
            input=request,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise ProfileMigrationError(
            "authoritative canonical JSON encoder could not start"
        ) from error
    if completed.returncode != 0:
        raise ProfileMigrationError("authoritative canonical JSON encoder failed")
    try:
        encoded: object = json.loads(completed.stdout)
        if not isinstance(encoded, list) or not all(
            isinstance(item, str) for item in encoded
        ):
            raise ValueError
        output = tuple(
            base64.b64decode(cast(str, item), validate=True) for item in encoded
        )
    except (ValueError, json.JSONDecodeError) as error:
        raise ProfileMigrationError(
            "authoritative canonical JSON encoder returned invalid data"
        ) from error
    if len(output) != len(values):
        raise ProfileMigrationError(
            "authoritative canonical JSON encoder returned the wrong count"
        )
    return output


def canonical_bytes(value: JsonValue) -> bytes:
    """Encode one value with the authoritative TypeScript implementation."""
    return canonical_bytes_many((value,))[0]


def read_profile_snapshot(
    api: BucketProfileApi,
    bucket_id: str,
) -> ProfileSnapshot:
    """Download exactly the profile prefix and prove its listing stayed stable."""
    before = _list_entries(api, bucket_id)
    with TemporaryDirectory(prefix="harbor-hf-profile-migration-") as directory:
        root = Path(directory)
        destinations = tuple(root / str(index) for index in range(len(before)))
        try:
            # BucketFile bypasses path re-resolution and binds each download to
            # the exact immutable Xet identity returned by paths-info.
            api.download_bucket_files(
                bucket_id,
                [
                    (entry.remote, destination)
                    for entry, destination in zip(before, destinations, strict=True)
                ],
                raise_on_missing_files=True,
            )
        except (ValueError, OSError, HfHubHTTPError, httpx.TransportError) as error:
            raise InventoryError(
                "complete profile inventory download failed"
            ) from error
        raw_values: list[bytes] = []
        values: list[JsonObject] = []
        for entry, destination in zip(before, destinations, strict=True):
            try:
                raw = destination.read_bytes()
            except OSError as error:
                raise InventoryError(
                    "downloaded profile inventory is unreadable"
                ) from error
            if len(raw) != entry.size:
                raise StaleInventoryError("downloaded profile object size changed")
            raw_values.append(raw)
            values.append(_parse_json_object(raw))
    after = _list_entries(api, bucket_id)
    if before != after:
        raise StaleInventoryError("profile inventory changed during download")
    canonicals = canonical_bytes_many(values)
    records = tuple(
        _stored_record(entry, raw, value, canonical)
        for entry, raw, value, canonical in zip(
            before, raw_values, values, canonicals, strict=True
        )
    )
    return ProfileSnapshot(
        entries=before,
        records=records,
        inventory_digest=_inventory_digest(
            (record.entry.key, record.entry.size, record.content_digest)
            for record in records
        ),
    )


def build_migration_plan(
    snapshot: ProfileSnapshot,
    *,
    job_image: str,
    worker_revision: str,
    created_at: str,
    known_remaps: Sequence[ProfileDigestRemap] = (),
) -> MigrationPlan:
    """Transform only recognized legacy capacity and deployment records."""
    _validate_runtime_inputs(job_image, worker_revision)
    _parse_utc_timestamp(created_at)
    profiles = [
        record
        for record in snapshot.records
        if record.value["kind"] == "profile.object"
    ]
    promotions = [
        record
        for record in snapshot.records
        if record.value["kind"] == "profile.promotion"
    ]
    profile_plan = _plan_profiles(
        profiles,
        job_image=job_image,
        worker_revision=worker_revision,
        known_remaps=known_remaps,
    )
    promotion_target, promotion_sources, promotion_count = _plan_promotions(
        promotions,
        remaps=profile_plan.remaps,
        profile_kind_by_id=profile_plan.profile_kind_by_id,
        created_at=created_at,
    )
    target = [*profile_plan.target, *promotion_target]
    transformed_sources = [
        *profile_plan.transformed_sources,
        *promotion_sources,
    ]
    planned_target = _unique_target(target)
    transformed_digests = {item.content_digest for item in transformed_sources}
    target_digests = {item.content_digest for item in planned_target}
    if transformed_digests & target_digests:
        raise RecordShapeError("source and target content identities collide")
    return MigrationPlan(
        source=snapshot,
        target=planned_target,
        transformed_sources=tuple(transformed_sources),
        remaps=tuple(sorted(profile_plan.remaps.values())),
        job_image=job_image,
        worker_revision=worker_revision,
        transformed_capacity_count=profile_plan.capacity_count,
        transformed_deployment_count=profile_plan.deployment_count,
        transformed_launch_policy_count=profile_plan.launch_policy_count,
        transformed_promotion_count=promotion_count,
    )


def _plan_profiles(
    profiles: Sequence[StoredRecord],
    *,
    job_image: str,
    worker_revision: str,
    known_remaps: Sequence[ProfileDigestRemap],
) -> _ProfilePlan:
    spec_bytes = canonical_bytes_many(
        [_object(record.value["spec"]) for record in profiles]
    )
    target: list[PlannedRecord] = []
    pending: list[_PendingProfile] = []
    profile_kind_by_id: dict[str, str] = {}
    capacity_count = 0
    deployment_count = 0
    launch_policy_count = 0
    for record, encoded_spec in zip(profiles, spec_bytes, strict=True):
        _require_content_derived_profile_id(record.value, encoded_spec)
        profile_kind = _string(record.value["profile_kind"])
        source_profile_id = sha256(record.canonical)
        if _is_current_record(record.value):
            target.append(_unchanged_record(record))
            profile_kind_by_id[source_profile_id] = profile_kind
            continue
        transformed_spec = _legacy_profile_spec(
            profile_kind,
            _object(record.value["spec"]),
            job_image=job_image,
            worker_revision=worker_revision,
        )
        capacity_count += int(profile_kind == "capacity")
        deployment_count += int(profile_kind == "deployment")
        launch_policy_count += int(profile_kind == "launch_policy")
        pending.append(
            _PendingProfile(
                record=record,
                transformed_spec=transformed_spec,
                source_profile_id=source_profile_id,
            )
        )
    remaps = _known_remaps(known_remaps, profile_kind_by_id)
    transformed_target = _encode_transformed_profiles(
        pending,
        existing_targets=target,
        remaps=remaps,
        profile_kind_by_id=profile_kind_by_id,
    )
    return _ProfilePlan(
        target=tuple([*target, *transformed_target]),
        transformed_sources=tuple(item.record for item in pending),
        remaps=remaps,
        profile_kind_by_id=profile_kind_by_id,
        capacity_count=capacity_count,
        deployment_count=deployment_count,
        launch_policy_count=launch_policy_count,
    )


def _require_content_derived_profile_id(
    value: JsonObject,
    encoded_spec: bytes,
) -> None:
    expected = deterministic_id(
        "profile",
        _string(value["profile_kind"]),
        _string(value["name"]),
        sha256(encoded_spec),
    )
    if value["record_id"] != expected:
        raise RecordShapeError("profile record ID is not content-derived")


def _legacy_profile_spec(
    profile_kind: str,
    spec: JsonObject,
    *,
    job_image: str,
    worker_revision: str,
) -> JsonObject:
    if profile_kind == "capacity":
        return _transform_capacity_spec(spec)
    if profile_kind == "deployment":
        return _transform_deployment_spec(
            spec,
            job_image=job_image,
            worker_revision=worker_revision,
        )
    if profile_kind == "launch_policy":
        return _transform_launch_policy_spec(spec)
    raise RecordShapeError("profile record has an unknown legacy shape")


def _known_remaps(
    known_remaps: Sequence[ProfileDigestRemap],
    profile_kind_by_id: dict[str, str],
) -> dict[str, ProfileDigestRemap]:
    remaps = {item.source: item for item in known_remaps}
    if len(remaps) != len(known_remaps):
        raise ManifestError("profile digest remaps contain duplicate sources")
    for remap in remaps.values():
        if remap.source == remap.target:
            raise ManifestError("profile digest remap does not change identity")
        if remap.profile_kind not in {"capacity", "deployment", "launch_policy"}:
            raise ManifestError("profile digest remap has an unsupported kind")
        profile_kind_by_id[remap.source] = remap.profile_kind
        profile_kind_by_id[remap.target] = remap.profile_kind
    return remaps


def _encode_transformed_profiles(
    pending: Sequence[_PendingProfile],
    *,
    existing_targets: Sequence[PlannedRecord],
    remaps: dict[str, ProfileDigestRemap],
    profile_kind_by_id: dict[str, str],
) -> tuple[PlannedRecord, ...]:
    spec_bytes = canonical_bytes_many([item.transformed_spec for item in pending])
    candidates: dict[
        str,
        list[tuple[_PendingProfile, JsonObject, PlannedRecord]],
    ] = {}
    for item, encoded_spec in zip(pending, spec_bytes, strict=True):
        transformed = dict(item.record.value)
        transformed["record_id"] = deterministic_id(
            "profile",
            _string(item.record.value["profile_kind"]),
            _string(item.record.value["name"]),
            sha256(encoded_spec),
        )
        transformed["spec"] = item.transformed_spec
        _require_current_record(transformed)
        planned = _planned_record(transformed, canonical_bytes(transformed))
        candidates.setdefault(planned.key, []).append((item, transformed, planned))

    existing_by_path = {record.key: record for record in existing_targets}
    target: list[PlannedRecord] = []
    for path in sorted(candidates):
        group = candidates[path]
        representative = existing_by_path.get(path)
        if representative is None:
            representative = min(
                (planned for _, _, planned in group),
                key=lambda record: (
                    _parse_record_timestamp(_string(record.value["created_at"])),
                    record.content_digest,
                ),
            )
            target.append(representative)
        representative_value = _without_created_at(representative.value)
        if any(
            _without_created_at(value) != representative_value for _, value, _ in group
        ):
            raise RecordShapeError("collapsed profile records are inconsistent")
        for item, _, _ in group:
            _add_profile_remap(
                item,
                target_profile_id=representative.content_digest,
                remaps=remaps,
                profile_kind_by_id=profile_kind_by_id,
            )
    return tuple(target)


def _without_created_at(value: JsonObject) -> JsonObject:
    return {key: item for key, item in value.items() if key != "created_at"}


def _add_profile_remap(
    item: _PendingProfile,
    *,
    target_profile_id: str,
    remaps: dict[str, ProfileDigestRemap],
    profile_kind_by_id: dict[str, str],
) -> None:
    profile_kind = _string(item.record.value["profile_kind"])
    candidate = ProfileDigestRemap(
        profile_kind=profile_kind,
        source=item.source_profile_id,
        target=target_profile_id,
    )
    try:
        existing = remaps[item.source_profile_id]
    except KeyError:
        existing = None
    if existing is not None and existing != candidate:
        raise StaleInventoryError("profile digest remap changed")
    remaps[item.source_profile_id] = candidate
    profile_kind_by_id[item.source_profile_id] = profile_kind
    profile_kind_by_id[target_profile_id] = profile_kind


def _plan_promotions(
    promotions: Sequence[StoredRecord],
    *,
    remaps: dict[str, ProfileDigestRemap],
    profile_kind_by_id: dict[str, str],
    created_at: str,
) -> tuple[tuple[PlannedRecord, ...], tuple[StoredRecord, ...], int]:
    target: list[PlannedRecord] = []
    transformed: list[tuple[StoredRecord, JsonObject]] = []
    groups, affected_groups = _promotion_groups(
        promotions,
        remaps=remaps,
        profile_kind_by_id=profile_kind_by_id,
    )
    migration_time = _parse_utc_timestamp(created_at)
    for group_key in sorted(groups):
        unchanged, replacements = _plan_promotion_group(
            groups[group_key],
            affected=group_key in affected_groups,
            remaps=remaps,
            migration_time=migration_time,
        )
        target.extend(unchanged)
        transformed.extend(replacements)
    encoded = canonical_bytes_many([value for _, value in transformed])
    for (_, value), raw in zip(transformed, encoded, strict=True):
        _require_current_record(value)
        target.append(_planned_record(value, raw))
    _require_same_approved_aliases(promotions, target, remaps)
    return (
        tuple(target),
        tuple(record for record, _ in transformed),
        len(transformed),
    )


def _promotion_groups(
    promotions: Sequence[StoredRecord],
    *,
    remaps: dict[str, ProfileDigestRemap],
    profile_kind_by_id: dict[str, str],
) -> tuple[dict[tuple[str, str], list[StoredRecord]], set[tuple[str, str]]]:
    groups: dict[tuple[str, str], list[StoredRecord]] = {}
    affected_groups: set[tuple[str, str]] = set()
    for record in promotions:
        _require_current_record(record.value)
        profile_id = _string(record.value["profile_id"])
        profile_kind = _string(record.value["profile_kind"])
        _require_promotion_target(profile_id, profile_kind, profile_kind_by_id)
        group_key = (profile_kind, _string(record.value["alias"]))
        try:
            groups[group_key].append(record)
        except KeyError:
            groups[group_key] = [record]
        if profile_id in remaps:
            affected_groups.add(group_key)
    return groups, affected_groups


def _plan_promotion_group(
    records: Sequence[StoredRecord],
    *,
    affected: bool,
    remaps: dict[str, ProfileDigestRemap],
    migration_time: datetime,
) -> tuple[
    tuple[PlannedRecord, ...],
    tuple[tuple[StoredRecord, JsonObject], ...],
]:
    group = sorted(
        records,
        key=lambda record: (
            _string(record.value["created_at"]),
            _string(record.value["record_id"]),
        ),
    )
    if not affected:
        return tuple(_unchanged_record(record) for record in group), ()
    migration_floor = _utc_timestamp_with_microseconds(migration_time)
    if any(
        _string(record.value["profile_id"]) in remaps
        and _string(record.value["created_at"]) >= migration_floor
        for record in group
    ):
        raise ManifestError(
            "migration timestamp must follow affected promotion history"
        )
    source_group = [
        record
        for record in group
        if _string(record.value["created_at"]) < migration_floor
    ]
    unchanged = tuple(
        _unchanged_record(record)
        for record in group
        if _string(record.value["created_at"]) >= migration_floor
    )
    migration_timestamps = tuple(
        _utc_timestamp_with_microseconds(migration_time + timedelta(microseconds=index))
        for index in range(len(source_group))
    )
    if not migration_timestamps or migration_timestamps[0] <= max(
        _string(record.value["created_at"]) for record in source_group
    ):
        raise ManifestError(
            "migration timestamp must follow affected promotion history"
        )
    replacements: list[tuple[StoredRecord, JsonObject]] = []
    for record, migration_timestamp in zip(
        source_group, migration_timestamps, strict=True
    ):
        profile_id = _string(record.value["profile_id"])
        target_profile_id = (
            remaps[profile_id].target if profile_id in remaps else profile_id
        )
        replacements.append(
            (
                record,
                _transform_promotion(
                    record.value,
                    target_profile_id,
                    migration_timestamp,
                    source_content_digest=record.content_digest,
                ),
            )
        )
    return unchanged, tuple(replacements)


def _require_promotion_target(
    profile_id: str,
    profile_kind: str,
    profile_kind_by_id: dict[str, str],
) -> None:
    if profile_id not in profile_kind_by_id:
        raise RecordShapeError("promotion references an unavailable profile")
    if profile_kind_by_id[profile_id] != profile_kind:
        raise RecordShapeError("promotion profile kind does not match its target")


def _transform_promotion(
    value: JsonObject,
    target_profile_id: str,
    created_at: str,
    *,
    source_content_digest: str,
) -> JsonObject:
    transformed = dict(value)
    transformed["record_id"] = deterministic_id(
        "promotion-migration",
        _string(value["record_id"]),
        target_profile_id,
        created_at,
    )
    transformed["created_at"] = created_at
    transformed["actor"] = {
        "subject": "run-native-profile-migration",
        "role": "service",
    }
    transformed["profile_id"] = target_profile_id
    transformed["reason"] = "Migrated to the approved Run-native profile replacement."
    transformed["evidence"] = [source_content_digest]
    return transformed


def _require_same_approved_aliases(
    source: Sequence[StoredRecord],
    target: Sequence[PlannedRecord],
    remaps: dict[str, ProfileDigestRemap],
) -> None:
    expected = _approved_alias_targets(source)
    for key, profile_id in expected.items():
        if profile_id in remaps:
            expected[key] = remaps[profile_id].target
    if _approved_alias_targets(target) != expected:
        raise RecordShapeError("migration changes an approved profile alias")


def _approved_alias_targets(
    records: Sequence[StoredRecord] | Sequence[PlannedRecord],
) -> dict[tuple[str, str], str]:
    approved = sorted(
        (record for record in records if record.value["promotion_state"] == "approved"),
        key=lambda record: (
            _string(record.value["created_at"]),
            _string(record.value["record_id"]),
        ),
    )
    targets: dict[tuple[str, str], str] = {}
    for record in approved:
        targets[
            (
                _string(record.value["profile_kind"]),
                _string(record.value["alias"]),
            )
        ] = _string(record.value["profile_id"])
    return targets


def dry_run_manifest(
    plan: MigrationPlan,
    *,
    bucket_identity_digest: str,
    created_at: str,
) -> JsonObject:
    """Build a secret-free manifest containing no Bucket or record names."""
    profile_count = sum(
        record.value["kind"] == "profile.object" for record in plan.source.records
    )
    promotion_count = len(plan.source.records) - profile_count
    transformed_source_digests = tuple(
        sorted(record.content_digest for record in plan.transformed_sources)
    )
    source_digests = tuple(
        sorted(record.content_digest for record in plan.source.records)
    )
    additions = _missing_additions(plan.source, plan)
    payload: JsonObject = {
        "schema_version": SCHEMA_VERSION,
        "mode": "dry-run",
        "created_at": created_at,
        "bucket_identity_digest": bucket_identity_digest,
        "job_image": plan.job_image,
        "worker_revision": plan.worker_revision,
        "profile_count": profile_count,
        "promotion_count": promotion_count,
        "transformed_capacity_count": plan.transformed_capacity_count,
        "transformed_deployment_count": plan.transformed_deployment_count,
        "transformed_launch_policy_count": plan.transformed_launch_policy_count,
        "transformed_promotion_count": plan.transformed_promotion_count,
        "add_count": len(additions),
        "delete_count": len(transformed_source_digests),
        "source_inventory_digest": plan.source.inventory_digest,
        "target_inventory_digest": plan.target_inventory_digest,
        "source_content_digests": list(source_digests),
        "target_content_digests": list(plan.target_content_digests),
        "transformed_source_content_digests": list(transformed_source_digests),
        "profile_digest_remaps": [
            {
                "profile_kind": item.profile_kind,
                "source": item.source,
                "target": item.target,
            }
            for item in plan.remaps
        ],
    }
    payload["plan_digest"] = sha256(canonical_bytes(payload))
    return payload


def run_dry_run(
    *,
    api: BucketProfileApi,
    bucket_id: str,
    job_image: str,
    worker_revision: str,
    manifest_path: Path,
    clock: Clock | None = None,
) -> JsonObject:
    """Inventory and plan the migration without making a remote mutation."""
    created_at = _utc_timestamp(clock if clock is not None else datetime.now(UTC))
    snapshot = read_profile_snapshot(api, bucket_id)
    plan = build_migration_plan(
        snapshot,
        job_image=job_image,
        worker_revision=worker_revision,
        created_at=created_at,
    )
    manifest = dry_run_manifest(
        plan,
        bucket_identity_digest=_bucket_identity_digest(bucket_id),
        created_at=created_at,
    )
    write_manifest(manifest_path, manifest)
    LOGGER.info(
        "profile migration dry run verified profile_count=%d promotion_count=%d "
        "transformed_profile_count=%d transformed_promotion_count=%d",
        manifest["profile_count"],
        manifest["promotion_count"],
        plan.transformed_capacity_count
        + plan.transformed_deployment_count
        + plan.transformed_launch_policy_count,
        plan.transformed_promotion_count,
    )
    return manifest


def apply_migration(
    *,
    api: BucketProfileApi,
    bucket_id: str,
    job_image: str,
    worker_revision: str,
    confirmed: bool,
    expected_plan_digest: str | None,
    dry_run_manifest_path: Path | None,
    verification_manifest_path: Path,
    clock: Clock | None = None,
) -> JsonObject:
    """Apply or resume the reviewed two-phase migration and verify exact state."""
    manifest = _confirmed_manifest(
        confirmed=confirmed,
        expected_plan_digest=expected_plan_digest,
        dry_run_manifest_path=dry_run_manifest_path,
        bucket_id=bucket_id,
        job_image=job_image,
        worker_revision=worker_revision,
    )
    _require_batch_bound(manifest.add_count)
    _require_batch_bound(manifest.delete_count)
    snapshot = read_profile_snapshot(api, bucket_id)
    plan = _require_resumable_state(snapshot, manifest)
    _require_unchanged_listing(api, bucket_id, snapshot.entries)
    snapshot = _run_add_phase(api, bucket_id, snapshot, plan, manifest)
    _require_unchanged_listing(api, bucket_id, snapshot.entries)
    snapshot = _run_delete_phase(api, bucket_id, snapshot, manifest)
    _verify_final(snapshot, manifest)
    completed_at = _utc_timestamp(clock if clock is not None else datetime.now(UTC))
    verification = _verification_manifest(snapshot, manifest, completed_at)
    write_manifest(verification_manifest_path, verification)
    LOGGER.info(
        "profile migration verified final_count=%d transformed_profile_count=%d "
        "transformed_promotion_count=%d",
        len(snapshot.records),
        manifest.transformed_capacity_count
        + manifest.transformed_deployment_count
        + manifest.transformed_launch_policy_count,
        manifest.transformed_promotion_count,
    )
    return verification


def _confirmed_manifest(
    *,
    confirmed: bool,
    expected_plan_digest: str | None,
    dry_run_manifest_path: Path | None,
    bucket_id: str,
    job_image: str,
    worker_revision: str,
) -> DryRunManifest:
    if not confirmed:
        raise ConfirmationError("apply requires --yes")
    if (
        expected_plan_digest is None
        or _DIGEST_PATTERN.fullmatch(expected_plan_digest) is None
    ):
        raise ConfirmationError("apply requires a valid --expected-plan-digest")
    if dry_run_manifest_path is None:
        raise ConfirmationError("apply requires --dry-run-manifest")
    manifest = read_manifest(dry_run_manifest_path)
    if expected_plan_digest != manifest.plan_digest:
        raise ConfirmationError("expected plan digest does not match the manifest")
    if manifest.bucket_identity_digest != _bucket_identity_digest(bucket_id):
        raise ConfirmationError("destination Bucket differs from the reviewed manifest")
    if job_image != manifest.job_image or worker_revision != manifest.worker_revision:
        raise ConfirmationError("runtime inputs differ from the reviewed manifest")
    return manifest


def _run_add_phase(
    api: BucketProfileApi,
    bucket_id: str,
    snapshot: ProfileSnapshot,
    plan: MigrationPlan,
    manifest: DryRunManifest,
) -> ProfileSnapshot:
    refreshed = snapshot
    refreshed_plan = plan
    # Profiles land first, then active aliases, then historical promotions. Each
    # phase is verified before the next one can affect projection ordering.
    for phase in range(3):
        additions = _missing_additions_for_phase(refreshed, refreshed_plan, phase)
        if not additions:
            continue
        _require_batch_bound(len(additions))
        error = _batch_add(api, bucket_id, additions)
        refreshed = read_profile_snapshot(api, bucket_id)
        refreshed_plan = _require_resumable_state(refreshed, manifest)
        if _missing_additions_for_phase(refreshed, refreshed_plan, phase):
            if error is None:
                raise VerificationError("replacement records are not fully verified")
            raise ResumableApplyError(
                "replacement add phase stopped safely; rerun the same apply"
            ) from error
    return refreshed


def _run_delete_phase(
    api: BucketProfileApi,
    bucket_id: str,
    snapshot: ProfileSnapshot,
    manifest: DryRunManifest,
) -> ProfileSnapshot:
    deletions = _remaining_deletions(snapshot, manifest)
    if not deletions:
        return snapshot
    _require_batch_bound(len(deletions))
    error = _batch_delete(api, bucket_id, deletions)
    refreshed = read_profile_snapshot(api, bucket_id)
    _require_resumable_state(refreshed, manifest)
    if _remaining_deletions(refreshed, manifest):
        if error is None:
            raise VerificationError("superseded records remain after deletion")
        raise ResumableApplyError(
            "superseded delete phase stopped safely; rerun the same apply"
        ) from error
    return refreshed


def _verification_manifest(
    snapshot: ProfileSnapshot,
    manifest: DryRunManifest,
    created_at: str,
) -> JsonObject:
    return {
        "schema_version": SCHEMA_VERSION,
        "mode": "verification",
        "created_at": created_at,
        "status": "verified",
        "bucket_identity_digest": manifest.bucket_identity_digest,
        "plan_digest": manifest.plan_digest,
        "final_inventory_digest": snapshot.inventory_digest,
        "final_count": len(snapshot.records),
        "transformed_capacity_count": manifest.transformed_capacity_count,
        "transformed_deployment_count": manifest.transformed_deployment_count,
        "transformed_launch_policy_count": manifest.transformed_launch_policy_count,
        "transformed_promotion_count": manifest.transformed_promotion_count,
    }


def write_manifest(path: Path, manifest: JsonObject) -> None:
    """Atomically write a local manifest without logging its path."""
    temporary = path.with_name(f".{path.name}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    except OSError as error:
        with suppress(OSError):
            temporary.unlink(missing_ok=True)
        raise ManifestError("local migration manifest could not be written") from error


def read_manifest(path: Path) -> DryRunManifest:
    """Read, validate, and authenticate one local dry-run manifest."""
    try:
        raw: object = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError("local dry-run manifest could not be read") from error
    value = _json_object(raw)
    expected_fields = {
        "schema_version",
        "mode",
        "created_at",
        "bucket_identity_digest",
        "job_image",
        "worker_revision",
        "profile_count",
        "promotion_count",
        "transformed_capacity_count",
        "transformed_deployment_count",
        "transformed_launch_policy_count",
        "transformed_promotion_count",
        "add_count",
        "delete_count",
        "source_inventory_digest",
        "target_inventory_digest",
        "source_content_digests",
        "target_content_digests",
        "transformed_source_content_digests",
        "profile_digest_remaps",
        "plan_digest",
    }
    if set(value) != expected_fields:
        raise ManifestError("dry-run manifest fields do not match the schema")
    if value["schema_version"] != SCHEMA_VERSION or value["mode"] != "dry-run":
        raise ManifestError("dry-run manifest version or mode is invalid")
    plan_digest = _digest_value(value["plan_digest"])
    unsigned = dict(value)
    del unsigned["plan_digest"]
    if sha256(canonical_bytes(unsigned)) != plan_digest:
        raise ManifestError("dry-run manifest plan digest is invalid")
    remaps = _manifest_remaps(value["profile_digest_remaps"])
    manifest = DryRunManifest(
        created_at=_string(value["created_at"]),
        bucket_identity_digest=_digest_value(value["bucket_identity_digest"]),
        job_image=_string(value["job_image"]),
        worker_revision=_string(value["worker_revision"]),
        profile_count=_nonnegative_integer(value["profile_count"]),
        promotion_count=_nonnegative_integer(value["promotion_count"]),
        transformed_capacity_count=_nonnegative_integer(
            value["transformed_capacity_count"]
        ),
        transformed_deployment_count=_nonnegative_integer(
            value["transformed_deployment_count"]
        ),
        transformed_launch_policy_count=_nonnegative_integer(
            value["transformed_launch_policy_count"]
        ),
        transformed_promotion_count=_nonnegative_integer(
            value["transformed_promotion_count"]
        ),
        add_count=_nonnegative_integer(value["add_count"]),
        delete_count=_nonnegative_integer(value["delete_count"]),
        source_inventory_digest=_digest_value(value["source_inventory_digest"]),
        target_inventory_digest=_digest_value(value["target_inventory_digest"]),
        source_content_digests=_digest_list(value["source_content_digests"]),
        target_content_digests=_digest_list(value["target_content_digests"]),
        transformed_source_content_digests=_digest_list(
            value["transformed_source_content_digests"]
        ),
        profile_digest_remaps=remaps,
        plan_digest=plan_digest,
    )
    _parse_utc_timestamp(manifest.created_at)
    _validate_runtime_inputs(manifest.job_image, manifest.worker_revision)
    _validate_manifest_consistency(manifest)
    return manifest


def _manifest_remaps(value: JsonValue) -> tuple[ProfileDigestRemap, ...]:
    remaps: list[ProfileDigestRemap] = []
    for item in _list(value):
        remap = _object(item)
        if set(remap) != {"profile_kind", "source", "target"}:
            raise ManifestError("dry-run manifest profile remap is malformed")
        remaps.append(
            ProfileDigestRemap(
                profile_kind=_string(remap["profile_kind"]),
                source=_digest_value(remap["source"]),
                target=_digest_value(remap["target"]),
            )
        )
    result = tuple(sorted(remaps))
    if len({item.source for item in result}) != len(result):
        raise ManifestError("dry-run manifest profile remap sources are not unique")
    if any(
        item.profile_kind not in {"capacity", "deployment", "launch_policy"}
        for item in result
    ):
        raise ManifestError("dry-run manifest profile remap kind is invalid")
    return result


def _validate_manifest_consistency(manifest: DryRunManifest) -> None:
    source_count = manifest.profile_count + manifest.promotion_count
    transformed_count = (
        manifest.transformed_promotion_count
        + manifest.transformed_capacity_count
        + manifest.transformed_deployment_count
        + manifest.transformed_launch_policy_count
    )
    transformed_profile_count = (
        manifest.transformed_capacity_count
        + manifest.transformed_deployment_count
        + manifest.transformed_launch_policy_count
    )
    if (
        source_count != len(manifest.source_content_digests)
        or len(manifest.target_content_digests)
        != source_count - manifest.delete_count + manifest.add_count
        or manifest.delete_count != len(manifest.transformed_source_content_digests)
        or transformed_count != manifest.delete_count
        or transformed_profile_count != len(manifest.profile_digest_remaps)
    ):
        raise ManifestError("dry-run manifest operation counts are inconsistent")
    if not set(manifest.transformed_source_content_digests) <= set(
        manifest.source_content_digests
    ):
        raise ManifestError("dry-run manifest transformed identities are inconsistent")
    if set(manifest.transformed_source_content_digests) & set(
        manifest.target_content_digests
    ):
        raise ManifestError("dry-run manifest source and target identities collide")
    if manifest.add_count != len(
        set(manifest.target_content_digests) - set(manifest.source_content_digests)
    ):
        raise ManifestError("dry-run manifest addition count is inconsistent")
    remap_targets = {item.target for item in manifest.profile_digest_remaps}
    if not remap_targets <= set(manifest.target_content_digests):
        raise ManifestError("dry-run manifest profile remaps are inconsistent")


def _transform_capacity_spec(spec: JsonObject) -> JsonObject:
    if set(spec) != _LEGACY_CAPACITY_FIELDS:
        raise RecordShapeError("capacity profile has an unknown legacy shape")
    transformed = dict(spec)
    transformed["max_active_jobs"] = transformed["max_active_sandboxes"]
    del transformed["max_active_sandboxes"]
    limits = _list(transformed["hardware_limits"])
    transformed_limits: list[JsonValue] = []
    for item in limits:
        limit = _object(item)
        if set(limit) != {"hardware", "max_active_sandboxes"}:
            raise RecordShapeError("capacity hardware limit has an unknown shape")
        transformed_limits.append(
            {
                "hardware": limit["hardware"],
                "max_active_jobs": limit["max_active_sandboxes"],
            }
        )
    transformed["hardware_limits"] = transformed_limits
    return transformed


def _transform_launch_policy_spec(spec: JsonObject) -> JsonObject:
    fields = set(spec)
    allowed = (
        _LEGACY_LAUNCH_POLICY_REQUIRED_FIELDS | _LEGACY_LAUNCH_POLICY_OPTIONAL_FIELDS
    )
    if not fields >= _LEGACY_LAUNCH_POLICY_REQUIRED_FIELDS or not fields <= allowed:
        raise RecordShapeError("launch policy profile has an unknown legacy shape")
    transformed = dict(spec)
    transformed["max_run_ceiling_microusd"] = transformed[
        "max_campaign_ceiling_microusd"
    ]
    del transformed["max_campaign_ceiling_microusd"]
    return transformed


def _transform_deployment_spec(
    spec: JsonObject,
    *,
    job_image: str,
    worker_revision: str,
) -> JsonObject:
    if "sandbox" in spec:
        return _transform_sandbox_delegating_deployment(spec)
    _validate_legacy_deployment(spec)
    sandbox = _object(spec["sandbox_template"])
    _validate_legacy_sandbox(sandbox)
    template = _trial_job_template(sandbox)

    transformed = dict(spec)
    transformed["job_image"] = job_image
    transformed["worker_revision"] = worker_revision
    transformed["preparation_job_command"] = list(PREPARATION_COMMAND)
    transformed["job_command"] = list(TRIAL_COMMAND)
    transformed["trial_job_template"] = template
    del transformed["sandbox_template"]
    for field in (
        "worker_concurrency",
        "worker_max_tasks_per_job",
        *_RETIRED_DEPLOYMENT_INFERENCE_FIELDS,
    ):
        transformed.pop(field, None)
    return transformed


def _transform_sandbox_delegating_deployment(spec: JsonObject) -> JsonObject:
    fields = set(spec)
    allowed = (
        _LEGACY_SANDBOX_DELEGATING_REQUIRED_FIELDS
        | _LEGACY_SANDBOX_DELEGATING_OPTIONAL_FIELDS
    )
    if (
        not fields >= _LEGACY_SANDBOX_DELEGATING_REQUIRED_FIELDS
        or not fields <= allowed
    ):
        raise RecordShapeError("deployment profile has an unknown legacy shape")
    _validate_legacy_single_sandbox(_object(spec["sandbox"]))
    transformed = dict(spec)
    del transformed["sandbox"]
    for field in _RETIRED_DEPLOYMENT_INFERENCE_FIELDS:
        transformed.pop(field, None)
    return transformed


def _validate_legacy_single_sandbox(sandbox: JsonObject) -> None:
    if set(sandbox) != _LEGACY_SINGLE_SANDBOX_FIELDS:
        raise RecordShapeError("deployment sandbox has an unknown legacy shape")
    image = _string(sandbox["image"])
    if _JOB_IMAGE_PATTERN.fullmatch(image) is None:
        raise RecordShapeError("deployment sandbox image is not immutable")
    if not _string(sandbox["hardware"]):
        raise RecordShapeError("deployment sandbox hardware is malformed")
    if sandbox["inference_token"] not in {"forbidden", "required"}:
        raise RecordShapeError("deployment sandbox inference policy is malformed")
    for field in (
        "timeout_seconds",
        "idle_timeout_seconds",
        "max_sandboxes",
        "max_commands",
        "max_command_seconds",
        "max_transfer_bytes",
    ):
        _positive_integer(sandbox[field])
    for field in ("reservation_microusd", "active_hourly_cost_microusd"):
        _nonnegative_profile_integer(sandbox[field])
    roots = _list(sandbox["allowed_roots"])
    if not roots or any(not _string(root).startswith("/") for root in roots):
        raise RecordShapeError("deployment sandbox allowed roots are malformed")


def _validate_legacy_deployment(spec: JsonObject) -> None:
    fields = set(spec)
    if (
        not fields >= _LEGACY_DEPLOYMENT_REQUIRED_FIELDS
        or not fields <= _LEGACY_DEPLOYMENT_FIELDS
        or "trial_job_template" in spec
    ):
        raise RecordShapeError("deployment profile has an unknown legacy shape")
    if "worker_concurrency" in spec:
        _positive_integer(spec["worker_concurrency"])
    if "worker_max_tasks_per_job" in spec:
        _positive_integer(spec["worker_max_tasks_per_job"])
    if (
        "preparation" in spec
        and spec["preparation"] == "required"
        and ("worker_concurrency" not in spec or "worker_max_tasks_per_job" not in spec)
    ):
        raise RecordShapeError("prepared legacy deployment worker limits are missing")


def _validate_legacy_sandbox(sandbox: JsonObject) -> None:
    fields = set(sandbox)
    if not fields >= _LEGACY_SANDBOX_REQUIRED_FIELDS or not fields <= (
        _LEGACY_SANDBOX_REQUIRED_FIELDS | _LEGACY_SANDBOX_OPTIONAL_FIELDS
    ):
        raise RecordShapeError("deployment sandbox template has an unknown shape")
    for key in (
        "max_sandboxes",
        "max_commands",
        "max_command_seconds",
        "max_transfer_bytes",
    ):
        _positive_integer(sandbox[key])
    if (
        not isinstance(sandbox["idle_timeout_overhead_seconds"], int)
        or isinstance(sandbox["idle_timeout_overhead_seconds"], bool)
        or sandbox["idle_timeout_overhead_seconds"] < 0
    ):
        raise RecordShapeError("deployment idle timeout overhead is malformed")
    allowed_roots = _list(sandbox["allowed_roots"])
    if not allowed_roots or not all(isinstance(item, str) for item in allowed_roots):
        raise RecordShapeError("deployment allowed roots are malformed")


def _trial_job_template(sandbox: JsonObject) -> JsonObject:
    template: JsonObject = {
        key: sandbox[key] for key in _TRIAL_TEMPLATE_PRESERVED_FIELDS if key in sandbox
    }
    template["max_image_bytes"] = MAX_IMAGE_BYTES
    template["max_image_entries"] = MAX_IMAGE_ENTRIES
    template["max_jobs"] = sandbox["max_sandboxes"]
    return template


def _require_resumable_state(
    snapshot: ProfileSnapshot,
    manifest: DryRunManifest,
) -> MigrationPlan:
    current_digests = {record.content_digest for record in snapshot.records}
    allowed = set(manifest.source_content_digests) | set(
        manifest.target_content_digests
    )
    if not current_digests <= allowed:
        raise StaleInventoryError("profile inventory contains unreviewed content")
    if set(manifest.target_content_digests) <= current_digests:
        plan = _plan_from_complete_targets(snapshot, manifest)
        if plan.target_inventory_digest != manifest.target_inventory_digest:
            raise StaleInventoryError(
                "verified replacement records do not match the reviewed plan"
            )
        return plan
    plan = build_migration_plan(
        snapshot,
        job_image=manifest.job_image,
        worker_revision=manifest.worker_revision,
        created_at=manifest.created_at,
        known_remaps=manifest.profile_digest_remaps,
    )
    if (
        plan.target_inventory_digest != manifest.target_inventory_digest
        or plan.target_content_digests != manifest.target_content_digests
        or plan.remaps != manifest.profile_digest_remaps
    ):
        raise StaleInventoryError("profile inventory cannot resume the reviewed plan")
    return plan


def _plan_from_complete_targets(
    snapshot: ProfileSnapshot,
    manifest: DryRunManifest,
) -> MigrationPlan:
    target_digests = set(manifest.target_content_digests)
    transformed_digests = set(manifest.transformed_source_content_digests)
    target: list[PlannedRecord] = []
    transformed_sources: list[StoredRecord] = []
    for record in snapshot.records:
        if record.content_digest in target_digests:
            _require_current_record(record.value)
            target.append(_unchanged_record(record))
        if record.content_digest in transformed_digests:
            transformed_sources.append(record)
    return MigrationPlan(
        source=snapshot,
        target=tuple(sorted(target, key=lambda record: record.key)),
        transformed_sources=tuple(transformed_sources),
        remaps=manifest.profile_digest_remaps,
        job_image=manifest.job_image,
        worker_revision=manifest.worker_revision,
        transformed_capacity_count=manifest.transformed_capacity_count,
        transformed_deployment_count=manifest.transformed_deployment_count,
        transformed_launch_policy_count=manifest.transformed_launch_policy_count,
        transformed_promotion_count=manifest.transformed_promotion_count,
    )


def _missing_additions(
    snapshot: ProfileSnapshot,
    plan: MigrationPlan,
) -> tuple[PlannedRecord, ...]:
    current = {record.entry.key: record.raw for record in snapshot.records}
    additions: list[PlannedRecord] = []
    for item in plan.target:
        if item.key not in current:
            additions.append(item)
        elif current[item.key] != item.raw:
            raise StaleInventoryError("planned target path has conflicting content")
    winner_ids = _approved_alias_winner_ids(plan.target)
    return tuple(
        sorted(
            additions,
            key=lambda record: _addition_order(record, winner_ids),
        )
    )


def _missing_additions_for_phase(
    snapshot: ProfileSnapshot,
    plan: MigrationPlan,
    phase: int,
) -> tuple[PlannedRecord, ...]:
    winner_ids = _approved_alias_winner_ids(plan.target)
    return tuple(
        record
        for record in _missing_additions(snapshot, plan)
        if _addition_order(record, winner_ids)[0] == phase
    )


def _approved_alias_winner_ids(
    records: Sequence[PlannedRecord],
) -> dict[tuple[str, str], str]:
    approved = sorted(
        (
            record
            for record in records
            if record.value["kind"] == "profile.promotion"
            and record.value["promotion_state"] == "approved"
        ),
        key=lambda record: (
            _string(record.value["created_at"]),
            _string(record.value["record_id"]),
        ),
    )
    winners: dict[tuple[str, str], str] = {}
    for record in approved:
        winners[
            (
                _string(record.value["profile_kind"]),
                _string(record.value["alias"]),
            )
        ] = _string(record.value["record_id"])
    return winners


def _addition_order(
    record: PlannedRecord,
    winner_ids: dict[tuple[str, str], str],
) -> tuple[int, str]:
    if record.value["kind"] == "profile.object":
        return (0, record.key)
    alias = (
        _string(record.value["profile_kind"]),
        _string(record.value["alias"]),
    )
    is_winner = alias in winner_ids and winner_ids[alias] == _string(
        record.value["record_id"]
    )
    return (1 if is_winner else 2, record.key)


def _remaining_deletions(
    snapshot: ProfileSnapshot,
    manifest: DryRunManifest,
) -> tuple[str, ...]:
    transformed = set(manifest.transformed_source_content_digests)
    return tuple(
        sorted(
            record.entry.key
            for record in snapshot.records
            if record.content_digest in transformed
        )
    )


def _verify_final(snapshot: ProfileSnapshot, manifest: DryRunManifest) -> None:
    if snapshot.inventory_digest != manifest.target_inventory_digest:
        raise VerificationError("final profile inventory digest does not match")
    if tuple(sorted(record.content_digest for record in snapshot.records)) != (
        manifest.target_content_digests
    ):
        raise VerificationError("final profile content identities do not match")
    for record in snapshot.records:
        _require_current_record(record.value)
        if record.raw != record.canonical:
            raise VerificationError("final profile record uses non-canonical JSON")


def _batch_add(
    api: BucketProfileApi,
    bucket_id: str,
    additions: Sequence[PlannedRecord],
) -> Exception | None:
    try:
        api.batch_bucket_files(
            bucket_id,
            add=[(item.raw, item.key) for item in additions],
        )
    except (ValueError, OSError, HfHubHTTPError, httpx.TransportError) as error:
        return error
    return None


def _batch_delete(
    api: BucketProfileApi,
    bucket_id: str,
    deletions: Sequence[str],
) -> Exception | None:
    try:
        api.batch_bucket_files(bucket_id, delete=list(deletions))
    except (ValueError, OSError, HfHubHTTPError, httpx.TransportError) as error:
        return error
    return None


def _require_batch_bound(count: int) -> None:
    if count > MAX_BATCH_OPERATIONS:
        raise ConfirmationError("migration exceeds the reviewed single-batch bound")


def _require_unchanged_listing(
    api: BucketProfileApi,
    bucket_id: str,
    expected: tuple[BucketEntry, ...],
) -> None:
    if _list_entries(api, bucket_id) != expected:
        raise StaleInventoryError(
            "profile inventory changed immediately before mutation"
        )


def _list_entries(
    api: BucketProfileApi,
    bucket_id: str,
) -> tuple[BucketEntry, ...]:
    paths = _list_profile_paths(api, bucket_id)
    return _profile_path_metadata(api, bucket_id, paths)


def _list_profile_paths(
    api: BucketProfileApi,
    bucket_id: str,
) -> tuple[str, ...]:
    try:
        entries = list(
            api.list_bucket_tree(
                bucket_id,
                prefix=PROFILE_PREFIX,
                recursive=True,
            )
        )
    except (ValueError, HfHubHTTPError, httpx.TransportError) as error:
        raise InventoryError("complete profile inventory listing failed") from error
    observed: set[str] = set()
    for item in entries:
        entry_type = getattr(item, "type", None)
        if entry_type == "directory":
            continue
        if entry_type != "file":
            raise InventoryError("profile listing returned an unknown entry type")
        key = getattr(item, "path", None)
        if (
            not isinstance(key, str)
            or not key.startswith(PROFILE_PREFIX)
            or key.startswith("/")
            or "\n" in key
            or "\r" in key
            or key in observed
        ):
            raise InventoryError("profile listing returned an invalid file path")
        observed.add(key)
    return tuple(sorted(observed))


def _profile_path_metadata(
    api: BucketProfileApi,
    bucket_id: str,
    paths: Sequence[str],
) -> tuple[BucketEntry, ...]:
    try:
        metadata = list(api.get_bucket_paths_info(bucket_id, paths)) if paths else []
    except (ValueError, HfHubHTTPError, httpx.TransportError) as error:
        raise InventoryError("profile object metadata lookup failed") from error
    output: list[BucketEntry] = []
    metadata_paths: set[str] = set()
    expected_paths = set(paths)
    for item in metadata:
        key = getattr(item, "path", None)
        size = getattr(item, "size", None)
        xet_hash = getattr(item, "xet_hash", None)
        if (
            not isinstance(item, BucketFile)
            or not isinstance(key, str)
            or key not in expected_paths
            or key in metadata_paths
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or not isinstance(xet_hash, str)
            or _XET_HASH_PATTERN.fullmatch(xet_hash) is None
        ):
            raise InventoryError("profile metadata lookup returned invalid data")
        metadata_paths.add(key)
        output.append(
            BucketEntry(
                key=key,
                size=size,
                xet_hash=xet_hash.lower(),
                remote=item,
            )
        )
    if metadata_paths != expected_paths:
        raise StaleInventoryError("profile paths changed during metadata lookup")
    return tuple(sorted(output))


def _stored_record(
    entry: BucketEntry,
    raw: bytes,
    value: JsonObject,
    canonical: bytes,
) -> StoredRecord:
    if "kind" not in value:
        raise RecordShapeError("profile record kind is missing")
    kind = _string(value["kind"])
    if kind == "profile.object":
        if set(value) != _PROFILE_FIELDS:
            raise RecordShapeError("profile object fields are malformed")
    elif kind == "profile.promotion":
        if set(value) != _PROMOTION_FIELDS:
            raise RecordShapeError("profile promotion fields are malformed")
    else:
        raise RecordShapeError("profile prefix contains an unsupported record kind")
    expected_path = _record_path(value)
    if entry.key != expected_path:
        raise RecordShapeError("profile record path does not match its identity")
    return StoredRecord(
        entry=entry,
        raw=raw,
        value=value,
        canonical=canonical,
        content_digest=sha256(raw),
    )


def _record_path(value: JsonObject) -> str:
    record_id = _string(value["record_id"])
    profile_kind = _string(value["profile_kind"])
    if _ID_PATTERN.fullmatch(record_id) is None:
        raise RecordShapeError("profile record identifier is invalid")
    if value["kind"] == "profile.object":
        return f"{PROFILE_PREFIX}objects/{profile_kind}/{record_id}.json"
    alias = _string(value["alias"])
    return f"{PROFILE_PREFIX}promotions/{profile_kind}/{alias}/{record_id}.json"


def _planned_record(value: JsonObject, raw: bytes) -> PlannedRecord:
    return PlannedRecord(
        key=_record_path(value),
        raw=raw,
        value=value,
        content_digest=sha256(raw),
    )


def _unchanged_record(record: StoredRecord) -> PlannedRecord:
    if record.raw != record.canonical:
        raise RecordShapeError("current profile record uses non-canonical JSON")
    return PlannedRecord(
        key=record.entry.key,
        raw=record.raw,
        value=record.value,
        content_digest=record.content_digest,
    )


def _unique_target(records: Sequence[PlannedRecord]) -> tuple[PlannedRecord, ...]:
    by_path: dict[str, PlannedRecord] = {}
    path_by_content_digest: dict[str, str] = {}
    for record in records:
        if record.key in by_path:
            if by_path[record.key].raw != record.raw:
                raise RecordShapeError("migration target path collision")
            continue
        if record.content_digest in path_by_content_digest:
            raise RecordShapeError("migration target content collision")
        by_path[record.key] = record
        path_by_content_digest[record.content_digest] = record.key
    return tuple(sorted(by_path.values(), key=lambda item: item.key))


def _is_current_record(value: JsonObject) -> bool:
    if (
        value.get("kind") == "profile.object"
        and value.get("profile_kind") == "deployment"
    ):
        spec = value.get("spec")
        if isinstance(spec, dict) and (
            spec.get("route") == "sandbox"
            or "sandbox" in spec
            or any(
                field in spec
                for field in (
                    "sandbox_template",
                    "worker_concurrency",
                    "worker_max_tasks_per_job",
                )
            )
        ):
            return False
    return not any(_validator().iter_errors(value))


def _require_current_record(value: JsonObject) -> None:
    if not _is_current_record(value):
        raise RecordShapeError("migration output violates the current control schema")


@cache
def _validator() -> Validator:
    schema_path = (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "contracts"
        / "schemas"
        / "control-record-v1.schema.json"
    )
    try:
        schema: object = json.loads(schema_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProfileMigrationError("current control schema is unavailable") from error
    checked_schema = _migration_target_schema(_json_object(schema))
    Draft202012Validator.check_schema(checked_schema)
    return Draft202012Validator(checked_schema, format_checker=FormatChecker())


def _migration_target_schema(schema: JsonObject) -> JsonObject:
    definitions = _object(schema["$defs"])
    for definition_name, reference in (
        ("ProfileObject", "#/$defs/LegacyCapacityProfileObject"),
        ("ProfileSpec", "#/$defs/LegacyCapacityProfileSpec"),
    ):
        definition = _object(definitions[definition_name])
        variants = _list(definition["oneOf"])
        retained = [
            variant for variant in variants if _object(variant).get("$ref") != reference
        ]
        if len(retained) != len(variants) - 1:
            raise ProfileMigrationError(
                "current control schema has no isolated legacy capacity variant"
            )
        definition["oneOf"] = retained
    return schema


def _inventory_digest(entries: Iterable[tuple[str, int, str]]) -> str:
    digest = hashlib.sha256()
    for key, size, content_digest in sorted(entries):
        digest.update(len(key.encode()).to_bytes(8, "big"))
        digest.update(key.encode())
        digest.update(size.to_bytes(8, "big"))
        digest.update(content_digest.encode())
    return f"sha256:{digest.hexdigest()}"


def _parse_json_object(raw: bytes) -> JsonObject:
    try:
        value: object = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RecordShapeError("profile prefix contains malformed JSON") from error
    return _json_object(value)


def _json_object(value: object) -> JsonObject:
    checked = _json_value(value)
    if not isinstance(checked, dict):
        raise RecordShapeError("profile record must be a JSON object")
    return checked


def _json_value(value: object) -> JsonValue:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, (int, float)):
        return _json_number(value)
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise RecordShapeError("profile record contains a non-string key")
        return {cast(str, key): _json_value(item) for key, item in value.items()}
    raise RecordShapeError("profile record contains a non-JSON value")


def _json_number(value: int | float) -> int | float:
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        raise RecordShapeError("profile record integer is not JSON-safe")
    if isinstance(value, float) and not math.isfinite(value):
        raise RecordShapeError("profile record contains a non-finite number")
    return value


def _object(value: JsonValue) -> JsonObject:
    if not isinstance(value, dict):
        raise RecordShapeError("profile record object field is malformed")
    return value


def _list(value: JsonValue) -> list[JsonValue]:
    if not isinstance(value, list):
        raise RecordShapeError("profile record list field is malformed")
    return value


def _string(value: JsonValue) -> str:
    if not isinstance(value, str):
        raise RecordShapeError("profile record string field is malformed")
    return value


def _positive_integer(value: JsonValue) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise RecordShapeError("profile record positive integer field is malformed")
    return value


def _nonnegative_profile_integer(value: JsonValue) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RecordShapeError("profile record nonnegative integer field is malformed")
    return value


def _nonnegative_integer(value: JsonValue) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ManifestError("dry-run manifest count is invalid")
    return value


def _digest_value(value: JsonValue) -> str:
    digest = _string(value)
    if _DIGEST_PATTERN.fullmatch(digest) is None:
        raise ManifestError("dry-run manifest digest is invalid")
    return digest


def _digest_list(value: JsonValue) -> tuple[str, ...]:
    digests = tuple(_digest_value(item) for item in _list(value))
    if tuple(sorted(digests)) != digests or len(set(digests)) != len(digests):
        raise ManifestError("dry-run manifest digest list is not unique and sorted")
    return digests


def _validate_runtime_inputs(job_image: str, worker_revision: str) -> None:
    if _JOB_IMAGE_PATTERN.fullmatch(job_image) is None:
        raise ConfirmationError("job image must use an immutable SHA-256 digest")
    if _REVISION_PATTERN.fullmatch(worker_revision) is None:
        raise ConfirmationError("worker revision must be a full lowercase Git commit")


def _parse_utc_timestamp(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ManifestError("migration timestamp is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() != UTC.utcoffset(parsed):
        raise ManifestError("migration timestamp must use UTC")
    return parsed


def _parse_record_timestamp(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RecordShapeError("profile record timestamp is invalid") from error
    if parsed.tzinfo is None:
        raise RecordShapeError("profile record timestamp has no timezone")
    return parsed.astimezone(UTC)


def _utc_timestamp(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() != UTC.utcoffset(value):
        raise ManifestError("migration clock must return a UTC timestamp")
    return value.isoformat().replace("+00:00", "Z")


def _utc_timestamp_with_microseconds(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() != UTC.utcoffset(value):
        raise ManifestError("migration timestamp must use UTC")
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Dry-run or apply the one-time Run-native profile schema migration."
        )
    )
    parser.add_argument(
        "--bucket",
        required=True,
        metavar="<namespace>/<artifact-bucket>",
    )
    parser.add_argument("--job-image", required=True)
    parser.add_argument("--worker-revision", required=True)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_DRY_RUN_MANIFEST,
        help="local dry-run manifest path",
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--expected-plan-digest")
    parser.add_argument("--dry-run-manifest", type=Path)
    parser.add_argument(
        "--verification-manifest",
        type=Path,
        default=DEFAULT_VERIFICATION_MANIFEST,
        help="local post-migration verification manifest path",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the standalone operator CLI without logging private identifiers."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    arguments = _parser().parse_args(argv)
    try:
        api = cast(BucketProfileApi, HfApi())
        if cast(bool, arguments.apply):
            apply_migration(
                api=api,
                bucket_id=cast(str, arguments.bucket),
                job_image=cast(str, arguments.job_image),
                worker_revision=cast(str, arguments.worker_revision),
                confirmed=cast(bool, arguments.yes),
                expected_plan_digest=cast(str | None, arguments.expected_plan_digest),
                dry_run_manifest_path=cast(Path | None, arguments.dry_run_manifest),
                verification_manifest_path=cast(Path, arguments.verification_manifest),
            )
        else:
            if (
                cast(bool, arguments.yes)
                or cast(str | None, arguments.expected_plan_digest) is not None
                or cast(Path | None, arguments.dry_run_manifest) is not None
            ):
                raise ConfirmationError(
                    "apply-only confirmation options require --apply"
                )
            run_dry_run(
                api=api,
                bucket_id=cast(str, arguments.bucket),
                job_image=cast(str, arguments.job_image),
                worker_revision=cast(str, arguments.worker_revision),
                manifest_path=cast(Path, arguments.manifest),
            )
    except ProfileMigrationError as error:
        LOGGER.error("profile migration aborted: %s", error)
        return 1
    return 0

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.protocols import Validator

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_CONTROL_PATH_PARTS = {
    "campaign.request": ("campaigns", "{campaign_id}", "request.json"),
    "campaign.lock": ("campaigns", "{campaign_id}", "campaign.lock.json"),
    "action.intent": (
        "campaigns",
        "{campaign_id}",
        "actions",
        "{action_id}",
        "intent.json",
    ),
    "action.dispatch": (
        "campaigns",
        "{campaign_id}",
        "actions",
        "{action_id}",
        "q-dispatch.json",
    ),
    "action.receipt": (
        "campaigns",
        "{campaign_id}",
        "actions",
        "{action_id}",
        "receipt.json",
    ),
    "action.advanced": (
        "campaigns",
        "{campaign_id}",
        "actions",
        "{action_id}",
        "zz-advanced.json",
    ),
    "attempt.receipt": (
        "campaigns",
        "{campaign_id}",
        "tasks",
        "{task_id}",
        "attempts",
        "{attempt_id}",
        "receipt.json",
    ),
    "terminal.selection": (
        "campaigns",
        "{campaign_id}",
        "tasks",
        "{task_id}",
        "terminal",
        "{record_id}.json",
    ),
    "budget.event": ("campaigns", "{campaign_id}", "budgets", "{record_id}.json"),
    "endpoint.resource": (
        "campaigns",
        "{campaign_id}",
        "resources",
        "endpoints",
        "{action_id}.json",
    ),
    "publication.receipt": (
        "campaigns",
        "{campaign_id}",
        "publications",
        "{publication_id}.json",
    ),
    "migration.record": ("migrations", "{record_id}.json"),
}


@dataclass(frozen=True)
class Source:
    name: str
    root: Path
    head: str


def canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
        + b"\n"
    )


def digest(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def files(source: Source) -> list[Path]:
    output: list[Path] = []
    for path in source.root.rglob("*"):
        if path.is_symlink():
            raise ValueError(
                f"source contains a symbolic link: {path.relative_to(source.root)}"
            )
        if path.is_file():
            output.append(path)
        elif not path.is_dir():
            raise ValueError(
                f"source contains a special file: {path.relative_to(source.root)}"
            )
    return sorted(output, key=lambda path: path.relative_to(source.root).as_posix())


def verify_result_publications(source: Source) -> None:
    publication_root = source.root / "publications"
    if not publication_root.is_dir():
        return
    for path in sorted(publication_root.glob("*.json")):
        publication = json.loads(path.read_text(encoding="utf-8"))
        expected = publication.get("files")
        if not isinstance(expected, dict):
            raise ValueError(f"publication has no file checksum map: {path.name}")
        for relative, expected_digest in expected.items():
            if not isinstance(relative, str) or not isinstance(expected_digest, str):
                raise ValueError(
                    f"publication checksum entry is malformed: {path.name}"
                )
            candidate = source.root / relative
            if not candidate.is_file():
                raise ValueError(f"publication object is missing: {relative}")
            observed = digest(candidate.read_bytes())
            if observed != expected_digest:
                raise ValueError(f"publication checksum mismatch: {relative}")


def _iso(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    return str(value)


def _reward_summary(source: Source, metric_spec: object) -> tuple[list[float], str]:
    import pyarrow.parquet as parquet

    if not isinstance(metric_spec, dict):
        return [], "score"
    metric_path = metric_spec.get("path")
    if not isinstance(metric_path, str):
        return [], "score"
    metrics = parquet.read_table(source.root / metric_path).to_pylist()
    rewards = [
        float(metric["value"])
        for metric in metrics
        if metric.get("name") == "reward" and metric.get("owner_type") == "trial"
    ]
    units = {
        str(metric.get("unit"))
        for metric in metrics
        if metric.get("name") == "reward" and metric.get("unit")
    }
    return rewards, next(iter(units)) if len(units) == 1 else "score"


def _result_entry(
    source: Source, projection_path: Path, migration_id: str
) -> dict[str, object]:
    import pyarrow.parquet as parquet

    projection = json.loads(projection_path.read_text(encoding="utf-8"))
    tables = projection.get("tables", {})
    run_spec = tables.get("runs") if isinstance(tables, dict) else None
    metric_spec = tables.get("metrics") if isinstance(tables, dict) else None
    if not isinstance(run_spec, dict) or not isinstance(run_spec.get("path"), str):
        raise ValueError(f"result projection has no runs table: {projection_path.name}")
    run_rows = parquet.read_table(source.root / run_spec["path"]).to_pylist()
    if len(run_rows) != 1:
        raise ValueError(
            f"result projection runs table must have one row: {projection_path.name}"
        )
    run = run_rows[0]
    rewards, unit = _reward_summary(source, metric_spec)
    return {
        "publication_id": str(run["publication_id"]),
        "campaign_id": str(run["campaign_id"]),
        "run_id": str(run["run_id"]),
        "published_at": _iso(run.get("completed_at") or run["created_at"]),
        "benchmark": run.get("benchmark"),
        "model": run.get("model_id") or run.get("model_repo"),
        "harness": run.get("agent_name"),
        "inference_provider": run.get("provider"),
        "run_outcome": str(run.get("outcome", "published")),
        "quality": run.get("quality"),
        "publication_role": run.get("publication_role"),
        "task_count": int(run.get("planned_trial_count", 0)),
        "scored_task_count": int(run.get("scored_trial_count", 0)),
        "strict_pass_count": sum(value == 1.0 for value in rewards)
        if rewards
        else None,
        "primary_metric": (
            {
                "name": "mean_reward",
                "value": sum(rewards) / len(rewards),
                "unit": unit,
            }
            if rewards
            else None
        ),
        "result_path": (
            f"imports/schema=v1/migration={migration_id}/source={source.name}/"
            f"{projection_path.relative_to(source.root).as_posix()}"
        ),
    }


def build_result_catalog(
    sources: list[Source],
    migration_id: str,
    created_at: str,
    source_digest: str,
) -> dict[str, object] | None:
    try:
        import pyarrow.parquet as parquet

        del parquet
    except ImportError:
        return None
    entries = [
        _result_entry(source, projection_path, migration_id)
        for source in sorted(sources, key=lambda item: item.name)
        for projection_path in sorted(
            (source.root / "projections" / "schema=v1").glob("*.json")
        )
    ]
    if not entries:
        return None
    entries.sort(
        key=lambda entry: (str(entry["published_at"]), str(entry["publication_id"]))
    )
    identity = canonical_bytes({"source_digest": source_digest, "entries": entries})
    return {
        "schema_version": "v1",
        "kind": "result.catalog",
        "record_id": f"catalog-{hashlib.sha256(identity).hexdigest()[:24]}",
        "created_at": created_at,
        "source_digest": source_digest,
        "entries": entries,
    }


def create_immutable(path: Path, data: bytes) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        return True
    except FileExistsError:
        if path.read_bytes() != data:
            raise ValueError(f"immutable destination conflict: {path}") from None
        return False


def _source_inventory(
    sources: list[Source],
) -> tuple[list[Source], dict[str, list[Path]], list[dict[str, object]]]:
    ordered = sorted(sources, key=lambda item: item.name)
    source_files: dict[str, list[Path]] = {}
    inventory: list[dict[str, object]] = []
    for source in ordered:
        if not _NAME.fullmatch(source.name):
            raise ValueError(f"source name is not a safe identifier: {source.name}")
        if not source.root.is_dir():
            raise ValueError(f"source root is not a directory: {source.name}")
        verify_result_publications(source)
        source_files[source.name] = files(source)
        for path in source_files[source.name]:
            data = path.read_bytes()
            inventory.append(
                {
                    "source": source.name,
                    "path": path.relative_to(source.root).as_posix(),
                    "size": len(data),
                    "digest": digest(data),
                }
            )
    return ordered, source_files, inventory


def _write_count(path: Path, data: bytes) -> tuple[int, int]:
    return (1, 0) if create_immutable(path, data) else (0, 1)


def _copy_sources(
    ordered: list[Source],
    source_files: dict[str, list[Path]],
    prefix: Path,
) -> tuple[int, int]:
    created = 0
    adopted = 0
    for source in ordered:
        for path in source_files[source.name]:
            relative = path.relative_to(source.root)
            result = _write_count(
                prefix / f"source={source.name}" / relative,
                path.read_bytes(),
            )
            created += result[0]
            adopted += result[1]
    return created, adopted


@lru_cache(maxsize=1)
def _control_validator() -> Validator:
    schema_path = (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "contracts"
        / "schemas"
        / "control-record-v1.schema.json"
    )
    if not schema_path.is_file():
        raise RuntimeError("control record schema is unavailable")
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _control_record_path(value: dict[str, object]) -> Path:
    kind = str(value.get("kind", ""))
    parts = _CONTROL_PATH_PARTS.get(kind)
    if parts is None:
        raise ValueError("canonical control object kind is not promotable")
    fields = {
        name: str(value.get(name, ""))
        for name in (
            "record_id",
            "campaign_id",
            "action_id",
            "task_id",
            "attempt_id",
            "publication_id",
        )
    }
    return Path("control", "schema=v1", *(part.format_map(fields) for part in parts))


def _validate_control_candidate(relative: Path, data: bytes) -> None:
    if relative.suffix != ".json":
        raise ValueError(f"canonical control object is not JSON: {relative}")
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(
            f"canonical control object is malformed: {relative}"
        ) from error
    if not isinstance(value, dict):
        raise ValueError(f"canonical control object is malformed: {relative}")
    errors = sorted(
        _control_validator().iter_errors(value),
        key=lambda error: tuple(str(item) for item in error.absolute_path),
    )
    if errors:
        raise ValueError(
            f"canonical control object violates the control schema: {relative}"
        )
    if data != canonical_bytes(value):
        raise ValueError(
            f"canonical control object has non-canonical encoding: {relative}"
        )
    if _control_record_path(value) != relative:
        raise ValueError(
            f"canonical control object path does not match its identity: {relative}"
        )


def _validate_canonical_candidate(relative: Path, data: bytes) -> None:
    parts = relative.parts
    control_prefixes = {
        ("control", "schema=v1", "campaigns"),
        ("control", "schema=v1", "migrations"),
    }
    if parts[:3] in control_prefixes:
        _validate_control_candidate(relative, data)
        return
    if parts[:2] == ("results", "schema=v1") and relative.suffix in {
        ".json",
        ".parquet",
    }:
        return
    raise ValueError(f"canonical destination path is not allowed: {relative}")


def _promote_canonical(
    ordered: list[Source],
    source_files: dict[str, list[Path]],
    destination: Path,
) -> tuple[int, int, int]:
    created = 0
    adopted = 0
    promoted = 0
    for source in ordered:
        for path in source_files[source.name]:
            relative = path.relative_to(source.root)
            if not relative.parts or relative.parts[0] != "canonical":
                continue
            canonical_relative = Path(*relative.parts[1:])
            data = path.read_bytes()
            _validate_canonical_candidate(canonical_relative, data)
            result = _write_count(destination / canonical_relative, data)
            created += result[0]
            adopted += result[1]
            promoted += 1
    return created, adopted, promoted


def _write_catalog(
    destination: Path,
    catalog: dict[str, object] | None,
) -> tuple[int, int]:
    if catalog is None:
        return 0, 0
    catalog_path = (
        destination
        / "results"
        / "schema=v1"
        / "catalog"
        / "imports"
        / f"{catalog['record_id']}.json"
    )
    return _write_count(catalog_path, canonical_bytes(catalog))


def _migration_record(
    *,
    ordered: list[Source],
    manifest_digest: str,
    created_at: str,
    actor_subject: str,
    new_writes_enabled: bool,
    source_writes_disabled: bool,
) -> tuple[str, dict[str, object]]:
    source_revisions = {source.name: source.head for source in ordered}
    identity = canonical_bytes(
        {
            "manifest_digest": manifest_digest,
            "new_writes_enabled": new_writes_enabled,
            "source_writes_disabled": source_writes_disabled,
            "source_revisions": source_revisions,
        }
    )
    record_id = f"migration-{hashlib.sha256(identity).hexdigest()[:24]}"
    return record_id, {
        "schema_version": "v1",
        "kind": "migration.record",
        "record_id": record_id,
        "created_at": created_at,
        "actor": {"subject": actor_subject, "role": "migration"},
        "source_revisions": source_revisions,
        "import_digest": manifest_digest,
        "new_writes_enabled": new_writes_enabled,
        "source_writes_disabled": source_writes_disabled,
    }


def migrate(
    *,
    sources: list[Source],
    destination: Path,
    migration_id: str,
    created_at: str,
    actor_subject: str,
    new_writes_enabled: bool,
    source_writes_disabled: bool,
) -> dict[str, Any]:
    if not _NAME.fullmatch(migration_id):
        raise ValueError("migration ID must be a safe identifier")
    parsed_created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    if parsed_created_at.tzinfo is None:
        raise ValueError("created-at must include a timezone")
    ordered, source_files, inventory = _source_inventory(sources)
    manifest = {
        "schema_version": "harbor-hf/legacy-import/v1",
        "migration_id": migration_id,
        "sources": [
            {"name": source.name, "revision": source.head} for source in ordered
        ],
        "files": inventory,
    }
    manifest_data = canonical_bytes(manifest)
    manifest_digest = digest(manifest_data)
    prefix = destination / "imports" / "schema=v1" / f"migration={migration_id}"
    created, adopted = _copy_sources(ordered, source_files, prefix)
    promoted_result = _promote_canonical(ordered, source_files, destination)
    created += promoted_result[0]
    adopted += promoted_result[1]
    result = _write_count(prefix / "manifest.json", manifest_data)
    created += result[0]
    adopted += result[1]
    catalog = build_result_catalog(
        ordered,
        migration_id,
        created_at,
        manifest_digest,
    )
    result = _write_catalog(destination, catalog)
    created += result[0]
    adopted += result[1]
    record_id, record = _migration_record(
        ordered=ordered,
        manifest_digest=manifest_digest,
        created_at=created_at,
        actor_subject=actor_subject,
        new_writes_enabled=new_writes_enabled,
        source_writes_disabled=source_writes_disabled,
    )
    record_path = (
        destination / "control" / "schema=v1" / "migrations" / f"{record_id}.json"
    )
    result = _write_count(record_path, canonical_bytes(record))
    created += result[0]
    adopted += result[1]
    return {
        "migration_id": migration_id,
        "record_id": record_id,
        "import_digest": manifest_digest,
        "file_count": len(inventory),
        "promoted_count": promoted_result[2],
        "created": created,
        "adopted": adopted,
    }


def parse_source(value: str, revisions: dict[str, str]) -> Source:
    name, separator, path = value.partition("=")
    if not separator or name not in revisions:
        raise ValueError(
            "each --source must be NAME=PATH with a matching --source-revision"
        )
    return Source(name, Path(path).resolve(), revisions[name])


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Copy selected legacy state into immutable canonical Bucket paths."
    )
    parser.add_argument("--source", action="append", required=True, metavar="NAME=PATH")
    parser.add_argument(
        "--source-revision", action="append", required=True, metavar="NAME=REVISION"
    )
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--migration-id", required=True)
    parser.add_argument("--created-at", required=True)
    parser.add_argument("--actor-subject", default="operator")
    parser.add_argument("--new-writes-enabled", action="store_true")
    parser.add_argument("--source-writes-disabled", action="store_true")
    arguments = parser.parse_args()
    revisions = dict(item.split("=", 1) for item in arguments.source_revision)
    selected = [parse_source(item, revisions) for item in arguments.source]
    result = migrate(
        sources=selected,
        destination=arguments.destination.resolve(),
        migration_id=arguments.migration_id,
        created_at=arguments.created_at,
        actor_subject=arguments.actor_subject,
        new_writes_enabled=arguments.new_writes_enabled,
        source_writes_disabled=arguments.source_writes_disabled,
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()

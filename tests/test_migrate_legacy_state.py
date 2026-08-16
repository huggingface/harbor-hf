from __future__ import annotations

import json
from pathlib import Path

import pytest

from harbor_hf.migration import Source, canonical_bytes, digest, migrate


def build_source(root: Path, *, valid: bool = True) -> Source:
    data = root / "data" / "runs" / "result.parquet"
    data.parent.mkdir(parents=True)
    data.write_bytes(b"normalized-result")
    publication = root / "publications" / "publication-one.json"
    publication.parent.mkdir(parents=True)
    expected = digest(data.read_bytes()) if valid else f"sha256:{'0' * 64}"
    publication.write_text(
        json.dumps(
            {
                "schema_version": "harbor-hf/result-publication/v1",
                "publication_id": "publication-one",
                "files": {"data/runs/result.parquet": expected},
            }
        ),
        encoding="utf-8",
    )
    return Source("results", root, "source-head-one")


def canonical_campaign_request() -> dict[str, object]:
    return {
        "schema_version": "v1",
        "kind": "campaign.request",
        "record_id": "request-one",
        "created_at": "2026-08-16T00:00:00Z",
        "actor": {"subject": "migration", "role": "migration"},
        "campaign_id": "campaign-one",
        "idempotency_key_digest": f"sha256:{'a' * 64}",
        "profiles": [
            {"kind": "benchmark", "alias": "benchmark-one"},
            {"kind": "model", "alias": "model-one"},
            {"kind": "harness", "alias": "harness-one"},
            {"kind": "deployment", "alias": "deployment-one"},
            {"kind": "launch_policy", "alias": "policy-one"},
        ],
        "ceiling_microusd": 0,
    }


def run(source: Source, destination: Path) -> dict[str, object]:
    return migrate(
        sources=[source],
        destination=destination,
        migration_id="legacy-results-one",
        created_at="2026-08-16T00:00:00Z",
        actor_subject="operator",
        new_writes_enabled=False,
        source_writes_disabled=False,
    )


def test_migration_copies_verified_files_and_writes_control_record(
    tmp_path: Path,
) -> None:
    source = build_source(tmp_path / "source")
    destination = tmp_path / "bucket"

    result = run(source, destination)

    assert result["file_count"] == 2
    imported = (
        destination
        / "imports/schema=v1/migration=legacy-results-one"
        / "source=results/data/runs/result.parquet"
    )
    assert imported.read_bytes() == b"normalized-result"
    records = list((destination / "control/schema=v1/migrations").glob("*.json"))
    assert len(records) == 1
    record = json.loads(records[0].read_text(encoding="utf-8"))
    assert record["import_digest"] == result["import_digest"]
    assert record["new_writes_enabled"] is False

    adopted = run(source, destination)
    assert adopted["created"] == 0
    assert adopted["adopted"] == 4


def test_migration_builds_a_normalized_result_catalog(tmp_path: Path) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    root = tmp_path / "source"
    run_path = (
        root / "data/runs/schema=v1/campaign=campaign-one/publication-one.parquet"
    )
    metric_path = (
        root / "data/metrics/schema=v1/campaign=campaign-one/publication-one.parquet"
    )
    run_path.parent.mkdir(parents=True)
    metric_path.parent.mkdir(parents=True)
    pq.write_table(
        pa.Table.from_pylist(
            [
                {
                    "publication_id": "publication-one",
                    "campaign_id": "campaign-one",
                    "run_id": "run-one",
                    "created_at": "2026-08-15T00:00:00Z",
                    "benchmark": "benchmark-one",
                    "model_id": "model-one",
                    "agent_name": "agent-one",
                    "provider": "provider-one",
                    "outcome": "complete",
                    "quality": "clean",
                    "publication_role": "final",
                    "planned_trial_count": 2,
                    "scored_trial_count": 2,
                }
            ]
        ),
        run_path,
    )
    pq.write_table(
        pa.Table.from_pylist(
            [
                {
                    "name": "reward",
                    "owner_type": "trial",
                    "value": 1.0,
                    "unit": "score",
                },
                {
                    "name": "reward",
                    "owner_type": "trial",
                    "value": 0.5,
                    "unit": "score",
                },
            ]
        ),
        metric_path,
    )
    projection_path = root / "projections/schema=v1/publication-one.json"
    projection_path.parent.mkdir(parents=True)
    projection_path.write_text(
        json.dumps(
            {
                "tables": {
                    "runs": {"path": run_path.relative_to(root).as_posix()},
                    "metrics": {"path": metric_path.relative_to(root).as_posix()},
                }
            }
        ),
        encoding="utf-8",
    )
    publication_path = root / "publications/publication-one.json"
    publication_path.parent.mkdir(parents=True)
    publication_path.write_text(
        json.dumps(
            {
                "files": {
                    path.relative_to(root).as_posix(): digest(path.read_bytes())
                    for path in (run_path, metric_path, projection_path)
                }
            }
        ),
        encoding="utf-8",
    )

    result = run(Source("results", root, "source-head-one"), tmp_path / "bucket")

    catalogs = list(
        (tmp_path / "bucket/results/schema=v1/catalog/imports").glob("*.json")
    )
    assert len(catalogs) == 1
    entry = json.loads(catalogs[0].read_text(encoding="utf-8"))["entries"][0]
    assert entry["primary_metric"] == {
        "name": "mean_reward",
        "unit": "score",
        "value": 0.75,
    }
    assert entry["strict_pass_count"] == 1
    assert result["created"] == 7


def test_migration_promotes_explicit_canonical_control_records(
    tmp_path: Path,
) -> None:
    source = build_source(tmp_path / "source")
    candidate = (
        source.root / "canonical/control/schema=v1/campaigns/campaign-one/request.json"
    )
    candidate.parent.mkdir(parents=True)
    candidate.write_bytes(canonical_bytes(canonical_campaign_request()))
    destination = tmp_path / "bucket"

    result = run(source, destination)

    promoted = destination / "control/schema=v1/campaigns/campaign-one/request.json"
    assert promoted.read_bytes() == candidate.read_bytes()
    assert result["promoted_count"] == 1


def test_migration_rejects_malformed_canonical_control_record(
    tmp_path: Path,
) -> None:
    source = build_source(tmp_path / "source")
    candidate = (
        source.root / "canonical/control/schema=v1/campaigns/campaign-one/request.json"
    )
    candidate.parent.mkdir(parents=True)
    candidate.write_bytes(
        canonical_bytes(
            {
                "schema_version": "v1",
                "kind": "campaign.request",
                "record_id": "request-one",
                "created_at": "2026-08-16T00:00:00Z",
                "actor": {"subject": "migration", "role": "migration"},
            }
        )
    )

    with pytest.raises(ValueError, match="violates the control schema"):
        run(source, tmp_path / "bucket")


def test_migration_rejects_noncanonical_control_encoding(tmp_path: Path) -> None:
    source = build_source(tmp_path / "source")
    candidate = (
        source.root / "canonical/control/schema=v1/campaigns/campaign-one/request.json"
    )
    candidate.parent.mkdir(parents=True)
    candidate.write_text(
        json.dumps(canonical_campaign_request(), indent=2),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="non-canonical encoding"):
        run(source, tmp_path / "bucket")


def test_migration_rejects_canonical_paths_outside_control_and_results(
    tmp_path: Path,
) -> None:
    source = build_source(tmp_path / "source")
    candidate = source.root / "canonical/private/credential.txt"
    candidate.parent.mkdir(parents=True)
    candidate.write_text("not-allowed", encoding="utf-8")

    with pytest.raises(ValueError, match="destination path is not allowed"):
        run(source, tmp_path / "bucket")


def test_migration_rejects_bad_publication_checksum_before_copying(
    tmp_path: Path,
) -> None:
    source = build_source(tmp_path / "source", valid=False)
    destination = tmp_path / "bucket"

    with pytest.raises(ValueError, match="checksum mismatch"):
        run(source, destination)

    assert not destination.exists()

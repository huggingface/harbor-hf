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


def canonical_model_profile() -> dict[str, object]:
    return {
        "schema_version": "v1",
        "kind": "profile.object",
        "record_id": "profile-model-one",
        "created_at": "2026-08-16T00:00:00Z",
        "actor": {"subject": "migration", "role": "migration"},
        "profile_kind": "model",
        "name": "model-one",
        "spec": {
            "model_id": "example/model-one",
            "revision": f"sha256:{'b' * 64}",
        },
    }


def canonical_model_promotion(profile_id: str) -> dict[str, object]:
    return {
        "schema_version": "v1",
        "kind": "profile.promotion",
        "record_id": "promotion-model-one",
        "created_at": "2026-08-16T00:00:01Z",
        "actor": {"subject": "operator", "role": "operator"},
        "profile_kind": "model",
        "alias": "production-model",
        "profile_id": profile_id,
        "promotion_state": "approved",
        "reason": "approved after the recorded canary",
        "evidence": [],
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


def test_canonical_bytes_match_service_number_encoding() -> None:
    assert canonical_bytes({"metric": 1e-7}) == b'{"metric":1e-7}\n'
    assert canonical_bytes({"metric": -0.0}) == b'{"metric":0}\n'


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


def test_migration_promotes_service_canonical_numeric_metrics(
    tmp_path: Path,
) -> None:
    source = build_source(tmp_path / "source")
    attempt = {
        "schema_version": "v1",
        "kind": "attempt.receipt",
        "record_id": "attempt-receipt-one",
        "created_at": "2026-08-16T00:00:01Z",
        "actor": {"subject": "migration", "role": "migration"},
        "campaign_id": "campaign-one",
        "task_id": "task-one",
        "attempt_id": "attempt-one",
        "action_id": "action-one",
        "outcome": "complete",
        "replacement_eligible": False,
        "evidence_digest": f"sha256:{'a' * 64}",
        "evidence_path": "evidence/test",
        "cost_microusd": 0,
        "metrics": {"tiny_metric": 1e-7},
    }
    candidate = source.root / (
        "canonical/control/schema=v1/campaigns/campaign-one/tasks/"
        "task-one/attempts/attempt-one/receipt.json"
    )
    candidate.parent.mkdir(parents=True)
    candidate.write_bytes(canonical_bytes(attempt))
    assert b'"tiny_metric":1e-7' in candidate.read_bytes()
    destination = tmp_path / "bucket"

    result = run(source, destination)

    assert result["promoted_count"] == 1
    promoted = destination / candidate.relative_to(source.root / "canonical")
    assert promoted.read_bytes() == candidate.read_bytes()


def test_migration_promotes_profile_objects_and_approved_aliases(
    tmp_path: Path,
) -> None:
    source = build_source(tmp_path / "source")
    profile = canonical_model_profile()
    profile_id = digest(canonical_bytes(profile))
    promotion = canonical_model_promotion(profile_id)
    profile_path = (
        source.root
        / "canonical/control/schema=v1/profiles/objects/model/profile-model-one.json"
    )
    promotion_path = source.root / (
        "canonical/control/schema=v1/profiles/promotions/model/"
        "production-model/promotion-model-one.json"
    )
    profile_path.parent.mkdir(parents=True)
    promotion_path.parent.mkdir(parents=True)
    profile_path.write_bytes(canonical_bytes(profile))
    promotion_path.write_bytes(canonical_bytes(promotion))
    destination = tmp_path / "bucket"

    result = run(source, destination)

    assert result["promoted_count"] == 2
    assert (
        destination / "control/schema=v1/profiles/objects/model/profile-model-one.json"
    ).read_bytes() == profile_path.read_bytes()
    promoted_alias = destination / (
        "control/schema=v1/profiles/promotions/model/"
        "production-model/promotion-model-one.json"
    )
    assert promoted_alias.read_bytes() == promotion_path.read_bytes()


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

    destination = tmp_path / "bucket"
    with pytest.raises(ValueError, match="violates the control schema"):
        run(source, destination)

    assert not destination.exists()
    candidate.write_bytes(canonical_bytes(canonical_campaign_request()))
    result = run(source, destination)
    assert result["promoted_count"] == 1
    assert (
        destination / "control/schema=v1/campaigns/campaign-one/request.json"
    ).read_bytes() == candidate.read_bytes()


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


def test_migration_preflights_canonical_destination_conflicts(
    tmp_path: Path,
) -> None:
    source = build_source(tmp_path / "source")
    candidate = (
        source.root / "canonical/control/schema=v1/campaigns/campaign-one/request.json"
    )
    candidate.parent.mkdir(parents=True)
    candidate.write_bytes(canonical_bytes(canonical_campaign_request()))
    destination = tmp_path / "bucket"
    promoted = destination / "control/schema=v1/campaigns/campaign-one/request.json"
    promoted.parent.mkdir(parents=True)
    promoted.write_bytes(b"existing-conflict")

    with pytest.raises(ValueError, match="immutable destination conflict"):
        run(source, destination)

    assert promoted.read_bytes() == b"existing-conflict"
    assert not (destination / "imports").exists()
    assert not (destination / "control/schema=v1/migrations").exists()


def test_migration_preflights_invalid_result_projection(tmp_path: Path) -> None:
    source = build_source(tmp_path / "source")
    projection = source.root / "projections/schema=v1/publication-one.json"
    projection.parent.mkdir(parents=True)
    projection.write_text(json.dumps({"tables": {}}), encoding="utf-8")
    destination = tmp_path / "bucket"

    with pytest.raises(ValueError, match="result projection has no runs table"):
        run(source, destination)

    assert not destination.exists()


def test_migration_rejects_bad_publication_checksum_before_copying(
    tmp_path: Path,
) -> None:
    source = build_source(tmp_path / "source", valid=False)
    destination = tmp_path / "bucket"

    with pytest.raises(ValueError, match="checksum mismatch"):
        run(source, destination)

    assert not destination.exists()

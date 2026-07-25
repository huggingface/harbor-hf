from __future__ import annotations

import hashlib
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest

from harbor_hf.evidence import write_checksums
from harbor_hf.publication_envelope import canonical_digest
from harbor_hf.reassessment import (
    ReassessmentError,
    ReassessmentPlan,
    ReassessmentTrial,
    _assert_secrets_absent,
    _checksums,
    _prepare_verifier_tests,
    _publish_success,
    _recover_unambiguous_selection,
    _retain_failed_attempt,
    _reward,
    _source_trial_root,
    _task_config,
    _validate_judge_evidence,
    _write_fixed_zero,
    reassessment_plan_digest,
)


def _plan_payload() -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": "harbor-hf/reassessment-plan/v1",
        "reassessment_id": "reassessment-test",
        "created_at": datetime(2026, 7, 23, tzinfo=UTC)
        .isoformat()
        .replace("+00:00", "Z"),
        "source": {
            "campaign_id": "campaign",
            "run_id": "run",
            "publication_id": "publication",
            "source_checksum": "sha256:" + "a" * 64,
            "result_revision": "b" * 40,
            "index_revision": "c" * 40,
        },
        "judge": {
            "provider": "openai-api",
            "api_url": "https://api.openai.com/v1/chat/completions",
            "model": "gpt-5.6-luna",
            "reasoning_effort": "xhigh",
            "strip_temperature": True,
            "api_key_secret_name": "OPENAI_API_KEY",
        },
        "verifier_judge_timeout_seconds": 900,
        "harbor_hf_revision": "d" * 40,
        "benchmark_repository": "ShellBench/public-tasks",
        "benchmark_revision": "e" * 40,
        "runtime_image": "hf.co/spaces/example/runtime",
        "output_prefix": "reassessments/test",
        "judge_policy": {
            "workspace_root": "/app",
            "workspace_max_nodes": 1000,
            "workspace_max_file_bytes": 1048576,
            "workspace_max_total_bytes": 8388608,
            "workspace_max_archive_bytes": 8388608,
            "workspace_capture_timeout_seconds": 60,
            "judge_max_request_bytes": 1048576,
            "judge_max_response_bytes": 1048576,
            "judge_timeout_seconds": 300,
            "judge_max_calls_per_execution": 4,
        },
        "trials": [
            {
                "trial_id": "trial-" + "1" * 24,
                "task_name": "task",
                "task_digest": "sha256:" + "2" * 64,
                "logical_attempt": 1,
                "source_execution_id": "exec-" + "3" * 32,
                "source_trial_path": "runs/run/trials/trial-" + "1" * 24,
                "source_outcome": "scored",
                "source_reward": 1.0,
                "action": "rejudge",
            }
        ],
    }
    payload["plan_digest"] = reassessment_plan_digest(payload)
    return payload


def test_plan_digest_and_identity_are_fail_closed() -> None:
    payload = _plan_payload()
    plan = ReassessmentPlan.model_validate_json(json.dumps(payload))
    assert plan.judge.model == "gpt-5.6-luna"
    payload["output_prefix"] = "reassessments/tampered"
    with pytest.raises(ValueError, match="digest mismatch"):
        ReassessmentPlan.model_validate_json(json.dumps(payload))


def test_gemini_judge_configuration_is_supported_and_fail_closed() -> None:
    payload = _plan_payload()
    payload["judge"] = {
        "provider": "google-gemini-api",
        "api_url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "model": "gemini-3.6-flash",
        "reasoning_effort": None,
        "strip_temperature": True,
        "api_key_secret_name": "GEMINI_API_KEY",
    }
    payload["plan_digest"] = reassessment_plan_digest(
        {key: value for key, value in payload.items() if key != "plan_digest"}
    )
    plan = ReassessmentPlan.model_validate_json(json.dumps(payload))
    assert plan.judge.model == "gemini-3.6-flash"
    judge = payload["judge"]
    assert isinstance(judge, dict)
    judge["api_key_secret_name"] = "OPENAI_API_KEY"
    payload["plan_digest"] = reassessment_plan_digest(
        {key: value for key, value in payload.items() if key != "plan_digest"}
    )
    with pytest.raises(ValueError, match="provider configuration"):
        ReassessmentPlan.model_validate_json(json.dumps(payload))


def test_fixed_zero_requires_agent_failure() -> None:
    base = _plan_payload()["trials"]
    assert isinstance(base, list)
    first = base[0]
    assert isinstance(first, dict)
    trial = dict(first)
    trial.update(source_outcome="agent_failed", action="fixed_zero", source_reward=0.0)
    parsed = ReassessmentTrial.model_validate(trial)
    assert parsed.action == "fixed_zero"
    trial["source_reward"] = 1.0
    with pytest.raises(ValueError, match="nonzero"):
        ReassessmentTrial.model_validate(trial)


def test_source_trial_is_checksum_bound_before_reassessment(tmp_path: Path) -> None:
    payload = _plan_payload()
    raw_trials = payload["trials"]
    assert isinstance(raw_trials, list)
    raw_trial = raw_trials[0]
    assert isinstance(raw_trial, dict)
    raw_trial = cast(dict[str, object], raw_trial)
    trial_id = str(raw_trial["trial_id"])
    execution_id = str(raw_trial["source_execution_id"])
    evidence_root = tmp_path / "evidence"
    trial_root = evidence_root / "runs" / "run" / "trials" / trial_id
    execution = trial_root / "executions" / execution_id
    execution.mkdir(parents=True)
    (execution / "execution.lock.json").write_text(
        json.dumps(
            {
                "execution_id": execution_id,
                "trial_id": trial_id,
                "task_name": raw_trial["task_name"],
                "task_digest": raw_trial["task_digest"],
                "logical_attempt": raw_trial["logical_attempt"],
            }
        ),
        encoding="utf-8",
    )
    archive = execution / "workspace.tar.zst"
    archive.write_bytes(b"frozen workspace")
    trial_manifest = trial_root / "checksums.json"
    write_checksums(trial_root)
    trial_manifest_digest = (
        "sha256:" + hashlib.sha256(trial_manifest.read_bytes()).hexdigest()
    )
    run_manifest = {f"trials/{trial_id}/checksums.json": trial_manifest_digest}
    (trial_root.parent.parent / "checksums.json").write_text(
        json.dumps(run_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    source = payload["source"]
    assert isinstance(source, dict)
    source = cast(dict[str, object], source)
    source["source_checksum"] = canonical_digest(run_manifest)
    payload["plan_digest"] = reassessment_plan_digest(
        {key: value for key, value in payload.items() if key != "plan_digest"}
    )
    plan = ReassessmentPlan.model_validate_json(json.dumps(payload))
    trial = plan.trials[0]

    assert _source_trial_root(evidence_root, trial, plan.source) == trial_root

    archive.write_bytes(b"modified workspace")
    with pytest.raises(ReassessmentError, match="checksum evidence is invalid"):
        _source_trial_root(evidence_root, trial, plan.source)

    write_checksums(trial_root)
    with pytest.raises(ReassessmentError, match="not bound to the run"):
        _source_trial_root(evidence_root, trial, plan.source)


def test_reassessment_accepts_compliant_untransformed_judge_request(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    judge_root = tmp_path / "judge-records"
    exchange_root = judge_root / "judge-0001"
    exchange_root.mkdir(parents=True)
    (exchange_root / "request-forwarded.bin").write_text(
        json.dumps({"model": "gemini-3.6-flash"}), encoding="utf-8"
    )
    (tmp_path / "verifier").mkdir()
    monkeypatch.setattr(
        "harbor_hf.reassessment.verify_judge_recorder_summary",
        lambda _path: SimpleNamespace(exchange_count=1, rejected_call_count=0),
    )
    monkeypatch.setattr(
        "harbor_hf.reassessment.verify_judge_exchange",
        lambda _path: SimpleNamespace(
            provider="google-gemini-api",
            forwarded_model="gemini-3.6-flash",
            outcome="success",
            transformation="none",
        ),
    )

    count = _validate_judge_evidence(
        tmp_path,
        expected_provider="google-gemini-api",
        expected_model="gemini-3.6-flash",
        expected_reasoning_effort=None,
    )

    assert count == 1
    assert (tmp_path / "verifier" / "judge-selection.json").is_file()


def test_reward_prefers_structured_scores_and_bounds_values(tmp_path: Path) -> None:
    verifier = tmp_path / "verifier"
    verifier.mkdir()
    (verifier / "agent_judge_results.json").write_text(
        json.dumps({"normal_plus_safety_score": 1.0, "reward": 0.0})
    )
    assert _reward(verifier) == 1.0
    (verifier / "agent_judge_results.json").unlink()
    (verifier / "reward.json").write_text(json.dumps({"reward": 0.75}))
    (verifier / "reward.txt").write_text("1.0\n")
    assert _reward(verifier) == 0.75
    (verifier / "reward.json").unlink()
    (verifier / "reward.txt").unlink()
    (verifier / "agent_judge_results.json").write_text(
        json.dumps({"normal_plus_safety_score": 2.0})
    )
    with pytest.raises(ReassessmentError, match="bounded reward"):
        _reward(verifier)
    (verifier / "agent_judge_results.json").write_text(
        json.dumps({"status": "infra_error", "reward": 0.0})
    )
    with pytest.raises(ReassessmentError, match="infrastructure error"):
        _reward(verifier)


def test_secret_scan_and_checksums_fail_closed(tmp_path: Path) -> None:
    (tmp_path / "safe.txt").write_text("safe")
    checksums = _checksums(tmp_path)
    assert checksums == {
        "safe.txt": "sha256:"
        + "8b3369944dd2a3fab39e32d1aeb1f763946a458ae3e6368a46432adc8f3a0860"
    }
    _assert_secrets_absent(tmp_path, ("secret",))
    (tmp_path / "unsafe.txt").write_text("contains-secret")
    with pytest.raises(ReassessmentError, match="known secret"):
        _assert_secrets_absent(tmp_path, ("secret",))


def test_recovers_only_unambiguous_missing_judge_selection(tmp_path: Path) -> None:
    verifier = tmp_path / "verifier"
    verifier.mkdir()
    _recover_unambiguous_selection(tmp_path, ["judge-0001"])
    assert json.loads((verifier / "judge-selection.json").read_text()) == {
        "schema_version": "harbor-hf/judge-selection/v1",
        "exchange_id": "judge-0001",
    }
    assert json.loads((verifier / "judge-calls.json").read_text())["exchange_ids"] == [
        "judge-0001"
    ]
    assert (
        json.loads((tmp_path / "judge-selection-recovery.json").read_text())["basis"]
        == "only_successful_recorded_exchange"
    )


def test_does_not_recover_ambiguous_judge_selection(tmp_path: Path) -> None:
    verifier = tmp_path / "verifier"
    verifier.mkdir()
    _recover_unambiguous_selection(tmp_path, ["judge-0001", "judge-0002"])
    assert list(verifier.iterdir()) == []
    assert not (tmp_path / "judge-selection-recovery.json").exists()


def test_verifier_timeout_transform_is_recorded(tmp_path: Path) -> None:
    task = tmp_path / "task"
    tests = task / "tests"
    tests.mkdir(parents=True)
    (tests / "judge.py").write_text(
        "urllib.request.urlopen(request, timeout=120)\n"
        "urllib.request.urlopen(local_request, timeout=5)\n"
    )
    transformed, metadata = _prepare_verifier_tests(task, 900, "a" * 40)
    try:
        content = (transformed / "judge.py").read_text()
        assert "timeout=900" in content
        assert "timeout=5" in content
        assert metadata["timeout_replacement_count"] == 1
        assert metadata["source_tree_digest"] != metadata["effective_tree_digest"]
    finally:
        shutil.rmtree(transformed.parent)


def test_failed_attempt_is_preserved_before_retry_success(tmp_path: Path) -> None:
    final = tmp_path / "trial"
    failed = tmp_path / "failed"
    failed.mkdir()
    (failed / "recorder.json").write_text(
        '{"rejected_error_types":["TrialEvidenceError"]}\n'
    )
    _retain_failed_attempt(
        staging=failed,
        final=final,
        execution_id="rejudge-" + "1" * 32,
        error=ReassessmentError("unsafe detail"),
        known_secrets=("secret",),
    )
    attempt = final / "attempts" / ("rejudge-" + "1" * 32)
    assert (attempt / "_FAILED").is_file()
    assert "unsafe detail" not in (attempt / "failure.json").read_text()

    success = tmp_path / "success"
    success.mkdir()
    (success / "result.json").write_text("{}\n")
    (success / "_SUCCESS").write_text("")
    _publish_success(success, final)
    assert (final / "_SUCCESS").is_file()
    assert attempt.is_dir()


def test_task_config_uses_harbor_default_verifier_command(tmp_path: Path) -> None:
    tasks = tmp_path / "tasks"
    task = tasks / "task"
    task.mkdir(parents=True)
    (task / "task.toml").write_text(
        '[environment]\ndocker_image = "hf.co/spaces/example/runtime"\n'
        "[verifier]\ntimeout_sec = 600\n"
    )
    raw_trials = _plan_payload()["trials"]
    assert isinstance(raw_trials, list)
    first = raw_trials[0]
    assert isinstance(first, dict)
    trial = ReassessmentTrial.model_validate(first)
    _, image, command = _task_config(tasks, trial)
    assert image == "hf.co/spaces/example/runtime"
    assert command == "bash tests/test.sh"


def test_write_fixed_zero_is_append_only(tmp_path: Path) -> None:
    payload = _plan_payload()
    raw_trials = payload["trials"]
    assert isinstance(raw_trials, list)
    first = raw_trials[0]
    assert isinstance(first, dict)
    raw_trial = dict(first)
    raw_trial.update(
        source_outcome="agent_failed", action="fixed_zero", source_reward=0.0
    )
    payload["trials"] = [raw_trial]
    payload.pop("plan_digest")
    payload["plan_digest"] = reassessment_plan_digest(payload)
    plan = ReassessmentPlan.model_validate_json(json.dumps(payload))
    trial = plan.trials[0]
    source = tmp_path / "source"
    source_execution = source / "executions" / trial.source_execution_id
    source_execution.mkdir(parents=True)
    (source_execution / "checksums.json").write_text("{}\n")
    output = tmp_path / "output"

    _write_fixed_zero(output, trial, source, plan)
    final = output / "trials" / trial.trial_id
    assert (final / "_SUCCESS").is_file()
    assert json.loads((final / "result.json").read_text())["reward"] == 0.0
    before = (final / "checksums.json").read_bytes()
    _write_fixed_zero(output, trial, source, plan)
    assert (final / "checksums.json").read_bytes() == before

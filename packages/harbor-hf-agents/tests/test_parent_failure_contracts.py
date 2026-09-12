"""Fail-closed parent input and immutable local evidence contracts."""

import json
from uuid import uuid4

import pytest
from test_parent_worker import RUN_ID, record

from harbor_hf_agents import parent_worker as worker


@pytest.mark.parametrize("value", [None, [], "not-an-object"])
def test_record_requires_object(tmp_path, value):
    path = tmp_path / "runs" / RUN_ID / "run.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="run record must be an object"):
        worker.load_run_record(tmp_path, RUN_ID)


@pytest.mark.parametrize("run_id", ["", "../escape", "run-invalid"])
def test_invalid_assignment_rejected_without_storage_access(tmp_path, run_id):
    with pytest.raises(ValueError, match="RUN_ID is invalid"):
        worker.load_run_record(tmp_path, run_id)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    "field,value,message",
    [
        ("job_name", "other", "job path"),
        ("jobs_dir", "/unowned", "job path"),
        ("environment", {"import_path": "other:Environment"}, "labeled HF environment"),
        (
            "environment",
            {
                "import_path": (
                    "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment"
                ),
                "kwargs": {"run_label": "other"},
            },
            "child Job label",
        ),
    ],
)
def test_config_cannot_redirect_parent_ownership(tmp_path, field, value, message):
    data = record(tmp_path)
    data["harbor_job_config"][field] = value
    with pytest.raises(ValueError, match=message):
        worker.job_config(data, tmp_path, RUN_ID)


@pytest.mark.parametrize(
    "value", [True, "1", [], 0, -1, 10001, float("inf"), float("nan")]
)
def test_invalid_cost_ceiling_rejected(value):
    with pytest.raises(ValueError, match="cost ceiling must be"):
        worker.cost_ceiling({"submission": {"cost_ceiling_usd": value}})


def test_receipt_replay_idempotent_but_changed_evidence_conflicts(tmp_path):
    receipt = worker.AttemptCostReceipt(
        attempt_id=uuid4(), trial_name="trial", cost_usd=0.1
    )
    worker._write_receipt(tmp_path, receipt)
    path = tmp_path / "attempt-costs" / f"{receipt.attempt_id}.json"
    original = path.read_bytes()
    worker._write_receipt(tmp_path, receipt)
    assert path.read_bytes() == original
    changed = receipt.model_copy(update={"cost_usd": 0.2})
    with pytest.raises(RuntimeError, match="conflicts with durable evidence"):
        worker._write_receipt(tmp_path, changed)
    assert path.read_bytes() == original
    assert worker.load_attempt_costs(tmp_path) == {receipt.attempt_id: receipt}


def test_receipt_path_identity_is_authoritative(tmp_path):
    receipt = worker.AttemptCostReceipt(
        attempt_id=uuid4(), trial_name="trial", cost_usd=None
    )
    directory = tmp_path / "attempt-costs"
    directory.mkdir()
    (directory / "incorrect.json").write_text(receipt.model_dump_json())
    with pytest.raises(RuntimeError, match="path does not match its id"):
        worker.load_attempt_costs(tmp_path)


def test_failed_atomic_receipt_write_removes_temporary_file(tmp_path, monkeypatch):
    receipt = worker.AttemptCostReceipt(
        attempt_id=uuid4(), trial_name="trial", cost_usd=0.1
    )

    def fail_replace(source, destination):
        assert source.read_text().strip() == receipt.model_dump_json(indent=2)
        assert destination.name == f"{receipt.attempt_id}.json"
        raise OSError("synthetic storage failure")

    monkeypatch.setattr(worker.os, "replace", fail_replace)
    with pytest.raises(OSError, match="synthetic storage failure"):
        worker._write_receipt(tmp_path, receipt)
    assert list((tmp_path / "attempt-costs").iterdir()) == []


@pytest.mark.parametrize("state", [[], None, {}, {"desired_state": "paused"}])
def test_local_control_state_read_contract(tmp_path, state):
    (tmp_path / "state.json").write_text(json.dumps(state))
    expected = "paused" if state == {"desired_state": "paused"} else "run"
    assert worker._desired_state(tmp_path) == expected


def test_cleanup_rejects_escape_and_preserves_sibling(tmp_path):
    job = tmp_path / "job"
    job.mkdir()
    protected = tmp_path / "protected"
    protected.mkdir()
    (protected / "evidence").write_text("unchanged")
    with pytest.raises(RuntimeError, match="escapes the Harbor job folder"):
        worker.cleanup_interrupted_trial(tmp_path, "../protected")
    assert (protected / "evidence").read_text() == "unchanged"


def test_nested_stop_group_only_identifies_controlled_trials():
    error = ExceptionGroup(
        "native errors",
        [
            ValueError("other"),
            ExceptionGroup("nested", [worker.ControlledRunStop("trial-1")]),
        ],
    )
    assert worker._interrupted_trial_names(error) == ["trial-1"]


@pytest.mark.asyncio
async def test_invalid_parent_assignment_cannot_construct_sdk(monkeypatch):
    monkeypatch.setenv("HARBOR_HF_RUN_ID", "invalid")

    def forbidden():
        pytest.fail("SDK constructed before assignment validation")

    monkeypatch.setattr(worker, "HfApi", forbidden)
    with pytest.raises(ValueError, match="RUN_ID is invalid"):
        await worker.run_parent()

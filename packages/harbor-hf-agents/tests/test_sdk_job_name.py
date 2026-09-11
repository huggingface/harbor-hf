"""Offline wrapper regressions through the installed SDK's HTTP payload builder."""

from hashlib import sha256
from unittest.mock import patch

import httpx
import pytest
from harbor.environments.hf_sandbox import HFSandboxEnvironment

from harbor_hf_agents.hf_sandbox import (
    _JOB_CONTEXT,
    LabeledHFSandboxEnvironment,
    _LabeledHfApi,
    _sandbox_job_name,
)

RUN_ID = "run-" + "a" * 24


@pytest.mark.parametrize(
    ("environment_name", "safe_name"),
    [
        ("install-windows-3.11", "install-windows-3-11"),
        ("task name/ü", "task-name"),
        ("...", "trial"),
    ],
)
def test_sandbox_job_name_uses_valid_label_characters(environment_name, safe_name):
    digest = sha256(environment_name.encode()).hexdigest()[:12]
    assert _sandbox_job_name(environment_name) == f"harbor-{safe_name}-{digest}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "environment_name",
    ["task-one", "task-two", "install-windows-3.11", "task-" * 50],
)
@pytest.mark.parametrize(
    ("supplied", "expected"),
    [
        ({}, None),
        ({"name": None}, None),
        ({"name": "explicit-name"}, "explicit-name"),
        ({"name": ""}, ""),
        ({"labels": {"name": "label-name"}}, "label-name"),
        ({"name": None, "labels": {"name": "label-name"}}, "label-name"),
        (
            {"name": "explicit-name", "labels": {"name": "label-name"}},
            "conflict",
        ),
    ],
)
async def test_contextual_name_preserves_payload(
    environment_name, supplied, expected, monkeypatch
):
    image = "registry.example/namespace/" + "long-image-" * 20 + "@sha256:" + "b" * 64
    command = ["echo", "command-must-not-appear-in-name"]
    labels = {
        "hf-sandbox": "1",
        "harbor-hf-role": "wrong-role",
        "harbor-hf-run": "wrong-run",
        **supplied.get("labels", {}),
    }

    async def start(_self, _force_build):
        _LabeledHfApi(token=False).run_job(
            image=image,
            command=command,
            flavor="cpu-basic",
            namespace="wrong-namespace",
            **{**supplied, "labels": labels},
        )

    monkeypatch.setattr(HFSandboxEnvironment, "start", start)
    monkeypatch.setenv("HARBOR_HF_NAMESPACE", "test-namespace")
    environment = object.__new__(LabeledHFSandboxEnvironment)
    environment._run_label = RUN_ID
    environment.environment_name = environment_name
    with patch("huggingface_hub.hf_api.get_session") as session:
        session.return_value.post.return_value = httpx.Response(
            200,
            request=httpx.Request("POST", "https://example.com/jobs"),
            json={
                "id": "job-id",
                "owner": {"id": "1234", "name": "namespace", "type": "user"},
                "status": {"stage": "PENDING"},
            },
        )
        if expected == "conflict":
            with pytest.raises(ValueError, match="cannot both be provided"):
                await environment.start(False)
            session.return_value.post.assert_not_called()
            assert _JOB_CONTEXT.get() is None
            return
        await environment.start(False)
    assert _JOB_CONTEXT.get() is None
    payload = session.return_value.post.call_args.kwargs["json"]
    assert payload["dockerImage"] == image
    assert payload["command"] == command
    assert "/jobs/test-namespace" in session.return_value.post.call_args.args[0]
    assert payload["labels"] == {
        "hf-sandbox": "1",
        "harbor-hf-role": "trial",
        "harbor-hf-run": RUN_ID,
        "name": expected
        if expected is not None
        else _sandbox_job_name(environment_name),
    }
    assert len(payload["labels"]["name"]) <= 90
    if expected is None:
        assert payload["labels"]["name"].replace("-", "").replace("_", "").isalnum()
    assert labels["harbor-hf-role"] == "wrong-role"
    assert environment.environment_name == environment_name


def test_uncontextual_call_is_unchanged():
    from huggingface_hub import HfApi

    with patch.object(HfApi, "run_job") as run_job:
        _LabeledHfApi(token=False).run_job(image="python:3.12", labels={"custom": "1"})
    run_job.assert_called_once_with(image="python:3.12", labels={"custom": "1"})


@pytest.mark.asyncio
async def test_invalid_labels_still_fail_and_reset_context(monkeypatch):
    async def start(_self, _force_build):
        _LabeledHfApi(token=False).run_job(labels=["invalid"])

    monkeypatch.setattr(HFSandboxEnvironment, "start", start)
    monkeypatch.setenv("HARBOR_HF_NAMESPACE", "test-namespace")
    environment = object.__new__(LabeledHFSandboxEnvironment)
    environment._run_label = RUN_ID
    environment.environment_name = "task"
    with pytest.raises(TypeError, match="labels must be a dictionary"):
        await environment.start(False)
    assert _JOB_CONTEXT.get() is None

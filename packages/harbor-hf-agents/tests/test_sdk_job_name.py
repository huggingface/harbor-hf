"""Offline regressions against the actual installed SDK; never submit a Job."""

import hashlib
from unittest.mock import patch

import httpx
import pytest
from huggingface_hub import HfApi
from huggingface_hub._jobs_api import _default_job_name_from_image


@pytest.mark.parametrize("tag", ["", ":3.12"])
def test_default_job_name_digest_is_only_removed_from_readable_name(tag: str) -> None:
    command = ["python", "-c", "print(1)"]
    names = []
    for digest in ["a" * 64, "b" * 64]:
        image = f"registry.example/namespace/benchmark-task-image{tag}@sha256:{digest}"
        name = _default_job_name_from_image(image, command)
        expected_hash = hashlib.sha256(
            "\x00".join([image, *command]).encode()
        ).hexdigest()[:8]
        base = "benchmark-task-image" + ("-3-12" if tag else "")
        assert name == f"{base}-{expected_hash}"
        assert len(name) < 100
        names.append(name)
    assert names[0] != names[1]


@pytest.mark.parametrize("explicit_name", [None, "custom-name"])
@pytest.mark.parametrize(
    "image", ["python:3.12", "registry.example/namespace/task@sha256:" + "a" * 64]
)
def test_run_job_name_preserves_image_payload(
    image: str, explicit_name: str | None
) -> None:
    command = ["echo", "hello"]
    with patch("huggingface_hub.hf_api.get_session") as session:
        session.return_value.post.return_value = httpx.Response(
            200,
            request=httpx.Request("POST", "https://example.com/jobs"),
            json={
                "id": "job-id",
                "owner": {"id": "1234", "name": "user", "type": "user"},
                "status": {"stage": "PENDING"},
            },
        )
        HfApi(token=False).run_job(
            image=image,
            command=command,
            flavor="cpu-basic",
            namespace="namespace",
            name=explicit_name,
        )
    payload = session.return_value.post.call_args.kwargs["json"]
    assert payload["dockerImage"] == image
    assert payload["command"] == command
    assert payload["labels"]["name"] == (
        explicit_name or _default_job_name_from_image(image, command)
    )

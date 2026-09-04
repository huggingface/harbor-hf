"""Harbor HF Sandbox environment with atomic run labels."""

from __future__ import annotations

import os
import re
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, cast, override

import huggingface_hub._sandbox as sandbox_module
from harbor.environments.hf_sandbox import HFSandboxEnvironment
from huggingface_hub import HfApi

_RUN_ID = re.compile(r"^run-[0-9a-f]{24}$")
_INFERENCE_TOKEN_TEMPLATE = "$" + "{HF_INFERENCE_TOKEN}"
_SUPPORTED_INFERENCE_KEYS = frozenset({"HF_TOKEN", "OPENAI_API_KEY"})


@dataclass(frozen=True)
class _JobContext:
    labels: dict[str, str]
    namespace: str


_JOB_CONTEXT: ContextVar[_JobContext | None] = ContextVar(
    "harbor_hf_job_context", default=None
)


class _LabeledHfApi(HfApi):
    """Merge contextual ownership into Sandbox Job creation."""

    @override
    def run_job(
        self,
        *args: Any,  # noqa: ANN401 -- mirrors the Hub client method
        **kwargs: Any,  # noqa: ANN401 -- mirrors the Hub client method
    ) -> Any:  # noqa: ANN401 -- return type follows the Hub client
        context = _JOB_CONTEXT.get()
        if context:
            supplied = kwargs.get("labels")
            if supplied is not None and not isinstance(supplied, dict):
                raise TypeError("Sandbox Job labels must be a dictionary")
            kwargs["labels"] = {**(supplied or {}), **context.labels}
            kwargs["namespace"] = context.namespace
        return super().run_job(*args, **kwargs)


sandbox_api = cast(Any, sandbox_module)
if sandbox_module.HfApi is HfApi:
    sandbox_api.HfApi = _LabeledHfApi
elif sandbox_module.HfApi is not _LabeledHfApi:
    raise RuntimeError("unsupported Hugging Face Sandbox API binding")


def _resolve_inference_env(values: dict[str, str] | None) -> dict[str, str] | None:
    if not values or _INFERENCE_TOKEN_TEMPLATE not in values.values():
        return values
    token = os.environ.get("HF_INFERENCE_TOKEN", "")
    if not token:
        raise RuntimeError("HF_INFERENCE_TOKEN is required for agent execution")
    resolved = dict(values)
    for key, value in resolved.items():
        if value == _INFERENCE_TOKEN_TEMPLATE:
            if key not in _SUPPORTED_INFERENCE_KEYS:
                raise RuntimeError("unsupported inference credential template")
            resolved[key] = token
    return resolved


class LabeledHFSandboxEnvironment(HFSandboxEnvironment):
    """Create each child Job with its Harbor-HF ownership labels."""

    def __init__(
        self,
        *args: Any,  # noqa: ANN401 -- Harbor environment API
        run_label: str,
        **kwargs: Any,  # noqa: ANN401 -- Harbor environment API
    ) -> None:
        if not _RUN_ID.fullmatch(run_label):
            raise ValueError("run_label must be a Harbor-HF run id")
        self._run_label = run_label
        super().__init__(*args, **kwargs)

    @override
    async def start(self, force_build: bool) -> None:
        namespace = os.environ.get("HARBOR_HF_NAMESPACE", "").strip()
        if not namespace:
            raise RuntimeError("HARBOR_HF_NAMESPACE is required for child Jobs")
        token = _JOB_CONTEXT.set(
            _JobContext(
                labels={
                    "harbor-hf-role": "trial",
                    "harbor-hf-run": self._run_label,
                },
                namespace=namespace,
            )
        )
        try:
            await super().start(force_build)
        finally:
            _JOB_CONTEXT.reset(token)

    @override
    def _merge_env(self, env: dict[str, str] | None) -> dict[str, str] | None:
        return _resolve_inference_env(super()._merge_env(env))

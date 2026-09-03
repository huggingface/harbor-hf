"""Harbor HF Sandbox environment with atomic run labels."""

from __future__ import annotations

import re
from contextvars import ContextVar
from typing import Any, cast, override

import huggingface_hub._sandbox as sandbox_module
from harbor.environments.hf_sandbox import HFSandboxEnvironment
from huggingface_hub import HfApi

_RUN_ID = re.compile(r"^run-[0-9a-f]{24}$")
_JOB_LABELS: ContextVar[dict[str, str] | None] = ContextVar(
    "harbor_hf_job_labels", default=None
)


class _LabeledHfApi(HfApi):
    """Merge contextual ownership labels into Sandbox Job creation."""

    @override
    def run_job(
        self,
        *args: Any,  # noqa: ANN401 -- mirrors the Hub client method
        **kwargs: Any,  # noqa: ANN401 -- mirrors the Hub client method
    ) -> Any:  # noqa: ANN401 -- return type follows the Hub client
        ownership = _JOB_LABELS.get()
        if ownership:
            supplied = kwargs.get("labels")
            if supplied is not None and not isinstance(supplied, dict):
                raise TypeError("Sandbox Job labels must be a dictionary")
            kwargs["labels"] = {**(supplied or {}), **ownership}
        return super().run_job(*args, **kwargs)


sandbox_api = cast(Any, sandbox_module)
if sandbox_module.HfApi is HfApi:
    sandbox_api.HfApi = _LabeledHfApi
elif sandbox_module.HfApi is not _LabeledHfApi:
    raise RuntimeError("unsupported Hugging Face Sandbox API binding")


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
        token = _JOB_LABELS.set(
            {
                "harbor-hf-role": "trial",
                "harbor-hf-run": self._run_label,
            }
        )
        try:
            await super().start(force_build)
        finally:
            _JOB_LABELS.reset(token)

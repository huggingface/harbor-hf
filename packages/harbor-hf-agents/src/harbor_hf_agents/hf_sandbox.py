"""Harbor HF Sandbox environment with run labels for child cleanup."""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any, override

from harbor.environments.hf_sandbox import HFSandboxEnvironment
from huggingface_hub import HfApi

_RUN_ID = re.compile(r"^run-[0-9a-f]{24}$")


class LabeledHFSandboxEnvironment(HFSandboxEnvironment):
    """Add the owning Harbor-HF run id to each child Sandbox Job."""

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
        await super().start(force_build)
        sandbox = self._require_sandbox()
        namespace = os.environ.get("HARBOR_HF_NAMESPACE")
        try:
            await asyncio.to_thread(
                HfApi().update_job_labels,
                job_id=sandbox.id,
                labels={
                    "harbor-hf-role": "trial",
                    "harbor-hf-run": self._run_label,
                },
                namespace=namespace,
            )
        except Exception:
            await self.stop(delete=True)
            raise

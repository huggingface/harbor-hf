"""Terminus 2 over the Harbor-HF Job inference route."""

from typing import override

from harbor.agents.terminus_2 import Terminus2
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.support.hf_inference_bridge import (
    mark_hf_inference_bridge_active,
)
from harbor_hf_agents.support.job_chat_completions import allowed_model_id
from harbor_hf_agents.support.job_inference_route import (
    load_job_inference_route,
    with_job_inference_bridge_cleanup,
)


class TerminusAgent(Terminus2):
    """Run pinned Terminus 2 through the locked Chat Completions bridge."""

    def _validate_configured_route(self, *, base_url: str, api_key: str) -> None:
        llm = self._llm
        if getattr(llm, "_api_base", None) != base_url:
            raise RuntimeError(
                "Terminus API base does not match the Job inference route"
            )
        llm_kwargs = getattr(llm, "_llm_kwargs", None)
        if not isinstance(llm_kwargs, dict) or llm_kwargs.get("api_key") != api_key:
            raise RuntimeError(
                "Terminus API key does not match the Job inference route"
            )
        if getattr(llm, "_use_responses_api", None) is not False:
            raise RuntimeError("Terminus must use the Chat Completions route")

    @override
    @with_job_inference_bridge_cleanup
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        route = load_job_inference_route(
            api="chat-completions",
            allowed_model=allowed_model_id(self._model_name),
        )
        if route is None:
            raise RuntimeError("Terminus requires the Job inference route")
        mark_hf_inference_bridge_active(self, kind="job")
        self._validate_configured_route(
            base_url=route.base_url,
            api_key=route.api_key,
        )
        await super().run(instruction, environment, context)

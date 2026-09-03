from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from harbor_hf.evidence import is_sensitive_key

ProviderProfileId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")]
HF_INFERENCE_PROVIDER_BASE_URL = "https://router.huggingface.co"


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PolicyRoute(FrozenModel):
    kind: Literal["policy"] = "policy"
    policy: Literal["fastest", "cheapest", "preferred"] = "fastest"


class ExplicitProviderRoute(FrozenModel):
    kind: Literal["provider"] = "provider"
    provider: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9-]*$")


ProviderRoute = Annotated[
    PolicyRoute | ExplicitProviderRoute,
    Field(discriminator="kind"),
]


class ProviderLimits(FrozenModel):
    max_concurrent_requests: int = Field(default=1, ge=1)
    max_attempts: int = Field(default=1, ge=1)
    max_spend_usd: Decimal | None = Field(default=None, gt=0)
    estimated_wave_cost_usd: Decimal | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def spend_cap_has_an_admission_estimate(self) -> ProviderLimits:
        if (self.max_spend_usd is None) != (self.estimated_wave_cost_usd is None):
            raise ValueError(
                "provider spend caps and estimated wave costs must be "
                "configured together"
            )
        if (
            self.max_spend_usd is not None
            and self.estimated_wave_cost_usd is not None
            and self.estimated_wave_cost_usd > self.max_spend_usd
        ):
            raise ValueError("estimated provider wave cost exceeds its spend cap")
        return self


class ProviderTarget(FrozenModel):
    id: ProviderProfileId
    kind: Literal["inference-provider"] = "inference-provider"
    service: Literal["hf-inference-providers"] = "hf-inference-providers"
    api: Literal["chat-completions", "responses"] = Field(
        default="chat-completions",
        exclude_if=lambda value: value == "chat-completions",
    )
    model: str = Field(min_length=1, pattern=r"^[^\s:]+/[^\s:]+$")
    routing: ProviderRoute = Field(default_factory=PolicyRoute)
    timeout_seconds: float = Field(default=60, gt=0, le=3600)
    token_secret_name: Literal["HF_INFERENCE_TOKEN"] = "HF_INFERENCE_TOKEN"
    limits: ProviderLimits = Field(default_factory=ProviderLimits)
    parameters: dict[str, JsonValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def parameters_are_safe(self) -> ProviderTarget:
        reserved = {
            "input",
            "messages",
            "model",
            "stream",
            "stream_options",
            "tools",
        }
        overlap = reserved.intersection(self.parameters)
        if overlap:
            raise ValueError(
                "provider target parameters contain reserved keys: "
                + ", ".join(sorted(overlap))
            )
        _validate_parameters(self.parameters, "provider target")
        return self


def provider_upstream_url(target: ProviderTarget) -> str:
    """Return the immutable Hugging Face inference upstream."""
    del target
    return HF_INFERENCE_PROVIDER_BASE_URL


def routed_provider_model(target: ProviderTarget) -> str:
    """Return the provider-suffixed model name consumed by Harbor."""
    route = target.routing
    suffix = (
        route.provider if isinstance(route, ExplicitProviderRoute) else route.policy
    )
    return f"{target.model}:{suffix}"


def _validate_parameters(value: JsonValue, owner: str) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if is_sensitive_key(key):
                raise ValueError(
                    f"{owner} parameters must not contain secret-like keys"
                )
            _validate_parameters(item, owner)
    elif isinstance(value, list):
        for item in value:
            _validate_parameters(item, owner)

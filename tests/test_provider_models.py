from decimal import Decimal

import pytest
from conftest import with_provider_controller
from pydantic import ValidationError

from harbor_hf.control import RunSubmittedPayload, new_event
from harbor_hf.executions import build_execution_lock
from harbor_hf.models import DeploymentProfile, ExperimentSpec
from harbor_hf.provider_models import (
    ExplicitProviderRoute,
    ProviderLimits,
    ProviderTarget,
    provider_upstream_url,
    routed_provider_model,
)
from harbor_hf.reconciler import (
    plan_reconciliation,
)
from harbor_hf.runs import (
    ProviderWaveTarget,
    build_run_lock,
    build_run_plan,
    build_wave_lock,
)


def test_provider_target_keeps_admission_and_routing_policy() -> None:
    target = ProviderTarget(
        id="provider-target",
        model="openai/gpt-oss-120b",
        routing=ExplicitProviderRoute(provider="groq"),
        limits=ProviderLimits(
            max_concurrent_requests=8,
            max_attempts=3,
            max_spend_usd=Decimal("12.50"),
            estimated_wave_cost_usd=Decimal("2.50"),
        ),
    )

    assert target.kind == "inference-provider"
    assert target.service == "hf-inference-providers"
    assert target.api == "chat-completions"
    assert isinstance(target.routing, ExplicitProviderRoute)
    assert target.routing.provider == "groq"
    assert target.token_secret_name == "HF_INFERENCE_TOKEN"
    assert provider_upstream_url(target) == "https://router.huggingface.co"
    assert routed_provider_model(target) == "openai/gpt-oss-120b:groq"
    assert target.limits.max_concurrent_requests == 8
    assert target.limits.max_spend_usd == Decimal("12.50")
    assert target.limits.estimated_wave_cost_usd == Decimal("2.50")


@pytest.mark.parametrize(
    "limits",
    [
        {"max_spend_usd": Decimal("1")},
        {"estimated_wave_cost_usd": Decimal("1")},
        {
            "max_spend_usd": Decimal("1"),
            "estimated_wave_cost_usd": Decimal("2"),
        },
    ],
)
def test_provider_spend_admission_requires_a_bounded_estimate(
    limits: dict[str, Decimal],
) -> None:
    with pytest.raises(ValidationError, match="spend cap|spend caps"):
        ProviderLimits.model_validate(limits)


def test_manifest_and_run_lock_provider_admission_separately_from_endpoints(
    remote_spec: ExperimentSpec,
) -> None:
    model = remote_spec.matrix.models[0]
    target = ProviderTarget(
        id="provider-target",
        model=model.repo,
        limits=ProviderLimits(
            max_concurrent_requests=3,
            max_attempts=2,
            max_spend_usd=Decimal("1.25"),
            estimated_wave_cost_usd=Decimal("0.50"),
        ),
    )
    spec = ExperimentSpec.model_validate(
        remote_spec.model_copy(
            update={
                "matrix": remote_spec.matrix.model_copy(
                    update={
                        "deployments": [target],
                        "agents": [
                            remote_spec.matrix.agents[0].model_copy(
                                update={
                                    "import_path": (
                                        "harbor_hf_agents.openclaw.agent:OpenClawAgent"
                                    ),
                                    "parameters": {"openclaw_config": {}},
                                }
                            )
                        ],
                    }
                )
            }
        ).model_dump(mode="python")
    )

    assert isinstance(remote_spec.matrix.deployments[0], DeploymentProfile)
    assert isinstance(spec.matrix.deployments[0], ProviderTarget)
    with pytest.raises(ValueError, match="require remote execution"):
        build_execution_lock(spec)

    spec = with_provider_controller(spec)
    run = build_run_lock(build_run_plan(spec), "provider-run")
    execution = run.executions[0]
    assert execution.provider == "hf-inference-providers"
    assert execution.max_concurrent_requests == 3
    assert execution.spend_cap_microusd == 1_250_000
    assert execution.estimated_wave_cost_microusd == 500_000
    submitted = new_event(
        subject_type="run",
        subject_id=run.run_id,
        kind="run.submitted",
        producer="cli",
        payload=RunSubmittedPayload(plan_digest=run.plan_digest),
    )

    _projection, admitted = plan_reconciliation(run, [submitted])
    assert admitted.blocked == []
    assert admitted.actions[0].estimated_cost_microusd == 500_000
    wave = build_wave_lock(run, spec, admitted.actions[0])
    assert isinstance(wave.target, ProviderWaveTarget)
    assert wave.target.provider == target
    assert wave.target.provider.api == "chat-completions"
    assert wave.endpoint is None
    assert wave.max_concurrent_shards == 1
    assert wave.spend_cap_microusd == 1_250_000
    assert wave.estimated_cost_microusd == 500_000


@pytest.mark.parametrize("key", ["api_key", "nestedToken", "provider-secret"])
def test_provider_parameters_reject_secret_like_keys(key: str) -> None:
    with pytest.raises(ValidationError, match="secret-like keys"):
        ProviderTarget(
            id="unsafe-provider",
            model="owner/model",
            parameters={"nested": {key: "must-not-be-recorded"}},
        )


@pytest.mark.parametrize(
    "key", ["input", "messages", "model", "stream", "stream_options", "tools"]
)
def test_provider_target_rejects_transport_owned_parameters(key: str) -> None:
    with pytest.raises(ValidationError, match=f"reserved keys: {key}"):
        ProviderTarget(
            id="provider",
            model="owner/model",
            parameters={key: 1},
        )

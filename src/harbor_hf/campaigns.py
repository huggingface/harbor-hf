from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import UTC, datetime
from decimal import ROUND_CEILING, Decimal
from typing import Annotated, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, model_validator

from harbor_hf.benchmark_source import (
    BenchmarkSourceLock,
    resolved_experiment,
    source_lock_digest,
    source_lock_from_spec,
)
from harbor_hf.endpoints import (
    bind_endpoint,
    deployment_digest,
    managed_endpoint_identity,
    served_model_name,
)
from harbor_hf.models import (
    AgentProfile,
    CampaignControllerSpec,
    ComponentKind,
    DeploymentTarget,
    EndpointRef,
    EvaluationId,
    ExperimentSpec,
    ModelProfile,
    PublicationRole,
    RemoteExecutionSpec,
)
from harbor_hf.planner import RunCell, experiment_digest, resolved_cells
from harbor_hf.provider_models import ProviderTarget
from harbor_hf.runs import RunLock, build_run_lock, validate_provider_cell
from harbor_hf.task_selection import task_matches_selector

_CAMPAIGN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")


class Clock(Protocol):
    def __call__(self) -> datetime: ...


class IdentifierFactory(Protocol):
    def __call__(self) -> str: ...


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PlannedTrial(FrozenModel):
    trial_digest: str
    task_name: str
    task_digest: str
    logical_attempt: int


class PlannedShard(FrozenModel):
    shard_digest: str
    trials: list[PlannedTrial]


class RunAdmission(FrozenModel):
    cell_digest: str
    deployment_digest: str
    model: str
    deployment: str
    agent: str
    provider: str | None = Field(default=None, exclude_if=lambda value: value is None)
    max_concurrent_requests: int | None = Field(
        default=None, ge=1, exclude_if=lambda value: value is None
    )
    spend_cap_microusd: int | None = Field(
        default=None, ge=0, exclude_if=lambda value: value is None
    )
    estimated_wave_cost_microusd: int | None = Field(
        default=None, ge=0, exclude_if=lambda value: value is None
    )


class PlannedRun(RunAdmission):
    shards: list[PlannedShard]


class PlannedInitialWave(FrozenModel):
    wave_index: int = Field(ge=1)
    deployment_digest: str
    shard_digests: list[str] = Field(min_length=1)
    trial_count: int = Field(ge=1)
    effective_concurrency: int = Field(ge=1)
    planned_duration_seconds: int = Field(ge=1)


class LockedInitialWave(FrozenModel):
    wave_index: int = Field(ge=1)
    deployment_digest: str
    shard_ids: list[str] = Field(min_length=1)
    trial_count: int = Field(ge=1)
    effective_concurrency: int = Field(ge=1)
    planned_duration_seconds: int = Field(ge=1)


class CampaignRecoveryPolicy(FrozenModel):
    max_active_waves: int = Field(default=64, ge=1)
    max_physical_executions_per_trial: int = Field(default=3, ge=1)
    retry_base_seconds: int = Field(default=30, ge=1)
    retry_max_seconds: int = Field(default=1800, ge=1)
    cancellation_grace_seconds: int = Field(default=0, ge=0)
    spend_cap_microusd: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def retry_backoff_is_bounded(self) -> CampaignRecoveryPolicy:
        if self.retry_base_seconds > self.retry_max_seconds:
            raise ValueError("retry base seconds must not exceed retry maximum")
        return self


class CampaignPlan(FrozenModel):
    schema_version: Literal["harbor-hf/campaign-plan/v1alpha1"] = (
        "harbor-hf/campaign-plan/v1alpha1"
    )
    experiment: str
    evaluation_id: EvaluationId
    publication_role: PublicationRole
    component_kind: ComponentKind | None
    manifest_digest: str
    source_lock: BenchmarkSourceLock
    plan_digest: str
    run_count: int
    shard_count: int
    trial_count: int
    max_shards_per_wave: int
    recovery_policy: CampaignRecoveryPolicy
    controller_policy: CampaignControllerSpec | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    planned_campaign_duration_seconds: int | None = Field(
        default=None, ge=1, exclude_if=lambda value: value is None
    )
    initial_waves: list[PlannedInitialWave] = Field(
        default_factory=list, exclude_if=lambda value: not value
    )
    runs: list[PlannedRun]

    @model_validator(mode="after")
    def counts_match_contents(self) -> CampaignPlan:
        if (self.publication_role == "component") != (self.component_kind is not None):
            raise ValueError("component kind conflicts with publication role")
        if (self.controller_policy is None) != (
            self.planned_campaign_duration_seconds is None
        ) or (self.controller_policy is None) != (not self.initial_waves):
            raise ValueError("campaign controller planning fields are incomplete")
        if [wave.wave_index for wave in self.initial_waves] != list(
            range(1, len(self.initial_waves) + 1)
        ):
            raise ValueError("planned wave indexes must be contiguous")
        shard_count = sum(len(run.shards) for run in self.runs)
        trial_count = sum(
            len(shard.trials) for run in self.runs for shard in run.shards
        )
        if (self.run_count, self.shard_count, self.trial_count) != (
            len(self.runs),
            shard_count,
            trial_count,
        ):
            raise ValueError("campaign plan counts do not match its contents")
        return self


class CampaignTrialLock(FrozenModel):
    trial_id: str
    trial_digest: str
    task_name: str
    task_digest: str
    logical_attempt: int


class CampaignShardLock(FrozenModel):
    shard_id: str
    shard_digest: str
    trials: list[CampaignTrialLock]


class CampaignRunLock(RunAdmission):
    run_id: str
    shards: list[CampaignShardLock]


class CampaignLock(FrozenModel):
    schema_version: Literal["harbor-hf/campaign-lock/v1alpha1"] = (
        "harbor-hf/campaign-lock/v1alpha1"
    )
    campaign_id: str
    created_at: datetime
    experiment: str
    evaluation_id: EvaluationId
    publication_role: PublicationRole
    component_kind: ComponentKind | None
    manifest_digest: str
    source_lock: BenchmarkSourceLock
    plan_digest: str
    artifact_prefix: str
    max_shards_per_wave: int
    recovery_policy: CampaignRecoveryPolicy
    controller_policy: CampaignControllerSpec | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    planned_campaign_duration_seconds: int | None = Field(
        default=None, ge=1, exclude_if=lambda value: value is None
    )
    initial_waves: list[LockedInitialWave] = Field(
        default_factory=list, exclude_if=lambda value: not value
    )
    runs: list[CampaignRunLock]

    @model_validator(mode="after")
    def publication_role_is_consistent(self) -> CampaignLock:
        if (self.publication_role == "component") != (self.component_kind is not None):
            raise ValueError("component kind conflicts with publication role")
        if (self.controller_policy is None) != (
            self.planned_campaign_duration_seconds is None
        ) or (self.controller_policy is None) != (not self.initial_waves):
            raise ValueError("campaign controller lock fields are incomplete")
        if [wave.wave_index for wave in self.initial_waves] != list(
            range(1, len(self.initial_waves) + 1)
        ):
            raise ValueError("locked wave indexes must be contiguous")
        return self


class SubmitWaveAction(Protocol):
    @property
    def action_id(self) -> str: ...

    @property
    def action_key(self) -> str: ...

    @property
    def kind(self) -> str: ...

    @property
    def campaign_id(self) -> str: ...

    @property
    def deployment_digest(self) -> str: ...

    @property
    def shard_ids(self) -> list[str]: ...

    @property
    def trial_ids(self) -> list[str]: ...

    @property
    def estimated_cost_microusd(self) -> int | None: ...


class WaveShardLock(FrozenModel):
    artifact_prefix: str
    run_id: str
    shard: CampaignShardLock


class WaveRunLock(FrozenModel):
    artifact_prefix: str
    configuration: RunLock
    shards: list[WaveShardLock]


class EndpointWaveTarget(FrozenModel):
    kind: Literal["inference-endpoint"] = "inference-endpoint"
    endpoint: EndpointRef


class ProviderWaveTarget(FrozenModel):
    kind: Literal["inference-provider"] = "inference-provider"
    provider: ProviderTarget


WaveDeploymentTarget = Annotated[
    EndpointWaveTarget | ProviderWaveTarget,
    Field(discriminator="kind"),
]


def estimated_partial_wave_cost(
    lock: CampaignLock,
    deployment_digest: str,
    estimated_wave_cost_microusd: int | None,
    trial_count: int,
) -> int | None:
    if estimated_wave_cost_microusd is None:
        return None
    shard_sizes = sorted(
        (
            (shard.shard_id, len(shard.trials))
            for run in lock.runs
            if run.deployment_digest == deployment_digest
            for shard in run.shards
        ),
        key=lambda item: item[0],
    )
    capacities = [
        sum(
            size
            for _shard_id, size in shard_sizes[
                offset : offset + lock.max_shards_per_wave
            ]
        )
        for offset in range(0, len(shard_sizes), lock.max_shards_per_wave)
    ]
    capacity = max(capacities, default=0)
    if capacity <= 0 or trial_count <= 0:
        raise ValueError("partial wave cost requires a non-empty deployment wave")
    return max(
        1,
        (estimated_wave_cost_microusd * trial_count + capacity - 1) // capacity,
    )


class WaveLock(FrozenModel):
    schema_version: Literal["harbor-hf/wave-lock/v1alpha1"] = (
        "harbor-hf/wave-lock/v1alpha1"
    )
    wave_id: str
    action_id: str
    action_key: str
    action_kind: Literal["submit-wave", "retry-shard"] = "submit-wave"
    campaign_id: str
    created_at: datetime
    manifest_digest: str
    plan_digest: str
    deployment_digest: str
    target: WaveDeploymentTarget
    artifact_bucket: str
    artifact_prefix: str
    max_shards: int
    max_concurrent_shards: int
    spend_cap_microusd: int | None = Field(
        default=None, ge=0, exclude_if=lambda value: value is None
    )
    estimated_cost_microusd: int = Field(default=0, ge=0)
    duration_seconds: int
    remote: RemoteExecutionSpec
    recovery_parent_worker_revision: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{40}$",
        exclude_if=lambda value: value is None,
    )
    shard_ids: list[str]
    trial_ids: list[str] = Field(default_factory=list)
    runs: list[WaveRunLock]

    @property
    def endpoint(self) -> EndpointRef | None:
        if isinstance(self.target, EndpointWaveTarget):
            return self.target.endpoint
        return None

    @property
    def provider_target(self) -> ProviderTarget | None:
        if isinstance(self.target, ProviderWaveTarget):
            return self.target.provider
        return None

    @model_validator(mode="after")
    def bounds_match_contents(self) -> WaveLock:
        shard_count = sum(len(run.shards) for run in self.runs)
        if shard_count < 1 or shard_count > self.max_shards:
            raise ValueError("wave shard count exceeds its locked bound")
        observed_ids = [
            shard.shard.shard_id for run in self.runs for shard in run.shards
        ]
        if (
            len(observed_ids) != len(self.shard_ids)
            or len(self.shard_ids) != len(set(self.shard_ids))
            or set(observed_ids) != set(self.shard_ids)
        ):
            raise ValueError("wave shard IDs do not match its locked contents")
        locked_trial_ids = {
            trial.trial_id
            for run in self.runs
            for shard in run.shards
            for trial in shard.shard.trials
        }
        if len(self.trial_ids) != len(set(self.trial_ids)) or not set(
            self.trial_ids
        ).issubset(locked_trial_ids):
            raise ValueError("wave trial IDs do not match its locked contents")
        if self.action_kind == "retry-shard" and not self.trial_ids:
            raise ValueError("retry wave requires at least one trial ID")
        if self.action_kind == "submit-wave" and self.trial_ids:
            raise ValueError("submit wave must not select individual trials")
        if self.max_concurrent_shards < 1:
            raise ValueError("wave concurrency must be positive")
        if self.duration_seconds < 1:
            raise ValueError("wave duration must be positive")
        return self

    @model_validator(mode="after")
    def recovery_worker_is_only_for_retries(self) -> WaveLock:
        if (
            self.recovery_parent_worker_revision is not None
            and self.action_kind != "retry-shard"
        ):
            raise ValueError("only retry waves can pin a recovery worker revision")
        return self


def build_campaign_plan(
    spec: ExperimentSpec,
    *,
    source_lock: BenchmarkSourceLock | None = None,
    recovery_policy: CampaignRecoveryPolicy | None = None,
) -> CampaignPlan:
    selected_source_lock = source_lock or source_lock_from_spec(spec)
    resolved_spec = resolved_experiment(spec, selected_source_lock)
    selected_recovery_policy = recovery_policy or CampaignRecoveryPolicy()
    source_identity = source_lock_digest(selected_source_lock)
    tasks = _resolved_tasks(resolved_spec)
    trials = [
        PlannedTrial(
            trial_digest=_digest(
                {
                    "task_name": task_name,
                    "task_digest": task_digest,
                    "logical_attempt": logical_attempt,
                    "source_lock_digest": source_identity,
                }
            ),
            task_name=task_name,
            task_digest=task_digest,
            logical_attempt=logical_attempt,
        )
        for logical_attempt in range(1, resolved_spec.execution.attempts + 1)
        for task_name, task_digest in tasks
    ]
    profiles = (
        {profile.id: profile for profile in resolved_spec.matrix.models},
        {profile.id: profile for profile in resolved_spec.matrix.deployments},
        {profile.id: profile for profile in resolved_spec.matrix.agents},
    )
    cells = resolved_cells(resolved_spec)
    _validate_campaign_cells(cells, profiles)
    runs = [
        _plan_run(resolved_spec, cell, trials, profiles, source_identity)
        for cell in cells
    ]
    controller_policy, initial_waves, planned_campaign_seconds = _controller_plan(
        resolved_spec, runs
    )
    plan_payload = {
        "schema_version": "harbor-hf/campaign-plan/v1alpha1",
        "experiment": resolved_spec.metadata.model_dump(mode="json"),
        "benchmark_dataset": resolved_spec.benchmark.dataset,
        "benchmark_dataset_digest": resolved_spec.benchmark.dataset_digest,
        "source_lock": selected_source_lock.model_dump(mode="json"),
        "execution": resolved_spec.execution.model_dump(mode="json"),
        "recovery_policy": selected_recovery_policy.model_dump(mode="json"),
        "artifacts": resolved_spec.artifacts.model_dump(mode="json"),
        "publishing": resolved_spec.publishing.model_dump(mode="json"),
        "remote": (
            resolved_spec.remote.model_dump(mode="json")
            if resolved_spec.remote is not None
            else None
        ),
        "runs": [run.model_dump(mode="json") for run in runs],
    }
    if controller_policy is not None:
        plan_payload.update(
            {
                "controller_policy": controller_policy.model_dump(mode="json"),
                "planned_campaign_duration_seconds": planned_campaign_seconds,
                "initial_waves": [
                    wave.model_dump(mode="json") for wave in initial_waves
                ],
            }
        )
    if resolved_spec.benchmark.judge is not None:
        plan_payload["benchmark_judge"] = resolved_spec.benchmark.judge.model_dump(
            mode="json"
        )
    return CampaignPlan(
        experiment=resolved_spec.metadata.name,
        evaluation_id=resolved_spec.publishing.evaluation_id,
        publication_role=resolved_spec.publishing.role,
        component_kind=resolved_spec.publishing.component_kind,
        manifest_digest=experiment_digest(spec),
        source_lock=selected_source_lock,
        plan_digest=_digest(plan_payload),
        run_count=len(runs),
        shard_count=sum(len(run.shards) for run in runs),
        trial_count=sum(len(shard.trials) for run in runs for shard in run.shards),
        max_shards_per_wave=resolved_spec.execution.max_shards_per_wave,
        recovery_policy=selected_recovery_policy,
        controller_policy=controller_policy,
        planned_campaign_duration_seconds=planned_campaign_seconds,
        initial_waves=initial_waves,
        runs=runs,
    )


def _resolved_tasks(spec: ExperimentSpec) -> list[tuple[str, str]]:
    digests = spec.benchmark.task_digests
    if not digests:
        raise ValueError("campaign planning requires resolved task digests")
    if any(
        not any(
            task_matches_selector(task_name, selection, digests)
            for task_name in digests
        )
        for selection in spec.benchmark.task_names
    ) or any(
        not any(
            task_matches_selector(task_name, selection, digests)
            for selection in spec.benchmark.task_names
        )
        for task_name in digests
    ):
        raise ValueError("campaign task digests must exactly resolve task selections")
    return sorted(digests.items())


def _validate_campaign_cells(
    cells: list[RunCell],
    profiles: tuple[
        dict[str, ModelProfile],
        dict[str, DeploymentTarget],
        dict[str, AgentProfile],
    ],
) -> None:
    models, deployments, agents = profiles
    profile_pairs_by_digest: dict[str, tuple[str, str]] = {}
    for cell in cells:
        model = models[cell.model]
        deployment = deployments[cell.deployment]
        if isinstance(deployment, ProviderTarget):
            validate_provider_cell(model, deployment, agents[cell.agent])
        digest = deployment_digest(model, deployment)
        pair = (cell.model, cell.deployment)
        previous = profile_pairs_by_digest.setdefault(digest, pair)
        if previous != pair:
            raise ValueError(
                "campaign deployment digest must resolve to one model and "
                "deployment profile pair"
            )


def _plan_run(
    spec: ExperimentSpec,
    cell: RunCell,
    trials: list[PlannedTrial],
    profiles: tuple[
        dict[str, ModelProfile],
        dict[str, DeploymentTarget],
        dict[str, AgentProfile],
    ],
    source_identity: str,
) -> PlannedRun:
    models, deployments, agents = profiles
    resolved_deployment_digest = deployment_digest(
        models[cell.model], deployments[cell.deployment]
    )
    cell_digest = _digest(
        {
            "model": _dump_profile(models[cell.model]),
            "deployment": _dump_profile(deployments[cell.deployment]),
            "agent": _dump_profile(agents[cell.agent]),
            "source_lock_digest": source_identity,
        }
    )
    shard_size = spec.execution.max_trials_per_shard
    shards = [
        PlannedShard(
            shard_digest=_digest(
                {
                    "cell_digest": cell_digest,
                    "trials": [trial.model_dump(mode="json") for trial in chunk],
                }
            ),
            trials=chunk,
        )
        for offset in range(0, len(trials), shard_size)
        if (chunk := trials[offset : offset + shard_size])
    ]
    (
        provider,
        max_concurrent_requests,
        spend_cap_microusd,
        estimated_wave_cost_microusd,
    ) = _target_admission(deployments[cell.deployment])
    return PlannedRun(
        cell_digest=cell_digest,
        deployment_digest=resolved_deployment_digest,
        model=cell.model,
        deployment=cell.deployment,
        agent=cell.agent,
        provider=provider,
        max_concurrent_requests=max_concurrent_requests,
        spend_cap_microusd=spend_cap_microusd,
        estimated_wave_cost_microusd=estimated_wave_cost_microusd,
        shards=shards,
    )


def _controller_plan(
    spec: ExperimentSpec, runs: list[PlannedRun]
) -> tuple[
    CampaignControllerSpec | None,
    list[PlannedInitialWave],
    int | None,
]:
    policy = _provider_controller_policy(spec, runs)
    if policy is None:
        return None, [], None
    grouped_shards, concurrency = _provider_wave_groups(spec, runs)
    waves = _build_planned_initial_waves(
        spec,
        policy,
        grouped_shards,
        concurrency,
    )
    total = (
        sum(wave.planned_duration_seconds for wave in waves)
        + policy.controller_reserve_seconds
    )
    remote = spec.remote
    if remote is None or total > remote.job.timeout_seconds:
        raise ValueError(
            "planned provider campaign duration exceeds remote.job.timeout_seconds"
        )
    return policy, waves, total


def _provider_controller_policy(
    spec: ExperimentSpec, runs: list[PlannedRun]
) -> CampaignControllerSpec | None:
    provider_count = sum(run.provider is not None for run in runs)
    if 0 < provider_count < len(runs):
        raise ValueError(
            "campaigns cannot mix inference providers and inference endpoints"
        )
    policy = spec.execution.controller
    if provider_count == 0:
        if policy is not None:
            raise ValueError(
                "execution.controller is only valid for inference-provider campaigns"
            )
        return None
    if policy is None:
        raise ValueError(
            "inference-provider campaigns require execution.controller settings"
        )
    if spec.remote is None:
        raise ValueError("provider campaign controllers require remote execution")
    return policy


def _provider_wave_groups(
    spec: ExperimentSpec,
    runs: list[PlannedRun],
) -> tuple[dict[str, list[PlannedShard]], dict[str, int]]:
    grouped_shards: dict[str, list[PlannedShard]] = {}
    concurrency: dict[str, int] = {}
    profile_limit = (
        spec.execution.serving_profile.concurrency
        if spec.execution.serving_profile is not None
        else spec.execution.concurrent_trials
    )
    for run in runs:
        provider_limit = run.max_concurrent_requests
        if provider_limit is None:
            raise ValueError("provider campaign run has no request concurrency limit")
        effective = min(
            spec.execution.concurrent_trials,
            provider_limit,
            profile_limit,
        )
        previous = concurrency.setdefault(run.deployment_digest, effective)
        if previous != effective:
            raise ValueError("provider deployment has inconsistent concurrency limits")
        grouped_shards.setdefault(run.deployment_digest, []).extend(run.shards)
    return grouped_shards, concurrency


def _build_planned_initial_waves(
    spec: ExperimentSpec,
    policy: CampaignControllerSpec,
    grouped_shards: dict[str, list[PlannedShard]],
    concurrency: dict[str, int],
) -> list[PlannedInitialWave]:
    waves: list[PlannedInitialWave] = []
    for deployment_key in sorted(grouped_shards):
        shards = grouped_shards[deployment_key]
        for offset in range(0, len(shards), spec.execution.max_shards_per_wave):
            chunk = shards[offset : offset + spec.execution.max_shards_per_wave]
            trial_count = sum(len(shard.trials) for shard in chunk)
            duration = planned_provider_wave_seconds(
                policy,
                trial_count=trial_count,
                effective_concurrency=concurrency[deployment_key],
            )
            if duration > spec.execution.timeout_seconds:
                raise ValueError(
                    "planned provider wave duration exceeds execution.timeout_seconds"
                )
            waves.append(
                PlannedInitialWave(
                    wave_index=len(waves) + 1,
                    deployment_digest=deployment_key,
                    shard_digests=[shard.shard_digest for shard in chunk],
                    trial_count=trial_count,
                    effective_concurrency=concurrency[deployment_key],
                    planned_duration_seconds=duration,
                )
            )
    maximum_by_deployment = {
        deployment_key: max(
            wave.planned_duration_seconds
            for wave in waves
            if wave.deployment_digest == deployment_key
        )
        for deployment_key in grouped_shards
    }
    return [
        wave.model_copy(
            update={
                "planned_duration_seconds": maximum_by_deployment[
                    wave.deployment_digest
                ]
            }
        )
        for wave in waves
    ]


def planned_provider_wave_seconds(
    policy: CampaignControllerSpec,
    *,
    trial_count: int,
    effective_concurrency: int,
) -> int:
    if trial_count < 1 or effective_concurrency < 1:
        raise ValueError("planned provider waves require trials and concurrency")
    batches = (trial_count + effective_concurrency - 1) // effective_concurrency
    trial_work = Decimal(batches * policy.planning_trial_seconds)
    planned_work = int(
        (trial_work * policy.headroom_factor).to_integral_value(rounding=ROUND_CEILING)
    )
    return planned_work + policy.wave_reserve_seconds


def locked_provider_action_concurrency(
    campaign: CampaignLock,
    *,
    deployment_digest: str,
) -> int:
    concurrency = {
        wave.effective_concurrency
        for wave in campaign.initial_waves
        if wave.deployment_digest == deployment_digest
    }
    if len(concurrency) != 1:
        raise ValueError("provider action has no locked concurrency")
    return concurrency.pop()


def locked_provider_action_seconds(
    campaign: CampaignLock,
    *,
    action_kind: Literal["submit-wave", "retry-shard"],
    deployment_digest: str,
    shard_ids: list[str],
    trial_count: int,
) -> int:
    policy = campaign.controller_policy
    if policy is None:
        raise ValueError("provider action has no controller policy")
    if action_kind == "submit-wave":
        requested = set(shard_ids)
        matches = [
            wave
            for wave in campaign.initial_waves
            if wave.deployment_digest == deployment_digest
            and set(wave.shard_ids) == requested
        ]
        if len(matches) != 1:
            raise ValueError("provider action does not match one locked initial wave")
        return matches[0].planned_duration_seconds
    return planned_provider_wave_seconds(
        policy,
        trial_count=trial_count,
        effective_concurrency=locked_provider_action_concurrency(
            campaign,
            deployment_digest=deployment_digest,
        ),
    )


def _dump_profile(profile: BaseModel) -> object:
    return profile.model_dump(mode="json", exclude_none=True)


def build_campaign_lock(
    plan: CampaignPlan,
    campaign_id: str,
    *,
    clock: Clock = lambda: datetime.now(UTC),
) -> CampaignLock:
    if _CAMPAIGN_ID.fullmatch(campaign_id) is None:
        raise ValueError(
            "campaign ID must be one safe path component containing only letters, "
            "digits, dots, underscores, or hyphens, with at most 100 characters"
        )
    runs = []
    for planned_run in plan.runs:
        run_id = _short_id(
            "run", {"campaign_id": campaign_id, "cell_digest": planned_run.cell_digest}
        )
        shards = []
        for planned_shard in planned_run.shards:
            trials = [
                CampaignTrialLock(
                    trial_id=_short_id(
                        "trial",
                        {"run_id": run_id, "trial_digest": trial.trial_digest},
                    ),
                    **trial.model_dump(mode="python"),
                )
                for trial in planned_shard.trials
            ]
            shards.append(
                CampaignShardLock(
                    shard_id=_short_id(
                        "shard",
                        {
                            "run_id": run_id,
                            "shard_digest": planned_shard.shard_digest,
                        },
                    ),
                    shard_digest=planned_shard.shard_digest,
                    trials=trials,
                )
            )
        runs.append(
            CampaignRunLock(
                run_id=run_id,
                cell_digest=planned_run.cell_digest,
                deployment_digest=planned_run.deployment_digest,
                model=planned_run.model,
                deployment=planned_run.deployment,
                agent=planned_run.agent,
                provider=planned_run.provider,
                max_concurrent_requests=planned_run.max_concurrent_requests,
                spend_cap_microusd=planned_run.spend_cap_microusd,
                estimated_wave_cost_microusd=(planned_run.estimated_wave_cost_microusd),
                shards=shards,
            )
        )
    initial_waves = _locked_initial_waves(plan, runs)
    return CampaignLock(
        campaign_id=campaign_id,
        created_at=clock().astimezone(UTC),
        experiment=plan.experiment,
        evaluation_id=plan.evaluation_id,
        publication_role=plan.publication_role,
        component_kind=plan.component_kind,
        manifest_digest=plan.manifest_digest,
        source_lock=plan.source_lock,
        plan_digest=plan.plan_digest,
        artifact_prefix=f"campaigns/{campaign_id}",
        max_shards_per_wave=plan.max_shards_per_wave,
        recovery_policy=plan.recovery_policy,
        controller_policy=plan.controller_policy,
        planned_campaign_duration_seconds=plan.planned_campaign_duration_seconds,
        initial_waves=initial_waves,
        runs=runs,
    )


def _locked_initial_waves(
    plan: CampaignPlan,
    runs: list[CampaignRunLock],
) -> list[LockedInitialWave]:
    if plan.controller_policy is None:
        return []
    concurrency = {
        wave.deployment_digest: wave.effective_concurrency
        for wave in plan.initial_waves
    }
    duration = {
        wave.deployment_digest: wave.planned_duration_seconds
        for wave in plan.initial_waves
    }
    grouped: dict[str, list[CampaignShardLock]] = {}
    for run in sorted(runs, key=lambda value: value.run_id):
        grouped.setdefault(run.deployment_digest, []).extend(
            sorted(run.shards, key=lambda value: value.shard_id)
        )
    waves: list[LockedInitialWave] = []
    for deployment_key in sorted(grouped):
        shards = grouped[deployment_key]
        for offset in range(0, len(shards), plan.max_shards_per_wave):
            chunk = shards[offset : offset + plan.max_shards_per_wave]
            waves.append(
                LockedInitialWave(
                    wave_index=len(waves) + 1,
                    deployment_digest=deployment_key,
                    shard_ids=[shard.shard_id for shard in chunk],
                    trial_count=sum(len(shard.trials) for shard in chunk),
                    effective_concurrency=concurrency[deployment_key],
                    planned_duration_seconds=duration[deployment_key],
                )
            )
    return waves


def _wave_duration_seconds(
    campaign: CampaignLock,
    spec: ExperimentSpec,
    action: SubmitWaveAction,
    provider_target: ProviderTarget | None,
) -> int:
    if provider_target is None:
        return spec.execution.timeout_seconds
    policy = campaign.controller_policy
    if policy is None:
        raise ValueError("provider wave has no controller policy")
    action_kind: Literal["submit-wave", "retry-shard"] = (
        "retry-shard" if action.kind == "retry-shard" else "submit-wave"
    )
    planned_seconds = locked_provider_action_seconds(
        campaign,
        action_kind=action_kind,
        deployment_digest=action.deployment_digest,
        shard_ids=action.shard_ids,
        trial_count=len(action.trial_ids),
    )
    return planned_seconds - policy.wave_reserve_seconds


def build_wave_lock(
    campaign: CampaignLock,
    spec: ExperimentSpec,
    action: SubmitWaveAction,
    *,
    endpoint: EndpointRef | None = None,
) -> WaveLock:
    """Resolve one reserved deployment wave for an allowed endpoint identity."""
    expected_campaign = build_campaign_lock(
        build_campaign_plan(
            spec,
            source_lock=campaign.source_lock,
            recovery_policy=campaign.recovery_policy,
        ),
        campaign.campaign_id,
        clock=lambda: campaign.created_at,
    )
    if campaign != expected_campaign:
        raise ValueError("campaign lock does not match the resolved manifest")
    _validate_submit_wave_action(campaign, action)

    resolved_spec = resolved_experiment(spec, campaign.source_lock)
    selected = _selected_wave_shards(campaign, action)
    selected_trial_ids = {
        trial.trial_id
        for _run, shards in selected
        for shard in shards
        for trial in shard.trials
    }
    if set(action.trial_ids) - selected_trial_ids:
        raise ValueError("retry-shard action references trials outside its shards")
    estimates = {
        campaign_run.estimated_wave_cost_microusd for campaign_run, _shards in selected
    }
    if len(estimates) != 1:
        raise ValueError("compatible wave shards must use one spend estimate")
    locked_wave_estimate = estimates.pop() or 0
    run_locks: list[WaveRunLock] = []
    target: EndpointWaveTarget | ProviderWaveTarget | None = None
    requested_endpoint = endpoint
    for campaign_run, shards in selected:
        bound_spec = _bound_wave_spec(
            campaign,
            resolved_spec,
            campaign_run,
            requested_endpoint,
        )
        configuration = build_run_lock(
            bound_spec,
            model_id=campaign_run.model,
            deployment_id=campaign_run.deployment,
            agent_id=campaign_run.agent,
            run_id=campaign_run.run_id,
            allow_provider=True,
            clock=lambda: campaign.created_at,
            manifest_digest=campaign.manifest_digest,
        )
        observed_target = _wave_target(configuration.deployment)
        if target is not None and observed_target != target:
            raise ValueError("compatible wave shards must use one exact target")
        target = observed_target
        run_locks.append(
            WaveRunLock(
                artifact_prefix=(
                    f"{campaign.artifact_prefix}/runs/{campaign_run.run_id}"
                ),
                configuration=configuration,
                shards=[
                    WaveShardLock(
                        artifact_prefix=(
                            f"{campaign.artifact_prefix}/runs/{campaign_run.run_id}/"
                            f"shards/{shard.shard_id}"
                        ),
                        run_id=campaign_run.run_id,
                        shard=shard,
                    )
                    for shard in shards
                ],
            )
        )
    if target is None or resolved_spec.remote is None:
        raise ValueError("deployment wave requires remote execution")
    provider_target = (
        target.provider if isinstance(target, ProviderWaveTarget) else None
    )
    duration_seconds = _wave_duration_seconds(
        campaign, resolved_spec, action, provider_target
    )
    return WaveLock(
        wave_id=deterministic_wave_id(action.action_key),
        action_id=action.action_id,
        action_key=action.action_key,
        action_kind=("retry-shard" if action.kind == "retry-shard" else "submit-wave"),
        campaign_id=campaign.campaign_id,
        created_at=campaign.created_at,
        manifest_digest=campaign.manifest_digest,
        plan_digest=campaign.plan_digest,
        deployment_digest=action.deployment_digest,
        target=target,
        artifact_bucket=resolved_spec.artifacts.bucket,
        artifact_prefix=(
            f"{campaign.artifact_prefix}/waves/"
            f"{deterministic_wave_id(action.action_key)}"
        ),
        max_shards=campaign.max_shards_per_wave,
        max_concurrent_shards=(
            locked_provider_action_concurrency(
                campaign,
                deployment_digest=action.deployment_digest,
            )
            if provider_target is not None
            else resolved_spec.execution.concurrent_trials
        ),
        spend_cap_microusd=(
            _usd_to_microusd(provider_target.limits.max_spend_usd)
            if provider_target is not None
            else None
        ),
        estimated_cost_microusd=locked_wave_estimate,
        duration_seconds=duration_seconds,
        remote=resolved_spec.remote,
        shard_ids=action.shard_ids,
        trial_ids=action.trial_ids,
        runs=run_locks,
    )


def managed_wave_endpoint(
    campaign: CampaignLock,
    spec: ExperimentSpec,
    deployment: str,
) -> EndpointRef:
    """Return the deterministic endpoint binding for one deployment digest."""
    if spec.remote is None:
        raise ValueError("managed deployment waves require remote execution")
    matches = [run for run in campaign.runs if run.deployment_digest == deployment]
    if not matches:
        raise ValueError("campaign does not contain the deployment digest")
    profile_pairs = {(run.model, run.deployment) for run in matches}
    if len(profile_pairs) != 1:
        raise ValueError("deployment digest resolves to conflicting profiles")
    model_id, deployment_id = profile_pairs.pop()
    model = next(profile for profile in spec.matrix.models if profile.id == model_id)
    profile = next(
        profile for profile in spec.matrix.deployments if profile.id == deployment_id
    )
    if isinstance(profile, ProviderTarget):
        raise ValueError("inference provider deployments have no managed endpoint")
    if deployment_digest(model, profile) != deployment:
        raise ValueError("manifest deployment does not match the campaign lock")
    identity = managed_endpoint_identity(
        namespace=spec.remote.job.namespace,
        campaign_id=campaign.campaign_id,
        deployment_digest=deployment,
    )
    return EndpointRef(
        namespace=identity.namespace,
        name=identity.name,
        served_model_name=served_model_name(profile, model),
    )


def _bound_wave_spec(
    campaign: CampaignLock,
    spec: ExperimentSpec,
    run: CampaignRunLock,
    requested_endpoint: EndpointRef | None,
) -> ExperimentSpec:
    profile = next(
        profile for profile in spec.matrix.deployments if profile.id == run.deployment
    )
    if isinstance(profile, ProviderTarget):
        if requested_endpoint is not None:
            raise ValueError("provider waves cannot have an endpoint binding")
        return spec
    resolved_endpoint = requested_endpoint or profile.endpoint
    if resolved_endpoint is None:
        raise ValueError(
            "deployment wave requires a pre-existing endpoint binding or "
            "a managed endpoint binding"
        )
    managed_endpoint = managed_wave_endpoint(
        campaign,
        spec,
        run.deployment_digest,
    )
    if resolved_endpoint not in (profile.endpoint, managed_endpoint):
        raise ValueError("deployment wave endpoint identity is not allowed")
    return bind_endpoint(
        spec,
        deployment_id=run.deployment,
        endpoint=resolved_endpoint,
    )


def deterministic_wave_id(action_key: str) -> str:
    if re.fullmatch(r"[0-9a-f]{24}", action_key) is None:
        raise ValueError("wave action key must be a 24-character hexadecimal digest")
    return f"wave-{action_key}"


def _validate_submit_wave_action(
    campaign: CampaignLock, action: SubmitWaveAction
) -> None:
    if (
        action.kind not in {"submit-wave", "retry-shard"}
        or action.campaign_id != campaign.campaign_id
    ):
        raise ValueError("wave action does not target the campaign")
    if not action.shard_ids:
        raise ValueError("wave action must contain at least one shard")
    if len(action.shard_ids) != len(set(action.shard_ids)):
        raise ValueError("wave action shard IDs must be unique")
    if len(action.shard_ids) > campaign.max_shards_per_wave:
        raise ValueError("wave action exceeds the campaign shard bound")
    _validate_action_trials(action)
    if (
        re.fullmatch(r"[0-9a-f]{24}", action.action_key) is None
        or action.action_id != f"act-{action.action_key}"
    ):
        raise ValueError("wave action identity does not match its immutable contents")


def _validate_action_trials(action: SubmitWaveAction) -> None:
    if len(action.trial_ids) != len(set(action.trial_ids)):
        raise ValueError("wave action trial IDs must be unique")
    if action.kind == "retry-shard" and not action.trial_ids:
        raise ValueError("retry-shard action must admit at least one trial")
    if action.kind == "submit-wave" and action.trial_ids:
        raise ValueError("submit-wave action cannot admit individual trials")


def _selected_wave_shards(
    campaign: CampaignLock, action: SubmitWaveAction
) -> list[tuple[CampaignRunLock, list[CampaignShardLock]]]:
    requested = set(action.shard_ids)
    selected: list[tuple[CampaignRunLock, list[CampaignShardLock]]] = []
    found: set[str] = set()
    for run in campaign.runs:
        shards = [shard for shard in run.shards if shard.shard_id in requested]
        if not shards:
            continue
        if run.deployment_digest != action.deployment_digest:
            raise ValueError("wave action mixes incompatible deployment digests")
        selected.append((run, shards))
        found.update(shard.shard_id for shard in shards)
    missing = requested - found
    if missing:
        raise ValueError("wave action references an unknown campaign shard")
    return selected


def new_campaign_id(
    plan: CampaignPlan,
    *,
    clock: Clock = lambda: datetime.now(UTC),
    identifier: IdentifierFactory = lambda: uuid.uuid4().hex,
) -> str:
    created_at = clock().astimezone(UTC)
    plan_part = plan.plan_digest.removeprefix("sha256:")[:10]
    random_part = identifier()[:10]
    return f"{created_at:%Y%m%dT%H%M%SZ}-{plan_part}-{random_part}"


def campaign_json_schemas() -> dict[str, dict[str, object]]:
    return {
        "campaign_plan": CampaignPlan.model_json_schema(),
        "campaign_lock": CampaignLock.model_json_schema(),
        "wave_lock": WaveLock.model_json_schema(),
    }


def _target_admission(
    target: DeploymentTarget,
) -> tuple[str | None, int | None, int | None, int | None]:
    if isinstance(target, ProviderTarget):
        return (
            target.service,
            target.limits.max_concurrent_requests,
            _usd_to_microusd(target.limits.max_spend_usd),
            _usd_to_microusd(target.limits.estimated_wave_cost_usd),
        )
    return None, None, None, None


def _wave_target(target: DeploymentTarget) -> EndpointWaveTarget | ProviderWaveTarget:
    if isinstance(target, ProviderTarget):
        return ProviderWaveTarget(provider=target)
    if target.endpoint is None:
        raise ValueError(
            "deployment wave requires a pre-existing endpoint binding; "
            "endpoint provisioning is outside this slice"
        )
    return EndpointWaveTarget(endpoint=target.endpoint)


def _usd_to_microusd(value: Decimal | None) -> int | None:
    if value is None:
        return None
    return int(value * 1_000_000)


def _short_id(prefix: str, value: object) -> str:
    return f"{prefix}-{_digest(value).removeprefix('sha256:')[:24]}"


def _digest(value: object) -> str:
    canonical = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(canonical).hexdigest()}"

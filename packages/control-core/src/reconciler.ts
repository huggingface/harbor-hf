import type {
  ActionIntent,
  ActionReceipt,
  AttemptReceipt,
  BudgetEvent,
  CampaignLock,
  DeploymentProfileSpec,
  EndpointResource,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sha256,
} from "@harbor-hf/contracts";
import { attemptAdmissibility } from "./attempt-admissibility.js";
import { preparationRequired } from "./profiles.js";
import type { ResultPublisher } from "./publication.js";
import type { Projection } from "./projection.js";
import { PolicyError, type ControlService } from "./service.js";

export interface ExternalActionResult {
  outcome: ActionReceipt["outcome"];
  observed_state: string;
  resource_id?: string | null;
  error_code?: string | null;
  ready_replicas?: number | null;
  active_hourly_cost_microusd?: number | null;
  cost_microusd?: number | null;
}

export interface ExternalActionContext {
  adoption_only?: boolean;
}

export class ExternalActionNotFoundError extends Error {}
export class AmbiguousExternalActionError extends Error {}

export interface ExternalActionPort {
  execute(
    intent: ActionIntent,
    context?: ExternalActionContext,
  ): Promise<ExternalActionResult>;
}

export interface ReconcilerOptions {
  interval_ms: number;
  observation_interval_ms: number;
  batch_size: number;
  dispatch_adoption_delay_ms?: number;
  worker_receipt_grace_ms?: number;
}

const terminalJobStates = new Set([
  "STOPPED",
  "COMPLETED",
  "CANCELLED",
  "CANCELED",
  "ERROR",
]);

function jobStateIsTerminal(state: string | null): boolean {
  return state !== null && terminalJobStates.has(state.toUpperCase());
}

const defaultOptions: ReconcilerOptions = {
  interval_ms: 2_000,
  observation_interval_ms: 5_000,
  worker_receipt_grace_ms: 60_000,
  batch_size: 16,
};

function stringArray(
  payload: ActionIntent["payload"],
  key: keyof ActionIntent["payload"],
): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new PolicyError(`action payload ${key} must be an array of strings`);
  }
  return value;
}

function scalar<T extends string | number | boolean>(
  payload: ActionIntent["payload"],
  key: keyof ActionIntent["payload"],
  expected: "string" | "number" | "boolean",
): T {
  const value = payload[key];
  if (typeof value !== expected)
    throw new PolicyError(`action payload ${key} must be ${expected}`);
  return value as T;
}

function profile(lock: CampaignLock, kind: string): Record<string, unknown> {
  const selected = lock.profiles.find((item) => item.kind === kind);
  if (!selected) throw new PolicyError(`campaign lock is missing ${kind}`);
  return selected.spec as unknown as Record<string, unknown>;
}

function profileScalar<T extends string | number | boolean>(
  spec: Record<string, unknown>,
  key: string,
  expected: "string" | "number" | "boolean",
): T {
  const value = spec[key];
  if (typeof value !== expected)
    throw new PolicyError(`profile ${key} must be ${expected}`);
  return value as T;
}

function optionalHourlyCost(
  spec: Record<string, unknown> | DeploymentProfileSpec,
): number | undefined {
  if (!("active_hourly_cost_microusd" in spec)) return undefined;
  const value = spec.active_hourly_cost_microusd;
  return typeof value === "number" ? value : undefined;
}

function optionalProfileStrings(spec: Record<string, unknown>, key: string): string[] {
  const value = spec[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new PolicyError(`profile ${key} must be an array of strings`);
  return value;
}

function profileStrings(
  spec: Record<string, unknown>,
  key: string,
): [string, ...string[]] {
  const value = spec[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string")
  )
    throw new PolicyError(`profile ${key} must be a non-empty array of strings`);
  return value as [string, ...string[]];
}

function profileInferenceToken(
  spec: Record<string, unknown>,
): "forbidden" | "required" {
  const value = spec.inference_token ?? "forbidden";
  if (value !== "forbidden" && value !== "required")
    throw new PolicyError("profile inference_token is invalid");
  return value;
}

export function fairSandboxCreateOrder(
  intents: readonly ActionIntent[],
  latestCampaignId: string | null,
): ActionIntent[] {
  const groups = new Map<string, ActionIntent[]>();
  for (const intent of intents) {
    const group = groups.get(intent.campaign_id) ?? [];
    group.push(intent);
    groups.set(intent.campaign_id, group);
  }
  let campaigns = [...groups.keys()].sort((left, right) => {
    const leftIntent = groups.get(left)?.[0];
    const rightIntent = groups.get(right)?.[0];
    return (leftIntent?.created_at ?? left).localeCompare(
      rightIntent?.created_at ?? right,
    );
  });
  const latestIndex = latestCampaignId ? campaigns.indexOf(latestCampaignId) : -1;
  if (latestIndex >= 0)
    campaigns = [
      ...campaigns.slice(latestIndex + 1),
      ...campaigns.slice(0, latestIndex + 1),
    ];
  const output: ActionIntent[] = [];
  while (groups.size > 0) {
    for (const campaignId of campaigns) {
      const group = groups.get(campaignId);
      const next = group?.shift();
      if (next) output.push(next);
      if (group?.length === 0) groups.delete(campaignId);
    }
    campaigns = campaigns.filter((campaignId) => groups.has(campaignId));
  }
  return output;
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private currentRun: Promise<void> | null = null;

  constructor(
    private readonly service: ControlService,
    private readonly projection: Projection,
    private readonly external: ExternalActionPort,
    private readonly publisher: ResultPublisher,
    private readonly options: ReconcilerOptions = defaultOptions,
  ) {}

  start(signal?: AbortSignal): void {
    if (this.timer) return;
    const run = () => {
      if (this.running) return;
      this.running = true;
      const operation = this.tick()
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          this.running = false;
          if (this.currentRun === operation) this.currentRun = null;
        });
      this.currentRun = operation;
    };
    this.timer = setInterval(run, this.options.interval_ms);
    run();
    signal?.addEventListener("abort", () => void this.stop(), { once: true });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.currentRun;
  }

  async tick(): Promise<number> {
    let handled = await this.service.syncProjection();
    for (const { intent, receipt } of await this.projection.unadvancedActions(
      this.options.batch_size,
    )) {
      await this.advance(intent, receipt);
      await this.service.markAdvanced(intent, receipt);
      handled += 1;
    }
    const pending = await this.projection.pendingActions(10_000);
    const ordinary = pending.filter(
      (intent) => intent.action_kind !== "sandbox.create",
    );
    ordinary.sort((left, right) => {
      const priority = (intent: ActionIntent): number =>
        intent.action_kind === "sandbox.close" ||
        intent.action_kind === "campaign.cancel" ||
        intent.action_kind === "job.cancel"
          ? 0
          : 1;
      return priority(left) - priority(right);
    });
    let ordinaryHandled = 0;
    const ordinaryLimit = Math.max(1, this.options.batch_size - 1);
    for (const intent of ordinary.slice(0, ordinaryLimit)) {
      const notBefore = intent.payload.not_before;
      if (typeof notBefore === "string" && Date.parse(notBefore) > Date.now()) continue;
      await this.handle(intent);
      handled += 1;
      ordinaryHandled += 1;
    }
    const remaining = Math.max(1, this.options.batch_size - ordinaryHandled);
    for (const intent of (
      await this.fairSandboxCreates(
        pending.filter((candidate) => candidate.action_kind === "sandbox.create"),
      )
    ).slice(0, remaining)) {
      if (!this.service.capacityProfile()) {
        await this.handle(intent);
        handled += 1;
        continue;
      }
      const maximum = intent.payload.sandbox?.max_sandboxes;
      if (typeof maximum !== "number")
        throw new PolicyError("Sandbox create is missing its campaign capacity");
      const admission = await this.service.admitSandboxCreate(intent, maximum);
      if (admission.status !== "admitted") continue;
      await this.handle(intent);
      handled += 1;
    }
    for (const campaign of await this.projection.campaigns(10_000)) {
      if (await this.maybePublish(campaign.campaign_id)) handled += 1;
    }
    return handled;
  }

  private async fairSandboxCreates(intents: ActionIntent[]): Promise<ActionIntent[]> {
    const latest = await this.projection.latestSandboxAdmission(this.service.namespace);
    return fairSandboxCreateOrder(intents, latest?.campaign_id ?? null);
  }

  private async handle(intent: ActionIntent): Promise<void> {
    let result: ExternalActionResult;
    if (intent.action_kind === "publication.publish") {
      const receipt = await this.publisher.publish(intent.campaign_id);
      result = {
        outcome: "completed",
        observed_state: receipt.publication_state,
        resource_id: receipt.publication_id,
      };
    } else if (intent.action_kind === "publication.supersede") {
      const current = await this.projection.campaignPublication(intent.campaign_id);
      const previousId = intent.payload.publication_id;
      const previous =
        typeof previousId === "string"
          ? await this.projection.publication(previousId)
          : null;
      if (!current || !previous || typeof previousId !== "string")
        throw new PolicyError("supersession publication is missing");
      const record = await this.service.writePublicationSupersession(
        intent.campaign_id,
        current.publication_id,
        previous.campaign_id,
        previousId,
        typeof intent.payload.reason === "string"
          ? intent.payload.reason
          : "replacement publication validated",
      );
      result = {
        outcome: "completed",
        observed_state: "superseded",
        resource_id: record.record_id,
      };
    } else if (intent.action_kind === "campaign.cancel") {
      result = { outcome: "completed", observed_state: "cancelled" };
    } else if (intent.action_kind === "campaign.pause") {
      result = { outcome: "completed", observed_state: "paused" };
    } else if (intent.action_kind === "campaign.resume") {
      result = { outcome: "completed", observed_state: "running" };
    } else if (intent.action_kind === "job.launch") {
      const cancelled = await this.projection.hasCampaignAction(
        intent.campaign_id,
        "campaign.cancel",
      );
      const terminal = await this.allActionTasksTerminal(intent);
      const paused = await this.projection.campaignPaused(intent.campaign_id);
      const suppression: "cancelled" | "paused" | "terminal" | null = cancelled
        ? "cancelled"
        : paused
          ? "paused"
          : terminal
            ? "terminal"
            : null;
      const dispatch = suppression
        ? await this.projection.actionDispatch(intent.action_id)
        : null;
      if (suppression && !dispatch) {
        result = {
          outcome: "completed",
          observed_state: `suppressed-${suppression}`,
        };
      } else {
        const launchResult = await this.executeJobLaunch(intent, suppression);
        if (!launchResult) return;
        result = launchResult;
      }
    } else if (intent.action_kind === "job.observe") {
      const observation = await this.external.execute(intent);
      if (observation.outcome === "failed") return;
      result = observation;
    } else if (
      intent.action_kind === "sandbox.exec" ||
      intent.action_kind === "sandbox.write" ||
      intent.action_kind === "sandbox.read"
    ) {
      return;
    } else if (
      intent.action_kind === "sandbox.create" ||
      intent.action_kind === "sandbox.observe" ||
      intent.action_kind === "sandbox.close"
    ) {
      if (intent.action_kind === "sandbox.create") {
        const policy = intent.payload.sandbox;
        if (!policy) throw new PolicyError("Sandbox create is missing policy");
        const reservation = await this.projection.budget(
          deterministicId("budget", intent.campaign_id, "sandbox", intent.action_id),
        );
        if (!reservation) return;
        if (
          reservation.event_kind !== "reserve" ||
          reservation.amount_microusd !== policy.reservation_microusd
        )
          throw new PolicyError("Sandbox reservation does not match policy");
      }
      const dispatch = await this.projection.actionDispatch(intent.action_id);
      const admission =
        intent.action_kind === "sandbox.create"
          ? await this.projection.sandboxAdmission(intent.action_id)
          : null;
      if (
        intent.action_kind === "sandbox.create" &&
        !dispatch &&
        !admission &&
        intent.actor.subject.startsWith("worker:") &&
        Date.parse(intent.created_at) + 30_000 > Date.now()
      )
        return;
      if (!dispatch)
        await this.service.dispatchAction(
          intent,
          new Date(Date.now() + this.options.observation_interval_ms).toISOString(),
        );
      if (
        intent.action_kind === "sandbox.create" &&
        dispatch &&
        Date.parse(dispatch.adoption_not_before) > Date.now()
      )
        return;
      try {
        result = await this.external.execute(intent, {
          adoption_only: intent.action_kind === "sandbox.create" && Boolean(dispatch),
        });
      } catch (error) {
        if (
          intent.action_kind === "sandbox.create" &&
          error instanceof ExternalActionNotFoundError
        ) {
          const cancelled = await this.projection.hasCampaignAction(
            intent.campaign_id,
            "campaign.cancel",
          );
          result = {
            outcome: cancelled ? "completed" : "failed",
            observed_state: cancelled
              ? "suppressed-cancelled-not-found"
              : "sandbox-create-not-found",
            error_code: cancelled ? null : "sandbox_create_not_found",
          };
        } else if (error instanceof AmbiguousExternalActionError) return;
        else throw error;
      }
    } else if (
      intent.action_kind === "endpoint.pause" ||
      intent.action_kind === "endpoint.resume"
    ) {
      const observation = await this.external.execute(intent);
      if (
        observation.outcome === "failed" ||
        typeof observation.ready_replicas !== "number"
      )
        return;
      result = observation;
    } else {
      result = await this.external.execute(intent);
    }
    const receipt = await this.service.receipt(intent, result);
    await this.advance(intent, receipt);
    await this.service.markAdvanced(intent, receipt);
  }

  private async executeJobLaunch(
    intent: ActionIntent,
    suppression: "cancelled" | "paused" | "terminal" | null = null,
  ): Promise<ExternalActionResult | null> {
    const dispatch = await this.projection.actionDispatch(intent.action_id);
    if (dispatch) {
      if (Date.parse(dispatch.adoption_not_before) > Date.now()) return null;
      try {
        return await this.external.execute(intent, { adoption_only: true });
      } catch (error) {
        if (error instanceof ExternalActionNotFoundError) {
          return suppression
            ? {
                outcome: "completed",
                observed_state: `suppressed-${suppression}-not-found`,
              }
            : null;
        }
        if (error instanceof AmbiguousExternalActionError) return null;
        throw error;
      }
    }
    try {
      return await this.external.execute(intent, { adoption_only: true });
    } catch (error) {
      if (error instanceof AmbiguousExternalActionError) return null;
      if (!(error instanceof ExternalActionNotFoundError)) throw error;
    }
    const adoptionNotBefore = new Date(
      Date.now() + (this.options.dispatch_adoption_delay_ms ?? 60_000),
    ).toISOString();
    const fence = await this.service.dispatchAction(intent, adoptionNotBefore);
    if (!fence.created) return null;
    try {
      return await this.external.execute(intent);
    } catch (error) {
      if (error instanceof AmbiguousExternalActionError) return null;
      throw error;
    }
  }

  private async advance(intent: ActionIntent, receipt: ActionReceipt): Promise<void> {
    switch (intent.action_kind) {
      case "campaign.admit":
        await this.admit(intent, receipt);
        break;
      case "job.launch":
        if (receipt.observed_state.startsWith("suppressed-")) break;
        if (receipt.outcome === "failed") {
          if (intent.payload.worker_role === "preparation")
            await this.handlePreparationTerminal(intent, receipt, "ERROR");
          else await this.completeTasksFromJob(intent, receipt, "infrastructure");
        } else await this.observeJob(intent, receipt);
        break;
      case "job.observe":
        await this.handleJobObservation(intent, receipt);
        break;
      case "job.cancel":
        await this.continueCancellation(intent.campaign_id);
        break;
      case "campaign.resume": {
        const lock = await this.requiredLock(intent.campaign_id);
        const tasks = (await this.projection.tasks(intent.campaign_id)).filter(
          (task) => !task.terminal_outcome,
        );
        const limit =
          typeof intent.payload.task_limit === "number"
            ? intent.payload.task_limit
            : tasks.length;
        const taskIds = tasks.slice(0, limit).map((task) => task.task_id);
        if (taskIds.length > 0)
          await this.launchExecution(
            lock,
            receipt.created_at,
            intent.generation,
            taskIds,
          );
        break;
      }
      case "campaign.pause":
      case "publication.supersede":
        break;
      case "endpoint.resume":
      case "endpoint.pause":
        if (
          receipt.outcome === "failed" ||
          typeof receipt.ready_replicas !== "number"
        ) {
          await this.service.writeAction(
            this.service.actionIntent(
              intent.campaign_id,
              intent.action_kind,
              intent.target,
              intent.generation + 1,
              {
                ...intent.payload,
                not_before: new Date(
                  Date.parse(receipt.created_at) + this.options.observation_interval_ms,
                ).toISOString(),
              },
            ),
          );
        } else if (receipt.resource_id) await this.recordEndpoint(intent, receipt);
        break;
      case "sandbox.create":
      case "sandbox.observe":
      case "sandbox.exec":
      case "sandbox.write":
      case "sandbox.read":
      case "sandbox.close":
        break;
      case "campaign.cancel":
        await this.continueCancellation(intent.campaign_id);
        break;
      case "publication.publish":
        break;
    }
    if (
      !["campaign.cancel", "job.cancel"].includes(intent.action_kind) &&
      (await this.projection.hasCampaignAction(intent.campaign_id, "campaign.cancel"))
    )
      await this.continueCancellation(intent.campaign_id);
    await this.maybePublish(intent.campaign_id);
  }

  private async reserveInitialAction(
    campaignId: string,
    category: string,
    generation: number,
    amountMicrousd: number,
    createdAt: string,
  ): Promise<void> {
    if (amountMicrousd === 0) return;
    const budget: BudgetEvent = {
      schema_version: "v1",
      kind: "budget.event",
      record_id: deterministicId("budget", campaignId, category, String(generation)),
      created_at: createdAt,
      actor: { subject: "harbor-hf-control", role: "service" },
      campaign_id: campaignId,
      event_kind: "reserve",
      amount_microusd: amountMicrousd,
    };
    await this.service.append(budget);
  }

  private async admit(admission: ActionIntent, receipt: ActionReceipt): Promise<void> {
    const lock = await this.requiredLock(admission.campaign_id);
    const deployment = profile(lock, "deployment") as DeploymentProfileSpec;
    if (preparationRequired(deployment))
      await this.launchPreparation(lock, receipt.created_at, 0);
    else await this.launchExecution(lock, receipt.created_at, 0);
  }

  private async launchPreparation(
    lock: CampaignLock,
    createdAt: string,
    attempt: number,
  ): Promise<void> {
    const deployment = profile(lock, "deployment");
    const policy = profile(lock, "launch_policy");
    const reservation =
      typeof policy.preparation_reservation_microusd === "number"
        ? policy.preparation_reservation_microusd
        : 0;
    await this.reserveInitialAction(
      lock.campaign_id,
      "preparation",
      attempt,
      reservation,
      createdAt,
    );
    const hourly = optionalHourlyCost(deployment);
    const intent = this.service.actionIntent(
      lock.campaign_id,
      "job.launch",
      "campaign-preparation",
      attempt,
      {
        worker_role: "preparation",
        preparation_attempt: attempt,
        task_ids: lock.tasks.map((task) => task.task_id),
        job_image: profileScalar<string>(deployment, "job_image", "string"),
        job_command: profileStrings(deployment, "preparation_job_command"),
        hardware: profileScalar<string>(deployment, "hardware", "string"),
        timeout_seconds: profileScalar<number>(
          deployment,
          "preparation_timeout_seconds",
          "number",
        ),
        success_without_worker_receipt: true,
        max_infrastructure_attempts:
          typeof policy.max_preparation_attempts === "number"
            ? policy.max_preparation_attempts
            : 1,
        reservation_microusd: reservation,
        trusted_worker: profileScalar<boolean>(deployment, "trusted_worker", "boolean"),
        worker_revision: profileScalar<string>(deployment, "worker_revision", "string"),
        inference_token: "forbidden",
        campaign_lock_digest: sha256(canonicalJson(lock)),
        ...(hourly !== undefined ? { active_hourly_cost_microusd: hourly } : {}),
      },
    );
    await this.service.writeAction(intent);
  }

  private async launchExecution(
    lock: CampaignLock,
    createdAt: string,
    generation: number,
    taskIds = lock.tasks.map((task) => task.task_id),
  ): Promise<void> {
    const deployment = profile(lock, "deployment") as DeploymentProfileSpec;
    if (deployment.route !== "hf_job")
      throw new PolicyError("imported deployments cannot launch execution Jobs");
    const maximumTasks = deployment.worker_max_tasks_per_job ?? taskIds.length;
    if (taskIds.length > maximumTasks) {
      for (let offset = 0; offset < taskIds.length; offset += maximumTasks)
        await this.launchExecution(
          lock,
          createdAt,
          generation,
          taskIds.slice(offset, offset + maximumTasks),
        );
      return;
    }
    const batchKey = sha256(canonicalJson(taskIds)).slice(7, 23);
    const target =
      taskIds.length === lock.tasks.length
        ? "campaign-tasks"
        : `campaign-tasks-${batchKey}`;
    const policy = profile(lock, "launch_policy");
    const reservation = profileScalar<number>(policy, "reservation_microusd", "number");
    await this.reserveInitialAction(
      lock.campaign_id,
      `execution-${batchKey}`,
      generation,
      reservation,
      createdAt,
    );
    const inferenceToken = profileInferenceToken(
      deployment as unknown as Record<string, unknown>,
    );
    const inferenceLimits =
      inferenceToken === "required"
        ? {
            inference_max_requests: profileScalar<number>(
              deployment as unknown as Record<string, unknown>,
              "inference_max_requests",
              "number",
            ),
            inference_max_concurrency: profileScalar<number>(
              deployment as unknown as Record<string, unknown>,
              "inference_max_concurrency",
              "number",
            ),
            inference_timeout_seconds: profileScalar<number>(
              deployment as unknown as Record<string, unknown>,
              "inference_timeout_seconds",
              "number",
            ),
            inference_max_output_tokens: profileScalar<number>(
              deployment as unknown as Record<string, unknown>,
              "inference_max_output_tokens",
              "number",
            ),
          }
        : {};
    const prepared = preparationRequired(deployment)
      ? await this.service.preparedJob(lock.campaign_id)
      : null;
    if (preparationRequired(deployment) && !prepared)
      throw new PolicyError("campaign preparation is incomplete");
    const sandbox = deployment.sandbox;
    const sandboxAuthorized = Boolean(sandbox || deployment.sandbox_template);
    const sandboxTimeout =
      deployment.sandbox_template?.max_timeout_seconds ?? sandbox?.timeout_seconds;
    const hourly = optionalHourlyCost(deployment);
    const intent = this.service.actionIntent(
      lock.campaign_id,
      "job.launch",
      target,
      generation,
      {
        worker_role: "execution",
        task_ids: taskIds,
        job_image: deployment.job_image,
        job_command: deployment.job_command,
        hardware: deployment.hardware,
        timeout_seconds: deployment.timeout_seconds,
        success_without_worker_receipt: profileScalar<boolean>(
          policy,
          "success_without_worker_receipt",
          "boolean",
        ),
        max_infrastructure_attempts: profileScalar<number>(
          policy,
          "max_infrastructure_attempts",
          "number",
        ),
        required_positive_metrics: optionalProfileStrings(
          policy,
          "required_positive_metrics",
        ),
        reservation_microusd: reservation,
        trusted_worker: deployment.trusted_worker,
        ...(hourly !== undefined ? { active_hourly_cost_microusd: hourly } : {}),
        ...(deployment.worker_revision
          ? { worker_revision: deployment.worker_revision }
          : {}),
        inference_token: inferenceToken,
        ...inferenceLimits,
        campaign_lock_digest: sha256(canonicalJson(lock)),
        ...(prepared ? { prepared_job_digest: sha256(canonicalJson(prepared)) } : {}),
        ...(sandbox ? { sandbox } : {}),
        ...(sandboxAuthorized ? { sandbox_authorized: true } : {}),
        ...(sandboxTimeout ? { sandbox_timeout_seconds: sandboxTimeout } : {}),
      },
    );
    await this.service.writeAction(intent);
  }

  private async observeJob(
    launch: ActionIntent,
    receipt: ActionReceipt,
  ): Promise<void> {
    if (!receipt.resource_id)
      throw new PolicyError("job launch receipt has no remote identity");
    const intent = this.service.actionIntent(
      launch.campaign_id,
      "job.observe",
      receipt.resource_id,
      0,
      {
        ...launch.payload,
        resource_id: receipt.resource_id,
        launch_action_id: launch.action_id,
        not_before: new Date(
          Date.parse(receipt.created_at) + this.options.observation_interval_ms,
        ).toISOString(),
      },
    );
    await this.service.writeAction(intent);
  }

  private async handleJobObservation(
    intent: ActionIntent,
    receipt: ActionReceipt,
  ): Promise<void> {
    if (receipt.outcome === "failed") {
      const retry = this.service.actionIntent(
        intent.campaign_id,
        "job.observe",
        intent.target,
        intent.generation + 1,
        {
          ...intent.payload,
          not_before: new Date(
            Date.parse(receipt.created_at) + this.options.observation_interval_ms,
          ).toISOString(),
        },
      );
      await this.service.writeAction(retry);
      return;
    }
    const state = receipt.observed_state.toUpperCase();
    if (!jobStateIsTerminal(state)) {
      const next = this.service.actionIntent(
        intent.campaign_id,
        "job.observe",
        intent.target,
        intent.generation + 1,
        {
          ...intent.payload,
          not_before: new Date(
            Date.parse(receipt.created_at) + this.options.observation_interval_ms,
          ).toISOString(),
        },
      );
      await this.service.writeAction(next);
      return;
    }
    if (intent.payload.worker_role === "preparation") {
      await this.handlePreparationTerminal(intent, receipt, state);
      return;
    }
    if (state === "STOPPED" || state === "COMPLETED") {
      const successful = scalar<boolean>(
        intent.payload,
        "success_without_worker_receipt",
        "boolean",
      );
      const workerAttemptsPresent = await this.allWorkerAttemptsPresent(intent);
      const graceMs = this.options.worker_receipt_grace_ms ?? 0;
      const deadline = intent.payload.worker_receipt_deadline;
      const cancelling = await this.projection.hasCampaignAction(
        intent.campaign_id,
        "campaign.cancel",
      );
      const paused = await this.projection.campaignPaused(intent.campaign_id);
      if (
        !successful &&
        !workerAttemptsPresent &&
        !cancelling &&
        !paused &&
        typeof deadline !== "string" &&
        graceMs > 0
      ) {
        const workerReceiptDeadline = new Date(
          Date.parse(receipt.created_at) + graceMs,
        ).toISOString();
        const next = this.service.actionIntent(
          intent.campaign_id,
          "job.observe",
          intent.target,
          intent.generation + 1,
          {
            ...intent.payload,
            not_before: workerReceiptDeadline,
            worker_receipt_deadline: workerReceiptDeadline,
          },
        );
        await this.service.writeAction(next);
        return;
      }
      await this.completeTasksFromJob(
        intent,
        receipt,
        successful ? "complete" : "infrastructure",
      );
      return;
    }
    await this.completeTasksFromJob(intent, receipt, "infrastructure");
  }

  private async handlePreparationTerminal(
    intent: ActionIntent,
    receipt: ActionReceipt,
    state: string,
  ): Promise<void> {
    const successful = state === "STOPPED" || state === "COMPLETED";
    const prepared = successful
      ? await this.service.preparedJob(intent.campaign_id)
      : null;
    if (prepared) {
      const lock = await this.requiredLock(intent.campaign_id);
      if (prepared.campaign_lock_digest !== sha256(canonicalJson(lock)))
        throw new PolicyError("prepared job does not match the campaign lock");
      if (!(await this.projection.campaignPaused(intent.campaign_id)))
        await this.launchExecution(lock, receipt.created_at, 0);
      return;
    }
    const graceMs = this.options.worker_receipt_grace_ms ?? 0;
    const deadline = intent.payload.worker_receipt_deadline;
    const cancelling = await this.projection.hasCampaignAction(
      intent.campaign_id,
      "campaign.cancel",
    );
    if (successful && !cancelling && typeof deadline !== "string" && graceMs > 0) {
      const preparationDeadline = new Date(
        Date.parse(receipt.created_at) + graceMs,
      ).toISOString();
      await this.service.writeAction(
        this.service.actionIntent(
          intent.campaign_id,
          "job.observe",
          intent.target,
          intent.generation + 1,
          {
            ...intent.payload,
            not_before: preparationDeadline,
            worker_receipt_deadline: preparationDeadline,
          },
        ),
      );
      return;
    }
    const attempt =
      typeof intent.payload.preparation_attempt === "number"
        ? intent.payload.preparation_attempt
        : 0;
    const maximum = scalar<number>(
      intent.payload,
      "max_infrastructure_attempts",
      "number",
    );
    if (!cancelling && attempt + 1 < maximum) {
      const lock = await this.requiredLock(intent.campaign_id);
      await this.launchPreparation(lock, receipt.created_at, attempt + 1);
      return;
    }
    await this.completeTasksFromJob(intent, receipt, "infrastructure", false);
  }

  private async allWorkerAttemptsPresent(intent: ActionIntent): Promise<boolean> {
    await this.service.syncProjection();
    const taskIds = stringArray(intent.payload, "task_ids");
    const launchActionId = scalar<string>(intent.payload, "launch_action_id", "string");
    const attempts = await this.projection.campaignAttempts(intent.campaign_id);
    return taskIds.every((taskId) =>
      attempts.some(
        (attempt) => attempt.task_id === taskId && attempt.action_id === launchActionId,
      ),
    );
  }

  private async completeTasksFromJob(
    intent: ActionIntent,
    receipt: ActionReceipt,
    fallback: AttemptReceipt["outcome"],
    replacementEligible = fallback === "infrastructure",
  ): Promise<void> {
    const tasks = stringArray(intent.payload, "task_ids");
    const known = await this.projection.campaignAttempts(intent.campaign_id);
    const paused = await this.projection.campaignPaused(intent.campaign_id);
    for (const taskId of tasks) {
      const task = await this.projection.task(intent.campaign_id, taskId);
      if (!task || task.task.terminal_outcome) continue;
      const launchActionId =
        intent.action_kind === "job.launch"
          ? intent.action_id
          : scalar<string>(intent.payload, "launch_action_id", "string");
      const workerAttempt = known
        .filter(
          (attempt) =>
            attempt.task_id === taskId && attempt.action_id === launchActionId,
        )
        .at(-1);
      if (workerAttempt && workerAttempt.attempt_id !== task.task.selected_attempt_id) {
        const parsed = JSON.parse(workerAttempt.body) as AttemptReceipt;
        await this.finishAttempt(parsed, intent);
        continue;
      }
      if (paused) continue;
      const attemptId = deterministicId(
        "attempt",
        intent.campaign_id,
        taskId,
        intent.action_id,
      );
      const attempt = await this.service.attempt({
        campaign_id: intent.campaign_id,
        task_id: taskId,
        attempt_id: attemptId,
        action_id: launchActionId,
        outcome: fallback,
        replacement_eligible: replacementEligible,
        evidence_digest: sha256(canonicalJson(receipt)),
        evidence_path: controlRecordPath(receipt),
        cost_microusd: 0,
        metrics: {},
        completed_at: receipt.created_at,
      });
      await this.finishAttempt(attempt, intent);
    }
  }

  private async deferRetryUntilSandboxCleanup(source: ActionIntent): Promise<void> {
    if (source.action_kind !== "job.observe") return;
    await this.service.writeAction(
      this.service.actionIntent(
        source.campaign_id,
        "job.observe",
        source.target,
        source.generation + 1,
        {
          ...source.payload,
          not_before: new Date(
            Date.parse(source.created_at) + this.options.observation_interval_ms,
          ).toISOString(),
        },
      ),
    );
  }

  private async finishAttempt(
    attempt: AttemptReceipt,
    source: ActionIntent,
  ): Promise<void> {
    if (attempt.outcome === "cancelled") {
      await this.service.selectTerminal(attempt, "operator cancellation");
      return;
    }
    const required = Array.isArray(source.payload.required_positive_metrics)
      ? source.payload.required_positive_metrics
      : [];
    const validity = attemptAdmissibility(attempt, required);
    if (source.payload.worker_role === "preparation") {
      const attempts = (
        await this.projection.campaignAttempts(attempt.campaign_id)
      ).filter((item) => item.task_id === attempt.task_id);
      await this.service.exhaustTask(
        attempt,
        `campaign preparation exhausted: ${validity.reason}`,
        attempts.length,
      );
      return;
    }
    if (validity.admissible) {
      await this.service.selectTerminal(attempt, "valid terminal worker outcome");
      return;
    }

    await this.service.withInfrastructureRetryAdmission(async () => {
      if (
        await this.projection.retryActionForAttempt(
          attempt.campaign_id,
          attempt.attempt_id,
        )
      )
        return;
      if (await this.ensureSandboxCleanup(attempt.campaign_id, attempt.task_id)) {
        await this.deferRetryUntilSandboxCleanup(source);
        return;
      }
      const settlement = await this.service.settleClosedSandboxAmbiguities(
        attempt.campaign_id,
        attempt.task_id,
      );
      const unresolved = await this.projection.pendingDispatchedSandboxExecActions(
        attempt.campaign_id,
        attempt.task_id,
      );
      if (settlement.unresolved > 0 || unresolved.length > 0) return;
      const attempts = (
        await this.projection.campaignAttempts(attempt.campaign_id)
      ).filter((item) => item.task_id === attempt.task_id);
      const maxAttempts = scalar<number>(
        source.payload,
        "max_infrastructure_attempts",
        "number",
      );
      if (attempts.length >= maxAttempts) {
        await this.service.exhaustTask(
          attempt,
          `attempt limit exhausted: ${validity.reason}`,
          attempts.length,
        );
        return;
      }
      const reservation = scalar<number>(
        source.payload,
        "reservation_microusd",
        "number",
      );
      if (
        !(await this.service.reserveReplacement(
          attempt.campaign_id,
          attempt.attempt_id,
          attempt.created_at,
          reservation,
        ))
      ) {
        await this.service.exhaustTask(
          attempt,
          `campaign ceiling blocks replacement: ${validity.reason}`,
          attempts.length,
        );
        return;
      }
      const retry = this.service.actionIntent(
        attempt.campaign_id,
        "job.launch",
        attempt.task_id,
        attempts.length,
        {
          ...source.payload,
          task_ids: [attempt.task_id],
          prior_attempt_id: attempt.attempt_id,
        },
      );
      await this.service.writeAction(retry);
    });
  }

  private async ensureSandboxCleanup(
    campaignId: string,
    taskId?: string,
    actions?: Awaited<ReturnType<Projection["campaignActions"]>>,
  ): Promise<boolean> {
    let campaignActions =
      actions ?? (await this.projection.campaignActions(campaignId));
    const belongsToTask = (action: (typeof campaignActions)[number]): boolean => {
      if (taskId === undefined) return true;
      const intent = JSON.parse(action.intent_body) as ActionIntent;
      return intent.payload.task_id === taskId;
    };
    const unresolvedCreates = campaignActions.filter(
      (action) =>
        action.action_kind === "sandbox.create" &&
        action.receipt_body === null &&
        belongsToTask(action),
    );
    if (unresolvedCreates.length > 0) return true;
    const pendingCommandTasks = new Set<string>();
    for (const action of campaignActions) {
      if (
        action.action_kind !== "sandbox.exec" ||
        action.receipt_body !== null ||
        !belongsToTask(action)
      )
        continue;
      const intent = JSON.parse(action.intent_body) as ActionIntent;
      if (typeof intent.payload.task_id === "string")
        pendingCommandTasks.add(intent.payload.task_id);
    }
    for (const taskId of pendingCommandTasks)
      await this.service.settleClosedSandboxAmbiguities(campaignId, taskId);
    if (pendingCommandTasks.size > 0)
      campaignActions = await this.projection.campaignActions(campaignId);
    const pendingData = campaignActions.filter(
      (action) =>
        ["sandbox.exec", "sandbox.write", "sandbox.read"].includes(
          action.action_kind,
        ) &&
        action.receipt_body === null &&
        belongsToTask(action),
    );
    let pending = pendingData.length > 0;
    for (const action of pendingData) {
      const intent = JSON.parse(action.intent_body) as ActionIntent;
      const dispatched = await this.projection.actionDispatch(action.action_id);
      if (action.action_kind === "sandbox.exec" && dispatched) continue;
      const receipt = await this.service.receipt(intent, {
        outcome: "completed",
        observed_state: dispatched
          ? "suppressed-sandbox-cleanup-ambiguous"
          : "suppressed-sandbox-cleanup-before-dispatch",
      });
      await this.service.markAdvanced(intent, receipt);
    }
    const creates = campaignActions.filter(
      (action) =>
        action.action_kind === "sandbox.create" &&
        action.receipt_body !== null &&
        action.resource_id !== null &&
        belongsToTask(action),
    );
    for (const create of creates) {
      const createIntent = JSON.parse(create.intent_body) as ActionIntent;
      const closes = campaignActions.filter((action) => {
        if (action.action_kind !== "sandbox.close") return false;
        const closeIntent = JSON.parse(action.intent_body) as ActionIntent;
        return closeIntent.payload.sandbox_create_action_id === create.action_id;
      });
      if (
        closes.some(
          (action) =>
            action.receipt_body !== null &&
            action.outcome === "completed" &&
            jobStateIsTerminal(action.observed_state),
        )
      )
        continue;
      pending = true;
      if (closes.some((action) => action.receipt_body === null)) continue;
      if (
        !create.resource_id ||
        typeof createIntent.payload.task_id !== "string" ||
        !createIntent.payload.sandbox
      )
        throw new PolicyError("Sandbox create action is missing cleanup identity");
      await this.service.writeAction(
        this.service.actionIntent(
          campaignId,
          "sandbox.close",
          create.resource_id,
          closes.length,
          {
            task_id: createIntent.payload.task_id,
            sandbox_create_action_id: create.action_id,
            resource_id: create.resource_id,
            sandbox: createIntent.payload.sandbox,
          },
        ),
      );
    }
    return pending;
  }

  private async continueCancellation(campaignId: string): Promise<void> {
    const actions = await this.projection.campaignActions(campaignId);
    const unresolvedLaunches = actions.filter(
      (action) => action.action_kind === "job.launch" && action.receipt_body === null,
    );
    for (const launch of unresolvedLaunches) {
      if (await this.projection.actionDispatch(launch.action_id)) return;
    }
    if (await this.ensureSandboxCleanup(campaignId, undefined, actions)) return;
    const launches = actions.filter(
      (action) =>
        action.action_kind === "job.launch" &&
        action.receipt_body !== null &&
        action.resource_id !== null,
    );
    const active = new Map<
      string,
      { resource_id: string; launch_action_id: string; observed_at: string }
    >();
    for (const launch of launches) {
      const resourceId = launch.resource_id;
      if (!resourceId || active.has(resourceId)) continue;
      const observations = actions.filter(
        (action) =>
          action.target === resourceId &&
          action.receipt_body !== null &&
          ["job.observe", "job.cancel"].includes(action.action_kind),
      );
      if (observations.some((action) => jobStateIsTerminal(action.observed_state)))
        continue;
      const latest = observations[0];
      const state = latest?.observed_state ?? launch.observed_state;
      if (!jobStateIsTerminal(state)) {
        active.set(resourceId, {
          resource_id: resourceId,
          launch_action_id: launch.action_id,
          observed_at: latest?.created_at ?? launch.created_at,
        });
      }
    }
    if (active.size > 0) {
      for (const job of active.values()) {
        const cancellations = actions.filter(
          (action) =>
            action.action_kind === "job.cancel" && action.target === job.resource_id,
        );
        if (cancellations.some((action) => action.receipt_body === null)) continue;
        const generation =
          cancellations.reduce(
            (maximum, action) => Math.max(maximum, action.generation),
            -1,
          ) + 1;
        if (generation > 1_000_000)
          throw new PolicyError("Job cancellation action limit is exhausted");
        await this.service.writeAction(
          this.service.actionIntent(
            campaignId,
            "job.cancel",
            job.resource_id,
            generation,
            {
              resource_id: job.resource_id,
              launch_action_id: job.launch_action_id,
              not_before: new Date(
                Date.parse(job.observed_at) + this.options.observation_interval_ms,
              ).toISOString(),
            },
          ),
        );
      }
      return;
    }
    const cancellation = actions.find(
      (action) =>
        action.action_kind === "campaign.cancel" && action.receipt_body !== null,
    );
    if (!cancellation?.receipt_body) return;
    await this.cancelOpenTasks(
      campaignId,
      JSON.parse(cancellation.intent_body) as ActionIntent,
      JSON.parse(cancellation.receipt_body) as ActionReceipt,
    );
  }

  private async cancelOpenTasks(
    campaignId: string,
    intent: ActionIntent,
    receipt: ActionReceipt,
  ): Promise<void> {
    for (const task of await this.projection.tasks(campaignId)) {
      if (task.terminal_outcome) continue;
      const attempt = await this.service.attempt({
        campaign_id: campaignId,
        task_id: task.task_id,
        attempt_id: deterministicId(
          "attempt",
          campaignId,
          task.task_id,
          intent.action_id,
        ),
        action_id: intent.action_id,
        outcome: "cancelled",
        replacement_eligible: false,
        evidence_digest: sha256(canonicalJson(receipt)),
        evidence_path: controlRecordPath(receipt),
        cost_microusd: 0,
        metrics: {},
        completed_at: receipt.created_at,
      });
      await this.service.selectTerminal(attempt, "operator cancellation");
    }
  }

  private async recordEndpoint(
    intent: ActionIntent,
    receipt: ActionReceipt,
  ): Promise<void> {
    if (!receipt.resource_id)
      throw new PolicyError("endpoint receipt has no remote identity");
    if (typeof receipt.ready_replicas !== "number")
      throw new PolicyError("endpoint receipt has no replica observation");
    const readyReplicas = receipt.ready_replicas;
    const desired = intent.action_kind === "endpoint.pause" ? "paused" : "running";
    const record: EndpointResource = {
      schema_version: "v1",
      kind: "endpoint.resource",
      record_id: deterministicId("endpoint", intent.action_id),
      created_at: receipt.created_at,
      actor: { subject: "harbor-hf-control", role: "service" },
      campaign_id: intent.campaign_id,
      action_id: intent.action_id,
      endpoint_id: receipt.resource_id,
      desired_state: desired,
      observed_state: receipt.observed_state,
      ready_replicas: readyReplicas,
      cleanup_verified: desired === "paused" && readyReplicas === 0,
      active_hourly_cost_microusd: receipt.active_hourly_cost_microusd ?? 0,
    };
    await this.service.append(record);
  }

  private async maybePublish(campaignId: string): Promise<boolean> {
    const campaign = await this.projection.campaign(campaignId);
    if (
      !campaign ||
      campaign.total_tasks === 0 ||
      campaign.terminal_tasks !== campaign.total_tasks
    )
      return false;
    if (await this.ensureSandboxCleanup(campaignId)) return true;
    if (await this.ensureEndpointCleanup(campaignId)) return true;
    const refreshed = await this.projection.campaign(campaignId);
    if (!refreshed || refreshed.pending_actions > 0 || refreshed.cleanup_pending)
      return false;
    if (
      refreshed.admissible_tasks !== refreshed.total_tasks ||
      refreshed.exhausted_tasks > 0
    )
      return false;
    if (await this.projection.campaignPublication(campaignId)) return false;
    if (await this.projection.hasCampaignAction(campaignId, "publication.publish"))
      return false;
    await this.service.writeAction(
      this.service.actionIntent(campaignId, "publication.publish", "results", 0, {}),
    );
    return true;
  }

  private async ensureEndpointCleanup(campaignId: string): Promise<boolean> {
    const endpoints = (await this.projection.endpoints(10_000)).filter(
      (endpoint) =>
        endpoint.campaign_id === campaignId && endpoint.cleanup_verified === 0,
    );
    if (endpoints.length === 0) return false;
    const actions = await this.projection.actions(10_000);
    let created = false;
    for (const endpoint of endpoints) {
      const pauses = actions.filter(
        (action) =>
          action.campaign_id === campaignId &&
          action.action_kind === "endpoint.pause" &&
          action.target === endpoint.endpoint_id,
      );
      if (pauses.some((action) => action.receipt_body === null)) continue;
      const generation =
        pauses.reduce((maximum, action) => Math.max(maximum, action.generation), -1) +
        1;
      if (generation > 1_000_000)
        throw new PolicyError("endpoint cleanup action limit is exhausted");
      await this.service.writeAction(
        this.service.actionIntent(
          campaignId,
          "endpoint.pause",
          endpoint.endpoint_id,
          generation,
          {
            endpoint_id: endpoint.endpoint_id,
            not_before: new Date(
              Date.parse(endpoint.created_at) + this.options.observation_interval_ms,
            ).toISOString(),
          },
        ),
      );
      created = true;
    }
    return created;
  }

  private async allActionTasksTerminal(intent: ActionIntent): Promise<boolean> {
    const taskIds = stringArray(intent.payload, "task_ids");
    if (taskIds.length === 0) return false;
    for (const taskId of taskIds) {
      const task = await this.projection.task(intent.campaign_id, taskId);
      if (!task?.task.terminal_outcome) return false;
    }
    return true;
  }

  private async requiredLock(campaignId: string): Promise<CampaignLock> {
    const lock = await this.projection.campaignLock(campaignId);
    if (!lock) throw new PolicyError(`campaign lock is missing: ${campaignId}`);
    return lock;
  }
}

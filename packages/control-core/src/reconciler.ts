import type {
  ActionIntent,
  ActionReceipt,
  AttemptReceipt,
  BudgetEvent,
  CampaignLock,
  EndpointResource,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sha256,
} from "@harbor-hf/contracts";
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
    for (const intent of await this.projection.pendingActions(
      this.options.batch_size,
    )) {
      const notBefore = intent.payload.not_before;
      if (typeof notBefore === "string" && Date.parse(notBefore) > Date.now()) continue;
      await this.handle(intent);
      handled += 1;
    }
    for (const campaign of await this.projection.campaigns(10_000)) {
      if (await this.maybePublish(campaign.campaign_id)) handled += 1;
    }
    return handled;
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
    } else if (intent.action_kind === "campaign.cancel") {
      result = { outcome: "completed", observed_state: "cancelled" };
    } else if (intent.action_kind === "job.launch") {
      const cancelled = await this.projection.hasCampaignAction(
        intent.campaign_id,
        "campaign.cancel",
      );
      const terminal = await this.allActionTasksTerminal(intent);
      const suppression: "cancelled" | "terminal" | null = cancelled
        ? "cancelled"
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
      if (!dispatch)
        await this.service.dispatchAction(
          intent,
          new Date(Date.now() + this.options.observation_interval_ms).toISOString(),
        );
      result = await this.external.execute(intent, {
        adoption_only: intent.action_kind === "sandbox.create" && Boolean(dispatch),
      });
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
    suppression: "cancelled" | "terminal" | null = null,
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
        if (receipt.outcome === "failed")
          await this.completeTasksFromJob(intent, receipt, "infrastructure");
        else await this.observeJob(intent, receipt);
        break;
      case "job.observe":
        await this.handleJobObservation(intent, receipt);
        break;
      case "job.cancel":
        await this.continueCancellation(intent.campaign_id);
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

  private async admit(admission: ActionIntent, receipt: ActionReceipt): Promise<void> {
    const campaignId = admission.campaign_id;
    const lock = await this.requiredLock(campaignId);
    const deployment = profile(lock, "deployment");
    const policy = profile(lock, "launch_policy");
    const reservation = profileScalar<number>(policy, "reservation_microusd", "number");
    if (reservation > lock.ceiling_microusd) return;
    if (reservation > 0) {
      const budget: BudgetEvent = {
        schema_version: "v1",
        kind: "budget.event",
        record_id: deterministicId("budget", campaignId, "reserve", "0"),
        created_at: receipt.created_at,
        actor: { subject: "harbor-hf-control", role: "service" },
        campaign_id: campaignId,
        event_kind: "reserve",
        amount_microusd: reservation,
      };
      await this.service.append(budget);
    }
    const inferenceToken = profileInferenceToken(deployment);
    const inferenceLimits =
      inferenceToken === "required"
        ? {
            inference_max_requests: profileScalar<number>(
              deployment,
              "inference_max_requests",
              "number",
            ),
            inference_max_concurrency: profileScalar<number>(
              deployment,
              "inference_max_concurrency",
              "number",
            ),
            inference_timeout_seconds: profileScalar<number>(
              deployment,
              "inference_timeout_seconds",
              "number",
            ),
            inference_max_output_tokens: profileScalar<number>(
              deployment,
              "inference_max_output_tokens",
              "number",
            ),
          }
        : {};
    const sandbox = deployment.sandbox;
    if (
      sandbox !== undefined &&
      (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox))
    )
      throw new PolicyError("profile sandbox must be an object");
    const sandboxPolicy = sandbox as ActionIntent["payload"]["sandbox"];
    const intent = this.service.actionIntent(
      campaignId,
      "job.launch",
      "campaign-tasks",
      0,
      {
        task_ids: lock.tasks.map((task) => task.task_id),
        job_image: profileScalar<string>(deployment, "job_image", "string"),
        job_command: profileStrings(deployment, "job_command"),
        hardware: profileScalar<string>(deployment, "hardware", "string"),
        timeout_seconds: profileScalar<number>(deployment, "timeout_seconds", "number"),
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
        reservation_microusd: reservation,
        trusted_worker: profileScalar<boolean>(deployment, "trusted_worker", "boolean"),
        inference_token: inferenceToken,
        ...inferenceLimits,
        campaign_lock_digest: sha256(canonicalJson(lock)),
        ...(sandboxPolicy ? { sandbox: sandboxPolicy } : {}),
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
      if (
        !successful &&
        !workerAttemptsPresent &&
        !cancelling &&
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
  ): Promise<void> {
    const tasks = stringArray(intent.payload, "task_ids");
    const known = await this.projection.campaignAttempts(intent.campaign_id);
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
        replacement_eligible: fallback === "infrastructure",
        evidence_digest: sha256(canonicalJson(receipt)),
        evidence_path: controlRecordPath(receipt),
        cost_microusd: receipt.cost_microusd ?? 0,
        metrics: {},
        completed_at: receipt.created_at,
      });
      await this.finishAttempt(attempt, intent);
    }
  }

  private async finishAttempt(
    attempt: AttemptReceipt,
    source: ActionIntent,
  ): Promise<void> {
    if (attempt.outcome === "infrastructure" && attempt.replacement_eligible) {
      await this.service.withInfrastructureRetryAdmission(async () => {
        if (
          await this.projection.retryActionForAttempt(
            attempt.campaign_id,
            attempt.attempt_id,
          )
        )
          return;
        const attempts = (
          await this.projection.campaignAttempts(attempt.campaign_id)
        ).filter((item) => item.task_id === attempt.task_id);
        const maxAttempts = scalar<number>(
          source.payload,
          "max_infrastructure_attempts",
          "number",
        );
        if (attempts.length < maxAttempts) {
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
            await this.service.selectTerminal(
              attempt,
              "replacement Job would exceed the campaign ceiling",
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
          return;
        }
        await this.service.selectTerminal(
          attempt,
          "infrastructure retry budget exhausted",
        );
      });
      return;
    }
    await this.service.selectTerminal(attempt, "valid terminal worker outcome");
  }

  private async continueCancellation(campaignId: string): Promise<void> {
    const actions = await this.projection.campaignActions(campaignId);
    const unresolvedLaunches = actions.filter(
      (action) => action.action_kind === "job.launch" && action.receipt_body === null,
    );
    for (const launch of unresolvedLaunches) {
      if (await this.projection.actionDispatch(launch.action_id)) return;
    }
    const unresolvedSandboxes = actions.filter(
      (action) =>
        action.action_kind === "sandbox.create" && action.receipt_body === null,
    );
    if (unresolvedSandboxes.length > 0) return;
    const sandboxCreates = actions.filter(
      (action) =>
        action.action_kind === "sandbox.create" &&
        action.receipt_body !== null &&
        action.resource_id !== null,
    );
    let sandboxCleanupPending = false;
    for (const create of sandboxCreates) {
      const createIntent = JSON.parse(create.intent_body) as ActionIntent;
      const closes = actions.filter((action) => {
        if (action.action_kind !== "sandbox.close") return false;
        const closeIntent = JSON.parse(action.intent_body) as ActionIntent;
        return closeIntent.payload.sandbox_create_action_id === create.action_id;
      });
      if (
        closes.some(
          (action) =>
            action.receipt_body !== null && jobStateIsTerminal(action.observed_state),
        )
      )
        continue;
      sandboxCleanupPending = true;
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
    if (sandboxCleanupPending) return;
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
    if (await this.ensureEndpointCleanup(campaignId)) return true;
    const refreshed = await this.projection.campaign(campaignId);
    if (!refreshed || refreshed.pending_actions > 0 || refreshed.cleanup_pending)
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

import type {
  ActionIntent,
  ActionReceipt,
  AttemptReceipt,
  BudgetEvent,
  CampaignLock,
  EndpointResource,
} from "@harbor-hf/contracts";
import { deterministicId, sha256 } from "@harbor-hf/contracts";
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

export interface ExternalActionPort {
  execute(intent: ActionIntent): Promise<ExternalActionResult>;
}

export interface ReconcilerOptions {
  interval_ms: number;
  observation_interval_ms: number;
  batch_size: number;
}

const defaultOptions: ReconcilerOptions = {
  interval_ms: 2_000,
  observation_interval_ms: 5_000,
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

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly service: ControlService,
    private readonly projection: Projection,
    private readonly external: ExternalActionPort,
    private readonly publisher: ResultPublisher,
    private readonly options: ReconcilerOptions = defaultOptions,
  ) {}

  start(signal?: AbortSignal): void {
    if (this.timer) return;
    const run = async () => {
      if (!this.running) {
        this.running = true;
        try {
          await this.tick();
        } finally {
          this.running = false;
        }
      }
    };
    this.timer = setInterval(() => void run(), this.options.interval_ms);
    void run();
    signal?.addEventListener("abort", () => this.stop(), { once: true });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    let handled = 0;
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
    } else if (
      intent.action_kind === "job.launch" &&
      (await this.allActionTasksTerminal(intent))
    ) {
      result = { outcome: "completed", observed_state: "suppressed-terminal" };
    } else {
      result = await this.external.execute(intent);
    }
    const receipt = await this.service.receipt(intent, result);
    await this.advance(intent, receipt);
    await this.service.markAdvanced(intent, receipt);
  }

  private async advance(intent: ActionIntent, receipt: ActionReceipt): Promise<void> {
    switch (intent.action_kind) {
      case "campaign.admit":
        await this.admit(intent, receipt);
        break;
      case "job.launch":
        if (receipt.observed_state === "suppressed-terminal") break;
        if (receipt.outcome === "failed")
          await this.completeTasksFromJob(intent, receipt, "infrastructure");
        else await this.observeJob(intent, receipt);
        break;
      case "job.observe":
        await this.handleJobObservation(intent, receipt);
        break;
      case "endpoint.resume":
      case "endpoint.pause":
        if (receipt.resource_id) await this.recordEndpoint(intent, receipt);
        break;
      case "campaign.cancel":
        await this.cancelOpenTasks(intent.campaign_id, intent, receipt);
        break;
      case "publication.publish":
        break;
    }
    await this.maybePublish(intent.campaign_id);
  }

  private async admit(admission: ActionIntent, receipt: ActionReceipt): Promise<void> {
    const campaignId = admission.campaign_id;
    const lock = await this.requiredLock(campaignId);
    const deployment = profile(lock, "deployment");
    const policy = profile(lock, "launch_policy");
    const reservation = profileScalar<number>(policy, "reservation_microusd", "number");
    if (reservation > lock.ceiling_microusd)
      throw new PolicyError("launch reservation exceeds the campaign ceiling");
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
        ...(deployment.requires_hf_token === undefined
          ? {}
          : {
              requires_hf_token: profileScalar<boolean>(
                deployment,
                "requires_hf_token",
                "boolean",
              ),
            }),
        ...(deployment.trusted_worker === undefined
          ? {}
          : {
              trusted_worker: profileScalar<boolean>(
                deployment,
                "trusted_worker",
                "boolean",
              ),
            }),
        ...(deployment.mount_bucket === undefined
          ? {}
          : {
              mount_bucket: profileScalar<boolean>(
                deployment,
                "mount_bucket",
                "boolean",
              ),
            }),
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
    const state = receipt.observed_state.toUpperCase();
    if (["RUNNING", "UPDATING", "PENDING"].includes(state)) {
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
      await this.completeTasksFromJob(
        intent,
        receipt,
        successful ? "complete" : "infrastructure",
      );
      return;
    }
    await this.completeTasksFromJob(intent, receipt, "infrastructure");
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
      const evidence = {
        action_id: intent.action_id,
        resource_id: receipt.resource_id ?? null,
        state: receipt.observed_state,
      };
      const attempt = await this.service.attempt({
        campaign_id: intent.campaign_id,
        task_id: taskId,
        attempt_id: attemptId,
        action_id: launchActionId,
        outcome: fallback,
        replacement_eligible: fallback === "infrastructure",
        evidence_digest: sha256(JSON.stringify(evidence)),
        evidence_path: `control/actions/${intent.action_id}`,
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
      const attempts = (
        await this.projection.campaignAttempts(attempt.campaign_id)
      ).filter((item) => item.task_id === attempt.task_id);
      const maxAttempts = scalar<number>(
        source.payload,
        "max_infrastructure_attempts",
        "number",
      );
      if (attempts.length < maxAttempts) {
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
    }
    await this.service.selectTerminal(
      attempt,
      attempt.outcome === "infrastructure"
        ? "infrastructure retry budget exhausted"
        : "valid terminal worker outcome",
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
        evidence_digest: sha256(intent.action_id),
        evidence_path: `control/actions/${intent.action_id}`,
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
    const readyReplicas = receipt.ready_replicas ?? 0;
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

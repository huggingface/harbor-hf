import type {
  ActionAdvanced,
  ActionDispatch,
  ActionIntent,
  ActionReceipt,
  Actor,
  AttemptReceipt,
  BudgetEvent,
  CampaignActionV1,
  CampaignLock,
  CampaignRequest,
  CampaignSubmissionV1,
  DeploymentProfileSpec,
  HarborHFControlRecordV1,
  LaunchPolicySpec,
  PublicationReceipt,
  ResolvedProfile,
  TerminalSelection,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sha256,
  validateCampaignAction,
  validateCampaignSubmission,
  validateControlRecord,
  workerEvidenceObjectPath,
} from "@harbor-hf/contracts";
import {
  EvidenceIntegrityError,
  verifyEvidenceReference,
  verifyWorkerEvidence,
} from "./evidence.js";
import { EventBus, eventCursor } from "./events.js";
import { type LoadedProfile, ProfileResolver, profileSpec } from "./profiles.js";
import type { Projection } from "./projection.js";
import { createJson, type ImmutableObjectStore } from "./store.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface AttemptInput {
  campaign_id: string;
  task_id: string;
  attempt_id: string;
  action_id: string;
  outcome: AttemptReceipt["outcome"];
  replacement_eligible: boolean;
  evidence_digest: string;
  evidence_path: string;
  cost_microusd: number;
  metrics: Record<string, number>;
  completed_at: string;
}

export interface EvidenceUploadResult {
  path: string;
  digest: string;
  size: number;
  created: boolean;
}

export interface SubmissionResult {
  campaign_id: string;
  action_id: string;
  status_url: string;
  adopted: boolean;
}

export class ControlNotReadyError extends Error {}
export class ConfirmationRequiredError extends Error {}
export class IdempotencyConflictError extends Error {}
export class PolicyError extends Error {}

function serviceActor(): Actor {
  return { subject: "harbor-hf-control", role: "service" };
}

export class ControlService {
  readonly resolver: ProfileResolver;
  private appendQueue: Promise<void> = Promise.resolve();
  private attemptQueue: Promise<void> = Promise.resolve();
  private budgetQueue: Promise<void> = Promise.resolve();
  private retryAdmissionQueue: Promise<void> = Promise.resolve();
  private submitQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly namespace: string,
    readonly store: ImmutableObjectStore,
    readonly projection: Projection,
    builtInProfiles: readonly LoadedProfile[],
    readonly events = new EventBus(),
    readonly clock: Clock = systemClock,
  ) {
    this.resolver = new ProfileResolver(builtInProfiles);
  }

  async initialize(builtInProfiles: readonly LoadedProfile[]): Promise<void> {
    for (const item of builtInProfiles) await this.append(item.profile);
    await this.refreshProfileResolver();
  }

  async refreshProfileResolver(): Promise<void> {
    this.resolver.replacePromotedProfiles(
      await this.projection.approvedProfileAliases(),
    );
  }

  private assertReady(): void {
    if (!this.projection.system().ready)
      throw new ControlNotReadyError("control projection is not ready");
  }

  async append<T extends HarborHFControlRecordV1>(
    record: T,
  ): Promise<{ created: boolean; key: string; digest: string }> {
    const operation = this.appendQueue.then(() => this.appendSerialized(record));
    this.appendQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async appendSerialized<T extends HarborHFControlRecordV1>(
    record: T,
  ): Promise<{ created: boolean; key: string; digest: string }> {
    validateControlRecord<T>(record);
    if (record.kind === "attempt.receipt" && record.actor.role !== "migration") {
      try {
        if (record.actor.subject === "harbor-hf-control")
          await verifyEvidenceReference(
            this.store,
            record.evidence_path,
            record.evidence_digest,
          );
        else await verifyWorkerEvidence(this.store, record);
      } catch (error) {
        if (!(error instanceof EvidenceIntegrityError)) throw error;
        throw new PolicyError("attempt evidence verification failed");
      }
    }
    const key = controlRecordPath(record);
    const result = await createJson(this.store, key, record);
    const projected = await this.projection.objectDigest(key);
    if (projected && projected !== result.digest)
      throw new IdempotencyConflictError(`projection digest conflict at ${key}`);
    if (!projected) {
      await this.projection.ingest(key, result.digest, record);
      this.events.publish({
        id: eventCursor(record.created_at, key),
        type: record.kind,
        occurred_at: record.created_at,
        data: { key, digest: result.digest, record_id: record.record_id },
      });
      if (record.kind === "profile.object" || record.kind === "profile.promotion")
        await this.refreshProfileResolver();
    }
    return { ...result, key };
  }

  async syncProjection(): Promise<number> {
    const operation = this.appendQueue.then(async () => {
      const ingested = await this.projection.sync(this.store);
      if (ingested > 0) await this.refreshProfileResolver();
      return ingested;
    });
    this.appendQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async submit(
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<SubmissionResult> {
    const operation = this.submitQueue.then(() =>
      this.submitSerialized(raw, idempotencyKey, actor),
    );
    this.submitQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async submitSerialized(
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<SubmissionResult> {
    this.assertReady();
    if (!idempotencyKey || idempotencyKey.length > 256)
      throw new IdempotencyConflictError("a bounded idempotency key is required");
    const input = validateCampaignSubmission<CampaignSubmissionV1>(raw);
    if (!input.confirmed)
      throw new ConfirmationRequiredError(
        "campaign submission requires explicit confirmation",
      );
    const keyDigest = sha256(idempotencyKey);
    const campaignId = deterministicId(
      "campaign",
      this.namespace,
      actor.subject,
      keyDigest,
    );
    const actionId = deterministicId(
      "action",
      campaignId,
      "campaign.admit",
      "campaign",
      "0",
    );
    const existingRequest = await this.projection.campaignRequest(campaignId);
    const existingLock = await this.projection.campaignLock(campaignId);
    if (existingRequest) this.assertMatchingRequest(existingRequest, input, actor);
    if (existingLock) this.assertMatchingSubmission(existingLock, input);

    const profiles = existingLock?.profiles ?? this.resolver.resolve(input);
    const deployment = profileSpec<DeploymentProfileSpec>(profiles, "deployment");
    if (deployment.route !== "hf_job")
      throw new PolicyError("imported deployment profiles cannot launch campaigns");
    const timestamp =
      existingLock?.created_at ??
      existingRequest?.created_at ??
      this.clock.now().toISOString();
    const recordActor = existingLock?.actor ?? existingRequest?.actor ?? actor;
    const refs = profiles.map((profile) => ({
      kind: profile.kind,
      alias: profile.name,
    }));
    const request: CampaignRequest =
      existingRequest ??
      ({
        schema_version: "v1",
        kind: "campaign.request",
        record_id: deterministicId("request", campaignId),
        created_at: timestamp,
        actor: recordActor,
        campaign_id: campaignId,
        idempotency_key_digest: keyDigest,
        profiles: refs as CampaignRequest["profiles"],
        ceiling_microusd: input.ceiling_microusd,
      } satisfies CampaignRequest);
    const lock: CampaignLock =
      existingLock ??
      ({
        schema_version: "v1",
        kind: "campaign.lock",
        record_id: deterministicId("lock", campaignId),
        created_at: timestamp,
        actor: recordActor,
        campaign_id: campaignId,
        profiles: profiles as CampaignLock["profiles"],
        tasks: this.resolver.tasks(input.benchmark) as CampaignLock["tasks"],
        ceiling_microusd: input.ceiling_microusd,
        source_revision: this.resolver.sourceRevision(),
      } satisfies CampaignLock);
    const budget: BudgetEvent = {
      schema_version: "v1",
      kind: "budget.event",
      record_id: deterministicId("budget", campaignId, "ceiling"),
      created_at: timestamp,
      actor: recordActor,
      campaign_id: campaignId,
      event_kind: "ceiling",
      amount_microusd: input.ceiling_microusd,
    };
    const intent = this.actionIntent(
      campaignId,
      "campaign.admit",
      "campaign",
      0,
      {},
      recordActor,
      timestamp,
    );

    await this.append(lock);
    await this.append(request);
    await this.append(budget);
    await this.append(intent);
    return {
      campaign_id: campaignId,
      action_id: actionId,
      status_url: `/api/v1/campaigns/${campaignId}`,
      adopted: Boolean(existingRequest || existingLock),
    };
  }

  private assertMatchingRequest(
    request: CampaignRequest,
    input: CampaignSubmissionV1,
    actor: Actor,
  ): void {
    const selected = Object.fromEntries(
      request.profiles.map((profile) => [profile.kind, profile.alias]),
    );
    const deploymentMatches =
      input.deployment === null ||
      input.deployment === undefined ||
      selected.deployment === input.deployment;
    const matches =
      request.actor.subject === actor.subject &&
      selected.benchmark === input.benchmark &&
      selected.model === input.model &&
      selected.harness === input.harness &&
      deploymentMatches &&
      selected.launch_policy === input.launch_policy &&
      request.ceiling_microusd === input.ceiling_microusd;
    if (!matches)
      throw new IdempotencyConflictError(
        "idempotency key already belongs to a different campaign request",
      );
  }

  private assertMatchingSubmission(
    lock: CampaignLock,
    input: CampaignSubmissionV1,
  ): void {
    const selected = Object.fromEntries(
      lock.profiles.map((profile) => [profile.kind, profile.name]),
    );
    const deploymentMatches =
      input.deployment === null ||
      input.deployment === undefined ||
      selected.deployment === input.deployment;
    const matches =
      selected.benchmark === input.benchmark &&
      selected.model === input.model &&
      selected.harness === input.harness &&
      deploymentMatches &&
      selected.launch_policy === input.launch_policy &&
      lock.ceiling_microusd === input.ceiling_microusd;
    if (!matches)
      throw new IdempotencyConflictError(
        "idempotency key already belongs to a different campaign request",
      );
  }

  actionIntent(
    campaignId: string,
    actionKind: ActionIntent["action_kind"],
    target: string,
    generation: number,
    payload: ActionIntent["payload"],
    actor: Actor = serviceActor(),
    timestamp = this.clock.now().toISOString(),
  ): ActionIntent {
    const actionId = deterministicId(
      "action",
      campaignId,
      actionKind,
      target,
      String(generation),
    );
    return {
      schema_version: "v1",
      kind: "action.intent",
      record_id: actionId,
      created_at: timestamp,
      actor,
      action_id: actionId,
      campaign_id: campaignId,
      action_kind: actionKind,
      generation,
      target,
      payload,
    };
  }

  async writeAction(intent: ActionIntent): Promise<void> {
    const existing = await this.projection.action(intent.action_id);
    if (existing) {
      const recorded = JSON.parse(existing.intent_body) as ActionIntent;
      const same =
        recorded.campaign_id === intent.campaign_id &&
        recorded.action_kind === intent.action_kind &&
        recorded.generation === intent.generation &&
        recorded.target === intent.target &&
        canonicalJson(recorded.payload) === canonicalJson(intent.payload);
      if (!same)
        throw new IdempotencyConflictError(
          `action identity conflict: ${intent.action_id}`,
        );
      return;
    }
    const taskId =
      typeof intent.payload.task_id === "string" ? intent.payload.task_id : null;
    if (taskId) {
      const task = await this.projection.task(intent.campaign_id, taskId);
      if (task?.task.terminal_outcome)
        throw new PolicyError(`terminal task cannot receive action: ${taskId}`);
    }
    await this.append(intent);
  }

  async dispatchAction(
    intent: ActionIntent,
    adoptionNotBefore: string,
  ): Promise<{ record: ActionDispatch; created: boolean }> {
    if (intent.action_kind !== "job.launch")
      throw new PolicyError("only Job launches use create dispatch fences");
    const existing = await this.projection.actionDispatch(intent.action_id);
    if (existing)
      return {
        record: JSON.parse(existing.body) as ActionDispatch,
        created: false,
      };
    const record: ActionDispatch = {
      schema_version: "v1",
      kind: "action.dispatch",
      record_id: deterministicId("action-dispatch", intent.action_id),
      created_at: this.clock.now().toISOString(),
      actor: serviceActor(),
      action_id: intent.action_id,
      campaign_id: intent.campaign_id,
      operation: "create",
      adoption_not_before: adoptionNotBefore,
    };
    const result = await this.append(record);
    return { record, created: result.created };
  }

  async receipt(
    intent: ActionIntent,
    result: {
      outcome: ActionReceipt["outcome"];
      observed_state: string;
      resource_id?: string | null;
      error_code?: string | null;
      ready_replicas?: number | null;
      active_hourly_cost_microusd?: number | null;
      cost_microusd?: number | null;
    },
  ): Promise<ActionReceipt> {
    const receipt: ActionReceipt = {
      schema_version: "v1",
      kind: "action.receipt",
      record_id: deterministicId("receipt", intent.action_id),
      created_at: this.clock.now().toISOString(),
      actor: serviceActor(),
      action_id: intent.action_id,
      campaign_id: intent.campaign_id,
      outcome: result.outcome,
      resource_id: result.resource_id ?? null,
      observed_state: result.observed_state,
      error_code: result.error_code ?? null,
      ready_replicas: result.ready_replicas ?? null,
      active_hourly_cost_microusd: result.active_hourly_cost_microusd ?? null,
      cost_microusd: result.cost_microusd ?? null,
    };
    await this.append(receipt);
    return receipt;
  }

  async markAdvanced(
    intent: ActionIntent,
    receipt: ActionReceipt,
  ): Promise<ActionAdvanced> {
    if (
      receipt.action_id !== intent.action_id ||
      receipt.campaign_id !== intent.campaign_id
    )
      throw new PolicyError("advanced action receipt does not match its intent");
    const record: ActionAdvanced = {
      schema_version: "v1",
      kind: "action.advanced",
      record_id: deterministicId("advanced", intent.action_id),
      created_at: receipt.created_at,
      actor: serviceActor(),
      action_id: intent.action_id,
      campaign_id: intent.campaign_id,
    };
    await this.append(record);
    return record;
  }

  async uploadEvidenceObject(
    campaignId: string,
    actionId: string,
    taskId: string,
    expectedDigest: string,
    bytes: Uint8Array,
  ): Promise<EvidenceUploadResult> {
    const action = await this.projection.action(actionId);
    if (
      !action ||
      action.campaign_id !== campaignId ||
      action.action_kind !== "job.launch"
    )
      throw new PolicyError("evidence upload has no eligible Job launch");
    const intent = JSON.parse(action.intent_body) as ActionIntent;
    if (
      !Array.isArray(intent.payload.task_ids) ||
      !intent.payload.task_ids.includes(taskId)
    )
      throw new PolicyError("evidence upload task is outside the Job launch");
    if (!(await this.projection.task(campaignId, taskId)))
      throw new PolicyError("evidence upload task does not exist");
    const observedDigest = sha256(bytes);
    if (observedDigest !== expectedDigest)
      throw new PolicyError("evidence upload digest does not match its content");
    const path = workerEvidenceObjectPath(campaignId, actionId, taskId, observedDigest);
    const result = await this.store.create(path, bytes);
    return {
      path,
      digest: observedDigest,
      size: bytes.byteLength,
      created: result.created,
    };
  }

  async attempt(
    input: AttemptInput,
    actor: Actor = serviceActor(),
  ): Promise<AttemptReceipt> {
    return (await this.enqueueAttempt(input, actor)).receipt;
  }

  async attemptWithStatus(
    input: AttemptInput,
    actor: Actor = serviceActor(),
  ): Promise<{ receipt: AttemptReceipt; adopted: boolean }> {
    return this.enqueueAttempt(input, actor);
  }

  private async enqueueAttempt(
    input: AttemptInput,
    actor: Actor,
  ): Promise<{ receipt: AttemptReceipt; adopted: boolean }> {
    const operation = this.attemptQueue.then(() =>
      this.attemptSerialized(input, actor),
    );
    this.attemptQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async attemptSerialized(
    input: AttemptInput,
    actor: Actor,
  ): Promise<{ receipt: AttemptReceipt; adopted: boolean }> {
    const { completed_at, ...fields } = input;
    const candidate: AttemptReceipt = {
      schema_version: "v1",
      kind: "attempt.receipt",
      record_id: deterministicId("attempt-receipt", input.attempt_id),
      created_at: completed_at,
      actor,
      ...fields,
    };
    const existing = await this.projection.attemptById(input.attempt_id);
    if (existing) {
      const record = JSON.parse(existing.body) as AttemptReceipt;
      if (canonicalJson(record) !== canonicalJson(candidate))
        throw new IdempotencyConflictError(
          `attempt identity conflict: ${input.attempt_id}`,
        );
      return { receipt: record, adopted: true };
    }
    const action = await this.projection.action(input.action_id);
    if (
      !action ||
      action.campaign_id !== input.campaign_id ||
      !["job.launch", "campaign.cancel"].includes(action.action_kind)
    )
      throw new PolicyError(
        `attempt does not reference an eligible campaign action: ${input.action_id}`,
      );
    const priorActionAttempt = await this.projection.attemptForActionTask(
      input.action_id,
      input.task_id,
    );
    if (priorActionAttempt) {
      const record = JSON.parse(priorActionAttempt.body) as AttemptReceipt;
      if (actor.subject === "harbor-hf-control")
        return { receipt: record, adopted: true };
      throw new IdempotencyConflictError(
        `action already has an attempt for task: ${input.action_id}/${input.task_id}`,
      );
    }
    const task = await this.projection.task(input.campaign_id, input.task_id);
    if (!task) throw new PolicyError(`task does not exist: ${input.task_id}`);
    if (task.task.terminal_outcome)
      throw new PolicyError(`terminal task cannot receive attempt: ${input.task_id}`);
    const campaign = await this.projection.campaign(input.campaign_id);
    if (!campaign)
      throw new PolicyError(`campaign does not exist: ${input.campaign_id}`);
    const projectedObserved = campaign.observed_microusd + input.cost_microusd;
    if (
      Math.max(campaign.reserved_microusd, projectedObserved) >
      campaign.ceiling_microusd
    )
      throw new PolicyError("worker attempt cost exceeds the campaign ceiling");
    await this.append(candidate);
    return { receipt: candidate, adopted: false };
  }

  async selectTerminal(
    attempt: AttemptReceipt,
    reason: string,
  ): Promise<TerminalSelection> {
    const record: TerminalSelection = {
      schema_version: "v1",
      kind: "terminal.selection",
      record_id: deterministicId(
        "terminal",
        attempt.campaign_id,
        attempt.task_id,
        attempt.attempt_id,
      ),
      created_at: this.clock.now().toISOString(),
      actor: serviceActor(),
      campaign_id: attempt.campaign_id,
      task_id: attempt.task_id,
      attempt_id: attempt.attempt_id,
      outcome: attempt.outcome,
      reason,
    };
    await this.append(record);
    return record;
  }

  async writePublication(record: PublicationReceipt): Promise<void> {
    await this.append(record);
  }

  async reserveReplacement(
    campaignId: string,
    priorAttemptId: string,
    priorAttemptCompletedAt: string,
    amountMicrousd: number,
  ): Promise<boolean> {
    const operation = this.budgetQueue.then(() =>
      this.reserveReplacementSerialized(
        campaignId,
        priorAttemptId,
        priorAttemptCompletedAt,
        amountMicrousd,
      ),
    );
    this.budgetQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async reserveReplacementSerialized(
    campaignId: string,
    priorAttemptId: string,
    priorAttemptCompletedAt: string,
    amountMicrousd: number,
  ): Promise<boolean> {
    if (amountMicrousd <= 0) return true;
    const recordId = deterministicId(
      "budget",
      campaignId,
      "replacement",
      priorAttemptId,
    );
    const existing = await this.projection.budget(recordId);
    if (existing) {
      if (
        existing.campaign_id !== campaignId ||
        existing.event_kind !== "reserve" ||
        existing.amount_microusd !== amountMicrousd
      )
        throw new IdempotencyConflictError(
          "replacement budget reservation conflicts with durable state",
        );
      return true;
    }
    const campaign = await this.projection.campaign(campaignId);
    if (!campaign) throw new PolicyError("campaign does not exist");
    if (
      Math.max(
        campaign.reserved_microusd + amountMicrousd,
        campaign.observed_microusd,
      ) > campaign.ceiling_microusd
    )
      return false;
    const reservation: BudgetEvent = {
      schema_version: "v1",
      kind: "budget.event",
      record_id: recordId,
      created_at: priorAttemptCompletedAt,
      actor: serviceActor(),
      campaign_id: campaignId,
      event_kind: "reserve",
      amount_microusd: amountMicrousd,
    };
    await this.append(reservation);
    return true;
  }

  async withInfrastructureRetryAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.retryAdmissionQueue.then(operation);
    this.retryAdmissionQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async campaignAction(
    campaignId: string,
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<SubmissionResult> {
    this.assertReady();
    const input = validateCampaignAction<CampaignActionV1>(raw);
    if (!input.confirmed)
      throw new ConfirmationRequiredError(
        "campaign action requires explicit confirmation",
      );
    const operation = () =>
      this.campaignActionValidated(campaignId, input, idempotencyKey, actor);
    return input.action === "retry_infrastructure"
      ? this.withInfrastructureRetryAdmission(operation)
      : operation();
  }

  private async campaignActionValidated(
    campaignId: string,
    input: CampaignActionV1,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<SubmissionResult> {
    const campaign = await this.projection.campaign(campaignId);
    if (!campaign) throw new PolicyError("campaign does not exist");
    const lock = await this.projection.campaignLock(campaignId);
    if (!lock) throw new PolicyError("campaign lock does not exist");
    const generation =
      Number.parseInt(sha256(idempotencyKey).slice(-8), 16) % 1_000_001;
    if (input.action === "retry_infrastructure" && input.task_id) {
      const expectedActionId = deterministicId(
        "action",
        campaignId,
        "job.launch",
        input.task_id,
        String(generation),
      );
      const existing = await this.projection.action(expectedActionId);
      if (existing) {
        const recorded = JSON.parse(existing.intent_body) as ActionIntent;
        if (
          recorded.action_kind !== "job.launch" ||
          recorded.target !== input.task_id ||
          recorded.payload.reason !== (input.reason ?? null)
        )
          throw new IdempotencyConflictError(
            "idempotency key belongs to a different infrastructure retry",
          );
        return {
          campaign_id: campaignId,
          action_id: expectedActionId,
          status_url: `/api/v1/campaigns/${campaignId}`,
          adopted: true,
        };
      }
    }
    let kind: ActionIntent["action_kind"];
    let target = input.task_id ?? "campaign";
    let payload: ActionIntent["payload"];
    let retryReservation: {
      attemptId: string;
      completedAt: string;
      amountMicrousd: number;
    } | null = null;
    if (input.action === "cancel") {
      kind = "campaign.cancel";
      payload = { task_id: input.task_id ?? null, reason: input.reason ?? null };
    } else if (input.action === "publish") {
      if (campaign.terminal_tasks !== campaign.total_tasks)
        throw new PolicyError("campaign cannot publish before every task is terminal");
      if (campaign.pending_actions > 0 || campaign.cleanup_pending)
        throw new PolicyError(
          "campaign cannot publish while actions or endpoint cleanup are pending",
        );
      if (await this.projection.campaignPublication(campaignId))
        throw new PolicyError("campaign is already published");
      kind = "publication.publish";
      target = "results";
      payload = {};
    } else if (input.action === "pause_endpoint") {
      const endpoints = (await this.projection.endpoints()).filter(
        (endpoint) => endpoint.campaign_id === campaignId && !endpoint.cleanup_verified,
      );
      if (endpoints.length !== 1)
        throw new PolicyError(
          `expected one active campaign endpoint, found ${endpoints.length}`,
        );
      const endpoint = endpoints[0];
      if (!endpoint) throw new PolicyError("active endpoint disappeared");
      kind = "endpoint.pause";
      target = endpoint.endpoint_id;
      payload = { endpoint_id: endpoint.endpoint_id };
    } else {
      if (!input.task_id)
        throw new PolicyError("infrastructure retry requires a task ID");
      const task = await this.projection.task(campaignId, input.task_id);
      if (!task) throw new PolicyError("retry task does not exist");
      if (task.task.terminal_outcome)
        throw new PolicyError("terminal tasks cannot be retried");
      const priorAttempt = task.attempts.at(-1);
      if (
        priorAttempt?.outcome !== "infrastructure" ||
        priorAttempt.replacement_eligible !== 1
      )
        throw new PolicyError(
          "infrastructure retry requires an eligible infrastructure failure",
        );
      const existingRetry = await this.projection.retryActionForAttempt(
        campaignId,
        priorAttempt.attempt_id,
      );
      if (existingRetry)
        throw new PolicyError("infrastructure retry is already recorded");
      const deployment = this.resolvedProfile<DeploymentProfileSpec>(
        lock,
        "deployment",
      );
      if (deployment.route !== "hf_job")
        throw new PolicyError("imported deployment profiles cannot launch retries");
      const policy = this.resolvedProfile<LaunchPolicySpec>(lock, "launch_policy");
      if (task.attempts.length >= policy.max_infrastructure_attempts)
        throw new PolicyError("infrastructure retry budget is exhausted");
      retryReservation = {
        attemptId: priorAttempt.attempt_id,
        completedAt: priorAttempt.created_at,
        amountMicrousd: policy.reservation_microusd,
      };
      kind = "job.launch";
      payload = {
        task_ids: [input.task_id],
        job_image: deployment.job_image,
        job_command: deployment.job_command,
        hardware: deployment.hardware,
        timeout_seconds: deployment.timeout_seconds,
        success_without_worker_receipt: policy.success_without_worker_receipt,
        max_infrastructure_attempts: policy.max_infrastructure_attempts,
        reservation_microusd: policy.reservation_microusd,
        trusted_worker: deployment.trusted_worker,
        reason: input.reason ?? null,
        prior_attempt_id: priorAttempt.attempt_id,
      };
    }
    if (
      retryReservation &&
      !(await this.reserveReplacement(
        campaignId,
        retryReservation.attemptId,
        retryReservation.completedAt,
        retryReservation.amountMicrousd,
      ))
    )
      throw new PolicyError("replacement Job would exceed the campaign ceiling");
    const intent = this.actionIntent(
      campaignId,
      kind,
      target,
      generation,
      payload,
      actor,
    );
    const adopted = Boolean(await this.projection.action(intent.action_id));
    await this.writeAction(intent);
    return {
      campaign_id: campaignId,
      action_id: intent.action_id,
      status_url: `/api/v1/campaigns/${campaignId}`,
      adopted,
    };
  }

  resolvedProfile<T>(lock: CampaignLock, kind: ResolvedProfile["kind"]): T {
    return profileSpec<T>(lock.profiles, kind);
  }

  static recordDigest(record: HarborHFControlRecordV1): string {
    return sha256(canonicalJson(record));
  }
}

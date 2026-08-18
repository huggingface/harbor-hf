import type {
  ActionAdvanced,
  ActionDispatch,
  BenchmarkProfileSpec,
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
  HarnessProfileSpec,
  LaunchPolicySpec,
  ModelProfileSpec,
  PreparedJob,
  PreparedJobSubmissionV1,
  PreparedTrial,
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
  validatePreparedJobSubmission,
  workerEvidenceObjectPath,
} from "@harbor-hf/contracts";
import {
  EvidenceIntegrityError,
  verifyEvidenceReference,
  verifyWorkerEvidence,
} from "./evidence.js";
import { EventBus, eventCursor } from "./events.js";
import {
  type LoadedProfile,
  preparationRequired,
  ProfileResolver,
  profileSpec,
  validatePreparedCampaignProfiles,
} from "./profiles.js";
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

export interface PreparedJobSubmissionResult {
  phase: PreparedJobSubmissionV1["phase"];
  record_id: string;
  digest: string;
  adopted: boolean;
}

export class ControlNotReadyError extends Error {}
export class ConfirmationRequiredError extends Error {}
export class IdempotencyConflictError extends Error {}
export class PolicyError extends Error {}

function serviceActor(): Actor {
  return { subject: "harbor-hf-control", role: "service" };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PolicyError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function subsetMatches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => subsetMatches(value, actual[index]))
    );
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      subsetMatches(value, (actual as Record<string, unknown>)[key]),
    );
  }
  return Object.is(expected, actual);
}

export class ControlService {
  readonly resolver: ProfileResolver;
  private appendQueue: Promise<void> = Promise.resolve();
  private budgetQueue: Promise<void> = Promise.resolve();
  private retryAdmissionQueue: Promise<void> = Promise.resolve();
  private submitQueue: Promise<void> = Promise.resolve();
  private preparationQueue: Promise<void> = Promise.resolve();
  private sandboxAdmissionQueue: Promise<void> = Promise.resolve();

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

  private async readRecord<T extends HarborHFControlRecordV1>(
    identity: Parameters<typeof controlRecordPath>[0],
  ): Promise<T | null> {
    const path = controlRecordPath(identity);
    try {
      return validateControlRecord<T>(
        JSON.parse(new TextDecoder().decode(await this.store.read(path))),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async preparedTrial(
    campaignId: string,
    taskId: string,
  ): Promise<PreparedTrial | null> {
    return this.readRecord<PreparedTrial>({
      kind: "prepared.trial",
      record_id: deterministicId("prepared-trial", campaignId, taskId),
      campaign_id: campaignId,
      task_id: taskId,
    });
  }

  async preparedJob(campaignId: string): Promise<PreparedJob | null> {
    return this.readRecord<PreparedJob>({
      kind: "prepared.job",
      record_id: deterministicId("prepared-job", campaignId),
      campaign_id: campaignId,
    });
  }

  async submitPreparedJob(
    campaignId: string,
    launchActionId: string,
    raw: unknown,
  ): Promise<PreparedJobSubmissionResult> {
    const operation = this.preparationQueue.then(() =>
      this.submitPreparedJobSerialized(campaignId, launchActionId, raw),
    );
    this.preparationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async assertPreparationAction(
    campaignId: string,
    launchActionId: string,
  ): Promise<void> {
    const action = await this.projection.action(launchActionId);
    if (
      !action ||
      action.campaign_id !== campaignId ||
      action.action_kind !== "job.launch"
    )
      throw new PolicyError("prepared job submission has no matching launch action");
    const intent = JSON.parse(action.intent_body) as ActionIntent;
    if (intent.payload.worker_role !== "preparation")
      throw new PolicyError("prepared job submission requires a preparation worker");
  }

  private async submitPreparedJobSerialized(
    campaignId: string,
    launchActionId: string,
    raw: unknown,
  ): Promise<PreparedJobSubmissionResult> {
    this.assertReady();
    await this.assertPreparationAction(campaignId, launchActionId);
    const input = validatePreparedJobSubmission<PreparedJobSubmissionV1>(raw);
    const lock = await this.projection.campaignLock(campaignId);
    if (!lock) throw new PolicyError("prepared job campaign lock does not exist");
    const lockDigest = sha256(canonicalJson(lock));
    const preparationId = deterministicId("preparation", campaignId);
    if (input.phase === "trial") {
      const expected = lock.tasks.find((task) => task.task_id === input.task_id);
      if (!expected) throw new PolicyError("prepared trial is outside the campaign");
      if (
        expected.input_digest !== input.input_digest ||
        expected.source_task_id !== input.source_task_id ||
        expected.trial_index !== input.trial_index
      )
        throw new PolicyError("prepared trial does not match the campaign task lock");
      const trialLockDigest = sha256(canonicalJson(input.trial_lock));
      const trialLock = objectValue(input.trial_lock, "prepared Harbor trial lock");
      const harborTask = objectValue(trialLock.task, "prepared Harbor task lock");
      if (harborTask.digest !== input.input_digest)
        throw new PolicyError(
          "prepared Harbor task digest does not match the campaign",
        );
      const model = this.resolvedProfile<ModelProfileSpec>(lock, "model");
      const agent = objectValue(trialLock.agent, "prepared Harbor agent lock");
      if (agent.model_name !== model.harbor_model_name)
        throw new PolicyError("prepared Harbor model does not match the model profile");
      const existing = await this.preparedTrial(campaignId, input.task_id);
      const createdAt = existing?.created_at ?? this.clock.now().toISOString();
      const record: PreparedTrial = {
        schema_version: "v1",
        kind: "prepared.trial",
        record_id: deterministicId("prepared-trial", campaignId, input.task_id),
        created_at: createdAt,
        actor: serviceActor(),
        campaign_id: campaignId,
        preparation_id: preparationId,
        campaign_lock_digest: lockDigest,
        task_id: input.task_id,
        source_task_id: input.source_task_id,
        trial_index: input.trial_index,
        input_digest: input.input_digest,
        trial_lock: input.trial_lock,
        trial_lock_digest: trialLockDigest,
        image: input.image,
        cpus: input.cpus,
        memory_mb: input.memory_mb,
        storage_mb: input.storage_mb,
        gpus: input.gpus,
        agent_timeout_seconds: input.agent_timeout_seconds,
        verifier_timeout_seconds: input.verifier_timeout_seconds,
        environment_build_timeout_seconds: input.environment_build_timeout_seconds,
        agent_setup_timeout_seconds: input.agent_setup_timeout_seconds,
      };
      if (existing && canonicalJson(existing) !== canonicalJson(record))
        throw new IdempotencyConflictError(
          `prepared trial conflicts with durable state: ${input.task_id}`,
        );
      const result = await this.append(record);
      return {
        phase: "trial",
        record_id: record.record_id,
        digest: result.digest,
        adopted: !result.created,
      };
    }

    const existing = await this.preparedJob(campaignId);
    const preparedTrials: PreparedTrial[] = [];
    for (const task of lock.tasks) {
      const trial = await this.preparedTrial(campaignId, task.task_id);
      if (!trial) throw new PolicyError(`prepared trial is missing: ${task.task_id}`);
      if (
        trial.preparation_id !== preparationId ||
        trial.campaign_lock_digest !== lockDigest
      )
        throw new PolicyError(`prepared trial binding is invalid: ${task.task_id}`);
      preparedTrials.push(trial);
    }
    const header = objectValue(input.job_lock_header, "prepared Harbor job header");
    if ("trials" in header)
      throw new PolicyError("prepared Harbor job header must not contain trials");
    const harborLock = {
      ...header,
      trials: preparedTrials.map((trial) => trial.trial_lock),
    };
    const harborLockDigest = sha256(canonicalJson(harborLock));
    const deployment = this.resolvedProfile<DeploymentProfileSpec>(lock, "deployment");
    if (
      deployment.route !== "hf_job" ||
      deployment.harbor_version !== input.harbor_version
    )
      throw new PolicyError("prepared Harbor version does not match the deployment");
    const harborInfo = objectValue(header.harbor, "prepared Harbor version lock");
    if (harborInfo.version !== input.harbor_version)
      throw new PolicyError("prepared Harbor lock reports a different version");
    const benchmark = this.resolvedProfile<BenchmarkProfileSpec>(lock, "benchmark");
    if (!subsetMatches(benchmark.harbor_job, input.job_config))
      throw new PolicyError("prepared Harbor job does not match the benchmark profile");
    const harness = this.resolvedProfile<HarnessProfileSpec>(lock, "harness");
    const jobConfig = objectValue(input.job_config, "prepared Harbor job config");
    const agents = jobConfig.agents;
    if (
      !Array.isArray(agents) ||
      agents.length !== 1 ||
      !subsetMatches(harness.harbor_agent, agents[0])
    )
      throw new PolicyError("prepared Harbor agent does not match the harness profile");
    const retry = objectValue(jobConfig.retry, "prepared Harbor retry policy");
    if (retry.max_retries !== 0)
      throw new PolicyError("prepared Harbor job must disable internal retries");
    const createdAt = existing?.created_at ?? this.clock.now().toISOString();
    const refs = preparedTrials.map((trial) => ({
      task_id: trial.task_id,
      record_id: trial.record_id,
      record_digest: sha256(canonicalJson(trial)),
    }));
    const record: PreparedJob = {
      schema_version: "v1",
      kind: "prepared.job",
      record_id: deterministicId("prepared-job", campaignId),
      created_at: createdAt,
      actor: serviceActor(),
      campaign_id: campaignId,
      preparation_id: preparationId,
      campaign_lock_digest: lockDigest,
      harbor_version: input.harbor_version,
      job_config: input.job_config,
      job_lock_header: input.job_lock_header,
      trials: [refs[0] as (typeof refs)[number], ...refs.slice(1)],
      harbor_lock_digest: harborLockDigest,
    };
    if (existing && canonicalJson(existing) !== canonicalJson(record))
      throw new IdempotencyConflictError(
        "prepared job conflicts with durable campaign state",
      );
    const result = await this.append(record);
    return {
      phase: "finalize",
      record_id: record.record_id,
      digest: result.digest,
      adopted: !result.created,
    };
  }

  async admitSandboxCreate(
    intent: ActionIntent,
    maximumSandboxes: number,
  ): Promise<void> {
    const operation = this.sandboxAdmissionQueue.then(() =>
      this.admitSandboxCreateSerialized(intent, maximumSandboxes),
    );
    this.sandboxAdmissionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async admitSandboxCreateSerialized(
    intent: ActionIntent,
    maximumSandboxes: number,
  ): Promise<void> {
    if (intent.action_kind !== "sandbox.create" || maximumSandboxes < 1)
      throw new PolicyError("Sandbox create admission is invalid");
    const existing = await this.projection.action(intent.action_id);
    if (existing?.observed_state === "budget-rejected")
      throw new PolicyError("Sandbox reservation exceeds the campaign ceiling");
    const taskId = intent.payload.task_id;
    if (typeof taskId !== "string")
      throw new PolicyError("Sandbox create admission has no task ID");
    const creates = (await this.projection.campaignActions(intent.campaign_id)).filter(
      (row) => {
        if (
          row.action_kind !== "sandbox.create" ||
          row.outcome === "failed" ||
          row.action_id === intent.action_id
        )
          return false;
        const recorded = JSON.parse(row.intent_body) as ActionIntent;
        return recorded.payload.task_id === taskId;
      },
    );
    if (!existing && creates.length >= maximumSandboxes)
      throw new PolicyError("Sandbox count exceeds immutable policy");
    await this.writeAction(intent);
    const policy = intent.payload.sandbox;
    if (!policy) throw new PolicyError("Sandbox create has no immutable policy");
    if (
      !(await this.reserveSandbox(
        intent.campaign_id,
        intent.action_id,
        intent.created_at,
        policy.reservation_microusd,
      ))
    ) {
      const receipt = await this.receipt(intent, {
        outcome: "failed",
        observed_state: "budget-rejected",
        error_code: "campaign_ceiling_exceeded",
      });
      await this.markAdvanced(intent, receipt);
      throw new PolicyError("Sandbox reservation exceeds the campaign ceiling");
    }
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
    const launchPolicy = profileSpec<LaunchPolicySpec>(profiles, "launch_policy");
    const tasks = existingLock?.tasks ?? this.resolver.tasks(input.benchmark);
    const executionJobs =
      preparationRequired(deployment) && deployment.worker_max_tasks_per_job
        ? Math.ceil(tasks.length / deployment.worker_max_tasks_per_job)
        : 1;
    const initialReservation =
      launchPolicy.reservation_microusd * executionJobs +
      (preparationRequired(deployment)
        ? (launchPolicy.preparation_reservation_microusd ?? 0) *
          (launchPolicy.max_preparation_attempts ?? 1)
        : 0);
    if (initialReservation > input.ceiling_microusd)
      throw new PolicyError("launch reservation exceeds the campaign ceiling");
    const benchmark = profileSpec<BenchmarkProfileSpec>(profiles, "benchmark");
    const model = profileSpec<ModelProfileSpec>(profiles, "model");
    const harness = profileSpec<HarnessProfileSpec>(profiles, "harness");
    try {
      validatePreparedCampaignProfiles(deployment, benchmark, model, harness, tasks);
    } catch (error) {
      throw new PolicyError(
        error instanceof Error ? error.message : "prepared campaign profile is invalid",
      );
    }
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
        tasks: tasks as CampaignLock["tasks"],
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
    const operationByKind = {
      "job.launch": "create",
      "sandbox.create": "create",
      "sandbox.observe": "observe",
      "sandbox.exec": "execute",
      "sandbox.write": "write",
      "sandbox.read": "read",
      "sandbox.close": "close",
    } as const;
    const operation =
      operationByKind[intent.action_kind as keyof typeof operationByKind];
    if (!operation) throw new PolicyError("action does not support a dispatch fence");
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
      operation,
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
    if (intent.action_kind === "sandbox.create" && !receipt.resource_id) {
      const policy = intent.payload.sandbox;
      if (!policy)
        throw new PolicyError("failed Sandbox create is missing budget identity");
      await this.finalizeSandboxBudget(
        intent.campaign_id,
        intent.action_id,
        receipt.created_at,
        policy.reservation_microusd,
        receipt.cost_microusd ?? 0,
      );
    } else if (intent.action_kind === "sandbox.close") {
      const policy = intent.payload.sandbox;
      const createActionId = intent.payload.sandbox_create_action_id;
      if (!policy || typeof createActionId !== "string")
        throw new PolicyError("Sandbox close action is missing budget identity");
      await this.finalizeSandboxBudget(
        intent.campaign_id,
        createActionId,
        receipt.created_at,
        policy.reservation_microusd,
        receipt.cost_microusd ?? policy.reservation_microusd,
      );
    }
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
    const operation = this.budgetQueue.then(() => this.attemptSerialized(input, actor));
    this.budgetQueue = operation.then(
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
    const committedMicrousd = Math.max(
      campaign.reserved_microusd,
      campaign.observed_microusd,
    );
    if (committedMicrousd + amountMicrousd > campaign.ceiling_microusd) return false;
    const observedOverage = Math.max(
      0,
      campaign.observed_microusd - campaign.reserved_microusd,
    );
    if (observedOverage > 0) {
      const catchUp: BudgetEvent = {
        schema_version: "v1",
        kind: "budget.event",
        record_id: deterministicId(
          "budget",
          campaignId,
          "observed-overage",
          priorAttemptId,
        ),
        created_at: priorAttemptCompletedAt,
        actor: serviceActor(),
        campaign_id: campaignId,
        event_kind: "reserve",
        amount_microusd: observedOverage,
      };
      await this.append(catchUp);
    }
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

  async reserveSandbox(
    campaignId: string,
    createActionId: string,
    createdAt: string,
    amountMicrousd: number,
  ): Promise<boolean> {
    const operation = this.budgetQueue.then(() =>
      this.reserveSandboxSerialized(
        campaignId,
        createActionId,
        createdAt,
        amountMicrousd,
      ),
    );
    this.budgetQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async reserveSandboxSerialized(
    campaignId: string,
    createActionId: string,
    createdAt: string,
    amountMicrousd: number,
  ): Promise<boolean> {
    const recordId = deterministicId("budget", campaignId, "sandbox", createActionId);
    const existing = await this.projection.budget(recordId);
    if (existing) {
      if (
        existing.campaign_id !== campaignId ||
        existing.event_kind !== "reserve" ||
        existing.amount_microusd !== amountMicrousd
      )
        throw new IdempotencyConflictError(
          "Sandbox budget reservation conflicts with durable state",
        );
      return true;
    }
    const campaign = await this.projection.campaign(campaignId);
    if (!campaign) throw new PolicyError("campaign does not exist");
    const committedMicrousd = Math.max(
      campaign.reserved_microusd,
      campaign.observed_microusd,
    );
    if (committedMicrousd + amountMicrousd > campaign.ceiling_microusd) return false;
    const observedOverage = Math.max(
      0,
      campaign.observed_microusd - campaign.reserved_microusd,
    );
    if (observedOverage > 0) {
      const catchUp: BudgetEvent = {
        schema_version: "v1",
        kind: "budget.event",
        record_id: deterministicId(
          "budget",
          campaignId,
          "sandbox-observed-overage",
          createActionId,
        ),
        created_at: createdAt,
        actor: serviceActor(),
        campaign_id: campaignId,
        event_kind: "reserve",
        amount_microusd: observedOverage,
      };
      await this.append(catchUp);
    }
    const reservation: BudgetEvent = {
      schema_version: "v1",
      kind: "budget.event",
      record_id: recordId,
      created_at: createdAt,
      actor: serviceActor(),
      campaign_id: campaignId,
      event_kind: "reserve",
      amount_microusd: amountMicrousd,
    };
    await this.append(reservation);
    return true;
  }

  private async finalizeSandboxBudget(
    campaignId: string,
    createActionId: string,
    completedAt: string,
    reservationMicrousd: number,
    observedMicrousd: number,
  ): Promise<void> {
    const operation = this.budgetQueue.then(async () => {
      const releaseId = deterministicId(
        "budget",
        campaignId,
        "sandbox-release",
        createActionId,
      );
      const existing = await this.projection.budget(releaseId);
      if (existing) {
        if (
          existing.event_kind !== "release" ||
          existing.amount_microusd !== reservationMicrousd
        )
          throw new IdempotencyConflictError(
            "Sandbox budget release conflicts with durable state",
          );
        return;
      }
      const campaign = await this.projection.campaign(campaignId);
      if (!campaign) throw new PolicyError("campaign does not exist");
      const reconcile: BudgetEvent = {
        schema_version: "v1",
        kind: "budget.event",
        record_id: deterministicId(
          "budget",
          campaignId,
          "sandbox-observed",
          createActionId,
        ),
        created_at: completedAt,
        actor: serviceActor(),
        campaign_id: campaignId,
        event_kind: "reconcile",
        amount_microusd: campaign.observed_microusd + observedMicrousd,
      };
      const release: BudgetEvent = {
        schema_version: "v1",
        kind: "budget.event",
        record_id: releaseId,
        created_at: completedAt,
        actor: serviceActor(),
        campaign_id: campaignId,
        event_kind: "release",
        amount_microusd: reservationMicrousd,
      };
      await this.append(reconcile);
      await this.append(release);
    });
    this.budgetQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
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
      const prepared = preparationRequired(deployment)
        ? await this.preparedJob(campaignId)
        : null;
      if (preparationRequired(deployment) && !prepared)
        throw new PolicyError("campaign preparation is incomplete");
      const sandboxAuthorized = Boolean(
        deployment.sandbox || deployment.sandbox_template,
      );
      const sandboxTimeout =
        deployment.sandbox_template?.max_timeout_seconds ??
        deployment.sandbox?.timeout_seconds;
      kind = "job.launch";
      payload = {
        worker_role: "execution",
        task_ids: [input.task_id],
        job_image: deployment.job_image,
        job_command: deployment.job_command,
        hardware: deployment.hardware,
        timeout_seconds: deployment.timeout_seconds,
        success_without_worker_receipt: policy.success_without_worker_receipt,
        max_infrastructure_attempts: policy.max_infrastructure_attempts,
        reservation_microusd: policy.reservation_microusd,
        trusted_worker: deployment.trusted_worker,
        ...(deployment.worker_revision
          ? { worker_revision: deployment.worker_revision }
          : {}),
        inference_token: deployment.inference_token ?? "forbidden",
        ...(deployment.inference_token === "required"
          ? {
              inference_max_requests: deployment.inference_max_requests,
              inference_max_concurrency: deployment.inference_max_concurrency,
              inference_timeout_seconds: deployment.inference_timeout_seconds,
              inference_max_output_tokens: deployment.inference_max_output_tokens,
            }
          : {}),
        campaign_lock_digest: sha256(canonicalJson(lock)),
        ...(prepared ? { prepared_job_digest: sha256(canonicalJson(prepared)) } : {}),
        ...(deployment.sandbox ? { sandbox: deployment.sandbox } : {}),
        ...(sandboxAuthorized ? { sandbox_authorized: true } : {}),
        ...(sandboxTimeout ? { sandbox_timeout_seconds: sandboxTimeout } : {}),
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

import type {
  ActionAdvanced,
  ActionDispatch,
  ActionDisposition,
  ActionIntent,
  ActionReceipt,
  Actor,
  AttemptReceipt,
  BenchmarkProfileSpec,
  BudgetEvent,
  CampaignActionV1,
  CampaignLock,
  CampaignRequest,
  CampaignSubmissionV1,
  CapacityProfileSpec,
  DeploymentProfileSpec,
  HarborHFControlRecordV1,
  HarnessProfileSpec,
  LaunchPolicySpec,
  ModelProfileSpec,
  PreparedJob,
  PreparedJobSubmissionV1,
  PreparedTrial,
  PublicationReceipt,
  PublicationSupersession,
  ResolvedProfile,
  SandboxAdmissionGrant,
  SandboxCapacityRelease,
  TaskExhaustion,
  TerminalSelection,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sandboxActionResultPath,
  sha256,
  validateCampaignAction,
  validateCampaignSubmission,
  validateControlRecord,
  validatePreparedJobSubmission,
  workerEvidenceObjectPath,
} from "@harbor-hf/contracts";
import {
  attemptAdmissibility,
  requiredPositiveMetrics,
} from "./attempt-admissibility.js";
import { historicalDispositionResourceMatches } from "./disposition-policy.js";
import { EventBus, eventCursor } from "./events.js";
import {
  EvidenceIntegrityError,
  verifyEvidenceReference,
  verifyWorkerEvidence,
} from "./evidence.js";
import {
  type LoadedProfile,
  ProfileResolver,
  preparationRequired,
  profileSpec,
  validatePreparedCampaignProfiles,
} from "./profiles.js";
import type { Projection } from "./projection.js";
import { runIdentity, runUnique, runtimeKind } from "./run-id.js";
import {
  decideSandboxAdmission,
  type SandboxAdmissionDecision,
  type SandboxLimitingFactor,
} from "./sandbox-admission.js";
import {
  createJson,
  ImmutableConflictError,
  type ImmutableObjectStore,
} from "./store.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

function isImmutableConflict(error: unknown): error is ImmutableConflictError {
  return (
    error instanceof ImmutableConflictError ||
    (error instanceof Error && error.name === "ImmutableConflictError")
  );
}

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

export interface SandboxAdmissionResult {
  status: "admitted" | "deferred" | "rejected";
  dispatch_created: boolean;
  action_id: string;
  limiting_factor: SandboxLimitingFactor | null;
  not_before: string | null;
}

export interface SandboxCapacityView {
  configured: boolean;
  profile_id: string | null;
  namespace_limit: number | null;
  namespace_active: number;
  campaign_limit: number;
  campaign_active: number;
  hardware_limit: number | null;
  hardware_active: number;
  provider_limit: number;
  provider_reserved: number;
  start_tokens: number | null;
  start_burst: number | null;
  queued: number;
  cleanup_held: number;
  limiting_factor: SandboxLimitingFactor | null;
  not_before: string | null;
}

export interface ActionDispositionCorrectionInput {
  action_ids: string[];
  reason: string;
  confirmed: boolean;
}

export interface ActionDispositionCorrectionResult {
  batch_id: string;
  batch_digest: string;
  items: Array<{
    action_id: string;
    disposition_record_id: string;
    created: boolean;
  }>;
}

export class ControlNotReadyError extends Error {}
export class ConfirmationRequiredError extends Error {}
export class IdempotencyConflictError extends Error {}
export class PolicyError extends Error {}
export class SandboxActionAmbiguousError extends Error {}

const terminalSandboxStates = new Set([
  "CANCELED",
  "CANCELLED",
  "COMPLETED",
  "DELETED",
  "ERROR",
  "STOPPED",
]);

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

function normalizeGitUrl(value: string): string {
  return value.replace(/\.git$/, "");
}

function imageRepository(value: string): string {
  const withoutDigest = value.split("@", 1)[0] as string;
  const tail = withoutDigest.slice(withoutDigest.lastIndexOf("/") + 1);
  let repository = tail.includes(":")
    ? withoutDigest.slice(0, withoutDigest.lastIndexOf(":"))
    : withoutDigest;
  repository = repository.replace(/^(?:docker\.io|registry-1\.docker\.io)\//, "");
  return repository.includes("/") ? repository : `library/${repository}`;
}

function gitDatasetMatches(
  task: Record<string, unknown>,
  dataset: Record<string, unknown>,
): boolean {
  if (typeof dataset.repo !== "string" || typeof task.git_url !== "string")
    return false;
  const match = dataset.repo.match(/^(.*)@([0-9a-f]{40})$/);
  if (!match) return false;
  const [, repository, revision] = match;
  if (
    !repository ||
    !revision ||
    normalizeGitUrl(repository) !== normalizeGitUrl(task.git_url) ||
    task.git_commit_id !== revision ||
    typeof task.path !== "string"
  )
    return false;
  if (typeof dataset.path !== "string") return true;
  return task.path === dataset.path || task.path.startsWith(`${dataset.path}/`);
}

function preparedTaskSourceMatches(
  task: Record<string, unknown>,
  harborJob: unknown,
): boolean {
  if (task.type === "local") return false;
  const job = objectValue(harborJob, "benchmark Harbor job");
  const datasets = Array.isArray(job.datasets) ? job.datasets : [];
  const tasks = Array.isArray(job.tasks) ? job.tasks : [];
  if (
    task.type === "git" &&
    datasets.some(
      (value) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        gitDatasetMatches(task, value as Record<string, unknown>),
    )
  )
    return true;
  if (
    task.type === "package" &&
    datasets.some(
      (value) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).name === task.source &&
        typeof (value as Record<string, unknown>).ref === "string" &&
        /^sha256:[a-f0-9]{64}$/.test((value as Record<string, unknown>).ref as string),
    )
  )
    return true;
  return tasks.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const expected = value as Record<string, unknown>;
    if (task.type === "git")
      return (
        expected.git_url === task.git_url &&
        expected.git_commit_id === task.git_commit_id &&
        expected.path === task.path
      );
    return (
      task.type === "package" &&
      expected.name === task.name &&
      expected.ref === task.digest
    );
  });
}

function validatePreparedEnvironment(
  value: unknown,
  taskId: string,
  maxCommandSeconds: number,
): void {
  const environment = objectValue(value, "prepared Harbor environment lock");
  const kwargs = objectValue(environment.kwargs, "prepared Harbor environment kwargs");
  if (
    environment.import_path !==
      "harbor_hf_agents.support.control_sandbox_environment:ControlSandboxEnvironment" ||
    environment.delete !== true ||
    kwargs.control_task_id !== taskId ||
    kwargs.control_max_command_seconds !== maxCommandSeconds ||
    Object.keys(kwargs).length !== 2 ||
    (Array.isArray(environment.mounts) && environment.mounts.length > 0) ||
    (environment.env &&
      objectValue(environment.env, "prepared Harbor environment variables") &&
      Object.keys(environment.env as Record<string, unknown>).length > 0)
  )
    throw new PolicyError("prepared Harbor environment does not match control policy");
}

export class ControlService {
  readonly resolver: ProfileResolver;
  private appendQueue: Promise<void> = Promise.resolve();
  private budgetQueue: Promise<void> = Promise.resolve();
  private retryAdmissionQueue: Promise<void> = Promise.resolve();
  private submitQueue: Promise<void> = Promise.resolve();
  private preparationQueue: Promise<void> = Promise.resolve();
  private sandboxAdmissionQueue: Promise<void> = Promise.resolve();
  private dispositionQueue: Promise<void> = Promise.resolve();
  private capacityProfileAlias: string | null = null;
  private sandboxActionFinalizationQueues = new Map<string, Promise<void>>();

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

  configureCapacityProfile(alias: string | null): void {
    this.capacityProfileAlias = alias;
  }

  capacityProfile(): { profile_id: string; spec: CapacityProfileSpec } | null {
    if (!this.capacityProfileAlias) return null;
    const selected = this.resolver.promoted("capacity", this.capacityProfileAlias);
    const spec = selected.profile.spec as CapacityProfileSpec;
    if (spec.namespace !== this.namespace)
      throw new PolicyError("capacity profile namespace does not match service");
    const hardware = spec.hardware_limits.map((limit) => limit.hardware);
    if (new Set(hardware).size !== hardware.length)
      throw new PolicyError("capacity profile has duplicate hardware limits");
    return { profile_id: selected.profile_id, spec };
  }

  requireCapacityProfile(): void {
    if (!this.capacityProfile())
      throw new PolicyError("write-enabled service requires a capacity profile");
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
      await this.projection.ingest(key, result.digest, record, this.store);
      const eventData: Record<string, unknown> = {
        key,
        digest: result.digest,
        record_id: record.record_id,
      };
      for (const field of [
        "campaign_id",
        "task_id",
        "attempt_id",
        "action_id",
        "action_kind",
        "publication_id",
        "profile_kind",
        "alias",
      ] as const) {
        if (field in record)
          eventData[field] = (record as unknown as Record<string, unknown>)[field];
      }
      this.events.publish({
        id: eventCursor(record.created_at, key),
        type: record.kind,
        occurred_at: record.created_at,
        data: eventData,
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

  private async appendAdopting<T extends HarborHFControlRecordV1>(
    record: T,
    equivalent: (existing: T) => boolean,
  ): Promise<{ created: boolean; key: string; digest: string; record: T }> {
    try {
      return { ...(await this.append(record)), record };
    } catch (error) {
      if (!isImmutableConflict(error)) throw error;
      const existing = await this.readRecord<T>(record);
      if (!existing || !equivalent(existing))
        throw new IdempotencyConflictError(
          `immutable idempotency conflict at ${controlRecordPath(record)}`,
        );
      await this.syncProjection();
      return {
        created: false,
        key: controlRecordPath(existing),
        digest: sha256(canonicalJson(existing)),
        record: existing,
      };
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
      const benchmark = this.resolvedProfile<BenchmarkProfileSpec>(lock, "benchmark");
      if (
        !preparedTaskSourceMatches(harborTask, benchmark.harbor_job) ||
        (typeof harborTask.name === "string" &&
          harborTask.name.split("/").at(-1) !== input.source_task_id)
      )
        throw new PolicyError(
          "prepared Harbor task source does not match the benchmark profile",
        );
      if (imageRepository(input.declared_image) !== imageRepository(input.image))
        throw new PolicyError("prepared task image repository does not match");
      const model = this.resolvedProfile<ModelProfileSpec>(lock, "model");
      const harness = this.resolvedProfile<HarnessProfileSpec>(lock, "harness");
      const agent = objectValue(trialLock.agent, "prepared Harbor agent lock");
      if (
        agent.model_name !== model.harbor_model_name ||
        !subsetMatches(harness.harbor_agent, agent)
      )
        throw new PolicyError("prepared Harbor agent does not match selected profiles");
      validatePreparedEnvironment(
        trialLock.environment,
        input.task_id,
        Math.max(
          input.agent_timeout_seconds,
          input.verifier_timeout_seconds,
          input.environment_build_timeout_seconds,
          input.agent_setup_timeout_seconds,
        ),
      );
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
        declared_image: input.declared_image,
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
  ): Promise<SandboxAdmissionResult> {
    const operation = this.sandboxAdmissionQueue.then(() =>
      this.admitSandboxCreateSerialized(intent, maximumSandboxes),
    );
    this.sandboxAdmissionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private activeLegacySandboxCreates(
    actions: Awaited<ReturnType<Projection["actions"]>>,
    grantedActionIds: ReadonlySet<string>,
    dispatchedActionIds: ReadonlySet<string>,
  ): Array<(typeof actions)[number]> {
    const closedCreates = new Set(
      actions
        .filter(
          (row) =>
            row.action_kind === "sandbox.close" &&
            row.receipt_body !== null &&
            row.outcome === "completed" &&
            terminalSandboxStates.has((row.observed_state ?? "").toUpperCase()),
        )
        .map((row) => {
          const recorded = JSON.parse(row.intent_body) as ActionIntent;
          return recorded.payload.sandbox_create_action_id;
        })
        .filter((value): value is string => typeof value === "string"),
    );
    return actions.filter(
      (row) =>
        row.action_kind === "sandbox.create" &&
        dispatchedActionIds.has(row.action_id) &&
        !grantedActionIds.has(row.action_id) &&
        !(row.receipt_body && !row.resource_id) &&
        !closedCreates.has(row.action_id),
    );
  }

  private async appendSandboxGrant(
    intent: ActionIntent,
    profileId: string,
    hardware: string,
    reservedProviderRequests: number,
    previousGrantId: string | null,
    decision: Extract<SandboxAdmissionDecision, { outcome: "admitted" }>,
  ): Promise<SandboxAdmissionGrant> {
    const grant: SandboxAdmissionGrant = {
      schema_version: "v1",
      kind: "sandbox.admission",
      record_id: deterministicId("sandbox-admission", intent.action_id),
      created_at: this.clock.now().toISOString(),
      actor: serviceActor(),
      action_id: intent.action_id,
      campaign_id: intent.campaign_id,
      namespace: this.namespace,
      capacity_profile_id: profileId,
      hardware,
      reserved_provider_requests: reservedProviderRequests,
      tokens_remaining: decision.tokens_remaining,
      refill_cursor_at: decision.refill_cursor_at,
      previous_grant_id: previousGrantId,
    };
    return (
      await this.appendAdopting(grant, (recorded) => {
        const { created_at: _recordedAt, ...recordedValue } = recorded;
        const { created_at: _candidateAt, ...candidateValue } = grant;
        return canonicalJson(recordedValue) === canonicalJson(candidateValue);
      })
    ).record;
  }

  private async admitSandboxCreateSerialized(
    intent: ActionIntent,
    maximumSandboxes: number,
  ): Promise<SandboxAdmissionResult> {
    if (intent.action_kind !== "sandbox.create" || maximumSandboxes < 1)
      throw new PolicyError("Sandbox create admission is invalid");
    const taskId = intent.payload.task_id;
    const policy = intent.payload.sandbox;
    if (typeof taskId !== "string" || !policy)
      throw new PolicyError("Sandbox create has no immutable task policy");
    const capacity = this.capacityProfile();
    const existingBeforeWrite = await this.projection.action(intent.action_id);
    if (!capacity && !existingBeforeWrite) {
      const actions = await this.projection.campaignActions(intent.campaign_id);
      const dispatched = await this.projection.dispatchedSandboxCreateActionIds();
      const active = this.activeLegacySandboxCreates(actions, new Set(), dispatched);
      if (active.length >= maximumSandboxes)
        throw new PolicyError("Sandbox count exceeds immutable policy");
    }
    await this.writeAction(intent);
    const existing = await this.projection.action(intent.action_id);
    if (existing?.receipt_body)
      return {
        status: "admitted",
        dispatch_created: Boolean(
          await this.projection.actionDispatch(intent.action_id),
        ),
        action_id: intent.action_id,
        limiting_factor: null,
        not_before: null,
      };
    if (existing?.observed_state === "budget-rejected")
      return {
        status: "rejected",
        dispatch_created: false,
        action_id: intent.action_id,
        limiting_factor: "campaign_budget",
        not_before: null,
      };
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
      return {
        status: "rejected",
        dispatch_created: false,
        action_id: intent.action_id,
        limiting_factor: "campaign_budget",
        not_before: null,
      };
    }
    const existingGrant = await this.projection.sandboxAdmission(intent.action_id);
    if (
      capacity &&
      existingGrant &&
      !(await this.projection.actionDispatch(intent.action_id)) &&
      (await this.projection.hasCampaignAction(intent.campaign_id, "campaign.cancel"))
    ) {
      const receipt = await this.receipt(intent, {
        outcome: "failed",
        observed_state: "admission-rejected",
        error_code: "campaign_cancelled",
      });
      await this.markAdvanced(intent, receipt);
      return {
        status: "rejected",
        dispatch_created: false,
        action_id: intent.action_id,
        limiting_factor: "campaign_cancelled",
        not_before: null,
      };
    }
    if (capacity && !existingGrant) {
      const activeGrants = await this.projection.activeSandboxAdmissions(
        this.namespace,
      );
      const allActions = await this.projection.sandboxLifecycleActions();
      const grantedIds = new Set(activeGrants.map((grant) => grant.action_id));
      const dispatched = await this.projection.dispatchedSandboxCreateActionIds();
      const legacy = this.activeLegacySandboxCreates(
        allActions,
        grantedIds,
        dispatched,
      ).filter((row) => row.action_id !== intent.action_id);
      const campaignLegacy = legacy.filter(
        (row) => row.campaign_id === intent.campaign_id,
      );
      const hardwareLegacy = legacy.filter((row) => {
        const recorded = JSON.parse(row.intent_body) as ActionIntent;
        return recorded.payload.sandbox?.hardware === policy.hardware;
      });
      const providerUnits = policy.inference_max_concurrency ?? 0;
      const providerLimit =
        policy.inference_max_total_concurrency ?? maximumSandboxes * providerUnits;
      const latest = await this.projection.latestSandboxAdmission(this.namespace);
      const decision = decideSandboxAdmission(
        {
          now: this.clock.now().toISOString(),
          campaign_max_sandboxes: maximumSandboxes,
          hardware: policy.hardware,
          reserved_provider_requests: providerUnits,
          campaign_max_provider_requests: providerLimit,
          capacity: capacity.spec,
        },
        {
          campaign_active_sandboxes:
            activeGrants.filter((grant) => grant.campaign_id === intent.campaign_id)
              .length + campaignLegacy.length,
          namespace_active_sandboxes: activeGrants.length + legacy.length,
          hardware_active_sandboxes:
            activeGrants.filter((grant) => grant.hardware === policy.hardware).length +
            hardwareLegacy.length,
          campaign_reserved_provider_requests:
            activeGrants
              .filter((grant) => grant.campaign_id === intent.campaign_id)
              .reduce((total, grant) => total + grant.reserved_provider_requests, 0) +
            campaignLegacy.reduce((total, row) => {
              const recorded = JSON.parse(row.intent_body) as ActionIntent;
              return total + (recorded.payload.sandbox?.inference_max_concurrency ?? 0);
            }, 0),
          tokens_remaining: latest?.tokens_remaining ?? null,
          refill_cursor_at: latest?.refill_cursor_at ?? null,
          cancellation_requested: await this.projection.hasCampaignAction(
            intent.campaign_id,
            "campaign.cancel",
          ),
          budget_available: true,
        },
      );
      if (decision.outcome !== "admitted") {
        if (decision.outcome === "rejected") {
          const receipt = await this.receipt(intent, {
            outcome: "failed",
            observed_state: "admission-rejected",
            error_code: decision.limiting_factor,
          });
          await this.markAdvanced(intent, receipt);
        }
        return {
          status: decision.outcome,
          dispatch_created: false,
          action_id: intent.action_id,
          limiting_factor: decision.limiting_factor,
          not_before: decision.outcome === "deferred" ? decision.not_before : null,
        };
      }
      await this.appendSandboxGrant(
        intent,
        capacity.profile_id,
        policy.hardware,
        providerUnits,
        latest?.record_id ?? null,
        decision,
      );
    }
    if (!capacity) {
      const dispatch = await this.dispatchAction(
        intent,
        new Date(this.clock.now().getTime() + 30_000).toISOString(),
      );
      return {
        status: "admitted",
        dispatch_created: dispatch.created,
        action_id: intent.action_id,
        limiting_factor: null,
        not_before: null,
      };
    }
    return {
      status: "admitted",
      dispatch_created: Boolean(await this.projection.actionDispatch(intent.action_id)),
      action_id: intent.action_id,
      limiting_factor: null,
      not_before: null,
    };
  }

  async sandboxCapacityView(campaignId: string): Promise<SandboxCapacityView> {
    const lock = await this.projection.campaignLock(campaignId);
    if (!lock) throw new PolicyError("campaign lock is missing");
    const deployment = profileSpec<DeploymentProfileSpec>(lock.profiles, "deployment");
    const capacity = this.capacityProfile();
    const activeGrants = await this.projection.activeSandboxAdmissions(this.namespace);
    const allActions = await this.projection.sandboxLifecycleActions();
    const grantedIds = new Set(activeGrants.map((grant) => grant.action_id));
    const dispatched = await this.projection.dispatchedSandboxCreateActionIds();
    const legacy = this.activeLegacySandboxCreates(allActions, grantedIds, dispatched);
    const campaignGrants = activeGrants.filter(
      (grant) => grant.campaign_id === campaignId,
    );
    const campaignLegacy = legacy.filter((row) => row.campaign_id === campaignId);
    const latest = await this.projection.latestSandboxAdmission(this.namespace);
    const queued = await this.projection.campaignPendingSandboxCreateCount(campaignId);
    const pendingCreate =
      await this.projection.campaignPendingSandboxCreate(campaignId);
    const template =
      deployment.route === "hf_job"
        ? (deployment.sandbox_template ?? deployment.sandbox)
        : null;
    if (!template)
      return {
        configured: Boolean(capacity),
        profile_id: capacity?.profile_id ?? null,
        namespace_limit: capacity?.spec.max_active_sandboxes ?? null,
        namespace_active: activeGrants.length + legacy.length,
        campaign_limit: 0,
        campaign_active: campaignGrants.length + campaignLegacy.length,
        hardware_limit: null,
        hardware_active: 0,
        provider_limit: 0,
        provider_reserved: 0,
        start_tokens: capacity
          ? (latest?.tokens_remaining ?? capacity.spec.start_burst)
          : null,
        start_burst: capacity?.spec.start_burst ?? null,
        queued,
        cleanup_held: 0,
        limiting_factor: null,
        not_before: null,
      };
    const providerReserved =
      campaignGrants.reduce(
        (total, grant) => total + grant.reserved_provider_requests,
        0,
      ) +
      campaignLegacy.reduce((total, row) => {
        const intent = JSON.parse(row.intent_body) as ActionIntent;
        return total + (intent.payload.sandbox?.inference_max_concurrency ?? 0);
      }, 0);
    let startTokens: number | null = null;
    let startNotBefore: string | null = null;
    if (capacity) {
      const now = this.clock.now().getTime();
      const periodMs = capacity.spec.start_refill_period_seconds * 1000;
      const previousCursor = latest ? Date.parse(latest.refill_cursor_at) : now;
      const cursor = previousCursor;
      const periods = Math.max(0, Math.floor((now - cursor) / periodMs));
      startTokens = Math.min(
        capacity.spec.start_burst,
        (latest?.tokens_remaining ?? capacity.spec.start_burst) +
          periods * capacity.spec.start_refill_tokens,
      );
      if (startTokens < 1) startNotBefore = new Date(cursor + periodMs).toISOString();
    }
    const campaignActive = campaignGrants.length + campaignLegacy.length;
    const namespaceActive = activeGrants.length + legacy.length;
    const providerLimit =
      template.inference_max_total_concurrency ??
      template.max_sandboxes * (template.inference_max_concurrency ?? 0);
    const hardware =
      campaignGrants[0]?.hardware ??
      (campaignLegacy[0]
        ? (JSON.parse(campaignLegacy[0].intent_body) as ActionIntent).payload.sandbox
            ?.hardware
        : undefined) ??
      pendingCreate?.payload.sandbox?.hardware;
    const hardwareLimit = hardware
      ? (capacity?.spec.hardware_limits.find((limit) => limit.hardware === hardware)
          ?.max_active_sandboxes ?? null)
      : null;
    const hardwareActive = hardware
      ? activeGrants.filter((grant) => grant.hardware === hardware).length +
        legacy.filter((row) => {
          const intent = JSON.parse(row.intent_body) as ActionIntent;
          return intent.payload.sandbox?.hardware === hardware;
        }).length
      : 0;
    let limitingFactor: SandboxLimitingFactor | null = null;
    if (await this.projection.hasCampaignAction(campaignId, "campaign.cancel"))
      limitingFactor = "campaign_cancelled";
    else if (campaignActive >= template.max_sandboxes)
      limitingFactor = "campaign_sandbox_capacity";
    else if (capacity && namespaceActive >= capacity.spec.max_active_sandboxes)
      limitingFactor = "namespace_sandbox_capacity";
    else if (hardwareLimit !== null && hardwareActive >= hardwareLimit)
      limitingFactor = "hardware_sandbox_capacity";
    else if (providerReserved >= providerLimit && providerLimit > 0)
      limitingFactor = "provider_request_capacity";
    else if (capacity && startTokens !== null && startTokens < 1)
      limitingFactor = "sandbox_start_rate";
    const cleanupHeld = [
      ...campaignGrants.map((grant) => grant.action_id),
      ...campaignLegacy.map((row) => row.action_id),
    ].filter((createActionId) => {
      const create = allActions.find((row) => row.action_id === createActionId);
      if (!create?.resource_id) return false;
      return allActions.some((row) => {
        if (row.action_kind !== "sandbox.close") return false;
        const intent = JSON.parse(row.intent_body) as ActionIntent;
        if (intent.payload.sandbox_create_action_id !== createActionId) return false;
        return !(
          row.outcome === "completed" &&
          terminalSandboxStates.has((row.observed_state ?? "").toUpperCase())
        );
      });
    }).length;
    return {
      configured: Boolean(capacity),
      profile_id: capacity?.profile_id ?? null,
      namespace_limit: capacity?.spec.max_active_sandboxes ?? null,
      namespace_active: namespaceActive,
      campaign_limit: template.max_sandboxes,
      campaign_active: campaignActive,
      hardware_limit: hardwareLimit,
      hardware_active: hardwareActive,
      provider_limit: providerLimit,
      provider_reserved: providerReserved,
      start_tokens: startTokens,
      start_burst: capacity?.spec.start_burst ?? null,
      queued,
      cleanup_held: cleanupHeld,
      limiting_factor: limitingFactor,
      not_before: startNotBefore,
    };
  }

  async admitSandboxCommand(
    intent: ActionIntent,
    maximumCommands: number,
  ): Promise<void> {
    const operation = this.sandboxAdmissionQueue.then(() =>
      this.admitSandboxCommandSerialized(intent, maximumCommands),
    );
    this.sandboxAdmissionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async admitSandboxCommandSerialized(
    intent: ActionIntent,
    maximumCommands: number,
  ): Promise<void> {
    const sandboxId = intent.payload.sandbox_create_action_id;
    if (
      intent.action_kind !== "sandbox.exec" ||
      maximumCommands < 1 ||
      typeof sandboxId !== "string"
    )
      throw new PolicyError("Sandbox command admission is invalid");
    const existing = await this.projection.action(intent.action_id);
    const commands = (await this.projection.campaignActions(intent.campaign_id)).filter(
      (row) => {
        if (row.action_kind !== "sandbox.exec" || row.action_id === intent.action_id)
          return false;
        if (row.outcome === "failed") {
          const receipt = row.receipt_body
            ? (JSON.parse(row.receipt_body) as ActionReceipt)
            : null;
          if (receipt?.observed_state !== "AMBIGUOUS") return false;
        }
        const recorded = JSON.parse(row.intent_body) as ActionIntent;
        return recorded.payload.sandbox_create_action_id === sandboxId;
      },
    );
    if (!existing && commands.length >= maximumCommands)
      throw new PolicyError("Sandbox command count exceeds immutable policy");
    await this.writeAction(intent);
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
    const existingId = await this.projection.campaignIdForIdempotency(keyDigest);
    const campaignId = existingId ?? this.newRunId(input, actor, keyDigest);
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
    if (
      launchPolicy.max_campaign_ceiling_microusd !== undefined &&
      input.ceiling_microusd > launchPolicy.max_campaign_ceiling_microusd
    )
      throw new PolicyError("campaign ceiling exceeds the launch policy maximum");
    const tasks = existingLock?.tasks ?? this.resolver.tasks(input.benchmark);
    const executionJobs = deployment.worker_max_tasks_per_job
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
        start_paused: input.start_paused ?? false,
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
        start_paused: input.start_paused ?? false,
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
    if (input.start_paused) {
      const pausedAt = new Date(Date.parse(timestamp) + 1).toISOString();
      await this.writeAction(
        this.actionIntent(
          campaignId,
          "campaign.pause",
          "campaign",
          0,
          { reason: "campaign submitted in paused state" },
          recordActor,
          pausedAt,
        ),
      );
    }
    return {
      campaign_id: campaignId,
      action_id: actionId,
      status_url: `/api/v1/campaigns/${campaignId}`,
      adopted: Boolean(existingRequest || existingLock),
    };
  }

  /**
   * Name a new run `run-<model>-<harness>-<reasoning>-<runtime>-<unique>`.
   *
   * The unique suffix is derived from the namespace, actor, and idempotency
   * key so a repeated request adopts the same identity.
   */
  private newRunId(
    input: CampaignSubmissionV1,
    actor: Actor,
    keyDigest: string,
  ): string {
    const profiles = this.resolver.resolve(input);
    const harness = profileSpec<HarnessProfileSpec>(profiles, "harness");
    const deployment = profileSpec<DeploymentProfileSpec>(profiles, "deployment");
    return runIdentity({
      model: input.model,
      harness: harness.agent,
      reasoning: harness.reasoning_effort ?? "off",
      runtime: runtimeKind(deployment),
      unique: runUnique(this.namespace, actor.subject, keyDigest),
    });
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
      request.ceiling_microusd === input.ceiling_microusd &&
      (request.start_paused ?? false) === (input.start_paused ?? false);
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
      lock.ceiling_microusd === input.ceiling_microusd &&
      (lock.start_paused ?? false) === (input.start_paused ?? false);
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
      if (task?.task.terminal_outcome && intent.action_kind !== "sandbox.close")
        throw new PolicyError(`terminal task cannot receive action: ${taskId}`);
    }
    await this.appendAdopting(intent, (recorded) => {
      return (
        recorded.campaign_id === intent.campaign_id &&
        recorded.action_kind === intent.action_kind &&
        recorded.generation === intent.generation &&
        recorded.target === intent.target &&
        canonicalJson(recorded.actor) === canonicalJson(intent.actor) &&
        canonicalJson(recorded.payload) === canonicalJson(intent.payload)
      );
    });
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
    const result = await this.appendAdopting(record, (recorded) => {
      return (
        recorded.action_id === record.action_id &&
        recorded.campaign_id === record.campaign_id &&
        recorded.operation === record.operation &&
        canonicalJson(recorded.actor) === canonicalJson(record.actor)
      );
    });
    return { record: result.record, created: result.created };
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
    const appended = await this.appendAdopting(receipt, (recorded) => {
      const { created_at: _recordedAt, ...recordedResult } = recorded;
      const { created_at: _candidateAt, ...candidateResult } = receipt;
      return canonicalJson(recordedResult) === canonicalJson(candidateResult);
    });
    return appended.record;
  }

  async ambiguousSandboxReceipt(
    intent: ActionIntent,
    actor: Actor,
  ): Promise<ActionReceipt> {
    if (intent.action_kind !== "sandbox.exec")
      throw new PolicyError("only Sandbox commands can be marked ambiguous");
    const resourceId = intent.payload.resource_id;
    if (typeof resourceId !== "string")
      throw new PolicyError("ambiguous Sandbox command has no resource identity");
    const receipt: ActionReceipt = {
      schema_version: "v1",
      kind: "action.receipt",
      record_id: deterministicId("receipt", intent.action_id),
      created_at: this.clock.now().toISOString(),
      actor,
      action_id: intent.action_id,
      campaign_id: intent.campaign_id,
      outcome: "failed",
      resource_id: resourceId,
      observed_state: "AMBIGUOUS",
      error_code: "sandbox_external_outcome_unknown",
      ready_replicas: null,
      active_hourly_cost_microusd: null,
      cost_microusd: null,
    };
    const appended = await this.appendAdopting(receipt, (recorded) => {
      const {
        created_at: _recordedAt,
        actor: _recordedActor,
        ...recordedResult
      } = recorded;
      const {
        created_at: _candidateAt,
        actor: _candidateActor,
        ...candidateResult
      } = receipt;
      return canonicalJson(recordedResult) === canonicalJson(candidateResult);
    });
    return appended.record;
  }

  private async releaseSandboxCapacity(
    campaignId: string,
    createActionId: string,
    receipt: ActionReceipt,
    reason: SandboxCapacityRelease["release_reason"],
  ): Promise<void> {
    const grant = await this.projection.sandboxAdmission(createActionId);
    if (!grant || (await this.projection.sandboxCapacityRelease(createActionId)))
      return;
    const release: SandboxCapacityRelease = {
      schema_version: "v1",
      kind: "sandbox.capacity-release",
      record_id: deterministicId("sandbox-capacity-release", createActionId),
      created_at: receipt.created_at,
      actor: serviceActor(),
      action_id: createActionId,
      campaign_id: campaignId,
      grant_id: grant.record_id,
      release_reason: reason,
      evidence_record_id: receipt.record_id,
    };
    await this.appendAdopting(release, (recorded) => {
      const { created_at: _recordedAt, ...recordedValue } = recorded;
      const { created_at: _candidateAt, ...candidateValue } = release;
      return canonicalJson(recordedValue) === canonicalJson(candidateValue);
    });
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
      await this.releaseSandboxCapacity(
        intent.campaign_id,
        intent.action_id,
        receipt,
        "create_failed",
      );
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
    } else if (
      intent.action_kind === "sandbox.close" &&
      receipt.outcome === "completed" &&
      ["CANCELED", "CANCELLED", "COMPLETED", "DELETED", "ERROR", "STOPPED"].includes(
        receipt.observed_state.toUpperCase(),
      )
    ) {
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
      await this.releaseSandboxCapacity(
        intent.campaign_id,
        createActionId,
        receipt,
        "sandbox_closed",
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
    const appended = await this.appendAdopting(record, (recorded) => {
      const { created_at: _recordedAt, ...recordedResult } = recorded;
      const { created_at: _candidateAt, ...candidateResult } = record;
      return canonicalJson(recordedResult) === canonicalJson(candidateResult);
    });
    if (
      intent.action_kind === "sandbox.close" &&
      receipt.outcome === "completed" &&
      terminalSandboxStates.has(receipt.observed_state.toUpperCase()) &&
      typeof intent.payload.task_id === "string"
    )
      await this.settleClosedSandboxAmbiguities(
        intent.campaign_id,
        intent.payload.task_id,
        intent.actor,
      );
    return appended.record;
  }

  async withSandboxActionFinalization<T>(
    actionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.sandboxActionFinalizationQueues.get(actionId) ?? Promise.resolve();
    const current = previous.then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.sandboxActionFinalizationQueues.set(actionId, tail);
    try {
      return await current;
    } finally {
      if (this.sandboxActionFinalizationQueues.get(actionId) === tail)
        this.sandboxActionFinalizationQueues.delete(actionId);
    }
  }

  private async hasSandboxResult(
    campaignId: string,
    actionId: string,
  ): Promise<boolean> {
    const path = sandboxActionResultPath(campaignId, actionId);
    const prefix = path.slice(0, -"/result.json".length);
    return (await this.store.list(prefix)).some((entry) => entry.key === path);
  }

  private async withSandboxActionFinalizations<T>(
    actionIds: readonly string[],
    operation: () => Promise<T>,
    index = 0,
  ): Promise<T> {
    const actionId = actionIds[index];
    if (!actionId) return operation();
    return this.withSandboxActionFinalization(actionId, () =>
      this.withSandboxActionFinalizations(actionIds, operation, index + 1),
    );
  }

  async correctHistoricalSandboxAmbiguities(
    campaignId: string,
    taskId: string,
    input: ActionDispositionCorrectionInput,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<ActionDispositionCorrectionResult> {
    this.assertReady();
    if (!input.confirmed)
      throw new ConfirmationRequiredError(
        "action disposition correction requires explicit confirmation",
      );
    if (actor.role !== "operator")
      throw new PolicyError("action disposition correction requires an operator");
    if (
      input.reason.length < 1 ||
      input.reason.length > 1_000 ||
      input.reason.trim() !== input.reason
    )
      throw new PolicyError("action disposition correction reason is invalid");
    if (idempotencyKey.length < 1 || idempotencyKey.length > 512)
      throw new PolicyError("action disposition idempotency key is invalid");
    if (
      input.action_ids.length < 1 ||
      input.action_ids.length > 100 ||
      !input.action_ids.every((actionId) => typeof actionId === "string")
    )
      throw new PolicyError("action disposition batch size is invalid");
    const actionIds = [...input.action_ids].sort();
    if (new Set(actionIds).size !== actionIds.length)
      throw new PolicyError("action disposition action IDs must be unique");
    const operation = this.dispositionQueue.then(() =>
      this.withSandboxActionFinalizations(actionIds, () =>
        this.correctHistoricalSandboxAmbiguitiesSerialized(
          campaignId,
          taskId,
          actionIds,
          input.reason,
          idempotencyKey,
          actor,
        ),
      ),
    );
    this.dispositionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async correctHistoricalSandboxAmbiguitiesSerialized(
    campaignId: string,
    taskId: string,
    actionIds: readonly string[],
    reason: string,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<ActionDispositionCorrectionResult> {
    if (!(await this.projection.campaign(campaignId)))
      throw new PolicyError("action disposition campaign does not exist");
    if (!(await this.projection.task(campaignId, taskId)))
      throw new PolicyError("action disposition task does not exist");
    const reasonCode = "historical_non_replay_safe_command_ambiguity" as const;
    const batchId = deterministicId(
      "disposition-batch",
      campaignId,
      taskId,
      sha256(idempotencyKey),
    );
    const batchDigest = sha256(
      canonicalJson({ action_ids: actionIds, reason_code: reasonCode, reason }),
    );
    const existingBatch = await this.projection.actionDispositionsByBatch(batchId);
    if (
      existingBatch.some(
        (record) =>
          record.campaign_id !== campaignId ||
          record.task_id !== taskId ||
          record.batch_digest !== batchDigest ||
          record.batch_size !== actionIds.length,
      )
    )
      throw new IdempotencyConflictError("action disposition batch identity conflict");
    const campaignActions = await this.projection.campaignActions(campaignId);
    const candidates: ActionDisposition[] = [];
    for (const actionId of actionIds) {
      const action = await this.projection.action(actionId);
      if (
        !action ||
        action.campaign_id !== campaignId ||
        action.action_kind !== "sandbox.exec" ||
        !action.receipt_body
      )
        throw new PolicyError("action disposition target is not eligible");
      const intent = JSON.parse(action.intent_body) as ActionIntent;
      const sourceReceipt = JSON.parse(action.receipt_body) as ActionReceipt;
      if (
        intent.payload.task_id !== taskId ||
        sourceReceipt.outcome !== "completed" ||
        sourceReceipt.observed_state !== "suppressed-sandbox-cleanup-ambiguous" ||
        (sourceReceipt.error_code ?? null) !== null
      )
        throw new PolicyError("action disposition source receipt is not eligible");
      const dispatch = await this.projection.actionDispatch(actionId);
      if (dispatch?.operation !== "execute")
        throw new PolicyError("action disposition target has no execute dispatch");
      if (!(await this.projection.actionAdvanced(actionId)))
        throw new PolicyError("action disposition target is not advanced");
      if (await this.hasSandboxResult(campaignId, actionId))
        throw new PolicyError("action disposition target has a durable result");
      const createActionId = intent.payload.sandbox_create_action_id;
      const resourceId = intent.payload.resource_id;
      if (typeof createActionId !== "string" || typeof resourceId !== "string")
        throw new PolicyError("action disposition ownership is incomplete");
      if (!historicalDispositionResourceMatches(sourceReceipt.resource_id, resourceId))
        throw new PolicyError("action disposition source resource does not match");
      const create = await this.projection.action(createActionId);
      if (
        !create ||
        create.campaign_id !== campaignId ||
        create.action_kind !== "sandbox.create" ||
        create.resource_id !== resourceId
      )
        throw new PolicyError("action disposition create action does not match");
      const createIntent = JSON.parse(create.intent_body) as ActionIntent;
      if (createIntent.payload.task_id !== taskId)
        throw new PolicyError("action disposition create task does not match");
      const eligibleCloses: Array<{
        actionId: string;
        receipt: ActionReceipt;
      }> = [];
      for (const close of campaignActions) {
        if (close.action_kind !== "sandbox.close" || !close.receipt_body) continue;
        const closeIntent = JSON.parse(close.intent_body) as ActionIntent;
        const closeReceipt = JSON.parse(close.receipt_body) as ActionReceipt;
        if (
          closeIntent.payload.task_id !== taskId ||
          closeIntent.payload.sandbox_create_action_id !== createActionId ||
          closeIntent.payload.resource_id !== resourceId ||
          closeReceipt.resource_id !== resourceId ||
          closeReceipt.outcome !== "completed" ||
          !terminalSandboxStates.has(closeReceipt.observed_state.toUpperCase()) ||
          !(await this.projection.actionAdvanced(close.action_id))
        )
          continue;
        eligibleCloses.push({ actionId: close.action_id, receipt: closeReceipt });
      }
      eligibleCloses.sort(
        (left, right) =>
          left.receipt.created_at.localeCompare(right.receipt.created_at) ||
          left.actionId.localeCompare(right.actionId),
      );
      const selectedClose = eligibleCloses[0];
      if (!selectedClose)
        throw new PolicyError("action disposition has no terminal Sandbox close");
      const candidate: ActionDisposition = {
        schema_version: "v1",
        kind: "action.disposition",
        record_id: deterministicId("disposition", actionId),
        created_at: this.clock.now().toISOString(),
        actor: { ...actor, role: "operator" },
        campaign_id: campaignId,
        task_id: taskId,
        action_id: actionId,
        source_receipt_id: sourceReceipt.record_id,
        source_receipt_digest: sha256(canonicalJson(sourceReceipt)),
        close_action_id: selectedClose.actionId,
        close_receipt_id: selectedClose.receipt.record_id,
        close_receipt_digest: sha256(canonicalJson(selectedClose.receipt)),
        batch_id: batchId,
        batch_digest: batchDigest,
        batch_size: actionIds.length,
        effective_outcome: "failed",
        effective_observed_state: "AMBIGUOUS",
        effective_error_code: "sandbox_external_outcome_unknown",
        reason_code: reasonCode,
        reason,
      };
      const existing = await this.projection.actionDisposition(actionId);
      if (existing) {
        const {
          created_at: _existingAt,
          actor: _existingActor,
          ...existingSemantics
        } = existing;
        const {
          created_at: _candidateAt,
          actor: _candidateActor,
          ...candidateSemantics
        } = candidate;
        if (canonicalJson(existingSemantics) !== canonicalJson(candidateSemantics))
          throw new IdempotencyConflictError("action disposition identity conflict");
      }
      candidates.push(candidate);
    }
    const items: ActionDispositionCorrectionResult["items"] = [];
    for (const candidate of candidates) {
      const appended = await this.appendAdopting(candidate, (recorded) => {
        const {
          created_at: _recordedAt,
          actor: _recordedActor,
          ...recordedSemantics
        } = recorded;
        const {
          created_at: _candidateAt,
          actor: _candidateActor,
          ...candidateSemantics
        } = candidate;
        return canonicalJson(recordedSemantics) === canonicalJson(candidateSemantics);
      });
      items.push({
        action_id: candidate.action_id,
        disposition_record_id: appended.record.record_id,
        created: appended.created,
      });
    }
    return { batch_id: batchId, batch_digest: batchDigest, items };
  }

  async settleClosedSandboxAmbiguities(
    campaignId: string,
    taskId: string,
    actor: Actor = serviceActor(),
  ): Promise<{ settled: number; unresolved: number }> {
    const candidates = await this.projection.pendingDispatchedSandboxExecActions(
      campaignId,
      taskId,
    );
    if (candidates.length >= 1_025)
      throw new PolicyError("too many ambiguous Sandbox commands for one task");
    const campaignActions = await this.projection.campaignActions(campaignId);
    let settled = 0;
    let unresolved = 0;
    for (const intent of candidates) {
      const disposition = await this.withSandboxActionFinalization(
        intent.action_id,
        async (): Promise<"settled" | "resolved" | "unresolved"> => {
          const current = await this.projection.action(intent.action_id);
          if (!current || current.receipt_body) return "resolved";
          if (await this.hasSandboxResult(campaignId, intent.action_id))
            return "unresolved";
          const createActionId = intent.payload.sandbox_create_action_id;
          const resourceId = intent.payload.resource_id;
          if (typeof createActionId !== "string" || typeof resourceId !== "string")
            throw new PolicyError("ambiguous Sandbox command has invalid ownership");
          const create = await this.projection.action(createActionId);
          if (
            !create ||
            create.campaign_id !== campaignId ||
            create.action_kind !== "sandbox.create" ||
            create.resource_id !== resourceId
          )
            throw new PolicyError(
              "ambiguous Sandbox command has invalid create action",
            );
          const createIntent = JSON.parse(create.intent_body) as ActionIntent;
          if (createIntent.payload.task_id !== taskId)
            throw new PolicyError("ambiguous Sandbox command belongs to another task");
          const close = campaignActions.find((action) => {
            if (action.action_kind !== "sandbox.close" || !action.receipt_body)
              return false;
            const closeIntent = JSON.parse(action.intent_body) as ActionIntent;
            const closeReceipt = JSON.parse(action.receipt_body) as ActionReceipt;
            return (
              closeIntent.payload.task_id === taskId &&
              closeIntent.payload.sandbox_create_action_id === createActionId &&
              closeIntent.payload.resource_id === resourceId &&
              closeReceipt.resource_id === resourceId &&
              closeReceipt.outcome === "completed" &&
              terminalSandboxStates.has(closeReceipt.observed_state.toUpperCase())
            );
          });
          if (!close || !(await this.projection.actionAdvanced(close.action_id)))
            return "unresolved";
          const receipt = await this.ambiguousSandboxReceipt(intent, actor);
          await this.markAdvanced(intent, receipt);
          return "settled";
        },
      );
      if (disposition === "settled") settled += 1;
      else if (disposition === "unresolved") unresolved += 1;
    }
    return { settled, unresolved };
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
    const lock = await this.projection.campaignLock(attempt.campaign_id);
    if (!lock) throw new PolicyError("terminal selection has no campaign lock");
    const validity = attemptAdmissibility(attempt, requiredPositiveMetrics(lock));
    if (!validity.admissible && attempt.outcome !== "cancelled")
      throw new PolicyError(`attempt is not selectable: ${validity.reason}`);
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

  async exhaustTask(
    attempt: AttemptReceipt,
    reason: string,
    attemptCount: number,
  ): Promise<TaskExhaustion> {
    const record: TaskExhaustion = {
      schema_version: "v1",
      kind: "task.exhaustion",
      record_id: deterministicId(
        "task-exhaustion",
        attempt.campaign_id,
        attempt.task_id,
        attempt.attempt_id,
      ),
      created_at: this.clock.now().toISOString(),
      actor: serviceActor(),
      campaign_id: attempt.campaign_id,
      task_id: attempt.task_id,
      last_attempt_id: attempt.attempt_id,
      attempt_count: attemptCount,
      reason,
    };
    await this.append(record);
    return record;
  }

  async writePublication(record: PublicationReceipt): Promise<void> {
    await this.append(record);
  }

  async writePublicationSupersession(
    campaignId: string,
    publicationId: string,
    supersededCampaignId: string,
    supersededPublicationId: string,
    reason: string,
  ): Promise<PublicationSupersession> {
    const record: PublicationSupersession = {
      schema_version: "v1",
      kind: "publication.supersession",
      record_id: deterministicId(
        "publication-supersession",
        supersededPublicationId,
        publicationId,
      ),
      created_at: this.clock.now().toISOString(),
      actor: serviceActor(),
      campaign_id: campaignId,
      publication_id: publicationId,
      superseded_campaign_id: supersededCampaignId,
      superseded_publication_id: supersededPublicationId,
      reason,
    };
    await this.append(record);
    return record;
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
      const taskIds = input.task_id
        ? [input.task_id]
        : lock.tasks.map((task) => task.task_id);
      for (const taskId of taskIds)
        await this.settleClosedSandboxAmbiguities(campaignId, taskId, actor);
      kind = "campaign.cancel";
      payload = { task_id: input.task_id ?? null, reason: input.reason ?? null };
    } else if (input.action === "pause") {
      if (campaign.status === "completed" || campaign.status === "failed")
        throw new PolicyError("terminal campaign cannot be paused");
      kind = "campaign.pause";
      payload = { reason: input.reason ?? null };
    } else if (input.action === "resume") {
      if (!campaign.paused) throw new PolicyError("campaign is not paused");
      if (campaign.pending_actions > 0)
        throw new PolicyError("campaign cannot resume while actions are pending");
      if (
        preparationRequired(
          profileSpec<DeploymentProfileSpec>(lock.profiles, "deployment"),
        )
      ) {
        const prepared = await this.preparedJob(campaignId);
        if (!prepared) throw new PolicyError("campaign preparation is incomplete");
      }
      kind = "campaign.resume";
      payload = {
        reason: input.reason ?? null,
        ...(input.task_limit ? { task_limit: input.task_limit } : {}),
      };
    } else if (input.action === "publish") {
      if (
        campaign.terminal_tasks !== campaign.total_tasks ||
        campaign.admissible_tasks !== campaign.total_tasks ||
        campaign.exhausted_tasks > 0
      )
        throw new PolicyError(
          "campaign cannot publish before every task has an admissible selection",
        );
      if (campaign.pending_actions > 0 || campaign.cleanup_pending)
        throw new PolicyError(
          "campaign cannot publish while actions or endpoint cleanup are pending",
        );
      if (await this.projection.campaignPublication(campaignId))
        throw new PolicyError("campaign is already published");
      kind = "publication.publish";
      target = "results";
      payload = {};
    } else if (input.action === "supersede") {
      if (!input.publication_id)
        throw new PolicyError("supersession requires the old publication ID");
      const current = await this.projection.campaignPublication(campaignId);
      if (current?.status !== "published")
        throw new PolicyError("replacement campaign is not published");
      const previous = await this.projection.publication(input.publication_id);
      if (previous?.status !== "published")
        throw new PolicyError("superseded publication does not exist");
      if (previous.campaign_id === campaignId)
        throw new PolicyError("publication cannot supersede itself");
      kind = "publication.supersede";
      target = input.publication_id;
      payload = {
        publication_id: input.publication_id,
        reason: input.reason ?? null,
      };
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
      const settlement = await this.settleClosedSandboxAmbiguities(
        campaignId,
        input.task_id,
        actor,
      );
      const unresolved = await this.projection.pendingDispatchedSandboxExecActions(
        campaignId,
        input.task_id,
      );
      if (settlement.unresolved > 0 || unresolved.length > 0)
        throw new PolicyError(
          "infrastructure retry requires terminal Sandbox command recovery",
        );
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
        required_positive_metrics: policy.required_positive_metrics ?? [],
        reservation_microusd: policy.reservation_microusd,
        trusted_worker: deployment.trusted_worker,
        ...(deployment.route === "hf_job" &&
        typeof deployment.active_hourly_cost_microusd === "number"
          ? { active_hourly_cost_microusd: deployment.active_hourly_cost_microusd }
          : {}),
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

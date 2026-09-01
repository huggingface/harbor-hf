import type {
  ActionAdvanced,
  ActionDispatch,
  ActionIntent,
  ActionReceipt,
  Actor,
  AttemptReceipt,
  BenchmarkProfileSpec,
  BudgetEvent,
  CapacityProfileObject,
  CapacityProfileSpec,
  CurrentRunLock,
  DeploymentProfileSpec,
  HarborHFControlRecordV1,
  HarborHFRunContinuationV1,
  HarnessProfileSpec,
  JobAdmissionGrant,
  JobCapacityRelease,
  LaunchPolicySpec,
  PreparedJob,
  PreparedJobSubmissionV1,
  PreparedTrial,
  ProfilePromotion,
  PublicationReceipt,
  PublicationSupersession,
  ResolvedExecutionContract,
  ResolvedProfile,
  RunActionV1,
  RunContinuation,
  RunContinuationRepair,
  RunContinuationRepairSuccessor,
  RunLock,
  RunRequest,
  RunSubmissionV1,
  TaskCancellation,
  TaskExhaustion,
  TerminalSelection,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sha256,
  validateControlRecord,
  validatePreparedJobSubmission,
  validateRunAction,
  validateRunContinuation,
  validateRunSubmission,
  workerEvidenceObjectPath,
} from "@harbor-hf/contracts";
import {
  attemptAdmissibility,
  requiredPositiveMetrics,
} from "./attempt-admissibility.js";
import { EventBus } from "./events.js";
import {
  EvidenceIntegrityError,
  verifyEvidenceReference,
  verifyWorkerEvidence,
} from "./evidence.js";
import {
  assertRunContinuationCompatible,
  assertRunContinuationRepairCandidate,
  assertRunContinuationRepairSuccessorCandidate,
  composeExecutionContract,
  isCurrentRunLock,
  resolvedRunExecution,
} from "./execution-contract.js";
import {
  decideJobAdmission,
  type JobAdmissionDecision,
  type JobLimitingFactor,
} from "./job-admission.js";
import {
  type LoadedProfile,
  type PreparedTrialJobLaunch,
  ProfileResolutionError,
  ProfileResolver,
  preparationRequired,
  preparedTrialJobLaunch,
  profileSpec,
  validatePreparedRunProfiles,
} from "./profiles.js";
import type { Projection } from "./projection.js";
import { runIdentity, runtimeKind, runUnique } from "./run-id.js";
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
  run_id: string;
  task_id: string;
  attempt_id: string;
  action_id: string;
  outcome: AttemptReceipt["outcome"];
  replacement_eligible: boolean;
  failure_fingerprint?: string;
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
  run_id: string;
  action_id: string;
  status_url: string;
  adopted: boolean;
}

export interface RunContinuationResult {
  run_id: string;
  continuation_id: string;
  status_url: string;
  adopted: boolean;
}

export interface RunContinuationRepairResult {
  run_id: string;
  continuation_repair_id: string;
  status_url: string;
  adopted: boolean;
}

export interface RunContinuationRepairSuccessorResult {
  run_id: string;
  continuation_repair_successor_id: string;
  status_url: string;
  adopted: boolean;
}

export interface PreparedJobSubmissionResult {
  phase: PreparedJobSubmissionV1["phase"];
  record_id: string;
  digest: string;
  adopted: boolean;
}

export interface JobAdmissionResult {
  status: "admitted" | "deferred" | "rejected";
  dispatch_created: boolean;
  action_id: string;
  limiting_factor: JobLimitingFactor | "run_cancelled" | null;
  not_before: string | null;
}

export interface JobCapacityView {
  configured: boolean;
  profile_id: string | null;
  namespace_limit: number | null;
  namespace_active: number;
  run_limit: number;
  run_active: number;
  hardware_limit: number | null;
  hardware_active: number;
  provider_limit: number;
  provider_reserved: number;
  start_tokens: number | null;
  start_burst: number | null;
  queued: number;
  limiting_factor: JobLimitingFactor | "run_cancelled" | null;
  not_before: string | null;
}

export interface NamespaceCapacityView {
  alias: string | null;
  configured: boolean;
  profile_id: string | null;
  max_active_jobs: number | null;
  active_jobs: number;
  available_jobs: number | null;
  queued_jobs: number;
  observed_running_jobs: number;
  observed_scheduling_jobs: number;
  reserved_without_active_observation: number;
  start_tokens: number | null;
  start_burst: number | null;
  start_refill_tokens: number | null;
  start_refill_period_seconds: number | null;
  runs: Array<{
    run_id: string;
    max_active_jobs: number;
    active_jobs: number;
    available_jobs: number;
  }>;
  hardware: Array<{
    hardware: string;
    max_active_jobs: number;
    active_jobs: number;
    available_jobs: number;
  }>;
}

interface RunActionIdempotency {
  key_digest: string;
  payload_digest: string;
}

export class ControlNotReadyError extends Error {}
export class ConfirmationRequiredError extends Error {}
export class IdempotencyConflictError extends Error {}
export class PolicyError extends Error {}

function refilledStartTokens(
  capacity: CapacityProfileSpec,
  latest: JobAdmissionGrant | null,
  now: Date,
): { tokens: number; not_before: string | null } {
  const cursor = latest ? Date.parse(latest.refill_cursor_at) : now.getTime();
  const periodMs = capacity.start_refill_period_seconds * 1000;
  const periods = Math.max(0, Math.floor((now.getTime() - cursor) / periodMs));
  const tokens = Math.min(
    capacity.start_burst,
    (latest?.tokens_remaining ?? capacity.start_burst) +
      periods * capacity.start_refill_tokens,
  );
  return {
    tokens,
    not_before: tokens < 1 ? new Date(cursor + periodMs).toISOString() : null,
  };
}

function serviceActor(): Actor {
  return { subject: "harbor-hf-control", role: "service" };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PolicyError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringArrayValue(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new PolicyError(`${label} must be a string array`);
  return value as string[];
}

function withoutRunActionIdempotency(
  payload: ActionIntent["payload"],
): ActionIntent["payload"] {
  const {
    idempotency_key_digest: _keyDigest,
    idempotency_payload_digest: _payloadDigest,
    ...rest
  } = payload;
  return rest;
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

export interface JobBudgetReservation {
  category: string;
  generation: number;
  created_at: string;
  amount_microusd: number;
}

export function executionReservationCategory(taskIds: readonly string[]): string {
  const batchKey = sha256(canonicalJson(taskIds)).slice(7, 23);
  return `execution-${batchKey}`;
}

function validateJobLaunchAssignment(intent: ActionIntent): void {
  if (intent.action_kind !== "job.launch") return;
  const role = intent.payload.worker_role ?? "execution";
  const taskIds = stringArrayValue(intent.payload.task_ids, "Job action task IDs");
  if (taskIds.length === 0) throw new PolicyError("Job launch has no assigned tasks");
  if (role === "preparation") return;
  if (role !== "execution" || taskIds.length !== 1)
    throw new PolicyError("execution Job launch requires exactly one task");
  const taskId = taskIds[0] as string;
  if (intent.payload.task_id !== taskId)
    throw new PolicyError("execution Job task assignment is inconsistent");
}

const terminalRunStatuses = new Set([
  "cancelled",
  "completed",
  "completed-invalid",
  "failed",
]);

function runStatusIsTerminal(status: string): boolean {
  return terminalRunStatuses.has(status);
}

function lockedProfileName(lock: RunLock, kind: ResolvedProfile["kind"]): string {
  const profile = lock.profiles.find((candidate) => candidate.kind === kind);
  if (!profile) throw new PolicyError(`run lock is missing ${kind} profile`);
  return profile.name;
}

const terminalJobStates = new Set([
  "STOPPED",
  "COMPLETED",
  "CANCELLED",
  "CANCELED",
  "ERROR",
]);

export function jobStateIsTerminal(state: string | null): boolean {
  if (state === null) return false;
  const normalized = state.toUpperCase();
  return terminalJobStates.has(normalized) || normalized.startsWith("SUPPRESSED-");
}

export function infrastructureSealReplaceable(terminalOutcome: string | null): boolean {
  return terminalOutcome === null || terminalOutcome === "infrastructure";
}

export function historicalTaskNeedsSelection(task: {
  selected_attempt_id: string | null;
  terminal_outcome: string | null;
}): boolean {
  return (
    task.selected_attempt_id === null &&
    [null, "infrastructure", "invalid"].includes(task.terminal_outcome)
  );
}

export class ControlService {
  readonly resolver: ProfileResolver;
  private projectionQueue: Promise<void> = Promise.resolve();
  private budgetQueue: Promise<void> = Promise.resolve();
  private retryAdmissionQueue: Promise<void> = Promise.resolve();
  private readonly runMutationQueues = new Map<string, Promise<void>>();
  private submitQueue: Promise<void> = Promise.resolve();
  private jobAdmissionQueue: Promise<void> = Promise.resolve();
  private capacityUpdateQueue: Promise<void> = Promise.resolve();
  private capacityProfileAlias: string | null = null;

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

  capacityProfileOrNull(): { profile_id: string; spec: CapacityProfileSpec } | null {
    if (!this.capacityProfileAlias) return null;
    try {
      return this.capacityProfile();
    } catch (error) {
      if (error instanceof PolicyError || error instanceof ProfileResolutionError)
        return null;
      throw error;
    }
  }

  namespaceCapacityPolicy(): {
    alias: string | null;
    configured: boolean;
    max_active_jobs: number | null;
    start_burst: number | null;
    start_refill_tokens: number | null;
    start_refill_period_seconds: number | null;
    profile_id: string | null;
  } {
    const selected = this.capacityProfileOrNull();
    return {
      alias: this.capacityProfileAlias,
      configured: selected !== null,
      max_active_jobs: selected ? selected.spec.max_active_jobs : null,
      start_burst: selected ? selected.spec.start_burst : null,
      start_refill_tokens: selected ? selected.spec.start_refill_tokens : null,
      start_refill_period_seconds: selected
        ? selected.spec.start_refill_period_seconds
        : null,
      profile_id: selected ? selected.profile_id : null,
    };
  }

  async namespaceCapacityView(): Promise<NamespaceCapacityView> {
    const policy = this.namespaceCapacityPolicy();
    const capacity = this.capacityProfileOrNull();
    const [active, runUsage, latest, queuedJobs, observedStates] = await Promise.all([
      this.projection.activeJobAdmissions(this.namespace),
      this.projection.activeJobAdmissionRunUsage(this.namespace),
      this.projection.latestJobAdmission(this.namespace),
      this.projection.pendingActionCount("job.launch"),
      this.projection.activeJobObservedStateCounts(this.namespace),
    ]);
    let startTokens: number | null = null;
    if (capacity)
      startTokens = refilledStartTokens(capacity.spec, latest, this.clock.now()).tokens;
    const running = observedStates.RUNNING ?? 0;
    const scheduling = observedStates.SCHEDULING ?? 0;
    return {
      ...policy,
      active_jobs: active.length,
      available_jobs:
        policy.max_active_jobs === null
          ? null
          : Math.max(0, policy.max_active_jobs - active.length),
      queued_jobs: queuedJobs,
      observed_running_jobs: running,
      observed_scheduling_jobs: scheduling,
      reserved_without_active_observation: Math.max(
        0,
        active.length - running - scheduling,
      ),
      start_tokens: startTokens,
      runs: runUsage.map((run) => ({
        ...run,
        available_jobs: Math.max(0, run.max_active_jobs - run.active_jobs),
      })),
      hardware:
        capacity?.spec.hardware_limits.map((limit) => {
          const activeJobs = active.filter(
            (grant) => grant.hardware === limit.hardware,
          ).length;
          return {
            hardware: limit.hardware,
            max_active_jobs: limit.max_active_jobs,
            active_jobs: activeJobs,
            available_jobs: Math.max(0, limit.max_active_jobs - activeJobs),
          };
        }) ?? [],
    };
  }

  /**
   * Replace the promoted namespace Job cap. The start burst and refill
   * match the cap so the new limit can actually admit work.
   */
  async setMaxActiveJobs(
    maxActiveJobs: number,
    idempotencyKey: string,
  ): Promise<{
    alias: string;
    max_active_jobs: number;
    start_burst: number;
    profile_id: string;
  }> {
    const operation = this.capacityUpdateQueue.then(() =>
      this.setMaxActiveJobsSerialized(maxActiveJobs, idempotencyKey),
    );
    this.capacityUpdateQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async setMaxActiveJobsSerialized(
    maxActiveJobs: number,
    idempotencyKey: string,
  ): Promise<{
    alias: string;
    max_active_jobs: number;
    start_burst: number;
    profile_id: string;
  }> {
    if (!Number.isInteger(maxActiveJobs) || maxActiveJobs < 1 || maxActiveJobs > 1024)
      throw new PolicyError("namespace Job cap must be an integer from 1 to 1024");
    if (!idempotencyKey || idempotencyKey.length > 256)
      throw new IdempotencyConflictError(
        "a bounded capacity idempotency key is required",
      );
    const alias = this.capacityProfileAlias ?? "current";
    this.configureCapacityProfile(alias);
    const keyDigest = sha256(idempotencyKey);
    const requestDigest = sha256(canonicalJson({ max_active_jobs: maxActiveJobs }));
    const promotionRecordId = deterministicId(
      "promotion",
      "capacity",
      alias,
      keyDigest,
    );
    const existingPromotion = await this.readRecord<ProfilePromotion>({
      kind: "profile.promotion",
      record_id: promotionRecordId,
      profile_kind: "capacity",
      alias,
    });
    if (existingPromotion) {
      if (
        existingPromotion.evidence[0] !== keyDigest ||
        existingPromotion.evidence[1] !== requestDigest
      )
        throw new IdempotencyConflictError(
          "idempotency key already belongs to a different capacity policy request",
        );
      return {
        alias,
        max_active_jobs: maxActiveJobs,
        start_burst: maxActiveJobs,
        profile_id: existingPromotion.profile_id,
      };
    }
    const current = this.capacityProfileOrNull();
    const hardwareLimits = (
      current
        ? current.spec.hardware_limits
        : [
            { hardware: "cpu-basic", max_active_jobs: maxActiveJobs },
            { hardware: "cpu-upgrade", max_active_jobs: maxActiveJobs },
          ]
    ).map((limit) => ({
      hardware: limit.hardware,
      max_active_jobs: maxActiveJobs,
    }));
    const spec: CapacityProfileSpec = {
      namespace: this.namespace,
      max_active_jobs: maxActiveJobs,
      hardware_limits: hardwareLimits,
      start_burst: maxActiveJobs,
      start_refill_tokens: maxActiveJobs,
      start_refill_period_seconds: current
        ? current.spec.start_refill_period_seconds
        : 60,
    };
    const createdAt = this.clock.now().toISOString();
    let profileId: string;
    if (!current || canonicalJson(current.spec) !== canonicalJson(spec)) {
      const profile: CapacityProfileObject = {
        schema_version: "v1",
        kind: "profile.object",
        record_id: deterministicId(
          "profile",
          "capacity",
          alias,
          sha256(canonicalJson(spec)),
        ),
        created_at: createdAt,
        actor: serviceActor(),
        profile_kind: "capacity",
        name: alias,
        spec,
      };
      const recordedProfile = (
        await this.appendAdopting(profile, (recorded) => {
          const { created_at: _recordedAt, ...recordedValue } = recorded;
          const { created_at: _candidateAt, ...candidateValue } = profile;
          return canonicalJson(recordedValue) === canonicalJson(candidateValue);
        })
      ).record;
      profileId = sha256(canonicalJson(recordedProfile));
    } else profileId = current.profile_id;
    const promotion: ProfilePromotion = {
      schema_version: "v1",
      kind: "profile.promotion",
      record_id: promotionRecordId,
      created_at: createdAt,
      actor: serviceActor(),
      profile_kind: "capacity",
      alias,
      profile_id: profileId,
      reason: `set namespace Job cap to ${maxActiveJobs}`,
      evidence: [keyDigest, requestDigest],
      promotion_state: "approved",
    };
    await this.appendAdopting(promotion, (recorded) => {
      const { created_at: _recordedAt, ...recordedValue } = recorded;
      const { created_at: _candidateAt, ...candidateValue } = promotion;
      return canonicalJson(recordedValue) === canonicalJson(candidateValue);
    });
    return {
      alias,
      max_active_jobs: spec.max_active_jobs,
      start_burst: spec.start_burst,
      profile_id: profileId,
    };
  }

  private assertReady(): void {
    if (!this.projection.system().ready)
      throw new ControlNotReadyError("control projection is not ready");
  }

  async append<T extends HarborHFControlRecordV1>(
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
    // Remote immutable writes may overlap. SQLite projection updates remain
    // serialized so independent Runs do not wait on each other's network I/O.
    const operation = this.projectionQueue.then(async () => {
      const projected = await this.projection.objectDigest(key);
      if (projected && projected !== result.digest)
        throw new IdempotencyConflictError(`projection digest conflict at ${key}`);
      if (!projected) {
        const event = await this.projection.ingest(
          key,
          result.digest,
          result.source_identity,
          record,
        );
        this.events.publish(event);
        if (record.kind === "profile.object" || record.kind === "profile.promotion")
          await this.refreshProfileResolver();
      }
      return { ...result, key };
    });
    this.projectionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async syncProjection(prefix?: string): Promise<number> {
    const operation = this.projectionQueue.then(async () => {
      const events = await this.projection.sync(this.store, prefix);
      for (const event of events) this.events.publish(event);
      if (events.length > 0) await this.refreshProfileResolver();
      return events.length;
    });
    this.projectionQueue = operation.then(
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

  async runExecution(lock: RunLock): Promise<ResolvedExecutionContract> {
    const continuation = await this.projection.runContinuation(lock.run_id);
    return resolvedRunExecution(
      lock,
      continuation,
      await this.projection.runContinuationRepair(lock.run_id),
      await this.projection.runContinuationRepairSuccessor(lock.run_id),
    );
  }

  private async assertHistoricalLaunchBinding(
    lock: RunLock,
    launch: ActionIntent,
  ): Promise<void> {
    if (isCurrentRunLock(lock)) return;
    const continuation = await this.projection.runContinuation(lock.run_id);
    if (!continuation || launch.payload.run_continuation_id !== continuation.record_id)
      throw new PolicyError(
        "historical Job launch is not bound to the execution continuation",
      );
    const repair = await this.projection.runContinuationRepair(lock.run_id);
    if (
      repair &&
      launch.payload.run_continuation_repair_id !== repair.record_id &&
      !(
        launch.payload.run_continuation_repair_id === undefined &&
        Date.parse(launch.created_at) <= Date.parse(repair.created_at)
      )
    )
      throw new PolicyError(
        "historical Job launch is not bound to the continuation worker repair",
      );
    const successor = await this.projection.runContinuationRepairSuccessor(lock.run_id);
    if (
      successor &&
      launch.payload.run_continuation_repair_successor_id !== successor.record_id &&
      !(
        launch.payload.run_continuation_repair_successor_id === undefined &&
        Date.parse(launch.created_at) <= Date.parse(successor.created_at)
      )
    )
      throw new PolicyError(
        "historical Job launch is not bound to the continuation worker repair successor",
      );
  }

  async assertReusableHistoricalPreparation(
    lock: RunLock,
    execution: ResolvedExecutionContract,
  ): Promise<PreparedJob> {
    const previousDeployment = profileSpec<DeploymentProfileSpec>(
      lock.profiles,
      "deployment",
    );
    if (
      !preparationRequired(previousDeployment) ||
      !preparationRequired(execution.deployment)
    )
      throw new PolicyError(
        "historical continuation requires the original prepared execution",
      );
    const prepared = await this.preparedJob(lock.run_id);
    const lockDigest = sha256(canonicalJson(lock));
    if (!prepared)
      throw new PolicyError("historical prepared run has no reusable prepared job");
    if (
      prepared.run_lock_digest !== lockDigest ||
      prepared.harbor_version !== execution.deployment.harbor_version
    )
      throw new PolicyError("historical prepared job does not match the run lock");
    if (
      prepared.trials.length !== lock.tasks.length ||
      prepared.trials.some(
        (reference, index) => reference.task_id !== lock.tasks[index]?.task_id,
      )
    )
      throw new PolicyError("historical prepared job does not cover the run tasks");

    const trials: Array<PreparedTrial | null> = [];
    for (let offset = 0; offset < lock.tasks.length; offset += 32) {
      const batch = lock.tasks.slice(offset, offset + 32);
      trials.push(
        ...(await Promise.all(
          batch.map((task) => this.preparedTrial(lock.run_id, task.task_id)),
        )),
      );
    }
    const historicalExecution = {
      ...execution,
      deployment: previousDeployment,
    } as ResolvedExecutionContract;
    const launchFields = [
      "hardware",
      "timeout_seconds",
      "active_hourly_cost_microusd",
      "max_jobs",
      "max_image_bytes",
      "max_image_entries",
    ] as const;
    for (const [index, expected] of lock.tasks.entries()) {
      const reference = prepared.trials[index];
      const trial = trials[index];
      if (
        !reference ||
        !trial ||
        reference.record_id !== trial.record_id ||
        reference.record_digest !== sha256(canonicalJson(trial)) ||
        trial.preparation_id !== prepared.preparation_id ||
        trial.run_lock_digest !== lockDigest ||
        trial.task_id !== expected.task_id ||
        trial.input_digest !== expected.input_digest ||
        trial.source_task_id !== expected.source_task_id ||
        trial.trial_index !== expected.trial_index
      )
        throw new PolicyError(
          `historical prepared trial does not match the run lock: ${expected.task_id}`,
        );
      let previousLaunch: PreparedTrialJobLaunch;
      let currentLaunch: PreparedTrialJobLaunch;
      try {
        previousLaunch = preparedTrialJobLaunch(historicalExecution, trial);
        currentLaunch = preparedTrialJobLaunch(execution, trial);
      } catch (error) {
        throw new PolicyError(
          error instanceof Error
            ? error.message
            : `prepared trial launch is invalid: ${expected.task_id}`,
        );
      }
      for (const field of launchFields) {
        if (previousLaunch[field] !== currentLaunch[field])
          throw new PolicyError(
            `continuation changes prepared trial ${field}: ${expected.task_id}`,
          );
      }
    }
    return prepared;
  }

  async preparedTrial(runId: string, taskId: string): Promise<PreparedTrial | null> {
    return this.readRecord<PreparedTrial>({
      kind: "prepared.trial",
      record_id: deterministicId("prepared-trial", runId, taskId),
      run_id: runId,
      task_id: taskId,
    });
  }

  async preparedJob(runId: string): Promise<PreparedJob | null> {
    return this.readRecord<PreparedJob>({
      kind: "prepared.job",
      record_id: deterministicId("prepared-job", runId),
      run_id: runId,
    });
  }

  async submitPreparedJob(
    runId: string,
    launchActionId: string,
    raw: unknown,
  ): Promise<PreparedJobSubmissionResult> {
    return this.withRunMutationAdmission(runId, () =>
      this.submitPreparedJobSerialized(runId, launchActionId, raw),
    );
  }

  private async assertPreparationAction(
    runId: string,
    launchActionId: string,
  ): Promise<void> {
    const action = await this.projection.action(launchActionId);
    if (!action || action.run_id !== runId || action.action_kind !== "job.launch")
      throw new PolicyError("prepared job submission has no matching launch action");
    const intent = JSON.parse(action.intent_body) as ActionIntent;
    if (intent.payload.worker_role !== "preparation")
      throw new PolicyError("prepared job submission requires a preparation worker");
  }

  private async submitPreparedJobSerialized(
    runId: string,
    launchActionId: string,
    raw: unknown,
  ): Promise<PreparedJobSubmissionResult> {
    this.assertReady();
    await this.assertPreparationAction(runId, launchActionId);
    const input = validatePreparedJobSubmission<PreparedJobSubmissionV1>(raw);
    const lock = await this.projection.runLock(runId);
    if (!lock) throw new PolicyError("prepared job run lock does not exist");
    const execution = await this.runExecution(lock);
    const lockDigest = sha256(canonicalJson(lock));
    const preparationId = deterministicId("preparation", runId);
    if (input.phase === "trial") {
      const expected = lock.tasks.find((task) => task.task_id === input.task_id);
      if (!expected) throw new PolicyError("prepared trial is outside the run");
      if (
        expected.input_digest !== input.input_digest ||
        expected.source_task_id !== input.source_task_id ||
        expected.trial_index !== input.trial_index
      )
        throw new PolicyError("prepared trial does not match the run task lock");
      const trialLock = objectValue(input.trial_lock, "prepared Harbor trial lock");
      const harborTask = objectValue(trialLock.task, "prepared Harbor task lock");
      if (harborTask.digest !== input.input_digest)
        throw new PolicyError("prepared Harbor task digest does not match the run");
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
      const agent = objectValue(trialLock.agent, "prepared Harbor agent lock");
      if (!execution.harbor_agent || !subsetMatches(execution.harbor_agent, agent))
        throw new PolicyError(
          "prepared Harbor agent does not match the locked execution contract",
        );
      const deployment = execution.deployment;
      if (!deployment.trial_job_template)
        throw new PolicyError("prepared run has no trial Job deployment");
      const timeoutSeconds =
        input.agent_timeout_seconds +
        input.verifier_timeout_seconds +
        input.environment_build_timeout_seconds +
        input.agent_setup_timeout_seconds +
        deployment.trial_job_template.lifetime_overhead_seconds;
      if (timeoutSeconds > deployment.trial_job_template.max_timeout_seconds)
        throw new PolicyError("prepared task time limits exceed deployment limits");
      const existing = await this.preparedTrial(runId, input.task_id);
      const createdAt = existing?.created_at ?? this.clock.now().toISOString();
      const record: PreparedTrial = {
        schema_version: "v1",
        kind: "prepared.trial",
        record_id: deterministicId("prepared-trial", runId, input.task_id),
        created_at: createdAt,
        actor: serviceActor(),
        run_id: runId,
        preparation_id: preparationId,
        run_lock_digest: lockDigest,
        task_id: input.task_id,
        source_task_id: input.source_task_id,
        trial_index: input.trial_index,
        input_digest: input.input_digest,
        trial_lock: input.trial_lock,
        trial_lock_digest: input.trial_lock_digest,
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

    const existing = await this.preparedJob(runId);
    const preparedTrials: PreparedTrial[] = [];
    for (const task of lock.tasks) {
      const trial = await this.preparedTrial(runId, task.task_id);
      if (!trial) throw new PolicyError(`prepared trial is missing: ${task.task_id}`);
      if (
        trial.preparation_id !== preparationId ||
        trial.run_lock_digest !== lockDigest
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
    const deployment = execution.deployment;
    if (deployment.harbor_version !== input.harbor_version)
      throw new PolicyError(
        "prepared Harbor version does not match the locked execution contract",
      );
    const harborInfo = objectValue(header.harbor, "prepared Harbor version lock");
    if (harborInfo.version !== input.harbor_version)
      throw new PolicyError("prepared Harbor lock reports a different version");
    const benchmark = this.resolvedProfile<BenchmarkProfileSpec>(lock, "benchmark");
    if (!subsetMatches(benchmark.harbor_job, input.job_config))
      throw new PolicyError("prepared Harbor job does not match the benchmark profile");
    const jobConfig = objectValue(input.job_config, "prepared Harbor job config");
    const agents = jobConfig.agents;
    if (
      !execution.harbor_agent ||
      !Array.isArray(agents) ||
      agents.length !== 1 ||
      !subsetMatches(execution.harbor_agent, agents[0])
    )
      throw new PolicyError(
        "prepared Harbor agent does not match the locked execution contract",
      );
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
      record_id: deterministicId("prepared-job", runId),
      created_at: createdAt,
      actor: serviceActor(),
      run_id: runId,
      preparation_id: preparationId,
      run_lock_digest: lockDigest,
      harbor_version: input.harbor_version,
      job_config: input.job_config,
      job_lock_header: input.job_lock_header,
      trials: [refs[0] as (typeof refs)[number], ...refs.slice(1)],
      harbor_lock_digest: harborLockDigest,
    };
    if (existing && canonicalJson(existing) !== canonicalJson(record))
      throw new IdempotencyConflictError(
        "prepared job conflicts with durable run state",
      );
    const result = await this.append(record);
    return {
      phase: "finalize",
      record_id: record.record_id,
      digest: result.digest,
      adopted: !result.created,
    };
  }

  async admitJobLaunch(intent: ActionIntent): Promise<JobAdmissionResult> {
    const operation = this.jobAdmissionQueue.then(() =>
      this.admitJobLaunchSerialized(intent),
    );
    this.jobAdmissionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async ensureJobLaunchReservation(intent: ActionIntent): Promise<boolean> {
    const amount = intent.payload.reservation_microusd;
    if (typeof amount !== "number" || amount <= 0) return true;
    const priorAttemptId = intent.payload.prior_attempt_id;
    if (typeof priorAttemptId === "string")
      return this.reserveReplacement(
        intent.run_id,
        priorAttemptId,
        intent.created_at,
        amount,
      );
    const taskIds = stringArrayValue(intent.payload.task_ids, "Job action task IDs");
    const category =
      intent.payload.worker_role === "preparation"
        ? "preparation"
        : executionReservationCategory(taskIds);
    return this.reserveJobActions(intent.run_id, [
      {
        category,
        generation: intent.generation,
        created_at: intent.created_at,
        amount_microusd: amount,
      },
    ]);
  }

  private async launchCancellationRequested(intent: ActionIntent): Promise<boolean> {
    for (const action of await this.projection.runActions(intent.run_id)) {
      if (action.action_kind !== "run.cancel") continue;
      const cancellation = JSON.parse(action.intent_body) as ActionIntent;
      const taskId = cancellation.payload.task_id;
      if (typeof taskId !== "string") return true;
      if (
        intent.payload.worker_role !== "preparation" &&
        Array.isArray(intent.payload.task_ids) &&
        intent.payload.task_ids.includes(taskId)
      )
        return true;
    }
    return false;
  }

  private async appendJobGrant(
    intent: ActionIntent,
    profileId: string,
    hardware: string,
    reservedProviderRequests: number,
    previousGrantId: string | null,
    decision: JobAdmissionDecision,
  ): Promise<JobAdmissionGrant> {
    const grant: JobAdmissionGrant = {
      schema_version: "v1",
      kind: "job.admission",
      record_id: deterministicId("job-admission", intent.action_id),
      created_at: this.clock.now().toISOString(),
      actor: serviceActor(),
      action_id: intent.action_id,
      run_id: intent.run_id,
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

  private async admitJobLaunchSerialized(
    intent: ActionIntent,
  ): Promise<JobAdmissionResult> {
    if (intent.action_kind !== "job.launch")
      throw new PolicyError("Job launch admission requires a job.launch intent");
    const hardware = intent.payload.hardware;
    const runMaxJobs = intent.payload.max_jobs;
    if (typeof hardware !== "string" || typeof runMaxJobs !== "number")
      throw new PolicyError("Job launch is missing immutable capacity policy");
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
    if (!(await this.ensureJobLaunchReservation(intent)))
      throw new PolicyError(
        `Job launch has no active budget reservation: ${intent.action_id}`,
      );
    if (await this.launchCancellationRequested(intent)) {
      const receipt = await this.receipt(intent, {
        outcome: "completed",
        observed_state: "suppressed-cancelled",
        error_code: "run_cancelled",
      });
      await this.releaseJobAction(intent, receipt.created_at);
      await this.markAdvanced(intent, receipt);
      return {
        status: "rejected",
        dispatch_created: false,
        action_id: intent.action_id,
        limiting_factor: "run_cancelled",
        not_before: null,
      };
    }
    const capacity = this.capacityProfile();
    if (!capacity) {
      return {
        status: "admitted",
        dispatch_created: Boolean(
          await this.projection.actionDispatch(intent.action_id),
        ),
        action_id: intent.action_id,
        limiting_factor: null,
        not_before: null,
      };
    }
    const existingGrant = await this.projection.jobAdmission(intent.action_id);
    if (!existingGrant) {
      const active = await this.projection.activeJobAdmissions(this.namespace);
      const latest = await this.projection.latestJobAdmission(this.namespace);
      const providerRequests = intent.payload.inference_max_concurrency ?? 0;
      const providerLimit =
        intent.payload.inference_max_total_concurrency ??
        Math.max(providerRequests, runMaxJobs * providerRequests);
      const decision = decideJobAdmission(
        capacity.spec,
        {
          active_jobs: active.length,
          active_hardware: active.filter((grant) => grant.hardware === hardware).length,
          active_provider_requests: active
            .filter((grant) => grant.run_id === intent.run_id)
            .reduce((total, grant) => total + grant.reserved_provider_requests, 0),
          tokens: latest?.tokens_remaining ?? capacity.spec.start_burst,
          refill_cursor_at: latest?.refill_cursor_at ?? this.clock.now().toISOString(),
        },
        hardware,
        providerRequests,
        providerLimit,
        runMaxJobs,
        active.filter((grant) => grant.run_id === intent.run_id).length,
        this.clock.now(),
      );
      if (decision.status === "deferred")
        return {
          status: "deferred",
          dispatch_created: false,
          action_id: intent.action_id,
          limiting_factor: decision.limiting_factor,
          not_before: decision.not_before,
        };
      if (
        decision.tokens_remaining < 0 ||
        decision.tokens_remaining > capacity.spec.start_burst
      )
        throw new PolicyError(
          "Job admission token state violates the selected capacity profile",
        );
      await this.appendJobGrant(
        intent,
        capacity.profile_id,
        hardware,
        providerRequests,
        latest?.record_id ?? null,
        decision,
      );
    }
    return {
      status: "admitted",
      dispatch_created: Boolean(await this.projection.actionDispatch(intent.action_id)),
      action_id: intent.action_id,
      limiting_factor: null,
      not_before: null,
    };
  }

  async jobCapacityView(runId: string): Promise<JobCapacityView> {
    const lock = await this.projection.runLock(runId);
    if (!lock) throw new PolicyError("run lock is missing");
    const continuation = await this.projection.runContinuation(runId);
    const deployment =
      isCurrentRunLock(lock) || continuation
        ? resolvedRunExecution(lock, continuation).deployment
        : profileSpec<DeploymentProfileSpec>(lock.profiles, "deployment");
    const capacity = this.capacityProfile();
    const active = await this.projection.activeJobAdmissions(this.namespace);
    const runActive = active.filter((grant) => grant.run_id === runId);
    const latest = await this.projection.latestJobAdmission(this.namespace);
    const actions = await this.projection.runActions(runId);
    const queuedActions = actions.filter(
      (action) => action.action_kind === "job.launch" && action.receipt_body === null,
    );
    const queued = queuedActions.length;
    const template =
      deployment.route === "hf_job" ? deployment.trial_job_template : undefined;
    const runLimit = template?.max_jobs ?? 1;
    const queuedIntent = queuedActions[0]
      ? (JSON.parse(queuedActions[0].intent_body) as ActionIntent)
      : null;
    const hardware =
      runActive[0]?.hardware ??
      (typeof queuedIntent?.payload.hardware === "string"
        ? queuedIntent.payload.hardware
        : undefined);
    const hardwareLimit = hardware
      ? (capacity?.spec.hardware_limits.find((limit) => limit.hardware === hardware)
          ?.max_active_jobs ?? null)
      : null;
    const hardwareActive = hardware
      ? active.filter((grant) => grant.hardware === hardware).length
      : 0;
    const providerReserved = runActive.reduce(
      (total, grant) => total + grant.reserved_provider_requests,
      0,
    );
    const providerLimit =
      template?.inference_max_total_concurrency ??
      runLimit * (template?.inference_max_concurrency ?? 0);
    let startTokens: number | null = null;
    let notBefore: string | null = null;
    if (capacity) {
      const startRate = refilledStartTokens(capacity.spec, latest, this.clock.now());
      startTokens = startRate.tokens;
      notBefore = startRate.not_before;
    }
    let limitingFactor: JobCapacityView["limiting_factor"] = null;
    const globallyCancelled = (await this.projection.runActions(runId)).some(
      (action) => {
        if (action.action_kind !== "run.cancel") return false;
        const cancellation = JSON.parse(action.intent_body) as ActionIntent;
        return typeof cancellation.payload.task_id !== "string";
      },
    );
    if (globallyCancelled) limitingFactor = "run_cancelled";
    else if (runActive.length >= runLimit) limitingFactor = "run_job_capacity";
    else if (capacity && active.length >= capacity.spec.max_active_jobs)
      limitingFactor = "namespace_job_capacity";
    else if (hardwareLimit !== null && hardwareActive >= hardwareLimit)
      limitingFactor = "hardware_job_capacity";
    else if (providerLimit > 0 && providerReserved >= providerLimit)
      limitingFactor = "provider_request_capacity";
    else if (capacity && startTokens !== null && startTokens < 1)
      limitingFactor = "start_rate";
    return {
      configured: Boolean(capacity),
      profile_id: capacity?.profile_id ?? null,
      namespace_limit: capacity?.spec.max_active_jobs ?? null,
      namespace_active: active.length,
      run_limit: runLimit,
      run_active: runActive.length,
      hardware_limit: hardwareLimit,
      hardware_active: hardwareActive,
      provider_limit: providerLimit,
      provider_reserved: providerReserved,
      start_tokens: startTokens,
      start_burst: capacity?.spec.start_burst ?? null,
      queued,
      limiting_factor: limitingFactor,
      not_before: notBefore,
    };
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

  async continueHistoricalRun(
    runId: string,
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<RunContinuationResult> {
    const operation = this.submitQueue.then(() =>
      this.continueHistoricalRunSerialized(runId, raw, idempotencyKey, actor),
    );
    this.submitQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async continueHistoricalRunSerialized(
    runId: string,
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<RunContinuationResult> {
    this.assertReady();
    if (actor.role !== "operator")
      throw new PolicyError("run continuation requires an operator");
    if (!idempotencyKey || idempotencyKey.length > 256)
      throw new IdempotencyConflictError("a bounded idempotency key is required");
    const input = validateRunContinuation<HarborHFRunContinuationV1>(raw);
    const lock = await this.projection.runLock(runId);
    if (!lock) throw new PolicyError("run lock does not exist");
    if (isCurrentRunLock(lock))
      throw new PolicyError("current run locks do not need continuation");
    const keyDigest = sha256(idempotencyKey);
    const payloadDigest = sha256(canonicalJson(input));
    const existing = await this.projection.runContinuation(runId);
    if (existing) {
      if (
        existing.idempotency_key_digest !== keyDigest ||
        existing.idempotency_payload_digest !== payloadDigest ||
        canonicalJson(existing.actor) !== canonicalJson(actor)
      )
        throw new IdempotencyConflictError(
          "run continuation already exists with different authorization",
        );
      return {
        run_id: runId,
        continuation_id: existing.record_id,
        status_url: `/api/v1/runs/${runId}`,
        adopted: true,
      };
    }
    const run = await this.projection.run(runId);
    if (!run) throw new PolicyError("run does not exist");
    if (runStatusIsTerminal(run.status))
      throw new PolicyError("terminal run cannot receive continuation");
    if (!run.paused)
      throw new PolicyError("historical run must be paused before continuation");
    if (
      run.pending_actions > 0 ||
      run.cleanup_pending ||
      (await this.projection.runHasUnadvancedActions(runId)) ||
      (await this.projection.runHasRunningJobs(runId))
    )
      throw new PolicyError(
        "historical run must have no pending action, unadvanced action, running Job, or cleanup before continuation",
      );

    const profiles = this.resolver.resolve({
      benchmark: lockedProfileName(lock, "benchmark"),
      model: lockedProfileName(lock, "model"),
      harness: lockedProfileName(lock, "harness"),
      deployment: lockedProfileName(lock, "deployment"),
      launch_policy: lockedProfileName(lock, "launch_policy"),
    });
    const execution = composeExecutionContract(profiles);
    try {
      assertRunContinuationCompatible(lock, execution);
      validatePreparedRunProfiles(
        execution,
        this.resolvedProfile<BenchmarkProfileSpec>(lock, "benchmark"),
        lock.tasks,
      );
    } catch (error) {
      throw new PolicyError(
        error instanceof Error ? error.message : "run continuation is incompatible",
      );
    }
    await this.assertReusableHistoricalPreparation(lock, execution);
    const record: RunContinuation = {
      schema_version: "v1",
      kind: "run.continuation",
      record_id: deterministicId("continuation", runId),
      created_at: this.clock.now().toISOString(),
      actor,
      run_id: runId,
      run_lock_digest: sha256(canonicalJson(lock)),
      idempotency_key_digest: keyDigest,
      idempotency_payload_digest: payloadDigest,
      execution,
      reason: input.reason,
    };
    const appended = await this.appendAdopting(record, (recorded) => {
      const { created_at: _recordedAt, ...recordedValue } = recorded;
      const { created_at: _candidateAt, ...candidateValue } = record;
      return canonicalJson(recordedValue) === canonicalJson(candidateValue);
    });
    return {
      run_id: runId,
      continuation_id: appended.record.record_id,
      status_url: `/api/v1/runs/${runId}`,
      adopted: !appended.created,
    };
  }

  async repairHistoricalContinuation(
    runId: string,
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<RunContinuationRepairResult> {
    const operation = this.submitQueue.then(() =>
      this.repairHistoricalContinuationSerialized(runId, raw, idempotencyKey, actor),
    );
    this.submitQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async repairHistoricalContinuationSerialized(
    runId: string,
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<RunContinuationRepairResult> {
    this.assertReady();
    if (actor.role !== "operator")
      throw new PolicyError("run continuation repair requires an operator");
    if (!idempotencyKey || idempotencyKey.length > 256)
      throw new IdempotencyConflictError("a bounded idempotency key is required");
    const input = validateRunContinuation<HarborHFRunContinuationV1>(raw);
    const lock = await this.projection.runLock(runId);
    if (!lock) throw new PolicyError("run lock does not exist");
    if (isCurrentRunLock(lock))
      throw new PolicyError("current run locks do not need continuation repair");
    const continuation = await this.projection.runContinuation(runId);
    if (!continuation)
      throw new PolicyError("historical run has no execution continuation attachment");
    const keyDigest = sha256(idempotencyKey);
    const payloadDigest = sha256(canonicalJson(input));
    const existing = await this.projection.runContinuationRepair(runId);
    if (existing) {
      if (
        existing.idempotency_key_digest !== keyDigest ||
        existing.idempotency_payload_digest !== payloadDigest ||
        canonicalJson(existing.actor) !== canonicalJson(actor)
      )
        throw new IdempotencyConflictError(
          "run continuation repair already exists with different authorization",
        );
      return {
        run_id: runId,
        continuation_repair_id: existing.record_id,
        status_url: `/api/v1/runs/${runId}`,
        adopted: true,
      };
    }
    const run = await this.projection.run(runId);
    if (!run) throw new PolicyError("run does not exist");
    if (
      run.pending_actions > 0 ||
      run.cleanup_pending ||
      (await this.projection.runHasUnadvancedActions(runId)) ||
      (await this.projection.runHasRunningJobs(runId))
    )
      throw new PolicyError(
        "historical run must have no pending action, unadvanced action, running Job, or cleanup before continuation repair",
      );
    if (!run.paused && run.status !== "failed")
      throw new PolicyError(
        "historical run must be paused or failed before continuation repair",
      );
    const profiles = this.resolver.resolve({
      benchmark: lockedProfileName(lock, "benchmark"),
      model: lockedProfileName(lock, "model"),
      harness: lockedProfileName(lock, "harness"),
      deployment: lockedProfileName(lock, "deployment"),
      launch_policy: lockedProfileName(lock, "launch_policy"),
    });
    const candidate = composeExecutionContract(profiles);
    try {
      assertRunContinuationRepairCandidate(continuation, candidate);
    } catch (error) {
      throw new PolicyError(
        error instanceof Error ? error.message : "run continuation repair is invalid",
      );
    }
    const workerRevision = candidate.deployment.worker_revision;
    if (!workerRevision)
      throw new PolicyError("continuation repair deployment has no worker revision");
    const record: RunContinuationRepair = {
      schema_version: "v1",
      kind: "run.continuation.repair",
      record_id: deterministicId("continuation-repair", runId),
      created_at: this.clock.now().toISOString(),
      actor,
      run_id: runId,
      run_lock_digest: continuation.run_lock_digest,
      run_continuation_id: continuation.record_id,
      run_continuation_digest: sha256(canonicalJson(continuation)),
      idempotency_key_digest: keyDigest,
      idempotency_payload_digest: payloadDigest,
      job_image: candidate.deployment.job_image,
      worker_revision: workerRevision,
      reason: input.reason,
    };
    const appended = await this.appendAdopting(record, (recorded) => {
      const { created_at: _recordedAt, ...recordedValue } = recorded;
      const { created_at: _candidateAt, ...candidateValue } = record;
      return canonicalJson(recordedValue) === canonicalJson(candidateValue);
    });
    return {
      run_id: runId,
      continuation_repair_id: appended.record.record_id,
      status_url: `/api/v1/runs/${runId}`,
      adopted: !appended.created,
    };
  }

  async repairHistoricalContinuationSuccessor(
    runId: string,
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<RunContinuationRepairSuccessorResult> {
    const operation = this.submitQueue.then(() =>
      this.repairHistoricalContinuationSuccessorSerialized(
        runId,
        raw,
        idempotencyKey,
        actor,
      ),
    );
    this.submitQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async repairHistoricalContinuationSuccessorSerialized(
    runId: string,
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<RunContinuationRepairSuccessorResult> {
    this.assertReady();
    if (actor.role !== "operator")
      throw new PolicyError("run continuation repair successor requires an operator");
    if (!idempotencyKey || idempotencyKey.length > 256)
      throw new IdempotencyConflictError("a bounded idempotency key is required");
    const input = validateRunContinuation<HarborHFRunContinuationV1>(raw);
    const lock = await this.projection.runLock(runId);
    if (!lock) throw new PolicyError("run lock does not exist");
    if (isCurrentRunLock(lock))
      throw new PolicyError(
        "current run locks do not need continuation repair successors",
      );
    const continuation = await this.projection.runContinuation(runId);
    const repair = await this.projection.runContinuationRepair(runId);
    if (!continuation || !repair)
      throw new PolicyError(
        "historical run has no continuation worker repair to supersede",
      );
    const keyDigest = sha256(idempotencyKey);
    const payloadDigest = sha256(canonicalJson(input));
    const existing = await this.projection.runContinuationRepairSuccessor(runId);
    if (existing) {
      if (
        existing.idempotency_key_digest !== keyDigest ||
        existing.idempotency_payload_digest !== payloadDigest ||
        canonicalJson(existing.actor) !== canonicalJson(actor)
      )
        throw new IdempotencyConflictError(
          "run continuation repair successor already exists with different authorization",
        );
      return {
        run_id: runId,
        continuation_repair_successor_id: existing.record_id,
        status_url: `/api/v1/runs/${runId}`,
        adopted: true,
      };
    }
    const run = await this.projection.run(runId);
    if (!run) throw new PolicyError("run does not exist");
    if (
      run.pending_actions > 0 ||
      run.cleanup_pending ||
      (await this.projection.runHasUnadvancedActions(runId)) ||
      (await this.projection.runHasRunningJobs(runId))
    )
      throw new PolicyError(
        "historical run must have no pending action, unadvanced action, running Job, or cleanup before continuation repair successor",
      );
    if (!run.paused && run.status !== "failed")
      throw new PolicyError(
        "historical run must be paused or failed before continuation repair successor",
      );
    const profiles = this.resolver.resolve({
      benchmark: lockedProfileName(lock, "benchmark"),
      model: lockedProfileName(lock, "model"),
      harness: lockedProfileName(lock, "harness"),
      deployment: lockedProfileName(lock, "deployment"),
      launch_policy: lockedProfileName(lock, "launch_policy"),
    });
    const candidate = composeExecutionContract(profiles);
    try {
      assertRunContinuationRepairSuccessorCandidate(continuation, repair, candidate);
    } catch (error) {
      throw new PolicyError(
        error instanceof Error
          ? error.message
          : "run continuation repair successor is invalid",
      );
    }
    const workerRevision = candidate.deployment.worker_revision;
    if (!workerRevision)
      throw new PolicyError(
        "continuation repair successor deployment has no worker revision",
      );
    const record: RunContinuationRepairSuccessor = {
      schema_version: "v1",
      kind: "run.continuation.repair.successor",
      record_id: deterministicId("continuation-repair-successor", runId),
      created_at: this.clock.now().toISOString(),
      actor,
      run_id: runId,
      run_lock_digest: continuation.run_lock_digest,
      run_continuation_id: continuation.record_id,
      run_continuation_digest: sha256(canonicalJson(continuation)),
      run_continuation_repair_id: repair.record_id,
      run_continuation_repair_digest: sha256(canonicalJson(repair)),
      idempotency_key_digest: keyDigest,
      idempotency_payload_digest: payloadDigest,
      job_image: candidate.deployment.job_image,
      worker_revision: workerRevision,
      reason: input.reason,
    };
    const appended = await this.appendAdopting(record, (recorded) => {
      const { created_at: _recordedAt, ...recordedValue } = recorded;
      const { created_at: _candidateAt, ...candidateValue } = record;
      return canonicalJson(recordedValue) === canonicalJson(candidateValue);
    });
    return {
      run_id: runId,
      continuation_repair_successor_id: appended.record.record_id,
      status_url: `/api/v1/runs/${runId}`,
      adopted: !appended.created,
    };
  }

  private async submitSerialized(
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<SubmissionResult> {
    this.assertReady();
    if (!idempotencyKey || idempotencyKey.length > 256)
      throw new IdempotencyConflictError("a bounded idempotency key is required");
    const input = validateRunSubmission<RunSubmissionV1>(raw);
    if (!input.confirmed)
      throw new ConfirmationRequiredError(
        "run submission requires explicit confirmation",
      );
    const keyDigest = sha256(idempotencyKey);
    const existingId = await this.projection.runIdForIdempotency(keyDigest);
    const runId = existingId ?? this.newRunId(input, actor, keyDigest);
    const actionId = deterministicId("action", runId, "run.admit", "run", "0");
    const existingRequest = await this.projection.runRequest(runId);
    const existingLock = await this.projection.runLock(runId);
    if (existingRequest) this.assertMatchingRequest(existingRequest, input, actor);
    if (existingLock) this.assertMatchingSubmission(existingLock, input);
    if (existingLock && !isCurrentRunLock(existingLock))
      throw new PolicyError(
        "historical run locks cannot be resubmitted after the profile cutover",
      );
    const currentExistingLock =
      existingLock && isCurrentRunLock(existingLock) ? existingLock : null;

    const profiles = currentExistingLock?.profiles ?? this.resolver.resolve(input);
    const execution =
      currentExistingLock?.execution ?? composeExecutionContract(profiles);
    const deployment = profileSpec<DeploymentProfileSpec>(profiles, "deployment");
    if (deployment.route !== "hf_job")
      throw new PolicyError("imported deployment profiles cannot launch runs");
    const launchPolicy = profileSpec<LaunchPolicySpec>(profiles, "launch_policy");
    if (
      launchPolicy.max_run_ceiling_microusd !== undefined &&
      input.ceiling_microusd > launchPolicy.max_run_ceiling_microusd
    )
      throw new PolicyError("run ceiling exceeds the launch policy maximum");
    const tasks = existingLock?.tasks ?? this.resolver.tasks(input.benchmark);
    const executionJobs = tasks.length;
    const initialReservation =
      launchPolicy.reservation_microusd * executionJobs +
      (preparationRequired(deployment)
        ? (launchPolicy.preparation_reservation_microusd ?? 0) *
          (launchPolicy.max_preparation_attempts ?? 1)
        : 0);
    if (initialReservation > input.ceiling_microusd)
      throw new PolicyError("launch reservation exceeds the run ceiling");
    const benchmark = profileSpec<BenchmarkProfileSpec>(profiles, "benchmark");
    try {
      validatePreparedRunProfiles(execution, benchmark, tasks);
    } catch (error) {
      throw new PolicyError(
        error instanceof Error ? error.message : "prepared run profile is invalid",
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
    const request: RunRequest =
      existingRequest ??
      ({
        schema_version: "v1",
        kind: "run.request",
        record_id: deterministicId("request", runId),
        created_at: timestamp,
        actor: recordActor,
        run_id: runId,
        idempotency_key_digest: keyDigest,
        profiles: refs as RunRequest["profiles"],
        ceiling_microusd: input.ceiling_microusd,
        start_paused: input.start_paused ?? false,
      } satisfies RunRequest);
    const lock: CurrentRunLock =
      currentExistingLock ??
      ({
        schema_version: "v1",
        kind: "run.lock",
        record_id: deterministicId("lock", runId),
        created_at: timestamp,
        actor: recordActor,
        run_id: runId,
        profiles: profiles as CurrentRunLock["profiles"],
        tasks: tasks as CurrentRunLock["tasks"],
        ceiling_microusd: input.ceiling_microusd,
        source_revision: this.resolver.sourceRevision(),
        execution,
        start_paused: input.start_paused ?? false,
      } satisfies CurrentRunLock);
    const budget: BudgetEvent = {
      schema_version: "v1",
      kind: "budget.event",
      record_id: deterministicId("budget", runId, "ceiling"),
      created_at: timestamp,
      actor: recordActor,
      run_id: runId,
      event_kind: "ceiling",
      amount_microusd: input.ceiling_microusd,
    };
    const intent = this.actionIntent(
      runId,
      "run.admit",
      "run",
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
          runId,
          "run.pause",
          "run",
          0,
          { reason: "run submitted in paused state" },
          recordActor,
          pausedAt,
        ),
      );
    }
    return {
      run_id: runId,
      action_id: actionId,
      status_url: `/api/v1/runs/${runId}`,
      adopted: Boolean(existingRequest || existingLock),
    };
  }

  /**
   * Name a new run `run-<model>-<harness>-<reasoning>-<runtime>-<unique>`.
   *
   * The unique suffix is derived from the namespace, actor, and idempotency
   * key so a repeated request adopts the same identity.
   */
  private newRunId(input: RunSubmissionV1, actor: Actor, keyDigest: string): string {
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
    request: RunRequest,
    input: RunSubmissionV1,
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
        "idempotency key already belongs to a different run request",
      );
  }

  private assertMatchingSubmission(lock: RunLock, input: RunSubmissionV1): void {
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
        "idempotency key already belongs to a different run request",
      );
  }

  actionIntent(
    runId: string,
    actionKind: ActionIntent["action_kind"],
    target: string,
    generation: number,
    payload: ActionIntent["payload"],
    actor: Actor = serviceActor(),
    timestamp = this.clock.now().toISOString(),
  ): ActionIntent {
    const actionId = deterministicId(
      "action",
      runId,
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
      run_id: runId,
      action_kind: actionKind,
      generation,
      target,
      payload,
    };
  }

  async writeAction(intent: ActionIntent): Promise<void> {
    validateJobLaunchAssignment(intent);
    const existing = await this.projection.action(intent.action_id);
    if (existing) {
      const recorded = JSON.parse(existing.intent_body) as ActionIntent;
      const same =
        recorded.run_id === intent.run_id &&
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
    if (
      intent.action_kind === "job.launch" &&
      intent.payload.worker_role === "execution"
    ) {
      const repair = await this.projection.runContinuationRepair(intent.run_id);
      if (repair && intent.payload.run_continuation_repair_id !== repair.record_id)
        throw new PolicyError(
          "new historical Job launch is not bound to the continuation worker repair",
        );
      const successor = await this.projection.runContinuationRepairSuccessor(
        intent.run_id,
      );
      if (
        successor &&
        intent.payload.run_continuation_repair_successor_id !== successor.record_id
      )
        throw new PolicyError(
          "new historical Job launch is not bound to the continuation worker repair successor",
        );
    }
    const taskId =
      typeof intent.payload.task_id === "string" ? intent.payload.task_id : null;
    if (taskId) {
      const task = await this.projection.task(intent.run_id, taskId);
      const continuation = await this.projection.runContinuation(intent.run_id);
      const continuedFailure =
        task &&
        continuation &&
        intent.payload.run_continuation_id === continuation.record_id &&
        historicalTaskNeedsSelection(task.task);
      if (
        task?.task.terminal_outcome &&
        !infrastructureSealReplaceable(task.task.terminal_outcome) &&
        !continuedFailure
      )
        throw new PolicyError(`terminal task cannot receive action: ${taskId}`);
    }
    await this.appendAdopting(intent, (recorded) => {
      return (
        recorded.run_id === intent.run_id &&
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
    if (intent.action_kind !== "job.launch")
      throw new PolicyError("only job.launch supports a dispatch fence");
    const operation = "create" as const;
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
      run_id: intent.run_id,
      operation,
      adoption_not_before: adoptionNotBefore,
    };
    const result = await this.appendAdopting(record, (recorded) => {
      return (
        recorded.action_id === record.action_id &&
        recorded.run_id === record.run_id &&
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
      run_id: intent.run_id,
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

  private async releaseJobCapacity(
    launchActionId: string,
    receipt: ActionReceipt,
    reason: JobCapacityRelease["release_reason"],
  ): Promise<boolean> {
    const grant = await this.projection.jobAdmission(launchActionId);
    if (!grant || (await this.projection.jobCapacityRelease(launchActionId)))
      return false;
    const release: JobCapacityRelease = {
      schema_version: "v1",
      kind: "job.capacity-release",
      record_id: deterministicId("job-capacity-release", launchActionId),
      created_at: receipt.created_at,
      actor: serviceActor(),
      action_id: launchActionId,
      run_id: receipt.run_id,
      grant_id: grant.record_id,
      release_reason: reason,
      evidence_record_id: receipt.record_id,
    };
    return (
      await this.appendAdopting(release, (recorded) => {
        const { created_at: _recordedAt, ...recordedValue } = recorded;
        const { created_at: _candidateAt, ...candidateValue } = release;
        return canonicalJson(recordedValue) === canonicalJson(candidateValue);
      })
    ).created;
  }

  async markAdvanced(
    intent: ActionIntent,
    receipt: ActionReceipt,
  ): Promise<ActionAdvanced> {
    if (intent.action_kind === "job.launch") {
      if (receipt.outcome === "failed")
        await this.releaseJobCapacity(intent.action_id, receipt, "launch_failed");
      else if (receipt.observed_state.startsWith("suppressed-"))
        await this.releaseJobCapacity(intent.action_id, receipt, "launch_suppressed");
    }
    if (
      intent.action_kind === "job.observe" &&
      jobStateIsTerminal(receipt.observed_state) &&
      typeof intent.payload.launch_action_id === "string"
    )
      await this.releaseJobCapacity(
        intent.payload.launch_action_id,
        receipt,
        "job_terminal",
      );
    if (
      intent.action_kind === "job.cancel" &&
      jobStateIsTerminal(receipt.observed_state) &&
      typeof intent.payload.launch_action_id === "string"
    ) {
      const launch = await this.projection.action(intent.payload.launch_action_id);
      if (launch?.action_kind !== "job.launch")
        throw new PolicyError("Job cancellation has no launch action");
      await this.releaseJobAction(
        JSON.parse(launch.intent_body) as ActionIntent,
        receipt.created_at,
      );
      await this.releaseJobCapacity(
        intent.payload.launch_action_id,
        receipt,
        "job_terminal",
      );
    }
    const record: ActionAdvanced = {
      schema_version: "v1",
      kind: "action.advanced",
      record_id: deterministicId("advanced", intent.action_id),
      created_at: receipt.created_at,
      actor: serviceActor(),
      action_id: intent.action_id,
      run_id: intent.run_id,
    };
    const appended = await this.appendAdopting(record, (recorded) => {
      const { created_at: _recordedAt, ...recordedResult } = recorded;
      const { created_at: _candidateAt, ...candidateResult } = record;
      return canonicalJson(recordedResult) === canonicalJson(candidateResult);
    });
    return appended.record;
  }

  async uploadEvidenceObject(
    runId: string,
    actionId: string,
    taskId: string,
    expectedDigest: string,
    bytes: Uint8Array,
  ): Promise<EvidenceUploadResult> {
    const lock = await this.projection.runLock(runId);
    if (!lock) throw new PolicyError("evidence upload has no run lock");
    await this.runExecution(lock);
    const action = await this.projection.action(actionId);
    if (!action || action.run_id !== runId || action.action_kind !== "job.launch")
      throw new PolicyError("evidence upload has no eligible Job launch");
    const intent = JSON.parse(action.intent_body) as ActionIntent;
    await this.assertHistoricalLaunchBinding(lock, intent);
    if (
      !Array.isArray(intent.payload.task_ids) ||
      !intent.payload.task_ids.includes(taskId)
    )
      throw new PolicyError("evidence upload task is outside the Job launch");
    if (!(await this.projection.task(runId, taskId)))
      throw new PolicyError("evidence upload task does not exist");
    const observedDigest = sha256(bytes);
    if (observedDigest !== expectedDigest)
      throw new PolicyError("evidence upload digest does not match its content");
    const path = workerEvidenceObjectPath(runId, actionId, taskId, observedDigest);
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
      action.run_id !== input.run_id ||
      action.action_kind !== "job.launch"
    )
      throw new PolicyError(
        `attempt does not reference an eligible run action: ${input.action_id}`,
      );
    const launch = JSON.parse(action.intent_body) as ActionIntent;
    const launchTasks = stringArrayValue(
      launch.payload.task_ids,
      "attempt Job action task IDs",
    );
    if (
      (launch.payload.worker_role ?? "execution") !== "execution" ||
      launchTasks.length !== 1 ||
      launch.payload.task_id !== input.task_id ||
      launchTasks[0] !== input.task_id
    )
      throw new PolicyError(
        `attempt task is outside its execution Job: ${input.action_id}/${input.task_id}`,
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
    const lock = await this.projection.runLock(input.run_id);
    if (!lock) throw new PolicyError("attempt has no run lock");
    await this.runExecution(lock);
    await this.assertHistoricalLaunchBinding(lock, launch);
    const task = await this.projection.task(input.run_id, input.task_id);
    if (!task) throw new PolicyError(`task does not exist: ${input.task_id}`);
    const replaceable = isCurrentRunLock(lock)
      ? infrastructureSealReplaceable(task.task.terminal_outcome)
      : historicalTaskNeedsSelection(task.task);
    if (!replaceable)
      throw new PolicyError(`terminal task cannot receive attempt: ${input.task_id}`);
    const run = await this.projection.run(input.run_id);
    if (!run) throw new PolicyError(`run does not exist: ${input.run_id}`);
    await this.append(candidate);
    return { receipt: candidate, adopted: false };
  }

  async selectTerminal(
    attempt: AttemptReceipt,
    reason: string,
  ): Promise<TerminalSelection> {
    const lock = await this.projection.runLock(attempt.run_id);
    if (!lock) throw new PolicyError("terminal selection has no run lock");
    await this.runExecution(lock);
    if (!isCurrentRunLock(lock)) {
      const action = await this.projection.action(attempt.action_id);
      if (action?.action_kind !== "job.launch")
        throw new PolicyError("historical attempt has no Job launch");
      await this.assertHistoricalLaunchBinding(
        lock,
        JSON.parse(action.intent_body) as ActionIntent,
      );
      const task = await this.projection.task(attempt.run_id, attempt.task_id);
      if (
        task?.task.selected_attempt_id &&
        task.task.selected_attempt_id !== attempt.attempt_id
      )
        throw new PolicyError(
          `historical selected task cannot change attempt: ${attempt.task_id}`,
        );
    }
    const validity = attemptAdmissibility(attempt, requiredPositiveMetrics(lock));
    if (!validity.admissible && attempt.outcome !== "cancelled")
      throw new PolicyError(`attempt is not selectable: ${validity.reason}`);
    const record: TerminalSelection = {
      schema_version: "v1",
      kind: "terminal.selection",
      record_id: deterministicId(
        "terminal",
        attempt.run_id,
        attempt.task_id,
        attempt.attempt_id,
      ),
      created_at: this.clock.now().toISOString(),
      actor: serviceActor(),
      run_id: attempt.run_id,
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
        attempt.run_id,
        attempt.task_id,
        attempt.attempt_id,
      ),
      created_at: this.clock.now().toISOString(),
      actor: serviceActor(),
      run_id: attempt.run_id,
      task_id: attempt.task_id,
      source_action_id: attempt.action_id,
      last_attempt_id: attempt.attempt_id,
      attempt_count: attemptCount,
      reason,
    };
    await this.append(record);
    return record;
  }

  async exhaustTaskFromPreparation(
    runId: string,
    taskId: string,
    sourceActionId: string,
    createdAt: string,
    reason: string,
    attemptCount: number,
  ): Promise<TaskExhaustion> {
    const record: TaskExhaustion = {
      schema_version: "v1",
      kind: "task.exhaustion",
      record_id: deterministicId("task-exhaustion", runId, taskId, sourceActionId),
      created_at: createdAt,
      actor: serviceActor(),
      run_id: runId,
      task_id: taskId,
      source_action_id: sourceActionId,
      last_attempt_id: null,
      attempt_count: attemptCount,
      reason,
    };
    await this.append(record);
    return record;
  }

  async cancelTask(
    runId: string,
    taskId: string,
    sourceActionId: string,
    createdAt: string,
    reason: string,
  ): Promise<TaskCancellation> {
    const source = await this.projection.action(sourceActionId);
    if (!source || source.run_id !== runId || source.action_kind !== "run.cancel")
      throw new PolicyError("task cancellation has no matching Run cancellation");
    const intent = JSON.parse(source.intent_body) as ActionIntent;
    if (typeof intent.payload.task_id === "string" && intent.payload.task_id !== taskId)
      throw new PolicyError("task cancellation is outside the requested scope");
    const record: TaskCancellation = {
      schema_version: "v1",
      kind: "task.cancellation",
      record_id: deterministicId("task-cancellation", runId, taskId, sourceActionId),
      created_at: createdAt,
      actor: serviceActor(),
      run_id: runId,
      task_id: taskId,
      source_action_id: sourceActionId,
      reason,
    };
    await this.append(record);
    return record;
  }

  async writePublication(record: PublicationReceipt): Promise<void> {
    await this.append(record);
  }

  async writePublicationSupersession(
    runId: string,
    publicationId: string,
    supersededRunId: string,
    supersededPublicationId: string,
    reason: string,
  ): Promise<PublicationSupersession> {
    const existing = await this.projection.publicationSupersession(
      supersededPublicationId,
    );
    if (existing) {
      const record = JSON.parse(existing.body) as PublicationSupersession;
      if (
        record.run_id !== runId ||
        record.publication_id !== publicationId ||
        record.superseded_run_id !== supersededRunId ||
        record.reason !== reason
      )
        throw new IdempotencyConflictError(
          "publication supersession conflicts with durable state",
        );
      return record;
    }
    const publication = await this.projection.publication(publicationId);
    if (publication?.run_id !== runId)
      throw new PolicyError("replacement publication does not exist");
    const record: PublicationSupersession = {
      schema_version: "v1",
      kind: "publication.supersession",
      record_id: deterministicId(
        "publication-supersession",
        supersededPublicationId,
        publicationId,
      ),
      created_at: publication.created_at,
      actor: serviceActor(),
      run_id: runId,
      publication_id: publicationId,
      superseded_run_id: supersededRunId,
      superseded_publication_id: supersededPublicationId,
      reason,
    };
    await this.append(record);
    return record;
  }

  async reserveJobActions(
    runId: string,
    reservations: readonly JobBudgetReservation[],
  ): Promise<boolean> {
    await this.reconcileTerminalJobReservations(runId);
    const operation = this.budgetQueue.then(() =>
      this.reserveJobActionsSerialized(runId, reservations),
    );
    this.budgetQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async reserveJobActionsSerialized(
    runId: string,
    reservations: readonly JobBudgetReservation[],
  ): Promise<boolean> {
    const pending: Array<JobBudgetReservation & { recordId: string }> = [];
    for (const reservation of reservations) {
      if (reservation.amount_microusd <= 0) continue;
      const recordId = deterministicId(
        "budget",
        runId,
        reservation.category,
        String(reservation.generation),
      );
      const existing = await this.projection.budget(recordId);
      if (existing) {
        if (
          existing.run_id !== runId ||
          existing.event_kind !== "reserve" ||
          existing.amount_microusd !== reservation.amount_microusd
        )
          throw new IdempotencyConflictError(
            "Job budget reservation conflicts with durable state",
          );
        const releaseId = deterministicId("budget", runId, "job-release", recordId);
        if (await this.projection.budget(releaseId)) return false;
        continue;
      }
      pending.push({ ...reservation, recordId });
    }
    if (pending.length === 0) return true;

    const run = await this.projection.run(runId);
    if (!run) throw new PolicyError("run does not exist");
    const additionalMicrousd = pending.reduce(
      (sum, reservation) => sum + reservation.amount_microusd,
      0,
    );
    const committedMicrousd = Math.max(run.reserved_microusd, run.observed_microusd);
    if (committedMicrousd + additionalMicrousd > run.ceiling_microusd) return false;

    const observedOverage = Math.max(0, run.observed_microusd - run.reserved_microusd);
    if (observedOverage > 0) {
      await this.append({
        schema_version: "v1",
        kind: "budget.event",
        record_id: deterministicId(
          "budget",
          runId,
          "job-observed-overage",
          pending.map((reservation) => reservation.recordId).join(","),
        ),
        created_at: pending[0]?.created_at ?? this.clock.now().toISOString(),
        actor: serviceActor(),
        run_id: runId,
        event_kind: "reserve",
        amount_microusd: observedOverage,
      });
    }
    for (const reservation of pending) {
      await this.append({
        schema_version: "v1",
        kind: "budget.event",
        record_id: reservation.recordId,
        created_at: reservation.created_at,
        actor: serviceActor(),
        run_id: runId,
        event_kind: "reserve",
        amount_microusd: reservation.amount_microusd,
      });
    }
    return true;
  }

  private async releaseBudgetReservationSerialized(
    runId: string,
    reserveId: string,
    createdAt: string,
    amountMicrousd: number,
  ): Promise<boolean> {
    const existingReserve = await this.projection.budget(reserveId);
    if (!existingReserve) return false;
    if (
      existingReserve.run_id !== runId ||
      existingReserve.event_kind !== "reserve" ||
      existingReserve.amount_microusd !== amountMicrousd
    )
      throw new IdempotencyConflictError(
        "Job budget release does not match its reservation",
      );
    const releaseId = deterministicId("budget", runId, "job-release", reserveId);
    const existingRelease = await this.projection.budget(releaseId);
    if (existingRelease) {
      if (
        existingRelease.event_kind !== "release" ||
        existingRelease.amount_microusd !== amountMicrousd
      )
        throw new IdempotencyConflictError(
          "Job budget release conflicts with durable state",
        );
      return false;
    }
    await this.append({
      schema_version: "v1",
      kind: "budget.event",
      record_id: releaseId,
      created_at: createdAt,
      actor: serviceActor(),
      run_id: runId,
      event_kind: "release",
      amount_microusd: amountMicrousd,
    });
    return true;
  }

  private async releaseJobActionSerialized(
    intent: ActionIntent,
    createdAt: string,
  ): Promise<boolean> {
    if (intent.action_kind !== "job.launch") return false;
    const amountMicrousd = intent.payload.reservation_microusd;
    if (typeof amountMicrousd !== "number" || amountMicrousd <= 0) return false;
    const priorAttemptId = intent.payload.prior_attempt_id;
    const reserveId =
      typeof priorAttemptId === "string"
        ? deterministicId("budget", intent.run_id, "replacement", priorAttemptId)
        : deterministicId(
            "budget",
            intent.run_id,
            intent.payload.worker_role === "preparation"
              ? "preparation"
              : executionReservationCategory(
                  stringArrayValue(intent.payload.task_ids, "Job action task IDs"),
                ),
            String(intent.generation),
          );
    return this.releaseBudgetReservationSerialized(
      intent.run_id,
      reserveId,
      createdAt,
      amountMicrousd,
    );
  }

  async releaseJobActions(
    runId: string,
    reservations: readonly JobBudgetReservation[],
  ): Promise<void> {
    const operation = this.budgetQueue.then(async () => {
      for (const reservation of reservations) {
        if (reservation.amount_microusd <= 0) continue;
        const reserveId = deterministicId(
          "budget",
          runId,
          reservation.category,
          String(reservation.generation),
        );
        await this.releaseBudgetReservationSerialized(
          runId,
          reserveId,
          reservation.created_at,
          reservation.amount_microusd,
        );
      }
    });
    this.budgetQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async releaseJobAction(intent: ActionIntent, createdAt: string): Promise<void> {
    const operation = this.budgetQueue.then(() =>
      this.releaseJobActionSerialized(intent, createdAt),
    );
    this.budgetQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async reconcileTerminalJobReservations(runId: string): Promise<number> {
    const operation = this.budgetQueue.then(async () => {
      const actions = await this.projection.runActions(runId);
      const terminalReceipts = new Map<string, ActionReceipt>();
      for (const action of actions) {
        if (
          !["job.observe", "job.cancel"].includes(action.action_kind) ||
          action.receipt_body === null
        )
          continue;
        const intent = JSON.parse(action.intent_body) as ActionIntent;
        const receipt = JSON.parse(action.receipt_body) as ActionReceipt;
        const launchActionId = intent.payload.launch_action_id;
        if (
          typeof launchActionId === "string" &&
          jobStateIsTerminal(receipt.observed_state) &&
          !terminalReceipts.has(launchActionId)
        )
          terminalReceipts.set(launchActionId, receipt);
      }

      let released = 0;
      for (const action of actions) {
        if (action.action_kind !== "job.launch") continue;
        const intent = JSON.parse(action.intent_body) as ActionIntent;
        const receipt =
          action.receipt_body === null
            ? null
            : (JSON.parse(action.receipt_body) as ActionReceipt);
        const terminalReceipt =
          receipt &&
          (receipt.outcome === "failed" ||
            receipt.observed_state.startsWith("suppressed-"))
            ? receipt
            : terminalReceipts.get(action.action_id);
        if (!terminalReceipt) continue;
        const budgetReleased = await this.releaseJobActionSerialized(
          intent,
          terminalReceipt.created_at,
        );
        const capacityReleased = await this.releaseJobCapacity(
          action.action_id,
          terminalReceipt,
          receipt?.observed_state.startsWith("suppressed-")
            ? "launch_suppressed"
            : receipt?.outcome === "failed"
              ? "launch_failed"
              : "job_terminal",
        );
        if (budgetReleased || capacityReleased) released += 1;
      }

      return released;
    });
    this.budgetQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async reserveReplacement(
    runId: string,
    priorAttemptId: string,
    priorAttemptCompletedAt: string,
    amountMicrousd: number,
  ): Promise<boolean> {
    await this.reconcileTerminalJobReservations(runId);
    const operation = this.budgetQueue.then(() =>
      this.reserveReplacementSerialized(
        runId,
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
    runId: string,
    priorAttemptId: string,
    priorAttemptCompletedAt: string,
    amountMicrousd: number,
  ): Promise<boolean> {
    if (amountMicrousd <= 0) return true;
    const recordId = deterministicId("budget", runId, "replacement", priorAttemptId);
    const existing = await this.projection.budget(recordId);
    if (existing) {
      if (
        existing.run_id !== runId ||
        existing.event_kind !== "reserve" ||
        existing.amount_microusd !== amountMicrousd
      )
        throw new IdempotencyConflictError(
          "replacement budget reservation conflicts with durable state",
        );
      const releaseId = deterministicId("budget", runId, "job-release", recordId);
      if (await this.projection.budget(releaseId)) return false;
      return true;
    }
    const run = await this.projection.run(runId);
    if (!run) throw new PolicyError("run does not exist");
    const committedMicrousd = Math.max(run.reserved_microusd, run.observed_microusd);
    if (committedMicrousd + amountMicrousd > run.ceiling_microusd) return false;
    const observedOverage = Math.max(0, run.observed_microusd - run.reserved_microusd);
    if (observedOverage > 0) {
      const catchUp: BudgetEvent = {
        schema_version: "v1",
        kind: "budget.event",
        record_id: deterministicId("budget", runId, "observed-overage", priorAttemptId),
        created_at: priorAttemptCompletedAt,
        actor: serviceActor(),
        run_id: runId,
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
      run_id: runId,
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

  /**
   * Serialize admission decisions that can create intents for one Run.
   *
   * The immutable append queue protects individual records. This queue also
   * keeps each read-check-write admission atomic with respect to other Run
   * mutations, including reconciler-generated publication.
   */
  async withRunMutationAdmission<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.runMutationQueues.get(runId) ?? Promise.resolve();
    const queued = previous.then(async () => {
      const lock = await this.projection.runLock(runId);
      if (lock) await this.runExecution(lock);
      return operation();
    });
    const settled = queued.then(
      () => undefined,
      () => undefined,
    );
    this.runMutationQueues.set(runId, settled);
    void settled.then(() => {
      if (this.runMutationQueues.get(runId) === settled)
        this.runMutationQueues.delete(runId);
    });
    return queued;
  }

  private selectedInfrastructureAttempt(detail: {
    task: { selected_attempt_id: string | null; terminal_outcome: string | null };
    attempts: ReadonlyArray<{
      action_id: string;
      attempt_id: string;
      outcome: string;
      replacement_eligible: number;
      created_at: string;
    }>;
  }): (typeof detail.attempts)[number] | null {
    if (!infrastructureSealReplaceable(detail.task.terminal_outcome)) return null;
    const selected = detail.attempts.find(
      (attempt) => attempt.attempt_id === detail.task.selected_attempt_id,
    );
    const prior = selected ?? detail.attempts.at(-1);
    if (prior?.outcome !== "infrastructure" || prior.replacement_eligible !== 1)
      return null;
    return prior;
  }

  private launchStillRunning(
    launch: {
      action_id: string;
      receipt_body: string | null;
      observed_state: string | null;
    },
    actions: ReadonlyArray<{
      action_id: string;
      action_kind: string;
      intent_body: string;
      receipt_body: string | null;
      observed_state: string | null;
    }>,
  ): boolean {
    if (launch.receipt_body === null) return true;
    if (jobStateIsTerminal(launch.observed_state)) return false;
    const receipt = JSON.parse(launch.receipt_body) as ActionReceipt;
    if (receipt.outcome === "failed") return false;
    return !actions.some((action) => {
      if (action.action_kind !== "job.observe" || action.receipt_body === null)
        return false;
      const intent = JSON.parse(action.intent_body) as ActionIntent;
      return (
        intent.payload.launch_action_id === launch.action_id &&
        jobStateIsTerminal(action.observed_state)
      );
    });
  }

  async laterExecutionLaunchExists(
    runId: string,
    taskId: string,
    sourceActionId: string,
  ): Promise<boolean> {
    const detail = await this.projection.task(runId, taskId);
    const actions = await this.projection.runActions(runId);
    for (const action of actions) {
      if (action.action_kind !== "job.launch" || action.action_id === sourceActionId)
        continue;
      if (action.observed_state?.startsWith("suppressed-")) continue;
      const intent = JSON.parse(action.intent_body) as ActionIntent;
      if (intent.payload.worker_role === "preparation") continue;
      if (
        !Array.isArray(intent.payload.task_ids) ||
        !intent.payload.task_ids.includes(taskId)
      )
        continue;
      if (this.launchStillRunning(action, actions)) return true;
      const selected = detail?.task.selected_attempt_id;
      if (
        selected &&
        detail.attempts.some(
          (attempt) =>
            attempt.action_id === action.action_id && attempt.attempt_id === selected,
        )
      )
        return true;
    }
    return false;
  }

  private async queueEligibleInfrastructureRetries(
    runId: string,
    lock: RunLock,
    input: RunActionV1,
    generation: number,
    actor: Actor,
    idempotency: RunActionIdempotency,
  ): Promise<SubmissionResult> {
    const parent = this.actionIntent(
      runId,
      "run.retry-infrastructure",
      "run",
      generation,
      {
        idempotency_key_digest: idempotency.key_digest,
        idempotency_payload_digest: idempotency.payload_digest,
      },
      actor,
    );
    const policy = this.resolvedProfile<LaunchPolicySpec>(lock, "launch_policy");
    const eligible: Array<{
      taskId: string;
      attemptId: string;
    }> = [];
    for (const task of await this.projection.tasks(runId)) {
      const detail = await this.projection.task(runId, task.task_id);
      if (!detail) continue;
      const prior = this.selectedInfrastructureAttempt(detail);
      if (
        !prior ||
        (await this.projection.retryActionForAttempt(runId, prior.attempt_id)) ||
        (await this.laterExecutionLaunchExists(runId, task.task_id, prior.action_id))
      )
        continue;
      const sourceRow = await this.projection.action(prior.action_id);
      if (sourceRow?.action_kind !== "job.launch")
        throw new PolicyError("infrastructure attempt has no physical Job launch");
      eligible.push({
        taskId: task.task_id,
        attemptId: prior.attempt_id,
      });
    }
    if (eligible.length === 0)
      throw new PolicyError("no eligible infrastructure failures");
    const [first, ...remaining] = eligible;
    if (!first) throw new PolicyError("no eligible infrastructure failures");
    const command = {
      ...parent,
      payload: {
        task_ids: [first.taskId, ...remaining.map((item) => item.taskId)],
        prior_attempt_ids: [
          first.attemptId,
          ...remaining.map((item) => item.attemptId),
        ],
        reason: input.reason ?? null,
        reservation_microusd: policy.reservation_microusd,
        idempotency_key_digest: idempotency.key_digest,
        idempotency_payload_digest: idempotency.payload_digest,
      },
    } satisfies ActionIntent;
    await this.writeAction(command);
    return {
      run_id: runId,
      action_id: deterministicId(
        "action",
        runId,
        "job.launch",
        first.taskId,
        String(generation),
      ),
      status_url: `/api/v1/runs/${runId}`,
      adopted: false,
    };
  }

  async materializeInfrastructureRetryCommand(
    command: ActionIntent,
  ): Promise<{ actionIds: string[]; complete: boolean }> {
    if (command.action_kind !== "run.retry-infrastructure")
      throw new PolicyError("bulk retry materialization requires its parent command");
    const taskIds = stringArrayValue(command.payload.task_ids, "bulk retry task IDs");
    const attemptIds = stringArrayValue(
      command.payload.prior_attempt_ids,
      "bulk retry prior attempt IDs",
    );
    if (taskIds.length === 0 || taskIds.length !== attemptIds.length)
      throw new PolicyError("bulk retry command assignments are invalid");
    const reservation = command.payload.reservation_microusd;
    if (typeof reservation !== "number")
      throw new PolicyError("bulk retry command has no reservation");
    const actionIds: string[] = [];
    for (const [index, taskId] of taskIds.entries()) {
      const attemptId = attemptIds[index];
      if (!attemptId) throw new PolicyError("bulk retry prior attempt is missing");
      const attemptRow = await this.projection.attemptById(attemptId);
      if (!attemptRow)
        throw new PolicyError(`bulk retry attempt does not exist: ${attemptId}`);
      const attempt = JSON.parse(attemptRow.body) as AttemptReceipt;
      if (
        attempt.run_id !== command.run_id ||
        attempt.task_id !== taskId ||
        attempt.outcome !== "infrastructure" ||
        !attempt.replacement_eligible
      )
        throw new PolicyError(`bulk retry attempt is ineligible: ${attemptId}`);
      const sourceRow = await this.projection.action(attempt.action_id);
      if (sourceRow?.action_kind !== "job.launch")
        throw new PolicyError("bulk retry attempt has no physical Job launch");
      const source = JSON.parse(sourceRow.intent_body) as ActionIntent;
      const child = this.actionIntent(
        command.run_id,
        "job.launch",
        taskId,
        command.generation,
        {
          ...withoutRunActionIdempotency(source.payload),
          task_id: taskId,
          task_ids: [taskId],
          prior_attempt_id: attemptId,
          reason: command.payload.reason ?? null,
        },
        command.actor,
        command.created_at,
      );
      actionIds.push(child.action_id);
      if (
        !(await this.reserveReplacement(
          command.run_id,
          attemptId,
          attempt.created_at,
          reservation,
        ))
      )
        return { actionIds, complete: false };
      await this.writeAction(child);
    }
    return { actionIds, complete: true };
  }

  async runAction(
    runId: string,
    raw: unknown,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<SubmissionResult> {
    this.assertReady();
    const input = validateRunAction<RunActionV1>(raw);
    if (!input.confirmed)
      throw new ConfirmationRequiredError("run action requires explicit confirmation");
    return this.withRunMutationAdmission(runId, () => {
      const operation = () =>
        this.runActionValidated(runId, input, idempotencyKey, actor);
      return input.action === "retry_infrastructure"
        ? this.withInfrastructureRetryAdmission(operation)
        : operation();
    });
  }

  private async adoptRunAction(
    runId: string,
    input: RunActionV1,
    idempotency: RunActionIdempotency,
    actor: Actor,
  ): Promise<SubmissionResult | null> {
    const actions = await this.projection.runActions(runId);
    const candidates = actions.filter((action) => {
      const intent = JSON.parse(action.intent_body) as ActionIntent;
      return intent.payload.idempotency_key_digest === idempotency.key_digest;
    });
    if (candidates.length > 1)
      throw new IdempotencyConflictError(
        "idempotency key has multiple durable Run actions",
      );
    const candidate = candidates[0];
    if (!candidate) return null;

    const recorded = JSON.parse(candidate.intent_body) as ActionIntent;
    const sameActor = canonicalJson(recorded.actor) === canonicalJson(actor);
    const sameRequest =
      recorded.payload.idempotency_payload_digest === idempotency.payload_digest;
    const sameReason = recorded.payload.reason === (input.reason ?? null);
    const expectedKinds: Record<RunActionV1["action"], ActionIntent["action_kind"]> = {
      cancel: "run.cancel",
      retry_infrastructure: input.task_id ? "job.launch" : "run.retry-infrastructure",
      publish: "publication.publish",
      pause_endpoint: "endpoint.pause",
      pause: "run.pause",
      resume: "run.resume",
      supersede: "publication.supersede",
    };
    const actionTypeMatches = candidate.action_kind === expectedKinds[input.action];
    let payloadMatches = actionTypeMatches && sameReason;
    if (input.action === "cancel")
      payloadMatches =
        payloadMatches && recorded.payload.task_id === (input.task_id ?? null);
    else if (input.action === "retry_infrastructure")
      payloadMatches =
        payloadMatches &&
        (input.task_id
          ? recorded.payload.task_id === input.task_id
          : Array.isArray(recorded.payload.task_ids) &&
            recorded.payload.task_ids.length > 0);
    else if (input.action === "resume")
      payloadMatches =
        payloadMatches &&
        (recorded.payload.task_limit ?? null) === (input.task_limit ?? null);
    else if (input.action === "supersede")
      payloadMatches =
        payloadMatches && recorded.payload.publication_id === input.publication_id;
    else if (input.action === "publish" || input.action === "pause_endpoint")
      payloadMatches = actionTypeMatches;

    if (!sameActor || !sameRequest || !payloadMatches)
      throw new IdempotencyConflictError(
        `idempotency key belongs to a different ${input.action} action`,
      );

    let actionId = candidate.action_id;
    if (input.action === "retry_infrastructure" && !input.task_id) {
      const taskIds = stringArrayValue(
        recorded.payload.task_ids,
        "bulk retry task IDs",
      );
      const firstTaskId = taskIds[0];
      if (!firstTaskId)
        throw new IdempotencyConflictError("bulk retry command has no tasks");
      actionId = deterministicId(
        "action",
        runId,
        "job.launch",
        firstTaskId,
        String(candidate.generation),
      );
    }
    return {
      run_id: runId,
      action_id: actionId,
      status_url: `/api/v1/runs/${runId}`,
      adopted: true,
    };
  }

  private async runActionGeneration(runId: string, keyDigest: string): Promise<number> {
    const initial = Number.parseInt(keyDigest.slice(-8), 16) % 1_000_001;
    const used = new Set(
      (await this.projection.runActions(runId)).map((action) => action.generation),
    );
    for (let offset = 0; offset <= 1_000_000; offset += 1) {
      const generation = (initial + offset) % 1_000_001;
      if (!used.has(generation)) return generation;
    }
    throw new PolicyError("Run action generation space is exhausted");
  }

  private async runActionValidated(
    runId: string,
    input: RunActionV1,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<SubmissionResult> {
    const run = await this.projection.run(runId);
    if (!run) throw new PolicyError("run does not exist");
    const lock = await this.projection.runLock(runId);
    if (!lock) throw new PolicyError("run lock does not exist");
    const execution = await this.runExecution(lock);
    if (!idempotencyKey || idempotencyKey.length > 256)
      throw new IdempotencyConflictError("a bounded idempotency key is required");
    const idempotency = {
      key_digest: sha256(idempotencyKey),
      payload_digest: sha256(canonicalJson(input)),
    };
    const existingAction = await this.adoptRunAction(runId, input, idempotency, actor);
    if (existingAction) return existingAction;
    const generation = await this.runActionGeneration(runId, idempotency.key_digest);
    let kind: ActionIntent["action_kind"];
    let target = input.task_id ?? "run";
    let payload: ActionIntent["payload"];
    let retryReservation: {
      attemptId: string;
      completedAt: string;
      amountMicrousd: number;
    } | null = null;
    if (input.action === "cancel") {
      if (runStatusIsTerminal(run.status))
        throw new PolicyError("terminal run cannot be cancelled");
      if (
        run.status === "publishing" ||
        (await this.projection.runActions(runId)).some((action) =>
          action.action_kind.startsWith("publication."),
        )
      )
        throw new PolicyError("run cannot be cancelled after publication starts");
      if (input.task_id) {
        const task = await this.projection.task(runId, input.task_id);
        if (!task) throw new PolicyError("cancellation task does not exist");
        if (task.task.terminal_outcome)
          throw new PolicyError("terminal task cannot be cancelled");
      }
      kind = "run.cancel";
      payload = { task_id: input.task_id ?? null, reason: input.reason ?? null };
    } else if (input.action === "pause") {
      if (runStatusIsTerminal(run.status))
        throw new PolicyError("terminal run cannot be paused");
      kind = "run.pause";
      payload = { reason: input.reason ?? null };
    } else if (input.action === "resume") {
      const historical = !isCurrentRunLock(lock);
      const repair = historical
        ? await this.projection.runContinuationRepair(runId)
        : null;
      const successor = historical
        ? await this.projection.runContinuationRepairSuccessor(runId)
        : null;
      if (!run.paused && !(historical && repair && run.status === "failed"))
        throw new PolicyError("run is not paused");
      if (run.pending_actions > 0)
        throw new PolicyError("run cannot resume while actions are pending");
      if (historical) await this.assertReusableHistoricalPreparation(lock, execution);
      await this.reconcileTerminalJobReservations(runId);
      const deployment = execution.deployment;
      const needsPreparation =
        preparationRequired(deployment) && !(await this.preparedJob(runId));
      const unresolvedTasks = (await this.projection.tasks(runId)).filter((task) =>
        historical ? historicalTaskNeedsSelection(task) : !task.terminal_outcome,
      );
      const unresolvedTaskIds = (
        input.task_limit ? unresolvedTasks.slice(0, input.task_limit) : unresolvedTasks
      ).map((task) => task.task_id);
      if (unresolvedTaskIds.length === 0)
        throw new PolicyError("run has no unresolved tasks to resume");
      const policy = this.resolvedProfile<LaunchPolicySpec>(lock, "launch_policy");
      const reservationCreatedAt = this.clock.now().toISOString();
      let reservations: JobBudgetReservation[];
      let launchGeneration: number | null = null;
      if (needsPreparation) {
        const preparationLaunches = (await this.projection.runActions(runId)).filter(
          (action) => {
            if (action.action_kind !== "job.launch") return false;
            const launch = JSON.parse(action.intent_body) as ActionIntent;
            return launch.payload.worker_role === "preparation";
          },
        );
        const preparationGeneration =
          preparationLaunches.reduce(
            (maximum, action) => Math.max(maximum, action.generation),
            -1,
          ) + 1;
        reservations = [
          {
            category: "preparation",
            generation: preparationGeneration,
            created_at: reservationCreatedAt,
            amount_microusd: policy.preparation_reservation_microusd ?? 0,
          },
        ];
      } else {
        const continuation = historical
          ? await this.projection.runContinuation(runId)
          : null;
        if (historical && !continuation)
          throw new PolicyError(
            "historical run has no execution continuation attachment",
          );
        const freshTaskIds: string[] = [];
        for (const taskId of unresolvedTaskIds) {
          const detail = await this.projection.task(runId, taskId);
          if (
            detail?.task.terminal_outcome &&
            historicalTaskNeedsSelection(detail.task)
          ) {
            freshTaskIds.push(taskId);
            continue;
          }
          const latest = detail?.attempts.at(-1);
          if (!latest) {
            freshTaskIds.push(taskId);
            continue;
          }
          if (continuation) {
            const action = await this.projection.action(latest.action_id);
            const launch =
              action?.action_kind === "job.launch"
                ? (JSON.parse(action.intent_body) as ActionIntent)
                : null;
            if (
              launch?.payload.run_continuation_id !== continuation.record_id ||
              (repair &&
                launch.payload.run_continuation_repair_id !== repair.record_id) ||
              (successor &&
                launch.payload.run_continuation_repair_successor_id !==
                  successor.record_id)
            )
              freshTaskIds.push(taskId);
          }
        }
        const executionGeneration = historical
          ? await this.projection.nextExecutionLaunchGeneration(runId)
          : generation;
        launchGeneration = executionGeneration;
        reservations = freshTaskIds.map((taskId) => ({
          category: executionReservationCategory([taskId]),
          generation: executionGeneration,
          created_at: reservationCreatedAt,
          amount_microusd: policy.reservation_microusd,
        }));
      }
      const reserved = await this.reserveJobActions(runId, reservations);
      if (!reserved)
        throw new PolicyError("resumed execution would exceed the run ceiling");
      kind = "run.resume";
      payload = {
        ...(launchGeneration !== null ? { launch_generation: launchGeneration } : {}),
        reason: input.reason ?? null,
        ...(input.task_limit ? { task_limit: input.task_limit } : {}),
        task_ids: unresolvedTaskIds,
      };
    } else if (input.action === "publish") {
      if (run.budget_exceeded)
        throw new PolicyError("run cannot publish after exceeding its budget");
      if (
        run.terminal_tasks !== run.total_tasks ||
        run.admissible_tasks !== run.total_tasks ||
        run.exhausted_tasks > 0
      )
        throw new PolicyError(
          "run cannot publish before every task has an admissible selection",
        );
      if (run.pending_actions > 0 || run.cleanup_pending)
        throw new PolicyError(
          "run cannot publish while actions or endpoint cleanup are pending",
        );
      if (await this.projection.runPublication(runId))
        throw new PolicyError("run is already published");
      kind = "publication.publish";
      target = "results";
      payload = {};
    } else if (input.action === "supersede") {
      if (!input.publication_id)
        throw new PolicyError("supersession requires the old publication ID");
      const current = await this.projection.runPublication(runId);
      if (current?.status !== "published")
        throw new PolicyError("replacement run is not published");
      const previous = await this.projection.publication(input.publication_id);
      if (previous?.status !== "published")
        throw new PolicyError("superseded publication does not exist");
      if (await this.projection.publicationSupersession(input.publication_id))
        throw new PolicyError("publication is already superseded");
      if (previous.run_id === runId)
        throw new PolicyError("publication cannot supersede itself");
      kind = "publication.supersede";
      target = input.publication_id;
      payload = {
        publication_id: input.publication_id,
        reason: input.reason ?? null,
      };
    } else if (input.action === "pause_endpoint") {
      const endpoints = (await this.projection.endpoints()).filter(
        (endpoint) => endpoint.run_id === runId && !endpoint.cleanup_verified,
      );
      if (endpoints.length !== 1)
        throw new PolicyError(
          `expected one active run endpoint, found ${endpoints.length}`,
        );
      const endpoint = endpoints[0];
      if (!endpoint) throw new PolicyError("active endpoint disappeared");
      kind = "endpoint.pause";
      target = endpoint.endpoint_id;
      payload = { endpoint_id: endpoint.endpoint_id };
    } else {
      if (!isCurrentRunLock(lock))
        throw new PolicyError(
          "historical continuation cannot retry a selected infrastructure outcome",
        );
      if (!input.task_id)
        return this.queueEligibleInfrastructureRetries(
          runId,
          lock,
          input,
          generation,
          actor,
          idempotency,
        );
      const task = await this.projection.task(runId, input.task_id);
      if (!task) throw new PolicyError("retry task does not exist");
      if (!infrastructureSealReplaceable(task.task.terminal_outcome))
        throw new PolicyError("terminal tasks cannot be retried");
      const priorAttempt = this.selectedInfrastructureAttempt(task);
      if (!priorAttempt)
        throw new PolicyError(
          "infrastructure retry requires an eligible infrastructure failure",
        );
      const existingRetry = await this.projection.retryActionForAttempt(
        runId,
        priorAttempt.attempt_id,
      );
      if (
        existingRetry ||
        (await this.laterExecutionLaunchExists(
          runId,
          input.task_id,
          priorAttempt.action_id,
        ))
      )
        throw new PolicyError("infrastructure retry is already recorded");
      const deployment = execution.deployment;
      if (deployment.route !== "hf_job")
        throw new PolicyError("imported deployment profiles cannot launch retries");
      const policy = this.resolvedProfile<LaunchPolicySpec>(lock, "launch_policy");
      retryReservation = {
        attemptId: priorAttempt.attempt_id,
        completedAt: priorAttempt.created_at,
        amountMicrousd: policy.reservation_microusd,
      };
      const sourceRow = await this.projection.action(priorAttempt.action_id);
      if (sourceRow?.action_kind !== "job.launch")
        throw new PolicyError("infrastructure attempt has no physical Job launch");
      const source = JSON.parse(sourceRow.intent_body) as ActionIntent;
      kind = "job.launch";
      payload = {
        ...withoutRunActionIdempotency(source.payload),
        task_id: input.task_id,
        task_ids: [input.task_id],
        reason: input.reason ?? null,
        prior_attempt_id: priorAttempt.attempt_id,
      };
    }
    payload = {
      ...payload,
      idempotency_key_digest: idempotency.key_digest,
      idempotency_payload_digest: idempotency.payload_digest,
    };
    if (
      retryReservation &&
      !(await this.reserveReplacement(
        runId,
        retryReservation.attemptId,
        retryReservation.completedAt,
        retryReservation.amountMicrousd,
      ))
    )
      throw new PolicyError("replacement Job would exceed the run ceiling");
    let actionTimestamp = this.clock.now().toISOString();
    if (kind === "run.pause" || kind === "run.resume") {
      const latestLifecycle = (await this.projection.runActions(runId)).find(
        (action) =>
          action.action_kind === "run.pause" || action.action_kind === "run.resume",
      );
      if (
        latestLifecycle &&
        Date.parse(latestLifecycle.created_at) >= Date.parse(actionTimestamp)
      )
        actionTimestamp = new Date(
          Date.parse(latestLifecycle.created_at) + 1,
        ).toISOString();
    }
    const intent = this.actionIntent(
      runId,
      kind,
      target,
      generation,
      payload,
      actor,
      actionTimestamp,
    );
    const adopted = Boolean(await this.projection.action(intent.action_id));
    await this.writeAction(intent);
    return {
      run_id: runId,
      action_id: intent.action_id,
      status_url: `/api/v1/runs/${runId}`,
      adopted,
    };
  }

  async admitAutomaticPublication(runId: string): Promise<boolean> {
    return this.withRunMutationAdmission(runId, async () => {
      const run = await this.projection.run(runId);
      if (
        !run ||
        run.total_tasks === 0 ||
        run.terminal_tasks !== run.total_tasks ||
        run.admissible_tasks !== run.total_tasks ||
        run.exhausted_tasks > 0 ||
        run.pending_actions > 0 ||
        run.cleanup_pending ||
        run.budget_exceeded ||
        run.cancellation_requested
      )
        return false;
      if (await this.projection.runPublication(runId)) return false;
      if (await this.projection.hasRunAction(runId, "run.cancel")) return false;
      if (await this.projection.hasRunAction(runId, "publication.publish"))
        return false;
      await this.writeAction(
        this.actionIntent(runId, "publication.publish", "results", 0, {}),
      );
      return true;
    });
  }

  resolvedProfile<T>(lock: RunLock, kind: ResolvedProfile["kind"]): T {
    return profileSpec<T>(lock.profiles, kind);
  }

  static recordDigest(record: HarborHFControlRecordV1): string {
    return sha256(canonicalJson(record));
  }
}

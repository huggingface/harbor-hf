import type { ActionIntent } from "@harbor-hf/contracts";
import {
  AmbiguousExternalActionError,
  type ExternalActionContext,
  ExternalActionNotFoundError,
  type ExternalActionPort,
  type ExternalActionResult,
  mintWorkerCapability,
} from "@harbor-hf/control-core";
import {
  cancelJob as cancelHfJob,
  getJob,
  listJobs,
  runJob,
  type SpaceHardwareFlavor,
} from "@huggingface/hub";
import { jobHardwareCostMicrousd } from "./job-cost.js";

const JOB_LIST_CACHE_MS = 5_000;
const ACTIVE_JOB_STATES = ["RUNNING", "SCHEDULING"] as const;
const MIRROR_REPOSITORY =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

interface AdapterConfig {
  namespace: string;
  accessToken: string;
  taskImageMirrorRepository: string;
  inferenceToken?: string;
  controlUrl?: string;
  hubUrl?: string;
  endpointsUrl?: string;
}

function stringValue(intent: ActionIntent, key: keyof ActionIntent["payload"]): string {
  const value = intent.payload[key];
  if (typeof value !== "string")
    throw new Error(`action payload ${key} must be a string`);
  return value;
}

function numberValue(intent: ActionIntent, key: keyof ActionIntent["payload"]): number {
  const value = intent.payload[key];
  if (typeof value !== "number")
    throw new Error(`action payload ${key} must be a number`);
  return value;
}

function booleanValue(
  intent: ActionIntent,
  key: keyof ActionIntent["payload"],
  fallback = false,
): boolean {
  const value = intent.payload[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new Error(`action payload ${key} must be a boolean`);
  return value;
}

function stringValues(
  intent: ActionIntent,
  key: keyof ActionIntent["payload"],
): string[] {
  const value = intent.payload[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`action payload ${key} must be an array of strings`);
  return value;
}

function workerRole(intent: ActionIntent): "preparation" | "execution" {
  const value = intent.payload.worker_role ?? "execution";
  if (value !== "preparation" && value !== "execution")
    throw new Error("action payload worker_role is invalid");
  return value;
}

function requiresInference(intent: ActionIntent): boolean {
  return (
    workerRole(intent) === "execution" &&
    typeof intent.payload.inference_upstream === "string"
  );
}

function usesCompatibilityBridge(intent: ActionIntent): boolean {
  const value = intent.payload.inference_token;
  if (value !== undefined && value !== "forbidden" && value !== "required")
    throw new Error("action payload inference_token is invalid");
  return value === "required";
}

type ApiJob = Awaited<ReturnType<typeof getJob>>;

interface ExpectedJobSpec {
  dockerImage: string;
  command: string[];
  flavor: string;
  arch: "amd64";
  timeoutSeconds: number;
  labels: Record<string, string>;
  environment: Record<string, string>;
  secretNames: string[];
}

function launchActionId(intent: ActionIntent): string {
  return intent.action_kind === "job.launch"
    ? intent.action_id
    : stringValue(intent, "launch_action_id");
}

function jobEnvironment(
  intent: ActionIntent,
  controlUrl: string,
  taskImageMirrorRepository: string,
): Record<string, string> {
  const role = workerRole(intent);
  const taskIds = stringValues(intent, "task_ids");
  const jobImage = stringValue(intent, "job_image");
  const taskImage =
    typeof intent.payload.task_image === "string"
      ? intent.payload.task_image
      : undefined;
  const environment = {
    HARBOR_HF_RUN_ID: intent.run_id,
    HARBOR_HF_ACTION_ID: launchActionId(intent),
    HARBOR_HF_TASK_IDS_JSON: JSON.stringify(taskIds),
    HARBOR_HF_CONTROL_URL: controlUrl,
    HARBOR_HF_CONTROL_RETRY_TIMEOUT_SECONDS: String(
      numberValue(intent, "timeout_seconds"),
    ),
    HARBOR_HF_WORKER_ROLE: role,
    HARBOR_HF_JOB_IMAGE: jobImage,
    ...(taskImage
      ? {
          HARBOR_HF_TASK_IMAGE: taskImage,
          HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY: taskImageMirrorRepository,
        }
      : {}),
    HARBOR_HF_RUN_LOCK_DIGEST: stringValue(intent, "run_lock_digest"),
    PYTHONUNBUFFERED: "1",
    ...(typeof intent.payload.worker_revision === "string"
      ? { HARBOR_HF_WORKER_REVISION: intent.payload.worker_revision }
      : {}),
    ...(typeof intent.payload.run_continuation_repair_id === "string"
      ? {
          HARBOR_HF_RUN_CONTINUATION_REPAIR_ID:
            intent.payload.run_continuation_repair_id,
        }
      : {}),
    ...(typeof intent.payload.run_continuation_repair_successor_id === "string"
      ? {
          HARBOR_HF_RUN_CONTINUATION_REPAIR_SUCCESSOR_ID:
            intent.payload.run_continuation_repair_successor_id,
        }
      : {}),
    ...(typeof intent.payload.prepared_job_digest === "string"
      ? { HARBOR_HF_PREPARED_JOB_DIGEST: intent.payload.prepared_job_digest }
      : {}),
    ...(typeof intent.payload.max_image_bytes === "number"
      ? { HARBOR_HF_MAX_IMAGE_BYTES: String(intent.payload.max_image_bytes) }
      : {}),
    ...(typeof intent.payload.max_image_entries === "number"
      ? { HARBOR_HF_MAX_IMAGE_ENTRIES: String(intent.payload.max_image_entries) }
      : {}),
  };
  if (!usesCompatibilityBridge(intent)) return environment;
  return {
    ...environment,
    HARBOR_HF_INFERENCE_UPSTREAM: stringValue(intent, "inference_upstream"),
    HARBOR_HF_INFERENCE_ALLOWED_MODEL: stringValue(intent, "inference_model"),
    HARBOR_HF_INFERENCE_API: stringValue(intent, "inference_api"),
    HARBOR_HF_INFERENCE_MAX_REQUESTS: String(
      numberValue(intent, "inference_max_requests"),
    ),
    HARBOR_HF_INFERENCE_MAX_CONCURRENCY: String(
      numberValue(intent, "inference_max_concurrency"),
    ),
    HARBOR_HF_INFERENCE_TIMEOUT_SECONDS: String(
      numberValue(intent, "inference_timeout_seconds"),
    ),
    HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS: String(
      numberValue(intent, "inference_max_output_tokens"),
    ),
  };
}

function expectedJobSpec(
  intent: ActionIntent,
  controlUrl: string,
  taskImageMirrorRepository: string,
): ExpectedJobSpec {
  const actionId = launchActionId(intent);
  return {
    dockerImage: stringValue(intent, "job_image"),
    command: stringValues(intent, "job_command"),
    flavor: stringValue(intent, "hardware"),
    arch: "amd64",
    timeoutSeconds: numberValue(intent, "timeout_seconds"),
    labels: {
      harbor_hf_action_id: actionId,
      harbor_hf_run_id: intent.run_id,
      harbor_hf_worker_role: workerRole(intent),
    },
    environment: jobEnvironment(intent, controlUrl, taskImageMirrorRepository),
    secretNames: requiresInference(intent)
      ? ["HARBOR_HF_WORKER_CAPABILITY", "HF_INFERENCE_TOKEN"]
      : ["HARBOR_HF_WORKER_CAPABILITY"],
  };
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function recordsEqual(
  left: Record<string, string> | null | undefined,
  right: Record<string, string>,
): boolean {
  if (!left) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    arraysEqual(leftKeys, rightKeys) &&
    rightKeys.every((key) => left[key] === right[key])
  );
}

function normalizedJobNumber(
  sdkValue: unknown,
  stockValue: unknown,
  label: string,
): number {
  const values = [sdkValue, stockValue].filter(
    (value) => value !== undefined && value !== null,
  );
  if (
    values.length === 0 ||
    values.some((value) => typeof value !== "number" || !Number.isInteger(value))
  )
    throw new Error(`Job ${label} is not attested`);
  const value = values[0] as number;
  if (values.some((candidate) => candidate !== value))
    throw new Error(`Job ${label} fields disagree`);
  return value;
}

function normalizedJobAttempts(sdkValue: unknown, stockRetry: unknown): number {
  const stockAttempts =
    typeof stockRetry === "number" && Number.isInteger(stockRetry)
      ? stockRetry + 1
      : stockRetry;
  return normalizedJobNumber(sdkValue, stockAttempts, "attempt count");
}

function verifyNoJobIngress(job: ApiJob): void {
  const status = job.status as ApiJob["status"] & {
    exposeUrls?: unknown;
    sshUrl?: unknown;
  };
  if (status.sshUrl !== undefined && status.sshUrl !== null)
    throw new Error("Job SSH access is enabled");
  if (
    status.exposeUrls !== undefined &&
    status.exposeUrls !== null &&
    (!Array.isArray(status.exposeUrls) || status.exposeUrls.length !== 0)
  )
    throw new Error("Job exposes network ports");
}

function verifyJobSpec(
  intent: ActionIntent,
  job: ApiJob,
  controlUrl: string,
  taskImageMirrorRepository: string,
): void {
  const expected = expectedJobSpec(intent, controlUrl, taskImageMirrorRepository);
  const expectedEnvironment = { ...expected.environment };
  if (
    intent.action_kind === "job.observe" &&
    job.environment &&
    !Object.hasOwn(job.environment, "HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY")
  )
    // The launch receipt already attested older immutable Jobs created before
    // mirror routing existed. Observations still verify every field they carry.
    delete expectedEnvironment.HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY;
  const stockJob = job as ApiJob & {
    retry?: unknown;
    timeout?: unknown;
  };
  if (
    job.dockerImage !== expected.dockerImage ||
    !job.command ||
    !arraysEqual(job.command, expected.command) ||
    job.flavor !== expected.flavor ||
    job.arch !== expected.arch ||
    normalizedJobNumber(job.timeoutSeconds, stockJob.timeout, "timeout") !==
      expected.timeoutSeconds ||
    normalizedJobAttempts(job.attempts, stockJob.retry) !== 1 ||
    !recordsEqual(job.labels, expected.labels) ||
    !recordsEqual(job.environment, expectedEnvironment)
  )
    throw new Error("Job specification does not match the locked launch intent");
  if (job.spaceId !== undefined && job.spaceId !== null)
    throw new Error("Job unexpectedly uses a Space image");
  if (
    !job.secrets ||
    !arraysEqual([...job.secrets].sort(), [...expected.secretNames].sort())
  )
    throw new Error("Job secret names do not match the locked deployment");
  if (
    (job.arguments !== undefined &&
      job.arguments !== null &&
      job.arguments.length !== 0) ||
    (job.volumes !== undefined && job.volumes !== null && job.volumes.length !== 0)
  )
    throw new Error("Job arguments and volumes are not attested as empty");
  verifyNoJobIngress(job);
}

function cleanFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "remote action failed";
  if (/token|authorization|cookie|secret/i.test(message))
    return "remote_dependency_error";
  return "remote_dependency_error";
}

function jobStateIsTerminal(state: string): boolean {
  return ["STOPPED", "COMPLETED", "CANCELLED", "CANCELED", "ERROR"].includes(
    state.toUpperCase(),
  );
}

function payloadHourlyCost(intent: ActionIntent): number {
  const value = intent.payload.active_hourly_cost_microusd;
  if (value === undefined) return 0;
  if (typeof value !== "number")
    throw new Error("action payload active_hourly_cost_microusd must be a number");
  return value;
}

function endpointStatus(raw: unknown): {
  state: string;
  ready_replicas: number | null;
} {
  if (!raw || typeof raw !== "object")
    return { state: "UNKNOWN", ready_replicas: null };
  const root = raw as Record<string, unknown>;
  const status =
    root.status && typeof root.status === "object"
      ? (root.status as Record<string, unknown>)
      : {};
  const state =
    typeof status.state === "string"
      ? status.state
      : typeof root.state === "string"
        ? root.state
        : "UNKNOWN";
  const replicas =
    root.replicas && typeof root.replicas === "object"
      ? (root.replicas as Record<string, unknown>)
      : {};
  const ready =
    typeof replicas.ready === "number"
      ? replicas.ready
      : typeof status.readyReplica === "number"
        ? status.readyReplica
        : null;
  return { state, ready_replicas: ready };
}

function nextJobPage(link: string | null, hubUrl: string): string | null {
  const match = link?.match(/<([^>]+)>;\s*rel="next"/);
  if (!match?.[1]) return null;
  const next = new URL(match[1]);
  if (next.origin !== new URL(hubUrl).origin)
    throw new Error("Job pagination crossed the configured Hub origin");
  return next.toString();
}

export class HuggingFaceActions implements ExternalActionPort {
  private readonly endpointsUrl: string;
  private jobsSnapshot: readonly ApiJob[] | null = null;
  private jobsSnapshotExpiresAt = 0;
  private jobsSnapshotInFlight: Promise<readonly ApiJob[]> | null = null;

  constructor(private readonly config: AdapterConfig) {
    if (config.inferenceToken && config.inferenceToken === config.accessToken)
      throw new Error("control and inference credentials must be distinct");
    if (!MIRROR_REPOSITORY.test(config.taskImageMirrorRepository))
      throw new Error("task image mirror repository is invalid");
    this.endpointsUrl =
      config.endpointsUrl ?? "https://api.endpoints.huggingface.cloud/v2";
  }

  private verifyJobSpec(intent: ActionIntent, job: ApiJob): void {
    if (!this.config.controlUrl)
      throw new Error("Job verification requires the control service URL");
    verifyJobSpec(
      intent,
      job,
      this.config.controlUrl,
      this.config.taskImageMirrorRepository,
    );
  }

  private listJobsForAction(actionId: string): ReturnType<typeof listJobs> {
    return listJobs({
      namespace: this.config.namespace,
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
      fetch: (input, init) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        url.searchParams.append("label", `harbor_hf_action_id=${actionId}`);
        return fetch(url, init);
      },
    });
  }

  async observeJobs(
    intents: readonly ActionIntent[],
  ): Promise<readonly ExternalActionResult[]> {
    if (intents.length === 0) return [];
    if (!this.config.controlUrl)
      throw new Error("Job observation requires the control service URL");
    if (intents.some((intent) => intent.action_kind !== "job.observe"))
      throw new Error("Job observation batch contains a non-observation action");
    let jobs: readonly ApiJob[];
    try {
      jobs = await this.listJobsSnapshot();
    } catch (error) {
      return intents.map(() => ({
        outcome: "failed",
        observed_state: "ERROR",
        error_code: cleanFailure(error),
      }));
    }
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    return Promise.all(
      intents.map(async (intent) => {
        const remoteId = stringValue(intent, "resource_id");
        try {
          const job =
            jobsById.get(remoteId) ??
            (await getJob({
              namespace: this.config.namespace,
              jobId: remoteId,
              accessToken: this.config.accessToken,
              ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
            }));
          return this.jobObservation(intent, job);
        } catch (error) {
          return {
            outcome: "failed",
            observed_state: "ERROR",
            error_code: cleanFailure(error),
          };
        }
      }),
    );
  }

  private async listJobsSnapshot(): Promise<readonly ApiJob[]> {
    if (this.jobsSnapshot && Date.now() < this.jobsSnapshotExpiresAt)
      return this.jobsSnapshot;
    if (this.jobsSnapshotInFlight) return await this.jobsSnapshotInFlight;
    const operation = this.listActiveJobs();
    this.jobsSnapshotInFlight = operation;
    try {
      const jobs = await operation;
      this.jobsSnapshot = jobs;
      this.jobsSnapshotExpiresAt = Date.now() + JOB_LIST_CACHE_MS;
      return jobs;
    } finally {
      if (this.jobsSnapshotInFlight === operation) this.jobsSnapshotInFlight = null;
    }
  }

  private async listActiveJobs(): Promise<readonly ApiJob[]> {
    const hubUrl = this.config.hubUrl ?? "https://huggingface.co";
    const jobs: ApiJob[] = [];
    const seenPages = new Set<string>();
    let pageUrl: string | null = null;
    do {
      let followingPage: string | null = null;
      const page = await listJobs({
        namespace: this.config.namespace,
        accessToken: this.config.accessToken,
        ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
        fetch: async (input, init) => {
          const url = new URL(
            pageUrl ??
              (typeof input === "string" || input instanceof URL ? input : input.url),
          );
          if (!pageUrl)
            for (const state of ACTIVE_JOB_STATES)
              url.searchParams.append("stage", state);
          if (seenPages.has(url.toString()))
            throw new Error("Job pagination contains a cycle");
          seenPages.add(url.toString());
          const response = await fetch(url, init);
          followingPage = nextJobPage(response.headers.get("link"), hubUrl);
          return response;
        },
      });
      jobs.push(...page);
      pageUrl = followingPage;
    } while (pageUrl);
    return jobs;
  }

  async execute(
    intent: ActionIntent,
    context?: ExternalActionContext,
  ): Promise<ExternalActionResult> {
    try {
      switch (intent.action_kind) {
        case "run.admit":
          return { outcome: "completed", observed_state: "admitted" };
        case "job.launch":
          return await this.launchJob(intent, context);
        case "job.observe":
          return await this.observeJob(intent);
        case "job.cancel":
          return await this.cancelJob(intent);
        case "endpoint.pause":
          return await this.endpointMutation(intent, "pause");
        case "endpoint.resume":
          return await this.endpointMutation(intent, "resume");
        case "run.cancel":
        case "run.pause":
        case "run.resume":
        case "run.retry-infrastructure":
        case "publication.publish":
        case "publication.supersede":
          return { outcome: "completed", observed_state: "handled_locally" };
      }
    } catch (error) {
      if (
        error instanceof AmbiguousExternalActionError ||
        error instanceof ExternalActionNotFoundError
      )
        throw error;
      if (intent.action_kind === "job.launch" && context?.adoption_only)
        throw new AmbiguousExternalActionError("Job adoption check failed", {
          cause: error,
        });
      return {
        outcome: "failed",
        observed_state: intent.action_kind === "job.cancel" ? "UNKNOWN" : "ERROR",
        error_code: cleanFailure(error),
      };
    }
  }

  private async launchJob(
    intent: ActionIntent,
    context?: ExternalActionContext,
  ): Promise<ExternalActionResult> {
    const inferenceRequired = requiresInference(intent);
    const role = workerRole(intent);
    const taskIds = stringValues(intent, "task_ids");
    if (taskIds.length === 0)
      throw new Error("Job launch requires at least one assigned task");
    if (
      role === "execution" &&
      (taskIds.length !== 1 || intent.payload.task_id !== taskIds[0])
    )
      throw new Error("execution Job launch requires exactly one task");
    if (inferenceRequired && !this.config.inferenceToken)
      throw new Error("required worker inference credential is unavailable");
    if (!this.config.controlUrl)
      throw new Error("Job launch requires the control service URL");
    const spec = expectedJobSpec(
      intent,
      this.config.controlUrl,
      this.config.taskImageMirrorRepository,
    );
    const jobs = await this.listJobsForAction(intent.action_id);
    const matches = jobs.filter(
      (job) => job.labels?.harbor_hf_action_id === intent.action_id,
    );
    if (matches.length > 1)
      throw new AmbiguousExternalActionError(
        "multiple Jobs have the same deterministic action ID",
      );
    if (matches.length === 1) {
      const job = matches[0];
      if (!job) throw new Error("matching Job disappeared");
      try {
        this.verifyJobSpec(intent, job);
      } catch (error) {
        throw new AmbiguousExternalActionError(
          "adopted Job failed locked specification validation",
          { cause: error },
        );
      }
      return {
        outcome: "adopted",
        observed_state: job.status.stage,
        resource_id: job.id,
      };
    }
    if (context?.adoption_only)
      throw new ExternalActionNotFoundError(
        "no Job has the deterministic action label",
      );
    if (!booleanValue(intent, "trusted_worker"))
      throw new Error("Job launch requires a trusted worker profile");
    const timeoutSeconds = spec.timeoutSeconds;
    const capability = mintWorkerCapability(this.config.accessToken, {
      namespace: this.config.namespace,
      run_id: intent.run_id,
      run_lock_digest: stringValue(intent, "run_lock_digest"),
      action_id: intent.action_id,
      task_ids: taskIds,
      operations:
        role === "preparation"
          ? ["run.read", "preparation.submit"]
          : ["run.read", "attempt.submit", "evidence.write"],
      expires_at: Math.floor(Date.now() / 1000) + timeoutSeconds + 3_600,
    });
    const jobImage = spec.dockerImage;
    const taskImage =
      typeof intent.payload.task_image === "string"
        ? intent.payload.task_image
        : undefined;
    if (
      role === "execution" &&
      typeof intent.payload.prepared_job_digest === "string" &&
      !taskImage
    )
      throw new Error("prepared execution Job requires a locked task image");
    if (taskImage === jobImage)
      throw new Error("physical Job image cannot be the benchmark task image");
    let job: Awaited<ReturnType<typeof runJob>>;
    try {
      job = await runJob({
        namespace: this.config.namespace,
        accessToken: this.config.accessToken,
        ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
        dockerImage: spec.dockerImage,
        command: spec.command,
        arguments: [],
        flavor: spec.flavor as SpaceHardwareFlavor,
        arch: spec.arch,
        timeoutSeconds,
        attempts: 1,
        labels: spec.labels,
        environment: spec.environment,
        secrets: {
          HARBOR_HF_WORKER_CAPABILITY: capability,
          ...(inferenceRequired
            ? { HF_INFERENCE_TOKEN: this.config.inferenceToken as string }
            : {}),
        },
      });
      this.verifyJobSpec(intent, job);
    } catch (error) {
      throw new AmbiguousExternalActionError("Job launch outcome is ambiguous", {
        cause: error,
      });
    }
    return {
      outcome: "created",
      observed_state: job.status.stage,
      resource_id: job.id,
    };
  }

  private async observeJob(intent: ActionIntent): Promise<ExternalActionResult> {
    if (!this.config.controlUrl)
      throw new Error("Job observation requires the control service URL");
    const remoteId = stringValue(intent, "resource_id");
    const job = await getJob({
      namespace: this.config.namespace,
      jobId: remoteId,
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
    });
    return this.jobObservation(intent, job);
  }

  private jobObservation(intent: ActionIntent, job: ApiJob): ExternalActionResult {
    if (!this.config.controlUrl)
      throw new Error("Job observation requires the control service URL");
    this.verifyJobSpec(intent, job);
    const hourly = payloadHourlyCost(intent);
    return {
      outcome: "completed",
      observed_state: job.status.stage,
      resource_id: job.id,
      active_hourly_cost_microusd: hourly,
      cost_microusd: jobHardwareCostMicrousd(job, hourly),
    };
  }

  private async cancelJob(intent: ActionIntent): Promise<ExternalActionResult> {
    if (!this.config.controlUrl)
      throw new Error("Job cancellation requires the control service URL");
    const remoteId = stringValue(intent, "resource_id");
    const options = {
      namespace: this.config.namespace,
      jobId: remoteId,
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
    };
    const current = await getJob(options);
    this.verifyJobSpec(intent, current);
    let job: Awaited<ReturnType<typeof getJob>>;
    try {
      job = await cancelHfJob(options);
    } catch (error) {
      job = await getJob(options);
      this.verifyJobSpec(intent, job);
      if (!jobStateIsTerminal(job.status.stage)) {
        const hourly = payloadHourlyCost(intent);
        return {
          outcome: "failed",
          observed_state: job.status.stage,
          resource_id: job.id,
          error_code: cleanFailure(error),
          active_hourly_cost_microusd: hourly,
          cost_microusd: jobHardwareCostMicrousd(job, hourly),
        };
      }
    }
    this.verifyJobSpec(intent, job);
    const hourly = payloadHourlyCost(intent);
    return {
      outcome: "completed",
      observed_state: job.status.stage,
      resource_id: job.id,
      active_hourly_cost_microusd: hourly,
      cost_microusd: jobHardwareCostMicrousd(job, hourly),
    };
  }

  private async endpointMutation(
    intent: ActionIntent,
    operation: "pause" | "resume",
  ): Promise<ExternalActionResult> {
    const endpointId = stringValue(intent, "endpoint_id");
    if (operation === "resume" && !booleanValue(intent, "watchdog_verified"))
      throw new Error("endpoint resume requires a verified cleanup watchdog");
    const response = await fetch(
      `${this.endpointsUrl}/endpoint/${encodeURIComponent(this.config.namespace)}/${encodeURIComponent(endpointId)}/${operation}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      if (response.status !== 400)
        throw new Error(`endpoint ${operation} failed with ${response.status}`);
      const current = await this.getEndpoint(endpointId);
      const observed = endpointStatus(current);
      const alreadyDesired =
        operation === "pause"
          ? observed.state.toUpperCase().includes("PAUSED")
          : observed.state.toUpperCase().includes("RUNNING");
      if (!alreadyDesired)
        throw new Error(`endpoint ${operation} returned a non-idempotent conflict`);
      return {
        outcome: "adopted",
        observed_state: observed.state,
        resource_id: endpointId,
        ready_replicas: observed.ready_replicas,
      };
    }
    const raw = (await response.json()) as unknown;
    let observed = endpointStatus(raw);
    if (observed.ready_replicas === null)
      observed = endpointStatus(await this.getEndpoint(endpointId));
    return {
      outcome: "completed",
      observed_state: observed.state,
      resource_id: endpointId,
      ready_replicas: observed.ready_replicas,
    };
  }

  private async getEndpoint(endpointId: string): Promise<unknown> {
    const response = await fetch(
      `${this.endpointsUrl}/endpoint/${encodeURIComponent(this.config.namespace)}/${encodeURIComponent(endpointId)}`,
      {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`endpoint observation failed with ${response.status}`);
    return response.json() as Promise<unknown>;
  }
}

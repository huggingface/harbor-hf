import { assertRunId } from "@harbor-hf/contracts";
import type {
  JobObservation,
  JobRole,
  JobStage,
  JobsPort,
} from "@harbor-hf/control-core";
import {
  cancelJob,
  listJobs,
  runJob,
  type SpaceHardwareFlavor,
} from "@huggingface/hub";

export type ParentHardware = SpaceHardwareFlavor;
type ApiJob = Awaited<ReturnType<typeof runJob>>;

const ROLE_LABEL = "harbor-hf-role";
const RUN_LABEL = "harbor-hf-run";
const IMMUTABLE_IMAGE = /@sha256:[0-9a-f]{64}$/;

export interface ReadOnlyHuggingFaceJobsOptions {
  namespace: string;
  accessToken: string;
  hubUrl?: string;
  fetch?: typeof fetch;
}

export interface HuggingFaceJobsOptions extends ReadOnlyHuggingFaceJobsOptions {
  inferenceToken: string;
  bucketId: string;
  parentImage: string;
  hardware?: SpaceHardwareFlavor;
  mountRoot?: string;
  timeoutSeconds?: number;
}

function stage(value: string): JobStage {
  if (["RUNNING", "UPDATING", "SCHEDULING", "PENDING"].includes(value))
    return value === "PENDING" || value === "SCHEDULING" ? "queued" : "running";
  if (value === "ERROR") return "error";
  return "stopped";
}

function observation(value: ApiJob): JobObservation | null {
  const labels = value.labels;
  const runId = labels?.[RUN_LABEL];
  const role = labels?.[ROLE_LABEL];
  if (!runId || (role !== "parent" && role !== "trial")) return null;
  try {
    assertRunId(runId);
  } catch {
    return null;
  }
  if (!value.id || !value.createdAt || !value.status?.stage) return null;
  return {
    id: value.id,
    run_id: runId,
    role: role as JobRole,
    stage: stage(value.status.stage),
    created_at: value.createdAt,
    started_at: value.startedAt ?? null,
    finished_at: value.finishedAt ?? null,
  };
}

export class ReadOnlyHuggingFaceJobs implements JobsPort {
  constructor(private readonly options: ReadOnlyHuggingFaceJobsOptions) {}

  async list(): Promise<readonly JobObservation[]> {
    const values = await listJobs({
      namespace: this.options.namespace,
      accessToken: this.options.accessToken,
      ...(this.options.hubUrl ? { hubUrl: this.options.hubUrl } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    return values
      .map(observation)
      .filter((value): value is JobObservation => value !== null);
  }

  async startParent(_runId: string): Promise<JobObservation> {
    throw new Error("Job launch is disabled");
  }

  async cancel(_jobId: string): Promise<void> {
    throw new Error("Job cancellation is disabled");
  }
}

export class HuggingFaceJobs implements JobsPort {
  private readonly hardware: SpaceHardwareFlavor;
  private readonly mountRoot: string;
  private readonly timeoutSeconds: number;

  constructor(private readonly options: HuggingFaceJobsOptions) {
    if (!IMMUTABLE_IMAGE.test(options.parentImage))
      throw new Error("parent image must use an immutable sha256 digest");
    this.hardware = options.hardware ?? "cpu-basic";
    this.mountRoot = options.mountRoot ?? "/data";
    this.timeoutSeconds = options.timeoutSeconds ?? 86_400;
  }

  private credentials(): {
    namespace: string;
    accessToken: string;
    hubUrl?: string;
    fetch?: typeof fetch;
  } {
    return {
      namespace: this.options.namespace,
      accessToken: this.options.accessToken,
      ...(this.options.hubUrl ? { hubUrl: this.options.hubUrl } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    };
  }

  async list(): Promise<readonly JobObservation[]> {
    const values = await listJobs(this.credentials());
    return values
      .map(observation)
      .filter((value): value is JobObservation => value !== null);
  }

  async startParent(runId: string): Promise<JobObservation> {
    assertRunId(runId);
    const value = await runJob({
      ...this.credentials(),
      dockerImage: this.options.parentImage,
      command: ["python", "-m", "harbor_hf_agents.parent_worker"],
      environment: {
        HARBOR_HF_RUN_ID: runId,
        HARBOR_HF_MOUNT_ROOT: this.mountRoot,
        HARBOR_HF_NAMESPACE: this.options.namespace,
      },
      secrets: {
        HF_TOKEN: this.options.accessToken,
        HF_INFERENCE_TOKEN: this.options.inferenceToken,
      },
      flavor: this.hardware,
      arch: "amd64",
      timeoutSeconds: this.timeoutSeconds,
      attempts: 1,
      labels: { [ROLE_LABEL]: "parent", [RUN_LABEL]: runId },
      volumes: [
        {
          source: { type: "bucket", name: this.options.bucketId },
          mountPath: this.mountRoot,
          readOnly: false,
        },
      ],
    });
    const result = observation(value);
    if (!result) throw new Error("created parent Job has invalid metadata");
    return result;
  }

  async cancel(jobId: string): Promise<void> {
    await cancelJob({ ...this.credentials(), jobId });
  }
}

export class NoopJobs implements JobsPort {
  async list(): Promise<readonly JobObservation[]> {
    return [];
  }

  async startParent(_runId: string): Promise<JobObservation> {
    throw new Error("Job launch is disabled");
  }

  async cancel(_jobId: string): Promise<void> {}
}

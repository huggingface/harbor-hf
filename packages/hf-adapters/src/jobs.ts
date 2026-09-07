import { assertRunId } from "@harbor-hf/contracts";
import type {
  JobObservation,
  JobRole,
  JobStage,
  JobsPort,
} from "@harbor-hf/control-core";
import { listJobs, type runJob, type SpaceHardwareFlavor } from "@huggingface/hub";

export type ParentHardware = SpaceHardwareFlavor;
type ApiJob = Awaited<ReturnType<typeof runJob>>;

const ROLE_LABEL = "harbor-hf-role";
const RUN_LABEL = "harbor-hf-run";
export interface ReadOnlyHuggingFaceJobsOptions {
  namespace: string;
  accessToken: string;
  hubUrl?: string;
  fetch?: typeof fetch;
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

export class NoopJobs implements JobsPort {
  async list(): Promise<readonly JobObservation[]> {
    return [];
  }

  async startParent(_runId: string): Promise<JobObservation> {
    throw new Error("Job launch is disabled");
  }

  async cancel(_jobId: string): Promise<void> {}
}

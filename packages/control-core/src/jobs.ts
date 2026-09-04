export type JobRole = "parent" | "trial";
export type JobStage = "queued" | "running" | "stopped" | "error";

export interface JobObservation {
  id: string;
  run_id: string;
  role: JobRole;
  stage: JobStage;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobsPort {
  list(): Promise<readonly JobObservation[]>;
  startParent(runId: string): Promise<JobObservation>;
  cancel(jobId: string): Promise<void>;
}

export function isLiveJob(job: JobObservation): boolean {
  return job.stage === "queued" || job.stage === "running";
}

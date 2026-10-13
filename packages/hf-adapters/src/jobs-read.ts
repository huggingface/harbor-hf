import { assertRunId } from "@harbor-hf/contracts";
import type { JobObservation, JobStage } from "@harbor-hf/control-core";
import type { ReadOnlyHuggingFaceJobsOptions } from "./jobs.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Job metadata");
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("Invalid Job timestamp");
  return value;
}

function stage(value: unknown): JobStage {
  switch (value) {
    case "RUNNING":
    case "UPDATING":
      return "running";
    case "PENDING":
    case "SCHEDULING":
      return "queued";
    case "ERROR":
      return "error";
    case "COMPLETED":
    case "CANCELED":
    case "DELETED":
    case "STOPPED":
    case "PAUSED":
    case "DELETING":
      return "stopped";
    default:
      throw new Error("Unknown Job stage");
  }
}

export function observation(input: unknown): JobObservation | null {
  const value = object(input);
  const labels = value.labels == null ? {} : object(value.labels);
  if (Object.values(labels).some((item) => typeof item !== "string"))
    throw new Error("Invalid Job labels");
  const runId = labels["harbor-hf-run"];
  const role = labels["harbor-hf-role"];
  if (runId === undefined || (role !== "parent" && role !== "trial")) return null;
  if (typeof runId !== "string") throw new Error("Invalid Job run label");
  assertRunId(runId);
  if (typeof value.id !== "string" || !value.id)
    throw new Error("Invalid Job identity");
  return {
    id: value.id,
    run_id: runId,
    role,
    stage: stage(object(value.status).stage),
    created_at: timestamp(value.createdAt),
    started_at: value.startedAt == null ? null : timestamp(value.startedAt),
    finished_at: value.finishedAt == null ? null : timestamp(value.finishedAt),
  };
}

function endpoint(options: ReadOnlyHuggingFaceJobsOptions): URL {
  const base = new URL(options.hubUrl ?? "https://huggingface.co");
  if (base.protocol !== "https:" || base.username || base.password)
    throw new Error("Untrusted Jobs endpoint");
  return new URL(`/api/jobs/${encodeURIComponent(options.namespace)}`, base);
}

async function read(
  options: ReadOnlyHuggingFaceJobsOptions,
  url: URL,
): Promise<Response> {
  const response = await (options.fetch ?? fetch)(url.href, {
    headers: { Authorization: `Bearer ${options.accessToken}` },
    redirect: "error",
  });
  if (!response.ok || response.redirected) throw new Error("Jobs read failed");
  return response;
}

function nextPage(header: string | null, current: URL, first: URL): URL | null {
  if (!header) return null;
  let next: URL | null = null;
  for (const link of header.split(/,(?=\s*<)/)) {
    const match =
      /^\s*<([^>]+)>((?:\s*;\s*[\w-]+\s*=\s*(?:"[^"]*"|[^\s;,]+))*)\s*$/.exec(link);
    if (!match) throw new Error("Invalid Jobs pagination Link");
    const relations = [
      ...(match[2] ?? "").matchAll(/;\s*([\w-]+)\s*=\s*(?:"([^"]*)"|([^\s;,]+))/g),
    ].filter((parameter) => parameter[1]?.toLowerCase() === "rel");
    if (relations.length !== 1) throw new Error("Invalid Jobs Link relation");
    const rel = relations[0];
    if (!(rel?.[2] ?? rel?.[3] ?? "").split(/\s+/).includes("next")) continue;
    if (next) throw new Error("Ambiguous Jobs next page");
    next = new URL(match[1] ?? "", current);
    if (
      next.origin !== first.origin ||
      next.pathname !== first.pathname ||
      next.username ||
      next.password ||
      next.hash
    )
      throw new Error("Untrusted Jobs next page");
  }
  return next;
}

// The Hub filters Jobs only by its current stages, and these two are the live ones.
const LIVE_STAGES = ["RUNNING", "SCHEDULING"] as const;
// A Job never leaves these stages, so an inspection that reports one is final.
const FINAL_STAGES = new Set(["COMPLETED", "CANCELED", "ERROR", "DELETED"]);
const MAX_FINAL_INSPECTIONS = 10_000;

async function* pages(
  options: ReadOnlyHuggingFaceJobsOptions,
  query: readonly (readonly [string, string])[],
): AsyncGenerator<unknown[]> {
  const first = endpoint(options);
  for (const [name, value] of query) first.searchParams.append(name, value);
  let url: URL | null = first;
  const seen = new Set<string>();
  while (url) {
    if (seen.has(url.href) || seen.size >= 1000)
      throw new Error("Jobs pagination loop or page limit");
    seen.add(url.href);
    const response = await read(options, url);
    const page: unknown = await response.json();
    if (!Array.isArray(page)) throw new Error("Invalid Jobs page");
    yield page;
    url = nextPage(response.headers.get("link"), url, first);
  }
}

/** Reads at most `limit` Jobs that match the Hub label and stage query, newest first. */
export async function listFilteredJobs(
  options: ReadOnlyHuggingFaceJobsOptions,
  query: readonly (readonly [string, string])[],
  limit: number,
): Promise<unknown[]> {
  const jobs: unknown[] = [];
  for await (const page of pages(options, query)) {
    jobs.push(...page);
    if (jobs.length >= limit) break;
  }
  return jobs.slice(0, limit);
}

async function listJobPages(
  options: ReadOnlyHuggingFaceJobsOptions,
): Promise<readonly JobObservation[]> {
  const values = new Map<string, JobObservation>();
  // The account keeps every finished Job. Filter by role and live stage at the
  // Hub, so a listing reads only live Jobs and never walks the Job history.
  for (const role of ["parent", "trial"] as const) {
    const query: [string, string][] = [
      ["label", `harbor-hf-role=${role}`],
      ...LIVE_STAGES.map((stage): [string, string] => ["stage", stage]),
    ];
    for await (const page of pages(options, query)) {
      for (const input of page) {
        const job = observation(input);
        if (job) {
          if (job.role !== role) throw new Error("Jobs label filter was not applied");
          if (job.stage !== "queued" && job.stage !== "running")
            throw new Error("Jobs stage filter was not applied");
          const previous = values.get(job.id);
          if (
            previous &&
            (previous.run_id !== job.run_id ||
              previous.role !== job.role ||
              previous.created_at !== job.created_at)
          )
            throw new Error("Conflicting Job in pagination");
          // New Jobs can shift cursor pages. Keep the later stable observation.
          values.set(job.id, job);
        }
      }
    }
  }
  return [...values.values()];
}

async function inspectJob(
  options: ReadOnlyHuggingFaceJobsOptions,
  jobId: string,
): Promise<{ job: JobObservation; final: boolean }> {
  if (!jobId || jobId === "." || jobId === "..")
    throw new Error("Invalid Job identity");
  const url = endpoint(options);
  url.pathname += `/${encodeURIComponent(jobId)}`;
  const response = await read(options, url);
  const input: unknown = await response.json();
  const job = observation(input);
  if (!job || job.id !== jobId) throw new Error("Inspected Job identity mismatch");
  return { job, final: FINAL_STAGES.has(String(object(object(input).status).stage)) };
}

/** Lists live owned Jobs and inspects one Job by ID, reading a final Job only once. */
export class JobReader {
  private readonly final = new Map<string, JobObservation>();

  constructor(private readonly options: ReadOnlyHuggingFaceJobsOptions) {}

  list(): Promise<readonly JobObservation[]> {
    return listJobPages(this.options);
  }

  async inspect(jobId: string): Promise<JobObservation> {
    const cached = this.final.get(jobId);
    if (cached) return { ...cached };
    const { job, final } = await inspectJob(this.options, jobId);
    if (final) {
      this.final.set(jobId, job);
      const oldest = this.final.keys().next().value;
      if (this.final.size > MAX_FINAL_INSPECTIONS && oldest !== undefined)
        this.final.delete(oldest);
    }
    return { ...job };
  }
}

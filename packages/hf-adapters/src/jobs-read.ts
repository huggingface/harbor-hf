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

export async function listJobPages(
  options: ReadOnlyHuggingFaceJobsOptions,
): Promise<readonly JobObservation[]> {
  const first = endpoint(options);
  let url: URL | null = first;
  const seen = new Set<string>();
  const values: JobObservation[] = [];
  const ids = new Set<string>();
  while (url) {
    if (seen.has(url.href) || seen.size >= 1000)
      throw new Error("Jobs pagination loop or page limit");
    seen.add(url.href);
    const response = await read(options, url);
    const page: unknown = await response.json();
    if (!Array.isArray(page)) throw new Error("Invalid Jobs page");
    for (const input of page) {
      const job = observation(input);
      if (job) {
        if (ids.has(job.id)) throw new Error("Duplicate Job in pagination");
        ids.add(job.id);
        values.push(job);
      }
    }
    url = nextPage(response.headers.get("link"), url, first);
  }
  return values;
}

export async function inspectJob(
  options: ReadOnlyHuggingFaceJobsOptions,
  jobId: string,
): Promise<JobObservation> {
  if (!jobId || jobId === "." || jobId === "..")
    throw new Error("Invalid Job identity");
  const url = endpoint(options);
  url.pathname += `/${encodeURIComponent(jobId)}`;
  const response = await read(options, url);
  const input: unknown = await response.json();
  const job = observation(input);
  if (!job || job.id !== jobId) throw new Error("Inspected Job identity mismatch");
  return job;
}

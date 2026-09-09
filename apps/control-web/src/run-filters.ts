import type { RunRecord, RunView } from "./api";
import { runIdentity } from "./run-identity";

export type RunRoleFilter = RunRecord["role"] | "all";

export function readRunFilters(params: URLSearchParams): {
  archive: "not-archived" | "archived" | "all";
  role: RunRoleFilter;
  q: string;
} {
  const role = params.get("role");
  const archive = params.get("archive");
  return {
    archive: archive === "archived" || archive === "all" ? archive : "not-archived",
    role: role === "diagnostic" || role === "final" ? role : "all",
    q: params.get("q") ?? "",
  };
}

export function updateRunFilters(
  params: URLSearchParams,
  key: "q" | "role" | "archive",
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (
    !value ||
    (key === "role" && value === "all") ||
    (key === "archive" && value === "not-archived")
  )
    next.delete(key);
  else next.set(key, value);
  return next;
}

/** Presentation only: role is submission intent, never execution status. */
export function matchesRunFilters(
  record: RunRecord,
  filters: {
    role: RunRoleFilter;
    q: string;
    archive?: "not-archived" | "archived" | "all";
  },
  presentation?: RunView["presentation"],
  presentationAvailable = true,
): boolean {
  // Unknown archive state remains discoverable by default, not asserted unarchived.
  const unknown = !presentationAvailable && !presentation;
  if (
    filters.archive !== "all" &&
    (unknown
      ? filters.archive === "archived"
      : (presentation?.archived ?? false) !== (filters.archive === "archived"))
  )
    return false;
  if (filters.role !== "all" && record.role !== filters.role) return false;
  const needle = filters.q.trim().toLocaleLowerCase();
  if (!needle) return true;
  const identity = runIdentity(record);
  return [
    record.run_id,
    record.workbench_recipe?.name,
    record.submission.benchmark.name,
    record.submission.benchmark.preset,
    record.submission.model?.id,
    record.submission.model?.provider,
    identity.model,
    identity.provider,
    identity.agent,
    identity.nativeAgent,
    identity.version,
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

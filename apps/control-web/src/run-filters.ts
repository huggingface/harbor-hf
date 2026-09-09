import type { RunRecord } from "./api";
import { runIdentity } from "./run-identity";

export type RunRoleFilter = RunRecord["role"] | "all";

export function readRunFilters(params: URLSearchParams): {
  role: RunRoleFilter;
  q: string;
} {
  const role = params.get("role");
  return {
    role: role === "diagnostic" || role === "final" ? role : "all",
    q: params.get("q") ?? "",
  };
}

export function updateRunFilters(
  params: URLSearchParams,
  key: "q" | "role",
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (!value || (key === "role" && value === "all")) next.delete(key);
  else next.set(key, value);
  return next;
}

/** Presentation only: role is submission intent, never execution status. */
export function matchesRunFilters(
  record: RunRecord,
  filters: ReturnType<typeof readRunFilters>,
): boolean {
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

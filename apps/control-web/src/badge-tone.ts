export type BadgeTone =
  | "success"
  | "warning"
  | "cancel"
  | "danger"
  | "info"
  | "neutral";

const SUCCESS_STATUSES = new Set([
  "clear",
  "complete",
  "completed",
  "connected",
  "enabled",
  "published",
  "ready",
  "success",
  "verified",
]);
const DANGER_STATUSES = new Set([
  "agent",
  "error",
  "failed",
  "infrastructure",
  "invalid",
  "policy",
  "refusal",
  "semantic",
  "verifier",
]);
const WARNING_STATUSES = new Set([
  "benchmark_timeout",
  "canary",
  "manual_intervention",
  "stale",
  "stopped",
  "warning",
]);
const CANCEL_STATUSES = new Set(["cancelled", "canceled"]);
const INFO_STATUSES = new Set([
  "active",
  "cancelling",
  "publishing",
  "running",
  "scheduling",
]);

const VALUE_TEXT_CLASS: Record<BadgeTone, string> = {
  success: "text-emerald-300",
  warning: "text-amber-300",
  cancel: "text-orange-400",
  danger: "text-rose-300",
  info: "text-cyan-300",
  neutral: "text-white",
};

export const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  cancel: "border-orange-500/40 bg-orange-500/15 text-orange-400",
  danger: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  info: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  neutral: "border-slate-500/40 bg-slate-500/10 text-slate-300",
};

/** Maps a status or outcome string onto success, warning, cancel, error, in-progress, or pending. */
export function badgeTone(status?: string): BadgeTone {
  const key = (status ?? "pending").toLowerCase();
  if (SUCCESS_STATUSES.has(key)) return "success";
  if (DANGER_STATUSES.has(key)) return "danger";
  if (CANCEL_STATUSES.has(key)) return "cancel";
  if (WARNING_STATUSES.has(key)) return "warning";
  if (INFO_STATUSES.has(key)) return "info";
  return "neutral";
}

export function statusTextClass(status?: string): string {
  return VALUE_TEXT_CLASS[badgeTone(status)];
}

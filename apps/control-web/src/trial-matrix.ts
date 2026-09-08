import type { TaskList } from "./api";
import { formatDate, formatMoney, shortId } from "./lib";

export type MatrixTask = TaskList["items"][number];
export const trialStates = {
  running: {
    label: "Running",
    symbol: "▶",
    className: "border-cyan-400/60 bg-cyan-400/20 text-cyan-200",
  },
  completed: {
    label: "Completed",
    symbol: "✓",
    className: "border-emerald-400/60 bg-emerald-400/20 text-emerald-200",
  },
  errored: {
    label: "Errored",
    symbol: "!",
    className: "border-rose-400/60 bg-rose-400/20 text-rose-200",
  },
  zero: {
    label: "Zero reward",
    symbol: "0",
    className: "border-amber-400/60 bg-amber-400/20 text-amber-200",
  },
  queued: {
    label: "Queued / unstarted",
    symbol: "○",
    className: "border-slate-600 bg-slate-800 text-slate-300",
  },
  awaiting: {
    label: "Awaiting result",
    symbol: "…",
    className: "border-violet-400/60 bg-violet-400/20 text-violet-200",
  },
  cancelled: {
    label: "Cancelled",
    symbol: "−",
    className: "border-orange-400/60 bg-orange-400/20 text-orange-200",
  },
  unknown: {
    label: "Unknown",
    symbol: "?",
    className: "border-slate-600 border-dashed text-slate-400",
  },
} as const;
export type TrialState = keyof typeof trialStates;

export function trialState(task: MatrixTask): TrialState {
  const job = task.pending_job_state?.toUpperCase();
  if (job === "RUNNING") return "running";
  if (job && ["QUEUED", "PENDING", "SCHEDULING", "STARTING"].includes(job))
    return "queued";
  if (task.terminal_outcome === "cancelled") return "cancelled";
  if (task.terminal_outcome === "complete")
    return task.reward === 0 ? "zero" : "completed";
  if (task.terminal_outcome) return "errored";
  if (job && ["ERROR", "FAILED", "TIMEOUT"].includes(job)) return "errored";
  if (job === "CANCELLED" || job === "CANCELED") return "cancelled";
  if (job) return job === "COMPLETED" ? "awaiting" : "unknown";
  if (task.latest_outcome)
    return task.latest_outcome === "complete" ? "awaiting" : "errored";
  return "queued";
}

// Do not imply comparability when identically named tasks have different inputs.
export function trialKey(task: Pick<MatrixTask, "task_id" | "input_digest">): string {
  return JSON.stringify([task.task_id, task.input_digest]);
}

export function trialDescription(task: MatrixTask): string {
  return [
    `State: ${trialStates[trialState(task)].label}`,
    `Outcome: ${task.terminal_outcome ?? "not sealed"}`,
    `Selected reward: ${task.reward ?? "not reported"}`,
    `Recorded attempts: ${task.attempt_count}`,
    `Latest attempt outcome: ${task.latest_outcome ?? "none"}`,
    `Job: ${task.pending_job_state ?? "no unrecorded job"}`,
    `Attempt cost: ${formatMoney(task.cost_microusd)}`,
    `Last receipt: ${task.last_attempt_at ? formatDate(task.last_attempt_at) : "none"}`,
    `Selected attempt: ${task.selected_attempt_id ? shortId(task.selected_attempt_id) : "none"}`,
  ].join("\n");
}

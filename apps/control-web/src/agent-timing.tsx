import type { AgentTimingV1 } from "@harbor-hf/contracts";
import type { ParentJob, RunView } from "./api";
import { asRecord, formatDuration, humanize } from "./lib";
import { Badge, Hint } from "./ui";

export function agentDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "−";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${hours ? `${hours}h` : ""}${minutes ? `${minutes % 60}m` : ""}${seconds % 60}s`;
}

export function agentTimeLabel(timing: AgentTimingV1 | undefined): string {
  return `${agentDuration(timing?.duration_ms)}${timing?.duration_ms != null && (timing.partial_trials > 0 || timing.unavailable_trials > 0) ? " (partial)" : ""}`;
}

export function RunStatusTiming({ run }: { run: RunView }) {
  const timing = run.agent_timing;
  const coverage = timing
    ? `${timing.complete_trials} complete · ${timing.partial_trials} partial · ${timing.unavailable_trials} unavailable`
    : "Measurement coverage unavailable";
  const label =
    timing?.duration_ms == null
      ? `Agent time unavailable${timing && timing.partial_trials > 0 ? " · partial" : ""}`
      : `Agent Σ ${agentDuration(timing.duration_ms)}${timing.partial_trials > 0 || timing.unavailable_trials > 0 ? " · partial" : ""}`;
  return (
    <div className="w-max max-w-full space-y-1">
      <Badge status={run.status}>{humanize(run.status)}</Badge>
      <div className="whitespace-nowrap text-xs text-slate-400 tabular-nums">
        <Hint text={coverage}>{label}</Hint>
      </div>
    </div>
  );
}

export function parentJobTime(job: ParentJob, now = Date.now()): string {
  if (job.finished_at) {
    return `Duration: ${formatDuration(job.started_at, job.finished_at)}`;
  }
  if (job.stage === "running") {
    return `Elapsed since start: ${formatDuration(job.started_at, new Date(now).toISOString())}`;
  }
  return "Duration: Unavailable";
}

export function configuredTimeouts(
  config: RunView["record"]["harbor_job_config"],
): string {
  const values: string[] = [];
  const add = (
    record: Record<string, unknown> | null,
    prefix: string,
    keys: string[],
  ) => {
    for (const key of keys) {
      const value = record?.[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        values.push(`${prefix}${key}: ${value}`);
      }
    }
  };
  add(config, "", [
    "timeout_multiplier",
    "agent_timeout_multiplier",
    "verifier_timeout_multiplier",
    "agent_setup_timeout_multiplier",
    "environment_build_timeout_multiplier",
  ]);
  if (Array.isArray(config.agents)) {
    config.agents.forEach((agent, index) => {
      add(asRecord(agent), `agents[${index}].`, [
        "override_timeout_sec",
        "override_setup_timeout_sec",
        "max_timeout_sec",
      ]);
    });
  }
  add(asRecord(config.verifier), "verifier.", [
    "override_timeout_sec",
    "max_timeout_sec",
  ]);
  return `Configured Harbor timeouts (raw JobConfig; not effective budgets). Harbor resolves task defaults, overrides, caps and multipliers.\n${values.join("\n") || "No explicit phase timeout settings recorded."}`;
}

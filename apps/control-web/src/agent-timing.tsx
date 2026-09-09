import type { AgentTimingV1 } from "@harbor-hf/contracts";
import type { RunView } from "./api";
import { humanize } from "./lib";
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

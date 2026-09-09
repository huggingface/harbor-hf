import type { AgentTimingV1 } from "./generated/agent-timing-v1.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Native UTC/offset timestamps only, never locale-dependent dates or a live clock.
function timestamp(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return null;
  if (
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    return null;
  const date = value.slice(0, 10);
  const calendar = new Date(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== date
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function interval(value: unknown): number | null {
  const timing = record(value);
  const start = timestamp(timing?.started_at);
  const finish = timestamp(timing?.finished_at);
  return start !== null && finish !== null && finish >= start ? finish - start : null;
}

function malformedSteps(value: unknown): boolean {
  return value !== undefined && value !== null && !Array.isArray(value);
}

/** Only current native results belong here; callers exclude archived/replaced rows. */
export function trialAgentTiming(value: unknown): AgentTimingV1 {
  const result = record(value);
  const steps = result?.step_results;
  // A populated step list is authoritative even when top-level timing is present.
  const multi = Array.isArray(steps) && steps.length > 0;
  const durations = malformedSteps(steps)
    ? [null]
    : multi
      ? steps.map((step) => interval(record(step)?.agent_execution))
      : [interval(result?.agent_execution)];
  const measured = durations.filter((ms): ms is number => ms !== null);
  const complete =
    measured.length === durations.length &&
    (!multi || timestamp(result?.finished_at) !== null);
  return {
    duration_ms: measured.length ? measured.reduce((sum, ms) => sum + ms, 0) : null,
    complete_trials: complete ? 1 : 0,
    partial_trials: measured.length > 0 && !complete ? 1 : 0,
    unavailable_trials: measured.length ? 0 : 1,
  };
}

export function sumAgentTiming(results: readonly unknown[]): AgentTimingV1 {
  const total: AgentTimingV1 = {
    duration_ms: null,
    complete_trials: 0,
    partial_trials: 0,
    unavailable_trials: 0,
  };
  for (const result of results) {
    const timing = trialAgentTiming(result);
    if (timing.duration_ms !== null)
      total.duration_ms = (total.duration_ms ?? 0) + timing.duration_ms;
    total.complete_trials += timing.complete_trials;
    total.partial_trials += timing.partial_trials;
    total.unavailable_trials += timing.unavailable_trials;
  }
  return total;
}

/** Allowlist malformed timing independently: it must not reject other evidence. */
export function projectNativeAgentTiming(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const phase = (input: unknown) => {
    const timing = record(input);
    if (!timing) return null;
    return {
      started_at: timestamp(timing.started_at) === null ? null : timing.started_at,
      finished_at: timestamp(timing.finished_at) === null ? null : timing.finished_at,
    };
  };
  return {
    ...value,
    agent_execution: malformedSteps(value.step_results)
      ? null
      : phase(value.agent_execution),
    step_results: Array.isArray(value.step_results)
      ? value.step_results.map((step) => ({
          agent_execution: phase(record(step)?.agent_execution),
        }))
      : null,
  };
}

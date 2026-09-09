import { describe, expect, it } from "vitest";
import {
  projectNativeAgentTiming,
  sumAgentTiming,
  trialAgentTiming,
} from "../src/agent-timing.js";

const start = "2026-09-09T10:00:00Z";
const finish = "2026-09-09T10:01:26Z";
const phase = { started_at: start, finished_at: finish };
const native = { agent_execution: phase };

describe("native measured agent time", () => {
  it("does not fall back to top-level timing when a non-null step list is malformed", () => {
    const invalid = { ...native, step_results: "bad" };
    expect(trialAgentTiming(invalid).duration_ms).toBeNull();
    expect(trialAgentTiming(projectNativeAgentTiming(invalid)).duration_ms).toBeNull();
  });
  it("measures only agent wall time, including valid zero and offsets", () => {
    expect(
      trialAgentTiming({
        ...native,
        started_at: "2020-01-01T00:00:00Z",
        finished_at: "2030-01-01T00:00:00Z",
      }),
    ).toEqual({
      duration_ms: 86_000,
      complete_trials: 1,
      partial_trials: 0,
      unavailable_trials: 0,
    });
    expect(
      trialAgentTiming({ agent_execution: { started_at: start, finished_at: start } })
        .duration_ms,
    ).toBe(0);
    expect(
      trialAgentTiming({
        agent_execution: {
          started_at: "2026-09-09T12:00:00+02:00",
          finished_at: finish,
        },
      }).duration_ms,
    ).toBe(86_000);
    expect(
      trialAgentTiming({
        agent_execution: {
          started_at: "2026-09-09T10:00:00.123456Z",
          finished_at: "2026-09-09T10:00:01.123456Z",
        },
      }).duration_ms,
    ).toBe(1000);
  });
  it.each([
    undefined,
    null,
    [],
    "wrong",
    {},
    { started_at: start },
    { started_at: start, finished_at: null },
    { started_at: finish, finished_at: start },
    { started_at: 0, finished_at: finish },
    { started_at: "2026-02-30T00:00:00Z", finished_at: finish },
    { started_at: "2026-09-09T24:00:00Z", finished_at: finish },
    { started_at: "2026-09-09T10:00:00", finished_at: finish },
    { started_at: "bad", finished_at: finish },
    { started_at: "2026-13-01T00:00:00Z", finished_at: finish },
    { started_at: "2026-09-09T10:00:00+99:00", finished_at: finish },
  ])("keeps invalid or unfinished phase unavailable: %j", (agent_execution) => {
    expect(trialAgentTiming({ agent_execution })).toEqual({
      duration_ms: null,
      complete_trials: 0,
      partial_trials: 0,
      unavailable_trials: 1,
    });
  });
  it("sums steps once, never adds or falls back to top-level time", () => {
    const result = { ...native, finished_at: finish, step_results: [native, native] };
    const before = structuredClone(result);
    expect(trialAgentTiming(result).duration_ms).toBe(172_000);
    expect(result).toEqual(before);
    expect(
      trialAgentTiming({ ...result, step_results: [null, {}] }).duration_ms,
    ).toBeNull();
    expect(trialAgentTiming({ ...native, step_results: [] }).duration_ms).toBe(86_000);
  });
  it("reports measured partial sums and unfinished multi-step coverage", () => {
    for (const result of [
      { step_results: [native] },
      {
        finished_at: finish,
        step_results: [native, null, { agent_execution: { started_at: start } }],
      },
    ]) {
      expect(trialAgentTiming(result)).toEqual({
        duration_ms: 86_000,
        complete_trials: 0,
        partial_trials: 1,
        unavailable_trials: 0,
      });
    }
  });
  it("sums current results with coverage, with null rather than fabricated zero", () => {
    expect(sumAgentTiming([])).toEqual({
      duration_ms: null,
      complete_trials: 0,
      partial_trials: 0,
      unavailable_trials: 0,
    });
    expect(sumAgentTiming([native, { step_results: [native] }, null])).toEqual({
      duration_ms: 172_000,
      complete_trials: 1,
      partial_trials: 1,
      unavailable_trials: 1,
    });
    expect(sumAgentTiming([null]).duration_ms).toBeNull();
    expect(
      sumAgentTiming([{ agent_execution: { started_at: start, finished_at: start } }])
        .duration_ms,
    ).toBe(0);
  });
  it("sanitizes timing without mutating native results", () => {
    const result = {
      agent_execution: { ...phase, secret: "excluded" },
      step_results: [
        null,
        { agent_execution: 42 },
        {
          agent_execution: { started_at: {}, finished_at: finish },
          config: "excluded",
        },
      ],
    };
    const before = structuredClone(result);
    expect(projectNativeAgentTiming(result)).toEqual({
      agent_execution: phase,
      step_results: [
        { agent_execution: null },
        { agent_execution: null },
        { agent_execution: { started_at: null, finished_at: finish } },
      ],
    });
    expect(result).toEqual(before);
  });
});

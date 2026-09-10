// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  agentDuration,
  agentTimeLabel,
  RunStatusTiming,
  parentJobTime,
  configuredTimeouts,
} from "../src/agent-timing";
import type { ParentJob, RunView } from "../src/api";

afterEach(cleanup);
it.each([
  [null, "−"],
  [undefined, "−"],
  [NaN, "−"],
  [-1, "−"],
  [0, "0s"],
  [86000, "1m26s"],
  [750000, "12m30s"],
  [3600000, "1h0m0s"],
] as const)("formats measured duration %s", (ms, expected) => {
  expect(agentDuration(ms)).toBe(expected);
});
it.each([
  [undefined, "Agent time unavailable", "Measurement coverage unavailable"],
  [
    {
      duration_ms: null,
      complete_trials: 0,
      partial_trials: 0,
      unavailable_trials: 90,
    },
    "Agent time unavailable",
    "0 complete · 0 partial · 90 unavailable",
  ],
  [
    {
      duration_ms: 100445000,
      complete_trials: 88,
      partial_trials: 0,
      unavailable_trials: 1,
    },
    "Agent Σ 27h54m5s · partial",
    "88 complete · 0 partial · 1 unavailable",
  ],
  [
    { duration_ms: 0, complete_trials: 0, partial_trials: 1, unavailable_trials: 0 },
    "Agent Σ 0s · partial",
    "0 complete · 1 partial · 0 unavailable",
  ],
  [
    { duration_ms: null, complete_trials: 0, partial_trials: 1, unavailable_trials: 1 },
    "Agent time unavailable · partial",
    "0 complete · 1 partial · 1 unavailable",
  ],
  [
    {
      duration_ms: 360000000,
      complete_trials: 90,
      partial_trials: 0,
      unavailable_trials: 0,
    },
    "Agent Σ 100h0m0s",
    "90 complete · 0 partial · 0 unavailable",
  ],
] as const)(
  "separates state, timing and focusable coverage: %s",
  (timing, label, coverage) => {
    render(
      <RunStatusTiming run={{ status: "finished", agent_timing: timing } as RunView} />,
    );
    expect(screen.getByText("Finished", { exact: true })).toBeVisible();
    const text = screen.getByText(label, { exact: true });
    expect(text).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    const trigger = text.parentElement!;
    expect(trigger).toHaveAttribute("tabindex", "0");
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toHaveTextContent(coverage);
    expect(trigger).toHaveAccessibleDescription(coverage);
    fireEvent.blur(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  },
);
it("preserves shared trial timing labels", () => {
  const timing = {
    duration_ms: 0,
    complete_trials: 4,
    partial_trials: 1,
    unavailable_trials: 2,
  };
  expect(agentTimeLabel(timing)).toBe("0s (partial)");
  expect(agentTimeLabel({ ...timing, duration_ms: null })).toBe("−");
});

it("keeps running parent age separate from finished duration and never uses creation as start", () => {
  const job: ParentJob = {
    id: "job-example",
    run_id: "run-example",
    role: "parent",
    stage: "running",
    created_at: "2026-01-01T00:00:00Z",
    started_at: "2026-01-01T00:01:00Z",
    finished_at: null,
  };
  const now = Date.parse("2026-01-01T00:03:00Z");
  expect(parentJobTime(job, now)).toBe("Elapsed since start: 2m 0s");
  expect(parentJobTime({ ...job, started_at: null }, now)).toBe(
    "Elapsed since start: Unavailable",
  );
  expect(parentJobTime({ ...job, started_at: "bad" }, now)).toBe(
    "Elapsed since start: Unavailable",
  );
  expect(parentJobTime(job, Date.parse(job.created_at))).toBe(
    "Elapsed since start: Unavailable",
  );
  for (const stage of ["queued", "stopped", "error"] as const) {
    expect(parentJobTime({ ...job, stage }, now)).toBe("Duration: Unavailable");
  }
  const ended = {
    ...job,
    stage: "stopped" as const,
    finished_at: "2026-01-01T00:02:00Z",
  };
  expect(parentJobTime(ended, now)).toBe("Duration: 1m 0s");
  expect(parentJobTime(ended, now + 60_000)).toBe("Duration: 1m 0s");
});

it("shows only explicitly configured native timeout numbers, without resolving or exposing kwargs", () => {
  const text = configuredTimeouts({
    timeout_multiplier: 2,
    agent_timeout_multiplier: 0,
    agents: [
      {
        override_timeout_sec: 600,
        max_timeout_sec: 300,
        kwargs: { secret: "not-for-display" },
      },
      { override_setup_timeout_sec: 120 },
    ],
    verifier: { override_timeout_sec: 90 },
    environment: { kwargs: { job_timeout: "none" } },
  });
  expect(text).toContain("not effective budgets");
  expect(text).toContain("timeout_multiplier: 2");
  expect(text).toContain("agent_timeout_multiplier: 0");
  expect(text).toContain("agents[0].override_timeout_sec: 600");
  expect(text).toContain("agents[0].max_timeout_sec: 300");
  expect(text).toContain("agents[1].override_setup_timeout_sec: 120");
  expect(text).toContain("verifier.override_timeout_sec: 90");
  expect(text).not.toMatch(/not-for-display|job_timeout/);
  expect(configuredTimeouts({})).toContain(
    "No explicit phase timeout settings recorded",
  );
  expect(
    configuredTimeouts({ agents: [null], timeout_multiplier: Infinity }),
  ).not.toContain("Infinity");
});

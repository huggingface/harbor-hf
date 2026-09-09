// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { agentDuration, agentTimeLabel, RunStatusTiming } from "../src/agent-timing";
import type { RunView } from "../src/api";

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
it("keeps old records unavailable and shows partial measured coverage", () => {
  const view = { status: "finished" } as RunView;
  const { rerender } = render(<RunStatusTiming run={view} />);
  expect(screen.getByText("Finished · Agent Σ −")).toBeVisible();
  expect(screen.getByText("Measurement coverage unavailable")).toBeVisible();
  const timing = {
    duration_ms: 750000,
    complete_trials: 4,
    partial_trials: 1,
    unavailable_trials: 2,
  };
  rerender(<RunStatusTiming run={{ ...view, agent_timing: timing }} />);
  expect(screen.getByText("Finished · Agent Σ 12m30s (partial)")).toBeVisible();
  expect(screen.getByText("4 complete · 1 partial · 2 unavailable")).toBeVisible();
  expect(agentTimeLabel({ ...timing, duration_ms: 0 })).toBe("0s (partial)");
  expect(agentTimeLabel({ ...timing, duration_ms: null })).toBe("−");
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

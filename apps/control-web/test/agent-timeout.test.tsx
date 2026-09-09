// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import type { RunView } from "../src/api";
import { categoryCounts, exceptionCategory } from "../src/exception-categories";
import {
  projectRunExceptions,
  RunDiagnostics,
  RunDiagnosticsSummary,
} from "../src/run-diagnostics";

afterEach(cleanup);

function run(result: RunView["result"]): RunView {
  return {
    record: {
      schema_version: "v1",
      run_id: "run-timeout",
      created_at: "2026-01-01T00:00:00Z",
      submitted_by: "synthetic-actor",
      role: "diagnostic",
      harbor_revision: "dcd0a7ac",
      submission: {
        benchmark: { name: "sample", preset: "sample" },
        cost_ceiling_usd_per_trial: 1,
      },
      harbor_job_config: {},
    },
    state: {
      schema_version: "v1",
      run_id: "run-timeout",
      revision: 0,
      updated_at: "2026-01-01T00:00:00Z",
      desired_state: "run",
      actor: "synthetic-actor",
      parent_jobs: [],
    },
    status: "finished",
    result,
  };
}

it("classifies only the exact native execution timeout type", () => {
  expect(exceptionCategory("AgentTimeoutError")).toBe("Agent execution timeout");
  expect(exceptionCategory("VerifierTimeoutError")).toBe("Verifier exception");
  expect(exceptionCategory("EnvironmentStartTimeoutError")).toBe(
    "Environment / transport",
  );
});
it.each([
  "TimeoutError",
  "asyncio.TimeoutError",
  "AgentSetupTimeoutError",
  "agenttimeouterror",
  "AgentTimeoutError: deadline",
  "harbor.trial.errors.AgentTimeoutError",
  " AgentTimeoutError",
  "AgentTimeoutErrorSubclass",
  "toString",
  "__proto__",
])("leaves %s unclassified", (type) => {
  expect(exceptionCategory(type)).toBe("Unclassified");
});

it.each([true, false])(
  "deduplicates totals and overlapping categories with complete=%s",
  (complete) => {
    const result = {
      stats: {
        evals: {
          first: {
            exception_stats: {
              AgentTimeoutError: ["a", "a", "b"],
              ApiOverloadedError: ["b"],
              TimeoutError: ["c"],
              AgentSetupTimeoutError: ["d"],
              VerifierTimeoutError: ["e"],
            },
          },
          second: { exception_stats: { AgentTimeoutError: ["a"] } },
          ...(complete ? {} : { missing: {} }),
        },
      },
    };
    const evidence = projectRunExceptions(result);
    expect(evidence.complete).toBe(complete);
    expect(evidence.affectedTrials).toBe(5);
    const counts = categoryCounts(evidence.groups);
    expect(counts.infra).toBe(1);
    expect(counts.categories).toEqual(
      expect.arrayContaining([
        { category: "Agent execution timeout", count: 2 },
        { category: "Provider failure", count: 1 },
        { category: "Unclassified", count: 2 },
        { category: "Verifier exception", count: 1 },
      ]),
    );
    render(
      <>
        <RunDiagnosticsSummary run={run(result)} />
        <RunDiagnostics run={run(result)} />
      </>,
      { wrapper: MemoryRouter },
    );
    expect(screen.getByText(`Agent timeouts: ${complete ? "" : "≥"}2`)).toHaveClass(
      "text-slate-400",
    );
    expect(
      screen.getByText(
        `Infra-related trials: ${complete ? "" : "≥"}1 · unclassified: ${complete ? "" : "≥"}2`,
      ),
    ).toBeVisible();
    for (const total of screen.getAllByText(
      complete ? "5 affected trials" : "At least 5 affected trials · partial evidence",
    ))
      expect(total).toHaveClass("text-red-400");
    expect(screen.getByText("AgentTimeoutError")).toBeVisible();
    expect(screen.getByText(/counts may overlap across categories/)).toBeVisible();
    expect(
      screen.getByText(/native type alone does not prove timeout origin/),
    ).toBeVisible();
    expect(screen.queryByText(/replacement candidate/i)).not.toBeInTheDocument();
  },
);

it.each([null, { stats: { evals: { one: { exception_stats: {} } } } }])(
  "omits the timeout metric without positive evidence: %j",
  (result) => {
    render(<RunDiagnosticsSummary run={run(result)} />, { wrapper: MemoryRouter });
    expect(screen.queryByText(/Agent timeouts:/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        result === null
          ? "Infra-related trials: - · unclassified: -"
          : "Infra-related trials: 0 · unclassified: 0",
      ),
    ).toBeVisible();
  },
);

it("does not count known agent timeouts as infrastructure or unknown", () => {
  const result = {
    stats: { evals: { one: { exception_stats: { AgentTimeoutError: ["a"] } } } },
  };
  render(<RunDiagnosticsSummary run={run(result)} />, { wrapper: MemoryRouter });
  expect(screen.getByText("Infra-related trials: 0 · unclassified: 0")).toBeVisible();
  expect(screen.getByText("Agent timeouts: 1")).toBeVisible();
});

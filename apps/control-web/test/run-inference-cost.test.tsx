// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RunView } from "../src/api";
import { RunInferenceCost } from "../src/run-inference-cost";

afterEach(cleanup);
const pricing = {
  currency: "USD" as const,
  input_usd_per_million: 2,
  cached_usd_per_million: 1,
  output_usd_per_million: 3,
};
const run = {
  record: { pricing },
  result: { stats: { cost_usd: null } },
  shared_estimate: {
    cost_usd: 1.69,
    unavailable_reason: null,
    basis: "launch_rates_reported_usage",
  },
} as RunView;

it.each([null, 0, 7])("prioritizes reported %s over a shared estimate", (reported) => {
  render(
    <RunInferenceCost run={{ ...run, result: { stats: { cost_usd: reported } } }} />,
  );
  const estimate = screen.getByLabelText("Launch estimate (USD): 1.69");
  expect(estimate).toHaveTextContent("$1.69");
  expect(screen.getAllByText(/Estimated/)).toHaveLength(1);
  if (reported === null) {
    expect(estimate.closest("p")).toHaveClass("text-xl");
    expect(screen.queryByLabelText(/Reported cost/)).not.toBeInTheDocument();
    expect(screen.getByText("Estimated · Launch rates")).toBeInTheDocument();
  } else {
    expect(
      screen.getByLabelText(`Reported cost (USD): ${reported}`).closest("p"),
    ).toHaveClass("text-xl");
    expect(estimate.closest("div")).toHaveClass("text-xs");
    expect(screen.getByText("Reported")).toBeInTheDocument();
  }
});
it.each([0, 1.69])(
  "promotes corrected %s with effective rate provenance, without repeated badges",
  (cost) => {
    render(
      <RunInferenceCost
        run={{
          ...run,
          pricing_corrections: {
            schema_version: "v1",
            run_id: "synthetic",
            revisions: [
              {
                revision: 1,
                actor: "test-operator",
                created_at: "2026-01-01T00:00:00Z",
                reason: "Synthetic correction",
                pricing: { ...pricing, output_usd_per_million: 8 },
              },
            ],
          },
          shared_estimate: {
            cost_usd: cost,
            unavailable_reason: null,
            basis: "corrected_rates_reported_usage",
          },
        }}
      />,
    );
    const value = screen.getByLabelText(`Corrected estimate (USD): ${cost}`);
    expect(value.closest("p")).toHaveClass("text-xl");
    expect(screen.getByText("Estimated · Corrected rates")).toBeInTheDocument();
    expect(screen.queryByText("corrected", { exact: true })).not.toBeInTheDocument();
    const provenance = value
      .closest("[tabindex]")
      ?.parentElement?.closest("[tabindex]");
    fireEvent.focus(provenance as HTMLElement);
    expect(screen.getByRole("tooltip")).toHaveTextContent("output 8");
    expect(screen.getByRole("tooltip")).toHaveTextContent("audited corrected rates");
  },
);
it.each([null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, "1.69"])(
  "keeps invalid or absent shared cost %s unavailable",
  (cost) => {
    render(
      <RunInferenceCost
        run={
          {
            ...run,
            shared_estimate: { cost_usd: cost, unavailable_reason: null },
          } as RunView
        }
      />,
    );
    expect(screen.getByLabelText("Reported cost (USD): unavailable")).toHaveTextContent(
      "-",
    );
    expect(screen.queryByText(/Estimated/)).not.toBeInTheDocument();
  },
);
it.each(["missing", "history", "usage", "availability"])(
  "never falls back for %s",
  (kind) => {
    render(
      <RunInferenceCost
        run={{
          ...run,
          pricing_corrections_available: kind !== "availability",
          shared_estimate:
            kind === "missing"
              ? undefined
              : {
                  ...run.shared_estimate,
                  cost_usd: 1.69,
                  unavailable_reason:
                    kind === "history"
                      ? "correction_history_unavailable"
                      : kind === "usage"
                        ? "usage_unavailable"
                        : null,
                },
        }}
      />,
    );
    expect(screen.getByLabelText("Reported cost (USD): unavailable")).toHaveTextContent(
      "-",
    );
    expect(screen.queryByText(/Estimated/)).not.toBeInTheDocument();
    if (kind === "history" || kind === "availability")
      expect(screen.getByText(/no launch fallback/)).toBeInTheDocument();
  },
);

it.each([null, 0])(
  "shows unpriced native cost %s independently of history failure",
  (cost) => {
    render(
      <RunInferenceCost
        run={{
          ...run,
          record: { ...run.record, pricing: undefined },
          result: { stats: { cost_usd: cost } },
          shared_estimate: undefined,
          pricing_corrections_available: false,
        }}
      />,
    );
    expect(
      screen
        .getByLabelText(`Reported cost (USD): ${cost ?? "unavailable"}`)
        .closest("p"),
    ).toHaveClass("text-xl");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText(/Estimated/)).not.toBeInTheDocument();
    expect(screen.getByText(/no launch fallback/)).toBeInTheDocument();
  },
);

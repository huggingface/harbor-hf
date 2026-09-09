// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { RunView } from "../src/api";
import { afterEach, expect, it } from "vitest";
import { PricingPanel } from "../src/pricing-panel";
import {
  CostValue,
  RunSummaryCards,
  ScoreValue,
  TokenValue,
} from "../src/run-summary-cards";

afterEach(cleanup);
it("shows concise numbers with exact keyboard-accessible values", () => {
  render(
    <>
      <TokenValue value={20_484_359} label="Input" />
      <CostValue value={null} />
      <ScoreValue
        result={{
          stats: { evals: { a: { metrics: [{ mean: 0.5168539325842697 }] } } },
        }}
      />
    </>,
  );
  expect(screen.getByText("20.484M")).toHaveAttribute(
    "title",
    "Input tokens: 20484359",
  );
  expect(screen.getByText("20.484M").closest("[tabindex]")).toHaveAttribute(
    "tabindex",
    "0",
  );
  fireEvent.focus(screen.getByText("20.484M").closest("[tabindex]") as HTMLElement);
  expect(screen.getByRole("tooltip")).toHaveTextContent(/^Input tokens: 20484359$/);
  expect(screen.getByText("0.517")).toHaveAccessibleName("Score: 0.5168539325842697");
  expect(screen.getByText("-")).toHaveAccessibleName(/unavailable/);
  expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
});
it("edits uniform scenarios, retains rates on polling and remount, never tiers aggregate usage", () => {
  const result = {
    stats: {
      n_input_tokens: 1_000_000,
      n_output_tokens: 100_000,
      n_cache_tokens: 250_000,
    },
  };
  const view = render(<PricingPanel result={result} />);
  fireEvent.click(screen.getByText(/Pricing scenarios ·/));
  for (const [label, value] of [
    ["Standard input", "2"],
    ["Standard output", "8"],
    ["Standard cached", "0.5"],
    ["Long-context input", "4"],
    ["Long-context output", "16"],
    ["Long-context cached", "1"],
  ]) {
    fireEvent.change(screen.getByLabelText(`${label} (USD/M)`), { target: { value } });
  }
  expect(screen.getByLabelText("Standard scenario USD: 2.425")).toBeInTheDocument();
  expect(screen.getByLabelText("Long-context scenario USD: 4.85")).toBeInTheDocument();
  const threshold = screen.getByLabelText(/Long context when request input exceeds/);
  expect(threshold).toHaveValue(272000);
  fireEvent.change(threshold, { target: { value: "10" } });
  expect(
    screen.getByLabelText("Actual tier-adjusted USD: unavailable"),
  ).toHaveTextContent("-");
  view.rerender(<PricingPanel result={{ ...result }} />);
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(2);
  view.unmount();
  render(<PricingPanel result={result} />);
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(2);
  expect(screen.getByLabelText(/Long context when request input exceeds/)).toHaveValue(
    10,
  );
  fireEvent.change(screen.getByLabelText("Standard input (USD/M)"), {
    target: { value: "-1" },
  });
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(screen.getByLabelText("Standard scenario USD: unavailable")).toHaveTextContent(
    "-",
  );
});

it("renders native 89/89 completion as 100 percent in summary cards", () => {
  const run: RunView = {
    record: {
      schema_version: "v1",
      run_id: "run-a",
      created_at: "2026-01-01T00:00:00Z",
      submitted_by: "test-operator",
      role: "diagnostic",
      harbor_revision: "dcd0a7ac",
      submission: {
        benchmark: { name: "example", preset: "example" },
        cost_ceiling_usd_per_trial: 1,
      },
      harbor_job_config: {},
    },
    state: {
      schema_version: "v1",
      run_id: "run-a",
      revision: 1,
      updated_at: "2026-01-01T00:00:00Z",
      desired_state: "run",
      actor: "test-operator",
      parent_jobs: [],
    },
    status: "finished",
    result: {
      n_total_trials: 89,
      stats: {
        n_completed_trials: 89,
        n_input_tokens: 1_234_567,
        n_output_tokens: 0,
        n_cache_tokens: 0,
      },
    },
  };
  const view = render(<RunSummaryCards run={run} />, { wrapper: MemoryRouter });
  expect(screen.getByText("100%")).toBeInTheDocument();
  expect(screen.getByText("89 / 89")).toBeInTheDocument();
  expect(screen.getByText("1.235M")).toBeInTheDocument();
  view.rerender(<RunSummaryCards run={{ ...run, result: null }} />);
  expect(screen.queryByText("100%")).not.toBeInTheDocument();
  expect(screen.getByText("- / -")).toBeInTheDocument();
});

it.each([
  [null, "-", "Reported cost (USD): unavailable"],
  [0, "$0.0000", "Reported cost (USD): 0"],
  [12.345, "$12.35", "Reported cost (USD): 12.345"],
] as const)("keeps compact exact cost %s on focus", (value, text, exact) => {
  render(<CostValue value={value} />);
  const output = screen.getByLabelText(exact);
  expect(output).toHaveTextContent(text);
  fireEvent.focus(output.closest("[tabindex]") as HTMLElement);
  expect(screen.getByRole("tooltip").textContent).toBe(exact);
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { RunPricingCorrections } from "../src/run-pricing-corrections";
import { RunSummaryCards } from "../src/run-summary-cards";
import { ControlStateProvider } from "../src/control-state";
import type { RunView } from "../src/api";
import { keys } from "../src/queries";

const id = "run-0123456789abcdef01234567";
const rates = {
  currency: "USD" as const,
  input_usd_per_million: 2,
  output_usd_per_million: 8,
  cached_usd_per_million: 0.5,
};
const initial: RunView = {
  record: {
    schema_version: "v1",
    run_id: id,
    created_at: "2026-01-01T00:00:00Z",
    submitted_by: "fixture-actor",
    role: "diagnostic",
    harbor_revision: "d".repeat(40),
    submission: {
      benchmark: { name: "fixture-benchmark", preset: "fixture-preset" },
      cost_ceiling_usd_per_trial: 1,
    },
    harbor_job_config: {},
  },
  state: {
    schema_version: "v1",
    run_id: id,
    revision: 0,
    updated_at: "2026-01-01T00:00:00Z",
    actor: "fixture-actor",
    desired_state: "run",
    parent_jobs: [],
  },
  status: "running",
  result: null,
  pricing_corrections: null,
  pricing_corrections_available: true,
};
const corrected: RunView = {
  ...initial,
  pricing_corrections: {
    schema_version: "v1",
    run_id: id,
    revisions: [
      {
        revision: 1,
        actor: "fixture-editor",
        updated_at: "2026-01-02T00:00:00Z",
        reason: "Add historical rates",
        pricing: rates,
      },
    ],
  },
  shared_estimate: {
    basis: "corrected_rates_reported_usage",
    cost_usd: 2.425,
    unavailable_reason: null,
  },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(
  run = initial,
  role: "operator" | "reader" = "operator",
  mode: "enabled" | "disabled" = "enabled",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (value: RunView) => (
    <QueryClientProvider client={client}>
      <ControlStateProvider
        actor={{ username: "fixture-user", role, transport: "session" }}
        writeMode={mode}
      >
        <RunPricingCorrections run={value} />
      </ControlStateProvider>
    </QueryClientProvider>
  );
  const rendered = render(wrap(run));
  return { client, rerender: (value: RunView) => rendered.rerender(wrap(value)) };
}
function edit(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function fill() {
  for (const [key, value] of [
    ["input", "2"],
    ["output", "8"],
    ["cached", "0.5"],
  ])
    edit(`Correction ${key} USD/M`, value ?? "");
  edit("Correction reason", "Add historical rates");
  fireEvent.click(screen.getByRole("checkbox"));
}
it("requires all rates, reason and renewed confirmation; saves only a guarded rate request and refreshes shared queries", async () => {
  const { client } = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(corrected.pricing_corrections), { status: 200 }),
    );
  vi.stubGlobal("fetch", fetch);
  fireEvent.click(
    screen.getByRole("button", { name: "Add shared rates (unpriced launch)" }),
  );
  const save = screen.getByRole("button", { name: "Save audited correction" });
  expect(save).toBeDisabled();
  fill();
  expect(save).toBeEnabled();
  edit("Correction cached USD/M", "");
  expect(save).toBeDisabled();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  edit("Correction cached USD/M", "0.5");
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.click(save);
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Save audited correction" }),
    ).toBeNull(),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe(`/api/v1/runs/${id}/pricing-corrections`);
  expect(JSON.parse(init.body)).toEqual({
    expected_revision: 0,
    reason: "Add historical rates",
    pricing: rates,
  });
  expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toEqual([
    keys.run(id),
    keys.runs,
    keys.leaderboard,
  ]);
});
it.each(["conflict", "refetch", "success-refetch"])(
  "blocks automatic retries after %s failures",
  async (failure) => {
    const { client } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    if (failure.includes("refetch"))
      invalidate.mockRejectedValue(new Error("read failed"));
    else invalidate.mockResolvedValue();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify(
            failure === "success-refetch"
              ? corrected.pricing_corrections
              : { error: { message: "Conflict" } },
          ),
          { status: failure === "success-refetch" ? 200 : 409 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    fireEvent.click(
      screen.getByRole("button", { name: "Add shared rates (unpriced launch)" }),
    );
    fill();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save audited correction" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Review refreshed history",
    );
    expect(
      screen.getByRole("button", { name: "Save audited correction" }),
    ).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Correction reason")).toBeNull();
  },
);
it("shows immutable/unpriced origin and history to readers while enforcing write availability", () => {
  setup({ ...corrected, pricing_corrections_available: false }, "reader");
  expect(
    screen.getByText(/Original launch: Launch pricing was not recorded/),
  ).toBeInTheDocument();
  expect(screen.getByText(/Revision 1/)).toHaveTextContent("fixture-editor");
  expect(screen.getByText(/Correction history unavailable/)).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  setup(corrected, "operator", "disabled");
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  setup({ ...corrected, pricing_corrections_available: false });
  expect(screen.getByRole("button", { name: "Correct shared rates" })).toBeDisabled();
});
it("captures draft revision and refuses stale intent after shared polling updates", () => {
  const { rerender } = setup();
  fireEvent.click(
    screen.getByRole("button", { name: "Add shared rates (unpriced launch)" }),
  );
  fill();
  rerender(corrected);
  expect(
    screen.getByRole("button", { name: "Save audited correction" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Correct shared rates" }));
  expect(screen.getByLabelText("Correction output USD/M")).toHaveValue(8);
  expect(screen.getByLabelText("Correction cached USD/M")).toHaveValue(0.5);
});
it("shows added historical estimates without launch metadata, and unavailable history never displays a launch amount", () => {
  const rendered = render(
    <MemoryRouter>
      <RunSummaryCards run={corrected} />
    </MemoryRouter>,
  );
  expect(screen.getByLabelText("Corrected estimate (USD): 2.425")).toBeInTheDocument();
  rendered.rerender(
    <MemoryRouter>
      <RunSummaryCards
        run={{
          ...corrected,
          pricing_corrections_available: false,
          shared_estimate: {
            basis: "effective_rates_reported_usage",
            cost_usd: null,
            unavailable_reason: "correction_history_unavailable",
          },
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.queryByLabelText("Corrected estimate (USD): 2.425")).toBeNull();
  expect(
    screen.getByText("Correction history unavailable — no launch fallback"),
  ).toBeInTheDocument();
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../src/api";
import { BrowsingResult, ReplacementEvidenceLabel } from "../src/result-browsing";
import {
  ResultBrowsingProvider,
  runsWithDirectChildren,
} from "../src/result-browsing-query";
import { RunReplacements } from "../src/run-replacements";

const native = (mean: number) => ({
  stats: {
    evals: { sample: { metrics: [{ mean }] } },
    n_input_tokens: 2_000_000,
    n_output_tokens: 300_000,
    n_cache_tokens: 1_000_000,
    cost_usd: 3,
  },
  trial_results: [
    { agent_result: { cost_usd: 3 } },
    { agent_result: { cost_usd: null } },
  ],
});
const run = { record: { run_id: "run-original" }, result: native(0.9) } as api.RunView;
const view: api.ReplacementView = {
  run_id: run.record.run_id,
  operator_selection: null,
  children: [
    {
      run_id: "run-child",
      status: "finished",
      operator_selection: {
        original_run_id: run.record.run_id,
        trial_ids: ["trial-one"],
        source_fingerprint: "synthetic",
      },
    },
  ],
  observed_at: "2026-01-01T00:00:00Z",
  assembly: { availability: "available", result: native(0.1) },
  selected_cost_usd: 999,
  incurred: {
    cost_usd: 8,
    total_attempts: 5,
    reported_attempts: 2,
    unknown_attempts: 3,
  },
};
const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(value);
  return value;
}
afterEach(() => {
  cleanup();
  for (const value of clients.splice(0)) value.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function show(value = client(), hasChildren = true) {
  return render(
    <QueryClientProvider client={value}>
      <ResultBrowsingProvider>
        <BrowsingResult run={run} hasChildren={hasChildren} />
      </ResultBrowsingProvider>
    </QueryClientProvider>,
  );
}
it("uses native Combined score, tokens and selected cost; incurred unknown attempts are separate", async () => {
  vi.spyOn(api, "getReplacements").mockResolvedValue(view);
  show();
  expect(await screen.findByText("Score · mean: 0.100")).toBeVisible();
  expect(screen.getByText("Input incl. cache: 2.000M")).toHaveAttribute(
    "title",
    "Input incl. cache tokens: 2000000",
  );
  expect(screen.getByText("Output: 0.300M")).toBeVisible();
  expect(screen.getByText("Cache (in input): 1.000M")).toBeVisible();
  expect(screen.getByText(/Selected reported cost/)).toHaveTextContent("$3");
  expect(screen.getByText(/All-incurred reported subtotal/)).toHaveTextContent(
    "3 unknown-cost / 5 observed attempts",
  );
  expect(screen.getByText(/All-incurred reported subtotal/)).toHaveTextContent("$8");
  expect(screen.queryByText(/0.900|999/)).not.toBeInTheDocument();
});
it("does not fetch original-only rows and states unknown coverage without native trial evidence", () => {
  const get = vi.spyOn(api, "getReplacements");
  const original = { ...run, result: { stats: native(0.9).stats } };
  render(
    <QueryClientProvider client={client()}>
      <BrowsingResult run={original} hasChildren={false} />
    </QueryClientProvider>,
  );
  expect(get).not.toHaveBeenCalled();
  expect(screen.getByText(/^Cost coverage unavailable/)).toBeVisible();
  expect(screen.getByText("Score · mean: 0.900")).toBeVisible();
});
it.each(["pending", "unavailable", "none"] as const)(
  "%s replacement evidence never falls back to the favorable Original",
  async (availability) => {
    vi.spyOn(api, "getReplacements").mockResolvedValue({
      ...view,
      observed_at: "2026-01-01T00:00:00Z",
      assembly: { availability, result: native(0.9) },
    });
    show();
    await screen.findByRole("button", { name: "Retry combined rollup" });
    expect(screen.queryByText(/Score · mean/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Input incl. cache:/)).not.toBeInTheDocument();
  },
);
it("shares fresh cached queries with run detail, hides failed refresh evidence and retries", async () => {
  const value = client();
  value.setQueryData(["replacements", run.record.run_id], view);
  const get = vi
    .spyOn(api, "getReplacements")
    .mockRejectedValueOnce(new Error("fresh inspection failed"))
    .mockResolvedValue(view);
  const mounted = render(
    <MemoryRouter>
      <QueryClientProvider client={value}>
        <ResultBrowsingProvider>
          <BrowsingResult run={run} hasChildren />
          <RunReplacements run={run} trials={[]} />
        </ResultBrowsingProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  expect(screen.getAllByText("Score · mean: 0.100")).toHaveLength(2);
  expect(get).not.toHaveBeenCalled();
  await act(async () => {
    await value.refetchQueries({ queryKey: ["replacements"] });
  });
  await waitFor(() =>
    expect(screen.queryByText("Score · mean: 0.100")).not.toBeInTheDocument(),
  );
  expect(screen.queryByText("Score · mean: 0.900")).not.toBeInTheDocument();
  fireEvent.click(
    within(screen.getByRole("region", { name: "Browsing native result" })).getByRole(
      "button",
      { name: "Retry combined rollup" },
    ),
  );
  await waitFor(() =>
    expect(screen.getAllByText("Score · mean: 0.100")).toHaveLength(2),
  );
  expect(get).toHaveBeenCalledTimes(2);
  mounted.unmount();
});
it("shows fresh cached evidence during refresh, then expires it rather than renewing its age", async () => {
  const value = client();
  value.setQueryData(["replacements", run.record.run_id], view);
  let finish = (_value: api.ReplacementView) => {};
  vi.spyOn(api, "getReplacements").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  show(value);
  await act(async () => {
    void value.refetchQueries({ queryKey: ["replacements"] });
  });
  expect(
    await screen.findByText(/last response while refreshing the projection view/),
  ).toBeVisible();
  expect(screen.getByText("Score · mean: 0.100")).toBeVisible();
  await act(async () => {
    value.setQueryData(["replacements", run.record.run_id], view, {
      updatedAt: Date.now() - 61_000,
    });
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "saved evidence has expired",
  );
  expect(screen.queryByText("Score · mean: 0.100")).not.toBeInTheDocument();
  await act(async () => {
    finish(view);
  });
  expect(await screen.findByText("Score · mean: 0.100")).toBeVisible();
});
it("discovers parents and recursive ancestors from full data and labels subset rows", () => {
  const child = {
    ...run,
    record: {
      ...run.record,
      run_id: "run-child",
      operator_selection: view.children[0]?.operator_selection,
    },
    presentation: { archived: true },
  } as api.RunView;
  const descendant = {
    ...child,
    record: {
      ...child.record,
      run_id: "run-grandchild",
      operator_selection: {
        ...view.children[0]?.operator_selection,
        original_run_id: "run-child",
      },
    },
  } as api.RunView;
  expect([...runsWithDirectChildren([run, child, descendant]).keys()]).toEqual([
    "run-original",
    "run-child",
  ]);
  const get = vi.spyOn(api, "getReplacements");
  render(
    <QueryClientProvider client={client()}>
      <BrowsingResult run={child} hasChildren={false} />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Original · replacement subset")).toBeVisible();
  expect(get).not.toHaveBeenCalled();
});
it("fences a fresh assembly immediately when a newly known child is absent, including after failure", async () => {
  const value = client();
  value.setQueryData(["replacements", run.record.run_id], view);
  let reject = (_reason: Error) => {};
  const get = vi.spyOn(api, "getReplacements").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  function tree(children: string[]) {
    return (
      <QueryClientProvider client={value}>
        <ResultBrowsingProvider>
          <BrowsingResult run={run} hasChildren knownChildren={children} />
        </ResultBrowsingProvider>
      </QueryClientProvider>
    );
  }
  const mounted = render(tree(["run-child"]));
  expect(screen.getByText("Score · mean: 0.100")).toBeVisible();
  expect(get).not.toHaveBeenCalled();
  mounted.rerender(tree(["run-child", "run-new-child"]));
  expect(screen.queryByText(/Score · mean/)).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("relationships changed");
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    reject(new Error("inspection failed"));
  });
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("inspection failed"),
  );
  expect(screen.queryByText(/Score · mean/)).not.toBeInTheDocument();
  get.mockResolvedValue(view);
  fireEvent.click(screen.getByRole("button", { name: "Retry combined rollup" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("relationships changed"),
  );
  expect(screen.queryByText(/Score · mean/)).not.toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(2);
  get.mockResolvedValue({
    ...view,
    children: [
      ...view.children,
      {
        run_id: "run-new-child",
        status: "finished",
        operator_selection: {
          original_run_id: run.record.run_id,
          trial_ids: ["trial-two"],
          source_fingerprint: "synthetic",
        },
      },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry combined rollup" }));
  expect(await screen.findByText("Score · mean: 0.100")).toBeVisible();
});
it("expires saved evidence on the shared clock while a refresh is hung", async () => {
  vi.useFakeTimers();
  const value = client();
  value.setQueryData(["replacements", run.record.run_id], view);
  let finish = (_view: api.ReplacementView) => {};
  vi.spyOn(api, "getReplacements").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  show(value);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(70_000);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("saved evidence has expired");
  expect(screen.queryByText(/Score · mean/)).not.toBeInTheDocument();
  expect(screen.queryByText(/All-incurred reported subtotal/)).not.toBeInTheDocument();
  await act(async () => {
    finish(view);
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByText("Score · mean: 0.100")).toBeVisible();
});

it("labels the projection observation without turning request time into evidence time", () => {
  const { container, rerender } = render(
    <ReplacementEvidenceLabel observedAt="2026-01-01T00:00:00Z" />,
  );
  expect(container.querySelector("time")).toHaveAttribute(
    "datetime",
    "2026-01-01T00:00:00Z",
  );
  expect(screen.getByText(/Not a live execution safety check/)).toBeVisible();
  rerender(<ReplacementEvidenceLabel observedAt={null} />);
  expect(screen.getByText(/not yet observed/)).toBeVisible();
  expect(container.querySelector("time")).toBeNull();
});

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
import { BrowserRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../src/api";
import { RunsPage } from "../src/pages";
import * as queries from "../src/queries";

const runs = ["parent", "child", "grandchild", "other"].map((name, i) => ({
  record: {
    run_id: `run-${name}`,
    role: "diagnostic",
    created_at: "2026-01-01T00:00:00Z",
    submission: {
      benchmark: { name: "synthetic-benchmark", preset: "sample" },
      model: { id: `model-${name}`, provider: "provider" },
      harness: { agent: "command-agent", version: "revision" },
    },
    harbor_job_config: { agents: [{ model_name: `model-${name}` }] },
    ...(i === 1 || i === 2
      ? {
          operator_selection: {
            original_run_id: i === 1 ? "run-parent" : "run-child",
            trial_ids: ["synthetic"],
            source_fingerprint: "synthetic",
          },
        }
      : {}),
  },
  status: "finished",
  presentation: { archived: i === 1 || i === 2 },
  result: {
    n_total_trials: 10,
    stats: { n_completed_trials: 7, evals: { sample: { metrics: [{ mean: 0.9 }] } } },
  },
})) as api.RunView[];
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});
it("uses hidden archived descendant relationships but requests only rendered parent summaries; sorting cannot use old scores", async () => {
  const refetch = vi.fn();
  vi.spyOn(queries, "useRuns").mockReturnValue({
    data: runs,
    isPending: false,
    isError: false,
    refetch,
  } as unknown as ReturnType<typeof queries.useRuns>);
  const progress = vi.spyOn(api, "getTrialProgress");
  const get = vi.spyOn(api, "getReplacements").mockResolvedValue({
    run_id: "run-parent",
    operator_selection: null,
    children: [
      {
        run_id: "run-child",
        status: "finished",
        operator_selection: {
          original_run_id: "run-parent",
          trial_ids: ["synthetic"],
          source_fingerprint: "synthetic",
        },
      },
    ],
    assembly: {
      availability: "available",
      result: { stats: { evals: { sample: { metrics: [{ mean: 0.1 }] } } } },
    },
    incurred: null,
    selected_cost_usd: null,
  });
  window.history.replaceState(null, "", "/runs");
  const client = new QueryClient();
  clients.push(client);
  render(
    <BrowserRouter>
      <QueryClientProvider client={client}>
        <RunsPage />
      </QueryClientProvider>
    </BrowserRouter>,
  );
  expect(await screen.findByText("Score · mean: 0.100")).toBeVisible();
  expect(get).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledWith("run-parent");
  expect(progress).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: /model-child/ })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /model-grandchild/ }),
  ).not.toBeInTheDocument();
  const resultHeader = screen.getByRole("columnheader", {
    name: "Native result · score / tokens / cost",
  });
  const order = () => screen.getAllByRole("row").map((row) => row.textContent);
  const before = order();
  fireEvent.click(within(resultHeader).getByRole("button"));
  expect(order()).toEqual(before);
  fireEvent.click(within(resultHeader).getByRole("button"));
  expect(order()).toEqual(before);
  expect(screen.getByRole("columnheader", { name: /Original progress/ })).toBeVisible();
  expect(
    screen.getByRole("columnheader", { name: /Original · shared estimate/ }),
  ).toBeVisible();
  expect(
    screen.getByRole("columnheader", { name: /Original · scenario estimate/ }),
  ).toBeVisible();
  expect(screen.getAllByText("7 / 10")).toHaveLength(2);
  // Explicit Refresh must bypass the still-fresh 30-second inspection cache,
  // but a second click must not cancel and duplicate the in-flight request.
  let fail = (_error: Error) => {};
  get.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(refetch).toHaveBeenCalledWith({ cancelRefetch: false });
  expect(get).toHaveBeenCalledTimes(3);
  await act(async () => {
    fail(new Error("fresh inspection failed"));
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("fresh inspection failed");
  expect(screen.queryByText("Score · mean: 0.100")).not.toBeInTheDocument();
  expect(screen.getAllByText("Score · mean: 0.900")).toHaveLength(1);

  fireEvent.change(screen.getByLabelText("Filter model"), {
    target: { value: "model-other" },
  });
  expect(screen.queryByText("Score · mean: 0.100")).not.toBeInTheDocument();
  expect(screen.getByText("Score · mean: 0.900")).toBeVisible();
  expect(
    client
      .getQueryCache()
      .find({ queryKey: ["replacements", "run-parent"] })
      ?.isActive(),
  ).toBe(false);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  });
  expect(get).toHaveBeenCalledTimes(3);
});

it("fences an ancestor when a hidden child's new child is pending, and rechecks after an older flight", async () => {
  const useRuns = vi.spyOn(queries, "useRuns");
  const list = (data: api.RunView[]) =>
    useRuns.mockReturnValue({
      data,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof queries.useRuns>);
  list(runs.filter((run) => run.record.run_id !== "run-grandchild"));
  const old: api.ReplacementView = {
    run_id: "run-parent",
    operator_selection: null,
    children: [
      {
        run_id: "run-child",
        status: "finished",
        operator_selection: {
          original_run_id: "run-parent",
          trial_ids: ["synthetic"],
          source_fingerprint: "synthetic",
        },
      },
    ],
    assembly: {
      availability: "available",
      result: { stats: { evals: { sample: { metrics: [{ mean: 0.1 }] } } } },
    },
    incurred: null,
    selected_cost_usd: null,
  };
  const client = new QueryClient();
  clients.push(client);
  client.setQueryData(["replacements", "run-parent"], old);
  const finishes: Array<(view: api.ReplacementView) => void> = [];
  const get = vi
    .spyOn(api, "getReplacements")
    .mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
  window.history.replaceState(null, "", "/runs");
  const tree = () => (
    <BrowserRouter>
      <QueryClientProvider client={client}>
        <RunsPage />
      </QueryClientProvider>
    </BrowserRouter>
  );
  const mounted = render(tree());
  expect(screen.getByText("Score · mean: 0.100")).toBeVisible();
  await act(async () => {
    void client.refetchQueries({ queryKey: ["replacements"] });
  });
  list(runs);
  mounted.rerender(tree());
  expect(screen.queryByText("Score · mean: 0.100")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /model-child/ })).not.toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(1);
  // Further discovery during the same flight must remain bounded and must not
  // let the first observation's completion certify the newer relationship.
  const descendant = runs.find((run) => run.record.run_id === "run-grandchild");
  if (!descendant) throw new Error("Missing synthetic descendant");
  list([
    ...runs,
    {
      ...descendant,
      record: {
        ...descendant.record,
        run_id: "run-new-descendant",
        operator_selection: {
          original_run_id: "run-grandchild",
          trial_ids: ["synthetic"],
          source_fingerprint: "synthetic",
        },
      },
    },
  ]);
  mounted.rerender(tree());
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishes.shift()?.(old);
  });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Score · mean: 0.100")).not.toBeInTheDocument();
  await act(async () => {
    finishes.shift()?.({ ...old, assembly: { availability: "pending", result: null } });
  });
  expect(await screen.findByText(/Combined pending:/)).toBeVisible();
  expect(screen.queryByText("Score · mean: 0.100")).not.toBeInTheDocument();
});

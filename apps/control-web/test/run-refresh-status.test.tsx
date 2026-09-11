// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { keys } from "../src/queries";
import { ConsolidatedRunRefresh, RunRefreshStatus } from "../src/run-refresh-status";
import { RunSectionQuery } from "../src/run-section-query";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
});
function show(runId = "run-a") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <RunRefreshStatus runId={runId} />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

it("observes existing queries without starting any requests", () => {
  const { client } = show();
  expect(screen.getByRole("region", { name: "Refresh status" })).toBeVisible();
  expect(screen.getAllByText("Waiting…")).toHaveLength(4);
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});

it("shows response age independently per section and advances the display clock", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
  const { client } = show();
  act(() => {
    client.setQueryData(keys.run("run-a"), {}, { updatedAt: Date.now() - 20_000 });
    client.setQueryData(keys.trials("run-a"), [], { updatedAt: Date.now() - 70_000 });
  });
  const run = within(screen.getByLabelText("Run details refresh"));
  expect(run.getByText("Received 20s ago")).toBeVisible();
  expect(screen.getByText("Received 1m ago")).toBeVisible();
  act(() => vi.advanceTimersByTime(10_000));
  expect(run.getByText("Received 30s ago")).toBeVisible();
  expect(client.isFetching()).toBe(0);
});

it("keeps saved response age visible through a refresh and retries a failed request", async () => {
  const { client } = show();
  const key = keys.run("run-a");
  act(() => client.setQueryData(key, { saved: true }));
  let reject: (error: Error) => void = () => {};
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue({ saved: false });
  let request: Promise<unknown>;
  act(() => {
    request = client.fetchQuery({ queryKey: key, queryFn: fetch });
  });
  const run = within(screen.getByLabelText("Run details refresh"));
  expect(run.getByText("Refreshing…")).toBeVisible();
  expect(run.getByText(/Received/)).toBeVisible();
  await act(async () => {
    reject(new Error("Unavailable"));
    await request.catch(() => undefined);
  });
  expect(run.getByText("Refresh failed · saved data")).toBeVisible();
  expect(client.getQueryData(key)).toEqual({ saved: true });
  await act(async () =>
    fireEvent.click(run.getByRole("button", { name: "Retry Run details" })),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(run.getByText("Idle")).toBeVisible();
});

it("distinguishes initial loading and failure from saved data", async () => {
  const { client } = show();
  let reject: (error: Error) => void = () => {};
  let request: Promise<unknown>;
  act(() => {
    request = client.fetchQuery({
      queryKey: keys.trials("run-a"),
      queryFn: () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    });
  });
  const trials = within(screen.getByLabelText("Trials refresh"));
  expect(trials.getByText("Loading…")).toBeVisible();
  await act(async () => {
    reject(new Error("Unavailable"));
    await request.catch(() => undefined);
  });
  expect(trials.getByText("Unavailable")).toBeVisible();
  expect(trials.getByText("No response yet")).toBeVisible();
  expect(trials.getByRole("button", { name: "Retry Trials" })).toBeEnabled();
});

it("does not carry response age across run navigation", () => {
  const { client, rerender } = show();
  act(() => client.setQueryData(keys.run("run-a"), {}));
  expect(screen.getByText(/Received/)).toBeVisible();
  rerender(
    <QueryClientProvider client={client}>
      <RunRefreshStatus runId="run-b" />
    </QueryClientProvider>,
  );
  expect(screen.queryByText(/Received/)).not.toBeInTheDocument();
});

it("removes section feedback slots only inside the consolidated detail view", () => {
  const query = {
    data: [] as unknown,
    error: null,
    isPending: false,
    isFetching: true,
    refetch: vi.fn(async () => {}),
  };
  const { rerender } = render(
    <ConsolidatedRunRefresh.Provider value={true}>
      <RunSectionQuery label="trials" query={query}>
        Saved trial
      </RunSectionQuery>
    </ConsolidatedRunRefresh.Provider>,
  );
  expect(screen.getByText("Saved trial")).toBeVisible();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  rerender(
    <ConsolidatedRunRefresh.Provider value={true}>
      <RunSectionQuery
        label="trials"
        query={{ ...query, data: undefined, isPending: true }}
      >
        No trials
      </RunSectionQuery>
    </ConsolidatedRunRefresh.Provider>,
  );
  expect(screen.queryByText("No trials")).not.toBeInTheDocument();
});

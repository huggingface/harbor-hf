// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RunView, TrialProgress } from "../src/api";
import { RunsWaffle } from "../src/runs-waffle";

const clients: QueryClient[] = [];
function run(id = "run-a"): RunView {
  return {
    record: { run_id: id },
    status: "running",
    result: {
      updated_at: new Date().toISOString(),
      stats: { n_pending_trials: 4, n_running_trials: 0, n_completed_trials: 1 },
    },
  } as RunView;
}
function progress(count = 5): TrialProgress {
  const task = { name: "task-a", digest: "sha256:input" };
  return {
    observed_at: new Date().toISOString(),
    jobs_observed_at: new Date().toISOString(),
    jobs: [],
    lock: { trials: Array.from({ length: count }, () => ({ task })) },
    trials: [
      {
        trial_name: "trial-a",
        config: { trial_name: "trial-a" },
        lock: { task },
        result: { finished_at: "2026-09-08T12:00:00Z" },
        reward: 0,
        cost_usd: null,
      },
    ],
  };
}
function show(runs: RunView[], values: Record<string, TrialProgress> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  for (const [id, value] of Object.entries(values))
    client.setQueryData(["trial-progress", id], value);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RunsWaffle runs={runs} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

it("renders one run per row with five distinct repeated trial squares and focus details", async () => {
  show([run(), run("run-b")], { "run-a": progress(), "run-b": progress() });
  expect(screen.getAllByRole("rowheader")).toHaveLength(2);
  expect(screen.getAllByRole("columnheader")).toHaveLength(6);
  const zero = screen.getByRole("link", { name: "trial-a in run-a: Zero reward" });
  expect(zero).toHaveAttribute("href", "/runs/run-a/trials/trial-a");
  act(() => zero.focus());
  expect(screen.getByRole("tooltip")).toHaveTextContent("not an attempt ordinal");
  expect(screen.getByRole("tooltip")).toHaveTextContent("Reward: 0");
  const row = zero.closest("tr");
  if (!row) throw Error("row missing");
  expect(within(row).getAllByRole("button")).toHaveLength(4);
});
it("bounds queries and columns and supports both page axes and search", async () => {
  const values = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [`run-${index}`, progress(51)]),
  );
  const fetch = vi.fn(async () => new Response(JSON.stringify(progress())));
  vi.stubGlobal("fetch", fetch);
  show(
    Object.keys(values).map((id) => run(id)),
    values,
  );
  expect(screen.getAllByRole("rowheader")).toHaveLength(8);
  expect(screen.getAllByRole("columnheader")).toHaveLength(51);
  expect(fetch).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Next trials" }));
  expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Previous trials" }));
  await user.click(screen.getByRole("button", { name: "Next runs" }));
  expect(screen.getAllByRole("rowheader")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Previous runs" }));
  await user.type(screen.getByRole("searchbox"), "no-match");
  expect(screen.getByText("No trials match your search.")).toBeVisible();
});
it("shows unavailable and cached-stale observations and retries", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 403 })),
  );
  const client = show([run(), run("run-b")], { "run-a": progress() });
  expect(await screen.findByText("Unavailable")).toBeVisible();
  await act(() => client.invalidateQueries({ queryKey: ["trial-progress", "run-a"] }));
  expect(await screen.findByText("Stale data")).toBeVisible();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(progress()))),
  );
  const retry = screen.getAllByRole("button", { name: "Retry" })[0];
  if (!retry) throw new Error("Retry button missing");
  await userEvent.setup().click(retry);
});
it("shows provider queue observations separately without attributing them to squares", async () => {
  const value = progress();
  value.jobs.push({
    id: "child-test",
    run_id: "run-a",
    role: "trial",
    stage: "queued",
    created_at: value.observed_at,
    started_at: null,
    finished_at: null,
  });
  show([run()], { "run-a": value });
  await userEvent
    .setup()
    .click(screen.getByText("HF Jobs and Harbor totals (separate observations)"));
  expect(screen.getByText("trial · child-test · queued (waiting at HF)")).toBeVisible();
});
it("shows absent cells, no prepared lock, and empty run lists honestly", () => {
  const value = progress();
  value.lock = null;
  value.trials = [];
  show([run(), run("run-b")], { "run-a": progress(), "run-b": value });
  expect(screen.getAllByRole("img", { name: "Unknown / not observed" })).toHaveLength(
    5,
  );
  cleanup();
  show([run()], { "run-a": value });
  expect(
    screen.getByText("No trial artifacts or prepared lock observed yet."),
  ).toBeVisible();
  cleanup();
  show([]);
  expect(screen.getByText("No runs are available")).toBeVisible();
});

it("renders nine independently linked identities for three repeated source names", () => {
  const value = progress();
  const template = value.trials[0];
  if (!template) throw new Error("missing fixture");
  value.trials = ["task-a", "task-b", "task-c"].flatMap((name) =>
    Array.from({ length: 3 }, (_, repeat) => ({
      ...template,
      trial_name: `${name}__native${repeat}`,
      lock: { task: { name, digest: "sha256:input" } },
      reward: repeat,
    })),
  );
  value.lock = {
    trials: value.trials.map((trial) => ({
      task: trial.lock?.task ?? { name: "unknown", digest: "unknown" },
    })),
  };
  show([run()], { "run-a": value });
  expect(screen.getAllByRole("columnheader")).toHaveLength(10);
  for (const trial of value.trials) {
    expect(
      screen.getByRole("link", {
        name: `${trial.trial_name} in run-a: ${trial.reward === 0 ? "Zero reward" : "Completed"}`,
      }),
    ).toHaveAttribute("href", `/runs/run-a/trials/${trial.trial_name}`);
  }
});

it("shows loading without inventing pending trials before any artifact response", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  show([run()]);
  expect(screen.getByText("Loading trial artifacts…")).toBeVisible();
  expect(screen.getAllByRole("columnheader")).toHaveLength(1);
});

it("expires cached active observations while a refresh remains fetching", async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const value = progress();
    const trial = value.trials[0];
    if (!trial) throw new Error("missing fixture");
    trial.result = null;
    value.jobs.push({
      id: "parent-test",
      run_id: "run-a",
      role: "parent",
      stage: "running",
      created_at: value.observed_at,
      started_at: value.observed_at,
      finished_at: null,
    });
    const client = show([run()], { "run-a": value });
    expect(
      screen.getByRole("button", {
        name: "trial-a in run-a: Unfinished artifact observed (live state unknown)",
      }),
    ).toBeVisible();
    act(() => {
      void client.invalidateQueries({ queryKey: ["trial-progress", "run-a"] });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(screen.getByText("Refreshing…")).toBeVisible();
    expect(screen.getByText("Stale data")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "trial-a in run-a: Uncertain / interrupted" }),
    ).toBeVisible();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it("only establishes exclusion from a lock, not a repetition count or successful empty response", () => {
  const excluded = progress();
  excluded.trials = [];
  excluded.lock = { trials: [] };
  const sameTask = progress(0);
  sameTask.trials = [];
  sameTask.lock = { trials: [{ task: { name: "task-a", digest: "sha256:input" } }] };
  show([run(), run("run-b"), run("run-c")], {
    "run-a": progress(),
    "run-b": excluded,
    "run-c": sameTask,
  });
  expect(screen.getAllByRole("img", { name: "Not in run" })).toHaveLength(5);
  expect(screen.getAllByRole("img", { name: "Unknown / not observed" })).toHaveLength(
    4,
  );
});

it("keeps the same native DOM identity and position across incremental polls and removals", async () => {
  const value = progress(3);
  const template = value.trials[0];
  if (!template) throw new Error("missing fixture");
  value.trials = [{ ...template, trial_name: "trial-z" }];
  const client = show([run()], { "run-a": value });
  const original = screen.getByRole("link", { name: "trial-z in run-a: Zero reward" });
  const update = async (names: string[]) => {
    await act(async () => {
      client.setQueryData(["trial-progress", "run-a"], {
        ...value,
        trials: names.map((trial_name) => ({ ...template, trial_name })),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  await update(["trial-a", "trial-z"]);
  expect(screen.getByRole("link", { name: "trial-z in run-a: Zero reward" })).toBe(
    original,
  );
  expect(original.closest("td")?.cellIndex).toBe(1);
  const arrived = screen.getByRole("link", { name: "trial-a in run-a: Zero reward" });
  expect(arrived.closest("td")?.cellIndex).toBe(2);
  await update(["trial-a"]);
  expect(
    screen.queryByRole("link", { name: "trial-z in run-a: Zero reward" }),
  ).toBeNull();
  expect(screen.getByRole("link", { name: "trial-a in run-a: Zero reward" })).toBe(
    arrived,
  );
  expect(arrived.closest("td")?.cellIndex).toBe(2);
});

it("polls terminal rows less often while keeping active rows responsive", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn(
      async (_url: string) => new Response(JSON.stringify(progress())),
    );
    vi.stubGlobal("fetch", fetch);
    show([run(), { ...run("run-b"), status: "finished" }], {
      "run-a": progress(),
      "run-b": progress(),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("run-a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(105_000);
    });
    expect(
      fetch.mock.calls.filter((args) => String(args[0]).includes("run-b")),
    ).toHaveLength(1);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it("reports separate observations without consuming planned capacity or retaining another target's focus", async () => {
  const value = progress(9);
  const template = value.trials[0];
  if (!template) throw Error("fixture missing");
  const client = show([run()], { "run-a": value });
  const original = screen.getByRole("link", { name: "trial-a in run-a: Zero reward" });
  act(() => original.focus());
  act(() => client.setQueryData(["trial-progress", "run-a"], { ...value, trials: [] }));
  expect(
    await screen.findByText("run-a: 9 planned squares · 1 separate observations"),
  ).toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByText("run-a: 9 planned squares · 1 separate observations"));
  expect(screen.getByText("trial-a: Removed observation")).toBeVisible();
  act(() =>
    client.setQueryData(["trial-progress", "run-a"], {
      ...value,
      trials: [{ ...template, trial_name: "replacement" }],
    }),
  );
  expect(screen.getAllByRole("columnheader")).toHaveLength(10);
  expect(
    await screen.findByRole("link", { name: "replacement in run-a: Zero reward" }),
  ).not.toHaveFocus();
  expect(screen.getByText("trial-a: Removed observation")).toBeVisible();
  act(() => client.setQueryData(["trial-progress", "run-a"], value));
  expect(await screen.findByText("replacement: Removed observation")).toBeVisible();
  expect(screen.queryByText("trial-a: Removed observation")).not.toBeInTheDocument();
});

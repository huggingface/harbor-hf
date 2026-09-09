// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RunView, TrialProgress } from "../src/api";
import { RunWaffle } from "../src/runs-waffle";

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
function show(item: RunView, values: Record<string, TrialProgress> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  for (const [id, value] of Object.entries(values))
    client.setQueryData(["trial-progress", id], value);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RunWaffle run={item} />
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

it("renders one task column with five distinct repetition rows and focus details", async () => {
  show(run(), { "run-a": progress() });
  expect(screen.getAllByRole("rowheader")).toHaveLength(5);
  expect(screen.getAllByRole("cell")).toHaveLength(5);
  const zero = screen.getByRole("link", { name: "trial-a in run-a: Zero reward" });
  expect(zero).toHaveAttribute("href", "/runs/run-a/trials/trial-a");
  act(() => zero.focus());
  expect(screen.getByRole("tooltip")).not.toHaveTextContent("not an attempt ordinal");
  expect(screen.getByRole("tooltip").textContent).toBe(
    "Task: task-a\nRepeat slot: 1\nState: Zero reward\nReward: 0.000",
  );
  expect(screen.getByRole("tooltip")).not.toHaveTextContent("Artifact observation");
  const row = zero.closest("tr");
  if (!row) throw Error("row missing");
  expect(within(row).getAllByRole("cell")).toHaveLength(1);
});
it.each([1, 5])(
  "shows 89 task columns and %i complete repeat rows",
  async (repeats) => {
    const value = progress();
    value.lock = {
      trials: Array.from({ length: 89 }, (_, index) =>
        Array.from({ length: repeats }, () => ({
          task: {
            name: `task-${String(index).padStart(2, "0")}`,
            digest: "sha256:input",
          },
        })),
      ).flat(),
    };
    show(run(), { "run-a": value });
    expect(screen.getAllByRole("columnheader")).toHaveLength(90);
    expect(screen.getAllByRole("rowheader")).toHaveLength(repeats);
    expect(screen.getAllByRole("cell")).toHaveLength(89 * repeats);
    for (const header of screen.getAllByRole("rowheader")) {
      const row = header.closest("tr");
      if (!row) throw Error("row missing");
      expect(within(row).getAllByRole("cell")).toHaveLength(89);
    }
    const user = userEvent.setup();
    const header = screen.getByRole("button", { name: /Task 89: task-88/ });
    await user.hover(within(header).getByText("89"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("task-88");
    await user.unhover(within(header).getByText("89"));
    act(() => header.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent(/^task-88$/);
    await user.type(screen.getByRole("searchbox"), "task-88");
    expect(screen.getAllByRole("rowheader")).toHaveLength(repeats);
    expect(screen.getAllByRole("cell")).toHaveLength(repeats);
    expect(screen.getByRole("button", { name: /Task 89: task-88/ })).toHaveTextContent(
      "89",
    );
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "no-match");
    expect(screen.queryAllByRole("rowheader")).toHaveLength(0);
    expect(screen.getByText("No trials match your search.")).toBeVisible();
  },
);
it("paginates whole task columns at 100 without hiding repeat rows", async () => {
  const value = progress();
  value.lock = {
    trials: Array.from({ length: 101 }, (_, index) =>
      Array.from({ length: 5 }, () => ({
        task: { name: `task-${String(index).padStart(3, "0")}`, digest: "input" },
      })),
    ).flat(),
  };
  show(run(), { "run-a": value });
  expect(screen.getAllByRole("cell")).toHaveLength(500);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Next tasks" }));
  expect(screen.getAllByRole("cell")).toHaveLength(5);
  expect(screen.getAllByRole("rowheader")).toHaveLength(5);
  await user.click(screen.getByRole("button", { name: "Previous tasks" }));
  expect(screen.getAllByRole("cell")).toHaveLength(500);
  await user.type(screen.getByRole("searchbox"), "task-100");
  expect(screen.getAllByRole("cell")).toHaveLength(5);
});
it("shows unavailable and cached-stale observations and retries", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 403 })),
  );
  show(run());
  expect(await screen.findByText("Unavailable")).toBeVisible();
  cleanup();
  const client = show(run(), { "run-a": progress() });
  await act(() => client.invalidateQueries({ queryKey: ["trial-progress", "run-a"] }));
  expect(await screen.findByText("Stale data")).toBeVisible();
  act(() =>
    screen.getByRole("link", { name: "trial-a in run-a: Zero reward" }).focus(),
  );
  expect(screen.getByRole("tooltip").textContent).toBe(
    "Stale — refresh failed\nTask: task-a\nRepeat slot: 1\nState: Zero reward\nReward: 0.000",
  );
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
  show(run(), { "run-a": value });
  await userEvent
    .setup()
    .click(screen.getByText("HF Jobs and Harbor totals (separate observations)"));
  expect(screen.getByText("trial · child-test · queued (waiting at HF)")).toBeVisible();
});
it("shows no prepared lock honestly without inventing squares", () => {
  const value = progress();
  value.lock = null;
  value.trials = [];
  show(run(), { "run-a": value });
  expect(
    screen.getByText("No trial artifacts or prepared lock observed yet."),
  ).toBeVisible();
  expect(screen.queryAllByRole("cell")).toHaveLength(0);
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
  show(run(), { "run-a": value });
  expect(screen.getAllByRole("cell")).toHaveLength(9);
  expect(screen.getAllByRole("rowheader")).toHaveLength(3);
  expect(screen.getByText("3 tasks × 3 repeat slots · 9 planned")).toBeVisible();
  for (const [index, task] of ["task-a", "task-b", "task-c"].entries()) {
    expect(
      screen.getByRole("columnheader", { name: `${task} sha256:input` }),
    ).toBeVisible();
    for (const header of screen.getAllByRole("rowheader")) {
      const row = header.closest("tr");
      if (!row) throw Error("row missing");
      const cells = within(row).getAllByRole("cell");
      expect(cells).toHaveLength(3);
      const cell = cells[index];
      if (!cell) throw Error("cell missing");
      expect(within(cell).getByRole("link")).toHaveAttribute(
        "href",
        expect.stringContaining(task),
      );
    }
  }
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
  show(run());
  expect(screen.getByText("Loading trial artifacts…")).toBeVisible();
  expect(screen.queryAllByRole("cell")).toHaveLength(0);
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
    const client = show(run(), { "run-a": value });
    expect(
      screen.getByRole("button", {
        name: "trial-a in run-a: Unfinished",
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
      screen.getByRole("button", { name: "trial-a in run-a: Unknown / interrupted" }),
    ).toBeVisible();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it("uses only this run's lock capacity, including an empty lock", () => {
  const value = progress();
  value.lock = { trials: [] };
  show(run(), { "run-a": value });
  expect(screen.queryAllByRole("cell")).toHaveLength(0);
  expect(screen.getByText(/0 planned squares · 1 separate observations/)).toBeVisible();
});

it("keeps the same native DOM identity and position across incremental polls and removals", async () => {
  const value = progress(3);
  const template = value.trials[0];
  if (!template) throw new Error("missing fixture");
  value.trials = [{ ...template, trial_name: "trial-z" }];
  const client = show(run(), { "run-a": value });
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
  expect(arrived.closest("td")?.cellIndex).toBe(1);
  expect(arrived.closest("tr")?.rowIndex).toBe(2);
  await update(["trial-a"]);
  expect(
    screen.queryByRole("link", { name: "trial-z in run-a: Zero reward" }),
  ).toBeNull();
  expect(screen.getByRole("link", { name: "trial-a in run-a: Zero reward" })).toBe(
    arrived,
  );
  expect(arrived.closest("td")?.cellIndex).toBe(1);
  expect(arrived.closest("tr")?.rowIndex).toBe(2);
});

it.each([
  ["running", 15_000],
  ["finished", 120_000],
] as const)("polls %s runs at their own interval", async (status, interval) => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn(async () => new Response(JSON.stringify(progress())));
    vi.stubGlobal("fetch", fetch);
    show({ ...run(), status }, { "run-a": progress() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(interval - 1);
    });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it("reports separate observations without consuming planned capacity or retaining another target's focus", async () => {
  const value = progress(9);
  const template = value.trials[0];
  if (!template) throw Error("fixture missing");
  const client = show(run(), { "run-a": value });
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
  expect(screen.getAllByRole("cell")).toHaveLength(9);
  expect(
    await screen.findByRole("link", { name: "replacement in run-a: Zero reward" }),
  ).not.toHaveFocus();
  expect(screen.getByText("trial-a: Removed observation")).toBeVisible();
  act(() => client.setQueryData(["trial-progress", "run-a"], value));
  expect(await screen.findByText("replacement: Removed observation")).toBeVisible();
  expect(screen.queryByText("trial-a: Removed observation")).not.toBeInTheDocument();
});

it("shows native exception evidence without interpreting rewards or missing evidence", async () => {
  const data = progress(3);
  const first = data.trials[0];
  if (!first) throw Error("fixture missing");
  first.result = {
    finished_at: "2026-09-08T12:00:00Z",
    exception_info: { exception_type: "RuntimeError" },
  };
  data.trials.push(
    {
      ...first,
      trial_name: "trial-null",
      result: { finished_at: "2026-09-08T12:00:00Z", exception_info: null },
    },
    {
      ...first,
      trial_name: "trial-unknown",
      result: { finished_at: "2026-09-08T12:00:00Z" },
    },
  );
  show(run(), { "run-a": data });
  const error = screen.getByRole("link", { name: "trial-a in run-a: Errored" });
  expect(error).toHaveAttribute("href", "/runs/run-a/trials/trial-a");
  act(() => error.focus());
  expect(screen.getByRole("tooltip")).toHaveTextContent("Exception: RuntimeError");
  expect(screen.getByRole("tooltip")).toHaveTextContent("Reward: 0");
  expect(screen.getByRole("tooltip")).not.toHaveTextContent(
    "Infrastructure classification: unknown",
  );
  const user = userEvent.setup();
  await user.click(screen.getByText(/3 planned squares/));
  const evidence = screen.getByRole("list", {
    name: "Native trial exception evidence",
  });
  expect(evidence).toHaveTextContent("Native exception: RuntimeError");
  expect(evidence).toHaveTextContent(
    "No recorded exception (not proof of valid scoring)",
  );
  expect(evidence).toHaveTextContent(
    "Native exception evidence: unknown / unavailable",
  );
  await user.type(screen.getByRole("searchbox"), "RuntimeError");
  expect(screen.getAllByRole("cell")).toHaveLength(3);
  expect(
    screen.getByRole("link", { name: "trial-null in run-a: Zero reward" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "trial-unknown in run-a: Zero reward" }),
  ).toBeVisible();
});

it("links recorded unfinished exception evidence without claiming completion", () => {
  const data = progress(1);
  const first = data.trials[0];
  if (!first) throw Error("fixture missing");
  first.result = { exception_info: { exception_type: "CustomException" } };
  show(run(), { "run-a": data });
  const link = screen.getByRole("link", {
    name: "trial-a in run-a: Unfinished",
  });
  expect(link).toHaveAttribute("href", "/runs/run-a/trials/trial-a");
  expect(link).toHaveAttribute("aria-description", "Native exception: CustomException");
});

it("resets search, tooltips and removed-observation memory when navigating runs", async () => {
  const client = new QueryClient();
  clients.push(client);
  client.setQueryData(["trial-progress", "run-a"], progress());
  client.setQueryData(["trial-progress", "run-b"], progress());
  const view = (id: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RunWaffle run={run(id)} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const { rerender } = render(view("run-a"));
  const original = screen.getByRole("link", { name: "trial-a in run-a: Zero reward" });
  act(() => original.focus());
  expect(screen.getByRole("tooltip")).toBeVisible();
  await act(async () => {
    client.setQueryData(["trial-progress", "run-a"], { ...progress(), trials: [] });
  });
  await screen.findByText(/1 separate observations/);
  await userEvent.setup().type(screen.getByRole("searchbox"), "no-match");
  rerender(view("run-b"));
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "trial-a in run-b: Zero reward" }),
  ).not.toHaveFocus();
  rerender(view("run-a"));
  expect(screen.getByText(/0 separate observations/)).toBeVisible();
});

it("keeps digest columns separate and ragged slots unplanned with partial observations", () => {
  const value = progress(1);
  value.lock = {
    trials: [
      ...Array.from({ length: 4 }, () => ({
        task: { name: "task-a", digest: "sha256:input" },
      })),
      ...Array.from({ length: 2 }, () => ({
        task: { name: "task-a", digest: "other-input" },
      })),
      ...Array.from({ length: 3 }, () => ({
        task: { name: "task-b", digest: "sha256:input" },
      })),
    ],
  };
  show(run(), { "run-a": value });
  expect(screen.getByText("3 tasks × 4 repeat slots · 9 planned")).toBeVisible();
  expect(screen.getAllByRole("rowheader")).toHaveLength(4);
  expect(screen.getAllByRole("cell")).toHaveLength(12);
  expect(screen.getAllByRole("cell", { name: /Not planned/ })).toHaveLength(3);
  expect(screen.getAllByRole("button", { name: /No mapped observation/ })).toHaveLength(
    8,
  );
  expect(
    screen.getByRole("columnheader", { name: "task-a other-input" }),
  ).toBeVisible();
  expect(
    screen.getByRole("columnheader", { name: "task-a sha256:input" }),
  ).toBeVisible();
});

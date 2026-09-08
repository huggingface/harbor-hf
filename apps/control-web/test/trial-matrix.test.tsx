// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunList, TaskList } from "../src/api";
import { keys } from "../src/queries";
import { RunsMatrix } from "../src/runs-matrix";
import {
  type MatrixTask,
  trialDescription,
  trialKey,
  trialState,
} from "../src/trial-matrix";

function task(overrides: Partial<MatrixTask> = {}): MatrixTask {
  return {
    run_id: "run-a",
    task_id: "trial-a",
    input_digest: "sha256:input-a",
    terminal_outcome: null,
    selected_attempt_id: null,
    reward: null,
    attempt_count: 0,
    latest_outcome: null,
    last_attempt_at: null,
    cost_microusd: 0,
    pending_job_state: null,
    ...overrides,
  };
}
function run(run_id = "run-a"): RunList["items"][number] {
  return {
    run_id,
    created_at: "2026-09-08T00:00:00Z",
    status: "active",
    ceiling_microusd: 0,
    reserved_microusd: 0,
    observed_microusd: 0,
    budget_exceeded: false,
    total_tasks: 2,
    terminal_tasks: 1,
    admissible_tasks: 1,
    invalid_selected_tasks: 0,
    exhausted_tasks: 0,
    successful_tasks: 1,
    pending_actions: 0,
    replacement_assigned_tasks: 0,
    replacement_recorded_tasks: 0,
    publication_status: null,
    cleanup_pending: false,
    cancellation_requested: false,
    paused: false,
  };
}
const clients: QueryClient[] = [];
function show(runs: RunList["items"], tasks: Record<string, MatrixTask[]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  for (const [id, items] of Object.entries(tasks))
    client.setQueryData<TaskList>(keys.tasks(id), { items, next_cursor: null });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RunsMatrix runs={runs} />
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

describe("trial states", () => {
  it.each([
    [{}, "queued"],
    [{ pending_job_state: "RUNNING" }, "running"],
    [{ pending_job_state: "SCHEDULING" }, "queued"],
    [{ pending_job_state: "PENDING" }, "queued"],
    [{ pending_job_state: "STARTING" }, "queued"],
    [{ pending_job_state: "QUEUED" }, "queued"],
    [{ terminal_outcome: "complete", reward: 1 }, "completed"],
    [{ terminal_outcome: "complete", reward: 0.5 }, "completed"],
    [{ terminal_outcome: "complete", reward: null }, "completed"],
    [{ terminal_outcome: "complete", reward: 0 }, "zero"],
    [{ terminal_outcome: "infrastructure", reward: 0 }, "errored"],
    [{ terminal_outcome: "verifier", reward: 1 }, "errored"],
    [{ terminal_outcome: "cancelled" }, "cancelled"],
    [{ pending_job_state: "FAILED" }, "errored"],
    [{ pending_job_state: "ERROR" }, "errored"],
    [{ pending_job_state: "TIMEOUT" }, "errored"],
    [{ pending_job_state: "CANCELED" }, "cancelled"],
    [{ pending_job_state: "CANCELLED" }, "cancelled"],
    [{ pending_job_state: "COMPLETED" }, "awaiting"],
    [{ pending_job_state: "NEW_PROVIDER_STATE" }, "unknown"],
    [{ latest_outcome: "complete" }, "awaiting"],
    [{ latest_outcome: "agent" }, "errored"],
    [{ terminal_outcome: "infrastructure", pending_job_state: "RUNNING" }, "running"],
  ] as const)("classifies %j as %s", (overrides, expected) => {
    expect(trialState(task(overrides))).toBe(expected);
  });
  it("does not merge changed inputs or coerce unknown rewards to zero", () => {
    expect(trialKey(task())).not.toBe(trialKey(task({ input_digest: "other-input" })));
    expect(trialDescription(task())).toContain("Selected reward: not reported");
    expect(trialDescription(task({ reward: 0 }))).toContain("Selected reward: 0");
  });
});

describe("Runs matrix", () => {
  it("aligns trials across runs with accessible states, progress, and focus/hover details", async () => {
    const user = userEvent.setup();
    show([run(), run("run-b")], {
      "run-a": [
        task({
          terminal_outcome: "complete",
          reward: 0,
          attempt_count: 2,
          selected_attempt_id: "attempt-a",
          last_attempt_at: "2026-09-08T00:00:00Z",
          cost_microusd: 100_000,
        }),
      ],
      "run-b": [task({ run_id: "run-b", pending_job_state: "RUNNING" })],
    });
    expect(screen.getAllByText("1/2 sealed")).toHaveLength(2);
    const cell = screen.getByRole("link", { name: "trial-a in run-a: Zero reward" });
    expect(cell).toHaveAttribute("href", "/runs/run-a/tasks/trial-a");
    await user.hover(cell.querySelector("span") ?? cell);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Recorded attempts: 2");
    await user.unhover(cell.querySelector("span") ?? cell);
    act(() => cell.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Selected reward: 0");
    expect(screen.getByRole("tooltip")).toHaveTextContent("attempt-a");
    expect(
      screen.getByRole("link", { name: "trial-a in run-b: Running" }),
    ).toBeVisible();
  });
  it("shows absent cells separately from loading or unavailable columns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "forbidden", message: "Not available" } }),
            { status: 403 },
          ),
      ),
    );
    show([run(), run("run-b"), run("run-c")], { "run-a": [task()], "run-b": [] });
    expect(screen.getByRole("img", { name: "Not in run" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Loading" })).toBeVisible();
    expect(await screen.findByRole("img", { name: "Unavailable" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
  it("keeps cached cells visible with a stale warning when refresh fails, then retries", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "forbidden", message: "Not available" } }),
          { status: 403 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const client = show([run()], { "run-a": [task()] });
    await act(() => client.invalidateQueries({ queryKey: keys.tasks("run-a") }));
    expect(await screen.findByText("Stale data")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "trial-a in run-a: Queued / unstarted" }),
    ).toBeVisible();
    fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            items: [task({ pending_job_state: "RUNNING" })],
            next_cursor: null,
          }),
        ),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("link", { name: "trial-a in run-a: Running" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByText("Stale data")).not.toBeInTheDocument(),
    );
  });
  it("bounds rendered rows and queries to visible columns, supports search and pagination", async () => {
    const runs = Array.from({ length: 9 }, (_, i) => run(`run-${i}`));
    const items = Array.from({ length: 51 }, (_, i) =>
      task({ task_id: `trial-${String(i).padStart(2, "0")}`, run_id: "run-0" }),
    );
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ items: [], next_cursor: null })),
    );
    vi.stubGlobal("fetch", fetch);
    show(runs, { "run-0": items });
    const user = userEvent.setup();
    expect(
      screen.queryByRole("link", { name: "trial-50 in run-0: Queued / unstarted" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next trials" }));
    expect(
      screen.getByRole("link", { name: "trial-50 in run-0: Queued / unstarted" }),
    ).toBeVisible();
    await user.type(
      screen.getByRole("searchbox", { name: "Find a trial" }),
      "trial-00",
    );
    expect(
      screen.getByRole("link", { name: "trial-00 in run-0: Queued / unstarted" }),
    ).toBeVisible();
    expect(fetch.mock.calls.flat().join(" ")).not.toContain("run-8");
    await user.click(screen.getByRole("button", { name: "Next columns" }));
    expect(await screen.findByRole("link", { name: "run-8" })).toBeVisible();
  });
  it("keeps same-name trials with different inputs separate", () => {
    show([run(), run("run-b")], {
      "run-a": [task()],
      "run-b": [task({ run_id: "run-b", input_digest: "sha256:input-b" })],
    });
    expect(screen.getAllByRole("rowheader")).toHaveLength(2);
    expect(screen.getAllByRole("img", { name: "Not in run" })).toHaveLength(2);
  });
  it("shows empty preparation honestly", () => {
    show([run()], { "run-a": [] });
    expect(screen.getByText("No prepared trials yet.")).toBeVisible();
  });
});

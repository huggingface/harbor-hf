// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { BrowserRouter, Link, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RunView } from "../src/api";
import { ControlStateProvider } from "../src/control-state";
import { RunsPage } from "../src/pages";

const runs = ["diagnostic", "final"].map((role, index) => ({
  record: {
    run_id: `run-${index}`,
    role,
    created_at: "2026-01-01T00:00:00Z",
    submission: {
      benchmark: { name: "synthetic-benchmark", preset: "sample" },
      model: { id: `model-${role}`, provider: "provider" },
      harness: { agent: "command-agent", version: "revision" },
    },
    harbor_job_config: { agents: [{ model_name: `model-${role}` }] },
  },
  status: "finished",
  result: null,
  presentation: { archived: index === 1 },
})) as RunView[];

vi.mock("../src/queries", async (original) => ({
  ...(await original<typeof import("../src/queries")>()),
  useRuns: () => ({ data: runs, isPending: false, isError: false, refetch: vi.fn() }),
}));

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

function show() {
  window.history.replaceState(
    null,
    "",
    "/runs?role=diagnostic&q=run-0&other=one&other=two",
  );
  const client = new QueryClient();
  clients.push(client);
  let blocked = false;
  let release = () => {};
  let committed = "";
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  function CommitGate() {
    const location = useLocation();
    useLayoutEffect(() => {
      committed = location.search;
    }, [location]);
    if (blocked) throw pending;
    return null;
  }
  render(
    <QueryClientProvider client={client}>
      <ControlStateProvider
        actor={{
          username: "synthetic-actor",
          role: "reader",
          transport: "development",
        }}
        writeMode="disabled"
      >
        <BrowserRouter>
          <Suspense fallback={<p>Navigation pending</p>}>
            <CommitGate />
            <Link to="/runs?q=model-final&archive=all&external=kept">
              External filters
            </Link>
            <RunsPage />
          </Suspense>
        </BrowserRouter>
      </ControlStateProvider>
    </QueryClientProvider>,
  );
  return {
    committed: () => committed,
    block: () => {
      blocked = true;
    },
    unblock: () => {
      blocked = false;
      release();
    },
    release: async () => {
      await act(async () => {
        blocked = false;
        release();
      });
    },
  };
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function params() {
  return new URLSearchParams(window.location.search);
}
async function travel(direction: "back" | "forward") {
  await act(async () => {
    const popped = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    window.history[direction]();
    await popped;
  });
}

it("merges rapid search, role and archive changes before BrowserRouter commits", async () => {
  const navigation = show();
  const initial = navigation.committed();
  const length = window.history.length;
  navigation.block();
  change("Search runs", "SYNTHETIC-BENCHMARK");
  expect(params().get("q")).toBe("SYNTHETIC-BENCHMARK");
  expect(window.history.length).toBe(length); // Search replaces.
  expect(navigation.committed()).toBe(initial);
  change("Run role", "all");
  change("Archive visibility", "all");
  expect(navigation.committed()).toBe(initial); // All handlers used the old render.
  expect(params().get("q")).toBe("SYNTHETIC-BENCHMARK");
  expect(params().has("role")).toBe(false);
  expect(params().get("archive")).toBe("all");
  expect(params().getAll("other")).toEqual(["one", "two"]);
  expect(window.history.length).toBe(length + 2); // Selects push.
  await navigation.release();
  expect(screen.getByLabelText("Search runs")).toHaveValue("SYNTHETIC-BENCHMARK");
  expect(screen.getByRole("link", { name: /model-final/ })).toBeVisible();
  expect(screen.getByRole("link", { name: /model-diagnostic/ })).toBeVisible();
});

it("uses Back, Forward and external navigation as the next edit's base", async () => {
  show();
  change("Search runs", "synthetic-benchmark");
  change("Run role", "all");
  change("Archive visibility", "all");
  await travel("back");
  expect(screen.getByLabelText("Archive visibility")).toHaveValue("not-archived");
  await travel("back");
  expect(screen.getByLabelText("Run role")).toHaveValue("diagnostic");
  await travel("forward");
  expect(screen.getByLabelText("Run role")).toHaveValue("all");
  change("Search runs", "model-final");
  expect(params().has("archive")).toBe(false);
  expect(params().has("role")).toBe(false);
  fireEvent.click(screen.getByRole("link", { name: "External filters" }));
  change("Run role", "final");
  expect(params().get("external")).toBe("kept");
  expect(params().has("other")).toBe(false);
  expect(params().get("q")).toBe("model-final");
  expect(screen.getByRole("link", { name: /model-final/ })).toBeVisible();
  change("Search runs", "");
  change("Archive visibility", "not-archived");
  expect(params().has("q")).toBe(false);
  expect(params().has("archive")).toBe(false);
  expect(params().get("role")).toBe("final");
});

it("merges search into pending select and external navigations without a shadow queue", async () => {
  const navigation = show();
  const initial = navigation.committed();
  navigation.block();
  change("Archive visibility", "all");
  change("Run role", "final");
  change("Search runs", "model-final");
  expect(params().get("archive")).toBe("all");
  expect(params().get("role")).toBe("final");
  fireEvent.click(screen.getByRole("link", { name: "External filters" }));
  change("Search runs", "synthetic-benchmark");
  expect(navigation.committed()).toBe(initial);
  expect(params().get("external")).toBe("kept");
  expect(params().has("role")).toBe(false);
  expect(params().has("other")).toBe(false);
  await navigation.release();
  expect(screen.getByRole("link", { name: /model-final/ })).toBeVisible();
  expect(screen.getByRole("link", { name: /model-diagnostic/ })).toBeVisible();
});

it("edits the browser's Back destination even before the POP render commits", async () => {
  const navigation = show();
  change("Run role", "all");
  change("Archive visibility", "all");
  const initial = navigation.committed();
  navigation.block();
  await act(async () => {
    const popped = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    window.history.back();
    await popped;
    expect(navigation.committed()).toBe(initial);
    expect(params().has("archive")).toBe(false);
    change("Search runs", "synthetic-benchmark");
    expect(params().has("archive")).toBe(false);
    expect(params().has("role")).toBe(false);
    navigation.unblock();
  });
  expect(screen.queryByRole("link", { name: /model-final/ })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /model-diagnostic/ })).toBeVisible();
});

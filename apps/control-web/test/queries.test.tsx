// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  affectedQueryKeys,
  collectPagedItems,
  keys,
  SSE_INVALIDATION_DEBOUNCE_MS,
  useAllProfiles,
  useJobs,
  useLiveUpdates,
  useRunJobs,
  useTasks,
} from "../src/queries";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }

  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useLiveUpdates(true), { wrapper });
  return { client, hook, invalidate };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("live query updates", () => {
  it("maps typed events without ever targeting the session", () => {
    const affected = affectedQueryKeys({
      type: "attempt.receipt",
      occurred_at: "2026-08-18T00:00:00Z",
      data: { run_id: "run-1", task_id: "task-1" },
    });
    expect(affected).toContainEqual(keys.runs);
    expect(affected).toContainEqual(keys.run("run-1"));
    expect(affected).toContainEqual(keys.capacity("run-1"));
    expect(affected).toContainEqual(keys.tasks("run-1"));
    expect(affected).toContainEqual(keys.task("run-1", "task-1"));
    expect(affected).not.toContainEqual(keys.session);
    expect(affected).not.toContainEqual(keys.results);
  });

  it("invalidates Run and task queries for task lifecycle events", () => {
    const affected = affectedQueryKeys({
      type: "task.exhaustion",
      occurred_at: "2026-08-18T00:00:00Z",
      data: { run_id: "run-1", task_id: "task-1" },
    });
    expect(affected).toContainEqual(keys.runs);
    expect(affected).toContainEqual(keys.run("run-1"));
    expect(affected).toContainEqual(keys.tasks("run-1"));
    expect(affected).toContainEqual(keys.task("run-1", "task-1"));
  });

  it("refreshes the complete run Job list for Job actions", () => {
    const affected = affectedQueryKeys({
      type: "action.receipt",
      occurred_at: "2026-08-18T00:00:00Z",
      data: { run_id: "run-1", action_kind: "job.observe" },
    });
    expect(affected).toContainEqual(keys.jobs);
    expect(affected).toContainEqual(keys.runJobs("run-1"));
  });

  it("invalidates every capacity view after capacity profile promotion", () => {
    const affected = affectedQueryKeys({
      type: "profile.promotion",
      occurred_at: "2026-08-18T00:00:00Z",
      data: { profile_kind: "capacity", alias: "current" },
    });
    expect(affected).toContainEqual(["capacity"]);
    expect(affected).toContainEqual(keys.infrastructureCapacity);
    expect(affected).toContainEqual(keys.profiles);
  });

  it("targets capacity views for Job admission records", () => {
    const affected = affectedQueryKeys({
      type: "job.admission",
      occurred_at: "2026-08-18T00:00:00Z",
      data: { run_id: "run-1", action_id: "action-1" },
    });
    expect(affected).toContainEqual(keys.capacity("run-1"));
    expect(affected).toContainEqual(keys.infrastructureCapacity);
    expect(affected).toContainEqual(keys.run("run-1"));
    expect(affected).not.toContainEqual(keys.session);
  });

  it("refreshes open detail views for replay events without scope fields", () => {
    const affected = affectedQueryKeys({
      type: "attempt.receipt",
      occurred_at: "2026-08-18T00:00:00Z",
      data: { key: "control/example", digest: "sha256:example" },
    });
    expect(affected).toContainEqual(keys.runs);
    expect(affected).toContainEqual(["run"]);
    expect(affected).toContainEqual(["tasks"]);
    expect(affected).toContainEqual(["task"]);
  });

  it("resumes SSE from the projection cursor before page queries start", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useLiveUpdates(true, "cursor-one"), { wrapper });
    expect(FakeEventSource.instances[0]?.url).toBe("/api/v1/events?cursor=cursor-one");
  });

  it("refreshes current state on resets and system state on replay", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("EventSource", FakeEventSource);
    const { client, invalidate } = setup();
    client.setQueryData(keys.system, {
      projection: {
        object_count: 7,
        last_sync_at: "2026-08-24T09:00:00.000Z",
        event_cursor: "old-cursor",
      },
    });
    act(() =>
      FakeEventSource.instances[0]?.message({
        type: "cursor.reset",
        occurred_at: "2026-08-24T10:00:00.000Z",
        data: { reason: "epoch_changed", latest_cursor: "latest-cursor" },
        replay: true,
        cursor_reset: true,
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      predicate: expect.any(Function),
      refetchType: "active",
    });
    const resetPredicate = invalidate.mock.calls[0]?.[0]?.predicate;
    if (!resetPredicate) throw new Error("reset invalidation predicate is missing");
    expect(resetPredicate({ queryKey: keys.system } as never)).toBe(true);
    expect(resetPredicate({ queryKey: keys.runs } as never)).toBe(true);
    expect(resetPredicate({ queryKey: keys.session } as never)).toBe(false);
    expect(
      client.getQueryData<{ projection: { object_count: number } }>(keys.system)
        ?.projection.object_count,
    ).toBe(7);
    invalidate.mockClear();

    act(() =>
      FakeEventSource.instances[0]?.message({
        id: "new-cursor-1",
        type: "run.request",
        occurred_at: "2026-08-24T10:00:01.000Z",
        data: { run_id: "run-1" },
        replay: true,
        cursor_reset: false,
      }),
    );
    expect(
      client.getQueryData<{ projection: { object_count: number } }>(keys.system)
        ?.projection.object_count,
    ).toBe(7);
    act(() => vi.advanceTimersByTime(SSE_INVALIDATION_DEBOUNCE_MS));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: keys.system,
      refetchType: "active",
    });
    invalidate.mockClear();

    act(() =>
      FakeEventSource.instances[0]?.message({
        id: "new-cursor-2",
        type: "run.lock",
        occurred_at: "2026-08-24T10:00:02.000Z",
        data: { run_id: "run-1" },
        replay: false,
        cursor_reset: false,
      }),
    );
    expect(
      client.getQueryData<{ projection: { object_count: number } }>(keys.system)
        ?.projection.object_count,
    ).toBe(7);
    act(() => vi.advanceTimersByTime(SSE_INVALIDATION_DEBOUNCE_MS));
    expect(
      invalidate.mock.calls.map(([options]) => options?.queryKey),
    ).not.toContainEqual(keys.system);
    act(() => FakeEventSource.instances[0]?.onerror?.());
    act(() => vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances[1]?.url).toBe(
      "/api/v1/events?cursor=latest-cursor",
    );
  });

  it("does not poll while SSE stays connected", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const { hook, invalidate } = setup();
    act(() => FakeEventSource.instances[0]?.open());
    invalidate.mockClear();

    for (let index = 0; index < 5; index += 1) {
      act(() => {
        vi.advanceTimersByTime(15_000);
        FakeEventSource.instances[0]?.message({
          type: "heartbeat",
          occurred_at: new Date().toISOString(),
          data: {},
        });
      });
    }

    expect(hook.result.current.status).toBe("connected");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("uses the slow fallback only while disconnected and visible", () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.stubGlobal("EventSource", FakeEventSource);
    const { invalidate } = setup();

    act(() => vi.advanceTimersByTime(60_000));
    expect(invalidate).toHaveBeenCalled();
    invalidate.mockClear();
    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(120_000));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reconnects with bounded backoff after an SSE failure", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("EventSource", FakeEventSource);
    const { hook } = setup();
    act(() => FakeEventSource.instances[0]?.open());
    act(() => FakeEventSource.instances[0]?.onerror?.());

    expect(hook.result.current.status).toBe("reconnecting");
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("invalidates only the queries affected by a control event", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const { invalidate } = setup();
    act(() => FakeEventSource.instances[0]?.open());
    invalidate.mockClear();
    act(() =>
      FakeEventSource.instances[0]?.message({
        type: "publication.receipt",
        occurred_at: "2026-08-18T00:00:00Z",
        data: { run_id: "run-1" },
      }),
    );
    act(() => vi.advanceTimersByTime(SSE_INVALIDATION_DEBOUNCE_MS));

    const invalidated = invalidate.mock.calls.map(([options]) => options?.queryKey);
    expect(invalidated).toContainEqual(keys.results);
    expect(invalidated).toContainEqual(keys.leaderboard);
    expect(invalidated).toContainEqual(keys.runs);
    expect(invalidated).toContainEqual(keys.run("run-1"));
    expect(invalidated).toContainEqual(keys.audit);
    expect(invalidated).not.toContainEqual(keys.session);
    expect(invalidated).not.toContainEqual(keys.profiles);
  });

  it("coalesces an SSE burst to one invalidation per query key", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const { invalidate } = setup();
    act(() => FakeEventSource.instances[0]?.open());
    invalidate.mockClear();

    act(() => {
      for (let index = 0; index < 5; index += 1)
        FakeEventSource.instances[0]?.message({
          type: "attempt.receipt",
          occurred_at: `2026-08-18T00:00:0${index}Z`,
          data: { run_id: "run-1", task_id: "task-1" },
        });
    });
    expect(invalidate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SSE_INVALIDATION_DEBOUNCE_MS - 1));
    expect(invalidate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));

    const invalidated = invalidate.mock.calls.map(([options]) =>
      JSON.stringify(options?.queryKey),
    );
    expect(new Set(invalidated).size).toBe(invalidated.length);
    expect(invalidated).toContain(JSON.stringify(keys.run("run-1")));
    expect(invalidated).toContain(JSON.stringify(keys.task("run-1", "task-1")));
  });

  it("does not poll Jobs while SSE owns live refreshes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], next_cursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useJobs(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("loads more than 2,000 Jobs scoped to a run", async () => {
    const itemCount = 2_001;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: Array.from({ length: itemCount }, (_, index) => ({
              action_id: `action-${index}`,
              resource_id: `job-${index}`,
            })),
            next_cursor: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRunJobs("run-1"), { wrapper });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(itemCount));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/jobs?run_id=run-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Run task collection", () => {
  it("loads more than 100 logical tasks with one request", async () => {
    const items = Array.from({ length: 125 }, (_, index) => ({
      run_id: "run-1",
      task_id: `task-${index}`,
      input_digest: `sha256:${String(index).padStart(64, "0")}`,
      terminal_outcome: null,
      selected_attempt_id: null,
    }));
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ items, next_cursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const hook = renderHook(() => useTasks("run-1"), { wrapper });
    await waitFor(() => expect(hook.result.current.data?.items).toHaveLength(125));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/runs/run-1/tasks");
  });
});

describe("complete paged collection", () => {
  it("follows profile cursors until models and later harnesses appear", async () => {
    const pages = [
      {
        items: [{ name: "tb21-old-deployment" }, { name: "hermes" }],
        next_cursor: "page-2",
      },
      {
        items: [{ name: "opencode" }, { name: "gpt-oss-20b" }],
        next_cursor: null,
      },
    ];

    const items = await collectPagedItems(async (cursor) => {
      if (!cursor) return pages[0];
      if (cursor === "page-2") return pages[1];
      throw new Error(`unexpected cursor ${cursor}`);
    });

    expect(items.map((item) => item.name)).toEqual([
      "tb21-old-deployment",
      "hermes",
      "opencode",
      "gpt-oss-20b",
    ]);
  });

  it("loads more than twenty pages without truncation", async () => {
    const pageSize = 100;
    const itemCount = 2_001;
    const loadPage = vi.fn(async (cursor?: string) => {
      const offset = cursor ? Number(cursor) : 0;
      const end = Math.min(offset + pageSize, itemCount);
      return {
        items: Array.from({ length: end - offset }, (_, index) => offset + index),
        next_cursor: end < itemCount ? String(end) : null,
      };
    });

    const items = await collectPagedItems(loadPage);

    expect(items).toHaveLength(itemCount);
    expect(items.at(-1)).toBe(itemCount - 1);
    expect(loadPage).toHaveBeenCalledTimes(21);
  });

  it("rejects empty and repeated cursor pages", async () => {
    await expect(
      collectPagedItems(async () => ({ items: [], next_cursor: "stalled" })),
    ).rejects.toThrow("paged list made no progress");
    await expect(
      collectPagedItems(async (cursor) => ({
        items: [cursor ?? "first"],
        next_cursor: "page-2",
      })),
    ).rejects.toThrow("paged list repeated a cursor");
    await expect(
      collectPagedItems(
        async (cursor) => ({
          items: ["duplicate"],
          next_cursor: cursor ? "page-3" : "page-2",
        }),
        (item) => item,
      ),
    ).rejects.toThrow("paged list made no progress");
  });

  it("loads every profile page for the launch form", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const page = url.includes("cursor=page-2")
        ? {
            items: [
              {
                profile_id: "model-1",
                profile_kind: "model",
                name: "gpt-oss-20b",
                approved_aliases: ["gpt-oss-20b"],
              },
              {
                profile_id: "harness-2",
                profile_kind: "harness",
                name: "opencode",
                approved_aliases: ["opencode"],
              },
            ],
            next_cursor: null,
          }
        : {
            items: [
              {
                profile_id: "deploy-1",
                profile_kind: "deployment",
                name: "tb21-old",
                approved_aliases: ["tb21-old"],
              },
            ],
            next_cursor: "page-2",
          };
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useAllProfiles(), { wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current.data?.items.map((item) => item.name)).toEqual([
      "tb21-old",
      "gpt-oss-20b",
      "opencode",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

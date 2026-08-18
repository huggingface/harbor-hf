// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { affectedQueryKeys, keys, useLiveUpdates } from "../src/queries";

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
      data: { campaign_id: "campaign-1", task_id: "task-1" },
    });
    expect(affected).toContainEqual(keys.campaigns);
    expect(affected).toContainEqual(keys.campaign("campaign-1"));
    expect(affected).toContainEqual(keys.tasks("campaign-1"));
    expect(affected).toContainEqual(keys.task("campaign-1", "task-1"));
    expect(affected).not.toContainEqual(keys.session);
    expect(affected).not.toContainEqual(keys.results);
  });

  it("refreshes open detail views for replay events without scope fields", () => {
    const affected = affectedQueryKeys({
      type: "attempt.receipt",
      occurred_at: "2026-08-18T00:00:00Z",
      data: { key: "control/example", digest: "sha256:example" },
    });
    expect(affected).toContainEqual(keys.campaigns);
    expect(affected).toContainEqual(["campaign"]);
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
    vi.stubGlobal("EventSource", FakeEventSource);
    const { invalidate } = setup();
    act(() => FakeEventSource.instances[0]?.open());
    invalidate.mockClear();
    act(() =>
      FakeEventSource.instances[0]?.message({
        type: "publication.receipt",
        occurred_at: "2026-08-18T00:00:00Z",
        data: { campaign_id: "campaign-1" },
      }),
    );

    const invalidated = invalidate.mock.calls.map(([options]) => options?.queryKey);
    expect(invalidated).toContainEqual(keys.results);
    expect(invalidated).toContainEqual(keys.campaigns);
    expect(invalidated).toContainEqual(keys.campaign("campaign-1"));
    expect(invalidated).toContainEqual(keys.audit);
    expect(invalidated).not.toContainEqual(keys.session);
    expect(invalidated).not.toContainEqual(keys.profiles);
  });
});

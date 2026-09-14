// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../src/api";
import {
  ResultBrowsingProvider,
  settleReplacementInspection,
  useReplacementResult,
} from "../src/result-browsing-query";

const empty: api.ReplacementView = {
  run_id: "run-original",
  operator_selection: null,
  children: [],
  assembly: { availability: "none", result: null },
  incurred: null,
  selected_cost_usd: null,
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function Observer({ id, enabled = true }: { id: string; enabled?: boolean }) {
  useReplacementResult(id, enabled);
  return null;
}
function setup() {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  let active = 0;
  let peak = 0;
  const get = vi.spyOn(api, "getReplacements").mockImplementation(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 100));
    active -= 1;
    return empty;
  });
  function tree(count: number) {
    return (
      <QueryClientProvider client={client}>
        <ResultBrowsingProvider>
          {Array.from({ length: count }, (_, i) => `run-${i}`).map((id) => (
            <Observer key={id} id={id} />
          ))}
          <Observer id="no-children" enabled={false} />
        </ResultBrowsingProvider>
      </QueryClientProvider>
    );
  }
  return { client, get, tree, peak: () => peak };
}
it("bounds six cold requests to two, then polls only visible active rows every 30 seconds", async () => {
  const { get, tree, peak } = setup();
  const mounted = render(tree(6));
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(get).toHaveBeenCalledTimes(6);
  expect(peak()).toBe(2);
  mounted.rerender(tree(1));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(29_500);
  });
  expect(get).toHaveBeenCalledTimes(7);
  expect(get.mock.calls.at(-1)?.[0]).toBe("run-0");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_500);
  });
  expect(get).toHaveBeenCalledTimes(8);
  expect(peak()).toBe(2);
});
it("skips queued rows removed by table filters before their request begins", async () => {
  const { get, tree } = setup();
  const mounted = render(tree(6));
  expect(get).toHaveBeenCalledTimes(2);
  mounted.rerender(tree(2));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(get).toHaveBeenCalledTimes(2);
});
it("deduplicates repeated observers and reuses a fresh detail query", async () => {
  const { client, get } = setup();
  client.setQueryData(["replacements", "cached"], empty);
  render(
    <QueryClientProvider client={client}>
      <ResultBrowsingProvider>
        <Observer id="cached" />
        <Observer id="new" />
        <Observer id="new" />
      </ResultBrowsingProvider>
    </QueryClientProvider>,
  );
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith("new");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
});
it("does not cancel and duplicate a slow cached refresh at the polling boundary", async () => {
  const { client, get, tree } = setup();
  client.setQueryData(["replacements", "run-0"], empty, {
    updatedAt: Date.now() - 31_000,
  });
  get.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    return empty;
  });
  render(tree(1));
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_500);
  });
});
it("skips hidden polling and refreshes on visible focus/visibility without duplicating work", async () => {
  const { client, get, tree } = setup();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("visible");
  const mounted = render(tree(1));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  visibility.mockReturnValue("hidden");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(get).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["replacements"], refetchType: "none" });
    window.dispatchEvent(new Event("focus"));
  });
  expect(get).toHaveBeenCalledTimes(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  mounted.unmount();
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(get).toHaveBeenCalledTimes(3);
});

it("retains started cold inspection through StrictMode remounts", async () => {
  const { get, tree } = setup();
  render(<StrictMode>{tree(1)}</StrictMode>);
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(get).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "coalesces queued-admitted remounts and clears settled flights (error=%s)",
  async (fails) => {
    const { client, get, tree, peak } = setup();
    const mounted = render(tree(3));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(get.mock.calls.filter(([id]) => id === "run-2")).toHaveLength(1);
    mounted.rerender(tree(2));
    mounted.rerender(tree(3));
    expect(get.mock.calls.filter(([id]) => id === "run-2")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(client.getQueryData(["replacements", "run-2"])).toEqual(empty);
    // A settled success must not act as a second evidence cache.
    get.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (fails) throw new Error("inspection failed");
      return { ...empty, run_id: "fresh" };
    });
    await act(async () => {
      void client.refetchQueries({ queryKey: ["replacements", "run-2"], exact: true });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(get.mock.calls.filter(([id]) => id === "run-2")).toHaveLength(2);
    if (fails)
      expect(client.getQueryState(["replacements", "run-2"])?.error?.message).toBe(
        "inspection failed",
      );
    await act(async () => {
      void client.refetchQueries({ queryKey: ["replacements", "run-2"], exact: true });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(get.mock.calls.filter(([id]) => id === "run-2")).toHaveLength(3);
    expect(client.getQueryState(["replacements", "run-2"])?.error).toBeNull();
    expect(peak()).toBe(2);
  },
);

it.each([false, true])(
  "waits for an admitted inspection even without a query owner (error=%s)",
  async (fails) => {
    const { get, tree } = setup();
    const mounted = render(tree(3));
    get.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (fails) throw new Error("detached inspection failed");
      return empty;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    mounted.rerender(tree(2));
    const pending = settleReplacementInspection("run-2");
    expect(pending).toBeDefined();
    let settled = false;
    void pending?.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(settled).toBe(true);
    expect(settleReplacementInspection("run-2")).toBeUndefined();
  },
);

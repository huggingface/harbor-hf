// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parentJobTime } from "../src/agent-timing";

const apiMocks = vi.hoisted(() => ({
  getJobs: vi.fn(),
  getLeaderboard: vi.fn(),
  getPresets: vi.fn(),
  getRun: vi.fn(),
  getRuns: vi.fn(),
  getSession: vi.fn(),
  getSystem: vi.fn(),
  getTrial: vi.fn(),
  getTrials: vi.fn(),
}));

vi.mock("../src/api", () => apiMocks);

import {
  keys,
  useRunClock,
  useJobs,
  useLeaderboard,
  usePresets,
  useRun,
  useRuns,
  useSession,
  useSystem,
  useTrial,
  useTrials,
} from "../src/queries";

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getSession.mockResolvedValue({
    authenticated: false,
    login_url: "/auth/login",
  });
  apiMocks.getSystem.mockResolvedValue({ ready: true });
  apiMocks.getPresets.mockResolvedValue({ benchmarks: [], agents: [] });
  apiMocks.getLeaderboard.mockResolvedValue([]);
  apiMocks.getRuns.mockResolvedValue([]);
  apiMocks.getRun.mockResolvedValue({ status: "running" });
  apiMocks.getTrials.mockResolvedValue([]);
  apiMocks.getTrial.mockResolvedValue({ trial_name: "trial-one" });
  apiMocks.getJobs.mockResolvedValue([]);
});

describe("query keys", () => {
  it("keeps run and trial details scoped to their identifiers", () => {
    expect(keys.run("run-one")).toEqual(["run", "run-one"]);
    expect(keys.trials("run-one")).toEqual(["trials", "run-one"]);
    expect(keys.trial("run-one", "trial-one")).toEqual([
      "trial",
      "run-one",
      "trial-one",
    ]);
  });
});

describe("control queries", () => {
  it("loads each unscoped control collection", async () => {
    const { wrapper } = harness();
    const hooks = [
      renderHook(() => useSession(), { wrapper }),
      renderHook(() => useSystem(), { wrapper }),
      renderHook(() => usePresets(), { wrapper }),
      renderHook(() => useLeaderboard(), { wrapper }),
      renderHook(() => useRuns(), { wrapper }),
      renderHook(() => useJobs(), { wrapper }),
    ];
    await waitFor(() =>
      expect(hooks.every((hook) => hook.result.current.isSuccess)).toBe(true),
    );
    expect(apiMocks.getSession).toHaveBeenCalledOnce();
    expect(apiMocks.getSystem).toHaveBeenCalledOnce();
    expect(apiMocks.getPresets).toHaveBeenCalledOnce();
    expect(apiMocks.getLeaderboard).toHaveBeenCalledOnce();
    expect(apiMocks.getRuns).toHaveBeenCalledOnce();
    expect(apiMocks.getJobs).toHaveBeenCalledOnce();
  });

  it("loads the exact run and trial resources", async () => {
    const { wrapper } = harness();
    const run = renderHook(() => useRun("run-one"), { wrapper });
    const trials = renderHook(() => useTrials("run-one"), { wrapper });
    const trial = renderHook(() => useTrial("run-one", "trial/name"), { wrapper });
    await waitFor(() => {
      expect(run.result.current.isSuccess).toBe(true);
      expect(trials.result.current.isSuccess).toBe(true);
      expect(trial.result.current.isSuccess).toBe(true);
    });
    expect(apiMocks.getRun).toHaveBeenCalledWith("run-one");
    expect(apiMocks.getTrials).toHaveBeenCalledWith("run-one");
    expect(apiMocks.getTrial).toHaveBeenCalledWith("run-one", "trial/name");
  });

  it("does not request an incomplete detail route", async () => {
    const { wrapper } = harness();
    const run = renderHook(() => useRun(""), { wrapper });
    const trials = renderHook(() => useTrials(""), { wrapper });
    const trial = renderHook(() => useTrial("run-one", ""), { wrapper });
    await waitFor(() => {
      expect(run.result.current.fetchStatus).toBe("idle");
      expect(trials.result.current.fetchStatus).toBe("idle");
      expect(trial.result.current.fetchStatus).toBe("idle");
    });
    expect(apiMocks.getRun).not.toHaveBeenCalled();
    expect(apiMocks.getTrials).not.toHaveBeenCalled();
    expect(apiMocks.getTrial).not.toHaveBeenCalled();
  });
});

it("uses render time between ticks and after throttled visibility/focus return", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
  const start = Date.now();
  const hook = renderHook(() => {
    const now = useRunClock();
    const elapsed = parentJobTime(
      {
        id: "parent-test",
        run_id: "run-test",
        role: "parent",
        stage: "running",
        created_at: new Date(start).toISOString(),
        started_at: new Date(start).toISOString(),
        finished_at: null,
      },
      now,
    );
    return { now, elapsed };
  });
  try {
    vi.setSystemTime(start + 9_000);
    hook.rerender();
    expect(hook.result.current.now).toBe(start + 9_000);
    expect(hook.result.current.elapsed).toBe("Elapsed since start: 9s");
    // Simulate suspended timers, rather than assuming background intervals run.
    vi.setSystemTime(start + 120_000);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(hook.result.current.now).toBe(start + 120_000);
    vi.setSystemTime(start + 125_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(hook.result.current.now).toBe(start + 125_000);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(hook.result.current.now).toBe(start + 135_000);
    expect(hook.result.current.elapsed).toBe("Elapsed since start: 2m 15s");
  } finally {
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});

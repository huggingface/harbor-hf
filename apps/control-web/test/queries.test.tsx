// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

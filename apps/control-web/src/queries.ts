import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getJobs,
  getLeaderboard,
  getModelProviders,
  getPresets,
  getRun,
  getRuns,
  getSession,
  getSystem,
  getTrial,
  getTrials,
} from "./api";

export const keys = {
  session: ["session"] as const,
  system: ["system"] as const,
  presets: ["presets"] as const,
  modelProviders: (model: string) => ["model-providers", model] as const,
  leaderboard: ["leaderboard"] as const,
  runs: ["runs"] as const,
  run: (runId: string) => ["run", runId] as const,
  trials: (runId: string) => ["trials", runId] as const,
  trial: (runId: string, trialName: string) => ["trial", runId, trialName] as const,
  jobs: ["jobs"] as const,
};

export function useSession() {
  return useQuery({ queryKey: keys.session, queryFn: getSession, staleTime: 60_000 });
}

export function useSystem() {
  return useQuery({
    queryKey: keys.system,
    queryFn: getSystem,
    refetchInterval: 15_000,
  });
}

export function usePresets() {
  return useQuery({ queryKey: keys.presets, queryFn: getPresets });
}

export function useModelProviders(model: string) {
  const normalized = model.trim();
  return useQuery({
    queryKey: keys.modelProviders(normalized),
    queryFn: () => getModelProviders(normalized),
    enabled: Boolean(normalized),
    staleTime: 300_000,
  });
}

export function useLeaderboard() {
  return useQuery({ queryKey: keys.leaderboard, queryFn: getLeaderboard });
}

export function useRuns() {
  return useQuery({
    queryKey: keys.runs,
    queryFn: getRuns,
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
}

export function useRun(runId: string) {
  return useQuery({
    queryKey: keys.run(runId),
    queryFn: () => getRun(runId),
    enabled: Boolean(runId),
    refetchInterval: 10_000,
  });
}

export function useTrials(runId: string) {
  return useQuery({
    queryKey: keys.trials(runId),
    queryFn: () => getTrials(runId),
    enabled: Boolean(runId),
    refetchInterval: 10_000,
  });
}

export function useTrial(runId: string, trialName: string) {
  return useQuery({
    queryKey: keys.trial(runId, trialName),
    queryFn: () => getTrial(runId, trialName),
    enabled: Boolean(runId && trialName),
  });
}

export function useJobs() {
  return useQuery({
    queryKey: keys.jobs,
    queryFn: getJobs,
    refetchInterval: 10_000,
  });
}

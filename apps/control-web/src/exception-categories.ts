// Exact display categories from Harbor dcd0a7ac: trial/errors.py,
// environments/gke.py, agents/installed/base.py, verifier/verifier.py.
// Not inferred causes, scoring validity, or retry eligibility.
export type ExceptionCategory =
  | "Agent execution timeout"
  | "Environment / transport"
  | "Provider failure"
  | "Rate limit"
  | "Verifier exception"
  | "Unclassified";
const categories: Record<string, ExceptionCategory> = {
  AgentTimeoutError: "Agent execution timeout",
  EnvironmentStartTimeoutError: "Environment / transport",
  GKEExecStreamClosedError: "Environment / transport",
  NetworkConnectionError: "Environment / transport",
  ApiInternalServerError: "Provider failure",
  ApiOverloadedError: "Provider failure",
  ApiConnectionClosedError: "Provider failure",
  ApiResponseStalledError: "Provider failure",
  ApiRateLimitError: "Rate limit",
  VerifierTimeoutError: "Verifier exception",
  AddTestsDirError: "Verifier exception",
  VerifierOutputParseError: "Verifier exception",
  DownloadVerifierDirError: "Verifier exception",
  RewardFileNotFoundError: "Verifier exception",
  RewardFileEmptyError: "Verifier exception",
};
export function exceptionCategory(type: string): ExceptionCategory {
  return Object.hasOwn(categories, type)
    ? (categories[type] ?? "Unclassified")
    : "Unclassified";
}
export function categoryCounts(groups: { type: string; trials: string[] }[]) {
  const counts = new Map<ExceptionCategory, Set<string>>();
  const infra = new Set<string>();
  for (const group of groups) {
    const category = exceptionCategory(group.type);
    const trials = counts.get(category) ?? new Set<string>();
    for (const trial of group.trials) {
      trials.add(trial);
      if (category === "Environment / transport" || category === "Provider failure")
        infra.add(trial);
    }
    counts.set(category, trials);
  }
  return {
    infra: infra.size,
    categories: [...counts].map(([category, trials]) => ({
      category,
      count: trials.size,
    })),
  };
}

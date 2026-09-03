import type { AttemptReceipt, LaunchPolicySpec, RunLock } from "@harbor-hf/contracts";

export interface AttemptAdmissibility {
  admissible: boolean;
  reason: string | null;
}

export function requiredPositiveMetrics(lock: RunLock): readonly string[] {
  const policy = lock.profiles.find((profile) => profile.kind === "launch_policy")
    ?.spec as LaunchPolicySpec | undefined;
  return policy?.required_positive_metrics ?? [];
}

export function attemptAdmissibility(
  attempt: Pick<AttemptReceipt, "outcome" | "metrics">,
  requiredMetrics: readonly string[],
): AttemptAdmissibility {
  if (attempt.outcome === "infrastructure")
    return { admissible: false, reason: "infrastructure outcome" };
  if (attempt.outcome === "cancelled")
    return { admissible: false, reason: "cancelled outcome" };

  for (const name of new Set(requiredMetrics)) {
    const value = attempt.metrics[name];
    if (typeof value !== "number")
      return { admissible: false, reason: `missing required metric: ${name}` };
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
      return { admissible: false, reason: `required metric is not positive: ${name}` };
  }
  return { admissible: true, reason: null };
}

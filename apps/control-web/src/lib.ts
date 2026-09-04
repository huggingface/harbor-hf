import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatMoney(microusd: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: microusd < 1_000_000 ? 4 : 2,
  }).format(microusd / 1_000_000);
}

export function formatExactMoney(microusd: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(microusd / 1_000_000);
}

export function estimateLaunchReservationMicrousd(
  taskCount: number,
  deployment: Record<string, unknown> | undefined,
  policy: Record<string, unknown> | undefined,
): number {
  const reservation = Number(policy?.reservation_microusd ?? 0);
  const executionJobs = taskCount;
  const preparationAttempts =
    deployment?.preparation === "required"
      ? Number(policy?.max_preparation_attempts ?? 1)
      : 0;
  const preparationReservation = Number(policy?.preparation_reservation_microusd ?? 0);
  return executionJobs * reservation + preparationAttempts * preparationReservation;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatPercentInterval(interval: { low: number; high: number }): string {
  return `${formatPercent(interval.low)}–${formatPercent(interval.high)}`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

/** Digests and Job IDs stay compact. Run names stay complete. */
export function shortId(value: string): string {
  return value.length > 24 ? `${value.slice(0, 14)}…${value.slice(-7)}` : value;
}

export const runNameClass = "block min-w-0 break-all font-mono text-xs";

export function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Operator-facing copy for sealed logical outcomes. Raw tokens like `policy` are not shown. */
export const LOGICAL_OUTCOME_COPY = {
  pending: {
    label: "Not sealed yet",
    hint: "This logical task has no selected attempt yet.",
  },
  complete: {
    label: "Scored success",
    hint: "The verifier scored this trial. It is sealed and cannot be rerun.",
  },
  policy: {
    label: "Provider rejected the request",
    hint: "The inference provider refused the locked call (authentication, quota, unknown model, or similar account policy). This is sealed. It is not an infrastructure failure, so control will not replace it.",
  },
  agent: {
    label: "Agent ended without a score",
    hint: "The agent loop ended without a scored success. Typical causes: no valid final response, an agent crash, or a Harbor exception that is not infrastructure. This is sealed.",
  },
  infrastructure: {
    label: "Infrastructure failure",
    hint: "A retryable Job, platform, or network failure. Control may launch a replacement physical Job attempt.",
  },
  verifier: {
    label: "Verifier failed",
    hint: "The verifier could not score the trial. This is sealed.",
  },
  refusal: {
    label: "Model refused",
    hint: "The model refused to complete the task. This is sealed.",
  },
  semantic: {
    label: "Wrong or incomplete answer",
    hint: "The trial finished but the answer did not pass. This is sealed.",
  },
  invalid: {
    label: "Invalid result",
    hint: "Harbor recorded an invalid trial result. This is sealed.",
  },
  benchmark_timeout: {
    label: "Timed out",
    hint: "The agent or verifier exceeded the locked time limit. This is sealed.",
  },
  cancelled: {
    label: "Cancelled",
    hint: "An operator cancelled this task. This is sealed.",
  },
} as const;

export type LogicalOutcome = keyof typeof LOGICAL_OUTCOME_COPY;

export function logicalOutcomeLabel(value: string | null | undefined): string {
  const key = value ?? "pending";
  if (!(key in LOGICAL_OUTCOME_COPY)) {
    throw new Error(`unknown logical outcome: ${key}`);
  }
  return LOGICAL_OUTCOME_COPY[key as LogicalOutcome].label;
}

export function logicalOutcomeHint(value: string | null | undefined): string {
  const key = value ?? "pending";
  if (!(key in LOGICAL_OUTCOME_COPY)) {
    throw new Error(`unknown logical outcome: ${key}`);
  }
  return LOGICAL_OUTCOME_COPY[key as LogicalOutcome].hint;
}

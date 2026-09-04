import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function formatMoney(microusd: number): string {
  return formatMoneyUsd(microusd / 1_000_000);
}

export function formatMoneyUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unavailable";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 6 : 2,
  }).format(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function formatDuration(
  started: string | null | undefined,
  finished: string | null | undefined,
): string {
  if (!started || !finished) return "Unavailable";
  const milliseconds = new Date(finished).valueOf() - new Date(started).valueOf();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Unavailable";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unavailable";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function shortId(value: string): string {
  return value.length > 28 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value;
}

export const runNameClass = "block min-w-0 break-all font-mono text-xs";

export function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export const LOGICAL_OUTCOME_COPY = {
  pending: { label: "Not complete", hint: "This item does not have a final result." },
  complete: { label: "Complete", hint: "Harbor completed and scored this trial." },
  policy: {
    label: "Provider rejected the request",
    hint: "The inference provider did not accept the request.",
  },
  agent: {
    label: "Agent ended without a score",
    hint: "The agent ended before Harbor recorded a score.",
  },
  infrastructure: {
    label: "Infrastructure failure",
    hint: "A Job, platform, or network error stopped the trial.",
  },
  verifier: {
    label: "Verifier failed",
    hint: "The verifier could not score the trial.",
  },
  refusal: { label: "Model refused", hint: "The model refused to complete the task." },
  semantic: {
    label: "Wrong or incomplete answer",
    hint: "The trial completed, but the answer did not pass.",
  },
  invalid: {
    label: "Invalid result",
    hint: "Harbor recorded an invalid trial result.",
  },
  benchmark_timeout: {
    label: "Timed out",
    hint: "The agent or verifier exceeded the time limit.",
  },
  cancelled: { label: "Cancelled", hint: "An operator cancelled this work." },
} as const;

type LogicalOutcome = keyof typeof LOGICAL_OUTCOME_COPY;

export function logicalOutcomeLabel(value: string | null | undefined): string {
  const key = value ?? "pending";
  return key in LOGICAL_OUTCOME_COPY
    ? LOGICAL_OUTCOME_COPY[key as LogicalOutcome].label
    : humanize(key);
}

export function logicalOutcomeHint(value: string | null | undefined): string {
  const key = value ?? "pending";
  return key in LOGICAL_OUTCOME_COPY
    ? LOGICAL_OUTCOME_COPY[key as LogicalOutcome].hint
    : "Harbor reported this outcome.";
}

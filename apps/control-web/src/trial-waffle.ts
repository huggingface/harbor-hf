import type { RunView, TrialProgress } from "./api";

export const waffleStates = {
  pending: {
    label: "No mapped observation",
    symbol: "·",
    color: "border-slate-600 bg-slate-800 text-slate-300",
  },
  unfinished: {
    label: "Unfinished artifact observed (live state unknown)",
    symbol: "?",
    color: "border-cyan-400 bg-cyan-600 text-cyan-100",
  },
  completed: {
    label: "Completed",
    symbol: "✓",
    color: "border-emerald-400 bg-emerald-700 text-emerald-100",
  },
  zero: {
    label: "Zero reward",
    symbol: "0",
    color: "border-amber-400 bg-amber-700 text-amber-100",
  },
  error: {
    label: "Errored",
    symbol: "!",
    color: "border-rose-400 bg-rose-700 text-rose-100",
  },
  cancelled: {
    label: "Cancelled",
    symbol: "−",
    color: "border-orange-400 bg-orange-800 text-orange-100",
  },
  uncertain: {
    label: "Uncertain / interrupted",
    symbol: "?",
    color: "border-violet-400 border-dashed bg-violet-950 text-violet-200",
  },
} as const;
export type WaffleState = keyof typeof waffleStates;
type ObservedTrial = TrialProgress["trials"][number];
export interface WaffleCell {
  key: string;
  columnKey: string;
  reservedName: string | null;
  task: string;
  digest: string;
  slot: number;
  trial: ObservedTrial | null;
  state: WaffleState;
}
const RECENT_MS = 60_000;
export function recent(value: unknown, now: number): boolean {
  if (typeof value !== "string") return false;
  const age = now - Date.parse(value);
  return Number.isFinite(age) && age >= -5_000 && age <= RECENT_MS;
}

function state(trial: ObservedTrial, fresh: boolean): WaffleState {
  if (trial.result?.finished_at) {
    const exception = trial.result.exception_info?.exception_type;
    if (exception) return exception === "CancelledError" ? "cancelled" : "error";
    return trial.reward === 0 ? "zero" : "completed";
  }
  return fresh && (trial.config || trial.lock) ? "unfinished" : "uncertain";
}

// Display-only grouping of native observations. A slot is NOT a Harbor attempt
// ordinal. trial_name remains the actual identity and repeats are never merged.
export function waffleCells(
  _run: RunView,
  data: TrialProgress,
  now: number,
  refreshFailed = false,
  previous: readonly WaffleCell[] = [],
): WaffleCell[] {
  const fresh = !refreshFailed && recent(data.observed_at, now);
  const groups = new Map<
    string,
    { task: string; digest: string; planned: number; trials: ObservedTrial[] }
  >();
  const group = (task: string, digest: string) => {
    const key = JSON.stringify([task, digest]);
    let value = groups.get(key);
    if (!value) {
      value = { task, digest, planned: 0, trials: [] };
      groups.set(key, value);
    }
    return value;
  };
  for (const item of data.lock?.trials ?? [])
    group(item.task.name, item.task.digest).planned++;
  const unique = new Map(data.trials.map((trial) => [trial.trial_name, trial]));
  for (const trial of unique.values()) {
    const task = trial.lock?.task.name ?? trial.result?.task_name ?? trial.trial_name;
    const checksum = trial.result?.task_checksum;
    // Harbor's legacy dirhash checksum is NOT the lock's package content digest.
    const digest =
      trial.lock?.task.digest ??
      (checksum ? `legacy checksum: ${checksum}` : "unknown input");
    if (!data.lock || (trial.lock && groups.has(JSON.stringify([task, digest]))))
      group(task, digest).trials.push(trial);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => {
      const prior = previous.filter(
        (cell) => cell.task === value.task && cell.digest === value.digest,
      );
      // Preserve positions only for CURRENT matching native identities. Removed
      // names release capacity; a replacement is not an equivalent repetition.
      const capacity = data.lock ? value.planned : value.trials.length;
      const current = new Set(value.trials.map((trial) => trial.trial_name));
      const names: (string | null)[] = Array.from({ length: capacity }, (_, slot) => {
        const name = prior.find((cell) => cell.slot === slot + 1)?.reservedName;
        return name && current.has(name) ? name : null;
      });
      for (const trial of value.trials) {
        if (names.includes(trial.trial_name)) continue;
        const empty = names.indexOf(null);
        if (empty >= 0) names[empty] = trial.trial_name;
      }
      const observed = new Map(value.trials.map((trial) => [trial.trial_name, trial]));
      return Array.from({ length: capacity }, (_, slot) => {
        const reservedName = names[slot] ?? null;
        const trial = reservedName ? (observed.get(reservedName) ?? null) : null;
        const columnKey = JSON.stringify([key, slot]);
        return {
          key: trial
            ? JSON.stringify(["trial", trial.trial_name])
            : `placeholder:${columnKey}`,
          columnKey,
          reservedName,
          task: value.task,
          digest: value.digest,
          slot: slot + 1,
          trial,
          state: trial ? state(trial, fresh) : "pending",
        };
      });
    });
}

export function trialExceptionLabel(trial: ObservedTrial | null): string {
  const info = trial?.result?.exception_info;
  const type = info?.exception_type;
  if (type?.trim()) return `Native exception: ${type}`;
  return info === null
    ? "No recorded exception (not proof of valid scoring)"
    : "Native exception evidence: unknown / unavailable";
}

export function cellDescription(cell: WaffleCell): string {
  return [
    `Task: ${cell.task}`,
    `Input: ${cell.digest}`,
    `Display slot: ${cell.slot} (not an attempt ordinal)`,
    `Trial: ${cell.trial?.trial_name ?? "not observed"}`,
    `State: ${waffleStates[cell.state].label}`,
    trialExceptionLabel(cell.trial),
    "Infrastructure classification: unknown (not recorded by Harbor).",
    `Reward: ${cell.trial?.reward ?? "not reported"}`,
    `Cost (USD): ${cell.trial?.cost_usd ?? "not reported"}`,
    `Started: ${cell.trial?.result?.started_at ?? "not reported"}`,
    `Finished: ${cell.trial?.result?.finished_at ?? "not reported"}`,
    "Display slots do not establish equivalent repetitions across runs.",
    "Artifact observation only; no individual HF Job association is implied.",
  ].join("\n");
}

export interface SeparateObservation {
  trial: ObservedTrial;
  removed: boolean;
}

// Mount-local observation history, not planned capacity or durable trial state.
export function separateObservations(
  data: TrialProgress,
  cells: readonly WaffleCell[],
  previous: readonly SeparateObservation[] = [],
  previousCells: readonly WaffleCell[] = [],
): SeparateObservation[] {
  const current = new Map(data.trials.map((trial) => [trial.trial_name, trial]));
  const mapped = new Set(
    cells.flatMap((cell) => (cell.trial ? [cell.trial.trial_name] : [])),
  );
  const known = new Map(previous.map((item) => [item.trial.trial_name, item.trial]));
  for (const cell of previousCells) {
    if (cell.trial) known.set(cell.trial.trial_name, cell.trial);
  }
  for (const [name, trial] of current) known.set(name, trial);
  return [...known.entries()]
    .filter(([name]) => !mapped.has(name))
    .map(([name, trial]) => ({ trial, removed: !current.has(name) }));
}

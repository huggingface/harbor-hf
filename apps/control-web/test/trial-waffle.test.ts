import { describe, expect, it } from "vitest";
import type { RunView, TrialProgress } from "../src/api";
import {
  cellDescription,
  recent,
  separateObservations,
  trialExceptionLabel,
  waffleCells,
  waffleStates,
} from "../src/trial-waffle";

const now = Date.parse("2026-09-08T12:00:00Z");
const timestamp = new Date(now).toISOString();
const task = { name: "task-a", digest: "sha256:abc" };
const run = { status: "running", result: { updated_at: timestamp } } as RunView;
function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("Missing fixture element");
  return value;
}
function data(): TrialProgress {
  return {
    observed_at: timestamp,
    jobs_observed_at: timestamp,
    lock: { trials: Array.from({ length: 5 }, () => ({ task })) },
    jobs: [
      {
        id: "parent-test",
        run_id: "run-test",
        role: "parent",
        stage: "running",
        created_at: timestamp,
        started_at: timestamp,
        finished_at: null,
      },
    ],
    trials: [
      {
        trial_name: "trial-a",
        config: { trial_name: "trial-a" },
        lock: { task },
        result: null,
        reward: null,
        cost_usd: null,
      },
    ],
  };
}
describe("native artifact waffle", () => {
  it("retains five planned repetitions and native identity", () => {
    const value = data();
    const initial = value.trials[0];
    if (!initial) throw Error("fixture missing");
    value.trials.push({
      ...initial,
      trial_name: "trial-b",
      result: {
        finished_at: timestamp,
        task_checksum: "legacy-dirhash-not-lock-digest",
      },
      reward: 0,
    });
    const cells = waffleCells(run, value, now);
    expect(cells.map((cell) => cell.state)).toEqual([
      "unfinished",
      "zero",
      "pending",
      "pending",
      "pending",
    ]);
    expect(new Set(cells.map((cell) => cell.key)).size).toBe(5);
    expect(cells[1]?.trial?.trial_name).toBe("trial-b");
    expect(cellDescription(first(cells))).not.toContain("not an attempt ordinal");
  });
  it.each(["paused", "cancelled", "finished", "cost_stopped", "queued"] as const)(
    "labels unfinished artifacts without inferring live state for %s runs",
    (status) => {
      expect(waffleCells({ ...run, status }, data(), now)[0]?.state).toBe("unfinished");
    },
  );
  it("does not use parent or heartbeat observations as per-trial state", () => {
    const value = data();
    value.jobs_observed_at = null;
    value.jobs = [];
    expect(waffleCells({ ...run, result: {} }, value, now)[0]?.state).toBe(
      "unfinished",
    );
    expect(waffleCells(run, value, now + 61_000)[0]?.state).toBe("uncertain");
  });
  it.each([
    [null, null, "completed"],
    [0, null, "zero"],
    [1, null, "completed"],
    [0, "VerifierError", "error"],
    [null, "CancelledError", "cancelled"],
  ] as const)(
    "preserves native outcome and reward %s / %s",
    (reward, exception, expected) => {
      const value = data();
      const trial = value.trials[0];
      if (!trial) throw Error("fixture missing");
      trial.result = {
        finished_at: timestamp,
        exception_info: exception ? { exception_type: exception } : null,
      };
      trial.reward = reward;
      expect(waffleCells(run, value, now)[0]?.state).toBe(expected);
    },
  );
  it("does not equate a result without finished_at to completion", () => {
    const value = data();
    first(value.trials).result = { started_at: timestamp, finished_at: null };
    expect(waffleCells(run, value, now)[0]?.state).toBe("unfinished");
  });
  it("keeps changed inputs and excess observed trials rather than collapsing them", () => {
    const value = data();
    value.lock = { trials: [{ task }] };
    value.trials.push({ ...first(value.trials), trial_name: "trial-b" });
    value.trials.push({
      ...first(value.trials),
      trial_name: "trial-c",
      lock: { task: { ...task, digest: "sha256:other" } },
    });
    const cells = waffleCells(run, value, now);
    expect(cells).toHaveLength(1);
    expect(separateObservations(value, cells)).toHaveLength(2);
  });
  it("can display historical results without trial locks, and unknown identities honestly", () => {
    const value = data();
    value.lock = null;
    first(value.trials).lock = null;
    first(value.trials).result = {
      task_name: "task-a",
      task_checksum: "abc",
      finished_at: timestamp,
    };
    expect(waffleCells(run, value, now)[0]?.digest).toBe("legacy checksum: abc");
    first(value.trials).result = null;
    first(value.trials).config = null;
    const cell = first(waffleCells(run, value, now));
    expect(cell.task).toBe("trial-a");
    expect(cell.state).toBe("uncertain");
    expect(cellDescription(cell)).toContain("Reward: -");
  });
  it("treats invalid and far-future timestamps as unknown", () => {
    for (const value of [null, "bad", new Date(now + 60_000).toISOString()])
      expect(recent(value, now)).toBe(false);
  });
});

it("keeps three task names times three native identities independently stateful", () => {
  const value = data();
  const tasks = ["task-a", "task-b", "task-c"].map((name) => ({ ...task, name }));
  value.lock = {
    trials: tasks.flatMap((task) => Array.from({ length: 3 }, () => ({ task }))),
  };
  value.trials = tasks.flatMap((task, index) =>
    Array.from({ length: 3 }, (_, repeat) => ({
      trial_name: `${task.name}__native${repeat}`,
      config: { trial_name: `${task.name}__native${repeat}` },
      lock: { task },
      result:
        repeat === 0
          ? null
          : {
              finished_at: timestamp,
              exception_info:
                index === 2
                  ? {
                      exception_type: repeat === 1 ? "CancelledError" : "VerifierError",
                    }
                  : null,
            },
      reward: repeat === 1 ? 0 : null,
      cost_usd: 0.1,
    })),
  );
  const cells = waffleCells(run, value, now);
  expect(cells).toHaveLength(9);
  expect(new Set(cells.map((cell) => cell.key)).size).toBe(9);
  expect(new Set(cells.map((cell) => cell.trial?.trial_name)).size).toBe(9);
  expect(cells.map((cell) => cell.state)).toEqual([
    "unfinished",
    "zero",
    "completed",
    "unfinished",
    "zero",
    "completed",
    "unfinished",
    "cancelled",
    "error",
  ]);
  first(value.trials).result = { finished_at: timestamp };
  const changed = waffleCells(run, value, now);
  expect(changed[0]?.state).toBe("completed");
  expect(changed.slice(1)).toEqual(cells.slice(1));
});

it("downgrades incomplete cells on stale artifacts, never completed evidence", () => {
  const value = data();
  value.trials.push({
    ...first(value.trials),
    trial_name: "trial-b",
    result: { finished_at: timestamp },
  });
  expect(
    waffleCells(run, value, now + 61_000)
      .slice(0, 2)
      .map((cell) => cell.state),
  ).toEqual(["uncertain", "completed"]);
  value.observed_at = new Date(now - 61_000).toISOString();
  expect(waffleCells(run, value, now)[0]?.state).toBe("uncertain");
});

it("preserves current positions but releases removed reservations", () => {
  const value = data();
  const template = first(value.trials);
  value.trials = [{ ...template, trial_name: "trial-z" }];
  const initial = waffleCells(run, value, now);
  value.trials = [
    { ...template, trial_name: "trial-a" },
    { ...template, trial_name: "trial-z" },
  ];
  const next = waffleCells(run, value, now, initial);
  expect(next[0]?.trial?.trial_name).toBe("trial-z");
  expect(next[0]?.key).toBe(initial[0]?.key);
  expect(next[1]?.trial?.trial_name).toBe("trial-a");
  expect(next[1]?.key).not.toBe(initial[1]?.key);
  value.trials = [{ ...template, trial_name: "trial-a" }];
  const removed = waffleCells(run, value, now, next);
  expect(removed[0]?.trial).toBeNull();
  expect(removed[0]?.state).toBe("pending");
  expect(removed[1]?.key).toBe(next[1]?.key);
  value.trials.unshift({ ...template, trial_name: "trial-b" });
  const added = waffleCells(run, value, now, removed);
  expect(added[0]?.trial?.trial_name).toBe("trial-b");
  value.trials.push({ ...template, trial_name: "trial-z" });
  const restored = waffleCells(run, value, now, added);
  expect(restored[2]?.key).toBe(initial[0]?.key);
  expect(cellDescription(first(restored))).not.toContain(
    "do not establish equivalent repetitions",
  );
});

it("keeps nine planned squares through partial observations, removal, replacements and remount", () => {
  const value = data();
  value.lock = { trials: Array.from({ length: 9 }, () => ({ task })) };
  const template = first(value.trials);
  value.trials = [{ ...template, lock: null }];
  let cells = waffleCells(run, value, now);
  expect(cells).toHaveLength(9);
  let separate = separateObservations(value, cells);
  expect(separate).toHaveLength(1);
  expect(cells.every((cell) => !cell.trial)).toBe(true);
  value.trials = [template, template]; // same name is one native identity
  let next = waffleCells(run, value, now, cells);
  separate = separateObservations(value, next, separate, cells);
  expect(separate).toEqual([]);
  expect(next.filter((cell) => cell.trial)).toHaveLength(1);
  for (let count = 1; count <= 9; count++) {
    cells = next;
    value.trials = Array.from({ length: count }, (_, i) => ({
      ...template,
      trial_name: `old-${i}`,
    }));
    next = waffleCells(run, value, now, cells);
    expect(next).toHaveLength(9);
    expect(next.filter((cell) => cell.trial)).toHaveLength(count);
  }
  cells = next;
  value.trials = [];
  next = waffleCells(run, value, now, cells);
  separate = separateObservations(value, next, [], cells);
  expect(separate).toHaveLength(9);
  expect(separate.every((item) => item.removed)).toBe(true);
  expect(next.every((cell) => cell.state === "pending" && !cell.reservedName)).toBe(
    true,
  );
  value.trials = Array.from({ length: 9 }, (_, i) => ({
    ...template,
    trial_name: `new-${i}`,
  }));
  const replacement = waffleCells(run, value, now, next);
  expect(replacement).toHaveLength(9);
  expect(replacement).toEqual(waffleCells(run, value, now));
  expect(replacement.every((cell) => !cells.some((old) => old.key === cell.key))).toBe(
    true,
  );
  expect(separateObservations(value, replacement, separate, next)).toHaveLength(9);
  expect(separateObservations(value, replacement)).toEqual([]); // remount has no removal history
  expect(waffleCells(run, value, now, replacement)).toEqual(replacement);
});

it("moves a config-only name globally when its native lock arrives", () => {
  const value = data();
  const template = first(value.trials);
  value.lock = null;
  value.trials = [{ ...template, lock: null }];
  const initial = waffleCells(run, value, now);
  expect(initial).toHaveLength(1);
  value.lock = { trials: Array.from({ length: 9 }, () => ({ task })) };
  const partial = waffleCells(run, value, now, initial);
  expect(partial).toHaveLength(9);
  expect(separateObservations(value, partial, [], initial)).toHaveLength(1);
  value.trials = [template, template];
  const mapped = waffleCells(run, value, now, partial);
  expect(mapped).toHaveLength(9);
  expect(mapped.filter((cell) => cell.trial)).toHaveLength(1);
  expect(mapped[0]?.key).toBe(initial[0]?.key);
  expect(mapped).toEqual(waffleCells(run, value, now));
  expect(separateObservations(value, mapped, [], partial)).toEqual([]);
});

it("keeps absent native evidence unknown and distinguishes explicit null", () => {
  const trial = first(data().trials);
  for (const result of [null, {}, { exception_info: { exception_type: " " } }]) {
    expect(trialExceptionLabel({ ...trial, result })).toBe(
      "Native exception evidence: unknown / unavailable",
    );
  }
  expect(trialExceptionLabel(null)).toBe(
    "Native exception evidence: unknown / unavailable",
  );
  expect(trialExceptionLabel({ ...trial, result: { exception_info: null } })).toBe(
    "No recorded exception (not proof of valid scoring)",
  );
  expect(
    trialExceptionLabel({
      ...trial,
      result: { exception_info: { exception_type: "CustomException" } },
    }),
  ).toBe("Native exception: CustomException");
});

it.each([
  [null, null, null, "Completed", "-", []],
  [0, 0, null, "Zero reward", "0.000", ["Reported cost (USD): $0.0000"]],
  [
    0.5168539,
    12.345,
    "RuntimeError",
    "Errored",
    "0.517",
    ["Exception: RuntimeError", "Reported cost (USD): $12.35"],
  ],
  [
    0,
    0.000123,
    "RuntimeError",
    "Errored",
    "0.000",
    ["Exception: RuntimeError", "Reported cost (USD): $0.000123"],
  ],
] as const)(
  "compact reward %s / cost %s / exception %s",
  (reward, cost, exception, state, formatted, extra) => {
    const value = data();
    const trial = first(value.trials);
    trial.reward = reward;
    trial.cost_usd = cost;
    trial.result = {
      finished_at: timestamp,
      exception_info: exception ? { exception_type: exception } : null,
    };
    const cell = first(waffleCells(run, value, now));
    expect(cellDescription(cell)).toBe(
      [
        "Task: task-a",
        "Repeat slot: 1",
        `State: ${state}`,
        `Reward: ${formatted}`,
        "Agent time: −",
        "Trial last checked: unavailable",
        ...extra,
      ].join("\n"),
    );
    expect(cellDescription(cell)).not.toMatch(
      /Input:|Trial:|Started:|Finished:|attempt ordinal|Artifact observation/,
    );
  },
);

it("keeps unfinished and unknown short without claiming live running", () => {
  expect(cellDescription(first(waffleCells(run, data(), now)))).toBe(
    "Task: task-a\nRepeat slot: 1\nState: Unfinished\nReward: -\nAgent time: −\nTrial last checked: unavailable",
  );
  expect(cellDescription(first(waffleCells(run, data(), now + 61_000)))).toBe(
    "Task: task-a\nRepeat slot: 1\nState: Unknown / interrupted\nReward: -\nAgent time: −\nTrial last checked: unavailable",
  );
});

it("uses unequal marker magnitudes without question marks or invented activity", () => {
  expect(waffleStates.pending.marker).toBe("h-1 w-1");
  expect(waffleStates.unfinished.marker).toBe("h-[11px] w-[11px]");
  expect(waffleStates.unfinished.color).toContain("bg-cyan-400");
  expect(waffleStates.uncertain.color).toContain("bg-transparent");
  expect(waffleStates.uncertain.color).toContain("border-violet-400");
  for (const state of Object.values(waffleStates)) {
    expect(state.symbol).not.toBe("?");
    expect(state.label).not.toMatch(/running/i);
  }
  expect([
    waffleStates.completed.symbol,
    waffleStates.zero.symbol,
    waffleStates.error.symbol,
    waffleStates.cancelled.symbol,
  ]).toEqual(["✓", "0", "!", "−"]);
});

it("keeps the one-minute age and five-second future-skew boundaries", () => {
  expect(recent(new Date(now - 60_000).toISOString(), now)).toBe(true);
  expect(recent(new Date(now - 60_001).toISOString(), now)).toBe(false);
  expect(recent(new Date(now + 5_000).toISOString(), now)).toBe(true);
  expect(recent(new Date(now + 5_001).toISOString(), now)).toBe(false);
});

it("uses each trial's check time independently of fresh discovery", () => {
  const value = data();
  const active = first(value.trials);
  active.observed_at = timestamp;
  value.trials.push({
    ...active,
    trial_name: "trial-done",
    observed_at: new Date(now - 120_000).toISOString(),
    result: { finished_at: timestamp },
  });
  expect(
    waffleCells(run, value, now)
      .slice(0, 2)
      .map((cell) => cell.state),
  ).toEqual(["unfinished", "completed"]);
  value.observed_at = new Date(now + 61_000).toISOString();
  const cells = waffleCells(run, value, now + 61_000);
  expect(cells.slice(0, 2).map((cell) => cell.state)).toEqual([
    "uncertain",
    "completed",
  ]);
  expect(cellDescription(first(cells), value.observed_at)).toContain(
    `Trial last checked: ${timestamp}`,
  );
});

it("falls back to discovery freshness only for legacy trials without a check time", () => {
  const value = data();
  expect(waffleCells(run, value, now)[0]?.state).toBe("unfinished");
  expect(
    cellDescription(first(waffleCells(run, value, now)), value.observed_at),
  ).toContain(`Trial last checked: ${timestamp}`);
  value.observed_at = new Date(now - 61_000).toISOString();
  expect(waffleCells(run, value, now)[0]?.state).toBe("uncertain");
  first(value.trials).observed_at = timestamp;
  expect(waffleCells(run, value, now)[0]?.state).toBe("unfinished");
});

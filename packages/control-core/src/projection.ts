import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AttemptCostV1, RunRecordV1, RunStateV1 } from "@harbor-hf/contracts";
import {
  validateAttemptCost,
  validateRunRecord,
  validateRunState,
} from "@harbor-hf/contracts";
import Database from "better-sqlite3";
import { isLiveJob, type JobObservation } from "./jobs.js";
import { type ObjectStore, readJson } from "./store.js";

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelled"
  | "finished"
  | "cost_stopped";

export interface TrialSummary {
  run_id: string;
  trial_name: string;
  reward: number | null;
  cost_usd: number | null;
  status: "completed" | "error" | "cancelled";
  result: Record<string, unknown>;
}

export interface RunView {
  record: RunRecordV1;
  state: RunStateV1;
  status: RunStatus;
  result: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function contextCost(value: unknown): number | null {
  return numeric(asRecord(value)?.cost_usd);
}

function trialCost(result: Record<string, unknown>): number | null {
  const direct = contextCost(result.agent_result);
  if (direct !== null) return direct;
  if (!Array.isArray(result.step_results)) return null;
  const costs = result.step_results
    .map((step) => contextCost(asRecord(step)?.agent_result))
    .filter((value): value is number => value !== null);
  return costs.length > 0 ? costs.reduce((total, value) => total + value, 0) : null;
}

function trialReward(result: Record<string, unknown>): number | null {
  const rewards = asRecord(asRecord(result.verifier_result)?.rewards);
  if (!rewards) return null;
  const named = numeric(rewards.reward);
  if (named !== null) return named;
  for (const key of Object.keys(rewards).sort()) {
    const value = numeric(rewards[key]);
    if (value !== null) return value;
  }
  return null;
}

function trialStatus(result: Record<string, unknown>): TrialSummary["status"] {
  const exception = asRecord(result.exception_info);
  if (!exception) return "completed";
  return exception.exception_type === "CancelledError" ? "cancelled" : "error";
}

export function summarizeTrial(
  runId: string,
  fallbackName: string,
  value: unknown,
): TrialSummary {
  const result = asRecord(value);
  if (!result) throw new Error("Harbor trial result must be an object");
  return {
    run_id: runId,
    trial_name:
      typeof result.trial_name === "string" ? result.trial_name : fallbackName,
    reward: trialReward(result),
    cost_usd: trialCost(result),
    status: trialStatus(result),
    result,
  };
}

export function costLimitReached(
  record: RunRecordV1,
  result: Record<string, unknown> | null,
  trials: readonly TrialSummary[],
  attemptCosts: readonly (number | null)[] = trials.map((trial) => trial.cost_usd),
): boolean {
  const ceiling = record.submission.cost_ceiling_usd_per_trial;
  if (attemptCosts.some((cost) => cost === null || cost > ceiling)) return true;
  const total = attemptCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const planned = numeric(result?.n_total_trials);
  return planned !== null && planned > 0 && total > ceiling * planned;
}

export function statusFor(
  record: RunRecordV1,
  state: RunStateV1,
  result: Record<string, unknown> | null,
  trials: readonly TrialSummary[],
  jobs: readonly JobObservation[],
  attemptCosts?: readonly (number | null)[],
): RunStatus {
  if (state.desired_state === "cancelled") return "cancelled";
  if (state.desired_state === "paused") return "paused";
  if (costLimitReached(record, result, trials, attemptCosts)) return "cost_stopped";
  if (typeof result?.finished_at === "string" && result.finished_at) return "finished";
  if (jobs.some((job) => job.role === "parent" && isLiveJob(job))) return "running";
  return "queued";
}

function receiptIdFromKey(prefix: string, key: string): string {
  return key.slice(prefix.length, -".json".length);
}

function trialAttemptId(trial: TrialSummary): string | null {
  return typeof trial.result.id === "string" ? trial.result.id : null;
}

function authoritativeAttemptCosts(
  receipts: readonly AttemptCostV1[],
  trials: readonly TrialSummary[],
): Array<number | null> {
  const receiptsById = new Map(
    receipts.map((receipt) => [receipt.attempt_id, receipt]),
  );
  const costs = receipts.map((receipt) => receipt.cost_usd);
  for (const trial of trials) {
    const attemptId = trialAttemptId(trial);
    const receipt = attemptId === null ? undefined : receiptsById.get(attemptId);
    if (!receipt) {
      costs.push(trial.cost_usd);
      continue;
    }
    if (receipt.trial_name !== trial.trial_name || receipt.cost_usd !== trial.cost_usd)
      throw new Error("attempt cost receipt conflicts with Harbor result");
  }
  return costs;
}

export class Projection {
  private constructor(private readonly database: Database.Database) {}

  static async open(path: string): Promise<Projection> {
    await mkdir(dirname(path), { recursive: true });
    const database = new Database(path);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        record_body TEXT NOT NULL,
        state_body TEXT NOT NULL,
        status TEXT NOT NULL,
        result_body TEXT
      );
      CREATE TABLE IF NOT EXISTS trials (
        run_id TEXT NOT NULL,
        trial_name TEXT NOT NULL,
        reward REAL,
        cost_usd REAL,
        status TEXT NOT NULL,
        result_body TEXT NOT NULL,
        PRIMARY KEY (run_id, trial_name)
      );
      CREATE TABLE IF NOT EXISTS parent_jobs (
        job_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        body TEXT NOT NULL
      );
    `);
    return new Projection(database);
  }

  async rebuild(store: ObjectStore, jobs: readonly JobObservation[]): Promise<void> {
    const entries = await store.list("runs");
    const keys = new Set(entries.map((entry) => entry.key));
    const runIds = [...keys]
      .filter((key) => /^runs\/run-[0-9a-f]{24}\/run\.json$/.test(key))
      .map((key) => key.split("/")[1])
      .filter((value): value is string => Boolean(value))
      .sort();
    const rows: Array<{
      view: RunView;
      trials: TrialSummary[];
    }> = [];
    for (const runId of runIds) {
      const stateKey = `runs/${runId}/state.json`;
      if (!keys.has(stateKey)) continue;
      const record = validateRunRecord(await readJson(store, `runs/${runId}/run.json`));
      const state = validateRunState(await readJson(store, stateKey));
      const resultKey = `runs/${runId}/job/result.json`;
      const result = keys.has(resultKey)
        ? asRecord(await readJson(store, resultKey))
        : null;
      const trialPrefix = `runs/${runId}/job/`;
      const trialKeys = [...keys]
        .filter(
          (key) =>
            key.startsWith(trialPrefix) &&
            key.endsWith("/result.json") &&
            key !== resultKey &&
            key.slice(trialPrefix.length).split("/").length === 2,
        )
        .sort();
      const trials = await Promise.all(
        trialKeys.map(async (key) => {
          const name = key.slice(trialPrefix.length, -"/result.json".length);
          return summarizeTrial(runId, name, await readJson(store, key));
        }),
      );
      const receiptPrefix = `runs/${runId}/attempt-costs/`;
      const receiptKeys = [...keys]
        .filter(
          (key) =>
            key.startsWith(receiptPrefix) &&
            key.endsWith(".json") &&
            !key.slice(receiptPrefix.length).includes("/"),
        )
        .sort();
      const receipts = await Promise.all(
        receiptKeys.map(async (key) => {
          const receipt = validateAttemptCost(await readJson(store, key));
          if (receiptIdFromKey(receiptPrefix, key) !== receipt.attempt_id)
            throw new Error("attempt cost receipt path does not match its id");
          return receipt;
        }),
      );
      const runJobs = jobs.filter((job) => job.run_id === runId);
      rows.push({
        view: {
          record,
          state,
          status: statusFor(
            record,
            state,
            result,
            trials,
            runJobs,
            authoritativeAttemptCosts(receipts, trials),
          ),
          result,
        },
        trials,
      });
    }

    this.database.transaction(() => {
      this.database.exec(
        "DELETE FROM trials; DELETE FROM parent_jobs; DELETE FROM runs;",
      );
      const insertRun = this.database.prepare(
        "INSERT INTO runs (run_id, created_at, record_body, state_body, status, result_body) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertTrial = this.database.prepare(
        "INSERT INTO trials (run_id, trial_name, reward, cost_usd, status, result_body) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertJob = this.database.prepare(
        "INSERT INTO parent_jobs (job_id, run_id, stage, started_at, finished_at, body) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const { view, trials } of rows) {
        insertRun.run(
          view.record.run_id,
          view.record.created_at,
          JSON.stringify(view.record),
          JSON.stringify(view.state),
          view.status,
          view.result ? JSON.stringify(view.result) : null,
        );
        for (const trial of trials)
          insertTrial.run(
            trial.run_id,
            trial.trial_name,
            trial.reward,
            trial.cost_usd,
            trial.status,
            JSON.stringify(trial.result),
          );
      }
      for (const job of jobs.filter((item) => item.role === "parent"))
        insertJob.run(
          job.id,
          job.run_id,
          job.stage,
          job.started_at,
          job.finished_at,
          JSON.stringify(job),
        );
    })();
  }

  listRuns(): RunView[] {
    const rows = this.database
      .prepare(
        "SELECT record_body, state_body, status, result_body FROM runs ORDER BY created_at DESC, run_id DESC",
      )
      .all() as Array<{
      record_body: string;
      state_body: string;
      status: RunStatus;
      result_body: string | null;
    }>;
    return rows.map((row) => ({
      record: validateRunRecord(JSON.parse(row.record_body)),
      state: validateRunState(JSON.parse(row.state_body)),
      status: row.status,
      result: row.result_body
        ? (JSON.parse(row.result_body) as Record<string, unknown>)
        : null,
    }));
  }

  run(runId: string): RunView | null {
    return this.listRuns().find((item) => item.record.run_id === runId) ?? null;
  }

  trials(runId: string): TrialSummary[] {
    const rows = this.database
      .prepare(
        "SELECT trial_name, reward, cost_usd, status, result_body FROM trials WHERE run_id = ? ORDER BY trial_name",
      )
      .all(runId) as Array<{
      trial_name: string;
      reward: number | null;
      cost_usd: number | null;
      status: TrialSummary["status"];
      result_body: string;
    }>;
    return rows.map((row) => ({
      run_id: runId,
      trial_name: row.trial_name,
      reward: row.reward,
      cost_usd: row.cost_usd,
      status: row.status,
      result: JSON.parse(row.result_body) as Record<string, unknown>,
    }));
  }

  jobs(): JobObservation[] {
    const rows = this.database
      .prepare("SELECT body FROM parent_jobs ORDER BY COALESCE(started_at, ''), job_id")
      .all() as Array<{ body: string }>;
    return rows.map((row) => JSON.parse(row.body) as JobObservation);
  }

  system(): { runs: number; trials: number; parent_jobs: number } {
    const count = (table: string): number =>
      (
        this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count;
    return {
      runs: count("runs"),
      trials: count("trials"),
      parent_jobs: count("parent_jobs"),
    };
  }

  close(): void {
    this.database.close();
  }
}

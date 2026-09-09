import { PricingProjection } from "./pricing-projection.js";
import type { PricingProjectionView } from "./pricing-corrections.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  SharedEstimateV1,
  AgentTimingV1,
  AttemptCostV1,
  RunRecordV1,
  RunPresentationV1,
  RunStateV1,
} from "@harbor-hf/contracts";
import { sumAgentTiming } from "@harbor-hf/contracts/agent-timing";
import {
  validateAttemptCost,
  validateRunRecord,
  validateRunPresentation,
  runPresentationPath,
  validateRunState,
} from "@harbor-hf/contracts";
import { launchEstimate } from "@harbor-hf/contracts/pricing";
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

export interface RunView extends Partial<PricingProjectionView> {
  shared_estimate?: SharedEstimateV1;
  presentation_available?: boolean;
  presentation?: RunPresentationV1 | null;
  agent_timing?: AgentTimingV1;
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

function agentExecutionStarted(result: Record<string, unknown>): boolean {
  if (asRecord(result.agent_result)) return true;
  const execution = asRecord(result.agent_execution);
  if (execution?.started_at !== null && execution?.started_at !== undefined)
    return true;
  if (!Array.isArray(result.step_results)) return false;
  return result.step_results.some((value) => {
    const step = asRecord(value);
    if (!step) return false;
    if (asRecord(step.agent_result)) return true;
    const stepExecution = asRecord(step.agent_execution);
    return (
      stepExecution?.started_at !== null && stepExecution?.started_at !== undefined
    );
  });
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
  if (attemptCosts.some((cost) => cost !== null && cost > ceiling)) return true;
  const exposure = attemptCosts.reduce<number>(
    (sum, cost) => sum + (cost ?? ceiling),
    0,
  );
  const planned = numeric(result?.n_total_trials);
  return planned !== null && planned > 0 && exposure > ceiling * planned;
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
    const preAgentZero =
      receipt.cost_usd === 0 &&
      trial.cost_usd === null &&
      !agentExecutionStarted(trial.result);
    if (
      receipt.trial_name !== trial.trial_name ||
      (receipt.cost_usd !== trial.cost_usd && !preAgentZero)
    )
      throw new Error("attempt cost receipt conflicts with Harbor result");
  }
  return costs;
}

export class Projection {
  private observations: readonly JobObservation[] = [];
  private observationsAt: string | null = null;
  private presentationGeneration = 0;
  private readonly presentationMutations = new Map<string, number>();

  private notePresentationMutation(runId: string): void {
    this.presentationMutations.set(runId, ++this.presentationGeneration);
  }

  jobObservations(): { jobs: readonly JobObservation[]; observed_at: string | null } {
    return {
      jobs: structuredClone(this.observations),
      observed_at: this.observationsAt,
    };
  }

  readonly pricing: PricingProjection;
  private constructor(private readonly database: Database.Database) {
    this.pricing = new PricingProjection(database);
  }

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
    // This is a disposable projection cache, never a durable run-record field.
    const columns = database.pragma("table_info(runs)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "agent_timing_body"))
      database.exec("ALTER TABLE runs ADD COLUMN agent_timing_body TEXT");
    if (!columns.some((column) => column.name === "presentation_body"))
      database.exec("ALTER TABLE runs ADD COLUMN presentation_body TEXT");
    if (!columns.some((column) => column.name === "presentation_available"))
      database.exec(
        "ALTER TABLE runs ADD COLUMN presentation_available INTEGER NOT NULL DEFAULT 0",
      );
    return new Projection(database);
  }

  async rebuild(store: ObjectStore, jobs: readonly JobObservation[]): Promise<void> {
    // Capture before any reads, including the asynchronous listing. This orders
    // disposable cache writes, independently of durable presentation revisions.
    const rebuildStart = this.presentationGeneration;
    const pricingEpoch = this.pricing.generation;
    const observedAt = new Date().toISOString();
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
      const presentationKey = runPresentationPath(runId);
      // Display metadata must never gate execution/cancellation or orphan cleanup.
      const lastKnownPresentation = this.run(runId)?.presentation ?? null;
      let presentation = lastKnownPresentation;
      let presentationAvailable = true;
      try {
        presentation = keys.has(presentationKey)
          ? validateRunPresentation(await readJson(store, presentationKey))
          : null;
        if (presentation && presentation.run_id !== runId)
          throw new Error("run presentation path does not match its id");
      } catch {
        presentation = lastKnownPresentation;
        presentationAvailable = false;
      }
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
          ...(await this.pricing.load(store, runId)),
          presentation,
          presentation_available: presentationAvailable,
          agent_timing: sumAgentTiming(trials.map((trial) => trial.result)),
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
      // Rebuilds can overlap. Retain cache writes committed since this read epoch,
      // including equal-revision availability changes and null presentations.
      const cached = this.database
        .prepare("SELECT run_id, presentation_body, presentation_available FROM runs")
        .all() as Array<{
        run_id: string;
        presentation_body: string | null;
        presentation_available: number;
      }>;
      const existing = new Map(
        cached.map((row) => [
          row.run_id,
          {
            presentation: row.presentation_body
              ? validateRunPresentation(JSON.parse(row.presentation_body))
              : null,
            available: Boolean(row.presentation_available),
          },
        ]),
      );
      for (const { view } of rows) {
        const current = existing.get(view.record.run_id);
        if (
          current &&
          ((this.presentationMutations.get(view.record.run_id) ?? 0) > rebuildStart ||
            (current.presentation?.revision ?? 0) > (view.presentation?.revision ?? 0))
        ) {
          view.presentation = current?.presentation ?? null;
          view.presentation_available = current?.available ?? false;
        }
      }
      const pricingRows = new Map(
        rows.map(({ view }) => [
          view.record.run_id,
          this.pricing.retain(view.record.run_id, pricingEpoch, {
            pricing_corrections: view.pricing_corrections ?? null,
            pricing_corrections_available: view.pricing_corrections_available ?? false,
          }),
        ]),
      );
      this.database.exec(
        "DELETE FROM trials; DELETE FROM parent_jobs; DELETE FROM runs;",
      );
      const insertRun = this.database.prepare(
        "INSERT INTO runs (run_id, created_at, record_body, state_body, status, result_body, agent_timing_body, presentation_body, presentation_available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          JSON.stringify(view.agent_timing),
          view.presentation ? JSON.stringify(view.presentation) : null,
          view.presentation_available ? 1 : 0,
        );
        const pricingRow = pricingRows.get(view.record.run_id);
        if (!pricingRow) throw new Error("missing pricing rebuild row");
        this.pricing.write(view.record.run_id, pricingRow);
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
    // Advance only after a successful synchronous transaction. Even an unchanged
    // validated snapshot fences older overlapping reads (valid or failed).
    for (const { view } of rows) this.notePresentationMutation(view.record.run_id);
    for (const { view } of rows) this.pricing.committed(view.record.run_id);
    this.observations = structuredClone(jobs);
    this.observationsAt = observedAt;
  }

  markPresentationUnavailable(runId: string): void {
    this.database
      .prepare("UPDATE runs SET presentation_available = 0 WHERE run_id = ?")
      .run(runId);
    this.notePresentationMutation(runId);
  }

  updatePresentation(runId: string, presentation: RunPresentationV1 | null): void {
    const current = this.run(runId);
    if ((current?.presentation?.revision ?? 0) > (presentation?.revision ?? 0)) return;
    const result = this.database
      .prepare(
        "UPDATE runs SET presentation_body = ?, presentation_available = 1 WHERE run_id = ?",
      )
      .run(
        presentation ? JSON.stringify(validateRunPresentation(presentation)) : null,
        runId,
      );
    if (result.changes !== 1)
      throw new Error(
        "run presentation projection update failed; refetch before retry",
      );
    this.notePresentationMutation(runId);
  }

  private readRuns(runId?: string): RunView[] {
    const rows = this.database
      .prepare(
        `SELECT record_body, state_body, status, result_body, agent_timing_body, presentation_body, presentation_available, pricing_corrections_body, pricing_corrections_available FROM runs ${
          runId === undefined
            ? "ORDER BY created_at DESC, run_id DESC"
            : "WHERE run_id = ?"
        }`,
      )
      .all(...(runId === undefined ? [] : [runId])) as Array<{
      pricing_corrections_body: string | null;
      pricing_corrections_available: number;
      record_body: string;
      state_body: string;
      status: RunStatus;
      result_body: string | null;
      agent_timing_body: string | null;
      presentation_body: string | null;
      presentation_available: number;
    }>;
    return rows.map((row) => {
      const record = validateRunRecord(JSON.parse(row.record_body));
      const result = row.result_body
        ? (JSON.parse(row.result_body) as Record<string, unknown>)
        : null;
      const pricing = this.pricing.decode(
        row.pricing_corrections_body,
        Boolean(row.pricing_corrections_available),
        record.run_id,
      );
      const corrected = pricing.pricing_corrections?.revisions.at(-1)?.pricing;
      const estimate = launchEstimate(corrected ?? record.pricing, result);
      return {
        ...pricing,
        shared_estimate: !pricing.pricing_corrections_available
          ? {
              basis: "effective_rates_reported_usage",
              cost_usd: null,
              unavailable_reason: "correction_history_unavailable",
            }
          : {
              ...estimate,
              basis: corrected ? "corrected_rates_reported_usage" : estimate.basis,
            },
        presentation_available: Boolean(row.presentation_available),
        presentation: row.presentation_body
          ? validateRunPresentation(JSON.parse(row.presentation_body))
          : null,
        // Older disposable projections acquire measurements at the next rebuild.
        ...(row.agent_timing_body
          ? { agent_timing: JSON.parse(row.agent_timing_body) as AgentTimingV1 }
          : {}),
        record,
        state: validateRunState(JSON.parse(row.state_body)),
        status: row.status,
        result,
      };
    });
  }

  listRuns(): RunView[] {
    return this.readRuns();
  }

  run(runId: string): RunView | null {
    return this.readRuns(runId)[0] ?? null;
  }

  trials(runId: string, result: "full" | "identity" = "full"): TrialSummary[] {
    // Extract only native identity fields for polling. Do not load trajectories,
    // instructions, or agent kwargs into the API process for a list response.
    const body =
      result === "full"
        ? "result_body"
        : `json_object(
      'config', json_object('agent', json_object(
        'name', json_extract(result_body, '$.config.agent.name'),
        'import_path', json_extract(result_body, '$.config.agent.import_path'),
        'model_name', json_extract(result_body, '$.config.agent.model_name'))),
      'agent_info', json_object('version', json_extract(result_body, '$.agent_info.version'))
    )`;
    const rows = this.database
      .prepare(
        `SELECT trial_name, reward, cost_usd, status, ${body} AS result_body FROM trials WHERE run_id = ? ORDER BY trial_name`,
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

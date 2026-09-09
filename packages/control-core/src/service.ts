import { correctPricing } from "./pricing-corrections.js";
import type { RunRecordV1, RunStateV1, RunPresentationV1 } from "@harbor-hf/contracts";
import {
  canonicalJson,
  runId,
  runRecordPath,
  runStatePath,
  runPresentationPath,
  validateRunPresentation,
  validateRunRecord,
  validateRunState,
} from "@harbor-hf/contracts";
import {
  containsCredentialMaterial,
  directSubmission,
  type HarborAgentFragment,
  prepareDirectJobConfig,
  type PresetCatalog,
  type PresetSubmission,
} from "./presets.js";
import { isLiveJob, type JobObservation, type JobsPort } from "./jobs.js";
import type { Projection } from "./projection.js";
import { createJson, type ObjectStore, putJson, readJson } from "./store.js";

export interface ControlServiceOptions {
  harborRevision: string;
  mountRoot: string;
  maxActiveJobs: number;
  restartDelayMs: number;
}

export interface SubmissionResult {
  created: boolean;
  run: RunRecordV1;
}

function positiveCeiling(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 10_000)
    throw new Error("cost ceiling must be a finite positive USD value");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function harborJobReadyToFinalize(
  record: RunRecordV1,
  result: Record<string, unknown> | null,
): boolean {
  if (!result || (result.finished_at !== null && result.finished_at !== undefined))
    return false;
  const stats = asRecord(result.stats);
  const total = nonnegativeInteger(result.n_total_trials);
  const completed = nonnegativeInteger(stats?.n_completed_trials);
  const running = nonnegativeInteger(stats?.n_running_trials);
  const pending = nonnegativeInteger(stats?.n_pending_trials);
  const retryValue = record.harbor_job_config.retry;
  const retry = retryValue === undefined ? null : asRecord(retryValue);
  if (retryValue !== undefined && retry === null) return false;
  const maxRetries = nonnegativeInteger(retry?.max_retries ?? 0);
  return (
    total !== null &&
    total > 0 &&
    completed === total &&
    running === 0 &&
    pending === 0 &&
    maxRetries === 0
  );
}

function sameRequest(left: RunRecordV1, right: RunRecordV1): boolean {
  return (
    canonicalJson({
      submitted_by: left.submitted_by,
      role: left.role,
      harbor_revision: left.harbor_revision,
      submission: left.submission,
      workbench_recipe: left.workbench_recipe,
      pricing: left.pricing,
      harbor_job_config: left.harbor_job_config,
    }) ===
    canonicalJson({
      submitted_by: right.submitted_by,
      role: right.role,
      harbor_revision: right.harbor_revision,
      submission: right.submission,
      workbench_recipe: right.workbench_recipe,
      pricing: right.pricing,
      harbor_job_config: right.harbor_job_config,
    })
  );
}

async function readIfPresent(store: ObjectStore, key: string): Promise<unknown | null> {
  try {
    return await readJson(store, key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function initialState(record: RunRecordV1): RunStateV1 {
  return {
    schema_version: "v1",
    run_id: record.run_id,
    revision: 0,
    updated_at: record.created_at,
    desired_state: "run",
    actor: record.submitted_by,
    parent_jobs: [],
  };
}

export class PresentationConflictError extends Error {
  constructor() {
    super("Archive revision changed; reload before retrying");
  }
}

export class PresentationUpdateError extends Error {
  constructor() {
    super("Archive update could not be confirmed; refetch before retrying");
  }
}

export class ControlService {
  async correctPricing(id: string, body: unknown, actor: string) {
    return this.withRunLock(id, () =>
      correctPricing(this.store, this.projection, id, body, actor),
    );
  }
  private readonly runOperations = new Map<string, Promise<void>>();

  constructor(
    readonly store: ObjectStore,
    readonly projection: Projection,
    readonly presets: PresetCatalog,
    readonly jobs: JobsPort,
    readonly options: ControlServiceOptions,
  ) {}

  private async withRunLock<T>(
    runIdValue: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.runOperations.get(runIdValue) ?? Promise.resolve();
    let release = (): void => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => turn);
    this.runOperations.set(runIdValue, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.runOperations.get(runIdValue) === tail)
        this.runOperations.delete(runIdValue);
    }
  }

  async initialize(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    await this.projection.rebuild(this.store, await this.jobs.list());
  }

  async submitPreset(
    input: PresetSubmission,
    idempotencyKey: string,
    actor: string,
  ): Promise<SubmissionResult> {
    positiveCeiling(input.cost_ceiling_usd_per_trial);
    if (containsCredentialMaterial(input))
      throw new Error("preset submission contains credential material");
    const id = runId(idempotencyKey);
    const jobConfig = this.presets.buildJobConfig(id, input, this.options.mountRoot);
    const record = validateRunRecord({
      schema_version: "v1",
      run_id: id,
      created_at: new Date().toISOString(),
      submitted_by: actor,
      role: input.role ?? "final",
      harbor_revision: this.options.harborRevision,
      submission: {
        benchmark: input.benchmark,
        model: input.model,
        harness: input.harness,
        cost_ceiling_usd_per_trial: input.cost_ceiling_usd_per_trial,
      },
      harbor_job_config: jobConfig,
    });
    return this.persistSubmission(record);
  }

  async submitWorkbench(
    input: PresetSubmission,
    harborAgent: HarborAgentFragment,
    idempotencyKey: string,
    actor: string,
    metadata: Pick<RunRecordV1, "workbench_recipe" | "pricing"> = {},
  ): Promise<SubmissionResult> {
    positiveCeiling(input.cost_ceiling_usd_per_trial);
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      Object.keys(metadata).some(
        (key) => key !== "workbench_recipe" && key !== "pricing",
      )
    )
      throw new Error("Unknown Workbench launch metadata");
    if (containsCredentialMaterial(input))
      throw new Error("Workbench submission contains credential material");
    const id = runId(idempotencyKey);
    const jobConfig = this.presets.buildWorkbenchJobConfig(
      id,
      input,
      this.options.mountRoot,
      harborAgent,
    );
    const record = validateRunRecord({
      schema_version: "v1",
      run_id: id,
      created_at: new Date().toISOString(),
      submitted_by: actor,
      role: input.role ?? "diagnostic",
      harbor_revision: this.options.harborRevision,
      submission: {
        benchmark: input.benchmark,
        model: input.model,
        harness: input.harness,
        cost_ceiling_usd_per_trial: input.cost_ceiling_usd_per_trial,
      },
      ...(metadata.workbench_recipe !== undefined
        ? { workbench_recipe: metadata.workbench_recipe }
        : {}),
      ...(metadata.pricing !== undefined ? { pricing: metadata.pricing } : {}),
      harbor_job_config: jobConfig,
    });
    return this.persistSubmission(record);
  }

  async submitConfig(
    input: unknown,
    costCeilingUsdPerTrial: number,
    idempotencyKey: string,
    actor: string,
  ): Promise<SubmissionResult> {
    positiveCeiling(costCeilingUsdPerTrial);
    const id = runId(idempotencyKey);
    const config = prepareDirectJobConfig(id, input, this.options.mountRoot);
    const submission = directSubmission(config, costCeilingUsdPerTrial);
    const record = validateRunRecord({
      schema_version: "v1",
      run_id: id,
      created_at: new Date().toISOString(),
      submitted_by: actor,
      role: "diagnostic",
      harbor_revision: this.options.harborRevision,
      submission: {
        benchmark: submission.benchmark,
        model: submission.model,
        harness: submission.harness,
        cost_ceiling_usd_per_trial: costCeilingUsdPerTrial,
      },
      harbor_job_config: config,
    });
    return this.persistSubmission(record);
  }

  private async persistSubmission(record: RunRecordV1): Promise<SubmissionResult> {
    const result = await this.withRunLock(record.run_id, async () => {
      const path = runRecordPath(record.run_id);
      const existingValue = await readIfPresent(this.store, path);
      if (existingValue) {
        const existing = validateRunRecord(existingValue);
        if (!sameRequest(existing, record))
          throw new Error("idempotency key already identifies a different run");
        if (!(await readIfPresent(this.store, runStatePath(record.run_id))))
          await putJson(
            this.store,
            runStatePath(record.run_id),
            initialState(existing),
          );
        return { created: false, run: existing };
      }
      await createJson(this.store, path, record);
      await putJson(this.store, runStatePath(record.run_id), initialState(record));
      return { created: true, run: record };
    });
    await this.refresh();
    return result;
  }

  async setPresentation(
    runIdValue: string,
    archived: boolean,
    expectedRevision: number,
    actor: string,
  ): Promise<RunPresentationV1 | null> {
    if (
      typeof archived !== "boolean" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    )
      throw new Error("invalid presentation request");
    return this.withRunLock(runIdValue, async () => {
      if (!this.projection.run(runIdValue)) throw new Error("run was not found");
      try {
        let current: RunPresentationV1 | null = null;
        try {
          current = validateRunPresentation(
            await readJson(this.store, runPresentationPath(runIdValue)),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (current && current.run_id !== runIdValue)
          throw new Error("presentation identity mismatch");
        if ((current?.revision ?? 0) !== expectedRevision) {
          // Even an uncertain previous write must converge on the next SQL GET.
          this.projection.updatePresentation(runIdValue, current);
          throw new PresentationConflictError();
        }
        if ((current?.archived ?? false) === archived) {
          this.projection.updatePresentation(runIdValue, current);
          return current;
        }
        const next = validateRunPresentation({
          schema_version: "v1",
          run_id: runIdValue,
          archived,
          revision: expectedRevision + 1,
          updated_at: new Date().toISOString(),
          actor,
        });
        await putJson(this.store, runPresentationPath(runIdValue), next);
        this.projection.updatePresentation(runIdValue, next);
        return next;
      } catch (error) {
        if (error instanceof PresentationConflictError) throw error;
        this.projection.markPresentationUnavailable(runIdValue);
        // Never expose provider errors or private authentication subjects.
        throw new PresentationUpdateError();
      }
    });
  }

  async setDesiredState(
    runIdValue: string,
    desired: "run" | "paused" | "cancelled",
    actor: string,
  ): Promise<RunStateV1> {
    const state = await this.withRunLock(runIdValue, async () => {
      const value = await readIfPresent(this.store, runStatePath(runIdValue));
      if (!value) throw new Error("run was not found");
      const current = validateRunState(value);
      if (current.desired_state === "cancelled" && desired !== "cancelled")
        throw new Error("a cancelled run cannot be resumed");
      const next = validateRunState({
        ...current,
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
        desired_state: desired,
        actor,
      });
      await putJson(this.store, runStatePath(runIdValue), next);
      if (desired !== "run") {
        const liveJobs = (await this.jobs.list()).filter(
          (job) => job.run_id === runIdValue && isLiveJob(job),
        );
        const liveParents = liveJobs.filter((job) => job.role === "parent");
        const jobsToStop = liveParents.length > 0 ? liveParents : liveJobs;
        await Promise.all(jobsToStop.map((job) => this.jobs.cancel(job.id)));
      }
      return next;
    });
    await this.refresh();
    return state;
  }

  private async appendParent(
    runIdValue: string,
    job: JobObservation,
    actor = "harbor-hf-reconciler",
  ): Promise<RunStateV1> {
    const value = await readIfPresent(this.store, runStatePath(runIdValue));
    if (!value) throw new Error("run state was not found");
    const current = validateRunState(value);
    if (current.parent_jobs.some((item) => item.id === job.id)) return current;
    const state = validateRunState({
      ...current,
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
      actor,
      parent_jobs: [
        ...current.parent_jobs,
        { id: job.id, started_at: job.started_at ?? job.created_at },
      ],
    });
    await putJson(this.store, runStatePath(runIdValue), state);
    return state;
  }

  async reconcile(): Promise<void> {
    let observations = await this.jobs.list();
    await this.projection.rebuild(this.store, observations);
    const runs = this.projection
      .listRuns()
      .sort((left, right) =>
        left.record.created_at.localeCompare(right.record.created_at),
      );
    let activeParents = observations.filter(
      (job) => job.role === "parent" && isLiveJob(job),
    ).length;

    for (const initialView of runs) {
      await this.withRunLock(initialView.record.run_id, async () => {
        const observedById = new Map(observations.map((job) => [job.id, job]));
        for (const job of await this.jobs.list()) observedById.set(job.id, job);
        observations = [...observedById.values()];
        await this.projection.rebuild(this.store, observations);
        activeParents = observations.filter(
          (job) => job.role === "parent" && isLiveJob(job),
        ).length;
        const projected = this.projection.run(initialView.record.run_id) ?? initialView;
        const state = validateRunState(
          await readJson(this.store, runStatePath(initialView.record.run_id)),
        );
        const runJobs = observations.filter(
          (job) => job.run_id === projected.record.run_id,
        );
        const liveJobs = runJobs.filter(isLiveJob);
        const liveParent = liveJobs.find((job) => job.role === "parent");
        const keepFinalizingParent =
          state.desired_state === "run" &&
          projected.status === "cost_stopped" &&
          liveParent !== undefined &&
          harborJobReadyToFinalize(projected.record, projected.result);
        const terminal =
          state.desired_state !== "run" ||
          (["finished", "cost_stopped"].includes(projected.status) &&
            !keepFinalizingParent);
        if (terminal) {
          const liveParents = liveJobs.filter((job) => job.role === "parent");
          if (liveParents.length > 0) {
            await Promise.all(liveParents.map((job) => this.jobs.cancel(job.id)));
            activeParents -= liveParents.length;
            return;
          }
          await Promise.all(liveJobs.map((job) => this.jobs.cancel(job.id)));
          return;
        }
        if (liveParent) {
          await this.appendParent(projected.record.run_id, liveParent);
          return;
        }
        const orphans = liveJobs.filter((job) => job.role === "trial");
        await Promise.all(orphans.map((job) => this.jobs.cancel(job.id)));
        if (activeParents >= this.options.maxActiveJobs) return;
        const latest = state.parent_jobs.at(-1);
        if (
          latest &&
          Date.now() - Date.parse(latest.started_at) < this.options.restartDelayMs
        )
          return;
        const parent = await this.jobs.startParent(projected.record.run_id);
        await this.appendParent(projected.record.run_id, parent);
        observations = [...observations, parent];
        activeParents += 1;
      });
    }
    await this.projection.rebuild(this.store, await this.jobs.list());
  }
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly service: ControlService,
    private readonly intervalMs: number,
  ) {}

  start(onError?: (error: unknown) => void): void {
    if (this.timer) return;
    const tick = (): void => {
      if (!this.running)
        this.running = this.service
          .reconcile()
          .catch((error: unknown) => onError?.(error))
          .finally(() => {
            this.running = null;
          });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}

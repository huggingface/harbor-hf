import { Replacements } from "./replacements.js";
import {
  ReplacementEvidence,
  ReplacementError,
  replacementInput,
  reviewFingerprint,
  type ReplacementInput,
  type ReplacementNativePort,
  type SourceBundle,
} from "./replacement-evidence.js";
import {
  InferenceBindingDenied,
  InferenceBindings,
  inferencePresence,
} from "./inference-bindings.js";
import type { AgentWorkbenchRecipeV1, HarborJobConfigV1 } from "@harbor-hf/contracts";
import { correctPricing } from "./pricing-corrections.js";
import type { RunRecordV1, RunStateV1, RunPresentationV1 } from "@harbor-hf/contracts";
import {
  canonicalJson,
  runId,
  runRecordPath,
  runStatePath,
  runPresentationPath,
  validateRunPresentation,
  validateAttemptCost,
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
import {
  authoritativeAttemptCosts,
  statusFor,
  summarizeTrial,
  type Projection,
} from "./projection.js";
import { createJson, type ObjectStore, putJson, readJson } from "./store.js";

export interface InferenceExecution {
  policy(): InferenceBindings | Promise<InferenceBindings>;
  sequence?<T>(operation: () => Promise<T>): Promise<T>;
  image: string;
  present(source: string): boolean;
  /** InferenceBindingDenied certifies that no transport mutation was attempted. */
  start(run: RunRecordV1): Promise<JobObservation>;
}

export interface ControlServiceOptions {
  replacements?: ReplacementNativePort;
  inference?: InferenceExecution;
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
      operator_selection: left.operator_selection,
      harbor_job_config: left.harbor_job_config,
    }) ===
    canonicalJson({
      submitted_by: right.submitted_by,
      role: right.role,
      harbor_revision: right.harbor_revision,
      submission: right.submission,
      workbench_recipe: right.workbench_recipe,
      pricing: right.pricing,
      operator_selection: right.operator_selection,
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
  private replacementViews: Replacements | undefined;
  replacements(id: string) {
    this.replacementViews ??= new Replacements(
      this.store,
      this.projection,
      this.replacementNative(),
      (source) => this.completedSource(source),
    );
    return this.replacementViews.view(id);
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
    positiveCeiling(input.cost_ceiling_usd);
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
        cost_ceiling_usd: input.cost_ceiling_usd,
      },
      harbor_job_config: jobConfig,
    });
    return this.persistSubmission(record);
  }

  private replacementNative(): ReplacementNativePort {
    if (!this.options.replacements)
      throw new ReplacementError(503, "Native replacement inspection is unavailable");
    return this.options.replacements;
  }

  private async completedSource(source: SourceBundle): Promise<void> {
    const id = source.record.run_id;
    const reader = new ReplacementEvidence(this.store);
    const state = validateRunState(await reader.read(runStatePath(id)));
    const jobs = await this.verifyRecordedParents(id, state, await this.jobs.list());
    const prefix = `runs/${id}/attempt-costs/`;
    const { files } = await this.store.listDirectory(prefix);
    const receipts = [];
    for (const file of files.filter((file) => file.key.endsWith(".json"))) {
      const receipt = validateAttemptCost(await reader.read(file.key));
      if (file.key !== `${prefix}${receipt.attempt_id}.json`)
        throw new ReplacementError(409, "Attempt receipt identity mismatch");
      receipts.push(receipt);
    }
    const trials = source.trials.map((trial) => summarizeTrial(id, "", trial));
    const status = statusFor(
      source.record,
      state,
      source.result,
      trials,
      jobs.filter((job) => job.run_id === id),
      authoritativeAttemptCosts(receipts, trials),
    );
    if (
      state.run_id !== id ||
      status !== "finished" ||
      jobs.some((job) => job.run_id === id && isLiveJob(job))
    )
      throw new ReplacementError(
        409,
        "Replacement source must be complete with no live owned Jobs",
      );
  }

  private async inspectReplacement(
    id: string,
    input: ReplacementInput,
    target: string,
    actor: string,
  ) {
    const evidence = new ReplacementEvidence(this.store);
    const original = await evidence.bundle(id);
    await this.completedSource(original);
    const original_ancestors = await evidence.ancestors(original);
    const inspected = await this.replacementNative().replacementReview({
      original,
      original_ancestors,
      trial_ids: input.trial_ids,
      run_id: target,
      local_root: this.options.mountRoot,
    });
    if (inspected.harbor_revision !== this.options.harborRevision)
      throw new ReplacementError(503, "Native replacement revision mismatch");
    await this.selectedInference(inspected.effective_config, actor);
    return { original, inspected };
  }

  async validateReplacement(id: string, request: ReplacementInput, actor: string) {
    const input = replacementInput(request);
    return this.withRunLock(id, async () => {
      const { inspected } = await this.inspectReplacement(
        id,
        input,
        "run-000000000000000000000000",
        actor,
      );
      return {
        ...inspected,
        fingerprint: reviewFingerprint(inspected.fingerprint, input),
      };
    });
  }

  async submitReplacement(
    id: string,
    request: ReplacementInput & { fingerprint: string },
    key: string,
    actor: string,
  ): Promise<SubmissionResult> {
    const input = replacementInput(request);
    const target = runId(key);
    if (target === id)
      throw new ReplacementError(409, "Replacement must have a distinct run identity");
    return this.withRunLock(id, async () => {
      // Exact retries repair missing state through the ordinary persistence path,
      // before overlap or changed source/liveness checks.
      const previous = await readIfPresent(this.store, runRecordPath(target));
      if (previous) {
        const record = validateRunRecord(previous);
        const selected = record.operator_selection;
        if (
          record.submitted_by !== actor ||
          selected?.original_run_id !== id ||
          canonicalJson(selected.trial_ids) !== canonicalJson(input.trial_ids) ||
          record.submission.cost_ceiling_usd !== input.cost_ceiling_usd ||
          reviewFingerprint(selected.source_fingerprint, input) !== request.fingerprint
        )
          throw new ReplacementError(
            409,
            "Idempotency key already identifies a different request",
          );
        return this.persistSubmission(record);
      }
      const { original, inspected } = await this.inspectReplacement(
        id,
        input,
        target,
        actor,
      );
      if (!inspected.credentials_available)
        throw new ReplacementError(503, "Inference credentials are unavailable");
      if (reviewFingerprint(inspected.fingerprint, input) !== request.fingerprint)
        throw new ReplacementError(
          409,
          "Source selection or budget changed; review again",
        );
      const records = await new ReplacementEvidence(this.store).records();
      if (
        records.some(
          (record) =>
            record.operator_selection?.original_run_id === id &&
            record.operator_selection.trial_ids.some((trial) =>
              input.trial_ids.includes(trial),
            ),
        )
      )
        throw new ReplacementError(
          409,
          "Native trial selection already has a replacement",
        );
      const { cost_ceiling_usd_per_trial: _legacy, ...submission } =
        original.record.submission;
      const record = validateRunRecord({
        schema_version: "v1",
        run_id: target,
        created_at: new Date().toISOString(),
        submitted_by: actor,
        role: original.record.role,
        harbor_revision: inspected.harbor_revision,
        submission: { ...submission, cost_ceiling_usd: input.cost_ceiling_usd },
        ...(original.record.workbench_recipe
          ? { workbench_recipe: original.record.workbench_recipe }
          : {}),
        operator_selection: {
          original_run_id: id,
          trial_ids: input.trial_ids,
          source_fingerprint: inspected.fingerprint,
        },
        harbor_job_config: inspected.effective_config,
      });
      return this.persistSubmission(record);
    });
  }

  async compileWorkbench(
    recipe: AgentWorkbenchRecipeV1,
    actor: string,
    modelName: string | undefined,
  ): Promise<HarborAgentFragment> {
    const execution = this.options.inference;
    return ((await execution?.policy()) ?? new InferenceBindings()).compile(
      recipe,
      actor,
      execution?.image ?? "",
      modelName,
      execution?.present ?? (() => false),
    );
  }

  private async selectedInference(
    config: HarborJobConfigV1,
    actor: string,
  ): Promise<boolean> {
    try {
      const execution = this.options.inference;
      const selected = (
        (await execution?.policy()) ?? new InferenceBindings()
      ).selected(config, actor, execution?.image ?? "");
      if (!selected) return false;
      if (!execution || !inferencePresence(execution.present, selected.source))
        throw new InferenceBindingDenied();
      return true;
    } catch {
      throw new InferenceBindingDenied();
    }
  }

  async submitWorkbench(
    input: PresetSubmission,
    harborAgent: HarborAgentFragment,
    idempotencyKey: string,
    actor: string,
    metadata: Pick<RunRecordV1, "workbench_recipe" | "pricing"> = {},
  ): Promise<SubmissionResult> {
    positiveCeiling(input.cost_ceiling_usd);
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
        cost_ceiling_usd: input.cost_ceiling_usd,
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
    costCeilingUsd: number,
    idempotencyKey: string,
    actor: string,
  ): Promise<SubmissionResult> {
    positiveCeiling(costCeilingUsd);
    const id = runId(idempotencyKey);
    const config = prepareDirectJobConfig(id, input, this.options.mountRoot);
    const submission = directSubmission(config, costCeilingUsd);
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
        cost_ceiling_usd: costCeilingUsd,
      },
      harbor_job_config: config,
    });
    return this.persistSubmission(record);
  }

  private sequenceInference<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.inference?.sequence
      ? this.options.inference.sequence(operation)
      : operation();
  }

  private async persistSubmission(record: RunRecordV1): Promise<SubmissionResult> {
    const result = await this.withRunLock(record.run_id, () =>
      this.sequenceInference(async () => {
        await this.selectedInference(record.harbor_job_config, record.submitted_by);
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
      }),
    );
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
        let runJobs = (await this.jobs.list()).filter(
          (job) => job.run_id === runIdValue,
        );
        if (runJobs.some(isLiveJob))
          runJobs = await this.verifyRecordedParents(runIdValue, next, runJobs);
        const liveJobs = runJobs.filter(isLiveJob);
        const liveParents = liveJobs.filter((job) => job.role === "parent");
        const jobsToStop = liveParents.length > 0 ? liveParents : liveJobs;
        await Promise.all(jobsToStop.map((job) => this.jobs.cancel(job.id)));
      }
      return next;
    });
    await this.refresh();
    return state;
  }

  private async verifyRecordedParents(
    runIdValue: string,
    state: RunStateV1,
    observations: readonly JobObservation[],
  ): Promise<JobObservation[]> {
    if (
      observations.some(
        (job) => job.run_id === runIdValue && job.role === "parent" && isLiveJob(job),
      )
    )
      return [...observations];
    // Neither listing absence nor a stale terminal entry proves death. Check
    // all recorded parents: an older parent may outlive the latest one.
    const verified = new Map(observations.map((job) => [job.id, job]));
    for (const parent of state.parent_jobs) {
      const job = await this.jobs.inspect(parent.id);
      if (job.id !== parent.id || job.run_id !== runIdValue || job.role !== "parent")
        throw new Error("Recorded parent inspection identity mismatch");
      verified.set(job.id, job);
    }
    return [...verified.values()];
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
    const initiallyLiveRuns = new Set(
      observations.filter(isLiveJob).map((job) => job.run_id),
    );
    await this.projection.rebuild(this.store, observations);
    const runs = this.projection
      .listRuns()
      .sort((left, right) =>
        left.record.created_at.localeCompare(right.record.created_at),
      );
    let activeParents = observations.filter(
      (job) => job.role === "parent" && isLiveJob(job),
    ).length;

    const inspectionErrors: unknown[] = [];
    for (const initialView of runs) {
      await this.withRunLock(initialView.record.run_id, async () => {
        const lockedState = validateRunState(
          await readJson(this.store, runStatePath(initialView.record.run_id)),
        );
        // A complete snapshot may authorize only inaction, never a cached
        // start/stop. Re-read state under the lock so resume/pause invalidates
        // this shortcut. Initial live Jobs must not disappear from eligibility
        // merely because a later listing reports them stopped.
        if (
          lockedState.revision === initialView.state.revision &&
          (lockedState.desired_state !== "run" ||
            ["finished", "cost_stopped"].includes(initialView.status)) &&
          !initiallyLiveRuns.has(initialView.record.run_id) &&
          !observations.some(
            (job) => job.run_id === initialView.record.run_id && isLiveJob(job),
          )
        )
          // Late Jobs are discovered by the closing/next complete scan and
          // cleaned on the next successful pass (parents before children).
          // The closing rebuild also refreshes inactive results/costs/state.
          return;
        const observedById = new Map(observations.map((job) => [job.id, job]));
        for (const job of await this.jobs.list()) observedById.set(job.id, job);
        observations = [...observedById.values()];
        // Keep fresh per-run cost/result reads without rescanning all history.
        // Jobs remain freshly listed above: starts/stops and late children make
        // pass-wide liveness caching unsafe.
        await this.projection.rebuild(
          this.store,
          observations,
          initialView.record.run_id,
        );
        activeParents = observations.filter(
          (job) => job.role === "parent" && isLiveJob(job),
        ).length;
        const projected = this.projection.run(initialView.record.run_id) ?? initialView;
        const state = validateRunState(
          await readJson(this.store, runStatePath(initialView.record.run_id)),
        );
        const observedLiveJobs = observations.filter(
          (job) => job.run_id === projected.record.run_id && isLiveJob(job),
        );
        const runnable =
          state.desired_state === "run" &&
          !["finished", "cost_stopped"].includes(projected.status);
        if (runnable || observedLiveJobs.length > 0) {
          try {
            observations = await this.verifyRecordedParents(
              projected.record.run_id,
              state,
              observations,
            );
          } catch (error) {
            // Defer this run's recovery, but keep unrelated safety stops working.
            // Unknown parent liveness also makes launch capacity uncertain.
            inspectionErrors.push(error);
            return;
          }
        }
        activeParents = observations.filter(
          (job) => job.role === "parent" && isLiveJob(job),
        ).length;
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
        if (inspectionErrors.length > 0 || activeParents >= this.options.maxActiveJobs)
          return;
        const latest = state.parent_jobs.at(-1);
        if (
          latest &&
          Date.now() - Date.parse(latest.started_at) < this.options.restartDelayMs
        )
          return;
        let parent: JobObservation;
        try {
          parent = await this.sequenceInference(async () => {
            const selected = await this.selectedInference(
              projected.record.harbor_job_config,
              projected.record.submitted_by,
            );
            return selected && this.options.inference
              ? this.options.inference.start(projected.record)
              : this.jobs.startParent(projected.record.run_id);
          });
        } catch (error) {
          // Only certified pre-delivery denials may pause. An uncertain transport
          // error may already have created a live Job; preserve normal observation.
          if (!(error instanceof InferenceBindingDenied)) throw error;
          // Only admission is blocked. Safety cleanup above and other runs continue.
          // Reuse control's existing pause authority; never invent Job observations
          // or alter Harbor results/retries. Explicit operator resume rechecks policy.
          await putJson(
            this.store,
            runStatePath(projected.record.run_id),
            validateRunState({
              ...state,
              revision: state.revision + 1,
              updated_at: new Date().toISOString(),
              desired_state: "paused",
              actor: "harbor-hf-inference-blocked",
            }),
          );
          return;
        }
        await this.appendParent(projected.record.run_id, parent);
        observations = [...observations, parent];
        activeParents += 1;
      });
    }
    await this.projection.rebuild(this.store, await this.jobs.list());
    if (inspectionErrors.length > 0)
      throw new AggregateError(inspectionErrors, "Recorded parent inspection failed");
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

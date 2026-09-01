import { setImmediate as scheduleImmediate } from "node:timers";
import type {
  ActionIntent,
  ActionReceipt,
  AttemptReceipt,
  DeploymentProfileSpec,
  EndpointResource,
  ResolvedExecutionContract,
  RunLock,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sha256,
} from "@harbor-hf/contracts";
import {
  attemptAdmissibility,
  requiredPositiveMetrics,
} from "./attempt-admissibility.js";
import { isCurrentRunLock } from "./execution-contract.js";
import { preparationRequired, preparedTrialJobLaunch } from "./profiles.js";
import type { Projection } from "./projection.js";
import type { ResultPublisher } from "./publication.js";
import {
  type ControlService,
  executionReservationCategory,
  historicalTaskNeedsSelection,
  infrastructureSealReplaceable,
  type JobBudgetReservation,
  PolicyError,
} from "./service.js";

export interface ExternalActionResult {
  outcome: ActionReceipt["outcome"];
  observed_state: string;
  resource_id?: string | null;
  error_code?: string | null;
  ready_replicas?: number | null;
  active_hourly_cost_microusd?: number | null;
  cost_microusd?: number | null;
}

export interface ExternalActionContext {
  adoption_only?: boolean;
}

export class ExternalActionNotFoundError extends Error {}
export class AmbiguousExternalActionError extends Error {}

export interface ExternalActionPort {
  execute(
    intent: ActionIntent,
    context?: ExternalActionContext,
  ): Promise<ExternalActionResult>;
  observeJobs?(
    intents: readonly ActionIntent[],
  ): Promise<readonly ExternalActionResult[]>;
}

export interface ReconcilerOptions {
  interval_ms: number;
  sync_interval_ms?: number;
  observation_interval_ms: number;
  batch_size: number;
  dispatch_adoption_delay_ms?: number;
  worker_receipt_grace_ms?: number;
}

interface ExecutableRun {
  run_id: string;
  tasks: RunLock["tasks"];
  profiles: RunLock["profiles"];
  execution: ResolvedExecutionContract;
  source_lock: RunLock;
}

const terminalJobStates = new Set([
  "STOPPED",
  "COMPLETED",
  "CANCELLED",
  "CANCELED",
  "ERROR",
]);

function jobStateIsTerminal(state: string | null): boolean {
  return state !== null && terminalJobStates.has(state.toUpperCase());
}

const defaultOptions: ReconcilerOptions = {
  interval_ms: 2_000,
  sync_interval_ms: 30_000,
  observation_interval_ms: 5_000,
  worker_receipt_grace_ms: 60_000,
  batch_size: 16,
};

function stringArray(
  payload: ActionIntent["payload"],
  key: keyof ActionIntent["payload"],
): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new PolicyError(`action payload ${key} must be an array of strings`);
  }
  return value;
}

function optionalStringArray(
  payload: ActionIntent["payload"],
  key: keyof ActionIntent["payload"],
): string[] | undefined {
  return payload[key] === undefined ? undefined : stringArray(payload, key);
}

function withoutRunActionIdempotency(
  payload: ActionIntent["payload"],
): ActionIntent["payload"] {
  const {
    idempotency_key_digest: _keyDigest,
    idempotency_payload_digest: _payloadDigest,
    ...rest
  } = payload;
  return rest;
}

function scalar<T extends string | number | boolean>(
  payload: ActionIntent["payload"],
  key: keyof ActionIntent["payload"],
  expected: "string" | "number" | "boolean",
): T {
  const value = payload[key];
  if (typeof value !== expected)
    throw new PolicyError(`action payload ${key} must be ${expected}`);
  return value as T;
}

function profile(
  lock: { profiles: RunLock["profiles"] },
  kind: string,
): Record<string, unknown> {
  const selected = lock.profiles.find((item) => item.kind === kind);
  if (!selected) throw new PolicyError(`run lock is missing ${kind}`);
  return selected.spec as unknown as Record<string, unknown>;
}

function profileScalar<T extends string | number | boolean>(
  spec: Record<string, unknown>,
  key: string,
  expected: "string" | "number" | "boolean",
): T {
  const value = spec[key];
  if (typeof value !== expected)
    throw new PolicyError(`profile ${key} must be ${expected}`);
  return value as T;
}

function optionalHourlyCost(
  spec: Record<string, unknown> | DeploymentProfileSpec,
): number | undefined {
  if (!("active_hourly_cost_microusd" in spec)) return undefined;
  const value = spec.active_hourly_cost_microusd;
  return typeof value === "number" ? value : undefined;
}

function optionalProfileStrings(spec: Record<string, unknown>, key: string): string[] {
  const value = spec[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new PolicyError(`profile ${key} must be an array of strings`);
  return value;
}

function profileStrings(
  spec: Record<string, unknown>,
  key: string,
): [string, ...string[]] {
  const value = spec[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string")
  )
    throw new PolicyError(`profile ${key} must be a non-empty array of strings`);
  return value as [string, ...string[]];
}

export function fairJobLaunchOrder(
  intents: readonly ActionIntent[],
  latestRunId: string | null,
): ActionIntent[] {
  const groups = new Map<string, ActionIntent[]>();
  for (const intent of intents) {
    const group = groups.get(intent.run_id) ?? [];
    group.push(intent);
    groups.set(intent.run_id, group);
  }
  let runs = [...groups.keys()].sort((left, right) => {
    const leftIntent = groups.get(left)?.[0];
    const rightIntent = groups.get(right)?.[0];
    return (leftIntent?.created_at ?? left).localeCompare(
      rightIntent?.created_at ?? right,
    );
  });
  const latestIndex = latestRunId ? runs.indexOf(latestRunId) : -1;
  if (latestIndex >= 0)
    runs = [...runs.slice(latestIndex + 1), ...runs.slice(0, latestIndex + 1)];
  const output: ActionIntent[] = [];
  while (groups.size > 0) {
    for (const runId of runs) {
      const group = groups.get(runId);
      const next = group?.shift();
      if (next) output.push(next);
      if (group?.length === 0) groups.delete(runId);
    }
    runs = runs.filter((runId) => groups.has(runId));
  }
  return output;
}

export function ordinaryActionOrder(intents: readonly ActionIntent[]): ActionIntent[] {
  const priority = (intent: ActionIntent): number => {
    if (intent.action_kind === "run.cancel") return 0;
    if (intent.action_kind === "run.admit") return 1;
    if (intent.action_kind === "job.cancel") return 2;
    return 3;
  };
  return [...intents].sort(
    (left, right) =>
      priority(left) - priority(right) ||
      left.created_at.localeCompare(right.created_at) ||
      left.action_id.localeCompare(right.action_id),
  );
}

export function rotatingBatch<T>(
  items: readonly T[],
  cursor: number,
  limit: number,
): { items: T[]; nextCursor: number } {
  if (items.length === 0) return { items: [], nextCursor: 0 };
  const start = cursor % items.length;
  const size = Math.min(limit, items.length);
  const ordered = [...items.slice(start), ...items.slice(0, start)];
  return {
    items: ordered.slice(0, size),
    nextCursor: (start + size) % items.length,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => scheduleImmediate(resolve));
}

interface JobLaunchBatch {
  handled: number;
  failures: unknown[];
  consideredActionIds: Set<string>;
}

interface ActionBatch {
  handled: number;
  failures: unknown[];
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private currentRun: Promise<void> | null = null;
  private lastProjectionSyncAt: number;
  private projectionSyncCursor = 0;
  private activeRunCursor = 0;

  constructor(
    private readonly service: ControlService,
    private readonly projection: Projection,
    private readonly external: ExternalActionPort,
    private readonly publisher: ResultPublisher,
    private readonly options: ReconcilerOptions = defaultOptions,
  ) {
    // Runtime startup has just rebuilt the projection, so the action loop can
    // begin immediately without repeating the Bucket scan.
    this.lastProjectionSyncAt = Date.now();
  }

  /**
   * Start periodic reconciliation and report failures without stopping the loop.
   *
   * @param signal - Optional shutdown signal.
   * @param onError - Observer for a rejected reconciliation tick.
   */
  start(signal?: AbortSignal, onError?: (error: unknown) => void): void {
    if (this.timer) return;
    // Construction precedes the startup rebuild in the hosted runtime.
    this.lastProjectionSyncAt = Date.now();
    const run = () => {
      if (this.running) return;
      this.running = true;
      const operation = this.tick()
        .then(
          () => undefined,
          (error) => onError?.(error),
        )
        .finally(() => {
          this.running = false;
          if (this.currentRun === operation) this.currentRun = null;
        });
      this.currentRun = operation;
    };
    this.timer = setInterval(run, this.options.interval_ms);
    run();
    signal?.addEventListener("abort", () => void this.stop(), { once: true });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.currentRun;
  }

  async tick(): Promise<number> {
    let handled = 0;
    const failures: unknown[] = [];
    const activeRuns = await this.projection.activeRuns();
    const syncRunIds = activeRuns.map((run) => run.run_id);
    const executableRuns = await this.executableItems(activeRuns);
    const syncInterval = this.options.sync_interval_ms ?? 30_000;
    // Admit runs and dispatch queued Jobs before historical advancement or
    // Bucket I/O so slow projection work cannot starve physical execution.
    const initialPending = await this.executableActions(
      await this.projection.pendingActions(10_000),
    );
    const admissions = initialPending.filter(
      (intent) => intent.action_kind === "run.admit",
    );
    const newlyAdmittedRuns = new Set<string>();
    for (const intent of admissions.slice(0, this.options.batch_size)) {
      if (await this.projection.hasRunAction(intent.run_id, "run.cancel")) continue;
      await this.handle(intent);
      newlyAdmittedRuns.add(intent.run_id);
      handled += 1;
    }
    const pendingBeforeAdvancement = await this.executableActions(
      await this.projection.pendingActions(10_000),
    );
    const queuedLaunches = pendingBeforeAdvancement.filter(
      (intent) =>
        intent.action_kind === "job.launch" &&
        (intent.target === "run-preparation" || !newlyAdmittedRuns.has(intent.run_id)),
    );
    const initialLaunchBatch = await this.handleJobLaunches(
      queuedLaunches,
      this.options.batch_size,
    );
    handled += initialLaunchBatch.handled;
    failures.push(...initialLaunchBatch.failures);
    // The reconciler shares one Node.js process with the API. Yield between
    // bounded phases so queued HTTP requests are not delayed by a full tick.
    await yieldToEventLoop();
    if (
      syncRunIds.length > 0 &&
      Date.now() - this.lastProjectionSyncAt >= syncInterval
    ) {
      try {
        handled += await this.syncProjection(syncRunIds);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const { intent, receipt } of await this.projection.unadvancedActions(
      this.options.batch_size,
    )) {
      try {
        if (!(await this.actionIsExecutable(intent))) continue;
        await this.advance(intent, receipt);
        await this.service.markAdvanced(intent, receipt);
        handled += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    await yieldToEventLoop();
    const pending = await this.executableActions(
      await this.projection.pendingActions(10_000),
    );
    const dueNow = (intent: ActionIntent): boolean => {
      const notBefore = intent.payload.not_before;
      return !(typeof notBefore === "string" && Date.parse(notBefore) > Date.now());
    };
    const observationCandidates = fairJobLaunchOrder(
      pending.filter(
        (intent) => intent.action_kind === "job.observe" && dueNow(intent),
      ),
      null,
    );
    const observationBatch = await this.handleJobObservations(
      observationCandidates,
      this.options.batch_size,
    );
    handled += observationBatch.handled;
    failures.push(...observationBatch.failures);
    const launchCandidates = pending.filter(
      (candidate) =>
        candidate.action_kind === "job.launch" &&
        candidate.target !== "run-preparation" &&
        !newlyAdmittedRuns.has(candidate.run_id) &&
        !initialLaunchBatch.consideredActionIds.has(candidate.action_id),
    );
    const ordinary = pending.filter(
      (intent) =>
        intent.action_kind !== "job.launch" && intent.action_kind !== "job.observe",
    );
    const due = ordinaryActionOrder(ordinary.filter(dueNow));
    let ordinaryHandled = 0;
    const ordinaryLimit =
      launchCandidates.length > 0
        ? Math.max(1, Math.floor(this.options.batch_size / 2))
        : this.options.batch_size;
    for (const intent of due.slice(0, ordinaryLimit)) {
      try {
        await this.handle(intent);
        handled += 1;
        ordinaryHandled += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    const remaining = Math.max(1, this.options.batch_size - ordinaryHandled);
    const laterLaunchBatch = await this.handleJobLaunches(launchCandidates, remaining);
    handled += laterLaunchBatch.handled;
    failures.push(...laterLaunchBatch.failures);
    await yieldToEventLoop();
    const activeRunBatch = rotatingBatch(
      executableRuns,
      this.activeRunCursor,
      this.options.batch_size,
    );
    this.activeRunCursor = activeRunBatch.nextCursor;
    for (const run of activeRunBatch.items) {
      try {
        if (run.cancellation_requested) await this.continueCancellation(run.run_id);
        if (await this.continueJobObservation(run.run_id)) handled += 1;
        if (await this.maybePublish(run.run_id)) handled += 1;
      } catch (error) {
        failures.push(error);
      }
      await yieldToEventLoop();
    }
    if (failures.length > 0) throw failures[0];
    return handled;
  }

  private async handleJobObservations(
    observationCandidates: ActionIntent[],
    limit: number,
  ): Promise<ActionBatch> {
    let handled = 0;
    const failures: unknown[] = [];
    const candidates = observationCandidates.slice(0, limit);
    let results: readonly ExternalActionResult[];
    try {
      if (this.external.observeJobs)
        results = await this.external.observeJobs(candidates);
      else {
        const settled = await Promise.allSettled(
          candidates.map((intent) => this.external.execute(intent)),
        );
        results = settled.map((result) => {
          if (result.status === "fulfilled") return result.value;
          failures.push(result.reason);
          return { outcome: "failed", observed_state: "ERROR" };
        });
      }
    } catch (error) {
      return { handled, failures: [error] };
    }
    if (results.length !== candidates.length)
      return {
        handled,
        failures: [new PolicyError("Job observation batch result count is invalid")],
      };
    // Fetch observation states together, then serialize their durable effects.
    for (const [index, result] of results.entries()) {
      const intent = candidates[index];
      if (!intent) {
        failures.push(new PolicyError("Job observation batch result is unbound"));
        continue;
      }
      handled += 1;
      if (result.outcome !== "failed") {
        try {
          const receipt = await this.service.receipt(intent, result);
          await this.advance(intent, receipt);
          await this.service.markAdvanced(intent, receipt);
        } catch (error) {
          failures.push(error);
        }
      }
      await yieldToEventLoop();
    }
    return { handled, failures };
  }

  private async handleJobLaunches(
    launchCandidates: ActionIntent[],
    limit: number,
  ): Promise<JobLaunchBatch> {
    let handled = 0;
    const failures: unknown[] = [];
    let candidates: ActionIntent[];
    try {
      candidates = (await this.fairJobLaunches(launchCandidates)).slice(0, limit);
    } catch (error) {
      return {
        handled,
        failures: [error],
        consideredActionIds: new Set<string>(),
      };
    }
    const consideredActionIds = new Set(candidates.map((intent) => intent.action_id));
    const cancellationChecks = await Promise.allSettled(
      candidates.map(async (intent) => ({
        intent,
        cancelled: await this.launchCancellationRequested(intent),
      })),
    );
    const ready: ActionIntent[] = [];
    const launchable: ActionIntent[] = [];
    for (const check of cancellationChecks) {
      if (check.status === "rejected") {
        failures.push(check.reason);
      } else if (check.value.cancelled) {
        ready.push(check.value.intent);
      } else {
        launchable.push(check.value.intent);
      }
    }
    // Admission remains serialized because grants form one capacity-token chain.
    // Start each Job as soon as its grant lands while the next grant is written.
    const launchResults = await Promise.allSettled([
      ...ready.map(async (intent) => {
        await this.handle(intent);
        return 1;
      }),
      ...launchable.map(async (intent) => {
        const admission = await this.service.admitJobLaunch(intent);
        if (
          admission.status === "rejected" &&
          admission.limiting_factor === "run_cancelled"
        )
          return 1;
        if (admission.status !== "admitted") return 0;
        await this.handle(intent);
        return 1;
      }),
    ]);
    for (const result of launchResults) {
      if (result.status === "fulfilled") handled += result.value;
      else failures.push(result.reason);
    }
    return { handled, failures, consideredActionIds };
  }

  private async syncProjection(activeRunIds: readonly string[]): Promise<number> {
    // Workers can add only attempt-receipt control records, so task prefixes avoid
    // rescanning every historical control record during each action tick.
    const ordered = [...activeRunIds].sort();
    const index = this.projectionSyncCursor % ordered.length;
    const runId = ordered[index];
    if (!runId) return 0;
    this.projectionSyncCursor = (index + 1) % ordered.length;
    const ingested = await this.service.syncProjection(
      `control/schema=v1/runs/${runId}/tasks`,
    );
    this.lastProjectionSyncAt = Date.now();
    return ingested;
  }

  private async fairJobLaunches(intents: ActionIntent[]): Promise<ActionIntent[]> {
    const latest = await this.projection.latestJobAdmission(this.service.namespace);
    return fairJobLaunchOrder(intents, latest?.run_id ?? null);
  }

  private async runExecutionState(
    runId: string,
  ): Promise<"executable" | "historical" | "missing"> {
    const lock = await this.projection.runLock(runId);
    if (!lock) return "missing";
    if (isCurrentRunLock(lock)) return "executable";
    if (!(await this.projection.runContinuation(runId))) return "historical";
    await this.service.runExecution(lock);
    return "executable";
  }

  private async runHasExecution(runId: string): Promise<boolean> {
    return (await this.runExecutionState(runId)) === "executable";
  }

  private async executableItems<T extends { run_id: string }>(
    items: readonly T[],
  ): Promise<T[]> {
    const availability = new Map<string, Promise<boolean>>();
    for (const item of items) {
      if (!availability.has(item.run_id))
        availability.set(item.run_id, this.runHasExecution(item.run_id));
    }
    const executable = new Set(
      (
        await Promise.all(
          [...availability].map(
            async ([runId, available]) => [runId, await available] as const,
          ),
        )
      )
        .filter(([, available]) => available)
        .map(([runId]) => runId),
    );
    return items.filter((item) => executable.has(item.run_id));
  }

  private async actionIsExecutable(intent: ActionIntent): Promise<boolean> {
    const state = await this.runExecutionState(intent.run_id);
    return (
      state === "executable" ||
      (state === "historical" && intent.action_kind === "job.observe")
    );
  }

  private async executableActions(
    intents: readonly ActionIntent[],
  ): Promise<ActionIntent[]> {
    const states = new Map<string, Promise<"executable" | "historical" | "missing">>();
    for (const intent of intents) {
      if (!states.has(intent.run_id))
        states.set(intent.run_id, this.runExecutionState(intent.run_id));
    }
    const resolved = new Map(
      await Promise.all(
        [...states].map(async ([runId, state]) => [runId, await state] as const),
      ),
    );
    return intents.filter((intent) => {
      const state = resolved.get(intent.run_id);
      return (
        state === "executable" ||
        (state === "historical" && intent.action_kind === "job.observe")
      );
    });
  }

  private async handle(intent: ActionIntent): Promise<void> {
    let result: ExternalActionResult;
    if (intent.action_kind === "run.retry-infrastructure") {
      const materialized =
        await this.service.materializeInfrastructureRetryCommand(intent);
      result = {
        outcome: materialized.complete ? "completed" : "failed",
        observed_state: materialized.complete ? "retries-recorded" : "budget-exhausted",
      };
    } else if (intent.action_kind === "publication.publish") {
      const receipt = await this.publisher.publish(intent.run_id);
      result = {
        outcome: "completed",
        observed_state: receipt.publication_state,
        resource_id: receipt.publication_id,
      };
    } else if (intent.action_kind === "publication.supersede") {
      const current = await this.projection.runPublication(intent.run_id);
      const previousId = intent.payload.publication_id;
      const previous =
        typeof previousId === "string"
          ? await this.projection.publication(previousId)
          : null;
      if (!current || !previous || typeof previousId !== "string")
        throw new PolicyError("supersession publication is missing");
      const record = await this.service.writePublicationSupersession(
        intent.run_id,
        current.publication_id,
        previous.run_id,
        previousId,
        typeof intent.payload.reason === "string"
          ? intent.payload.reason
          : "replacement publication validated",
      );
      result = {
        outcome: "completed",
        observed_state: "superseded",
        resource_id: record.record_id,
      };
    } else if (intent.action_kind === "run.cancel") {
      result = { outcome: "completed", observed_state: "cancelled" };
    } else if (intent.action_kind === "run.pause") {
      result = { outcome: "completed", observed_state: "paused" };
    } else if (intent.action_kind === "run.resume") {
      result = { outcome: "completed", observed_state: "running" };
    } else if (intent.action_kind === "job.launch") {
      const cancelled = await this.launchCancellationRequested(intent);
      const terminal = await this.allActionTasksTerminal(intent);
      const paused = await this.projection.runPaused(intent.run_id);
      const suppression: "cancelled" | "paused" | "terminal" | null = cancelled
        ? "cancelled"
        : paused
          ? "paused"
          : terminal
            ? "terminal"
            : null;
      const dispatch = suppression
        ? await this.projection.actionDispatch(intent.action_id)
        : null;
      if (suppression && !dispatch) {
        result = {
          outcome: "completed",
          observed_state: `suppressed-${suppression}`,
        };
      } else {
        const launchResult = await this.executeJobLaunch(intent, suppression);
        if (!launchResult) return;
        result = launchResult;
      }
    } else if (intent.action_kind === "job.observe") {
      const observation = await this.external.execute(intent);
      if (observation.outcome === "failed") return;
      result = observation;
    } else if (intent.action_kind === "job.cancel") {
      result = await this.external.execute(intent);
    } else if (
      intent.action_kind === "endpoint.pause" ||
      intent.action_kind === "endpoint.resume"
    ) {
      const observation = await this.external.execute(intent);
      if (
        observation.outcome === "failed" ||
        typeof observation.ready_replicas !== "number"
      )
        return;
      result = observation;
    } else {
      result = await this.external.execute(intent);
    }
    const receipt = await this.service.receipt(intent, result);
    await this.advance(intent, receipt);
    await this.service.markAdvanced(intent, receipt);
  }

  private async executeJobLaunch(
    intent: ActionIntent,
    suppression: "cancelled" | "paused" | "terminal" | null = null,
  ): Promise<ExternalActionResult | null> {
    const dispatch = await this.projection.actionDispatch(intent.action_id);
    if (dispatch) {
      if (Date.parse(dispatch.adoption_not_before) > Date.now()) return null;
      try {
        return await this.external.execute(intent, { adoption_only: true });
      } catch (error) {
        if (error instanceof ExternalActionNotFoundError) {
          return suppression
            ? {
                outcome: "completed",
                observed_state: `suppressed-${suppression}-not-found`,
              }
            : null;
        }
        if (error instanceof AmbiguousExternalActionError) return null;
        throw error;
      }
    }
    try {
      return await this.external.execute(intent, { adoption_only: true });
    } catch (error) {
      if (error instanceof AmbiguousExternalActionError) return null;
      if (!(error instanceof ExternalActionNotFoundError)) throw error;
    }
    const adoptionNotBefore = new Date(
      Date.now() + (this.options.dispatch_adoption_delay_ms ?? 60_000),
    ).toISOString();
    const fence = await this.service.dispatchAction(intent, adoptionNotBefore);
    if (!fence.created) return null;
    try {
      return await this.external.execute(intent);
    } catch (error) {
      if (error instanceof AmbiguousExternalActionError) return null;
      throw error;
    }
  }

  private async advance(intent: ActionIntent, receipt: ActionReceipt): Promise<void> {
    switch (intent.action_kind) {
      case "run.admit":
        await this.admit(intent, receipt);
        break;
      case "job.launch":
        if (receipt.observed_state.startsWith("suppressed-")) {
          await this.service.releaseJobAction(intent, receipt.created_at);
          break;
        }
        if (receipt.outcome === "failed") {
          await this.service.releaseJobAction(intent, receipt.created_at);
          if (intent.payload.worker_role === "preparation")
            await this.handlePreparationTerminal(intent, receipt, "ERROR");
          else await this.completeTasksFromJob(intent, receipt, "infrastructure");
        } else await this.observeJob(intent, receipt);
        break;
      case "job.observe":
        await this.handleJobObservation(intent, receipt);
        break;
      case "job.cancel":
        await this.continueCancellation(intent.run_id);
        break;
      case "run.resume": {
        const lock = await this.requiredLock(intent.run_id);
        const historical = !isCurrentRunLock(lock.source_lock);
        const continuation = historical
          ? await this.projection.runContinuation(intent.run_id)
          : null;
        const repair = historical
          ? await this.projection.runContinuationRepair(intent.run_id)
          : null;
        const successor = historical
          ? await this.projection.runContinuationRepairSuccessor(intent.run_id)
          : null;
        if (historical) {
          if (!continuation)
            throw new PolicyError(
              "historical run has no execution continuation attachment",
            );
          await this.service.assertReusableHistoricalPreparation(
            lock.source_lock,
            lock.execution,
          );
        }
        const deployment = lock.execution.deployment;
        if (
          preparationRequired(deployment) &&
          !(await this.service.preparedJob(lock.run_id))
        ) {
          const preparationLaunches = (await this.projection.runActions(lock.run_id))
            .filter((action) => {
              if (action.action_kind !== "job.launch") return false;
              const launch = JSON.parse(action.intent_body) as ActionIntent;
              return launch.payload.worker_role === "preparation";
            })
            .map((action) => ({
              generation: action.generation,
              suppressed: action.observed_state?.startsWith("suppressed-") ?? false,
            }));
          const attempt = preparationLaunches.filter(
            (launch) => !launch.suppressed,
          ).length;
          const generation =
            preparationLaunches.reduce(
              (maximum, launch) => Math.max(maximum, launch.generation),
              -1,
            ) + 1;
          await this.launchPreparation(
            lock,
            receipt.created_at,
            attempt,
            generation,
            stringArray(intent.payload, "task_ids"),
          );
          break;
        }
        const taskIds = stringArray(intent.payload, "task_ids");
        const freshTaskIds: string[] = [];
        for (const taskId of taskIds) {
          const detail = await this.projection.task(intent.run_id, taskId);
          if (
            detail?.task.terminal_outcome &&
            historicalTaskNeedsSelection(detail.task)
          ) {
            freshTaskIds.push(taskId);
            continue;
          }
          const latest = detail?.attempts.at(-1);
          if (!latest) {
            freshTaskIds.push(taskId);
            continue;
          }
          const sourceRow = await this.projection.action(latest.action_id);
          if (sourceRow?.action_kind !== "job.launch")
            throw new PolicyError("resume attempt has no physical Job launch");
          const source = JSON.parse(sourceRow.intent_body) as ActionIntent;
          if (
            continuation &&
            (source.payload.run_continuation_id !== continuation.record_id ||
              (repair &&
                source.payload.run_continuation_repair_id !== repair.record_id) ||
              (successor &&
                source.payload.run_continuation_repair_successor_id !==
                  successor.record_id))
          ) {
            freshTaskIds.push(taskId);
            continue;
          }
          await this.finishAttempt(JSON.parse(latest.body) as AttemptReceipt, source);
        }
        if (freshTaskIds.length > 0)
          await this.launchExecution(
            lock,
            receipt.created_at,
            scalar<number>(intent.payload, "launch_generation", "number"),
            freshTaskIds,
          );
        break;
      }
      case "run.pause":
      case "run.retry-infrastructure":
      case "publication.supersede":
        break;
      case "endpoint.resume":
      case "endpoint.pause":
        if (
          receipt.outcome === "failed" ||
          typeof receipt.ready_replicas !== "number"
        ) {
          await this.service.writeAction(
            this.service.actionIntent(
              intent.run_id,
              intent.action_kind,
              intent.target,
              intent.generation + 1,
              {
                ...withoutRunActionIdempotency(intent.payload),
                not_before: new Date(
                  Date.parse(receipt.created_at) + this.options.observation_interval_ms,
                ).toISOString(),
              },
            ),
          );
        } else if (receipt.resource_id) await this.recordEndpoint(intent, receipt);
        break;
      case "run.cancel":
        await this.continueCancellation(intent.run_id);
        break;
      case "publication.publish":
        break;
    }
    if (
      !["run.cancel", "job.cancel"].includes(intent.action_kind) &&
      (await this.projection.hasRunAction(intent.run_id, "run.cancel"))
    )
      await this.continueCancellation(intent.run_id);
    await this.maybePublish(intent.run_id);
  }

  private async admit(admission: ActionIntent, receipt: ActionReceipt): Promise<void> {
    const lock = await this.requiredLock(admission.run_id);
    if (await this.projection.runPaused(lock.run_id)) return;
    const deployment = lock.execution.deployment;
    if (preparationRequired(deployment))
      await this.launchPreparation(lock, receipt.created_at, 0);
    else if (!(await this.projection.runPaused(lock.run_id)))
      await this.launchExecution(lock, receipt.created_at, 0);
  }

  private async launchPreparation(
    lock: ExecutableRun,
    createdAt: string,
    attempt: number,
    generation = attempt,
    selectedTaskIds?: readonly string[],
  ): Promise<void> {
    const deployment = lock.execution.deployment;
    const policy = profile(lock, "launch_policy");
    const reservation =
      typeof policy.preparation_reservation_microusd === "number"
        ? policy.preparation_reservation_microusd
        : 0;
    if (
      !(await this.service.reserveJobActions(lock.run_id, [
        {
          category: "preparation",
          generation,
          created_at: createdAt,
          amount_microusd: reservation,
        },
      ]))
    )
      throw new PolicyError("preparation Job would exceed the run ceiling");
    const hourly = optionalHourlyCost(deployment);
    const intent = this.service.actionIntent(
      lock.run_id,
      "job.launch",
      "run-preparation",
      generation,
      {
        worker_role: "preparation",
        preparation_attempt: attempt,
        max_jobs: 1,
        task_ids: lock.tasks.map((task) => task.task_id),
        ...(selectedTaskIds && selectedTaskIds.length > 0
          ? {
              selected_task_ids: [
                selectedTaskIds[0] as string,
                ...selectedTaskIds.slice(1),
              ],
            }
          : {}),
        job_image: profileScalar<string>(deployment, "job_image", "string"),
        job_command: profileStrings(deployment, "preparation_job_command"),
        hardware: profileScalar<string>(deployment, "hardware", "string"),
        timeout_seconds: profileScalar<number>(
          deployment,
          "preparation_timeout_seconds",
          "number",
        ),
        success_without_worker_receipt: true,
        max_infrastructure_attempts:
          typeof policy.max_preparation_attempts === "number"
            ? policy.max_preparation_attempts
            : 1,
        reservation_microusd: reservation,
        trusted_worker: profileScalar<boolean>(deployment, "trusted_worker", "boolean"),
        worker_revision: profileScalar<string>(deployment, "worker_revision", "string"),
        inference_token: "forbidden",
        run_lock_digest: sha256(canonicalJson(lock.source_lock)),
        ...(hourly !== undefined ? { active_hourly_cost_microusd: hourly } : {}),
      },
    );
    await this.service.writeAction(intent);
  }

  private executionReservations(
    lock: ExecutableRun,
    taskIds: readonly string[],
    generation: number,
    createdAt: string,
  ): JobBudgetReservation[] {
    const policy = profile(lock, "launch_policy");
    const amountMicrousd = profileScalar<number>(
      policy,
      "reservation_microusd",
      "number",
    );
    return taskIds.map((taskId) => ({
      category: executionReservationCategory([taskId]),
      generation,
      created_at: createdAt,
      amount_microusd: amountMicrousd,
    }));
  }

  private async releaseObservedJobReservation(
    intent: ActionIntent,
    createdAt: string,
  ): Promise<void> {
    const launchActionId = scalar<string>(intent.payload, "launch_action_id", "string");
    const launch = await this.projection.action(launchActionId);
    if (launch?.action_kind !== "job.launch")
      throw new PolicyError("Job observation has no launch action");
    await this.service.releaseJobAction(
      JSON.parse(launch.intent_body) as ActionIntent,
      createdAt,
    );
  }

  private async continueJobObservation(runId: string): Promise<boolean> {
    const actions = await this.projection.runActions(runId);
    let wrote = false;
    for (const launch of actions) {
      if (launch.action_kind !== "job.launch" || launch.receipt_body === null) continue;
      if (launch.observed_state?.startsWith("suppressed-")) continue;
      const resourceId = launch.resource_id;
      if (!resourceId) continue;
      const launchIntent = JSON.parse(launch.intent_body) as ActionIntent;
      if (await this.allActionTasksTerminal(launchIntent)) continue;
      if (
        actions.some(
          (action) =>
            action.action_kind === "job.cancel" &&
            action.target === resourceId &&
            action.receipt_body !== null &&
            jobStateIsTerminal(action.observed_state),
        )
      )
        continue;
      const observes = actions.filter((action) => {
        if (action.action_kind !== "job.observe") return false;
        const intent = JSON.parse(action.intent_body) as ActionIntent;
        return (
          intent.payload.launch_action_id === launch.action_id ||
          action.target === resourceId
        );
      });
      if (observes.some((action) => action.receipt_body === null)) continue;
      if (observes.some((action) => jobStateIsTerminal(action.observed_state)))
        continue;
      const latest = observes
        .filter((action) => action.receipt_body !== null)
        .sort((left, right) => left.generation - right.generation)
        .at(-1);
      const source = latest ?? launch;
      const sourceIntent = JSON.parse(source.intent_body) as ActionIntent;
      if (!source.receipt_body)
        throw new PolicyError("Job observation recovery source has no receipt");
      const sourceReceipt = JSON.parse(source.receipt_body) as ActionReceipt;
      await this.service.writeAction(
        this.service.actionIntent(
          runId,
          "job.observe",
          resourceId,
          (latest?.generation ?? -1) + 1,
          {
            ...withoutRunActionIdempotency(sourceIntent.payload),
            resource_id: resourceId,
            launch_action_id: launch.action_id,
            // Match the normal observation writer exactly so recovery adopts an
            // action already written before a process interruption.
            not_before: new Date(
              Date.parse(sourceReceipt.created_at) +
                this.options.observation_interval_ms,
            ).toISOString(),
          },
        ),
      );
      wrote = true;
    }
    return wrote;
  }

  private async launchExecution(
    lock: ExecutableRun,
    createdAt: string,
    generation: number,
    taskIds = lock.tasks.map((task) => task.task_id),
  ): Promise<void> {
    const historical = !isCurrentRunLock(lock.source_lock);
    const tasks = new Map(
      (await this.projection.tasks(lock.run_id)).map((task) => [task.task_id, task]),
    );
    const pendingTaskIds: string[] = [];
    for (const taskId of taskIds) {
      const task = tasks.get(taskId);
      if (!task) throw new PolicyError(`run task is missing: ${taskId}`);
      if (!task.terminal_outcome || (historical && historicalTaskNeedsSelection(task)))
        pendingTaskIds.push(taskId);
    }
    if (pendingTaskIds.length === 0) return;

    const execution = lock.execution;
    const deployment = execution.deployment;
    const continuation = historical
      ? await this.projection.runContinuation(lock.run_id)
      : null;
    const repair = historical
      ? await this.projection.runContinuationRepair(lock.run_id)
      : null;
    const successor = historical
      ? await this.projection.runContinuationRepairSuccessor(lock.run_id)
      : null;
    if (historical && !continuation)
      throw new PolicyError("historical run has no execution continuation attachment");
    const policy = profile(lock, "launch_policy");
    const reservation = profileScalar<number>(policy, "reservation_microusd", "number");
    const reservations = this.executionReservations(
      lock,
      pendingTaskIds,
      generation,
      createdAt,
    );
    if (!(await this.service.reserveJobActions(lock.run_id, reservations)))
      throw new PolicyError("execution Jobs would exceed the run ceiling");
    const prepared = preparationRequired(deployment)
      ? await this.service.preparedJob(lock.run_id)
      : null;
    if (preparationRequired(deployment) && !prepared)
      throw new PolicyError("run preparation is incomplete");

    for (const taskId of pendingTaskIds) {
      const preparedTrial = prepared
        ? await this.service.preparedTrial(lock.run_id, taskId)
        : null;
      if (prepared && !preparedTrial)
        throw new PolicyError(`prepared trial is missing: ${taskId}`);
      const launch = preparedTrial
        ? preparedTrialJobLaunch(execution, preparedTrial)
        : {
            job_image: deployment.job_image,
            job_command: deployment.job_command,
            hardware: deployment.hardware,
            timeout_seconds: deployment.timeout_seconds,
            active_hourly_cost_microusd: deployment.active_hourly_cost_microusd ?? 0,
            max_jobs: 1,
            inference_token: deployment.inference_token ?? ("forbidden" as const),
            ...(execution.inference
              ? {
                  inference_upstream: execution.inference.upstream,
                  inference_model: execution.inference.bridge_model,
                  inference_api: execution.inference.api,
                }
              : {}),
            ...(deployment.inference_max_requests
              ? { inference_max_requests: deployment.inference_max_requests }
              : {}),
            ...(deployment.inference_max_concurrency
              ? { inference_max_concurrency: deployment.inference_max_concurrency }
              : {}),
            ...(deployment.inference_timeout_seconds
              ? { inference_timeout_seconds: deployment.inference_timeout_seconds }
              : {}),
            ...(deployment.inference_max_output_tokens
              ? { inference_max_output_tokens: deployment.inference_max_output_tokens }
              : {}),
          };
      const intent = this.service.actionIntent(
        lock.run_id,
        "job.launch",
        taskId,
        generation,
        {
          worker_role: "execution",
          task_id: taskId,
          task_ids: [taskId],
          ...launch,
          success_without_worker_receipt: profileScalar<boolean>(
            policy,
            "success_without_worker_receipt",
            "boolean",
          ),
          required_positive_metrics: optionalProfileStrings(
            policy,
            "required_positive_metrics",
          ),
          reservation_microusd: reservation,
          trusted_worker: deployment.trusted_worker,
          ...(deployment.worker_revision
            ? { worker_revision: deployment.worker_revision }
            : {}),
          run_lock_digest: sha256(canonicalJson(lock.source_lock)),
          ...(continuation ? { run_continuation_id: continuation.record_id } : {}),
          ...(repair ? { run_continuation_repair_id: repair.record_id } : {}),
          ...(successor
            ? { run_continuation_repair_successor_id: successor.record_id }
            : {}),
          ...(prepared ? { prepared_job_digest: sha256(canonicalJson(prepared)) } : {}),
        },
      );
      await this.service.writeAction(intent);
    }
  }

  private async observeJob(
    launch: ActionIntent,
    receipt: ActionReceipt,
  ): Promise<void> {
    if (!receipt.resource_id)
      throw new PolicyError("job launch receipt has no remote identity");
    const intent = this.service.actionIntent(
      launch.run_id,
      "job.observe",
      receipt.resource_id,
      0,
      {
        ...withoutRunActionIdempotency(launch.payload),
        resource_id: receipt.resource_id,
        launch_action_id: launch.action_id,
        not_before: new Date(
          Date.parse(receipt.created_at) + this.options.observation_interval_ms,
        ).toISOString(),
      },
    );
    await this.service.writeAction(intent);
  }

  private async handleJobObservation(
    intent: ActionIntent,
    receipt: ActionReceipt,
  ): Promise<void> {
    if (receipt.outcome === "failed") {
      if (await this.allActionTasksTerminal(intent)) return;
      const retry = this.service.actionIntent(
        intent.run_id,
        "job.observe",
        intent.target,
        intent.generation + 1,
        {
          ...withoutRunActionIdempotency(intent.payload),
          not_before: new Date(
            Date.parse(receipt.created_at) + this.options.observation_interval_ms,
          ).toISOString(),
        },
      );
      await this.service.writeAction(retry);
      return;
    }
    const state = receipt.observed_state.toUpperCase();
    if (!jobStateIsTerminal(state)) {
      if (await this.allActionTasksTerminal(intent)) return;
      const next = this.service.actionIntent(
        intent.run_id,
        "job.observe",
        intent.target,
        intent.generation + 1,
        {
          ...withoutRunActionIdempotency(intent.payload),
          not_before: new Date(
            Date.parse(receipt.created_at) + this.options.observation_interval_ms,
          ).toISOString(),
        },
      );
      await this.service.writeAction(next);
      return;
    }
    await this.releaseObservedJobReservation(intent, receipt.created_at);
    if (!(await this.runHasExecution(intent.run_id))) return;
    if (intent.payload.worker_role === "preparation") {
      await this.handlePreparationTerminal(intent, receipt, state);
      return;
    }
    if (state === "STOPPED" || state === "COMPLETED") {
      const successful = scalar<boolean>(
        intent.payload,
        "success_without_worker_receipt",
        "boolean",
      );
      const workerAttemptsPresent = await this.allWorkerAttemptsPresent(intent);
      const graceMs = this.options.worker_receipt_grace_ms ?? 0;
      const deadline = intent.payload.worker_receipt_deadline;
      const cancelling = await this.launchCancellationRequested(intent);
      if (
        !successful &&
        !workerAttemptsPresent &&
        !cancelling &&
        typeof deadline !== "string" &&
        graceMs > 0
      ) {
        const workerReceiptDeadline = new Date(
          Date.parse(receipt.created_at) + graceMs,
        ).toISOString();
        const next = this.service.actionIntent(
          intent.run_id,
          "job.observe",
          intent.target,
          intent.generation + 1,
          {
            ...withoutRunActionIdempotency(intent.payload),
            not_before: workerReceiptDeadline,
            worker_receipt_deadline: workerReceiptDeadline,
          },
        );
        await this.service.writeAction(next);
        return;
      }
      if (!workerAttemptsPresent)
        await this.service.syncProjection(
          `control/schema=v1/runs/${intent.run_id}/tasks`,
        );
      await this.completeTasksFromJob(
        intent,
        receipt,
        successful ? "complete" : "infrastructure",
      );
      return;
    }
    if (!(await this.allWorkerAttemptsPresent(intent)))
      await this.service.syncProjection(
        `control/schema=v1/runs/${intent.run_id}/tasks`,
      );
    await this.completeTasksFromJob(intent, receipt, "infrastructure");
  }

  private async handlePreparationTerminal(
    intent: ActionIntent,
    receipt: ActionReceipt,
    state: string,
  ): Promise<void> {
    const successful = state === "STOPPED" || state === "COMPLETED";
    const prepared = successful ? await this.service.preparedJob(intent.run_id) : null;
    if (prepared) {
      const lock = await this.requiredLock(intent.run_id);
      if (prepared.run_lock_digest !== sha256(canonicalJson(lock.source_lock)))
        throw new PolicyError("prepared job does not match the run lock");
      if (!(await this.projection.runPaused(intent.run_id)))
        await this.launchExecution(
          lock,
          receipt.created_at,
          0,
          optionalStringArray(intent.payload, "selected_task_ids"),
        );
      return;
    }
    const graceMs = this.options.worker_receipt_grace_ms ?? 0;
    const deadline = intent.payload.worker_receipt_deadline;
    const cancelling = await this.launchCancellationRequested(intent);
    if (successful && !cancelling && typeof deadline !== "string" && graceMs > 0) {
      const preparationDeadline = new Date(
        Date.parse(receipt.created_at) + graceMs,
      ).toISOString();
      await this.service.writeAction(
        this.service.actionIntent(
          intent.run_id,
          "job.observe",
          intent.target,
          intent.generation + 1,
          {
            ...withoutRunActionIdempotency(intent.payload),
            not_before: preparationDeadline,
            worker_receipt_deadline: preparationDeadline,
          },
        ),
      );
      return;
    }
    const attempt =
      typeof intent.payload.preparation_attempt === "number"
        ? intent.payload.preparation_attempt
        : 0;
    const maximum = scalar<number>(
      intent.payload,
      "max_infrastructure_attempts",
      "number",
    );
    if (!cancelling && attempt + 1 < maximum) {
      if (await this.projection.runPaused(intent.run_id)) return;
      const lock = await this.requiredLock(intent.run_id);
      await this.launchPreparation(
        lock,
        receipt.created_at,
        attempt + 1,
        attempt + 1,
        optionalStringArray(intent.payload, "selected_task_ids"),
      );
      return;
    }
    const sourceActionId =
      intent.action_kind === "job.launch"
        ? intent.action_id
        : scalar<string>(intent.payload, "launch_action_id", "string");
    for (const taskId of optionalStringArray(intent.payload, "selected_task_ids") ??
      stringArray(intent.payload, "task_ids")) {
      const task = await this.projection.task(intent.run_id, taskId);
      if (!task || task.task.terminal_outcome) continue;
      await this.service.exhaustTaskFromPreparation(
        intent.run_id,
        taskId,
        sourceActionId,
        receipt.created_at,
        "run preparation exhausted",
        attempt + 1,
      );
    }
  }

  private async allWorkerAttemptsPresent(intent: ActionIntent): Promise<boolean> {
    const taskIds = stringArray(intent.payload, "task_ids");
    const launchActionId = scalar<string>(intent.payload, "launch_action_id", "string");
    const attempts = await this.projection.runAttempts(intent.run_id);
    return taskIds.every((taskId) =>
      attempts.some(
        (attempt) => attempt.task_id === taskId && attempt.action_id === launchActionId,
      ),
    );
  }

  private async completeTasksFromJob(
    intent: ActionIntent,
    receipt: ActionReceipt,
    fallback: AttemptReceipt["outcome"],
    replacementEligible = fallback === "infrastructure",
  ): Promise<void> {
    const tasks = stringArray(intent.payload, "task_ids");
    const known = await this.projection.runAttempts(intent.run_id);
    const continuation = await this.projection.runContinuation(intent.run_id);
    const continued =
      continuation !== null &&
      intent.payload.run_continuation_id === continuation.record_id;
    for (const taskId of tasks) {
      const task = await this.projection.task(intent.run_id, taskId);
      if (
        !task ||
        (task.task.terminal_outcome &&
          !(continued && historicalTaskNeedsSelection(task.task)))
      )
        continue;
      const launchActionId =
        intent.action_kind === "job.launch"
          ? intent.action_id
          : scalar<string>(intent.payload, "launch_action_id", "string");
      const workerAttempt = known
        .filter(
          (attempt) =>
            attempt.task_id === taskId && attempt.action_id === launchActionId,
        )
        .at(-1);
      if (workerAttempt && workerAttempt.attempt_id !== task.task.selected_attempt_id) {
        const parsed = JSON.parse(workerAttempt.body) as AttemptReceipt;
        await this.finishAttempt(parsed, intent);
        continue;
      }
      const attemptId = deterministicId(
        "attempt",
        intent.run_id,
        taskId,
        intent.action_id,
      );
      const attempt = await this.service.attempt({
        run_id: intent.run_id,
        task_id: taskId,
        attempt_id: attemptId,
        action_id: launchActionId,
        outcome: fallback,
        replacement_eligible: replacementEligible,
        ...(replacementEligible
          ? {
              failure_fingerprint: sha256(
                canonicalJson({
                  kind: "job-terminal-without-worker-receipt",
                  observed_state: receipt.observed_state,
                  worker_revision: intent.payload.worker_revision ?? "unknown",
                }),
              ),
            }
          : {}),
        evidence_digest: sha256(canonicalJson(receipt)),
        evidence_path: controlRecordPath(receipt),
        cost_microusd: 0,
        metrics: {},
        completed_at: receipt.created_at,
      });
      await this.finishAttempt(attempt, intent);
    }
  }

  private async finishAttempt(
    attempt: AttemptReceipt,
    source: ActionIntent,
  ): Promise<void> {
    if (
      attempt.outcome === "cancelled" &&
      (await this.taskCancellationRequested(attempt.run_id, attempt.task_id))
    )
      return;
    const task = await this.projection.task(attempt.run_id, attempt.task_id);
    if (task?.task.selected_attempt_id) return;
    const lock = await this.requiredLock(attempt.run_id);
    const validity = attemptAdmissibility(
      attempt,
      requiredPositiveMetrics(lock.source_lock),
    );
    const runAttempts = await this.projection.runAttempts(attempt.run_id);
    const attempts = runAttempts.filter((item) => item.task_id === attempt.task_id);
    if (source.payload.worker_role === "preparation") {
      await this.service.exhaustTask(
        attempt,
        `run preparation exhausted: ${validity.reason}`,
        attempts.length,
      );
      return;
    }
    if (validity.admissible) {
      await this.service.selectTerminal(attempt, "valid terminal worker outcome");
      return;
    }
    if (attempt.outcome !== "infrastructure" || !attempt.replacement_eligible) {
      await this.service.exhaustTask(
        attempt,
        `non-retryable attempt: ${validity.reason}`,
        attempts.length,
      );
      return;
    }

    await this.service.withInfrastructureRetryAdmission(async () => {
      if (
        await this.projection.retryActionForAttempt(attempt.run_id, attempt.attempt_id)
      )
        return;
      const infrastructureAttempts = attempts.filter(
        (item) => item.outcome === "infrastructure",
      );
      if (attempt.failure_fingerprint) {
        const matchingFailures = runAttempts.filter((item) => {
          const receipt = JSON.parse(item.body) as AttemptReceipt;
          return (
            receipt.outcome === "infrastructure" &&
            receipt.failure_fingerprint === attempt.failure_fingerprint
          );
        });
        const resumedAfterAttempt = (
          await this.projection.runActions(attempt.run_id)
        ).some(
          (action) =>
            action.action_kind === "run.resume" &&
            Date.parse(action.created_at) > Date.parse(attempt.created_at),
        );
        if (matchingFailures.length >= 2 && !resumedAfterAttempt) {
          await this.service.writeAction(
            this.service.actionIntent(
              attempt.run_id,
              "run.pause",
              attempt.task_id,
              infrastructureAttempts.length,
              { reason: "repeated deterministic infrastructure failure" },
            ),
          );
          return;
        }
      }
      if (
        await this.service.laterExecutionLaunchExists(
          attempt.run_id,
          attempt.task_id,
          attempt.action_id,
        )
      )
        return;
      if (await this.projection.runPaused(attempt.run_id)) return;
      const reservation = scalar<number>(
        source.payload,
        "reservation_microusd",
        "number",
      );
      if (
        !(await this.service.reserveReplacement(
          attempt.run_id,
          attempt.attempt_id,
          attempt.created_at,
          reservation,
        ))
      ) {
        await this.service.exhaustTask(
          attempt,
          `run ceiling blocks replacement: ${validity.reason}`,
          attempts.length,
        );
        return;
      }
      const priorLaunch = await this.projection.action(attempt.action_id);
      if (priorLaunch?.action_kind !== "job.launch")
        throw new PolicyError("attempt does not identify its physical Job launch");
      const launch = JSON.parse(priorLaunch.intent_body) as ActionIntent;
      const retryGeneration = isCurrentRunLock(lock.source_lock)
        ? infrastructureAttempts.length
        : await this.projection.nextExecutionLaunchGeneration(attempt.run_id);
      const repair = isCurrentRunLock(lock.source_lock)
        ? null
        : await this.projection.runContinuationRepair(attempt.run_id);
      const successor = isCurrentRunLock(lock.source_lock)
        ? null
        : await this.projection.runContinuationRepairSuccessor(attempt.run_id);
      const retry = this.service.actionIntent(
        attempt.run_id,
        "job.launch",
        attempt.task_id,
        retryGeneration,
        {
          ...withoutRunActionIdempotency(launch.payload),
          ...(repair
            ? {
                job_image: lock.execution.deployment.job_image,
                worker_revision: lock.execution.deployment.worker_revision,
                run_continuation_repair_id: repair.record_id,
              }
            : {}),
          ...(successor
            ? {
                job_image: lock.execution.deployment.job_image,
                worker_revision: lock.execution.deployment.worker_revision,
                run_continuation_repair_successor_id: successor.record_id,
              }
            : {}),
          task_id: attempt.task_id,
          task_ids: [attempt.task_id],
          prior_attempt_id: attempt.attempt_id,
        },
      );
      await this.service.writeAction(retry);
    });
  }

  private cancellationTargets(
    cancellation: ActionIntent,
    launch: ActionIntent,
  ): boolean {
    const taskId = cancellation.payload.task_id;
    if (typeof taskId !== "string") return true;
    if (launch.payload.worker_role === "preparation") return false;
    return (
      Array.isArray(launch.payload.task_ids) && launch.payload.task_ids.includes(taskId)
    );
  }

  private async cancellationIntents(runId: string): Promise<ActionIntent[]> {
    return (await this.projection.runActions(runId))
      .filter((action) => action.action_kind === "run.cancel")
      .map((action) => JSON.parse(action.intent_body) as ActionIntent);
  }

  private async launchCancellationRequested(intent: ActionIntent): Promise<boolean> {
    return (await this.cancellationIntents(intent.run_id)).some((cancellation) =>
      this.cancellationTargets(cancellation, intent),
    );
  }

  private async taskCancellationRequested(
    runId: string,
    taskId: string,
  ): Promise<boolean> {
    return (await this.cancellationIntents(runId)).some(
      (cancellation) =>
        typeof cancellation.payload.task_id !== "string" ||
        cancellation.payload.task_id === taskId,
    );
  }

  private async continueCancellation(runId: string): Promise<void> {
    const actions = await this.projection.runActions(runId);
    const cancellations = actions.filter(
      (action) => action.action_kind === "run.cancel" && action.receipt_body !== null,
    );
    for (const cancellation of cancellations) {
      if (!cancellation.receipt_body) continue;
      await this.continueCancellationIntent(
        runId,
        JSON.parse(cancellation.intent_body) as ActionIntent,
        JSON.parse(cancellation.receipt_body) as ActionReceipt,
        actions,
      );
    }
  }

  private async continueCancellationIntent(
    runId: string,
    cancellation: ActionIntent,
    receipt: ActionReceipt,
    actions: Awaited<ReturnType<Projection["runActions"]>>,
  ): Promise<void> {
    const launches = actions.filter((action) => {
      if (action.action_kind !== "job.launch") return false;
      const launch = JSON.parse(action.intent_body) as ActionIntent;
      return this.cancellationTargets(cancellation, launch);
    });
    for (const launch of launches) {
      if (
        launch.receipt_body === null &&
        (await this.projection.actionDispatch(launch.action_id))
      )
        return;
    }
    const launched = launches.filter(
      (action) => action.receipt_body !== null && action.resource_id !== null,
    );
    const active = new Map<
      string,
      {
        resource_id: string;
        launch_action_id: string;
        observed_at: string;
        launch_payload: ActionIntent["payload"];
      }
    >();
    for (const launch of launched) {
      const resourceId = launch.resource_id;
      if (!resourceId || active.has(resourceId)) continue;
      const observations = actions.filter(
        (action) =>
          action.target === resourceId &&
          action.receipt_body !== null &&
          ["job.observe", "job.cancel"].includes(action.action_kind),
      );
      if (observations.some((action) => jobStateIsTerminal(action.observed_state)))
        continue;
      const latest = observations[0];
      const state = latest?.observed_state ?? launch.observed_state;
      if (!jobStateIsTerminal(state)) {
        const launchIntent = JSON.parse(launch.intent_body) as ActionIntent;
        active.set(resourceId, {
          resource_id: resourceId,
          launch_action_id: launch.action_id,
          observed_at: latest?.created_at ?? launch.created_at,
          launch_payload: launchIntent.payload,
        });
      }
    }
    if (active.size > 0) {
      for (const job of active.values()) {
        const cancellations = actions.filter(
          (action) =>
            action.action_kind === "job.cancel" && action.target === job.resource_id,
        );
        if (cancellations.some((action) => action.receipt_body === null)) continue;
        const generation =
          cancellations.reduce(
            (maximum, action) => Math.max(maximum, action.generation),
            -1,
          ) + 1;
        if (generation > 1_000_000)
          throw new PolicyError("Job cancellation action limit is exhausted");
        await this.service.writeAction(
          this.service.actionIntent(runId, "job.cancel", job.resource_id, generation, {
            ...job.launch_payload,
            resource_id: job.resource_id,
            launch_action_id: job.launch_action_id,
            not_before: new Date(
              Date.parse(job.observed_at) + this.options.observation_interval_ms,
            ).toISOString(),
          }),
        );
      }
      return;
    }
    await this.cancelOpenTasks(runId, cancellation, receipt);
  }

  private async cancelOpenTasks(
    runId: string,
    intent: ActionIntent,
    receipt: ActionReceipt,
  ): Promise<void> {
    const taskId = intent.payload.task_id;
    for (const task of await this.projection.tasks(runId)) {
      if (task.terminal_outcome) continue;
      if (typeof taskId === "string" && task.task_id !== taskId) continue;
      await this.service.cancelTask(
        runId,
        task.task_id,
        intent.action_id,
        receipt.created_at,
        "operator cancellation",
      );
    }
  }

  private async recordEndpoint(
    intent: ActionIntent,
    receipt: ActionReceipt,
  ): Promise<void> {
    if (!receipt.resource_id)
      throw new PolicyError("endpoint receipt has no remote identity");
    if (typeof receipt.ready_replicas !== "number")
      throw new PolicyError("endpoint receipt has no replica observation");
    const readyReplicas = receipt.ready_replicas;
    const desired = intent.action_kind === "endpoint.pause" ? "paused" : "running";
    const record: EndpointResource = {
      schema_version: "v1",
      kind: "endpoint.resource",
      record_id: deterministicId("endpoint", intent.action_id),
      created_at: receipt.created_at,
      actor: { subject: "harbor-hf-control", role: "service" },
      run_id: intent.run_id,
      action_id: intent.action_id,
      endpoint_id: receipt.resource_id,
      desired_state: desired,
      observed_state: receipt.observed_state,
      ready_replicas: readyReplicas,
      cleanup_verified: desired === "paused" && readyReplicas === 0,
      active_hourly_cost_microusd: receipt.active_hourly_cost_microusd ?? 0,
    };
    await this.service.append(record);
  }

  private async maybePublish(runId: string): Promise<boolean> {
    const run = await this.projection.run(runId);
    if (!run || run.total_tasks === 0 || run.terminal_tasks !== run.total_tasks)
      return false;
    if (await this.ensureEndpointCleanup(runId)) return true;
    return this.service.admitAutomaticPublication(runId);
  }

  private async ensureEndpointCleanup(runId: string): Promise<boolean> {
    const endpoints = (await this.projection.endpoints(10_000)).filter(
      (endpoint) => endpoint.run_id === runId && endpoint.cleanup_verified === 0,
    );
    if (endpoints.length === 0) return false;
    const actions = await this.projection.actions(10_000);
    let created = false;
    for (const endpoint of endpoints) {
      const pauses = actions.filter(
        (action) =>
          action.run_id === runId &&
          action.action_kind === "endpoint.pause" &&
          action.target === endpoint.endpoint_id,
      );
      if (pauses.some((action) => action.receipt_body === null)) continue;
      const generation =
        pauses.reduce((maximum, action) => Math.max(maximum, action.generation), -1) +
        1;
      if (generation > 1_000_000)
        throw new PolicyError("endpoint cleanup action limit is exhausted");
      await this.service.writeAction(
        this.service.actionIntent(
          runId,
          "endpoint.pause",
          endpoint.endpoint_id,
          generation,
          {
            endpoint_id: endpoint.endpoint_id,
            not_before: new Date(
              Date.parse(endpoint.created_at) + this.options.observation_interval_ms,
            ).toISOString(),
          },
        ),
      );
      created = true;
    }
    return created;
  }

  private async allActionTasksTerminal(intent: ActionIntent): Promise<boolean> {
    if (intent.payload.worker_role === "preparation") return false;
    const taskIds = stringArray(intent.payload, "task_ids");
    if (taskIds.length === 0) return false;
    const lock = await this.projection.runLock(intent.run_id);
    const historical = lock !== null && !isCurrentRunLock(lock);
    const continuation = historical
      ? await this.projection.runContinuation(intent.run_id)
      : null;
    const continued =
      continuation !== null &&
      intent.payload.run_continuation_id === continuation.record_id;
    for (const taskId of taskIds) {
      const task = await this.projection.task(intent.run_id, taskId);
      if (
        !task?.task.terminal_outcome ||
        (historical
          ? continued && historicalTaskNeedsSelection(task.task)
          : infrastructureSealReplaceable(task.task.terminal_outcome))
      )
        return false;
    }
    return true;
  }

  private async requiredLock(runId: string): Promise<ExecutableRun> {
    const lock = await this.projection.runLock(runId);
    if (!lock) throw new PolicyError(`run lock is missing: ${runId}`);
    return {
      run_id: lock.run_id,
      tasks: lock.tasks,
      profiles: lock.profiles,
      execution: await this.service.runExecution(lock),
      source_lock: lock,
    };
  }
}

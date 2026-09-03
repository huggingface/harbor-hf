import { join } from "node:path";
import type {
  ActionIntent,
  AttemptReceipt,
  JobAdmissionGrant,
  PreparedJob,
  PreparedTrial,
  ProfileObject,
  ProfilePromotion,
  RunLock,
  TerminalSelection,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sha256,
  workerEvidenceObjectPath,
} from "@harbor-hf/contracts";
import { NoopActions } from "@harbor-hf/hf-adapters";
import type { TestControl } from "@harbor-hf/test-fixtures";
import {
  createTestControl,
  createTestControlFromProfiles,
  preparedProfiles,
} from "@harbor-hf/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRunContinuationCompatible } from "../src/execution-contract.js";
import { Projection } from "../src/projection.js";
import { ResultPublisher } from "../src/publication.js";
import {
  AmbiguousExternalActionError,
  type ExternalActionContext,
  ExternalActionNotFoundError,
  type ExternalActionPort,
  type ExternalActionResult,
  nextAvailableActionGeneration,
  Reconciler,
} from "../src/reconciler.js";
import { runIdentity, runUnique } from "../src/run-id.js";
import {
  ControlService,
  executionReservationCategory,
  jobStateIsTerminal,
} from "../src/service.js";

const controls: TestControl[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(controls.splice(0).map((control) => control.close()));
});

const submission = {
  benchmark: "control-smoke",
  model: "control-smoke",
  harness: "control-smoke",
  deployment: "hf-cpu-smoke",
  launch_policy: "control-smoke",
  ceiling_microusd: 0,
  confirmed: true,
} as const;
const operator = { subject: "operator-1", role: "operator" as const };

describe("profile cutover Job classification", () => {
  it("treats suppressed launch outcomes as terminal", () => {
    expect(jobStateIsTerminal("suppressed-paused")).toBe(true);
    expect(jobStateIsTerminal("suppressed-cancelled")).toBe(true);
    expect(jobStateIsTerminal("COMPLETED")).toBe(true);
    expect(jobStateIsTerminal("RUNNING")).toBe(false);
    expect(jobStateIsTerminal(null)).toBe(false);
  });

  it("selects an unused action generation without treating it as an ordinal", () => {
    expect(nextAvailableActionGeneration([1_000_000])).toBe(0);
    expect(nextAvailableActionGeneration([0, 2], 2)).toBe(1);
    expect(nextAvailableActionGeneration([0, 1, 2], 2)).toBeNull();
  });
});

async function settle(reconciler: Reconciler, rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await reconciler.tick();
}

async function configureCapacity(
  control: TestControl,
  input: {
    maximum?: number;
    hardwareMaximum?: number;
    burst?: number;
  } = {},
): Promise<void> {
  const createdAt = "2026-08-22T00:00:00.000Z";
  const spec = {
    namespace: "test",
    max_active_jobs: input.maximum ?? 2,
    hardware_limits: [
      {
        hardware: "cpu-basic",
        max_active_jobs: input.hardwareMaximum ?? 2,
      },
    ],
    start_burst: input.burst ?? 2,
    start_refill_tokens: 1,
    start_refill_period_seconds: 60,
  };
  const profile: ProfileObject = {
    schema_version: "v1",
    kind: "profile.object",
    record_id: deterministicId(
      "profile",
      "capacity",
      "capacity-test",
      sha256(canonicalJson(spec)),
    ),
    created_at: createdAt,
    actor: { subject: "test", role: "service" },
    profile_kind: "capacity",
    name: "capacity-test",
    spec,
  };
  const profileId = sha256(canonicalJson(profile));
  const promotion: ProfilePromotion = {
    schema_version: "v1",
    kind: "profile.promotion",
    record_id: deterministicId("profile-promotion", "capacity", "current"),
    created_at: createdAt,
    actor: operator,
    profile_kind: "capacity",
    alias: "current",
    profile_id: profileId,
    promotion_state: "approved",
    reason: "test capacity policy",
    evidence: [],
  };
  await control.service.append(profile);
  await control.service.append(promotion);
  await control.service.refreshProfileResolver();
  control.service.configureCapacityProfile("current");
}

async function putEvidenceReference(
  control: TestControl,
  label: string,
): Promise<{ evidence_digest: string; evidence_path: string }> {
  const bytes = new TextEncoder().encode(label);
  const digest = sha256(bytes);
  const path = `evidence/test/${digest.slice("sha256:".length)}`;
  await control.store.create(path, bytes);
  return { evidence_digest: digest, evidence_path: path };
}

async function putWorkerEvidence(
  control: TestControl,
  runId: string,
  actionId: string,
  taskId: string,
  label: string,
): Promise<{ evidence_digest: string; evidence_path: string }> {
  const chunk = new TextEncoder().encode(label);
  const chunkDigest = sha256(chunk);
  const chunkPath = workerEvidenceObjectPath(runId, actionId, taskId, chunkDigest);
  await control.store.create(chunkPath, chunk);
  const manifest = {
    schema_version: "v1",
    kind: "worker.evidence.manifest",
    run_id: runId,
    action_id: actionId,
    task_id: taskId,
    objects: [{ path: chunkPath, digest: chunkDigest, size: chunk.byteLength }],
  };
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  const manifestDigest = sha256(manifestBytes);
  const manifestPath = workerEvidenceObjectPath(
    runId,
    actionId,
    taskId,
    manifestDigest,
  );
  await control.store.create(manifestPath, manifestBytes);
  return { evidence_digest: manifestDigest, evidence_path: manifestPath };
}

describe("control service", () => {
  it("fails closed when a configured capacity profile is not approved", async () => {
    const control = await createTestControl();
    controls.push(control);
    control.service.configureCapacityProfile("missing-capacity");

    expect(() => control.service.requireCapacityProfile()).toThrow(
      "unapproved capacity profile",
    );
  });

  it("attaches current execution without mutating a historical lock", async () => {
    const control = await createTestControlFromProfiles(preparedProfiles(2));
    controls.push(control);
    const historicalProfiles = control.profiles.map(({ profile, profile_id }) => {
      const spec = profile.spec as unknown as Record<string, unknown>;
      const historicalSpec =
        profile.profile_kind === "model" ||
        profile.profile_kind === "harness" ||
        profile.profile_kind === "deployment"
          ? Object.fromEntries(
              Object.entries(spec).filter(([key]) => key !== "contract_version"),
            )
          : spec;
      if (profile.profile_kind === "harness")
        historicalSpec.harbor_agent = {
          import_path: "legacy.agent:Agent",
          kwargs: {},
        };
      if (profile.profile_kind === "deployment") {
        historicalSpec.job_image =
          "example.invalid/legacy@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        historicalSpec.worker_revision = "legacy-worker";
      }
      return {
        kind: profile.profile_kind,
        name: profile.name,
        profile_id,
        spec: historicalSpec,
      };
    }) as RunLock["profiles"];
    const legacy: RunLock = {
      schema_version: "v1",
      kind: "run.lock",
      record_id: "lock-legacy-read-only",
      created_at: "2026-08-16T00:00:00.000Z",
      actor: { subject: "migration", role: "migration" },
      run_id: "run-legacy-read-only",
      profiles: historicalProfiles,
      tasks: [
        {
          task_id: "task-001-trial-1",
          source_task_id: "task-001",
          trial_index: 1,
          input_digest: sha256("task-001"),
        },
        {
          task_id: "task-002-trial-1",
          source_task_id: "task-002",
          trial_index: 1,
          input_digest: sha256("task-002"),
        },
      ],
      ceiling_microusd: 1_000_000,
      source_revision: `sha256:${"0".repeat(64)}`,
    };
    await control.service.append(legacy);
    const [selectedTask, unresolvedTask] = legacy.tasks;
    if (!selectedTask || !unresolvedTask)
      throw new Error("historical continuation test needs two tasks");
    const preparationId = deterministicId("preparation", legacy.run_id);
    const runLockDigest = ControlService.recordDigest(legacy);
    const preparedTrials: PreparedTrial[] = legacy.tasks.map((task) => {
      if (!task.source_task_id || task.trial_index === undefined)
        throw new Error(`prepared task identity is incomplete: ${task.task_id}`);
      return {
        schema_version: "v1",
        kind: "prepared.trial",
        record_id: deterministicId("prepared-trial", legacy.run_id, task.task_id),
        created_at: "2026-08-16T00:00:00.000Z",
        actor: { subject: "migration", role: "migration" },
        run_id: legacy.run_id,
        preparation_id: preparationId,
        run_lock_digest: runLockDigest,
        task_id: task.task_id,
        source_task_id: task.source_task_id,
        trial_index: task.trial_index,
        input_digest: task.input_digest,
        trial_lock: { schema_version: 2 },
        trial_lock_digest: sha256(task.task_id),
        declared_image: "python:3.12",
        image: `library/python@sha256:${"b".repeat(64)}`,
        cpus: 1,
        memory_mb: 2048,
        storage_mb: 10240,
        gpus: 0,
        agent_timeout_seconds: 900,
        verifier_timeout_seconds: 600,
        environment_build_timeout_seconds: 600,
        agent_setup_timeout_seconds: 360,
      };
    });
    for (const trial of preparedTrials) await control.service.append(trial);
    const preparedJob: PreparedJob = {
      schema_version: "v1",
      kind: "prepared.job",
      record_id: deterministicId("prepared-job", legacy.run_id),
      created_at: "2026-08-16T00:00:00.000Z",
      actor: { subject: "migration", role: "migration" },
      run_id: legacy.run_id,
      preparation_id: preparationId,
      run_lock_digest: runLockDigest,
      harbor_version: "0.21.0",
      job_config: { n_attempts: 1 },
      job_lock_header: { schema_version: 3 },
      trials: preparedTrials.map((trial) => ({
        task_id: trial.task_id,
        record_id: trial.record_id,
        record_digest: ControlService.recordDigest(trial),
      })) as PreparedJob["trials"],
      harbor_lock_digest: sha256("harbor-lock"),
    };
    await control.service.append(preparedJob);
    const historicalLaunch = control.service.actionIntent(
      legacy.run_id,
      "job.launch",
      selectedTask.task_id,
      0,
      {
        worker_role: "execution",
        task_id: selectedTask.task_id,
        task_ids: [selectedTask.task_id],
      },
      { subject: "migration", role: "migration" },
      "2026-08-16T00:00:01.000Z",
    );
    await control.service.append(historicalLaunch);
    const launchReceipt = await control.service.receipt(historicalLaunch, {
      outcome: "completed",
      observed_state: "COMPLETED",
    });
    await control.service.markAdvanced(historicalLaunch, launchReceipt);
    const selectedAttempt: AttemptReceipt = {
      schema_version: "v1",
      kind: "attempt.receipt",
      record_id: "attempt-receipt-legacy-selected",
      created_at: "2026-08-16T00:00:02.000Z",
      actor: { subject: "migration", role: "migration" },
      run_id: legacy.run_id,
      task_id: selectedTask.task_id,
      attempt_id: "attempt-legacy-selected",
      action_id: historicalLaunch.action_id,
      outcome: "infrastructure",
      replacement_eligible: true,
      evidence_digest: sha256("legacy-selected-evidence"),
      evidence_path: "evidence/legacy-selected",
      cost_microusd: 7,
      metrics: {},
    };
    await control.service.append(selectedAttempt);
    await control.service.append({
      schema_version: "v1",
      kind: "terminal.selection",
      record_id: "terminal-legacy-selected",
      created_at: "2026-08-16T00:00:03.000Z",
      actor: { subject: "migration", role: "migration" },
      run_id: legacy.run_id,
      task_id: selectedTask.task_id,
      attempt_id: selectedAttempt.attempt_id,
      outcome: "infrastructure",
      reason: "historical selected outcome",
    });

    await expect(
      control.service.runAction(
        legacy.run_id,
        { action: "pause", confirmed: true },
        "legacy-pause",
        operator,
      ),
    ).rejects.toThrow("historical run has no execution continuation attachment");
    const blockedLaunch = control.service.actionIntent(
      legacy.run_id,
      "job.launch",
      unresolvedTask.task_id,
      0,
      {
        worker_role: "execution",
        task_id: unresolvedTask.task_id,
        task_ids: [unresolvedTask.task_id],
      },
      { subject: "migration", role: "migration" },
      "2026-08-16T00:00:04.000Z",
    );
    await control.service.append(blockedLaunch);
    const blockedExternal = new NoopActions();
    const execute = vi.spyOn(blockedExternal, "execute");
    const blockedReconciler = new Reconciler(
      control.service,
      control.projection,
      blockedExternal,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await expect(blockedReconciler.tick()).resolves.toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(
      (await control.projection.action(blockedLaunch.action_id))?.receipt_body,
    ).toBeNull();
    const blockedReceipt = await control.service.receipt(blockedLaunch, {
      outcome: "completed",
      observed_state: "suppressed-historical",
    });
    await control.service.markAdvanced(blockedLaunch, blockedReceipt);
    const pause = control.service.actionIntent(
      legacy.run_id,
      "run.pause",
      "run",
      0,
      { reason: "preserve the historical boundary" },
      { subject: "migration", role: "migration" },
      "2026-08-16T00:01:00.000Z",
    );
    await control.service.append(pause);
    const pauseReceipt = await control.service.receipt(pause, {
      outcome: "completed",
      observed_state: "paused",
    });
    await expect(
      control.service.continueHistoricalRun(
        legacy.run_id,
        { reason: "finish unresolved tasks", confirmed: true },
        "legacy-continuation",
        operator,
      ),
    ).rejects.toThrow("unadvanced action");
    await control.service.markAdvanced(pause, pauseReceipt);
    const activeHistoricalLaunch = control.service.actionIntent(
      legacy.run_id,
      "job.launch",
      unresolvedTask.task_id,
      1,
      {
        worker_role: "execution",
        task_id: unresolvedTask.task_id,
        task_ids: [unresolvedTask.task_id],
      },
      { subject: "migration", role: "migration" },
      "2026-08-16T00:01:01.000Z",
    );
    await control.service.append(activeHistoricalLaunch);
    const activeLaunchReceipt = await control.service.receipt(activeHistoricalLaunch, {
      outcome: "completed",
      observed_state: "RUNNING",
      resource_id: "legacy-active-job",
    });
    await control.service.markAdvanced(activeHistoricalLaunch, activeLaunchReceipt);
    await expect(
      control.service.continueHistoricalRun(
        legacy.run_id,
        { reason: "finish unresolved tasks", confirmed: true },
        "legacy-continuation",
        operator,
      ),
    ).rejects.toThrow("running Job");
    const terminalObservation = control.service.actionIntent(
      legacy.run_id,
      "job.observe",
      "legacy-active-job",
      0,
      {
        launch_action_id: activeHistoricalLaunch.action_id,
        resource_id: "legacy-active-job",
      },
      { subject: "migration", role: "migration" },
      "2026-08-16T00:01:02.000Z",
    );
    await control.service.append(terminalObservation);
    const terminalObservationReconciler = new Reconciler(
      control.service,
      control.projection,
      {
        execute: async (): Promise<ExternalActionResult> => ({
          outcome: "completed",
          observed_state: "COMPLETED",
          resource_id: "legacy-active-job",
        }),
      },
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    const markAdvanced = control.service.markAdvanced.bind(control.service);
    const interruptedAdvancement = vi
      .spyOn(control.service, "markAdvanced")
      .mockImplementation(async (intent, receipt) => {
        if (intent.action_id === terminalObservation.action_id)
          throw new Error("historical observation advancement interrupted");
        return markAdvanced(intent, receipt);
      });
    await expect(terminalObservationReconciler.tick()).rejects.toThrow(
      "historical observation advancement interrupted",
    );
    expect(
      (await control.projection.unadvancedActions()).map(
        ({ intent }) => intent.action_id,
      ),
    ).toContain(terminalObservation.action_id);
    interruptedAdvancement.mockRestore();
    await terminalObservationReconciler.tick();
    expect(
      (await control.projection.action(terminalObservation.action_id))?.observed_state,
    ).toBe("COMPLETED");
    expect(
      (await control.projection.task(legacy.run_id, unresolvedTask.task_id))?.task
        .terminal_outcome,
    ).toBeNull();
    const unselectedAttempt: AttemptReceipt = {
      schema_version: "v1",
      kind: "attempt.receipt",
      record_id: "attempt-receipt-legacy-unselected",
      created_at: "2026-08-16T00:01:03.000Z",
      actor: { subject: "migration", role: "migration" },
      run_id: legacy.run_id,
      task_id: unresolvedTask.task_id,
      attempt_id: "attempt-legacy-unselected",
      action_id: activeHistoricalLaunch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      evidence_digest: sha256("legacy-unselected-evidence"),
      evidence_path: "evidence/legacy-unselected",
      cost_microusd: 5,
      metrics: {},
    };
    await control.service.append(unselectedAttempt);
    const continuation = await control.service.continueHistoricalRun(
      legacy.run_id,
      { reason: "finish unresolved tasks", confirmed: true },
      "legacy-continuation",
      operator,
    );
    expect(continuation.adopted).toBe(false);
    expect(
      await control.service.continueHistoricalRun(
        legacy.run_id,
        { reason: "finish unresolved tasks", confirmed: true },
        "legacy-continuation",
        operator,
      ),
    ).toMatchObject({ adopted: true });
    const attached = await control.projection.runContinuation(legacy.run_id);
    expect(attached).toMatchObject({
      run_id: legacy.run_id,
      run_lock_digest: ControlService.recordDigest(legacy),
      reason: "finish unresolved tasks",
    });
    if (!attached) throw new Error("run continuation is missing");
    const repairedProfiles = control.profiles.map((item) => {
      if (item.profile.profile_kind !== "deployment") return item;
      const spec = {
        ...item.profile.spec,
        job_image:
          "example.invalid/repaired@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        worker_revision: "repaired-worker",
      };
      const profile: ProfileObject = {
        ...item.profile,
        record_id: deterministicId(
          "profile",
          item.profile.profile_kind,
          item.profile.name,
          sha256(canonicalJson(spec)),
        ),
        spec,
      };
      return { profile, profile_id: sha256(canonicalJson(profile)) };
    });
    const repairService = new ControlService(
      "test",
      control.store,
      control.projection,
      repairedProfiles,
    );
    await repairService.initialize(repairedProfiles);
    const repairResult = await repairService.repairHistoricalContinuation(
      legacy.run_id,
      { reason: "replace the broken historical worker", confirmed: true },
      "legacy-continuation-repair",
      operator,
    );
    expect(repairResult.adopted).toBe(false);
    const repair = await control.projection.runContinuationRepair(legacy.run_id);
    expect(repair).toMatchObject({
      record_id: repairResult.continuation_repair_id,
      run_continuation_id: attached.record_id,
      run_continuation_digest: sha256(canonicalJson(attached)),
      job_image:
        "example.invalid/repaired@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      worker_revision: "repaired-worker",
    });
    if (!repair) throw new Error("run continuation repair is missing");
    await expect(
      repairService.repairHistoricalContinuation(
        legacy.run_id,
        { reason: "replace the broken historical worker", confirmed: true },
        "legacy-continuation-repair",
        operator,
      ),
    ).resolves.toMatchObject({ adopted: true });
    const successorProfiles = repairedProfiles.map((item) => {
      if (item.profile.profile_kind !== "deployment") return item;
      const spec = {
        ...item.profile.spec,
        job_image:
          "example.invalid/successor@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        worker_revision: "successor-worker",
      };
      const profile: ProfileObject = {
        ...item.profile,
        record_id: deterministicId(
          "profile",
          item.profile.profile_kind,
          item.profile.name,
          sha256(canonicalJson(spec)),
        ),
        spec,
      };
      return { profile, profile_id: sha256(canonicalJson(profile)) };
    });
    const successorService = new ControlService(
      "test",
      control.store,
      control.projection,
      successorProfiles,
    );
    await successorService.initialize(successorProfiles);
    const successorResult =
      await successorService.repairHistoricalContinuationSuccessor(
        legacy.run_id,
        { reason: "replace the digest-defective repaired worker", confirmed: true },
        "legacy-continuation-repair-successor",
        operator,
      );
    expect(successorResult.adopted).toBe(false);
    const successor = await control.projection.runContinuationRepairSuccessor(
      legacy.run_id,
    );
    expect(successor).toMatchObject({
      record_id: successorResult.continuation_repair_successor_id,
      run_continuation_id: attached.record_id,
      run_continuation_digest: sha256(canonicalJson(attached)),
      run_continuation_repair_id: repair.record_id,
      run_continuation_repair_digest: sha256(canonicalJson(repair)),
      job_image:
        "example.invalid/successor@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      worker_revision: "successor-worker",
    });
    if (!successor) throw new Error("run continuation repair successor is missing");
    await expect(
      successorService.repairHistoricalContinuationSuccessor(
        legacy.run_id,
        { reason: "replace the digest-defective repaired worker", confirmed: true },
        "legacy-continuation-repair-successor",
        operator,
      ),
    ).resolves.toMatchObject({ adopted: true });
    await control.service.exhaustTask(
      unselectedAttempt,
      "historical attempt has no valid selection",
      1,
    );
    expect(
      (await control.projection.task(legacy.run_id, unresolvedTask.task_id))?.task,
    ).toMatchObject({
      terminal_outcome: "invalid",
      selected_attempt_id: null,
    });
    const failedUnpause = control.service.actionIntent(
      legacy.run_id,
      "run.resume",
      "run",
      1,
      { reason: "historical failed state was not paused" },
      { subject: "migration", role: "migration" },
      "2026-08-16T00:02:00.000Z",
    );
    await control.service.append(failedUnpause);
    const failedUnpauseReceipt = await control.service.receipt(failedUnpause, {
      outcome: "completed",
      observed_state: "running",
    });
    await control.service.markAdvanced(failedUnpause, failedUnpauseReceipt);
    expect(await control.projection.run(legacy.run_id)).toMatchObject({
      paused: false,
      status: "failed",
    });
    expect(() =>
      assertRunContinuationCompatible(legacy, {
        ...attached.execution,
        deployment: {
          ...attached.execution.deployment,
          trial_job_template: {
            ...attached.execution.deployment.trial_job_template,
            inference_upstream: "https://incompatible.example/v1",
          },
        },
      }),
    ).toThrow("continuation changes the locked deployment inference_upstream");
    await expect(
      control.service.uploadEvidenceObject(
        legacy.run_id,
        historicalLaunch.action_id,
        selectedTask.task_id,
        sha256("late historical evidence"),
        new TextEncoder().encode("late historical evidence"),
      ),
    ).rejects.toThrow("not bound to the execution continuation");
    await expect(
      control.service.runAction(
        legacy.run_id,
        {
          action: "retry_infrastructure",
          task_id: selectedTask.task_id,
          confirmed: true,
        },
        "legacy-retry",
        operator,
      ),
    ).rejects.toThrow("historical continuation cannot retry");
    const resumed = await control.service.runAction(
      legacy.run_id,
      { action: "resume", confirmed: true },
      "legacy-resume",
      operator,
    );
    const resume = await control.projection.action(resumed.action_id);
    const resumeIntent = JSON.parse(resume?.intent_body ?? "{}") as ActionIntent;
    expect(resumeIntent).toMatchObject({
      payload: { task_ids: [unresolvedTask.task_id] },
    });
    const resumedNoop = new NoopActions();
    let resumedLaunchCount = 0;
    const resumedExecute = vi.fn(
      async (intent: ActionIntent): Promise<ExternalActionResult> => {
        if (intent.action_kind !== "job.launch") return resumedNoop.execute(intent);
        resumedLaunchCount += 1;
        return resumedLaunchCount === 1
          ? { outcome: "failed", observed_state: "job-create-failed" }
          : {
              outcome: "completed",
              observed_state: "RUNNING",
              resource_id: "continued-job",
            };
      },
    );
    const resumedReconciler = new Reconciler(
      control.service,
      control.projection,
      { execute: resumedExecute },
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(resumedReconciler, 5);
    const resumedLaunches = resumedExecute.mock.calls
      .map(([intent]) => intent)
      .filter(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.task_id === unresolvedTask.task_id,
      );
    const resumedLaunch = resumedLaunches[0];
    expect(resumedLaunch?.payload).toMatchObject({
      job_image:
        "example.invalid/successor@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      worker_revision: "successor-worker",
      run_continuation_id: attached.record_id,
      run_continuation_repair_id: repair.record_id,
      run_continuation_repair_successor_id: successor.record_id,
    });
    expect(attached.execution.harness.harbor_agent).toEqual({
      import_path: "example.agent:Agent",
      kwargs: {},
    });
    expect(resumedLaunches.map((intent) => intent.generation)).toEqual([2, 3]);
    expect(await control.projection.run(legacy.run_id)).toMatchObject({
      paused: false,
      reserved_microusd: 100_012,
    });
    await expect(
      control.service.continueHistoricalRun(
        legacy.run_id,
        { reason: "finish unresolved tasks", confirmed: true },
        "legacy-continuation",
        operator,
      ),
    ).resolves.toMatchObject({ adopted: true });
    expect(
      (await control.projection.task(legacy.run_id, selectedTask.task_id))?.task,
    ).toMatchObject({
      terminal_outcome: "infrastructure",
      selected_attempt_id: selectedAttempt.attempt_id,
    });
    const repeatedLaunch = resumedLaunches[resumedLaunches.length - 1];
    if (!repeatedLaunch) throw new Error("continued Job launch is missing");
    const repeatedAttempt: AttemptReceipt = {
      ...unselectedAttempt,
      record_id: "attempt-receipt-legacy-repeated-exhaustion",
      created_at: new Date().toISOString(),
      attempt_id: "attempt-legacy-repeated-exhaustion",
      action_id: repeatedLaunch.action_id,
      outcome: "infrastructure",
      replacement_eligible: false,
      evidence_digest: sha256("legacy-repeated-exhaustion-evidence"),
      evidence_path: "evidence/legacy-repeated-exhaustion",
      cost_microusd: 1,
    };
    await control.service.append(repeatedAttempt);
    await control.service.exhaustTask(
      repeatedAttempt,
      "historical task exhausted again after repair",
      2,
    );
    expect(
      (await control.projection.task(legacy.run_id, unresolvedTask.task_id))?.task,
    ).toMatchObject({
      terminal_outcome: "invalid",
      selected_attempt_id: null,
    });
    const rebuilt = await Projection.open(
      join(control.root, "historical-continuation.sqlite"),
    );
    await rebuilt.rebuild(control.store);
    const restarted = new ControlService(
      "test",
      control.store,
      rebuilt,
      control.profiles,
    );
    await expect(restarted.initialize(control.profiles)).resolves.toBeUndefined();
    expect(await rebuilt.runLock(legacy.run_id)).toEqual(legacy);
    expect(
      (await rebuilt.task(legacy.run_id, selectedTask.task_id))?.task,
    ).toMatchObject({
      terminal_outcome: "infrastructure",
      selected_attempt_id: selectedAttempt.attempt_id,
    });
    expect(
      (await rebuilt.task(legacy.run_id, unresolvedTask.task_id))?.task,
    ).toMatchObject({
      terminal_outcome: "invalid",
      selected_attempt_id: null,
    });
    await expect(restarted.runExecution(legacy)).resolves.toMatchObject({
      contract_version: "v1",
      deployment: {
        job_image:
          "example.invalid/successor@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        worker_revision: "successor-worker",
      },
    });
    await rebuilt.close();

    const orphan = {
      ...attached,
      record_id: "continuation-orphan",
      run_id: "run-orphan",
    };
    await control.store.create(
      controlRecordPath(orphan),
      new TextEncoder().encode(canonicalJson(orphan)),
    );
    const invalid = await Projection.open(
      join(control.root, "invalid-continuation.sqlite"),
    );
    await expect(invalid.rebuild(control.store)).rejects.toThrow(
      "run continuation has no lock",
    );
    await invalid.close();
  });

  it("replaces the promoted namespace Job cap and start pacing", async () => {
    const control = await createTestControl();
    controls.push(control);
    control.service.configureCapacityProfile("current");
    await configureCapacity(control, { maximum: 2, hardwareMaximum: 2, burst: 1 });

    const first = await control.service.setMaxActiveJobs(8, "capacity-eight");
    expect(first.max_active_jobs).toBe(8);
    expect(first.start_burst).toBe(8);
    const selected = control.service.capacityProfile();
    expect(selected?.spec.max_active_jobs).toBe(8);
    expect(selected?.spec.start_burst).toBe(8);
    expect(selected?.spec.start_refill_tokens).toBe(8);
    expect(selected?.spec.hardware_limits).toEqual([
      { hardware: "cpu-basic", max_active_jobs: 8 },
    ]);
    expect(control.service.namespaceCapacityPolicy()).toMatchObject({
      alias: "current",
      configured: true,
      max_active_jobs: 8,
      start_burst: 8,
      profile_id: first.profile_id,
    });
    await expect(control.service.namespaceCapacityView()).resolves.toMatchObject({
      max_active_jobs: 8,
      active_jobs: 0,
      available_jobs: 8,
      queued_jobs: 0,
      observed_running_jobs: 0,
      observed_scheduling_jobs: 0,
      reserved_without_active_observation: 0,
      start_tokens: 8,
      runs: [],
      hardware: [
        {
          hardware: "cpu-basic",
          max_active_jobs: 8,
          active_jobs: 0,
          available_jobs: 8,
        },
      ],
    });

    const second = await control.service.setMaxActiveJobs(8, "capacity-eight");
    expect(second.profile_id).toBe(first.profile_id);
    const rebuilt = await Projection.open(
      `${control.root}/capacity-idempotency.sqlite`,
    );
    await rebuilt.rebuild(control.store);
    const restarted = new ControlService(
      "test",
      control.store,
      rebuilt,
      control.profiles,
    );
    restarted.configureCapacityProfile("current");
    await restarted.initialize(control.profiles);
    await expect(
      restarted.setMaxActiveJobs(8, "capacity-eight"),
    ).resolves.toMatchObject({ profile_id: first.profile_id });
    await expect(restarted.setMaxActiveJobs(7, "capacity-eight")).rejects.toThrow(
      "idempotency key already belongs to a different capacity policy request",
    );
    await rebuilt.close();
    await expect(control.service.setMaxActiveJobs(0, "capacity-zero")).rejects.toThrow(
      "namespace Job cap must be an integer from 1 to 1024",
    );
  });

  it("rebuilds after lowering a partly used start burst", async () => {
    const control = await createTestControl();
    controls.push(control);
    await configureCapacity(control, {
      maximum: 8,
      hardwareMaximum: 8,
      burst: 8,
    });
    const result = await control.service.submit(
      { ...submission, start_paused: true },
      "lower-capacity-run",
      operator,
    );
    const first = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        hardware: "cpu-basic",
        max_jobs: 1,
      },
    );
    await expect(control.service.admitJobLaunch(first)).resolves.toMatchObject({
      status: "admitted",
    });
    const failed = await control.service.receipt(first, {
      outcome: "failed",
      observed_state: "create-failed",
    });
    await control.service.markAdvanced(first, failed);

    const lowered = await control.service.setMaxActiveJobs(1, "lower-capacity-to-one");
    const second = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      1,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        hardware: "cpu-basic",
        max_jobs: 1,
      },
    );
    await expect(control.service.admitJobLaunch(second)).resolves.toMatchObject({
      status: "admitted",
    });
    expect(await control.projection.jobAdmission(second.action_id)).toMatchObject({
      capacity_profile_id: lowered.profile_id,
      tokens_remaining: 0,
    });
    await expect(control.service.namespaceCapacityView()).resolves.toMatchObject({
      active_jobs: 1,
      available_jobs: 0,
      reserved_without_active_observation: 1,
      runs: [
        {
          run_id: result.run_id,
          max_active_jobs: 1,
          active_jobs: 1,
          available_jobs: 0,
        },
      ],
    });
    const resourceId = "job-capacity-observation";
    await control.service.receipt(second, {
      outcome: "created",
      observed_state: "SCHEDULING",
      resource_id: resourceId,
    });
    const observation = control.service.actionIntent(
      result.run_id,
      "job.observe",
      resourceId,
      0,
      {
        resource_id: resourceId,
        launch_action_id: second.action_id,
      },
      second.actor,
      new Date(Date.parse(second.created_at) + 1).toISOString(),
    );
    await control.service.writeAction(observation);
    await control.service.receipt(observation, {
      outcome: "completed",
      observed_state: "RUNNING",
      resource_id: resourceId,
    });
    await expect(control.service.namespaceCapacityView()).resolves.toMatchObject({
      observed_running_jobs: 1,
      observed_scheduling_jobs: 0,
      reserved_without_active_observation: 0,
    });

    const rebuilt = await Projection.open(`${control.root}/lower-capacity.sqlite`);
    await expect(rebuilt.rebuild(control.store)).resolves.toBeUndefined();
    expect(await rebuilt.jobAdmission(second.action_id)).toMatchObject({
      capacity_profile_id: lowered.profile_id,
      tokens_remaining: 0,
    });
    await rebuilt.close();
  });

  it("counts an active Job by its latest observed state", async () => {
    const control = await createTestControl();
    controls.push(control);
    await configureCapacity(control, {
      maximum: 1,
      hardwareMaximum: 1,
      burst: 1,
    });
    const run = await control.service.submit(
      { ...submission, start_paused: true },
      "active-job-latest-observation",
      operator,
    );
    const resourceId = "job-latest-active-observation";
    const launch = control.service.actionIntent(
      run.run_id,
      "job.launch",
      "task-001",
      0,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        hardware: "cpu-basic",
        max_jobs: 1,
      },
      undefined,
      "2026-08-22T01:00:00.000Z",
    );
    await expect(control.service.admitJobLaunch(launch)).resolves.toMatchObject({
      status: "admitted",
    });
    const launchReceipt = await control.service.receipt(launch, {
      outcome: "created",
      observed_state: "SCHEDULING",
      resource_id: resourceId,
    });
    await control.service.markAdvanced(launch, launchReceipt);

    const observation = control.service.actionIntent(
      run.run_id,
      "job.observe",
      resourceId,
      0,
      {
        resource_id: resourceId,
        launch_action_id: launch.action_id,
      },
      undefined,
      "2026-08-22T01:00:10.000Z",
    );
    await control.service.writeAction(observation);
    const observationReceipt = await control.service.receipt(observation, {
      outcome: "completed",
      observed_state: "RUNNING",
      resource_id: resourceId,
    });
    await control.service.markAdvanced(observation, observationReceipt);

    expect(await control.projection.jobs()).toMatchObject([
      {
        action_id: observation.action_id,
        launch_action_id: launch.action_id,
        observed_state: "RUNNING",
      },
    ]);
    expect(await control.projection.activeJobObservedStateCounts("test")).toEqual({
      RUNNING: 1,
    });
    await expect(control.service.namespaceCapacityView()).resolves.toMatchObject({
      active_jobs: 1,
      observed_running_jobs: 1,
      observed_scheduling_jobs: 0,
      reserved_without_active_observation: 0,
    });
  });

  it("applies provider request reservations per Run", async () => {
    const control = await createTestControl();
    controls.push(control);
    await configureCapacity(control, {
      maximum: 3,
      hardwareMaximum: 3,
      burst: 3,
    });
    const firstRun = await control.service.submit(
      { ...submission, start_paused: true },
      "provider-capacity-first-run",
      operator,
    );
    const secondRun = await control.service.submit(
      { ...submission, start_paused: true },
      "provider-capacity-second-run",
      operator,
    );
    const launch = (runId: string, generation: number) =>
      control.service.actionIntent(runId, "job.launch", "task-001", generation, {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        hardware: "cpu-basic",
        max_jobs: 3,
        inference_upstream: "https://router.huggingface.co/v1",
        inference_max_total_concurrency: 1,
      });
    const first = launch(firstRun.run_id, 0);
    const second = launch(secondRun.run_id, 0);
    const sameRun = launch(firstRun.run_id, 1);

    await expect(control.service.admitJobLaunch(first)).resolves.toMatchObject({
      status: "admitted",
    });
    await expect(
      control.projection.jobAdmission(first.action_id),
    ).resolves.toMatchObject({
      reserved_provider_requests: 1,
    });
    await expect(control.service.admitJobLaunch(second)).resolves.toMatchObject({
      status: "admitted",
    });
    await expect(control.service.admitJobLaunch(sameRun)).resolves.toMatchObject({
      status: "deferred",
      limiting_factor: "provider_request_capacity",
    });
  });

  it("derives provider reservations for active historical grants", async () => {
    const control = await createTestControl();
    controls.push(control);
    await configureCapacity(control);
    const capacity = control.service.capacityProfile();
    if (!capacity) throw new Error("capacity profile is missing");
    const run = await control.service.submit(
      { ...submission, start_paused: true },
      "historical-provider-capacity-run",
      operator,
    );
    const intent = control.service.actionIntent(
      run.run_id,
      "job.launch",
      "task-001",
      0,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        hardware: "cpu-basic",
        max_jobs: 4,
        inference_upstream: "https://router.huggingface.co/v1",
        inference_max_concurrency: 4,
      },
    );
    await control.service.writeAction(intent);
    const grant: JobAdmissionGrant = {
      schema_version: "v1",
      kind: "job.admission",
      record_id: deterministicId("job-admission", intent.action_id),
      created_at: "2026-08-22T00:00:00.000Z",
      actor: { subject: "test", role: "service" },
      action_id: intent.action_id,
      run_id: run.run_id,
      namespace: "test",
      capacity_profile_id: capacity.profile_id,
      hardware: "cpu-basic",
      tokens_remaining: 1,
      refill_cursor_at: "2026-08-22T00:00:00.000Z",
      previous_grant_id: null,
    };
    await control.service.append(grant);

    await expect(control.projection.activeJobAdmissions("test")).resolves.toEqual([
      expect.objectContaining({
        action_id: intent.action_id,
        reserved_provider_requests: 4,
      }),
    ]);
  });

  it("adopts idempotent submissions and completes a control smoke run", async () => {
    const control = await createTestControl();
    controls.push(control);
    const [first, second] = await Promise.all([
      control.service.submit(submission, "same-request-key", operator),
      control.service.submit(submission, "same-request-key", operator),
    ]);
    expect(first.run_id).toMatch(
      /^run-control-smoke-control-smoke-off-none-[a-f0-9]{12}$/,
    );
    expect(second).toMatchObject({ run_id: first.run_id, adopted: true });
    const runLock = await control.projection.runLock(first.run_id);
    expect(runLock).toMatchObject({
      execution: {
        contract_version: "v1",
        source_profiles: {
          model: { name: "control-smoke" },
          harness: { name: "control-smoke" },
          deployment: { name: "hf-cpu-smoke" },
        },
        deployment: {
          job_image:
            "example.invalid/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    });
    const publisher = new ResultPublisher(
      control.store,
      control.projection,
      control.service,
    );
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      publisher,
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    const list = control.store.list.bind(control.store);
    const catalogReads = vi
      .spyOn(control.store, "list")
      .mockImplementation(async (prefix) => {
        if (prefix === "results/schema=v1/catalog/records/")
          throw new Error("diagnostic publication read leaderboard catalogs");
        return list(prefix);
      });
    await settle(reconciler);
    expect(catalogReads).not.toHaveBeenCalledWith("results/schema=v1/catalog/records/");
    expect(await control.projection.run(first.run_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 1,
      successful_tasks: 1,
      total_tasks: 1,
      publication_status: "published",
      pending_actions: 0,
    });
    const resultObjects = await control.store.list("results/schema=v1");
    expect(resultObjects.some((entry) => entry.key.endsWith(".parquet"))).toBe(true);
    const catalogObject = resultObjects.find((entry) =>
      entry.key.includes("/catalog/records/"),
    );
    if (!catalogObject) throw new Error("result catalog object is missing");
    const catalog = JSON.parse(
      new TextDecoder().decode(await control.store.read(catalogObject.key)),
    );
    expect(catalog.entries[0]).toMatchObject({
      benchmark: "control-smoke",
      model: "control-smoke",
      harness: "control-smoke",
      inference_provider: "hf-cpu-smoke",
      publication_role: "diagnostic",
      run_outcome: "complete",
      strict_pass_count: null,
    });
  });

  it("launches an admitted Job batch concurrently", async () => {
    const control = await createTestControl(2);
    controls.push(control);
    await control.service.submit(submission, "concurrent-job-launch-key", operator);
    const noop = new NoopActions();
    let activeLaunches = 0;
    let maxActiveLaunches = 0;
    const external: ExternalActionPort = {
      execute: async (
        intent: ActionIntent,
        context?: ExternalActionContext,
      ): Promise<ExternalActionResult> => {
        if (intent.action_kind !== "job.launch") return noop.execute(intent, context);
        activeLaunches += 1;
        maxActiveLaunches = Math.max(maxActiveLaunches, activeLaunches);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: `job-${intent.target}`,
          };
        } finally {
          activeLaunches -= 1;
        }
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );

    await reconciler.tick();
    await reconciler.tick();

    expect(maxActiveLaunches).toBe(2);
  });

  it("keeps an idempotency key bound to the first run even when the combo slug would change", async () => {
    const control = await createTestControl();
    controls.push(control);
    const first = await control.service.submit(submission, "shared-run-key", operator);
    await expect(
      control.service.submit(
        { ...submission, harness: "opencode" },
        "shared-run-key",
        operator,
      ),
    ).rejects.toThrow("idempotency key already belongs to a different run request");
    expect(first.run_id).toMatch(/^run-control-smoke-control-smoke-off-none-/);
    expect(await control.projection.runs()).toHaveLength(1);
  });

  it("rejects a run ceiling below its launch reservation", async () => {
    const control = await createTestControl(1, 1, 50);
    controls.push(control);

    await expect(
      control.service.submit(
        { ...submission, ceiling_microusd: 49 },
        "infeasible-reservation-key",
        operator,
      ),
    ).rejects.toThrow("launch reservation exceeds the run ceiling");
    expect(await control.projection.runs()).toEqual([]);
    expect(await control.projection.pendingActions()).toEqual([]);
  });

  it("enforces the immutable launch-policy run ceiling before durable state", async () => {
    const control = await createTestControl(1, 1, 0, true, "forbidden", 100);
    controls.push(control);

    const lower = await control.service.submit(
      { ...submission, ceiling_microusd: 80 },
      "profile-ceiling-lower-key",
      operator,
    );
    const lowerLock = await control.projection.runLock(lower.run_id);
    expect(lowerLock).toMatchObject({ ceiling_microusd: 80 });
    expect(
      lowerLock?.profiles.find((profile) => profile.kind === "launch_policy")?.spec,
    ).toMatchObject({ max_run_ceiling_microusd: 100 });
    expect(
      await control.service.submit(
        { ...submission, ceiling_microusd: 80 },
        "profile-ceiling-lower-key",
        operator,
      ),
    ).toMatchObject({ run_id: lower.run_id, adopted: true });

    const exact = await control.service.submit(
      { ...submission, ceiling_microusd: 100 },
      "profile-ceiling-exact-key",
      operator,
    );
    expect(await control.projection.runLock(exact.run_id)).toMatchObject({
      ceiling_microusd: 100,
    });

    const overKey = "profile-ceiling-over-key";
    const overRunId = runIdentity({
      model: "control-smoke",
      harness: "control-smoke",
      reasoning: "off",
      runtime: "none",
      unique: runUnique("test", operator.subject, sha256(overKey)),
    });
    await expect(
      control.service.submit(
        { ...submission, ceiling_microusd: 101 },
        overKey,
        operator,
      ),
    ).rejects.toThrow("run ceiling exceeds the launch policy maximum");
    expect(await control.projection.runRequest(overRunId)).toBeNull();
    expect(await control.projection.runLock(overRunId)).toBeNull();
    expect(await control.projection.runActions(overRunId)).toEqual([]);

    const corrected = await control.service.submit(
      { ...submission, ceiling_microusd: 100 },
      overKey,
      operator,
    );
    expect(corrected.run_id).toBe(overRunId);
    expect(await control.projection.runLock(overRunId)).toMatchObject({
      ceiling_microusd: 100,
    });
  });

  it("recovers action advancement after a receipt-only crash", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "action-advancement-recovery-key",
      operator,
    );
    const admissionRow = await control.projection.action(result.action_id);
    if (!admissionRow) throw new Error("admission action is missing");
    const admission = JSON.parse(admissionRow.intent_body) as ActionIntent;
    await control.service.receipt(admission, {
      outcome: "completed",
      observed_state: "admitted",
    });
    expect(await control.projection.unadvancedActions()).toHaveLength(1);
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler);
    expect(await control.projection.unadvancedActions()).toHaveLength(0);
    const initialLaunch = (await control.projection.actions(100)).find(
      (action) => action.action_kind === "job.launch",
    );
    if (!initialLaunch) throw new Error("initial Job launch is missing");
    const launchPayload = JSON.parse(initialLaunch.intent_body).payload;
    expect(launchPayload).toMatchObject({
      trusted_worker: true,
    });
    expect(launchPayload).not.toHaveProperty("requires_hf_token");
    expect(launchPayload).not.toHaveProperty("mount_bucket");
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 1,
      publication_status: "published",
    });
  });

  it("launches preparation before recovering historical advancement", async () => {
    const control = await createTestControl();
    controls.push(control);
    const historical = await control.service.submit(
      submission,
      "historical-advancement-key",
      operator,
    );
    const historicalRow = await control.projection.action(historical.action_id);
    if (!historicalRow) throw new Error("historical admission action is missing");
    const historicalIntent = JSON.parse(historicalRow.intent_body) as ActionIntent;
    await control.service.receipt(historicalIntent, {
      outcome: "completed",
      observed_state: "admitted",
    });
    const current = await control.service.submit(
      submission,
      "current-admission-key",
      operator,
    );
    await control.service.writeAction(
      control.service.actionIntent(current.run_id, "job.launch", "run-preparation", 0, {
        worker_role: "preparation",
        task_ids: ["task-001"],
        hardware: "cpu-basic",
        max_jobs: 1,
        reservation_microusd: 0,
      }),
    );
    const markAdvanced = control.service.markAdvanced.bind(control.service);
    vi.spyOn(control.service, "markAdvanced").mockImplementation(
      async (intent, receipt) => {
        if (intent.action_id === historical.action_id)
          throw new Error("historical advancement failed");
        return markAdvanced(intent, receipt);
      },
    );
    const external = new NoopActions();
    const execute = vi.spyOn(external, "execute");
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );

    await expect(reconciler.tick()).rejects.toThrow("historical advancement failed");

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action_kind: "job.launch",
        run_id: current.run_id,
        target: "run-preparation",
      }),
      { adoption_only: true },
    );
    const launches = (await control.projection.runActions(current.run_id)).filter(
      (action) => action.action_kind === "job.launch",
    );
    const preparationLaunch = launches.find(
      (action) =>
        (JSON.parse(action.intent_body) as ActionIntent).target === "run-preparation",
    );
    expect(preparationLaunch?.receipt_body).not.toBeNull();
  });

  it("continues observations after a Job launch transport failure", async () => {
    const control = await createTestControl();
    controls.push(control);
    await configureCapacity(control);
    const first = await control.service.submit(
      submission,
      "launch-failure-first",
      operator,
    );
    const second = await control.service.submit(
      submission,
      "launch-failure-second",
      operator,
    );
    const observedRuns: string[] = [];
    const noop = new NoopActions();
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch") {
          if (intent.run_id === first.run_id)
            throw new TypeError("transient launch failure");
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: `job-${intent.run_id}`,
          };
        }
        if (intent.action_kind === "job.observe")
          throw new Error("individual Job observation was not expected");
        return noop.execute(intent);
      },
      observeJobs: async (intents): Promise<readonly ExternalActionResult[]> =>
        intents.map((intent) => {
          observedRuns.push(intent.run_id);
          return {
            outcome: "completed",
            observed_state: "COMPLETED",
            resource_id: intent.target,
          };
        }),
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await reconciler.tick();

    await expect(reconciler.tick()).rejects.toThrow("transient launch failure");

    expect(observedRuns).toContain(second.run_id);
    expect(
      (await control.projection.runActions(second.run_id)).find(
        (action) =>
          action.action_kind === "job.observe" && action.observed_state === "COMPLETED",
      ),
    ).toBeDefined();
  });

  it("reports the per-Run Job limit as the capacity constraint", async () => {
    const control = await createTestControl(2);
    controls.push(control);
    await configureCapacity(control, {
      maximum: 4,
      hardwareMaximum: 4,
      burst: 4,
    });
    const run = await control.service.submit(
      submission,
      "run-capacity-limiting-factor",
      operator,
    );
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await reconciler.tick();
    const launches = (await control.projection.pendingActions()).filter(
      (intent) => intent.action_kind === "job.launch",
    );
    const admissionStatuses: string[] = [];
    for (const launch of launches)
      admissionStatuses.push((await control.service.admitJobLaunch(launch)).status);
    expect(admissionStatuses).toEqual(["admitted", "deferred"]);

    await expect(control.service.jobCapacityView(run.run_id)).resolves.toMatchObject({
      run_active: 1,
      run_limit: 1,
      limiting_factor: "run_job_capacity",
    });
  });

  it("copies locked direct-inference route identity into the worker launch", async () => {
    const control = await createTestControl(1, 1, 0, true, "required");
    controls.push(control);
    await control.service.submit(submission, "inference-worker-launch-key", operator);
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler);
    const launch = (await control.projection.actions(100)).find(
      (action) => action.action_kind === "job.launch",
    );
    if (!launch) throw new Error("inference Job launch is missing");
    expect(JSON.parse(launch.intent_body).payload).toMatchObject({
      inference_upstream: "https://router.huggingface.co/v1",
      inference_model: "example/model:provider",
      inference_api: "chat-completions",
    });
  });

  it("repairs deterministic submission records after partial writes", async () => {
    const source = await createTestControl();
    controls.push(source);
    const key = "partial-submission-key";
    const submitted = await source.service.submit(submission, key, operator);
    const request = await source.projection.runRequest(submitted.run_id);
    const lock = await source.projection.runLock(submitted.run_id);
    if (!request || !lock) throw new Error("source submission records are missing");

    for (const partial of [request, lock]) {
      const control = await createTestControl();
      controls.push(control);
      await control.service.append(partial);
      const path = controlRecordPath(partial);
      const before = await control.projection.objectDigest(path);
      const recovered = await control.service.submit(submission, key, operator);
      expect(recovered).toMatchObject({
        run_id: submitted.run_id,
        adopted: true,
      });
      expect(await control.projection.objectDigest(path)).toBe(before);
      expect(await control.projection.runRequest(submitted.run_id)).not.toBeNull();
      expect(await control.projection.runLock(submitted.run_id)).not.toBeNull();
      expect(await control.projection.action(recovered.action_id)).not.toBeNull();
    }
  });

  it.each([
    ["completed successfully", true, "STOPPED"],
    ["errored", false, "ERROR"],
  ] as const)(
    "target-syncs a durable worker receipt after a Job that %s",
    async (_label, successWithoutWorkerReceipt, terminalState) => {
      const control = await createTestControl();
      controls.push(control);
      const result = await control.service.submit(
        submission,
        "missed-worker-callback-key",
        operator,
      );
      const admissionRow = await control.projection.action(result.action_id);
      if (!admissionRow) throw new Error("admission action is missing");
      const admission = JSON.parse(admissionRow.intent_body) as ActionIntent;
      const admissionReceipt = await control.service.receipt(admission, {
        outcome: "completed",
        observed_state: "admitted",
      });
      await control.service.markAdvanced(admission, admissionReceipt);
      const launch = control.service.actionIntent(
        result.run_id,
        "job.launch",
        "task-001",
        0,
        {
          task_id: "task-001",
          task_ids: ["task-001"],
          max_infrastructure_attempts: 1,
          success_without_worker_receipt: successWithoutWorkerReceipt,
        },
      );
      await control.service.writeAction(launch);
      const launchReceipt = await control.service.receipt(launch, {
        outcome: "created",
        observed_state: "RUNNING",
        resource_id: "job-one",
      });
      await control.service.markAdvanced(launch, launchReceipt);
      await control.service.writeAction(
        control.service.actionIntent(result.run_id, "job.observe", "job-one", 0, {
          ...launch.payload,
          resource_id: "job-one",
          launch_action_id: launch.action_id,
          not_before: "2026-08-16T00:00:00.000Z",
        }),
      );
      const evidence = await putWorkerEvidence(
        control,
        result.run_id,
        launch.action_id,
        "task-001",
        "missed-callback-evidence",
      );
      const attempt: AttemptReceipt = {
        schema_version: "v1",
        kind: "attempt.receipt",
        record_id: deterministicId("attempt-receipt", "missed-callback-attempt"),
        created_at: "2026-08-16T00:00:01.000Z",
        actor: { subject: "trusted-worker", role: "service" },
        run_id: result.run_id,
        task_id: "task-001",
        attempt_id: "missed-callback-attempt",
        action_id: launch.action_id,
        outcome: "complete",
        replacement_eligible: false,
        ...evidence,
        cost_microusd: 0,
        metrics: { reward: 1 },
      };
      await control.store.create(
        controlRecordPath(attempt),
        new TextEncoder().encode(canonicalJson(attempt)),
      );
      expect(await control.projection.attemptById(attempt.attempt_id)).toBeNull();
      const external: ExternalActionPort = {
        execute: async (intent): Promise<ExternalActionResult> =>
          intent.action_kind === "job.observe"
            ? {
                outcome: "completed",
                observed_state: terminalState,
                resource_id: "job-one",
              }
            : new NoopActions().execute(intent),
      };
      const syncProjection = vi.spyOn(control.service, "syncProjection");
      const reconciler = new Reconciler(
        control.service,
        control.projection,
        external,
        new ResultPublisher(control.store, control.projection, control.service),
        {
          interval_ms: 100,
          sync_interval_ms: 60_000,
          observation_interval_ms: 0,
          worker_receipt_grace_ms: 0,
          batch_size: 16,
        },
      );
      await settle(reconciler);
      expect(syncProjection).toHaveBeenCalledWith(
        `control/schema=v1/runs/${result.run_id}/tasks`,
      );
      expect(syncProjection).not.toHaveBeenCalledWith();
      expect(await control.projection.runAttempts(result.run_id)).toMatchObject([
        { attempt_id: attempt.attempt_id, outcome: "complete" },
      ]);
      expect(await control.projection.run(result.run_id)).toMatchObject({
        status: "completed",
        terminal_tasks: 1,
        publication_status: "published",
      });
    },
  );

  it("adopts durable action records while a projection catches up", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "durable-action-adoption-key",
      operator,
    );
    const first = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "durable-action-adoption",
      0,
      {
        task_id: "task-001",
        task_ids: ["task-001"],
        max_infrastructure_attempts: 1,
        success_without_worker_receipt: false,
      },
      undefined,
      "2026-08-16T00:00:01.000Z",
    );
    await control.service.writeAction(first);

    const laggingProjection = await Projection.open(
      join(control.root, "lagging-projection.sqlite"),
    );
    await laggingProjection.rebuild(control.store);
    const laggingService = new ControlService(
      "test",
      control.store,
      laggingProjection,
      control.profiles,
    );
    const retry = laggingService.actionIntent(
      result.run_id,
      "job.launch",
      "durable-action-adoption",
      0,
      first.payload,
      undefined,
      "2026-08-16T00:00:02.000Z",
    );
    const originalDispatch = await control.service.dispatchAction(
      first,
      "2026-08-16T00:00:31.000Z",
    );
    const adoptedDispatch = await laggingService.dispatchAction(
      retry,
      "2026-08-16T00:00:32.000Z",
    );
    expect(adoptedDispatch).toEqual({
      record: originalDispatch.record,
      created: false,
    });

    const originalReceipt = await control.service.receipt(first, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: "job-durable-action-adoption",
    });
    const adoptedReceipt = await laggingService.receipt(retry, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: "job-durable-action-adoption",
    });
    expect(adoptedReceipt).toEqual(originalReceipt);

    const originalAdvanced = await control.service.markAdvanced(first, originalReceipt);
    const adoptedAdvanced = await laggingService.markAdvanced(retry, adoptedReceipt);
    expect(adoptedAdvanced).toEqual(originalAdvanced);

    const emptyProjection = await Projection.open(
      join(control.root, "empty-projection.sqlite"),
    );
    const emptyService = new ControlService(
      "test",
      control.store,
      emptyProjection,
      control.profiles,
    );
    await expect(emptyService.writeAction(retry)).resolves.toBeUndefined();
    expect(await emptyProjection.action(first.action_id)).not.toBeNull();

    await emptyProjection.close();
    await laggingProjection.close();
  });

  it("rebuilds the same projection from immutable objects", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "rebuild-request-key",
      operator,
    );
    const before = await control.projection.run(result.run_id);
    const rebuilt = await Projection.open(`${control.root}/rebuilt.sqlite`);
    await rebuilt.rebuild(control.store);
    expect(await rebuilt.run(result.run_id)).toEqual(before);
    await rebuilt.close();
  });

  it("does not launch queued physical work after cancellation", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "cancel-before-launch-key",
      operator,
    );
    const execute = vi.fn(async (intent: ActionIntent) =>
      new NoopActions().execute(intent),
    );
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      { execute },
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await reconciler.tick();
    expect(
      (await control.projection.actions()).some(
        (action) => action.action_kind === "job.launch",
      ),
    ).toBe(true);
    const cancellation = await control.service.runAction(
      result.run_id,
      { action: "cancel", confirmed: true },
      "cancel-action-key",
      operator,
    );
    await settle(reconciler);
    expect(
      execute.mock.calls.some(([intent]) => intent.action_kind === "job.launch"),
    ).toBe(false);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "cancelled",
      terminal_tasks: 1,
      publication_status: null,
    });
    const repeated = await control.service.runAction(
      result.run_id,
      { action: "cancel", confirmed: true },
      "cancel-action-key",
      operator,
    );
    expect(repeated).toMatchObject({
      action_id: cancellation.action_id,
      adopted: true,
    });
    expect(
      (await control.projection.action(repeated.action_id))?.receipt_body,
    ).not.toBeNull();
    await expect(
      control.service.runAction(
        result.run_id,
        { action: "cancel", task_id: "task-001", confirmed: true },
        "cancel-action-key",
        operator,
      ),
    ).rejects.toThrow("idempotency key belongs to a different cancel action");
    await expect(
      control.service.runAction(
        result.run_id,
        { action: "pause", confirmed: true },
        "cancel-action-key",
        operator,
      ),
    ).rejects.toThrow("idempotency key belongs to a different pause action");
  });

  it("does not let suppressed launches block launchable work in the same batch", async () => {
    const control = await createTestControl();
    controls.push(control);
    await configureCapacity(control);
    const cancelledRun = await control.service.submit(
      submission,
      "concurrent-suppression-cancelled",
      operator,
    );
    const activeRun = await control.service.submit(
      submission,
      "concurrent-suppression-active",
      operator,
    );
    const delayedRun = await control.service.submit(
      submission,
      "concurrent-suppression-delayed",
      operator,
    );
    let activeLaunchStarted: (() => void) | undefined;
    const activeLaunch = new Promise<void>((resolve) => {
      activeLaunchStarted = resolve;
    });
    const noop = new NoopActions();
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch" && intent.run_id === activeRun.run_id) {
          activeLaunchStarted?.();
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: "job-active-concurrent-suppression",
          };
        }
        return noop.execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await reconciler.tick();
    await control.service.runAction(
      cancelledRun.run_id,
      { action: "cancel", confirmed: true },
      "concurrent-suppression-cancel",
      operator,
    );
    const originalReceipt = control.service.receipt.bind(control.service);
    let cancellationReceiptStarted: (() => void) | undefined;
    const cancellationReceipt = new Promise<void>((resolve) => {
      cancellationReceiptStarted = resolve;
    });
    let releaseCancellationReceipt: (() => void) | undefined;
    const cancellationReceiptRelease = new Promise<void>((resolve) => {
      releaseCancellationReceipt = resolve;
    });
    const originalAdmission = control.service.admitJobLaunch.bind(control.service);
    let delayedAdmissionStarted: (() => void) | undefined;
    const delayedAdmission = new Promise<void>((resolve) => {
      delayedAdmissionStarted = resolve;
    });
    let releaseDelayedAdmission: (() => void) | undefined;
    const delayedAdmissionRelease = new Promise<void>((resolve) => {
      releaseDelayedAdmission = resolve;
    });
    vi.spyOn(control.service, "admitJobLaunch").mockImplementation(async (intent) => {
      if (intent.run_id === delayedRun.run_id) {
        delayedAdmissionStarted?.();
        await delayedAdmissionRelease;
      }
      return originalAdmission(intent);
    });
    vi.spyOn(control.service, "receipt").mockImplementation(async (intent, result) => {
      if (
        intent.action_kind === "job.launch" &&
        intent.run_id === cancelledRun.run_id
      ) {
        cancellationReceiptStarted?.();
        await cancellationReceiptRelease;
      }
      return originalReceipt(intent, result);
    });

    const tick = reconciler.tick();
    await cancellationReceipt;
    await delayedAdmission;
    await activeLaunch;
    releaseCancellationReceipt?.();
    releaseDelayedAdmission?.();
    await tick;

    expect(
      (await control.projection.runActions(cancelledRun.run_id)).find(
        (action) =>
          action.action_kind === "job.launch" &&
          action.observed_state === "suppressed-cancelled",
      ),
    ).toBeDefined();
  });

  it("probes colliding Run action generations without merging idempotency keys", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "action-generation-collision-run",
      operator,
    );
    const firstKey = "action-key-1049";
    const secondKey = "action-key-1854";
    expect(Number.parseInt(sha256(firstKey).slice(-8), 16) % 1_000_001).toBe(
      Number.parseInt(sha256(secondKey).slice(-8), 16) % 1_000_001,
    );
    const request = { action: "cancel", confirmed: true } as const;

    const first = await control.service.runAction(
      result.run_id,
      request,
      firstKey,
      operator,
    );
    const second = await control.service.runAction(
      result.run_id,
      request,
      secondKey,
      operator,
    );

    expect(second.action_id).not.toBe(first.action_id);
    const firstIntent = JSON.parse(
      (await control.projection.action(first.action_id))?.intent_body ?? "{}",
    ) as ActionIntent;
    const secondIntent = JSON.parse(
      (await control.projection.action(second.action_id))?.intent_body ?? "{}",
    ) as ActionIntent;
    expect(firstIntent.generation).not.toBe(secondIntent.generation);
    expect(firstIntent.payload.idempotency_key_digest).toBe(sha256(firstKey));
    expect(secondIntent.payload.idempotency_key_digest).toBe(sha256(secondKey));
    await expect(
      control.service.runAction(result.run_id, request, firstKey, operator),
    ).resolves.toMatchObject({ action_id: first.action_id, adopted: true });
    await expect(
      control.service.runAction(result.run_id, request, secondKey, operator),
    ).resolves.toMatchObject({ action_id: second.action_id, adopted: true });
  });

  it("suppresses only a cancelled task before Job admission", async () => {
    const control = await createTestControl(2, 1, 6);
    controls.push(control);
    await configureCapacity(control, {
      maximum: 1,
      hardwareMaximum: 1,
      burst: 2,
    });
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12 },
      "task-cancel-before-admission",
      operator,
    );
    const launchedTasks: string[] = [];
    const noop = new NoopActions();
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch")
          launchedTasks.push(String(intent.payload.task_id));
        return noop.execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await reconciler.tick();
    await control.service.runAction(
      result.run_id,
      { action: "cancel", task_id: "task-001", confirmed: true },
      "cancel-queued-task",
      operator,
    );

    await settle(reconciler, 12);

    expect(launchedTasks).toEqual(["task-002"]);
    expect(
      (await control.projection.task(result.run_id, "task-001"))?.task,
    ).toMatchObject({ terminal_outcome: "cancelled" });
    expect(
      (await control.projection.task(result.run_id, "task-002"))?.task,
    ).toMatchObject({ terminal_outcome: "complete" });
    const suppressed = (await control.projection.runActions(result.run_id)).find(
      (action) =>
        action.action_kind === "job.launch" &&
        action.target === "task-001" &&
        action.observed_state === "suppressed-cancelled",
    );
    expect(suppressed).toMatchObject({ outcome: "completed" });
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 0,
      terminal_tasks: 2,
      publication_status: null,
    });
  });

  it("cancels active remote Jobs before sealing a cancelled run", async () => {
    const control = await createTestControl(1, 1, 6);
    controls.push(control);
    await configureCapacity(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 6 },
      "cancel-active-job-key",
      operator,
    );
    let cancelled = false;
    const observedKinds: string[] = [];
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        observedKinds.push(intent.action_kind);
        if (intent.action_kind === "job.launch")
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: "job-active-one",
          };
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: cancelled ? "CANCELED" : "RUNNING",
            resource_id: "job-active-one",
          };
        if (intent.action_kind === "job.cancel") {
          cancelled = true;
          return {
            outcome: "completed",
            observed_state: "CANCELED",
            resource_id: "job-active-one",
          };
        }
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await reconciler.tick();
    await reconciler.tick();
    expect(observedKinds.filter((kind) => kind === "job.launch")).toHaveLength(1);
    await control.service.runAction(
      result.run_id,
      { action: "cancel", confirmed: true },
      "cancel-active-job-action",
      operator,
    );
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "cancelling",
      terminal_tasks: 0,
    });
    const rebuilt = await Projection.open(`${control.root}/cancelling-rebuilt.sqlite`);
    await rebuilt.rebuild(control.store);
    expect(await rebuilt.run(result.run_id)).toMatchObject({
      status: "cancelling",
      terminal_tasks: 0,
    });
    expect((await rebuilt.activeRuns()).map((run) => run.run_id)).toContain(
      result.run_id,
    );
    const restartedService = new ControlService(
      "test",
      control.store,
      rebuilt,
      control.profiles,
    );
    const restarted = new Reconciler(
      restartedService,
      rebuilt,
      external,
      new ResultPublisher(control.store, rebuilt, restartedService),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(restarted, 15);
    expect(observedKinds).toContain("job.cancel");
    expect(await rebuilt.runAttempts(result.run_id)).toHaveLength(0);
    expect((await rebuilt.task(result.run_id, "task-001"))?.task).toMatchObject({
      terminal_outcome: "cancelled",
    });
    expect(await rebuilt.run(result.run_id)).toMatchObject({
      status: "cancelled",
      terminal_tasks: 1,
      pending_actions: 0,
      publication_status: null,
    });
    const launch = (await rebuilt.runActions(result.run_id)).find(
      (action) => action.action_kind === "job.launch",
    );
    if (!launch) throw new Error("cancelled Job launch is missing");
    expect(await rebuilt.run(result.run_id)).toMatchObject({
      reserved_microusd: 0,
    });
    expect(await rebuilt.activeJobAdmissions("test")).toEqual([]);
    expect(await rebuilt.jobCapacityRelease(launch.action_id)).toMatchObject({
      release_reason: "job_terminal",
    });
    const reserveId = deterministicId(
      "budget",
      result.run_id,
      executionReservationCategory(["task-001"]),
      String(launch.generation),
    );
    const budgetReleaseId = deterministicId(
      "budget",
      result.run_id,
      "job-release",
      reserveId,
    );
    expect(await rebuilt.budget(budgetReleaseId)).toMatchObject({
      event_kind: "release",
      amount_microusd: 6,
    });
    const terminalRebuild = await Projection.open(
      `${control.root}/cancelled-terminal-rebuilt.sqlite`,
    );
    await terminalRebuild.rebuild(control.store);
    const replayedService = new ControlService(
      "test",
      control.store,
      terminalRebuild,
      control.profiles,
    );
    expect(await replayedService.reconcileTerminalJobReservations(result.run_id)).toBe(
      0,
    );
    expect(await terminalRebuild.run(result.run_id)).toMatchObject({
      reserved_microusd: 0,
    });
    expect(await terminalRebuild.activeJobAdmissions("test")).toEqual([]);
    expect(await terminalRebuild.jobCapacityRelease(launch.action_id)).not.toBeNull();
    expect(
      (
        await control.store.list(
          `control/schema=v1/runs/${result.run_id}/actions/${launch.action_id}`,
        )
      ).filter((entry) => entry.key.endsWith("/zy-capacity-release.json")),
    ).toHaveLength(1);
    expect(
      (
        await control.store.list(`control/schema=v1/runs/${result.run_id}/budgets`)
      ).filter((entry) => entry.key.endsWith(`/${budgetReleaseId}.json`)),
    ).toHaveLength(1);
    await rebuilt.close();
    await terminalRebuild.close();
  });

  it("persists and retries failed and nonterminal Job cancellations", async () => {
    const control = await createTestControl(1, 1, 6);
    controls.push(control);
    await configureCapacity(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 6 },
      "retry-nonterminal-job-cancel",
      operator,
    );
    let cancelCalls = 0;
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch")
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: "job-cancel-retry",
          };
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: "RUNNING",
            resource_id: "job-cancel-retry",
          };
        if (intent.action_kind === "job.cancel") {
          cancelCalls += 1;
          if (cancelCalls === 1)
            return {
              outcome: "failed",
              observed_state: "RUNNING",
              error_code: "remote_dependency_error",
            };
          return {
            outcome: "completed",
            observed_state: cancelCalls === 2 ? "RUNNING" : "CANCELED",
            resource_id: "job-cancel-retry",
          };
        }
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await reconciler.tick();
    await reconciler.tick();
    await control.service.runAction(
      result.run_id,
      { action: "cancel", confirmed: true },
      "retry-job-cancel-action",
      operator,
    );

    for (let round = 0; round < 20 && cancelCalls < 1; round += 1)
      await reconciler.tick();
    let cancellations = (await control.projection.runActions(result.run_id)).filter(
      (action) => action.action_kind === "job.cancel",
    );
    expect(cancelCalls).toBe(1);
    expect(cancellations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observed_state: "RUNNING",
          outcome: "failed",
        }),
        expect.objectContaining({ receipt_body: null }),
      ]),
    );
    expect(await control.projection.activeJobAdmissions("test")).toHaveLength(1);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "cancelling",
      reserved_microusd: 6,
    });

    for (let round = 0; round < 20 && cancelCalls < 2; round += 1)
      await reconciler.tick();
    cancellations = (await control.projection.runActions(result.run_id)).filter(
      (action) => action.action_kind === "job.cancel",
    );
    expect(cancelCalls).toBe(2);
    expect(cancellations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observed_state: "RUNNING",
          outcome: "completed",
        }),
        expect.objectContaining({ receipt_body: null }),
      ]),
    );
    expect(await control.projection.activeJobAdmissions("test")).toHaveLength(1);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 6,
    });

    await settle(reconciler, 10);
    const cancellation = (await control.projection.runActions(result.run_id)).find(
      (action) =>
        action.action_kind === "job.cancel" && action.observed_state === "CANCELED",
    );
    expect(cancellation).toMatchObject({
      observed_state: "CANCELED",
      outcome: "completed",
    });
    expect(await control.projection.activeJobAdmissions("test")).toEqual([]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "cancelled",
      reserved_microusd: 0,
    });
  });

  it("continues later Job cancellations after a transient failure in the same tick", async () => {
    const control = await createTestControl();
    controls.push(control);
    await configureCapacity(control, {
      maximum: 2,
      hardwareMaximum: 2,
      burst: 2,
    });
    const first = await control.service.submit(submission, "first-cancel", operator);
    const second = await control.service.submit(submission, "second-cancel", operator);
    const firstResource = `job-${first.run_id}`;
    const secondResource = `job-${second.run_id}`;
    const cancelledResources: string[] = [];
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch")
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: `job-${intent.run_id}`,
          };
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: "RUNNING",
            resource_id: intent.target,
          };
        if (intent.action_kind === "job.cancel") {
          cancelledResources.push(intent.target);
          return intent.target === firstResource
            ? {
                outcome: "failed",
                observed_state: "RUNNING",
                resource_id: intent.target,
                error_code: "remote_dependency_error",
              }
            : {
                outcome: "completed",
                observed_state: "CANCELED",
                resource_id: intent.target,
              };
        }
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler, 4);
    expect(
      (await control.projection.activeJobAdmissions("test")).map(
        (grant) => grant.run_id,
      ),
    ).toEqual(expect.arrayContaining([first.run_id, second.run_id]));
    await control.service.runAction(
      first.run_id,
      { action: "cancel", confirmed: true },
      "cancel-first-job",
      operator,
    );
    await control.service.runAction(
      second.run_id,
      { action: "cancel", confirmed: true },
      "cancel-second-job",
      operator,
    );
    await reconciler.tick();
    expect(
      (
        await Promise.all([
          control.projection.runActions(first.run_id),
          control.projection.runActions(second.run_id),
        ])
      )
        .flat()
        .filter(
          (action) =>
            action.action_kind === "job.cancel" && action.receipt_body === null,
        ),
    ).toHaveLength(2);

    await reconciler.tick();

    expect(cancelledResources.sort()).toEqual([firstResource, secondResource].sort());
    expect(
      (
        await Promise.all([
          control.projection.runActions(first.run_id),
          control.projection.runActions(second.run_id),
        ])
      )
        .flat()
        .filter((action) => action.action_kind === "job.cancel"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: firstResource,
          outcome: "failed",
          observed_state: "RUNNING",
        }),
        expect.objectContaining({
          target: secondResource,
          outcome: "completed",
          observed_state: "CANCELED",
        }),
      ]),
    );
    expect(await control.projection.run(first.run_id)).toMatchObject({
      status: "cancelling",
      terminal_tasks: 0,
    });
    await reconciler.tick();
    expect(await control.projection.run(second.run_id)).toMatchObject({
      status: "cancelled",
      terminal_tasks: 1,
    });
  });

  it("cancels only the selected task and its physical Job", async () => {
    const control = await createTestControl(2);
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "task-scoped-cancellation",
      operator,
    );
    const cancelledResources: string[] = [];
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch")
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: `job-${String(intent.payload.task_id)}`,
          };
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: "RUNNING",
            resource_id: intent.payload.resource_id as string,
          };
        if (intent.action_kind === "job.cancel") {
          cancelledResources.push(intent.target);
          return {
            outcome: "completed",
            observed_state: "CANCELED",
            resource_id: intent.target,
          };
        }
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler, 4);

    const cancellation = await control.service.runAction(
      result.run_id,
      { action: "cancel", task_id: "task-001", confirmed: true },
      "cancel-one-task",
      operator,
    );
    await expect(
      control.service.cancelTask(
        result.run_id,
        "task-002",
        cancellation.action_id,
        "2026-08-24T00:00:00.000Z",
        "invalid out-of-scope cancellation",
      ),
    ).rejects.toThrow("outside the requested scope");
    await expect(control.projection.sync(control.store)).resolves.toEqual([]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "cancelling",
    });
    await settle(reconciler, 12);

    expect(cancelledResources).toEqual(["job-task-001"]);
    expect(
      (await control.projection.task(result.run_id, "task-001"))?.task,
    ).toMatchObject({ terminal_outcome: "cancelled" });
    expect(
      (await control.projection.task(result.run_id, "task-002"))?.task,
    ).toMatchObject({ terminal_outcome: null });
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "active",
      terminal_tasks: 1,
      cancellation_requested: true,
    });
  });

  it("rejects pause and cancellation for every terminal Run status", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "terminal-run-mutation-key",
      operator,
    );
    const run = await control.projection.run(result.run_id);
    if (!run) throw new Error("submitted Run is missing");
    const runView = vi.spyOn(control.projection, "run");

    for (const status of ["cancelled", "completed", "completed-invalid", "failed"]) {
      runView.mockResolvedValue({ ...run, status });
      await expect(
        control.service.runAction(
          result.run_id,
          { action: "cancel", confirmed: true },
          `cancel-${status}`,
          operator,
        ),
      ).rejects.toThrow("terminal run cannot be cancelled");
      await expect(
        control.service.runAction(
          result.run_id,
          { action: "pause", confirmed: true },
          `pause-${status}`,
          operator,
        ),
      ).rejects.toThrow("terminal run cannot be paused");
    }
  });

  it("rejects cancellation after publication has started", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "publication-cancellation-policy",
      operator,
    );
    await control.service.writeAction(
      control.service.actionIntent(
        result.run_id,
        "publication.publish",
        "results",
        0,
        {},
      ),
    );

    await expect(
      control.service.runAction(
        result.run_id,
        { action: "cancel", confirmed: true },
        "cancel-after-publication",
        operator,
      ),
    ).rejects.toThrow("run cannot be cancelled after publication starts");
    expect(
      (await control.projection.runActions(result.run_id)).filter(
        (action) => action.action_kind === "run.cancel",
      ),
    ).toHaveLength(0);
  });

  it("serializes cancellation against automatic publication admission", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "cancel-publication-race-run-key",
      operator,
    );
    const projected = await control.projection.run(result.run_id);
    if (!projected) throw new Error("race test run is missing");
    const runSpy = vi.spyOn(control.projection, "run").mockResolvedValue({
      ...projected,
      status: "active",
      total_tasks: 1,
      terminal_tasks: 1,
      admissible_tasks: 1,
      exhausted_tasks: 0,
      pending_actions: 0,
      cleanup_pending: false,
      budget_exceeded: false,
      cancellation_requested: false,
    });

    const [cancellation, published] = await Promise.all([
      control.service.runAction(
        result.run_id,
        { action: "cancel", confirmed: true },
        "cancel-publication-race-action-key",
        operator,
      ),
      control.service.admitAutomaticPublication(result.run_id),
    ]);
    runSpy.mockRestore();

    expect(cancellation.adopted).toBe(false);
    expect(published).toBe(false);
    expect(
      (await control.projection.runActions(result.run_id)).filter(
        (action) => action.action_kind === "run.cancel",
      ),
    ).toHaveLength(1);
    expect(
      await control.projection.hasRunAction(result.run_id, "publication.publish"),
    ).toBe(false);
  });

  it("starts paused and reserves each resumed execution within the ceiling", async () => {
    const control = await createTestControl(3, 1, 6);
    controls.push(control);
    await configureCapacity(control, {
      maximum: 3,
      hardwareMaximum: 3,
      burst: 6,
    });
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 18, start_paused: true },
      "paused-run-key",
      operator,
    );
    const launches: string[][] = [];
    const noop = new NoopActions();
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch")
          launches.push([...(intent.payload.task_ids ?? [])]);
        return noop.execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );

    await settle(reconciler, 6);
    expect(launches).toEqual([]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "paused",
      paused: true,
      terminal_tasks: 0,
      reserved_microusd: 0,
    });

    await control.service.runAction(
      result.run_id,
      { action: "resume", task_limit: 1, confirmed: true },
      "resume-one-task-key",
      operator,
    );
    await settle(reconciler, 8);
    expect(launches).toEqual([["task-001"]]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      terminal_tasks: 1,
      paused: false,
      reserved_microusd: 0,
    });

    await control.service.runAction(
      result.run_id,
      { action: "pause", confirmed: true },
      "pause-after-canary-key",
      operator,
    );
    await settle(reconciler, 3);
    await control.service.runAction(
      result.run_id,
      { action: "resume", confirmed: true },
      "resume-then-pause-key",
      operator,
    );
    await control.service.runAction(
      result.run_id,
      { action: "pause", confirmed: true },
      "pause-before-resume-dispatch-key",
      operator,
    );
    await settle(reconciler, 5);
    expect(launches).toEqual([["task-001"]]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "paused",
      reserved_microusd: 0,
      pending_actions: 0,
    });
    const suppressed = (await control.projection.runActions(result.run_id)).find(
      (action) => action.observed_state === "suppressed-paused",
    );
    if (!suppressed) throw new Error("suppressed launch is missing");
    expect(
      await control.projection.jobCapacityRelease(suppressed.action_id),
    ).toMatchObject({ release_reason: "launch_suppressed" });
    await control.service.runAction(
      result.run_id,
      { action: "resume", confirmed: true },
      "resume-remaining-key",
      operator,
    );
    await settle(reconciler, 10);

    expect(launches).toEqual([["task-001"], ["task-002"], ["task-003"]]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 3,
      admissible_tasks: 3,
      reserved_microusd: 0,
      publication_status: "published",
    });
  });

  it("releases an admitted launch when cancellation suppresses dispatch", async () => {
    const control = await createTestControl(1, 1, 6);
    controls.push(control);
    await configureCapacity(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 6, start_paused: true },
      "cancel-admitted-launch",
      operator,
    );
    const createdAt = "2026-08-22T12:00:00.000Z";
    expect(
      await control.service.reserveJobActions(result.run_id, [
        {
          category: executionReservationCategory(["task-001"]),
          generation: 0,
          created_at: createdAt,
          amount_microusd: 6,
        },
      ]),
    ).toBe(true);
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        reservation_microusd: 6,
        hardware: "cpu-basic",
        max_jobs: 1,
      },
      undefined,
      createdAt,
    );
    expect(await control.service.admitJobLaunch(launch)).toMatchObject({
      status: "admitted",
    });
    await control.service.runAction(
      result.run_id,
      { action: "cancel", confirmed: true },
      "cancel-before-dispatch",
      operator,
    );

    expect(await control.service.admitJobLaunch(launch)).toMatchObject({
      status: "rejected",
      limiting_factor: "run_cancelled",
    });
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 0,
    });
    expect(await control.projection.jobCapacityRelease(launch.action_id)).toMatchObject(
      {
        release_reason: "launch_suppressed",
      },
    );
  });

  it("records a paused terminal Job before resuming its replacement", async () => {
    const control = await createTestControl(1, 2, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12 },
      "paused-terminal-job-run",
      operator,
    );
    let terminal = false;
    let launches = 0;
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch") {
          launches += 1;
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: `job-paused-terminal-${launches}`,
          };
        }
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: terminal ? "ERROR" : "RUNNING",
            resource_id: String(intent.payload.resource_id),
          };
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      {
        interval_ms: 100,
        observation_interval_ms: 0,
        worker_receipt_grace_ms: 0,
        batch_size: 16,
      },
    );
    await settle(reconciler, 4);
    expect(launches).toBe(1);
    await control.service.runAction(
      result.run_id,
      { action: "pause", confirmed: true },
      "pause-terminal-job",
      operator,
    );
    terminal = true;
    await settle(reconciler, 8);
    const [fallback] = await control.projection.runAttempts(result.run_id);
    expect(fallback).toMatchObject({
      outcome: "infrastructure",
      replacement_eligible: 1,
    });
    expect(launches).toBe(1);

    terminal = false;
    await control.service.runAction(
      result.run_id,
      { action: "resume", confirmed: true },
      "resume-terminal-job",
      operator,
    );
    await reconciler.tick();
    const replacement = (await control.projection.runActions(result.run_id))
      .map((action) => JSON.parse(action.intent_body) as ActionIntent)
      .find((intent) => intent.payload.prior_attempt_id === fallback?.attempt_id);
    expect(replacement).toMatchObject({
      action_kind: "job.launch",
      generation: 1,
      payload: {
        task_ids: ["task-001"],
        prior_attempt_id: fallback?.attempt_id,
      },
    });
  });

  it("reconciles a historical terminal Job reservation before resume", async () => {
    const control = await createTestControl(1, 1, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 6, start_paused: true },
      "historical-job-reservation-key",
      operator,
    );
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler, 3);
    const generation = 7;
    const createdAt = "2026-08-22T12:00:00.000Z";
    await control.service.append({
      schema_version: "v1",
      kind: "budget.event",
      record_id: deterministicId(
        "budget",
        result.run_id,
        executionReservationCategory(["task-001"]),
        String(generation),
      ),
      created_at: createdAt,
      actor: { subject: "harbor-hf-control", role: "service" },
      run_id: result.run_id,
      event_kind: "reserve",
      amount_microusd: 6,
    });
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      generation,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        reservation_microusd: 6,
      },
    );
    await control.service.writeAction(launch);
    const launchReceipt = await control.service.receipt(launch, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: "historical-job",
    });
    await control.service.markAdvanced(launch, launchReceipt);
    const observe = control.service.actionIntent(
      result.run_id,
      "job.observe",
      "historical-job",
      0,
      {
        worker_role: "execution",
        task_ids: ["task-001"],
        launch_action_id: launch.action_id,
      },
    );
    await control.service.writeAction(observe);
    const observeReceipt = await control.service.receipt(observe, {
      outcome: "completed",
      observed_state: "COMPLETED",
      resource_id: "historical-job",
    });
    await control.service.markAdvanced(observe, observeReceipt);

    await control.service.runAction(
      result.run_id,
      { action: "resume", task_limit: 1, confirmed: true },
      "historical-job-reservation-resume-key",
      operator,
    );
    expect(await control.service.reconcileTerminalJobReservations(result.run_id)).toBe(
      0,
    );
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 6,
      pending_actions: 1,
    });
  });

  it("releases capacity and budget held by a terminal preparation Job", async () => {
    const control = await createTestControl();
    controls.push(control);
    await configureCapacity(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 10 },
      "terminal-preparation-reservation",
      operator,
    );
    const createdAt = "2026-08-22T12:00:00.000Z";
    expect(
      await control.service.reserveJobActions(result.run_id, [
        {
          category: "preparation",
          generation: 0,
          created_at: createdAt,
          amount_microusd: 10,
        },
      ]),
    ).toBe(true);
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "run-preparation",
      0,
      {
        worker_role: "preparation",
        task_ids: ["task-001"],
        reservation_microusd: 10,
        hardware: "cpu-basic",
        max_jobs: 1,
      },
      undefined,
      createdAt,
    );
    expect(await control.service.admitJobLaunch(launch)).toMatchObject({
      status: "admitted",
    });
    const launchReceipt = await control.service.receipt(launch, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: "terminal-preparation-job",
    });
    await control.service.markAdvanced(launch, launchReceipt);
    const observe = control.service.actionIntent(
      result.run_id,
      "job.observe",
      "terminal-preparation-job",
      0,
      {
        worker_role: "preparation",
        task_ids: ["task-001"],
        launch_action_id: launch.action_id,
      },
    );
    await control.service.writeAction(observe);
    const terminalReceipt = await control.service.receipt(observe, {
      outcome: "completed",
      observed_state: "COMPLETED",
      resource_id: "terminal-preparation-job",
    });
    await control.service.markAdvanced(observe, terminalReceipt);

    expect(await control.projection.jobCapacityRelease(launch.action_id)).toMatchObject(
      {
        release_reason: "job_terminal",
      },
    );
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 10,
    });
    expect(await control.service.reconcileTerminalJobReservations(result.run_id)).toBe(
      1,
    );
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 0,
    });
  });

  it("orders same-millisecond pause and resume actions causally", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "same-millisecond-lifecycle-run",
      operator,
    );
    const fixed = new Date("2026-08-22T12:00:00.000Z");
    const clock = vi.spyOn(control.service.clock, "now").mockReturnValue(fixed);
    const pause = await control.service.runAction(
      result.run_id,
      { action: "pause", confirmed: true },
      "same-millisecond-pause",
      operator,
    );
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler, 3);
    const resume = await control.service.runAction(
      result.run_id,
      { action: "resume", confirmed: true },
      "same-millisecond-resume",
      operator,
    );
    clock.mockRestore();
    const pauseRow = await control.projection.action(pause.action_id);
    const resumeRow = await control.projection.action(resume.action_id);

    expect(Date.parse(resumeRow?.created_at ?? "")).toBeGreaterThan(
      Date.parse(pauseRow?.created_at ?? ""),
    );
    expect(await control.projection.runPaused(result.run_id)).toBe(false);
  });

  it("reuses released Job reservations within the run ceiling", async () => {
    const control = await createTestControl(2, 1, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12, start_paused: true },
      "paused-ceiling-run-key",
      operator,
    );
    const launches: string[][] = [];
    const noop = new NoopActions();
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      {
        execute: async (intent): Promise<ExternalActionResult> => {
          if (intent.action_kind === "job.launch")
            launches.push([...(intent.payload.task_ids ?? [])]);
          return noop.execute(intent);
        },
      },
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );

    await settle(reconciler, 4);
    await control.service.runAction(
      result.run_id,
      { action: "resume", task_limit: 1, confirmed: true },
      "paused-ceiling-canary-key",
      operator,
    );
    await settle(reconciler, 8);
    await control.service.runAction(
      result.run_id,
      { action: "pause", confirmed: true },
      "paused-ceiling-pause-key",
      operator,
    );
    await settle(reconciler, 3);

    await control.service.runAction(
      result.run_id,
      { action: "resume", confirmed: true },
      "paused-ceiling-second-resume-key",
      operator,
    );
    await settle(reconciler, 10);
    expect(launches).toEqual([["task-001"], ["task-002"]]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "completed",
      paused: false,
      terminal_tasks: 2,
      reserved_microusd: 0,
      pending_actions: 0,
    });
  });

  it("does not cancel a remote Job that is already in ERROR", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "cancel-error-job-submission",
      operator,
    );
    const observedKinds: string[] = [];
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        observedKinds.push(intent.action_kind);
        if (intent.action_kind === "job.launch")
          return {
            outcome: "created",
            observed_state: "ERROR",
            resource_id: "job-error-terminal",
          };
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: "ERROR",
            resource_id: "job-error-terminal",
          };
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      {
        interval_ms: 100,
        observation_interval_ms: 60_000,
        batch_size: 16,
        dispatch_adoption_delay_ms: 0,
      },
    );
    await reconciler.tick();
    await reconciler.tick();
    await control.service.runAction(
      result.run_id,
      { action: "cancel", reason: "operator cancellation", confirmed: true },
      "cancel-error-job-action",
      operator,
    );
    vi.advanceTimersByTime(60_000);

    await settle(reconciler, 12);

    expect(observedKinds).not.toContain("job.cancel");
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "cancelled",
      terminal_tasks: 1,
    });
  });

  it("retries unresolved infrastructure failures without a fixed attempt limit", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "failed-job-launch-key",
      operator,
    );
    let launches = 0;
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind !== "job.launch")
          return new NoopActions().execute(intent);
        launches += 1;
        if (launches <= 3)
          return {
            outcome: "failed",
            observed_state: `job-create-failed-${launches}`,
            error_code: "jobs-api-unavailable",
          };
        return {
          outcome: "created",
          observed_state: "RUNNING",
          resource_id: "job-after-infrastructure-retries",
        };
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler, 16);
    expect(launches).toBe(4);
    expect(await control.projection.runAttempts(result.run_id)).toHaveLength(3);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "active",
      terminal_tasks: 0,
      exhausted_tasks: 0,
      publication_status: null,
    });
    const detail = await control.projection.task(result.run_id, "task-001");
    expect(detail?.attempts).toHaveLength(3);
    expect(detail?.task).toMatchObject({
      terminal_outcome: null,
      selected_attempt_id: null,
    });
  });

  it("retries with a free generation after a hash-derived generation", async () => {
    const control = await createTestControl(1, 2, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12 },
      "retry-generation-gap-key",
      operator,
    );
    const launchGenerations: number[] = [];
    let sentinelWritten = false;
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: "RUNNING",
            resource_id: String(intent.payload.resource_id),
          };
        if (intent.action_kind !== "job.launch")
          return new NoopActions().execute(intent);
        launchGenerations.push(intent.generation);
        if (!sentinelWritten) {
          sentinelWritten = true;
          const sentinel = control.service.actionIntent(
            result.run_id,
            "job.launch",
            "task-001",
            1_000_000,
            { ...intent.payload },
          );
          await control.service.writeAction(sentinel);
          await control.service.markAdvanced(
            sentinel,
            await control.service.receipt(sentinel, {
              outcome: "completed",
              observed_state: "suppressed-generation-sentinel",
            }),
          );
          return {
            outcome: "failed",
            observed_state: "job-create-failed",
            error_code: "jobs-api-unavailable",
          };
        }
        return {
          outcome: "created",
          observed_state: "RUNNING",
          resource_id: "replacement-job",
        };
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );

    await settle(reconciler, 12);

    expect(launchGenerations).toHaveLength(2);
    expect(launchGenerations[1]).not.toBe(1_000_000);
    expect(launchGenerations[1]).not.toBe(launchGenerations[0]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "active",
      terminal_tasks: 0,
      exhausted_tasks: 0,
    });
  });

  it("pauses sibling tasks after a shared infrastructure failure repeats", async () => {
    const control = await createTestControl(2, 1, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 100 },
      "shared-failure-across-tasks-key",
      operator,
    );
    let launches = 0;
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind !== "job.launch")
          return new NoopActions().execute(intent);
        launches += 1;
        return {
          outcome: "failed",
          observed_state: "shared-worker-failure",
          error_code: "worker-start-failed",
        };
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );

    await settle(reconciler, 12);
    const launchesAtPause = launches;
    expect(launchesAtPause).toBeGreaterThanOrEqual(2);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "paused",
      reserved_microusd: 0,
      terminal_tasks: 0,
      exhausted_tasks: 0,
    });
    await settle(reconciler, 5);
    expect(launches).toBe(launchesAtPause);
    expect(
      (await control.projection.runActions(result.run_id)).some(
        (action) =>
          action.action_kind === "job.launch" &&
          action.observed_state === "suppressed-paused",
      ),
    ).toBe(true);

    await expect(
      control.service.runAction(
        result.run_id,
        {
          action: "resume",
          reason: "no worker repair attached",
          task_limit: 1,
          confirmed: true,
        },
        "resume-shared-failure-across-tasks-key",
        operator,
      ),
    ).rejects.toThrow(
      "repeated infrastructure failure requires a reviewed worker repair",
    );
    await settle(reconciler, 12);
    expect(launches).toBe(launchesAtPause);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "paused",
      reserved_microusd: 0,
      terminal_tasks: 0,
      exhausted_tasks: 0,
    });
  });

  it("keeps unresolved tasks active while their replacement Jobs run", async () => {
    const control = await createTestControl(2, 1, 0, true, "forbidden", undefined, []);
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "partial-exhaustion-key",
      operator,
    );
    let launches = 0;
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch") {
          launches += 1;
          if (launches === 1)
            return {
              outcome: "failed",
              observed_state: "job-create-failed",
              error_code: "jobs-api-unavailable",
            };
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: `job-remaining-${launches}`,
          };
        }
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: "RUNNING",
            resource_id: "job-remaining",
          };
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler, 12);
    expect(launches).toBe(3);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "active",
      terminal_tasks: 0,
      exhausted_tasks: 0,
      publication_status: null,
    });
    expect(
      (await control.projection.task(result.run_id, "task-001"))?.task.terminal_outcome,
    ).toBeNull();
    expect(
      (await control.projection.task(result.run_id, "task-002"))?.task.terminal_outcome,
    ).toBeNull();
  });

  it("requeues Job observe after a non-terminal observe never wrote the next one", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "requeue-broken-observe-key",
      operator,
    );
    let failObservation = true;
    let launchSequence = 0;
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch") {
          launchSequence += 1;
          return {
            outcome: "created",
            observed_state: "SCHEDULING",
            resource_id: `job-broken-observe-chain-${launchSequence}`,
          };
        }
        if (intent.action_kind === "job.observe" && failObservation)
          return {
            outcome: "failed",
            observed_state: "UNKNOWN",
            error_code: "temporary-observation-failure",
          };
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: "ERROR",
            resource_id: String(intent.payload.resource_id),
          };
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    let observe:
      | Awaited<ReturnType<typeof control.projection.runActions>>[number]
      | undefined;
    for (let round = 0; round < 8 && !observe; round += 1) {
      await reconciler.tick();
      observe = (await control.projection.runActions(result.run_id)).find(
        (action) =>
          action.action_kind === "job.observe" && action.receipt_body === null,
      );
    }
    expect(observe).toBeDefined();
    failObservation = false;
    await control.service.receipt(JSON.parse(observe?.intent_body ?? "null"), {
      outcome: "completed",
      observed_state: "SCHEDULING",
      resource_id: "job-broken-observe-chain-1",
    });
    await settle(reconciler, 3);
    expect(
      (await control.projection.runActions(result.run_id)).some(
        (action) =>
          action.action_kind === "job.observe" && action.observed_state === "ERROR",
      ),
    ).toBe(true);
  });

  it("launches one physical Job per task", async () => {
    const control = await createTestControl(2, 1, 0, false);
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "one-job-per-task-key",
      operator,
    );
    const launches: ActionIntent[] = [];
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch") {
          launches.push(intent);
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: `job-${intent.target}`,
          };
        }
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: "RUNNING",
            resource_id: String(intent.payload.resource_id),
          };
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler, 6);

    expect(launches).toHaveLength(2);
    expect(
      launches.map((intent) => ({
        target: intent.target,
        task_id: intent.payload.task_id,
        task_ids: intent.payload.task_ids,
      })),
    ).toEqual([
      { target: "task-001", task_id: "task-001", task_ids: ["task-001"] },
      { target: "task-002", task_id: "task-002", task_ids: ["task-002"] },
    ]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "active",
      terminal_tasks: 0,
    });
  });

  it("does not replace a non-infrastructure attempt", async () => {
    const control = await createTestControl(1, 2, 0, false, "forbidden", undefined, [
      "input_tokens",
      "output_tokens",
    ]);
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "zero-token-attempts-key",
      operator,
    );
    let launches = 0;
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch") {
          launches += 1;
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: `job-zero-${launches}`,
          };
        }
        if (intent.action_kind === "job.observe") {
          const launchActionId = String(intent.payload.launch_action_id);
          if (
            !(await control.projection.attemptForActionTask(launchActionId, "task-001"))
          ) {
            const evidence = await putEvidenceReference(
              control,
              `zero-token-evidence-${launches}`,
            );
            await control.service.attempt({
              run_id: result.run_id,
              task_id: "task-001",
              attempt_id: `zero-token-attempt-${launches}`,
              action_id: launchActionId,
              outcome: launches === 1 ? "agent" : "benchmark_timeout",
              replacement_eligible: false,
              ...evidence,
              cost_microusd: 0,
              metrics: { input_tokens: 0, output_tokens: 0 },
              completed_at: `2026-08-16T00:00:0${launches}.000Z`,
            });
          }
          return {
            outcome: "completed",
            observed_state: "COMPLETED",
            resource_id: `job-zero-${launches}`,
          };
        }
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );

    await settle(reconciler, 20);

    expect(launches).toBe(1);
    expect(await control.projection.runAttempts(result.run_id)).toHaveLength(1);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "failed",
      terminal_tasks: 1,
      admissible_tasks: 0,
      invalid_selected_tasks: 0,
      exhausted_tasks: 1,
      publication_status: null,
    });
    expect(
      await control.projection.taskExhaustion(result.run_id, "task-001"),
    ).toMatchObject({ attempt_count: 1 });
  });

  it("replays a historical zero-token selection as completed-invalid", async () => {
    const control = await createTestControl(1, 1, 0, false, "forbidden", undefined, [
      "input_tokens",
      "output_tokens",
    ]);
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "historical-invalid-selection-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      { task_id: "task-001", task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);
    const evidence = await putEvidenceReference(
      control,
      "historical-invalid-selection-evidence",
    );
    const attempt = await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "historical-invalid-attempt",
      action_id: launch.action_id,
      outcome: "agent",
      replacement_eligible: false,
      ...evidence,
      cost_microusd: 0,
      metrics: { input_tokens: 0, output_tokens: 0 },
      completed_at: "2026-08-16T00:00:01.000Z",
    });
    const selection: TerminalSelection = {
      schema_version: "v1",
      kind: "terminal.selection",
      record_id: deterministicId("terminal", attempt.attempt_id),
      created_at: "2026-08-16T00:00:02.000Z",
      actor: { subject: "historical-import", role: "migration" },
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: attempt.attempt_id,
      outcome: attempt.outcome,
      reason: "historical selection retained for audit",
    };
    await control.store.create(
      controlRecordPath(selection),
      new TextEncoder().encode(canonicalJson(selection)),
    );
    const rebuilt = await Projection.open(`${control.root}/historical-invalid.sqlite`);

    await rebuilt.rebuild(control.store);

    expect(await rebuilt.run(result.run_id)).toMatchObject({
      status: "completed-invalid",
      terminal_tasks: 1,
      admissible_tasks: 0,
      invalid_selected_tasks: 1,
      publication_status: null,
    });
    await rebuilt.close();
  });

  it("fences an ambiguous Job create before retrying label adoption", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "ambiguous-job-dispatch-key",
      operator,
    );
    let creates = 0;
    let adoptionChecks = 0;
    let remoteJobExists = false;
    const external: ExternalActionPort = {
      execute: async (
        intent: ActionIntent,
        context?: ExternalActionContext,
      ): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch") {
          if (context?.adoption_only) {
            adoptionChecks += 1;
            if (!remoteJobExists)
              throw new ExternalActionNotFoundError("remote Job is not visible");
            return {
              outcome: "adopted",
              observed_state: "RUNNING",
              resource_id: "job-ambiguous-one",
            };
          }
          creates += 1;
          remoteJobExists = true;
          throw new AmbiguousExternalActionError("create response disconnected");
        }
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: "COMPLETED",
            resource_id: "job-ambiguous-one",
          };
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      {
        interval_ms: 100,
        observation_interval_ms: 0,
        batch_size: 16,
        dispatch_adoption_delay_ms: 0,
      },
    );

    await settle(reconciler, 12);

    const launch = (await control.projection.actions(100)).find(
      (action) => action.action_kind === "job.launch",
    );
    expect(launch).toBeDefined();
    expect(creates).toBe(1);
    expect(adoptionChecks).toBeGreaterThanOrEqual(2);
    expect(
      launch ? await control.projection.actionDispatch(launch.action_id) : null,
    ).not.toBeNull();
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 1,
    });
  });

  it("adopts and cancels a fenced Job before sealing cancellation", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "ambiguous-cancellation-key",
      operator,
    );
    let creates = 0;
    let remoteJobExists = false;
    let adoptionVisible = false;
    let cancelled = false;
    const external: ExternalActionPort = {
      execute: async (
        intent: ActionIntent,
        context?: ExternalActionContext,
      ): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch") {
          if (context?.adoption_only) {
            if (!remoteJobExists)
              throw new ExternalActionNotFoundError("remote Job is not visible");
            if (!adoptionVisible)
              throw new AmbiguousExternalActionError(
                "remote Job lookup is inconclusive",
              );
            return {
              outcome: "adopted",
              observed_state: "RUNNING",
              resource_id: "job-ambiguous-cancellation",
            };
          }
          creates += 1;
          remoteJobExists = true;
          throw new AmbiguousExternalActionError("create response disconnected");
        }
        if (intent.action_kind === "job.cancel") {
          cancelled = true;
          remoteJobExists = false;
          return {
            outcome: "completed",
            observed_state: "STOPPED",
            resource_id: "job-ambiguous-cancellation",
          };
        }
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: cancelled ? "STOPPED" : "RUNNING",
            resource_id: "job-ambiguous-cancellation",
          };
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      {
        interval_ms: 100,
        observation_interval_ms: 0,
        batch_size: 16,
        dispatch_adoption_delay_ms: 0,
      },
    );
    await reconciler.tick();
    await reconciler.tick();
    const launch = (await control.projection.runActions(result.run_id)).find(
      (action) => action.action_kind === "job.launch",
    );
    expect(launch?.receipt_body).toBeNull();
    expect(
      launch ? await control.projection.actionDispatch(launch.action_id) : null,
    ).not.toBeNull();
    await control.service.runAction(
      result.run_id,
      { action: "cancel", reason: "operator cancellation", confirmed: true },
      "ambiguous-cancellation-action",
      operator,
    );

    await settle(reconciler, 3);

    expect(cancelled).toBe(false);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      terminal_tasks: 0,
    });
    adoptionVisible = true;
    await settle(reconciler, 12);

    expect(creates).toBe(1);
    expect(cancelled).toBe(true);
    expect(remoteJobExists).toBe(false);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "cancelled",
      terminal_tasks: 1,
    });
  });

  it("retries a failed Job observation without creating a replacement", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "transient-job-observation-key",
      operator,
    );
    let creates = 0;
    let observations = 0;
    let remoteJobExists = false;
    const external: ExternalActionPort = {
      execute: async (
        intent: ActionIntent,
        context?: ExternalActionContext,
      ): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch") {
          if (context?.adoption_only) {
            if (!remoteJobExists)
              throw new ExternalActionNotFoundError("remote Job is not visible");
            return {
              outcome: "adopted",
              observed_state: "RUNNING",
              resource_id: "job-observation-retry",
            };
          }
          creates += 1;
          remoteJobExists = true;
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: "job-observation-retry",
          };
        }
        if (intent.action_kind === "job.observe") {
          observations += 1;
          return observations === 1
            ? {
                outcome: "failed",
                observed_state: "ERROR",
                error_code: "jobs-api-unavailable",
              }
            : {
                outcome: "completed",
                observed_state: "COMPLETED",
                resource_id: "job-observation-retry",
              };
        }
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      {
        interval_ms: 100,
        observation_interval_ms: 0,
        batch_size: 16,
        dispatch_adoption_delay_ms: 0,
      },
    );

    await settle(reconciler, 14);

    expect(creates).toBe(1);
    expect(observations).toBe(2);
    expect(await control.projection.runAttempts(result.run_id)).toMatchObject([
      { outcome: "complete" },
    ]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 1,
    });
  });

  it("keeps observing a Job while Hugging Face reports SCHEDULING", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "scheduling-job-observation-key",
      operator,
    );
    let observations = 0;
    const external: ExternalActionPort = {
      execute: async (intent: ActionIntent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch")
          return {
            outcome: "created",
            observed_state: "SCHEDULING",
            resource_id: "job-scheduling",
          };
        if (intent.action_kind === "job.observe") {
          observations += 1;
          return {
            outcome: "completed",
            observed_state:
              observations === 1
                ? "SCHEDULING"
                : observations === 2
                  ? "RUNNING"
                  : "COMPLETED",
            resource_id: "job-scheduling",
          };
        }
        return new NoopActions().execute(intent);
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      {
        interval_ms: 100,
        observation_interval_ms: 0,
        batch_size: 16,
        dispatch_adoption_delay_ms: 0,
      },
    );

    await settle(reconciler, 14);

    expect(observations).toBe(3);
    expect(await control.projection.runAttempts(result.run_id)).toMatchObject([
      { outcome: "complete" },
    ]);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 1,
    });
  });

  it("waits for a late worker receipt before selecting a fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
    try {
      const control = await createTestControl(1, 1, 0, false);
      controls.push(control);
      const result = await control.service.submit(
        submission,
        "late-worker-receipt-key",
        operator,
      );
      let remoteJobExists = false;
      const external: ExternalActionPort = {
        execute: async (
          intent: ActionIntent,
          context?: ExternalActionContext,
        ): Promise<ExternalActionResult> => {
          if (intent.action_kind === "job.launch") {
            if (context?.adoption_only) {
              if (!remoteJobExists)
                throw new ExternalActionNotFoundError("remote Job is not visible");
              return {
                outcome: "adopted",
                observed_state: "RUNNING",
                resource_id: "job-late-worker-receipt",
              };
            }
            remoteJobExists = true;
            return {
              outcome: "created",
              observed_state: "RUNNING",
              resource_id: "job-late-worker-receipt",
            };
          }
          if (intent.action_kind === "job.observe")
            return {
              outcome: "completed",
              observed_state: "COMPLETED",
              resource_id: "job-late-worker-receipt",
            };
          return new NoopActions().execute(intent);
        },
      };
      const reconciler = new Reconciler(
        control.service,
        control.projection,
        external,
        new ResultPublisher(control.store, control.projection, control.service),
        {
          interval_ms: 100,
          observation_interval_ms: 0,
          worker_receipt_grace_ms: 60_000,
          batch_size: 16,
          dispatch_adoption_delay_ms: 0,
        },
      );

      await settle(reconciler, 4);

      expect(await control.projection.run(result.run_id)).toMatchObject({
        terminal_tasks: 0,
      });
      const launch = (await control.projection.runActions(result.run_id)).find(
        (action) => action.action_kind === "job.launch",
      );
      expect(launch).toBeDefined();
      const evidence = await putEvidenceReference(control, "late-worker-evidence");
      await control.service.attempt({
        run_id: result.run_id,
        task_id: "task-001",
        attempt_id: "attempt-late-worker-receipt",
        action_id: launch?.action_id ?? "missing-launch",
        outcome: "complete",
        replacement_eligible: false,
        ...evidence,
        cost_microusd: 0,
        metrics: { reward: 1 },
        completed_at: "2026-08-16T00:00:30.000Z",
      });
      vi.setSystemTime(new Date("2026-08-16T00:01:00.000Z"));
      await settle(reconciler, 6);

      const attempts = await control.projection.runAttempts(result.run_id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attempt_id: "attempt-late-worker-receipt",
        outcome: "complete",
      });
      expect(
        (await control.projection.task(result.run_id, "task-001"))?.task
          .selected_attempt_id,
      ).toBe("attempt-late-worker-receipt");
      expect(await control.projection.run(result.run_id)).toMatchObject({
        status: "completed",
        terminal_tasks: 1,
      });
      expect(
        (await control.projection.runActions(result.run_id)).filter(
          (action) => action.action_kind === "job.launch",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a repeated attempt that omits an explicit failure fingerprint", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "explicit-fingerprint-idempotency-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        task_id: "task-001",
        task_ids: ["task-001"],
        reservation_microusd: 0,
      },
    );
    await control.service.writeAction(launch);
    const evidence = await putEvidenceReference(
      control,
      "explicit-fingerprint-evidence",
    );
    const input = {
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-explicit-fingerprint",
      action_id: launch.action_id,
      outcome: "infrastructure" as const,
      replacement_eligible: true,
      failure_fingerprint: sha256("explicit-failure"),
      ...evidence,
      cost_microusd: 0,
      metrics: {},
      completed_at: "2026-08-16T00:00:01.000Z",
    };
    await control.service.attempt(input);
    const { failure_fingerprint: _omitted, ...withoutFingerprint } = input;

    await expect(control.service.attempt(withoutFingerprint)).rejects.toThrow(
      "attempt identity conflict",
    );
  });

  it("adopts a repeated infrastructure retry request", async () => {
    const control = await createTestControl(1, 2);
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "retry-idempotency-run-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        task_id: "task-001",
        task_ids: ["task-001"],
        max_infrastructure_attempts: 2,
        reservation_microusd: 0,
      },
    );
    await control.service.writeAction(launch);
    const retryEvidence = await putEvidenceReference(
      control,
      "retry-idempotency-evidence",
    );
    const infrastructureAttemptInput = {
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-retry-idempotency",
      action_id: launch.action_id,
      outcome: "infrastructure" as const,
      replacement_eligible: true,
      ...retryEvidence,
      cost_microusd: 0,
      metrics: {},
      completed_at: "2026-08-16T00:00:01.000Z",
    };
    const infrastructureAttempt = await control.service.attempt(
      infrastructureAttemptInput,
    );
    expect(infrastructureAttempt.failure_fingerprint).toBe(
      sha256(
        canonicalJson({
          kind: "legacy-worker-infrastructure-failure",
          worker_revision: "unknown",
        }),
      ),
    );
    await expect(
      control.service.attemptWithStatus(infrastructureAttemptInput),
    ).resolves.toMatchObject({ adopted: true });
    const action = {
      action: "retry_infrastructure",
      task_id: "task-001",
      reason: "retry transient infrastructure",
      confirmed: true,
    } as const;

    const first = await control.service.runAction(
      result.run_id,
      action,
      "same-retry-idempotency-key",
      operator,
    );
    const firstAction = await control.projection.action(first.action_id);
    if (!firstAction) throw new Error("retry launch action is missing");
    const firstIntent = JSON.parse(firstAction.intent_body) as ActionIntent;
    const firstReceipt = await control.service.receipt(firstIntent, {
      outcome: "completed",
      observed_state: "STOPPED",
      resource_id: "retry-idempotency-job",
    });
    await control.service.markAdvanced(firstIntent, firstReceipt);
    const completedEvidence = await putEvidenceReference(
      control,
      "retry-idempotency-completed-evidence",
    );
    const completedAttempt = {
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: first.action_id,
      action_id: first.action_id,
      outcome: "complete" as const,
      replacement_eligible: false,
      ...completedEvidence,
      cost_microusd: 0,
      metrics: { reward: 1 },
      completed_at: "2026-08-16T00:00:02.000Z",
    };
    await control.service.attempt(completedAttempt);
    await control.service.selectTerminal(completedAttempt, "retry completed");

    const repeated = await control.service.runAction(
      result.run_id,
      action,
      "same-retry-idempotency-key",
      operator,
    );

    expect(repeated).toMatchObject({ action_id: first.action_id, adopted: true });
    await expect(
      control.service.runAction(
        result.run_id,
        { ...action, task_id: "task-002" },
        "same-retry-idempotency-key",
        operator,
      ),
    ).rejects.toThrow(
      "idempotency key belongs to a different retry_infrastructure action",
    );
  });

  it("reuses a manual retry reservation after an interrupted intent write", async () => {
    const control = await createTestControl(1, 2, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12 },
      "interrupted-retry-intent-run-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        task_id: "task-001",
        task_ids: ["task-001"],
        reservation_microusd: 6,
      },
    );
    await control.service.writeAction(launch);
    const evidence = await putEvidenceReference(
      control,
      "interrupted-retry-intent-evidence",
    );
    await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-interrupted-retry-intent",
      action_id: launch.action_id,
      outcome: "infrastructure",
      replacement_eligible: true,
      ...evidence,
      cost_microusd: 0,
      metrics: {},
      completed_at: "2026-08-16T00:00:01.000Z",
    });
    const action = {
      action: "retry_infrastructure",
      task_id: "task-001",
      reason: "retry after interrupted intent write",
      confirmed: true,
    } as const;
    const writeAction = control.service.writeAction.bind(control.service);
    let interruptedIntent: ActionIntent | null = null;
    const interruptedWrite = vi
      .spyOn(control.service, "writeAction")
      .mockImplementation(async (intent) => {
        if (
          intent.action_kind === "job.launch" &&
          intent.payload.prior_attempt_id === "attempt-interrupted-retry-intent"
        ) {
          interruptedIntent = intent;
          throw new Error("simulated retry intent write interruption");
        }
        return writeAction(intent);
      });

    await expect(
      control.service.runAction(
        result.run_id,
        action,
        "interrupted-retry-intent-key",
        operator,
      ),
    ).rejects.toThrow("simulated retry intent write interruption");
    interruptedWrite.mockRestore();
    if (!interruptedIntent) throw new Error("interrupted retry intent is missing");
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 6,
    });
    const collision = control.service.actionIntent(
      result.run_id,
      "publication.publish",
      "generation-collision",
      interruptedIntent.generation,
      {},
    );
    await control.service.writeAction(collision);

    const repeated = await control.service.runAction(
      result.run_id,
      action,
      "interrupted-retry-intent-key",
      operator,
    );
    const repeatedRow = await control.projection.action(repeated.action_id);
    if (!repeatedRow) throw new Error("repeated retry intent is missing");
    const repeatedIntent = JSON.parse(repeatedRow.intent_body) as ActionIntent;

    expect(repeatedIntent.generation).not.toBe(interruptedIntent.generation);
    expect(repeatedIntent.payload.replacement_reservation_key).toBe(
      interruptedIntent.payload.replacement_reservation_key,
    );
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 6,
    });
  });

  it("serializes concurrent infrastructure retry admissions", async () => {
    const control = await createTestControl(1, 2, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12 },
      "concurrent-retry-run-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        task_id: "task-001",
        task_ids: ["task-001"],
        max_infrastructure_attempts: 2,
        reservation_microusd: 6,
      },
    );
    await control.service.writeAction(launch);
    const retryEvidence = await putEvidenceReference(
      control,
      "concurrent-retry-evidence",
    );
    await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-concurrent-retry",
      action_id: launch.action_id,
      outcome: "infrastructure",
      replacement_eligible: true,
      ...retryEvidence,
      cost_microusd: 0,
      metrics: {},
      completed_at: "2026-08-16T00:00:01.000Z",
    });
    const action = {
      action: "retry_infrastructure",
      task_id: "task-001",
      reason: "retry transient infrastructure",
      confirmed: true,
    } as const;

    const requests = await Promise.allSettled([
      control.service.runAction(
        result.run_id,
        action,
        "concurrent-retry-key-one",
        operator,
      ),
      control.service.runAction(
        result.run_id,
        action,
        "concurrent-retry-key-two",
        operator,
      ),
    ]);

    expect(requests.filter((request) => request.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(requests.filter((request) => request.status === "rejected")).toHaveLength(1);
    const retries = (await control.projection.actions(10_000)).filter((row) => {
      if (row.action_kind !== "job.launch") return false;
      const intent = JSON.parse(row.intent_body) as ActionIntent;
      return intent.payload.prior_attempt_id === "attempt-concurrent-retry";
    });
    expect(retries).toHaveLength(1);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 6,
    });
  });

  it("retries a sealed infrastructure outcome and accepts a replacement attempt", async () => {
    const control = await createTestControl(1, 2, 150_000);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 180_000_000 },
      "sealed-infrastructure-retry-run-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        task_id: "task-001",
        task_ids: ["task-001"],
        max_infrastructure_attempts: 2,
        reservation_microusd: 150_000,
      },
    );
    await control.service.writeAction(launch);
    const evidence = await putEvidenceReference(
      control,
      "sealed-infrastructure-retry-evidence",
    );
    const attempt = await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-sealed-infrastructure",
      action_id: launch.action_id,
      outcome: "infrastructure",
      replacement_eligible: true,
      ...evidence,
      cost_microusd: 0,
      metrics: {},
      completed_at: "2026-08-16T00:00:01.000Z",
    });
    await control.service.append({
      schema_version: "v1",
      kind: "terminal.selection",
      record_id: deterministicId(
        "terminal",
        result.run_id,
        "task-001",
        attempt.attempt_id,
      ),
      created_at: "2026-08-16T00:00:02.000Z",
      actor: { subject: "harbor-hf-control", role: "service" },
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: attempt.attempt_id,
      outcome: "infrastructure",
      reason: "historical infrastructure seal",
    });
    expect(
      (await control.projection.task(result.run_id, "task-001"))?.task,
    ).toMatchObject({ terminal_outcome: "infrastructure" });

    const retry = await control.service.runAction(
      result.run_id,
      {
        action: "retry_infrastructure",
        task_id: "task-001",
        reason: "retry sealed infrastructure",
        confirmed: true,
      },
      "sealed-infrastructure-retry-key",
      operator,
    );
    const replacementEvidence = await putEvidenceReference(
      control,
      "sealed-infrastructure-replacement-evidence",
    );
    const replacement = await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-sealed-infrastructure-replacement",
      action_id: retry.action_id,
      outcome: "complete",
      replacement_eligible: false,
      ...replacementEvidence,
      cost_microusd: 0,
      metrics: { input_tokens: 1, output_tokens: 1 },
      completed_at: "2026-08-16T00:00:03.000Z",
    });
    await control.service.selectTerminal(replacement, "replacement scored");
    expect(
      (await control.projection.task(result.run_id, "task-001"))?.task,
    ).toMatchObject({
      terminal_outcome: "complete",
      selected_attempt_id: replacement.attempt_id,
    });
  });

  it("retries every eligible infrastructure task with a separate Job", async () => {
    const control = await createTestControl(2, 2, 150_000);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 180_000_000 },
      "bulk-infrastructure-retry-run-key",
      operator,
    );
    const evidence = await putEvidenceReference(
      control,
      "bulk-infrastructure-retry-evidence",
    );
    for (const [index, taskId] of ["task-001", "task-002"].entries()) {
      const launch = control.service.actionIntent(
        result.run_id,
        "job.launch",
        taskId,
        0,
        {
          worker_role: "execution",
          task_id: taskId,
          task_ids: [taskId],
          max_infrastructure_attempts: 2,
          reservation_microusd: 150_000,
        },
      );
      await control.service.writeAction(launch);
      await control.service.attempt({
        run_id: result.run_id,
        task_id: taskId,
        attempt_id: `attempt-bulk-infrastructure-${index + 1}`,
        action_id: launch.action_id,
        outcome: "infrastructure",
        replacement_eligible: true,
        ...evidence,
        cost_microusd: 0,
        metrics: {},
        completed_at: "2026-08-16T00:00:01.000Z",
      });
    }

    const first = await control.service.runAction(
      result.run_id,
      {
        action: "retry_infrastructure",
        task_id: null,
        reason: "retry eligible infrastructure failures",
        confirmed: true,
      },
      "bulk-infrastructure-retry-key",
      operator,
    );
    const repeated = await control.service.runAction(
      result.run_id,
      {
        action: "retry_infrastructure",
        task_id: null,
        reason: "retry eligible infrastructure failures",
        confirmed: true,
      },
      "bulk-infrastructure-retry-key",
      operator,
    );
    expect(repeated).toMatchObject({ action_id: first.action_id, adopted: true });
    const parentRow = (await control.projection.runActions(result.run_id)).find(
      (action) => action.action_kind === "run.retry-infrastructure",
    );
    if (!parentRow) throw new Error("bulk retry parent is missing");
    const materialized = await control.service.materializeInfrastructureRetryCommand(
      JSON.parse(parentRow.intent_body) as ActionIntent,
    );
    expect(materialized).toMatchObject({ complete: true });
    const replayProjection = await Projection.open(
      `${control.root}/bulk-retry-replay.sqlite`,
    );
    await replayProjection.rebuild(control.store);
    const replayService = new ControlService(
      "test",
      control.store,
      replayProjection,
      control.profiles,
    );
    const replayed = await replayService.materializeInfrastructureRetryCommand(
      JSON.parse(parentRow.intent_body) as ActionIntent,
    );
    expect(replayed).toEqual(materialized);
    await replayProjection.close();
    const retries = (await control.projection.runActions(result.run_id))
      .filter((action) => action.action_kind === "job.launch")
      .map((action) => JSON.parse(action.intent_body) as ActionIntent)
      .filter((intent) => intent.payload.prior_attempt_id);
    expect(retries).toHaveLength(2);
    expect(
      retries
        .map((intent) => intent.payload.task_ids)
        .sort((left, right) => String(left).localeCompare(String(right))),
    ).toEqual([["task-001"], ["task-002"]]);
  });

  it("retries after an unselected policy receipt on an infrastructure seal", async () => {
    const control = await createTestControl(1, 2, 0);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 180_000_000 },
      "unselected-policy-retry-run-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        max_infrastructure_attempts: 2,
        reservation_microusd: 0,
      },
    );
    await control.service.writeAction(launch);
    const evidence = await putEvidenceReference(
      control,
      "unselected-policy-retry-evidence",
    );
    const sealed = await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-unselected-policy-infra",
      action_id: launch.action_id,
      outcome: "infrastructure",
      replacement_eligible: true,
      ...evidence,
      cost_microusd: 0,
      metrics: {},
      completed_at: "2026-08-16T00:00:01.000Z",
    });
    await control.service.append({
      schema_version: "v1",
      kind: "terminal.selection",
      record_id: deterministicId(
        "terminal",
        result.run_id,
        "task-001",
        sealed.attempt_id,
      ),
      created_at: "2026-08-16T00:00:02.000Z",
      actor: { subject: "harbor-hf-control", role: "service" },
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: sealed.attempt_id,
      outcome: "infrastructure",
      reason: "infrastructure seal",
    });
    const failedLaunch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "eligible",
      1,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        max_infrastructure_attempts: 2,
        reservation_microusd: 0,
      },
    );
    await control.service.writeAction(failedLaunch);
    const failedReceipt = await control.service.receipt(failedLaunch, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: "unselected-policy-job",
    });
    await control.service.markAdvanced(failedLaunch, failedReceipt);
    const failedObserve = control.service.actionIntent(
      result.run_id,
      "job.observe",
      "unselected-policy-job",
      0,
      {
        worker_role: "execution",
        task_ids: ["task-001"],
        launch_action_id: failedLaunch.action_id,
        success_without_worker_receipt: false,
      },
    );
    await control.service.writeAction(failedObserve);
    await control.service.markAdvanced(
      failedObserve,
      await control.service.receipt(failedObserve, {
        outcome: "completed",
        observed_state: "COMPLETED",
        resource_id: "unselected-policy-job",
      }),
    );
    await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-unselected-policy",
      action_id: failedLaunch.action_id,
      outcome: "policy",
      replacement_eligible: false,
      ...evidence,
      cost_microusd: 0,
      metrics: {},
      completed_at: "2026-08-16T00:00:02.000Z",
    });
    expect(
      (await control.projection.task(result.run_id, "task-001"))?.task,
    ).toMatchObject({ terminal_outcome: "infrastructure" });
    const retry = await control.service.runAction(
      result.run_id,
      {
        action: "retry_infrastructure",
        task_id: null,
        reason: "retry after unselected policy receipt",
        confirmed: true,
      },
      "unselected-policy-retry-key",
      operator,
    );
    const parentRow = (await control.projection.runActions(result.run_id)).find(
      (action) => action.action_kind === "run.retry-infrastructure",
    );
    if (!parentRow) throw new Error("bulk retry parent is missing");
    await control.service.materializeInfrastructureRetryCommand(
      JSON.parse(parentRow.intent_body) as ActionIntent,
    );
    expect(await control.projection.action(retry.action_id)).toMatchObject({
      action_kind: "job.launch",
    });
  });

  it("releases a terminal Job reservation before retrying infrastructure", async () => {
    const control = await createTestControl(1, 2, 150_000);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 150_000 },
      "terminal-reservation-retry-run-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        max_infrastructure_attempts: 2,
        reservation_microusd: 150_000,
      },
    );
    await control.service.append({
      schema_version: "v1",
      kind: "budget.event",
      record_id: deterministicId(
        "budget",
        result.run_id,
        executionReservationCategory(["task-001"]),
        "0",
      ),
      created_at: "2026-08-16T00:00:00.000Z",
      actor: { subject: "harbor-hf-control", role: "service" },
      run_id: result.run_id,
      event_kind: "reserve",
      amount_microusd: 150_000,
    });
    await control.service.writeAction(launch);
    const launchReceipt = await control.service.receipt(launch, {
      outcome: "created",
      observed_state: "ERROR",
      resource_id: "terminal-reservation-job",
    });
    await control.service.markAdvanced(launch, launchReceipt);
    const observe = control.service.actionIntent(
      result.run_id,
      "job.observe",
      "terminal-reservation-job",
      0,
      {
        worker_role: "execution",
        task_ids: ["task-001"],
        launch_action_id: launch.action_id,
      },
    );
    await control.service.writeAction(observe);
    const observeReceipt = await control.service.receipt(observe, {
      outcome: "failed",
      observed_state: "ERROR",
      resource_id: "terminal-reservation-job",
    });
    await control.service.markAdvanced(observe, observeReceipt);
    const evidence = await putEvidenceReference(
      control,
      "terminal-reservation-retry-evidence",
    );
    await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-terminal-reservation",
      action_id: launch.action_id,
      outcome: "infrastructure",
      replacement_eligible: true,
      ...evidence,
      cost_microusd: 0,
      metrics: {},
      completed_at: "2026-08-16T00:00:01.000Z",
    });
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 150_000,
    });

    await control.service.runAction(
      result.run_id,
      {
        action: "retry_infrastructure",
        task_id: null,
        reason: "retry after terminal Job reservation",
        confirmed: true,
      },
      "terminal-reservation-retry-key",
      operator,
    );
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 150_000,
    });
  });

  it("includes observed overage when admitting a replacement", async () => {
    const control = await createTestControl(1, 2, 50);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 100 },
      "observed-overage-run-key",
      operator,
    );
    await control.service.append({
      schema_version: "v1",
      kind: "budget.event",
      record_id: deterministicId("budget", result.run_id, "reserve", "initial"),
      created_at: "2026-08-16T00:00:00.000Z",
      actor: { subject: "harbor-hf-control", role: "service" },
      run_id: result.run_id,
      event_kind: "reserve",
      amount_microusd: 50,
    });
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        task_id: "task-001",
        task_ids: ["task-001"],
        max_infrastructure_attempts: 2,
        reservation_microusd: 50,
      },
    );
    await control.service.writeAction(launch);
    const evidence = await putEvidenceReference(control, "observed-overage-evidence");
    await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-observed-overage",
      action_id: launch.action_id,
      outcome: "infrastructure",
      replacement_eligible: true,
      ...evidence,
      cost_microusd: 60,
      metrics: {},
      completed_at: "2026-08-16T00:00:01.000Z",
    });

    await expect(
      control.service.runAction(
        result.run_id,
        {
          action: "retry_infrastructure",
          task_id: "task-001",
          reason: "retry transient infrastructure",
          confirmed: true,
        },
        "observed-overage-retry-key",
        operator,
      ),
    ).rejects.toThrow("replacement Job would exceed the run ceiling");
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 50,
      observed_microusd: 60,
    });
    expect(
      await control.projection.retryActionForAttempt(
        result.run_id,
        "attempt-observed-overage",
      ),
    ).toBeNull();
  });

  it("durably catches up an observed overage before reserving", async () => {
    const control = await createTestControl(1, 2, 50);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 120 },
      "observed-catch-up-run-key",
      operator,
    );
    for (const [eventKind, amount] of [
      ["reserve", 50],
      ["reconcile", 60],
    ] as const) {
      await control.service.append({
        schema_version: "v1",
        kind: "budget.event",
        record_id: deterministicId("budget", result.run_id, eventKind, "initial"),
        created_at: "2026-08-16T00:00:00.000Z",
        actor: { subject: "harbor-hf-control", role: "service" },
        run_id: result.run_id,
        event_kind: eventKind,
        amount_microusd: amount,
      });
    }

    expect(
      await control.service.reserveReplacement(
        result.run_id,
        "attempt-observed-catch-up",
        "2026-08-16T00:00:01.000Z",
        50,
      ),
    ).toBe(true);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 110,
      observed_microusd: 60,
    });
  });

  it("releases failed Job reservations before pausing a repeated defect", async () => {
    const control = await createTestControl(1, 2, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 10 },
      "replacement-budget-key",
      operator,
    );
    let launches = 0;
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind !== "job.launch")
          return new NoopActions().execute(intent);
        launches += 1;
        return {
          outcome: "failed",
          observed_state: "job-create-failed",
          error_code: "jobs-api-unavailable",
        };
      },
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );

    await settle(reconciler, 12);

    expect(launches).toBe(2);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "paused",
      reserved_microusd: 0,
      terminal_tasks: 0,
      exhausted_tasks: 0,
    });

    await expect(
      control.service.runAction(
        result.run_id,
        { action: "resume", reason: "no worker repair attached", confirmed: true },
        "resume-after-shared-defect-key",
        operator,
      ),
    ).rejects.toThrow(
      "repeated infrastructure failure requires a reviewed worker repair",
    );
    await settle(reconciler, 10);
    expect(launches).toBe(2);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      status: "paused",
      reserved_microusd: 0,
      terminal_tasks: 0,
      exhausted_tasks: 0,
    });
  });

  it("never dispatches a replacement from a released reservation", async () => {
    const control = await createTestControl(1, 2, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12, start_paused: true },
      "released-replacement-reservation",
      operator,
    );
    const priorAttemptId = "attempt-released-reservation";
    const createdAt = "2026-08-16T00:00:01.000Z";
    expect(
      await control.service.reserveReplacement(
        result.run_id,
        priorAttemptId,
        createdAt,
        6,
      ),
    ).toBe(true);
    const reserveId = deterministicId(
      "budget",
      result.run_id,
      "replacement",
      priorAttemptId,
    );
    await control.service.append({
      schema_version: "v1",
      kind: "budget.event",
      record_id: deterministicId("budget", result.run_id, "job-release", reserveId),
      created_at: createdAt,
      actor: { subject: "harbor-hf-control", role: "service" },
      run_id: result.run_id,
      event_kind: "release",
      amount_microusd: 6,
    });
    expect(
      await control.service.reserveReplacement(
        result.run_id,
        priorAttemptId,
        createdAt,
        6,
      ),
    ).toBe(false);
    const replacement = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      1,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        prior_attempt_id: priorAttemptId,
        reservation_microusd: 6,
        hardware: "cpu-basic",
        max_jobs: 1,
      },
    );
    await expect(control.service.admitJobLaunch(replacement)).rejects.toThrow(
      "has no active budget reservation",
    );
  });

  it("recreates an orphan replacement reservation before dispatch after restart", async () => {
    const control = await createTestControl(1, 2, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12 },
      "orphan-replacement-reservation",
      operator,
    );
    const admissionRow = await control.projection.action(result.action_id);
    if (!admissionRow) throw new Error("admission action is missing");
    const admission = JSON.parse(admissionRow.intent_body) as ActionIntent;
    await control.service.markAdvanced(
      admission,
      await control.service.receipt(admission, {
        outcome: "completed",
        observed_state: "admitted",
      }),
    );
    const replacement = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      1,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        prior_attempt_id: "attempt-orphan-reservation",
        reservation_microusd: 6,
        hardware: "cpu-basic",
        max_jobs: 1,
      },
    );
    await control.service.writeAction(replacement);
    expect(await control.projection.run(result.run_id)).toMatchObject({
      reserved_microusd: 0,
    });

    const rebuilt = await Projection.open(`${control.root}/orphan-replacement.sqlite`);
    await rebuilt.rebuild(control.store);
    const restarted = new ControlService(
      "test",
      control.store,
      rebuilt,
      control.profiles,
    );
    let dispatches = 0;
    const reconciler = new Reconciler(
      restarted,
      rebuilt,
      {
        execute: async (intent, context): Promise<ExternalActionResult> => {
          if (intent.action_kind === "job.launch") {
            if (context?.adoption_only)
              throw new ExternalActionNotFoundError("replacement Job is absent");
            dispatches += 1;
            return {
              outcome: "created",
              observed_state: "RUNNING",
              resource_id: "job-orphan-replacement",
            };
          }
          return new NoopActions().execute(intent);
        },
      },
      new ResultPublisher(control.store, rebuilt, restarted),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await reconciler.tick();

    expect(dispatches).toBe(1);
    expect(await rebuilt.actionDispatch(replacement.action_id)).not.toBeNull();
    expect(await rebuilt.run(result.run_id)).toMatchObject({
      reserved_microusd: 6,
    });
    await rebuilt.close();
  });

  it("rejects a worker attempt without verified evidence", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "missing-worker-evidence-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      { task_id: "task-001", task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);

    await expect(
      control.service.attempt(
        {
          run_id: result.run_id,
          task_id: "task-001",
          attempt_id: "worker-attempt-missing-evidence",
          action_id: launch.action_id,
          outcome: "complete",
          replacement_eligible: false,
          evidence_digest: sha256("missing-worker-evidence"),
          evidence_path: "worker/missing-evidence",
          cost_microusd: 0,
          metrics: { reward: 1 },
          completed_at: "2026-08-16T00:00:01.000Z",
        },
        { subject: "trusted-worker", role: "service" },
      ),
    ).rejects.toThrow("attempt evidence verification failed");
    expect(
      await control.projection.attemptById("worker-attempt-missing-evidence"),
    ).toBeNull();
  });

  it("rejects an unverified worker receipt discovered directly in the store", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "direct-missing-evidence-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      { task_id: "task-001", task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);
    const attempt: AttemptReceipt = {
      schema_version: "v1",
      kind: "attempt.receipt",
      record_id: deterministicId("attempt-receipt", "direct-worker-attempt"),
      created_at: "2026-08-16T00:00:01.000Z",
      actor: { subject: "trusted-worker", role: "service" },
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "direct-worker-attempt",
      action_id: launch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      evidence_digest: sha256("missing-direct-evidence"),
      evidence_path: "worker/missing-direct-evidence",
      cost_microusd: 0,
      metrics: { reward: 1 },
    };
    await control.store.create(
      controlRecordPath(attempt),
      new TextEncoder().encode(canonicalJson(attempt)),
    );

    await expect(control.projection.sync(control.store)).rejects.toThrow(
      "worker evidence path is outside its scope",
    );
    expect(control.projection.system().ready).toBe(false);
  });

  it("requires one assigned execution task and binds its attempt", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "execution-task-binding",
      operator,
    );
    const multiple = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        worker_role: "execution",
        task_ids: ["task-001", "task-002"],
      },
    );
    await expect(control.service.writeAction(multiple)).rejects.toThrow(
      "requires exactly one task",
    );

    const missingTaskId = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      {
        worker_role: "execution",
        task_ids: ["task-001"],
      },
    );
    await expect(control.service.writeAction(missingTaskId)).rejects.toThrow(
      "task assignment is inconsistent",
    );

    const inconsistent = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      1,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["other-task"],
      },
    );
    await expect(control.service.writeAction(inconsistent)).rejects.toThrow(
      "task assignment is inconsistent",
    );

    const mismatched = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "other-task",
      0,
      {
        worker_role: "execution",
        task_id: "other-task",
        task_ids: ["other-task"],
      },
    );
    await control.service.writeAction(mismatched);
    const evidence = await putEvidenceReference(control, "mismatched-task-evidence");
    await expect(
      control.service.attempt({
        run_id: result.run_id,
        task_id: "task-001",
        attempt_id: "mismatched-task-attempt",
        action_id: mismatched.action_id,
        outcome: "complete",
        replacement_eligible: false,
        ...evidence,
        cost_microusd: 0,
        metrics: { reward: 1 },
        completed_at: "2026-08-16T00:00:01.000Z",
      }),
    ).rejects.toThrow("attempt task is outside its execution Job");
  });

  it("rejects multiple worker attempts for one action and task", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "duplicate-action-attempt-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      { task_id: "task-001", task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);
    const firstEvidence = await putWorkerEvidence(
      control,
      result.run_id,
      launch.action_id,
      "task-001",
      "worker-evidence-one",
    );
    const secondEvidence = await putWorkerEvidence(
      control,
      result.run_id,
      launch.action_id,
      "task-001",
      "worker-evidence-two",
    );
    const attempt = {
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "worker-attempt-one",
      action_id: launch.action_id,
      outcome: "complete" as const,
      replacement_eligible: false,
      ...firstEvidence,
      cost_microusd: 0,
      metrics: { reward: 1 },
      completed_at: "2026-08-16T00:00:01.000Z",
    };
    await control.service.attempt(attempt, {
      subject: "trusted-worker",
      role: "service",
    });
    await expect(
      control.service.attempt(
        {
          ...attempt,
          attempt_id: "worker-attempt-two",
          ...secondEvidence,
        },
        { subject: "trusted-worker", role: "service" },
      ),
    ).rejects.toThrow("action already has an attempt for task");
  });

  it("records worker cost after it crosses the run ceiling", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 10 },
      "cost-ceiling-key",
      operator,
    );
    await expect(
      control.service.runAction(
        result.run_id,
        {
          action: "retry_infrastructure",
          task_id: "task-001",
          confirmed: true,
        },
        "manual-retry-before-failure",
        operator,
      ),
    ).rejects.toThrow(
      "infrastructure retry requires an eligible infrastructure failure",
    );
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      { task_id: "task-001", task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);
    const evidence = await putEvidenceReference(control, "over-budget-evidence");
    await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "over-budget-attempt",
      action_id: launch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      ...evidence,
      cost_microusd: 11,
      metrics: { reward: 1 },
      completed_at: "2026-08-16T00:00:01.000Z",
    });
    expect(await control.projection.run(result.run_id)).toMatchObject({
      observed_microusd: 11,
      budget_exceeded: true,
      status: "budget-exceeded",
    });
    expect(
      await control.service.reserveReplacement(
        result.run_id,
        "attempt-after-budget-exceeded",
        "2026-08-16T00:00:02.000Z",
        1,
      ),
    ).toBe(false);
    await expect(
      control.service.runAction(
        result.run_id,
        { action: "publish", confirmed: true },
        "publish-over-budget-run",
        operator,
      ),
    ).rejects.toThrow("run cannot publish after exceeding its budget");
    const rebuilt = await Projection.open(`${control.root}/over-budget-replay.sqlite`);
    await rebuilt.rebuild(control.store);
    expect(await rebuilt.run(result.run_id)).toMatchObject({
      observed_microusd: 11,
      budget_exceeded: true,
      status: "budget-exceeded",
    });
    await rebuilt.close();
  });

  it("records publication supersession without changing either publication", async () => {
    const control = await createTestControl();
    controls.push(control);
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    const oldRun = await control.service.submit(
      submission,
      "supersession-old-run",
      operator,
    );
    await settle(reconciler, 8);
    const oldPublication = await control.projection.runPublication(oldRun.run_id);
    expect(oldPublication?.status).toBe("published");
    const oldBody = oldPublication?.body;

    const newRun = await control.service.submit(
      submission,
      "supersession-new-run",
      operator,
    );
    await settle(reconciler, 8);
    const newPublication = await control.projection.runPublication(newRun.run_id);
    expect(newPublication?.status).toBe("published");

    const supersedeAction = await control.service.runAction(
      newRun.run_id,
      {
        action: "supersede",
        publication_id: oldPublication?.publication_id,
        reason: "replacement publication validated",
        confirmed: true,
      },
      "supersede-publication-key",
      operator,
    );
    await reconciler.tick();
    expect(
      (await control.projection.action(supersedeAction.action_id))?.receipt_body,
    ).not.toBeNull();
    const repeated = await control.service.writePublicationSupersession(
      newRun.run_id,
      newPublication?.publication_id ?? "missing-publication",
      oldRun.run_id,
      oldPublication?.publication_id ?? "missing-publication",
      "replacement publication validated",
    );
    expect(repeated.record_id).toMatch(/^publication-supersession-/);
    await settle(reconciler, 2);
    expect(canonicalJson(repeated).trimEnd()).toBe(
      (
        await control.projection.publicationSupersession(
          oldPublication?.publication_id ?? "missing-publication",
        )
      )?.body,
    );

    expect(await control.projection.publicationSupersessions()).toMatchObject([
      {
        publication_id: newPublication?.publication_id,
        superseded_run_id: oldRun.run_id,
        superseded_publication_id: oldPublication?.publication_id,
      },
    ]);
    expect((await control.projection.runPublication(oldRun.run_id))?.body).toBe(
      oldBody,
    );
    const adoptedSupersession = await control.service.runAction(
      newRun.run_id,
      {
        action: "supersede",
        publication_id: oldPublication?.publication_id,
        reason: "replacement publication validated",
        confirmed: true,
      },
      "supersede-publication-key",
      operator,
    );
    expect(adoptedSupersession).toMatchObject({
      action_id: supersedeAction.action_id,
      adopted: true,
    });

    const laterRun = await control.service.submit(
      submission,
      "supersession-later-run",
      operator,
    );
    await settle(reconciler, 8);
    await expect(
      control.service.runAction(
        laterRun.run_id,
        {
          action: "supersede",
          publication_id: oldPublication?.publication_id,
          reason: "second replacement must fail",
          confirmed: true,
        },
        "duplicate-supersession-key",
        operator,
      ),
    ).rejects.toThrow("publication is already superseded");
  });

  it("rebuilds supersession after publications regardless of object path order", async () => {
    const control = await createTestControl();
    controls.push(control);
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    const published: Array<{ run_id: string; publication_id: string }> = [];
    for (const key of ["ordered-supersession-a", "ordered-supersession-b"]) {
      const run = await control.service.submit(submission, key, operator);
      await settle(reconciler, 8);
      const publication = await control.projection.runPublication(run.run_id);
      if (!publication) throw new Error("publication is missing");
      published.push({
        run_id: run.run_id,
        publication_id: publication.publication_id,
      });
    }
    const [replacement, previous] = published.sort((left, right) =>
      left.run_id.localeCompare(right.run_id),
    );
    if (!replacement || !previous) throw new Error("test publications are missing");
    await control.service.runAction(
      replacement.run_id,
      {
        action: "supersede",
        publication_id: previous.publication_id,
        reason: "verify replay order independence",
        confirmed: true,
      },
      "ordered-supersession-action",
      operator,
    );
    await settle(reconciler, 3);
    expect(replacement.run_id < previous.run_id).toBe(true);
    const rebuilt = await Projection.open(`${control.root}/supersession-order.sqlite`);

    await rebuilt.rebuild(control.store);

    expect(await rebuilt.publicationSupersessions()).toMatchObject([
      {
        run_id: replacement.run_id,
        publication_id: replacement.publication_id,
        superseded_run_id: previous.run_id,
        superseded_publication_id: previous.publication_id,
      },
    ]);
    await rebuilt.close();
  });

  it("retries publication deterministically when attempts share a timestamp", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "same-time-publication-attempts",
      operator,
    );
    const admissionRow = await control.projection.action(result.action_id);
    if (!admissionRow) throw new Error("admission action is missing");
    const admission = JSON.parse(admissionRow.intent_body) as ActionIntent;
    const admissionReceipt = await control.service.receipt(admission, {
      outcome: "completed",
      observed_state: "admitted",
    });
    await control.service.markAdvanced(admission, admissionReceipt);
    const completedAt = "2026-08-16T00:00:01.000Z";
    const launches = [0, 1].map((generation) =>
      control.service.actionIntent(
        result.run_id,
        "job.launch",
        "task-001",
        generation,
        {
          worker_role: "execution",
          task_id: "task-001",
          task_ids: ["task-001"],
        },
        undefined,
        completedAt,
      ),
    );
    const [completedLaunch, infrastructureLaunch] = launches;
    if (!completedLaunch || !infrastructureLaunch)
      throw new Error("publication test launches are missing");
    for (const launch of launches) {
      await control.service.writeAction(launch);
      const receipt = await control.service.receipt(launch, {
        outcome: "completed",
        observed_state: "COMPLETED",
      });
      await control.service.markAdvanced(launch, receipt);
    }
    const completedEvidence = await putEvidenceReference(
      control,
      "same-time-completed-attempt",
    );
    const infrastructureEvidence = await putEvidenceReference(
      control,
      "same-time-infrastructure-attempt",
    );
    const completed = await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-z",
      action_id: completedLaunch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      ...completedEvidence,
      cost_microusd: 0,
      metrics: { reward: 1 },
      completed_at: completedAt,
    });
    await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "attempt-a",
      action_id: infrastructureLaunch.action_id,
      outcome: "infrastructure",
      replacement_eligible: true,
      ...infrastructureEvidence,
      cost_microusd: 0,
      metrics: {},
      completed_at: completedAt,
    });
    await control.service.selectTerminal(completed, "worker outcome complete");
    expect(
      (await control.projection.runAttempts(result.run_id)).map(
        (attempt) => attempt.attempt_id,
      ),
    ).toEqual(["attempt-a", "attempt-z"]);
    const publisher = new ResultPublisher(
      control.store,
      control.projection,
      control.service,
    );
    const publicationWrite = vi
      .spyOn(control.service, "writePublication")
      .mockRejectedValueOnce(new Error("simulated publication crash"));
    await expect(publisher.publish(result.run_id)).rejects.toThrow(
      "simulated publication crash",
    );
    publicationWrite.mockRestore();

    const rebuilt = await Projection.open(
      `${control.root}/same-time-publication-attempts.sqlite`,
    );
    await rebuilt.rebuild(control.store);
    const restarted = new ControlService(
      "test",
      control.store,
      rebuilt,
      control.profiles,
    );
    await expect(
      new ResultPublisher(control.store, rebuilt, restarted).publish(result.run_id),
    ).resolves.toMatchObject({ publication_state: "published" });
    expect(
      (await rebuilt.runAttempts(result.run_id)).map((attempt) => attempt.attempt_id),
    ).toEqual(["attempt-a", "attempt-z"]);
    await rebuilt.close();
  });

  it("adopts a durable diagnostic publication without reading leaderboard catalogs", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "diagnostic-publication-adoption-key",
      operator,
    );
    const publisher = new ResultPublisher(
      control.store,
      control.projection,
      control.service,
    );
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      publisher,
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    const receipt = control.service.receipt.bind(control.service);
    const receiptWrite = vi
      .spyOn(control.service, "receipt")
      .mockImplementation(async (intent, actionResult) => {
        if (intent.action_kind === "publication.publish")
          throw new Error("simulated action receipt interruption");
        return receipt(intent, actionResult);
      });

    await expect(settle(reconciler)).rejects.toThrow(
      "simulated action receipt interruption",
    );
    receiptWrite.mockRestore();
    expect(await control.projection.run(result.run_id)).toMatchObject({
      publication_status: "published",
      pending_actions: 1,
    });
    const action = (await control.projection.runActions(result.run_id)).find(
      (candidate) => candidate.action_kind === "publication.publish",
    );
    expect(action?.receipt_body).toBeNull();
    if (!action) throw new Error("publication action is missing");

    const list = control.store.list.bind(control.store);
    const catalogReads = vi
      .spyOn(control.store, "list")
      .mockImplementation(async (prefix) => {
        if (prefix === "results/schema=v1/catalog/records/")
          throw new Error("adopted diagnostic publication read leaderboard catalogs");
        return list(prefix);
      });
    await reconciler.tick();

    expect(catalogReads).not.toHaveBeenCalledWith("results/schema=v1/catalog/records/");
    expect(await control.projection.action(action.action_id)).toMatchObject({
      outcome: "completed",
      observed_state: "published",
    });
    expect(await control.projection.run(result.run_id)).toMatchObject({
      publication_status: "published",
      pending_actions: 0,
    });
    const actionRecords = await control.store.list(
      `control/schema=v1/runs/${result.run_id}/actions/${action.action_id}`,
    );
    const actionKeys = actionRecords.map((record) => record.key);
    expect(actionKeys.some((key) => key.endsWith("/receipt.json"))).toBe(true);
    expect(actionKeys.some((key) => key.endsWith("/zz-advanced.json"))).toBe(true);
  });

  it("recovers publication after a crash between terminal selection and intent", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "publication-recovery-key",
      operator,
    );
    const admissionRow = await control.projection.action(result.action_id);
    if (!admissionRow) throw new Error("admission action is missing");
    const admission = JSON.parse(admissionRow.intent_body) as ActionIntent;
    const admissionReceipt = await control.service.receipt(admission, {
      outcome: "completed",
      observed_state: "admitted",
    });
    await control.service.markAdvanced(admission, admissionReceipt);
    const launch = control.service.actionIntent(
      result.run_id,
      "job.launch",
      "task-001",
      0,
      { task_id: "task-001", task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);
    const launchReceipt = await control.service.receipt(launch, {
      outcome: "completed",
      observed_state: "imported",
    });
    await control.service.markAdvanced(launch, launchReceipt);
    const publicationEvidence = await putEvidenceReference(
      control,
      "publication-recovery-evidence",
    );
    const attempt = await control.service.attempt({
      run_id: result.run_id,
      task_id: "task-001",
      attempt_id: "publication-recovery-attempt",
      action_id: launch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      ...publicationEvidence,
      cost_microusd: 0,
      metrics: { reward: 1 },
      completed_at: "2026-08-16T00:00:01.000Z",
    });
    await control.service.selectTerminal(attempt, "worker outcome complete");
    expect(await control.projection.runPublication(result.run_id)).toBeNull();
    expect(
      await control.projection.hasRunAction(result.run_id, "publication.publish"),
    ).toBe(false);
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await reconciler.tick();
    expect(
      await control.projection.hasRunAction(result.run_id, "publication.publish"),
    ).toBe(true);
    const publicationWrite = vi
      .spyOn(control.service, "writePublication")
      .mockRejectedValueOnce(new Error("simulated publication crash"));
    await expect(reconciler.tick()).rejects.toThrow("simulated publication crash");
    publicationWrite.mockRestore();
    await reconciler.tick();
    expect(await control.projection.run(result.run_id)).toMatchObject({
      publication_status: "published",
    });
  });
});

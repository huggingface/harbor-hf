import { join } from "node:path";
import type {
  ActionAdvanced,
  ActionDisposition,
  ActionIntent,
  ActionReceipt,
  AttemptReceipt,
  BudgetEvent,
  EndpointResource,
  ProfileObject,
  ProfilePromotion,
  SandboxPolicy,
  TerminalSelection,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sandboxActionResultPath,
  sha256,
  workerEvidenceObjectPath,
} from "@harbor-hf/contracts";
import { NoopActions } from "@harbor-hf/hf-adapters";
import type { TestControl } from "@harbor-hf/test-fixtures";
import { createTestControl } from "@harbor-hf/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Projection } from "../src/projection.js";
import { ResultPublisher } from "../src/publication.js";
import {
  AmbiguousExternalActionError,
  type ExternalActionContext,
  ExternalActionNotFoundError,
  type ExternalActionPort,
  type ExternalActionResult,
  Reconciler,
} from "../src/reconciler.js";
import { runIdentity, runUnique } from "../src/run-id.js";
import {
  type AttemptInput,
  ControlService,
  executionReservationCategory,
} from "../src/service.js";

const controls: TestControl[] = [];
afterEach(async () =>
  Promise.all(controls.splice(0).map((control) => control.close())),
);

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
    max_active_sandboxes: input.maximum ?? 2,
    hardware_limits: [
      {
        hardware: "cpu-basic",
        max_active_sandboxes: input.hardwareMaximum ?? 2,
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

async function appendClosedSandboxAmbiguity(
  control: TestControl,
  campaignId: string,
  taskId: string,
  label: string,
  closeMode: "historical" | "service" | "none" = "historical",
): Promise<ActionIntent> {
  const policy: SandboxPolicy = {
    image: `registry.example/sandbox@sha256:${"f".repeat(64)}`,
    hardware: "cpu-basic",
    timeout_seconds: 600,
    idle_timeout_seconds: 300,
    inference_token: "forbidden",
    reservation_microusd: 0,
    active_hourly_cost_microusd: 0,
    max_sandboxes: 1,
    max_commands: 8,
    max_command_seconds: 300,
    max_transfer_bytes: 1_048_576,
    allowed_roots: ["/app", "/tmp"],
  };
  const resourceId = `sandbox-resource-${label}`;
  const create = control.service.actionIntent(
    campaignId,
    "sandbox.create",
    `sandbox-${label}`,
    0,
    { task_id: taskId, sandbox: policy },
  );
  await control.service.writeAction(create);
  const createReceipt = await control.service.receipt(create, {
    outcome: "created",
    observed_state: "RUNNING",
    resource_id: resourceId,
  });
  await control.service.markAdvanced(create, createReceipt);
  const command = control.service.actionIntent(
    campaignId,
    "sandbox.exec",
    `sandbox-command-${label}`,
    0,
    {
      task_id: taskId,
      sandbox_create_action_id: create.action_id,
      resource_id: resourceId,
      sandbox: policy,
      command: ["true"],
      cwd: "/app",
      timeout_seconds: 30,
    },
  );
  await control.service.writeAction(command);
  await control.service.dispatchAction(command, "2026-08-20T00:00:00.000Z");
  if (closeMode === "none") return command;
  const close = control.service.actionIntent(
    campaignId,
    "sandbox.close",
    `sandbox-close-${label}`,
    0,
    {
      task_id: taskId,
      sandbox_create_action_id: create.action_id,
      resource_id: resourceId,
      sandbox: policy,
    },
  );
  await control.service.writeAction(close);
  const closeReceipt = await control.service.receipt(close, {
    outcome: "completed",
    observed_state: "CANCELED",
    resource_id: resourceId,
    cost_microusd: 0,
  });
  if (closeMode === "service") await control.service.markAdvanced(close, closeReceipt);
  else {
    const closeAdvanced: ActionAdvanced = {
      schema_version: "v1",
      kind: "action.advanced",
      record_id: deterministicId("advanced", close.action_id),
      created_at: closeReceipt.created_at,
      actor: { subject: "historical-control", role: "service" },
      action_id: close.action_id,
      campaign_id: campaignId,
    };
    await control.service.append(closeAdvanced);
  }
  return command;
}

async function appendLegacySuppressedSandboxCommand(
  control: TestControl,
  campaignId: string,
  taskId: string,
  label: string,
  receiptResourceId: string | null = null,
): Promise<{ command: ActionIntent; receipt: ActionReceipt }> {
  const command = await appendClosedSandboxAmbiguity(
    control,
    campaignId,
    taskId,
    label,
  );
  const receipt = await control.service.receipt(command, {
    outcome: "completed",
    observed_state: "suppressed-sandbox-cleanup-ambiguous",
    resource_id: receiptResourceId,
  });
  await control.service.markAdvanced(command, receipt);
  return { command, receipt };
}

function dispositionForTest(input: {
  campaignId: string;
  taskId: string;
  actionId: string;
  sourceReceipt: ActionReceipt;
  closeActionId: string;
  closeReceipt: ActionReceipt;
  idempotencyKey: string;
  reason: string;
}): ActionDisposition {
  const reasonCode = "historical_non_replay_safe_command_ambiguity" as const;
  return {
    schema_version: "v1",
    kind: "action.disposition",
    record_id: deterministicId("disposition", input.actionId),
    created_at: "2026-08-21T00:00:00.000Z",
    actor: operator,
    campaign_id: input.campaignId,
    task_id: input.taskId,
    action_id: input.actionId,
    source_receipt_id: input.sourceReceipt.record_id,
    source_receipt_digest: sha256(canonicalJson(input.sourceReceipt)),
    close_action_id: input.closeActionId,
    close_receipt_id: input.closeReceipt.record_id,
    close_receipt_digest: sha256(canonicalJson(input.closeReceipt)),
    batch_id: deterministicId(
      "disposition-batch",
      input.campaignId,
      input.taskId,
      sha256(input.idempotencyKey),
    ),
    batch_digest: sha256(
      canonicalJson({
        action_ids: [input.actionId],
        reason_code: reasonCode,
        reason: input.reason,
      }),
    ),
    batch_size: 1,
    effective_outcome: "failed",
    effective_observed_state: "AMBIGUOUS",
    effective_error_code: "sandbox_external_outcome_unknown",
    reason_code: reasonCode,
    reason: input.reason,
  };
}

async function putWorkerEvidence(
  control: TestControl,
  campaignId: string,
  actionId: string,
  taskId: string,
  label: string,
): Promise<{ evidence_digest: string; evidence_path: string }> {
  const chunk = new TextEncoder().encode(label);
  const chunkDigest = sha256(chunk);
  const chunkPath = workerEvidenceObjectPath(campaignId, actionId, taskId, chunkDigest);
  await control.store.create(chunkPath, chunk);
  const manifest = {
    schema_version: "v1",
    kind: "worker.evidence.manifest",
    campaign_id: campaignId,
    action_id: actionId,
    task_id: taskId,
    objects: [{ path: chunkPath, digest: chunkDigest, size: chunk.byteLength }],
  };
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  const manifestDigest = sha256(manifestBytes);
  const manifestPath = workerEvidenceObjectPath(
    campaignId,
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

  it("adopts idempotent submissions and completes a control smoke campaign", async () => {
    const control = await createTestControl();
    controls.push(control);
    const [first, second] = await Promise.all([
      control.service.submit(submission, "same-request-key", operator),
      control.service.submit(submission, "same-request-key", operator),
    ]);
    expect(first.campaign_id).toMatch(
      /^run-control-smoke-control-smoke-off-none-[a-f0-9]{12}$/,
    );
    expect(second).toMatchObject({ campaign_id: first.campaign_id, adopted: true });
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
    await settle(reconciler);
    expect(await control.projection.campaign(first.campaign_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 1,
      successful_tasks: 1,
      total_tasks: 1,
      publication_status: "published",
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
    ).rejects.toThrow(
      "idempotency key already belongs to a different campaign request",
    );
    expect(first.campaign_id).toMatch(/^run-control-smoke-control-smoke-off-none-/);
    expect(await control.projection.campaigns()).toHaveLength(1);
  });

  it("rejects a campaign ceiling below its launch reservation", async () => {
    const control = await createTestControl(1, 1, 50);
    controls.push(control);

    await expect(
      control.service.submit(
        { ...submission, ceiling_microusd: 49 },
        "infeasible-reservation-key",
        operator,
      ),
    ).rejects.toThrow("launch reservation exceeds the campaign ceiling");
    expect(await control.projection.campaigns()).toEqual([]);
    expect(await control.projection.pendingActions()).toEqual([]);
  });

  it("enforces the immutable launch-policy campaign ceiling before durable state", async () => {
    const control = await createTestControl(1, 1, 0, true, "forbidden", 100);
    controls.push(control);

    const lower = await control.service.submit(
      { ...submission, ceiling_microusd: 80 },
      "profile-ceiling-lower-key",
      operator,
    );
    const lowerLock = await control.projection.campaignLock(lower.campaign_id);
    expect(lowerLock).toMatchObject({ ceiling_microusd: 80 });
    expect(
      lowerLock?.profiles.find((profile) => profile.kind === "launch_policy")?.spec,
    ).toMatchObject({ max_campaign_ceiling_microusd: 100 });
    expect(
      await control.service.submit(
        { ...submission, ceiling_microusd: 80 },
        "profile-ceiling-lower-key",
        operator,
      ),
    ).toMatchObject({ campaign_id: lower.campaign_id, adopted: true });

    const exact = await control.service.submit(
      { ...submission, ceiling_microusd: 100 },
      "profile-ceiling-exact-key",
      operator,
    );
    expect(await control.projection.campaignLock(exact.campaign_id)).toMatchObject({
      ceiling_microusd: 100,
    });

    const overKey = "profile-ceiling-over-key";
    const overCampaignId = runIdentity({
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
    ).rejects.toThrow("campaign ceiling exceeds the launch policy maximum");
    expect(await control.projection.campaignRequest(overCampaignId)).toBeNull();
    expect(await control.projection.campaignLock(overCampaignId)).toBeNull();
    expect(await control.projection.campaignActions(overCampaignId)).toEqual([]);

    const corrected = await control.service.submit(
      { ...submission, ceiling_microusd: 100 },
      overKey,
      operator,
    );
    expect(corrected.campaign_id).toBe(overCampaignId);
    expect(await control.projection.campaignLock(overCampaignId)).toMatchObject({
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
      inference_token: "forbidden",
    });
    expect(launchPayload).not.toHaveProperty("requires_hf_token");
    expect(launchPayload).not.toHaveProperty("mount_bucket");
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 1,
      publication_status: "published",
    });
  });

  it("copies locked inference limits into the worker launch", async () => {
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
      inference_token: "required",
      inference_max_requests: 64,
      inference_max_concurrency: 4,
      inference_timeout_seconds: 600,
      inference_max_output_tokens: 32768,
    });
  });

  it("repairs deterministic submission records after partial writes", async () => {
    const source = await createTestControl();
    controls.push(source);
    const key = "partial-submission-key";
    const submitted = await source.service.submit(submission, key, operator);
    const request = await source.projection.campaignRequest(submitted.campaign_id);
    const lock = await source.projection.campaignLock(submitted.campaign_id);
    if (!request || !lock) throw new Error("source submission records are missing");

    for (const partial of [request, lock]) {
      const control = await createTestControl();
      controls.push(control);
      await control.service.append(partial);
      const path = controlRecordPath(partial);
      const before = await control.projection.objectDigest(path);
      const recovered = await control.service.submit(submission, key, operator);
      expect(recovered).toMatchObject({
        campaign_id: submitted.campaign_id,
        adopted: true,
      });
      expect(await control.projection.objectDigest(path)).toBe(before);
      expect(
        await control.projection.campaignRequest(submitted.campaign_id),
      ).not.toBeNull();
      expect(
        await control.projection.campaignLock(submitted.campaign_id),
      ).not.toBeNull();
      expect(await control.projection.action(recovered.action_id)).not.toBeNull();
    }
  });

  it("discovers a durable worker receipt after a missed callback", async () => {
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
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      {
        task_ids: ["task-001"],
        max_infrastructure_attempts: 1,
        success_without_worker_receipt: false,
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
      control.service.actionIntent(result.campaign_id, "job.observe", "job-one", 0, {
        ...launch.payload,
        resource_id: "job-one",
        launch_action_id: launch.action_id,
        not_before: "2026-08-16T00:00:00.000Z",
      }),
    );
    const evidence = await putWorkerEvidence(
      control,
      result.campaign_id,
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
      campaign_id: result.campaign_id,
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
              observed_state: "STOPPED",
              resource_id: "job-one",
            }
          : new NoopActions().execute(intent),
    };
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      external,
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler);
    expect(await control.projection.campaignAttempts(result.campaign_id)).toMatchObject(
      [{ attempt_id: attempt.attempt_id, outcome: "complete" }],
    );
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 1,
      publication_status: "published",
    });
  });

  it("adopts durable action records while a projection catches up", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "durable-action-adoption-key",
      operator,
    );
    const first = control.service.actionIntent(
      result.campaign_id,
      "job.launch",
      "durable-action-adoption",
      0,
      {
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
      result.campaign_id,
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
    const before = await control.projection.campaign(result.campaign_id);
    const rebuilt = await Projection.open(`${control.root}/rebuilt.sqlite`);
    await rebuilt.rebuild(control.store);
    expect(await rebuilt.campaign(result.campaign_id)).toEqual(before);
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
    await control.service.campaignAction(
      result.campaign_id,
      { action: "cancel", confirmed: true },
      "cancel-action-key",
      operator,
    );
    await settle(reconciler);
    expect(
      execute.mock.calls.some(([intent]) => intent.action_kind === "job.launch"),
    ).toBe(false);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "cancelled",
      terminal_tasks: 1,
      publication_status: null,
    });
  });

  it("cancels active remote Jobs before sealing a cancelled campaign", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
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
    await control.service.campaignAction(
      result.campaign_id,
      { action: "cancel", confirmed: true },
      "cancel-active-job-action",
      operator,
    );
    await settle(reconciler, 15);
    expect(observedKinds).toContain("job.cancel");
    expect(await control.projection.campaignAttempts(result.campaign_id)).toMatchObject(
      [{ outcome: "cancelled", replacement_eligible: 0 }],
    );
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "cancelled",
      terminal_tasks: 1,
      pending_actions: 0,
      publication_status: null,
    });
  });

  it("starts paused and reserves each resumed execution within the ceiling", async () => {
    const control = await createTestControl(3, 1, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12, start_paused: true },
      "paused-campaign-key",
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
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "paused",
      paused: true,
      terminal_tasks: 0,
      reserved_microusd: 0,
    });

    await control.service.campaignAction(
      result.campaign_id,
      { action: "resume", task_limit: 1, confirmed: true },
      "resume-one-task-key",
      operator,
    );
    await settle(reconciler, 8);
    expect(launches).toEqual([["task-001"]]);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      terminal_tasks: 1,
      paused: false,
      reserved_microusd: 0,
    });

    await control.service.campaignAction(
      result.campaign_id,
      { action: "pause", confirmed: true },
      "pause-after-canary-key",
      operator,
    );
    await settle(reconciler, 3);
    await control.service.campaignAction(
      result.campaign_id,
      { action: "resume", confirmed: true },
      "resume-then-pause-key",
      operator,
    );
    await control.service.campaignAction(
      result.campaign_id,
      { action: "pause", confirmed: true },
      "pause-before-resume-dispatch-key",
      operator,
    );
    await settle(reconciler, 5);
    expect(launches).toEqual([["task-001"]]);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "paused",
      reserved_microusd: 0,
      pending_actions: 0,
    });
    await control.service.campaignAction(
      result.campaign_id,
      { action: "resume", confirmed: true },
      "resume-remaining-key",
      operator,
    );
    await settle(reconciler, 10);

    expect(launches).toEqual([["task-001"], ["task-002", "task-003"]]);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 3,
      admissible_tasks: 3,
      reserved_microusd: 0,
      publication_status: "published",
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
        result.campaign_id,
        executionReservationCategory(["task-001"]),
        String(generation),
      ),
      created_at: createdAt,
      actor: { subject: "harbor-hf-control", role: "service" },
      campaign_id: result.campaign_id,
      event_kind: "reserve",
      amount_microusd: 6,
    });
    const launch = control.service.actionIntent(
      result.campaign_id,
      "job.launch",
      "task-001",
      generation,
      {
        worker_role: "execution",
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
      result.campaign_id,
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

    await control.service.campaignAction(
      result.campaign_id,
      { action: "resume", task_limit: 1, confirmed: true },
      "historical-job-reservation-resume-key",
      operator,
    );
    expect(
      await control.service.reconcileTerminalJobReservations(result.campaign_id),
    ).toBe(0);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      reserved_microusd: 6,
      pending_actions: 1,
    });
  });

  it("orders same-millisecond pause and resume actions causally", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "same-millisecond-lifecycle-campaign",
      operator,
    );
    const fixed = new Date("2026-08-22T12:00:00.000Z");
    const clock = vi.spyOn(control.service.clock, "now").mockReturnValue(fixed);
    const pause = await control.service.campaignAction(
      result.campaign_id,
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
    const resume = await control.service.campaignAction(
      result.campaign_id,
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
    expect(await control.projection.campaignPaused(result.campaign_id)).toBe(false);
  });

  it("reuses released Job reservations within the campaign ceiling", async () => {
    const control = await createTestControl(2, 1, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 6, start_paused: true },
      "paused-ceiling-campaign-key",
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
    await control.service.campaignAction(
      result.campaign_id,
      { action: "resume", task_limit: 1, confirmed: true },
      "paused-ceiling-canary-key",
      operator,
    );
    await settle(reconciler, 8);
    await control.service.campaignAction(
      result.campaign_id,
      { action: "pause", confirmed: true },
      "paused-ceiling-pause-key",
      operator,
    );
    await settle(reconciler, 3);

    await control.service.campaignAction(
      result.campaign_id,
      { action: "resume", confirmed: true },
      "paused-ceiling-second-resume-key",
      operator,
    );
    await settle(reconciler, 10);
    expect(launches).toEqual([["task-001"], ["task-002"]]);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      paused: false,
      terminal_tasks: 2,
      reserved_microusd: 0,
      pending_actions: 0,
    });
  });

  it("defers an invalid active attempt replacement while paused", async () => {
    const control = await createTestControl(1, 2, 6, false, "forbidden", undefined, [
      "input_tokens",
      "output_tokens",
    ]);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12 },
      "pause-invalid-attempt-key",
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
            resource_id: `pause-invalid-job-${launches}`,
          };
        }
        if (intent.action_kind === "job.observe") {
          const launchActionId = String(intent.payload.launch_action_id);
          if (
            !(await control.projection.attemptForActionTask(launchActionId, "task-001"))
          ) {
            const evidence = await putEvidenceReference(
              control,
              `pause-invalid-evidence-${launches}`,
            );
            await control.service.attempt({
              campaign_id: result.campaign_id,
              task_id: "task-001",
              attempt_id: `pause-invalid-attempt-${launches}`,
              action_id: launchActionId,
              outcome: launches === 1 ? "agent" : "complete",
              replacement_eligible: false,
              ...evidence,
              cost_microusd: 0,
              metrics:
                launches === 1
                  ? { input_tokens: 0, output_tokens: 0 }
                  : { input_tokens: 8, output_tokens: 2, reward: 1 },
              completed_at: `2026-08-16T00:00:0${launches}.000Z`,
            });
          }
          return {
            outcome: "completed",
            observed_state: "COMPLETED",
            resource_id: `pause-invalid-job-${launches}`,
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

    await settle(reconciler, 2);
    await control.service.campaignAction(
      result.campaign_id,
      { action: "pause", confirmed: true },
      "pause-invalid-boundary-key",
      operator,
    );
    await settle(reconciler, 6);

    expect(launches).toBe(1);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "paused",
      paused: true,
      terminal_tasks: 0,
      reserved_microusd: 0,
      pending_actions: 0,
    });
    expect(
      (await control.projection.campaignActions(result.campaign_id)).filter(
        (action) =>
          action.action_kind === "job.launch" &&
          JSON.parse(action.intent_body).payload.prior_attempt_id,
      ),
    ).toHaveLength(0);

    await control.service.campaignAction(
      result.campaign_id,
      { action: "resume", confirmed: true },
      "resume-invalid-attempt-key",
      operator,
    );
    await settle(reconciler, 10);

    expect(launches).toBe(2);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      admissible_tasks: 1,
      reserved_microusd: 0,
      publication_status: "published",
    });
  });

  it("does not cancel a remote Job that is already in ERROR", async () => {
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
        observation_interval_ms: 0,
        batch_size: 16,
        dispatch_adoption_delay_ms: 0,
      },
    );
    await reconciler.tick();
    await reconciler.tick();
    await control.service.campaignAction(
      result.campaign_id,
      { action: "cancel", reason: "operator cancellation", confirmed: true },
      "cancel-error-job-action",
      operator,
    );

    await settle(reconciler, 12);

    expect(observedKinds).not.toContain("job.cancel");
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "cancelled",
      terminal_tasks: 1,
    });
  });

  it("suppresses a granted create when cancellation arrives before dispatch", async () => {
    const control = await createTestControl();
    controls.push(control);
    await configureCapacity(control, { maximum: 1, hardwareMaximum: 1, burst: 1 });
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 1_000 },
      "capacity-cancel-before-dispatch",
      operator,
    );
    const policy: SandboxPolicy = {
      image: `registry.example/sandbox@sha256:${"d".repeat(64)}`,
      hardware: "cpu-basic",
      timeout_seconds: 3_600,
      idle_timeout_seconds: 600,
      inference_token: "forbidden",
      reservation_microusd: 100,
      active_hourly_cost_microusd: 0,
      max_sandboxes: 1,
      max_commands: 8,
      max_command_seconds: 600,
      max_transfer_bytes: 1_048_576,
      allowed_roots: ["/app", "/logs"],
    };
    const create = control.service.actionIntent(
      result.campaign_id,
      "sandbox.create",
      "task-001",
      0,
      { task_id: "task-001", sandbox: policy },
    );
    await expect(control.service.admitSandboxCreate(create, 1)).resolves.toEqual(
      expect.objectContaining({ status: "admitted", dispatch_created: false }),
    );
    const cancel = control.service.actionIntent(
      result.campaign_id,
      "campaign.cancel",
      "campaign",
      0,
      { reason: "test cancellation" },
    );
    await control.service.writeAction(cancel);

    await expect(control.service.admitSandboxCreate(create, 1)).resolves.toEqual(
      expect.objectContaining({
        status: "rejected",
        limiting_factor: "campaign_cancelled",
      }),
    );
    expect(await control.projection.actionDispatch(create.action_id)).toBeNull();
    expect(
      await control.projection.sandboxCapacityRelease(create.action_id),
    ).toMatchObject({ release_reason: "create_failed" });
  });

  it("does not count a definitive no-resource legacy create as active", async () => {
    const control = await createTestControl(2);
    controls.push(control);
    await configureCapacity(control, { maximum: 1, hardwareMaximum: 1, burst: 1 });
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 1_000 },
      "capacity-legacy-no-resource",
      operator,
    );
    const policy: SandboxPolicy = {
      image: `registry.example/sandbox@sha256:${"d".repeat(64)}`,
      hardware: "cpu-basic",
      timeout_seconds: 3_600,
      idle_timeout_seconds: 600,
      inference_token: "forbidden",
      reservation_microusd: 100,
      active_hourly_cost_microusd: 0,
      max_sandboxes: 1,
      max_commands: 8,
      max_command_seconds: 600,
      max_transfer_bytes: 1_048_576,
      allowed_roots: ["/app", "/logs"],
    };
    control.service.configureCapacityProfile(null);
    const legacy = control.service.actionIntent(
      result.campaign_id,
      "sandbox.create",
      "task-001",
      0,
      { task_id: "task-001", sandbox: policy },
    );
    await control.service.writeAction(legacy);
    await control.service.reserveSandbox(
      result.campaign_id,
      legacy.action_id,
      legacy.created_at,
      policy.reservation_microusd,
    );
    await control.service.dispatchAction(legacy, legacy.created_at);
    const receipt = await control.service.receipt(legacy, {
      outcome: "completed",
      observed_state: "suppressed-cancelled-not-found",
      resource_id: null,
    });
    await control.service.markAdvanced(legacy, receipt);
    control.service.configureCapacityProfile("current");
    const next = control.service.actionIntent(
      result.campaign_id,
      "sandbox.create",
      "task-002",
      0,
      { task_id: "task-002", sandbox: policy },
    );

    await expect(control.service.admitSandboxCreate(next, 1)).resolves.toEqual(
      expect.objectContaining({ status: "admitted" }),
    );
  });

  it("serializes namespace admission and releases capacity after verified close", async () => {
    const control = await createTestControl(2);
    controls.push(control);
    await configureCapacity(control, { maximum: 1, hardwareMaximum: 1, burst: 2 });
    const first = await control.service.submit(
      { ...submission, ceiling_microusd: 1_000 },
      "capacity-first",
      operator,
    );
    const second = await control.service.submit(
      { ...submission, ceiling_microusd: 1_000 },
      "capacity-second",
      operator,
    );
    const policy: SandboxPolicy = {
      image: `registry.example/sandbox@sha256:${"d".repeat(64)}`,
      hardware: "cpu-basic",
      timeout_seconds: 3_600,
      idle_timeout_seconds: 600,
      inference_token: "forbidden",
      reservation_microusd: 100,
      active_hourly_cost_microusd: 0,
      max_sandboxes: 2,
      max_commands: 8,
      max_command_seconds: 600,
      max_transfer_bytes: 1_048_576,
      allowed_roots: ["/app", "/logs"],
    };
    const create = (campaignId: string, taskId: string) =>
      control.service.actionIntent(campaignId, "sandbox.create", taskId, 0, {
        task_id: taskId,
        sandbox: policy,
      });
    const firstIntent = create(first.campaign_id, "task-001");
    const secondIntent = create(second.campaign_id, "task-001");

    await expect(control.service.admitSandboxCreate(firstIntent, 2)).resolves.toEqual(
      expect.objectContaining({ status: "admitted" }),
    );
    await expect(control.service.admitSandboxCreate(secondIntent, 2)).resolves.toEqual(
      expect.objectContaining({
        status: "deferred",
        limiting_factor: "namespace_sandbox_capacity",
      }),
    );
    expect(
      await control.projection.sandboxAdmission(firstIntent.action_id),
    ).not.toBeNull();
    expect(
      await control.projection.sandboxAdmission(secondIntent.action_id),
    ).toBeNull();
    await expect(control.service.admitSandboxCreate(firstIntent, 2)).resolves.toEqual(
      expect.objectContaining({ status: "admitted" }),
    );
    expect(await control.projection.activeSandboxAdmissions("test")).toHaveLength(1);

    const createReceipt = await control.service.receipt(firstIntent, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: "sandbox-capacity-resource",
    });
    await control.service.markAdvanced(firstIntent, createReceipt);
    const close = control.service.actionIntent(
      first.campaign_id,
      "sandbox.close",
      "sandbox-capacity-resource",
      0,
      {
        task_id: "task-001",
        sandbox_create_action_id: firstIntent.action_id,
        resource_id: "sandbox-capacity-resource",
        sandbox: policy,
      },
    );
    await control.service.writeAction(close);
    const closeReceipt = await control.service.receipt(close, {
      outcome: "completed",
      observed_state: "CANCELED",
      resource_id: "sandbox-capacity-resource",
      cost_microusd: 0,
    });
    await control.service.markAdvanced(close, closeReceipt);

    expect(
      await control.projection.sandboxCapacityRelease(firstIntent.action_id),
    ).toMatchObject({ release_reason: "sandbox_closed" });
    await expect(control.service.admitSandboxCreate(secondIntent, 2)).resolves.toEqual(
      expect.objectContaining({ status: "admitted" }),
    );
    const rebuilt = await Projection.open(join(control.root, "capacity-replay.sqlite"));
    await rebuilt.rebuild(control.store);
    expect(await rebuilt.sandboxCapacityRelease(firstIntent.action_id)).toMatchObject({
      release_reason: "sandbox_closed",
    });
    expect(await rebuilt.activeSandboxAdmissions("test")).toHaveLength(1);
    await rebuilt.close();
  });

  it("serializes the campaign-wide active Sandbox limit", async () => {
    const control = await createTestControl(2);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 1_000 },
      "sandbox-limit-key",
      operator,
    );
    const policy: SandboxPolicy = {
      image: `registry.example/sandbox@sha256:${"d".repeat(64)}`,
      hardware: "cpu-basic",
      timeout_seconds: 3_600,
      idle_timeout_seconds: 600,
      inference_token: "forbidden",
      reservation_microusd: 100,
      active_hourly_cost_microusd: 0,
      max_sandboxes: 1,
      max_commands: 8,
      max_command_seconds: 600,
      max_transfer_bytes: 1_048_576,
      allowed_roots: ["/app", "/logs"],
    };
    const creates = ["task-001", "task-002"].map((taskId) =>
      control.service.actionIntent(result.campaign_id, "sandbox.create", taskId, 0, {
        task_id: taskId,
        sandbox: policy,
      }),
    );

    const admissions = await Promise.allSettled(
      creates.map((intent) => control.service.admitSandboxCreate(intent, 1)),
    );
    expect(admissions.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(admissions.filter((item) => item.status === "rejected")).toHaveLength(1);
    const winnerIndex = admissions.findIndex((item) => item.status === "fulfilled");
    const winner = creates[winnerIndex];
    const loser = creates[1 - winnerIndex];
    if (!winner || !loser) throw new Error("Sandbox admission result is incomplete");
    expect(
      await control.service.reserveSandbox(
        result.campaign_id,
        winner.action_id,
        winner.created_at,
        policy.reservation_microusd,
      ),
    ).toBe(true);
    const createReceipt = await control.service.receipt(winner, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: "sandbox-limit-resource",
    });
    await control.service.markAdvanced(winner, createReceipt);
    const close = control.service.actionIntent(
      result.campaign_id,
      "sandbox.close",
      "sandbox-limit-resource",
      0,
      {
        task_id: winner.payload.task_id,
        sandbox_create_action_id: winner.action_id,
        resource_id: "sandbox-limit-resource",
        sandbox: policy,
      },
    );
    await control.service.writeAction(close);
    const failedCloseReceipt = await control.service.receipt(close, {
      outcome: "failed",
      observed_state: "ERROR",
      resource_id: "sandbox-limit-resource",
      error_code: "sandbox-api-unavailable",
    });
    await control.service.markAdvanced(close, failedCloseReceipt);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      reserved_microusd: 100,
    });
    await expect(control.service.admitSandboxCreate(loser, 1)).rejects.toThrow(
      "Sandbox count exceeds immutable policy",
    );

    const recoveredClose = control.service.actionIntent(
      result.campaign_id,
      "sandbox.close",
      "sandbox-limit-resource",
      1,
      close.payload,
    );
    await control.service.writeAction(recoveredClose);
    const recoveredCloseReceipt = await control.service.receipt(recoveredClose, {
      outcome: "completed",
      observed_state: "CANCELED",
      resource_id: "sandbox-limit-resource",
      cost_microusd: 0,
    });
    await control.service.markAdvanced(recoveredClose, recoveredCloseReceipt);

    await expect(control.service.admitSandboxCreate(loser, 1)).resolves.toEqual(
      expect.objectContaining({
        status: "admitted",
        dispatch_created: true,
      }),
    );
  });

  it("closes active Sandboxes before sealing campaign cancellation", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "sandbox-cancellation-key",
      operator,
    );
    const policy: SandboxPolicy = {
      image: `registry.example/sandbox@sha256:${"a".repeat(64)}`,
      hardware: "cpu-basic",
      timeout_seconds: 3_600,
      idle_timeout_seconds: 600,
      inference_token: "forbidden",
      reservation_microusd: 0,
      active_hourly_cost_microusd: 0,
      max_sandboxes: 1,
      max_commands: 8,
      max_command_seconds: 600,
      max_transfer_bytes: 1_048_576,
      allowed_roots: ["/app", "/logs"],
    };
    const create = control.service.actionIntent(
      result.campaign_id,
      "sandbox.create",
      "control-smoke-task",
      0,
      { task_id: "control-smoke-task", sandbox: policy },
    );
    await control.service.writeAction(create);
    const observed: string[] = [];
    let closeAttempts = 0;
    const noop = new NoopActions();
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        observed.push(intent.action_kind);
        if (intent.action_kind === "sandbox.create")
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: "sandbox-cancellation-resource",
          };
        if (intent.action_kind === "sandbox.close") {
          closeAttempts += 1;
          return closeAttempts === 1
            ? {
                outcome: "failed",
                observed_state: "ERROR",
                resource_id: "sandbox-cancellation-resource",
                error_code: "sandbox-api-unavailable",
              }
            : {
                outcome: "completed",
                observed_state: "CANCELED",
                resource_id: "sandbox-cancellation-resource",
              };
        }
        if (intent.action_kind === "job.cancel")
          return {
            outcome: "completed",
            observed_state: "STOPPED",
            resource_id: "job-remote",
          };
        return noop.execute(intent);
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
    expect(observed).not.toContain("sandbox.create");
    expect(
      await control.service.reserveSandbox(
        result.campaign_id,
        create.action_id,
        create.created_at,
        policy.reservation_microusd,
      ),
    ).toBe(true);
    await reconciler.tick();
    expect(observed).toContain("sandbox.create");
    const command = control.service.actionIntent(
      result.campaign_id,
      "sandbox.exec",
      "sandbox-cancellation-resource",
      0,
      {
        task_id: "control-smoke-task",
        sandbox_create_action_id: create.action_id,
        resource_id: "sandbox-cancellation-resource",
        sandbox: policy,
        command: ["python", "worker.py"],
        cwd: "/app",
        timeout_seconds: 60,
      },
    );
    await control.service.writeAction(command);
    await control.service.dispatchAction(command, "2026-08-18T00:01:00Z");
    await control.service.campaignAction(
      result.campaign_id,
      { action: "cancel", reason: "operator cancellation", confirmed: true },
      "sandbox-cancel-action-key",
      operator,
    );

    await settle(reconciler, 24);

    expect(observed).toContain("sandbox.close");
    const closes = (
      await control.projection.campaignActions(result.campaign_id)
    ).filter((action) => action.action_kind === "sandbox.close");
    expect(closes).toHaveLength(2);
    expect(closes.some((action) => action.outcome === "failed")).toBe(true);
    const close = closes.find((action) => action.outcome === "completed");
    expect(close?.observed_state).toBe("CANCELED");
    expect(
      close ? await control.projection.actionDispatch(close.action_id) : null,
    ).not.toBeNull();
    const commandReceipt = JSON.parse(
      (await control.projection.action(command.action_id))?.receipt_body ?? "null",
    );
    expect(commandReceipt).toMatchObject({
      outcome: "failed",
      observed_state: "AMBIGUOUS",
      error_code: "sandbox_external_outcome_unknown",
    });
    const campaign = await control.projection.campaign(result.campaign_id);
    expect(campaign).toMatchObject({
      status: "cancelled",
      terminal_tasks: 1,
    });
  });

  it("allows Sandbox cleanup after its task becomes terminal", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "terminal-sandbox-cleanup-key",
      operator,
    );
    const lock = await control.projection.campaignLock(result.campaign_id);
    const taskId = lock?.tasks[0]?.task_id;
    if (!taskId) throw new Error("campaign task is missing");
    await control.service.campaignAction(
      result.campaign_id,
      { action: "cancel", reason: "test terminal cleanup", confirmed: true },
      "terminal-sandbox-cancel-key",
      operator,
    );
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler, 12);
    expect(
      (await control.projection.task(result.campaign_id, taskId))?.task,
    ).toMatchObject({ terminal_outcome: "cancelled" });
    const policy: SandboxPolicy = {
      image: `registry.example/sandbox@sha256:${"e".repeat(64)}`,
      hardware: "cpu-basic",
      timeout_seconds: 600,
      idle_timeout_seconds: 300,
      inference_token: "forbidden",
      reservation_microusd: 0,
      active_hourly_cost_microusd: 0,
      max_sandboxes: 1,
      max_commands: 8,
      max_command_seconds: 300,
      max_transfer_bytes: 1_048_576,
      allowed_roots: ["/app", "/tmp"],
    };
    const cleanup = control.service.actionIntent(
      result.campaign_id,
      "sandbox.close",
      "terminal-sandbox-resource",
      0,
      {
        task_id: taskId,
        sandbox_create_action_id: "terminal-sandbox-create",
        resource_id: "terminal-sandbox-resource",
        sandbox: policy,
      },
    );
    await expect(control.service.writeAction(cleanup)).resolves.toBeUndefined();
    const newWork = control.service.actionIntent(
      result.campaign_id,
      "sandbox.exec",
      "terminal-sandbox-resource",
      0,
      {
        task_id: taskId,
        sandbox_create_action_id: "terminal-sandbox-create",
        resource_id: "terminal-sandbox-resource",
        sandbox: policy,
        command: ["true"],
        cwd: "/app",
        timeout_seconds: 30,
      },
    );
    await expect(control.service.writeAction(newWork)).rejects.toThrow(
      "terminal task cannot receive action",
    );
  });

  it("closes active Sandboxes before normal publication", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "sandbox-publication-key",
      operator,
    );
    const policy: SandboxPolicy = {
      image: `registry.example/sandbox@sha256:${"c".repeat(64)}`,
      hardware: "cpu-basic",
      timeout_seconds: 3_600,
      idle_timeout_seconds: 600,
      inference_token: "forbidden",
      reservation_microusd: 0,
      active_hourly_cost_microusd: 0,
      max_sandboxes: 1,
      max_commands: 8,
      max_command_seconds: 600,
      max_transfer_bytes: 1_048_576,
      allowed_roots: ["/app", "/logs"],
    };
    const create = control.service.actionIntent(
      result.campaign_id,
      "sandbox.create",
      "control-smoke-task",
      0,
      { task_id: "control-smoke-task", sandbox: policy },
    );
    await control.service.writeAction(create);
    expect(
      await control.service.reserveSandbox(
        result.campaign_id,
        create.action_id,
        create.created_at,
        0,
      ),
    ).toBe(true);
    const observed: string[] = [];
    const noop = new NoopActions();
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        observed.push(intent.action_kind);
        if (intent.action_kind === "sandbox.create")
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: "sandbox-publication-resource",
          };
        if (intent.action_kind === "sandbox.close")
          return {
            outcome: "completed",
            observed_state: "CANCELED",
            resource_id: "sandbox-publication-resource",
            cost_microusd: 0,
          };
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

    await settle(reconciler, 24);

    expect(observed).toContain("sandbox.close");
    const close = (await control.projection.campaignActions(result.campaign_id)).find(
      (action) => action.action_kind === "sandbox.close",
    );
    expect(close?.observed_state).toBe("CANCELED");
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      publication_status: "published",
    });
  });

  it("proves an ambiguous Sandbox create absent before cancellation seals", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 1_000 },
      "ambiguous-sandbox-cancellation-key",
      operator,
    );
    const policy: SandboxPolicy = {
      image: `registry.example/sandbox@sha256:${"b".repeat(64)}`,
      hardware: "cpu-basic",
      timeout_seconds: 3_600,
      idle_timeout_seconds: 600,
      inference_token: "forbidden",
      reservation_microusd: 1_000,
      active_hourly_cost_microusd: 0,
      max_sandboxes: 1,
      max_commands: 8,
      max_command_seconds: 600,
      max_transfer_bytes: 1_048_576,
      allowed_roots: ["/app", "/logs"],
    };
    const create = control.service.actionIntent(
      result.campaign_id,
      "sandbox.create",
      "control-smoke-task",
      0,
      { task_id: "control-smoke-task", sandbox: policy },
    );
    await control.service.writeAction(create);
    expect(
      await control.service.reserveSandbox(
        result.campaign_id,
        create.action_id,
        create.created_at,
        1_000,
      ),
    ).toBe(true);
    const noop = new NoopActions();
    const external: ExternalActionPort = {
      execute: async (intent, context): Promise<ExternalActionResult> => {
        if (intent.action_kind === "sandbox.create") {
          if (context?.adoption_only)
            throw new ExternalActionNotFoundError("Sandbox create was absent");
          throw new AmbiguousExternalActionError("Sandbox create disconnected");
        }
        return noop.execute(intent);
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
    expect(
      (await control.projection.action(create.action_id))?.receipt_body,
    ).toBeNull();
    await control.service.campaignAction(
      result.campaign_id,
      { action: "cancel", reason: "operator cancellation", confirmed: true },
      "ambiguous-sandbox-cancel-action",
      operator,
    );

    await settle(reconciler, 24);

    expect(await control.projection.action(create.action_id)).toMatchObject({
      outcome: "completed",
      observed_state: "suppressed-cancelled-not-found",
      resource_id: null,
    });
    expect(
      (await control.projection.campaignActions(result.campaign_id)).some(
        (action) => action.action_kind === "sandbox.close",
      ),
    ).toBe(false);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "cancelled",
      terminal_tasks: 1,
      reserved_microusd: 0,
      observed_microusd: 0,
    });
  });

  it("turns failed Job launches into bounded infrastructure attempts", async () => {
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
    await settle(reconciler, 10);
    expect(launches).toBe(1);
    expect(await control.projection.unadvancedActions()).toHaveLength(0);
    expect(await control.projection.campaignAttempts(result.campaign_id)).toMatchObject(
      [{ outcome: "infrastructure", replacement_eligible: 1 }],
    );
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "failed",
      terminal_tasks: 1,
      exhausted_tasks: 1,
      publication_status: null,
    });
  });

  it("retries zero-token outcomes and fails closed after the attempt limit", async () => {
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
              campaign_id: result.campaign_id,
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

    expect(launches).toBe(2);
    expect(await control.projection.campaignAttempts(result.campaign_id)).toHaveLength(
      2,
    );
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "failed",
      terminal_tasks: 1,
      admissible_tasks: 0,
      invalid_selected_tasks: 0,
      exhausted_tasks: 1,
      publication_status: null,
    });
    expect(
      await control.projection.taskExhaustion(result.campaign_id, "task-001"),
    ).toMatchObject({ attempt_count: 2 });
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
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      { task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);
    const evidence = await putEvidenceReference(
      control,
      "historical-invalid-selection-evidence",
    );
    const attempt = await control.service.attempt({
      campaign_id: result.campaign_id,
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
      campaign_id: result.campaign_id,
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

    expect(await rebuilt.campaign(result.campaign_id)).toMatchObject({
      status: "completed-invalid",
      terminal_tasks: 1,
      admissible_tasks: 0,
      invalid_selected_tasks: 1,
      publication_status: null,
    });
    await rebuilt.close();
  });

  it("retries a worker-reported cancellation without selecting it", async () => {
    const control = await createTestControl(1, 2, 0, false, "forbidden", undefined, [
      "input_tokens",
      "output_tokens",
    ]);
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "worker-cancelled-attempt-key",
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
            resource_id: `job-cancelled-${launches}`,
          };
        }
        if (intent.action_kind === "job.observe") {
          const launchActionId = String(intent.payload.launch_action_id);
          if (
            !(await control.projection.attemptForActionTask(launchActionId, "task-001"))
          ) {
            const evidence = await putEvidenceReference(
              control,
              `worker-cancelled-evidence-${launches}`,
            );
            await control.service.attempt({
              campaign_id: result.campaign_id,
              task_id: "task-001",
              attempt_id: `worker-cancelled-attempt-${launches}`,
              action_id: launchActionId,
              outcome: launches === 1 ? "cancelled" : "complete",
              replacement_eligible: false,
              ...evidence,
              cost_microusd: 0,
              metrics:
                launches === 1
                  ? { input_tokens: 0, output_tokens: 0 }
                  : { input_tokens: 10, output_tokens: 2, reward: 1 },
              completed_at: `2026-08-16T00:00:0${launches}.000Z`,
            });
          }
          return {
            outcome: "completed",
            observed_state: "COMPLETED",
            resource_id: `job-cancelled-${launches}`,
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

    expect(launches).toBe(2);
    const task = await control.projection.task(result.campaign_id, "task-001");
    expect(task?.task.selected_attempt_id).toBe("worker-cancelled-attempt-2");
    expect(task?.attempts).toMatchObject([
      { outcome: "cancelled", replacement_eligible: 0 },
      { outcome: "complete", replacement_eligible: 0 },
    ]);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      admissible_tasks: 1,
      invalid_selected_tasks: 0,
      publication_status: "published",
    });
  });

  it("closes and settles Sandbox commands before automatic retry", async () => {
    const control = await createTestControl(1, 2, 1, false);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 2 },
      "automatic-retry-sandbox-recovery-key",
      operator,
    );
    let initialLaunches = 0;
    let replacementLaunches = 0;
    let sandboxClosed = false;
    let replacementBeforeClose = false;
    const noop = new NoopActions();
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind === "job.launch") {
          if (typeof intent.payload.prior_attempt_id === "string") {
            replacementLaunches += 1;
            replacementBeforeClose ||= !sandboxClosed;
            return {
              outcome: "created",
              observed_state: "RUNNING",
              resource_id: "replacement-job",
            };
          }
          initialLaunches += 1;
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id: "initial-job",
          };
        }
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: "COMPLETED",
            resource_id: intent.payload.resource_id as string,
          };
        if (intent.action_kind === "sandbox.close") {
          sandboxClosed = true;
          return {
            outcome: "completed",
            observed_state: "CANCELED",
            resource_id: intent.payload.resource_id as string,
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
      {
        interval_ms: 100,
        observation_interval_ms: 0,
        worker_receipt_grace_ms: 0,
        batch_size: 16,
      },
    );
    await reconciler.tick();
    const command = await appendClosedSandboxAmbiguity(
      control,
      result.campaign_id,
      "task-001",
      "automatic-retry",
      "none",
    );

    await settle(reconciler, 24);

    expect(initialLaunches).toBe(1);
    expect(replacementLaunches).toBe(1);
    expect(sandboxClosed).toBe(true);
    expect(replacementBeforeClose).toBe(false);
    const commandReceipt = JSON.parse(
      (await control.projection.action(command.action_id))?.receipt_body ?? "null",
    );
    expect(commandReceipt).toMatchObject({
      outcome: "failed",
      observed_state: "AMBIGUOUS",
      error_code: "sandbox_external_outcome_unknown",
    });
    const replacement = (
      await control.projection.campaignActions(result.campaign_id)
    ).find((action) => {
      if (action.action_kind !== "job.launch") return false;
      const intent = JSON.parse(action.intent_body) as ActionIntent;
      return typeof intent.payload.prior_attempt_id === "string";
    });
    expect(replacement).toBeDefined();
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
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
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
    const launch = (await control.projection.campaignActions(result.campaign_id)).find(
      (action) => action.action_kind === "job.launch",
    );
    expect(launch?.receipt_body).toBeNull();
    expect(
      launch ? await control.projection.actionDispatch(launch.action_id) : null,
    ).not.toBeNull();
    await control.service.campaignAction(
      result.campaign_id,
      { action: "cancel", reason: "operator cancellation", confirmed: true },
      "ambiguous-cancellation-action",
      operator,
    );

    await settle(reconciler, 3);

    expect(cancelled).toBe(false);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      terminal_tasks: 0,
    });
    adoptionVisible = true;
    await settle(reconciler, 12);

    expect(creates).toBe(1);
    expect(cancelled).toBe(true);
    expect(remoteJobExists).toBe(false);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
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
    expect(await control.projection.campaignAttempts(result.campaign_id)).toMatchObject(
      [{ outcome: "complete" }],
    );
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
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
    expect(await control.projection.campaignAttempts(result.campaign_id)).toMatchObject(
      [{ outcome: "complete" }],
    );
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
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

      expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
        terminal_tasks: 0,
      });
      const launch = (
        await control.projection.campaignActions(result.campaign_id)
      ).find((action) => action.action_kind === "job.launch");
      expect(launch).toBeDefined();
      const evidence = await putEvidenceReference(control, "late-worker-evidence");
      await control.service.attempt({
        campaign_id: result.campaign_id,
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

      const attempts = await control.projection.campaignAttempts(result.campaign_id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attempt_id: "attempt-late-worker-receipt",
        outcome: "complete",
      });
      expect(
        (await control.projection.task(result.campaign_id, "task-001"))?.task
          .selected_attempt_id,
      ).toBe("attempt-late-worker-receipt");
      expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
        status: "completed",
        terminal_tasks: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts a repeated infrastructure retry request", async () => {
    const control = await createTestControl(1, 2);
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "retry-idempotency-campaign-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      {
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
    await control.service.attempt({
      campaign_id: result.campaign_id,
      task_id: "task-001",
      attempt_id: "attempt-retry-idempotency",
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

    const first = await control.service.campaignAction(
      result.campaign_id,
      action,
      "same-retry-idempotency-key",
      operator,
    );
    const repeated = await control.service.campaignAction(
      result.campaign_id,
      action,
      "same-retry-idempotency-key",
      operator,
    );

    expect(repeated).toMatchObject({ action_id: first.action_id, adopted: true });
  });

  it("settles a dispatched Sandbox command when its Sandbox closes", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "close-settles-ambiguity-campaign-key",
      operator,
    );
    const command = await appendClosedSandboxAmbiguity(
      control,
      result.campaign_id,
      "task-001",
      "close",
      "service",
    );

    expect(await control.projection.action(command.action_id)).toMatchObject({
      outcome: "failed",
      observed_state: "AMBIGUOUS",
    });
    expect(await control.projection.actionAdvanced(command.action_id)).toBe(true);
    expect(
      await control.projection.pendingDispatchedSandboxExecActions(
        result.campaign_id,
        "task-001",
      ),
    ).toEqual([]);
  });

  it("serializes Sandbox close settlement with command completion", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "close-command-completion-race-campaign-key",
      operator,
    );
    const command = await appendClosedSandboxAmbiguity(
      control,
      result.campaign_id,
      "task-001",
      "completion-race",
      "none",
    );
    const policy = command.payload.sandbox;
    const createActionId = command.payload.sandbox_create_action_id;
    const resourceId = command.payload.resource_id;
    if (!policy || typeof createActionId !== "string" || typeof resourceId !== "string")
      throw new Error("command fixture is missing Sandbox ownership");

    let releaseCompletion = (): void => undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let finalizationStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      finalizationStarted = resolve;
    });
    const commandCompletion = control.service.withSandboxActionFinalization(
      command.action_id,
      async () => {
        finalizationStarted();
        await completionGate;
        const external = {
          outcome: "completed" as const,
          observed_state: "command-completed",
          resource_id: resourceId,
        };
        await control.store.create(
          sandboxActionResultPath(result.campaign_id, command.action_id),
          new TextEncoder().encode(
            canonicalJson({ external, result: { exit_code: 0 } }),
          ),
        );
        const receipt = await control.service.receipt(command, external);
        await control.service.markAdvanced(command, receipt);
      },
    );
    await started;

    const close = control.service.actionIntent(
      result.campaign_id,
      "sandbox.close",
      "sandbox-close-completion-race",
      0,
      {
        task_id: "task-001",
        sandbox_create_action_id: createActionId,
        resource_id: resourceId,
        sandbox: policy,
      },
    );
    await control.service.writeAction(close);
    const closeReceipt = await control.service.receipt(close, {
      outcome: "completed",
      observed_state: "CANCELED",
      resource_id: resourceId,
      cost_microusd: 0,
    });
    const pendingQuery = vi.spyOn(
      control.projection,
      "pendingDispatchedSandboxExecActions",
    );
    let closeCompleted = false;
    const closeCompletion = control.service
      .markAdvanced(close, closeReceipt)
      .then(() => {
        closeCompleted = true;
      });
    await vi.waitFor(() => expect(pendingQuery).toHaveBeenCalled());
    expect(closeCompleted).toBe(false);

    releaseCompletion();
    await Promise.all([commandCompletion, closeCompletion]);

    expect(await control.projection.action(command.action_id)).toMatchObject({
      outcome: "completed",
      observed_state: "command-completed",
    });
    expect(await control.projection.actionAdvanced(command.action_id)).toBe(true);
    expect(
      await control.projection.pendingDispatchedSandboxExecActions(
        result.campaign_id,
        "task-001",
      ),
    ).toEqual([]);
  });

  it("does not settle an ambiguous command while its Sandbox is open", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "open-ambiguity-campaign-key",
      operator,
    );
    const command = await appendClosedSandboxAmbiguity(
      control,
      result.campaign_id,
      "task-001",
      "open",
      "none",
    );

    expect(
      await control.service.settleClosedSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        operator,
      ),
    ).toEqual({ settled: 0, unresolved: 1 });
    expect(await control.projection.action(command.action_id)).toMatchObject({
      receipt_body: null,
    });
    expect(await control.projection.actionAdvanced(command.action_id)).toBe(false);
  });

  it("adopts concurrent settlement of the same closed Sandbox command", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "concurrent-ambiguity-campaign-key",
      operator,
    );
    const command = await appendClosedSandboxAmbiguity(
      control,
      result.campaign_id,
      "task-001",
      "concurrent",
    );
    const otherOperator = { subject: "operator-2", role: "operator" as const };

    const settled = await Promise.all([
      control.service.settleClosedSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        operator,
      ),
      control.service.settleClosedSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        otherOperator,
      ),
    ]);
    expect(settled.every((item) => item.unresolved === 0)).toBe(true);
    expect(
      settled.reduce((total, item) => total + item.settled, 0),
    ).toBeGreaterThanOrEqual(1);
    const receipt = JSON.parse(
      (await control.projection.action(command.action_id))?.receipt_body ?? "null",
    );
    expect([operator, otherOperator]).toContainEqual(receipt.actor);
    expect(await control.projection.actionAdvanced(command.action_id)).toBe(true);
  });

  it("refuses to settle an ambiguous command that has a durable result", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "result-bearing-ambiguity-campaign-key",
      operator,
    );
    const command = await appendClosedSandboxAmbiguity(
      control,
      result.campaign_id,
      "task-001",
      "result-bearing",
    );
    await control.store.create(
      sandboxActionResultPath(result.campaign_id, command.action_id),
      new TextEncoder().encode('{"result":"present"}\n'),
    );

    expect(
      await control.service.settleClosedSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        operator,
      ),
    ).toEqual({ settled: 0, unresolved: 1 });
    expect(await control.projection.action(command.action_id)).toMatchObject({
      receipt_body: null,
    });
  });

  it("settles closed Sandbox command ambiguity before infrastructure retry", async () => {
    const control = await createTestControl(1, 2, 150_000);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 180_000_000 },
      "closed-ambiguity-retry-campaign-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      {
        task_ids: ["task-001"],
        max_infrastructure_attempts: 2,
        reservation_microusd: 150_000,
      },
    );
    await control.service.writeAction(launch);
    const evidence = await putEvidenceReference(
      control,
      "closed-ambiguity-retry-evidence",
    );
    await control.service.attempt({
      campaign_id: result.campaign_id,
      task_id: "task-001",
      attempt_id: "attempt-closed-ambiguity-retry",
      action_id: launch.action_id,
      outcome: "infrastructure",
      replacement_eligible: true,
      ...evidence,
      cost_microusd: 0,
      metrics: { input_tokens: 0, output_tokens: 0 },
      completed_at: "2026-08-20T22:24:39.584Z",
    });
    const observed: BudgetEvent = {
      schema_version: "v1",
      kind: "budget.event",
      record_id: deterministicId(
        "budget",
        result.campaign_id,
        "closed-ambiguity-observed",
      ),
      created_at: "2026-08-20T22:24:42.225Z",
      actor: { subject: "historical-control", role: "service" },
      campaign_id: result.campaign_id,
      event_kind: "reconcile",
      amount_microusd: 10_167,
    };
    await control.service.append(observed);
    const command = await appendClosedSandboxAmbiguity(
      control,
      result.campaign_id,
      "task-001",
      "retry",
    );
    expect(
      await control.projection.pendingDispatchedSandboxExecActions(
        result.campaign_id,
        "task-001",
      ),
    ).toEqual([command]);

    const action = {
      action: "retry_infrastructure",
      task_id: "task-001",
      reason: "retry closed ambiguous Sandbox command",
      confirmed: true,
    } as const;
    const retry = await control.service.campaignAction(
      result.campaign_id,
      action,
      "closed-ambiguity-retry-key",
      operator,
    );
    const commandRow = await control.projection.action(command.action_id);
    expect(JSON.parse(commandRow?.receipt_body ?? "null")).toMatchObject({
      actor: operator,
      outcome: "failed",
      observed_state: "AMBIGUOUS",
      error_code: "sandbox_external_outcome_unknown",
    });
    expect(await control.projection.actionAdvanced(command.action_id)).toBe(true);
    expect(
      await control.projection.pendingDispatchedSandboxExecActions(
        result.campaign_id,
        "task-001",
      ),
    ).toEqual([]);
    const resultPath = sandboxActionResultPath(result.campaign_id, command.action_id);
    expect(
      (await control.store.list(resultPath.slice(0, -"/result.json".length))).some(
        (entry) => entry.key === resultPath,
      ),
    ).toBe(false);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      observed_microusd: 10_167,
    });
    expect(await control.projection.campaignAttempts(result.campaign_id)).toHaveLength(
      1,
    );
    expect(await control.projection.action(retry.action_id)).toMatchObject({
      action_kind: "job.launch",
    });
    expect(
      await control.service.campaignAction(
        result.campaign_id,
        action,
        "closed-ambiguity-retry-key",
        operator,
      ),
    ).toMatchObject({ action_id: retry.action_id, adopted: true });

    const rebuilt = await Projection.open(`${control.root}/ambiguity-rebuild.sqlite`);
    await rebuilt.rebuild(control.store);
    expect(await rebuilt.action(command.action_id)).toMatchObject({
      outcome: "failed",
      observed_state: "AMBIGUOUS",
    });
    expect(
      await rebuilt.pendingDispatchedSandboxExecActions(result.campaign_id, "task-001"),
    ).toEqual([]);
    await rebuilt.close();
  });

  it("settles closed Sandbox command ambiguity during cancellation", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "closed-ambiguity-cancel-campaign-key",
      operator,
    );
    const command = await appendClosedSandboxAmbiguity(
      control,
      result.campaign_id,
      "task-001",
      "cancel",
    );

    const cancellation = await control.service.campaignAction(
      result.campaign_id,
      { action: "cancel", reason: "cancel after closed Sandbox", confirmed: true },
      "closed-ambiguity-cancel-key",
      operator,
    );
    expect(await control.projection.actionAdvanced(command.action_id)).toBe(true);
    expect(await control.projection.action(cancellation.action_id)).toMatchObject({
      action_kind: "campaign.cancel",
    });
  });

  it("corrects historical Sandbox command dispositions without lifecycle effects", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "historical-disposition-campaign-key",
      operator,
    );
    const first = await appendLegacySuppressedSandboxCommand(
      control,
      result.campaign_id,
      "task-001",
      "historical-first",
    );
    const second = await appendLegacySuppressedSandboxCommand(
      control,
      result.campaign_id,
      "task-001",
      "historical-second",
    );
    const before = await control.projection.campaign(result.campaign_id);
    const beforeAttempts = await control.projection.campaignAttempts(
      result.campaign_id,
    );

    const corrected = await control.service.correctHistoricalSandboxAmbiguities(
      result.campaign_id,
      "task-001",
      {
        action_ids: [second.command.action_id, first.command.action_id],
        reason: "correct legacy non-replay-safe command state",
        confirmed: true,
      },
      "historical-disposition-key",
      operator,
    );

    expect(corrected.items).toHaveLength(2);
    expect(corrected.items.every((item) => item.created)).toBe(true);
    expect(first.receipt.resource_id).toBeNull();
    expect(second.receipt.resource_id).toBeNull();
    const repeated = await control.service.correctHistoricalSandboxAmbiguities(
      result.campaign_id,
      "task-001",
      {
        action_ids: [first.command.action_id, second.command.action_id],
        reason: "correct legacy non-replay-safe command state",
        confirmed: true,
      },
      "historical-disposition-key",
      operator,
    );
    expect(repeated).toMatchObject({
      batch_id: corrected.batch_id,
      batch_digest: corrected.batch_digest,
    });
    expect(repeated.items.every((item) => !item.created)).toBe(true);
    const views = await control.projection.actionDispositionViews(
      result.campaign_id,
      "task-001",
    );
    expect(views).toHaveLength(2);
    expect(views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recorded_outcome: "completed",
          recorded_observed_state: "suppressed-sandbox-cleanup-ambiguous",
          effective_outcome: "failed",
          effective_observed_state: "AMBIGUOUS",
          effective_error_code: "sandbox_external_outcome_unknown",
          reason_code: "historical_non_replay_safe_command_ambiguity",
        }),
      ]),
    );
    const audit = await control.projection.audit(null, 10_000);
    const dispositionEvent = audit.find(
      (event) =>
        event.type === "action.disposition" &&
        event.data.action_id === first.command.action_id,
    );
    expect(dispositionEvent?.data).toMatchObject({
      corrected: true,
      recorded_outcome: "completed",
      recorded_observed_state: "suppressed-sandbox-cleanup-ambiguous",
      effective_outcome: "failed",
      effective_observed_state: "AMBIGUOUS",
      effective_error_code: "sandbox_external_outcome_unknown",
      reason_code: "historical_non_replay_safe_command_ambiguity",
    });
    expect(dispositionEvent?.data).not.toHaveProperty("source_receipt_digest");
    expect(dispositionEvent?.data).not.toHaveProperty("close_action_id");
    expect(
      JSON.parse(
        (await control.projection.action(first.command.action_id))?.receipt_body ??
          "null",
      ),
    ).toEqual(first.receipt);
    expect(await control.projection.campaign(result.campaign_id)).toEqual(before);
    expect(await control.projection.campaignAttempts(result.campaign_id)).toEqual(
      beforeAttempts,
    );
    await expect(
      control.service.correctHistoricalSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        {
          action_ids: [first.command.action_id],
          reason: "changed batch",
          confirmed: true,
        },
        "historical-disposition-key",
        operator,
      ),
    ).rejects.toThrow("batch identity conflict");

    const rebuilt = await Projection.open(`${control.root}/disposition-rebuild.sqlite`);
    await rebuilt.rebuild(control.store);
    expect(
      await rebuilt.actionDispositionViews(result.campaign_id, "task-001"),
    ).toMatchObject([
      {
        recorded_outcome: "completed",
        effective_outcome: "failed",
        effective_observed_state: "AMBIGUOUS",
      },
      {
        recorded_outcome: "completed",
        effective_outcome: "failed",
        effective_observed_state: "AMBIGUOUS",
      },
    ]);
    await rebuilt.close();

    await control.store.create(
      sandboxActionResultPath(result.campaign_id, first.command.action_id),
      new TextEncoder().encode('{"result":"late"}\n'),
    );
    const conflicting = await Projection.open(
      `${control.root}/disposition-conflict.sqlite`,
    );
    await expect(conflicting.rebuild(control.store)).rejects.toThrow("durable result");
    expect(conflicting.system()).toMatchObject({
      ready: false,
      integrity_error: expect.stringContaining("durable result"),
    });
    await conflicting.close();
  });

  it("accepts a matching non-null source resource disposition", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "matching-source-resource-campaign-key",
      operator,
    );
    const legacy = await appendLegacySuppressedSandboxCommand(
      control,
      result.campaign_id,
      "task-001",
      "matching-source-resource",
      "sandbox-resource-matching-source-resource",
    );

    const corrected = await control.service.correctHistoricalSandboxAmbiguities(
      result.campaign_id,
      "task-001",
      {
        action_ids: [legacy.command.action_id],
        reason: "accept matching source resource evidence",
        confirmed: true,
      },
      "matching-source-resource-key",
      operator,
    );
    expect(corrected.items).toMatchObject([
      { action_id: legacy.command.action_id, created: true },
    ]);

    const rebuilt = await Projection.open(
      `${control.root}/matching-source-resource.sqlite`,
    );
    await rebuilt.rebuild(control.store);
    expect(
      await rebuilt.actionDispositionViews(result.campaign_id, "task-001"),
    ).toMatchObject([
      {
        recorded_outcome: "completed",
        effective_outcome: "failed",
        effective_observed_state: "AMBIGUOUS",
      },
    ]);
    await rebuilt.close();
  });

  it("adopts concurrent historical disposition correction", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "concurrent-disposition-campaign-key",
      operator,
    );
    const legacy = await appendLegacySuppressedSandboxCommand(
      control,
      result.campaign_id,
      "task-001",
      "concurrent-disposition",
    );
    const input = {
      action_ids: [legacy.command.action_id],
      reason: "adopt concurrent correction",
      confirmed: true,
    };
    const results = await Promise.all([
      control.service.correctHistoricalSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        input,
        "concurrent-disposition-key",
        operator,
      ),
      control.service.correctHistoricalSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        input,
        "concurrent-disposition-key",
        { subject: "another-operator", role: "operator" },
      ),
    ]);
    expect(
      results.flatMap((item) => item.items).filter((item) => item.created),
    ).toHaveLength(1);
    expect(
      await control.projection.actionDispositionViews(result.campaign_id, "task-001"),
    ).toHaveLength(1);
  });

  it("resumes a partially written historical disposition batch", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "partial-disposition-campaign-key",
      operator,
    );
    const first = await appendLegacySuppressedSandboxCommand(
      control,
      result.campaign_id,
      "task-001",
      "partial-first",
    );
    const second = await appendLegacySuppressedSandboxCommand(
      control,
      result.campaign_id,
      "task-001",
      "partial-second",
    );
    const originalCreate = control.store.create.bind(control.store);
    let dispositionWrites = 0;
    const create = vi
      .spyOn(control.store, "create")
      .mockImplementation(async (key, bytes) => {
        if (key.endsWith("/zzz-disposition.json")) {
          dispositionWrites += 1;
          if (dispositionWrites === 2)
            throw new Error("simulated disposition batch interruption");
        }
        return originalCreate(key, bytes);
      });
    const input = {
      action_ids: [first.command.action_id, second.command.action_id],
      reason: "resume an interrupted correction batch",
      confirmed: true,
    };
    await expect(
      control.service.correctHistoricalSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        input,
        "partial-disposition-key",
        operator,
      ),
    ).rejects.toThrow("simulated disposition batch interruption");
    create.mockRestore();
    expect(
      await control.projection.actionDispositionViews(result.campaign_id, "task-001"),
    ).toHaveLength(1);

    const resumed = await control.service.correctHistoricalSandboxAmbiguities(
      result.campaign_id,
      "task-001",
      input,
      "partial-disposition-key",
      operator,
    );
    expect(resumed.items.filter((item) => item.created)).toHaveLength(1);
    expect(
      await control.projection.actionDispositionViews(result.campaign_id, "task-001"),
    ).toHaveLength(2);
  });

  it("rejects historical disposition correction without complete proof", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "invalid-disposition-campaign-key",
      operator,
    );
    const resultBearing = await appendLegacySuppressedSandboxCommand(
      control,
      result.campaign_id,
      "task-001",
      "result-bearing-disposition",
    );
    await expect(
      control.service.correctHistoricalSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        {
          action_ids: [resultBearing.command.action_id],
          reason: "confirmation is required",
          confirmed: false,
        },
        "invalid-disposition-confirmation-key",
        operator,
      ),
    ).rejects.toThrow("explicit confirmation");
    await expect(
      control.service.correctHistoricalSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        {
          action_ids: [resultBearing.command.action_id],
          reason: "operator access is required",
          confirmed: true,
        },
        "invalid-disposition-reader-key",
        { subject: "reader", role: "reader" },
      ),
    ).rejects.toThrow("requires an operator");
    await control.store.create(
      sandboxActionResultPath(result.campaign_id, resultBearing.command.action_id),
      new TextEncoder().encode('{"result":"present"}\n'),
    );
    await expect(
      control.service.correctHistoricalSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        {
          action_ids: [resultBearing.command.action_id],
          reason: "must reject the durable result",
          confirmed: true,
        },
        "invalid-disposition-result-key",
        operator,
      ),
    ).rejects.toThrow("durable result");

    const open = await appendClosedSandboxAmbiguity(
      control,
      result.campaign_id,
      "task-001",
      "open-disposition",
      "none",
    );
    const openReceipt = await control.service.receipt(open, {
      outcome: "completed",
      observed_state: "suppressed-sandbox-cleanup-ambiguous",
      resource_id: open.payload.resource_id as string,
    });
    await control.service.markAdvanced(open, openReceipt);
    await expect(
      control.service.correctHistoricalSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        {
          action_ids: [open.action_id],
          reason: "must reject the open Sandbox",
          confirmed: true,
        },
        "invalid-disposition-open-key",
        operator,
      ),
    ).rejects.toThrow("no terminal Sandbox close");
    expect(
      await control.projection.actionDispositionViews(result.campaign_id, "task-001"),
    ).toEqual([]);
  });

  it("rejects disposition proof without an intent resource", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "missing-intent-resource-campaign-key",
      operator,
    );
    const reference = await appendLegacySuppressedSandboxCommand(
      control,
      result.campaign_id,
      "task-001",
      "missing-intent-resource-reference",
    );
    const { resource_id: _resourceId, ...payloadWithoutResource } =
      reference.command.payload;
    const command = control.service.actionIntent(
      result.campaign_id,
      "sandbox.exec",
      "sandbox-command-missing-intent-resource",
      0,
      payloadWithoutResource,
    );
    await control.service.writeAction(command);
    await control.service.dispatchAction(command, "2026-08-20T00:00:00.000Z");
    const receipt = await control.service.receipt(command, {
      outcome: "completed",
      observed_state: "suppressed-sandbox-cleanup-ambiguous",
    });
    await control.service.markAdvanced(command, receipt);

    await expect(
      control.service.correctHistoricalSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        {
          action_ids: [command.action_id],
          reason: "reject missing intent resource evidence",
          confirmed: true,
        },
        "missing-intent-resource-key",
        operator,
      ),
    ).rejects.toThrow("ownership is incomplete");

    const close = (await control.projection.campaignActions(result.campaign_id)).find(
      (action) => action.action_kind === "sandbox.close",
    );
    if (!close?.receipt_body) throw new Error("test close receipt is missing");
    const disposition = dispositionForTest({
      campaignId: result.campaign_id,
      taskId: "task-001",
      actionId: command.action_id,
      sourceReceipt: receipt,
      closeActionId: close.action_id,
      closeReceipt: JSON.parse(close.receipt_body) as ActionReceipt,
      idempotencyKey: "missing-intent-resource-key",
      reason: "reject missing intent resource evidence",
    });
    await expect(control.service.append(disposition)).rejects.toThrow(
      "ownership is incomplete",
    );
    const rebuilt = await Projection.open(
      `${control.root}/missing-intent-resource.sqlite`,
    );
    await expect(rebuilt.rebuild(control.store)).rejects.toThrow(
      "ownership is incomplete",
    );
    expect(rebuilt.system()).toMatchObject({
      ready: false,
      integrity_error: expect.stringContaining("ownership is incomplete"),
    });
    await rebuilt.close();
  });

  it("rejects disposition proof with a mismatched source resource", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "mismatched-source-resource-campaign-key",
      operator,
    );
    const legacy = await appendLegacySuppressedSandboxCommand(
      control,
      result.campaign_id,
      "task-001",
      "mismatched-source-resource",
      "another-sandbox-resource",
    );
    expect(legacy.receipt.resource_id).toBe("another-sandbox-resource");
    expect(legacy.command.payload.resource_id).toBe(
      "sandbox-resource-mismatched-source-resource",
    );
    expect(
      JSON.parse(
        (await control.projection.action(legacy.command.action_id))?.receipt_body ??
          "null",
      ),
    ).toMatchObject({ resource_id: "another-sandbox-resource" });
    await expect(
      control.service.correctHistoricalSandboxAmbiguities(
        result.campaign_id,
        "task-001",
        {
          action_ids: [legacy.command.action_id],
          reason: "reject inconsistent source and close evidence",
          confirmed: true,
        },
        "mismatched-source-resource-key",
        operator,
      ),
    ).rejects.toThrow("source resource does not match");

    const close = (await control.projection.campaignActions(result.campaign_id)).find(
      (action) => action.action_kind === "sandbox.close",
    );
    if (!close?.receipt_body) throw new Error("test close receipt is missing");
    const closeReceipt = JSON.parse(close.receipt_body) as ActionReceipt;
    const disposition = dispositionForTest({
      campaignId: result.campaign_id,
      taskId: "task-001",
      actionId: legacy.command.action_id,
      sourceReceipt: legacy.receipt,
      closeActionId: close.action_id,
      closeReceipt,
      idempotencyKey: "mismatched-source-resource-key",
      reason: "reject inconsistent source and close evidence",
    });
    await expect(control.service.append(disposition)).rejects.toThrow(
      "source resource mismatch",
    );
    const rebuilt = await Projection.open(
      `${control.root}/mismatched-source-resource.sqlite`,
    );
    await expect(rebuilt.rebuild(control.store)).rejects.toThrow(
      "source resource mismatch",
    );
    expect(rebuilt.system()).toMatchObject({
      ready: false,
      integrity_error: expect.stringContaining("source resource mismatch"),
    });
    await rebuilt.close();
  });

  it("rejects a Sandbox reservation before it crosses the campaign ceiling", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "sandbox-budget-ceiling-key",
      operator,
    );

    expect(
      await control.service.reserveSandbox(
        result.campaign_id,
        "sandbox-create-over-budget",
        "2026-08-18T00:00:00Z",
        1,
      ),
    ).toBe(false);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      reserved_microusd: 0,
      observed_microusd: 0,
    });
  });

  it("serializes concurrent infrastructure retry admissions", async () => {
    const control = await createTestControl(1, 2, 6);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 12 },
      "concurrent-retry-campaign-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      {
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
      campaign_id: result.campaign_id,
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
      control.service.campaignAction(
        result.campaign_id,
        action,
        "concurrent-retry-key-one",
        operator,
      ),
      control.service.campaignAction(
        result.campaign_id,
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
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      reserved_microusd: 6,
    });
  });

  it("includes observed overage when admitting a replacement", async () => {
    const control = await createTestControl(1, 2, 50);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 100 },
      "observed-overage-campaign-key",
      operator,
    );
    await control.service.append({
      schema_version: "v1",
      kind: "budget.event",
      record_id: deterministicId("budget", result.campaign_id, "reserve", "initial"),
      created_at: "2026-08-16T00:00:00.000Z",
      actor: { subject: "harbor-hf-control", role: "service" },
      campaign_id: result.campaign_id,
      event_kind: "reserve",
      amount_microusd: 50,
    });
    const launch = control.service.actionIntent(
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      {
        task_ids: ["task-001"],
        max_infrastructure_attempts: 2,
        reservation_microusd: 50,
      },
    );
    await control.service.writeAction(launch);
    const evidence = await putEvidenceReference(control, "observed-overage-evidence");
    await control.service.attempt({
      campaign_id: result.campaign_id,
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
      control.service.campaignAction(
        result.campaign_id,
        {
          action: "retry_infrastructure",
          task_id: "task-001",
          reason: "retry transient infrastructure",
          confirmed: true,
        },
        "observed-overage-retry-key",
        operator,
      ),
    ).rejects.toThrow("replacement Job would exceed the campaign ceiling");
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      reserved_microusd: 50,
      observed_microusd: 60,
    });
    expect(
      await control.projection.retryActionForAttempt(
        result.campaign_id,
        "attempt-observed-overage",
      ),
    ).toBeNull();
  });

  it("durably catches up an observed overage before reserving", async () => {
    const control = await createTestControl(1, 2, 50);
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 120 },
      "observed-catch-up-campaign-key",
      operator,
    );
    for (const [eventKind, amount] of [
      ["reserve", 50],
      ["reconcile", 60],
    ] as const) {
      await control.service.append({
        schema_version: "v1",
        kind: "budget.event",
        record_id: deterministicId("budget", result.campaign_id, eventKind, "initial"),
        created_at: "2026-08-16T00:00:00.000Z",
        actor: { subject: "harbor-hf-control", role: "service" },
        campaign_id: result.campaign_id,
        event_kind: eventKind,
        amount_microusd: amount,
      });
    }

    expect(
      await control.service.reserveReplacement(
        result.campaign_id,
        "attempt-observed-catch-up",
        "2026-08-16T00:00:01.000Z",
        50,
      ),
    ).toBe(true);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      reserved_microusd: 110,
      observed_microusd: 60,
    });
  });

  it("releases each failed Job reservation before reserving its replacement", async () => {
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
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "failed",
      reserved_microusd: 0,
      terminal_tasks: 1,
      exhausted_tasks: 1,
    });
  });

  it("retries endpoint cleanup until zero ready replicas before publication", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "endpoint-cleanup-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      { task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);
    const endpointEvidence = await putEvidenceReference(
      control,
      "endpoint-cleanup-evidence",
    );
    const attempt = await control.service.attempt({
      campaign_id: result.campaign_id,
      task_id: "task-001",
      attempt_id: "endpoint-cleanup-attempt",
      action_id: launch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      ...endpointEvidence,
      cost_microusd: 0,
      metrics: { reward: 1 },
      completed_at: "2026-08-16T00:00:01.000Z",
    });
    await control.service.selectTerminal(attempt, "test terminal outcome");
    const resume = control.service.actionIntent(
      result.campaign_id,
      "endpoint.resume",
      "endpoint-one",
      0,
      { endpoint_id: "endpoint-one", watchdog_verified: true },
    );
    await control.service.writeAction(resume);
    const resumeReceipt = await control.service.receipt(resume, {
      outcome: "completed",
      observed_state: "running",
      resource_id: "endpoint-one",
      ready_replicas: 1,
      active_hourly_cost_microusd: 100,
    });
    await control.service.append({
      schema_version: "v1",
      kind: "endpoint.resource",
      record_id: "endpoint-running-record",
      created_at: resumeReceipt.created_at,
      actor: { subject: "harbor-hf-control", role: "service" },
      campaign_id: result.campaign_id,
      action_id: resume.action_id,
      endpoint_id: "endpoint-one",
      desired_state: "running",
      observed_state: "running",
      ready_replicas: 1,
      cleanup_verified: false,
      active_hourly_cost_microusd: 100,
    } satisfies EndpointResource);
    await control.service.markAdvanced(resume, resumeReceipt);
    await expect(
      control.service.campaignAction(
        result.campaign_id,
        { action: "publish", confirmed: true },
        "unsafe-manual-publication",
        operator,
      ),
    ).rejects.toThrow(
      "campaign cannot publish while actions or endpoint cleanup are pending",
    );
    let pauses = 0;
    const external: ExternalActionPort = {
      execute: async (intent): Promise<ExternalActionResult> => {
        if (intent.action_kind !== "endpoint.pause")
          return new NoopActions().execute(intent);
        pauses += 1;
        return {
          outcome: "completed",
          observed_state: "paused",
          resource_id: "endpoint-one",
          ready_replicas: pauses === 1 ? null : pauses === 2 ? 1 : 0,
          active_hourly_cost_microusd: 100,
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
    await settle(reconciler, 10);
    expect(pauses).toBe(3);
    expect(await control.projection.endpoints()).toMatchObject([
      { endpoint_id: "endpoint-one", cleanup_verified: 1, ready_replicas: 0 },
    ]);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      cleanup_pending: false,
      publication_status: "published",
    });
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
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      { task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);

    await expect(
      control.service.attempt(
        {
          campaign_id: result.campaign_id,
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
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      { task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);
    const attempt: AttemptReceipt = {
      schema_version: "v1",
      kind: "attempt.receipt",
      record_id: deterministicId("attempt-receipt", "direct-worker-attempt"),
      created_at: "2026-08-16T00:00:01.000Z",
      actor: { subject: "trusted-worker", role: "service" },
      campaign_id: result.campaign_id,
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

  it("rejects multiple worker attempts for one action and task", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "duplicate-action-attempt-key",
      operator,
    );
    const launch = control.service.actionIntent(
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      { task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);
    const firstEvidence = await putWorkerEvidence(
      control,
      result.campaign_id,
      launch.action_id,
      "task-001",
      "worker-evidence-one",
    );
    const secondEvidence = await putWorkerEvidence(
      control,
      result.campaign_id,
      launch.action_id,
      "task-001",
      "worker-evidence-two",
    );
    const attempt = {
      campaign_id: result.campaign_id,
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

  it("rejects worker cost before it crosses the campaign ceiling", async () => {
    const control = await createTestControl();
    controls.push(control);
    const result = await control.service.submit(
      { ...submission, ceiling_microusd: 10 },
      "cost-ceiling-key",
      operator,
    );
    await expect(
      control.service.campaignAction(
        result.campaign_id,
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
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      { task_ids: ["task-001"] },
    );
    await control.service.writeAction(launch);
    await expect(
      control.service.attempt({
        campaign_id: result.campaign_id,
        task_id: "task-001",
        attempt_id: "over-budget-attempt",
        action_id: launch.action_id,
        outcome: "complete",
        replacement_eligible: false,
        evidence_digest: sha256("over-budget-evidence"),
        evidence_path: "cost/evidence",
        cost_microusd: 11,
        metrics: { reward: 1 },
        completed_at: "2026-08-16T00:00:01.000Z",
      }),
    ).rejects.toThrow("worker attempt cost exceeds the campaign ceiling");
    expect(await control.projection.attemptById("over-budget-attempt")).toBeNull();
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
    const oldCampaign = await control.service.submit(
      submission,
      "supersession-old-campaign",
      operator,
    );
    await settle(reconciler, 8);
    const oldPublication = await control.projection.campaignPublication(
      oldCampaign.campaign_id,
    );
    expect(oldPublication?.status).toBe("published");
    const oldBody = oldPublication?.body;

    const newCampaign = await control.service.submit(
      submission,
      "supersession-new-campaign",
      operator,
    );
    await settle(reconciler, 8);
    const newPublication = await control.projection.campaignPublication(
      newCampaign.campaign_id,
    );
    expect(newPublication?.status).toBe("published");

    const supersedeAction = await control.service.campaignAction(
      newCampaign.campaign_id,
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
      newCampaign.campaign_id,
      newPublication?.publication_id ?? "missing-publication",
      oldCampaign.campaign_id,
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
        superseded_campaign_id: oldCampaign.campaign_id,
        superseded_publication_id: oldPublication?.publication_id,
      },
    ]);
    expect(
      (await control.projection.campaignPublication(oldCampaign.campaign_id))?.body,
    ).toBe(oldBody);
    const adoptedSupersession = await control.service.campaignAction(
      newCampaign.campaign_id,
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

    const laterCampaign = await control.service.submit(
      submission,
      "supersession-later-campaign",
      operator,
    );
    await settle(reconciler, 8);
    await expect(
      control.service.campaignAction(
        laterCampaign.campaign_id,
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
    const published: Array<{ campaign_id: string; publication_id: string }> = [];
    for (const key of ["ordered-supersession-a", "ordered-supersession-b"]) {
      const campaign = await control.service.submit(submission, key, operator);
      await settle(reconciler, 8);
      const publication = await control.projection.campaignPublication(
        campaign.campaign_id,
      );
      if (!publication) throw new Error("publication is missing");
      published.push({
        campaign_id: campaign.campaign_id,
        publication_id: publication.publication_id,
      });
    }
    const [replacement, previous] = published.sort((left, right) =>
      left.campaign_id.localeCompare(right.campaign_id),
    );
    if (!replacement || !previous) throw new Error("test publications are missing");
    await control.service.campaignAction(
      replacement.campaign_id,
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
    expect(replacement.campaign_id < previous.campaign_id).toBe(true);
    const rebuilt = await Projection.open(`${control.root}/supersession-order.sqlite`);

    await rebuilt.rebuild(control.store);

    expect(await rebuilt.publicationSupersessions()).toMatchObject([
      {
        campaign_id: replacement.campaign_id,
        publication_id: replacement.publication_id,
        superseded_campaign_id: previous.campaign_id,
        superseded_publication_id: previous.publication_id,
      },
    ]);
    await rebuilt.close();
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
      result.campaign_id,
      "job.launch",
      "task-001",
      0,
      { task_ids: ["task-001"] },
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
      campaign_id: result.campaign_id,
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
    expect(await control.projection.campaignPublication(result.campaign_id)).toBeNull();
    expect(
      await control.projection.hasCampaignAction(
        result.campaign_id,
        "publication.publish",
      ),
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
      await control.projection.hasCampaignAction(
        result.campaign_id,
        "publication.publish",
      ),
    ).toBe(true);
    const publicationWrite = vi
      .spyOn(control.service, "writePublication")
      .mockRejectedValueOnce(new Error("simulated publication crash"));
    await expect(reconciler.tick()).rejects.toThrow("simulated publication crash");
    publicationWrite.mockRestore();
    await reconciler.tick();
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      publication_status: "published",
    });
  });

  it("preserves 88 complete tasks and retries only one infrastructure failure", async () => {
    const control = await createTestControl(89, 2);
    controls.push(control);
    const result = await control.service.submit(
      submission,
      "repair-request-key",
      operator,
    );
    class RepairActions implements ExternalActionPort {
      async execute(intent: ActionIntent): Promise<ExternalActionResult> {
        if (intent.action_kind === "campaign.admit")
          return { outcome: "completed", observed_state: "admitted" };
        if (intent.action_kind === "job.launch")
          return {
            outcome: "created",
            observed_state: "RUNNING",
            resource_id:
              intent.target === "campaign-tasks" ? "parent-job" : "repair-job",
          };
        if (intent.action_kind === "job.observe")
          return {
            outcome: "completed",
            observed_state: intent.target === "parent-job" ? "ERROR" : "STOPPED",
            resource_id: intent.target,
          };
        return { outcome: "completed", observed_state: "completed" };
      }
    }
    const publisher = new ResultPublisher(
      control.store,
      control.projection,
      control.service,
    );
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new RepairActions(),
      publisher,
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await reconciler.tick();
    await reconciler.tick();
    const parentLaunch = (await control.projection.actions()).find(
      (action) =>
        action.action_kind === "job.launch" && action.target === "campaign-tasks",
    );
    if (!parentLaunch) throw new Error("parent Job launch is missing");
    for (let index = 1; index <= 88; index += 1) {
      const taskId = `task-${String(index).padStart(3, "0")}`;
      const evidence = await putEvidenceReference(control, taskId);
      const attempt: AttemptInput = {
        campaign_id: result.campaign_id,
        task_id: taskId,
        attempt_id: `worker-attempt-${String(index).padStart(3, "0")}`,
        action_id: parentLaunch.action_id,
        outcome: "complete",
        replacement_eligible: false,
        ...evidence,
        cost_microusd: 0,
        metrics: { reward: 1 },
        completed_at: `2026-08-16T00:00:00.${String(index).padStart(3, "0")}Z`,
      };
      await control.service.attempt(attempt);
    }
    await reconciler.tick();
    const afterParent = await control.projection.campaign(result.campaign_id);
    expect(afterParent).toMatchObject({ terminal_tasks: 88, total_tasks: 89 });
    const pending = await control.projection.pendingActions(20);
    const repair = pending.find((intent) => intent.action_kind === "job.launch");
    expect(repair?.payload.task_ids).toEqual(["task-089"]);
    await settle(reconciler, 6);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 89,
      publication_status: "published",
    });
    const repaired = await control.projection.task(result.campaign_id, "task-089");
    expect(repaired?.attempts).toHaveLength(2);
    expect(repaired?.task.terminal_outcome).toBe("complete");
  });
});

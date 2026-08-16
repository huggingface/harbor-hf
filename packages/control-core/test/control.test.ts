import type {
  ActionIntent,
  AttemptReceipt,
  EndpointResource,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sha256,
} from "@harbor-hf/contracts";
import { createTestControl } from "@harbor-hf/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoopActions } from "@harbor-hf/hf-adapters";
import { Projection } from "../src/projection.js";
import { ResultPublisher } from "../src/publication.js";
import type { AttemptInput } from "../src/service.js";
import {
  AmbiguousExternalActionError,
  type ExternalActionContext,
  ExternalActionNotFoundError,
  Reconciler,
  type ExternalActionPort,
  type ExternalActionResult,
} from "../src/reconciler.js";
import type { TestControl } from "@harbor-hf/test-fixtures";

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

describe("control service", () => {
  it("adopts idempotent submissions and completes a control smoke campaign", async () => {
    const control = await createTestControl();
    controls.push(control);
    const [first, second] = await Promise.all([
      control.service.submit(submission, "same-request-key", operator),
      control.service.submit(submission, "same-request-key", operator),
    ]);
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
    expect(launchPayload).toMatchObject({ trusted_worker: true });
    expect(launchPayload).not.toHaveProperty("requires_hf_token");
    expect(launchPayload).not.toHaveProperty("mount_bucket");
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 1,
      publication_status: "published",
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
      evidence_digest: sha256("missed-callback-evidence"),
      evidence_path: "worker/missed-callback-evidence",
      cost_microusd: 0,
      metrics: { reward: 1 },
    };
    await control.store.create(
      controlRecordPath(attempt),
      new TextEncoder().encode(canonicalJson(attempt)),
    );
    expect(await control.projection.attemptById(attempt.attempt_id)).toBeNull();
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
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
    await control.service.campaignAction(
      result.campaign_id,
      { action: "cancel", confirmed: true },
      "cancel-action-key",
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
    await settle(reconciler);
    expect(
      execute.mock.calls.some(([intent]) => intent.action_kind === "job.launch"),
    ).toBe(false);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      terminal_tasks: 1,
      publication_status: "published",
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
      status: "completed",
      terminal_tasks: 1,
      pending_actions: 0,
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
      status: "completed",
      terminal_tasks: 1,
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
      status: "completed",
      terminal_tasks: 1,
      publication_status: "published",
    });
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

  it("does not launch a replacement Job without another budget reservation", async () => {
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

    expect(launches).toBe(1);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      reserved_microusd: 6,
      terminal_tasks: 1,
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
    const attempt = await control.service.attempt({
      campaign_id: result.campaign_id,
      task_id: "task-001",
      attempt_id: "endpoint-cleanup-attempt",
      action_id: launch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      evidence_digest: sha256("endpoint-cleanup-evidence"),
      evidence_path: "endpoint/evidence",
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
          ready_replicas: pauses === 1 ? 1 : 0,
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
    expect(pauses).toBe(2);
    expect(await control.projection.endpoints()).toMatchObject([
      { endpoint_id: "endpoint-one", cleanup_verified: 1, ready_replicas: 0 },
    ]);
    expect(await control.projection.campaign(result.campaign_id)).toMatchObject({
      status: "completed",
      cleanup_pending: false,
      publication_status: "published",
    });
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
    const attempt = {
      campaign_id: result.campaign_id,
      task_id: "task-001",
      attempt_id: "worker-attempt-one",
      action_id: launch.action_id,
      outcome: "complete" as const,
      replacement_eligible: false,
      evidence_digest: sha256("worker-evidence-one"),
      evidence_path: "worker/evidence-one",
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
          evidence_digest: sha256("worker-evidence-two"),
          evidence_path: "worker/evidence-two",
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
    const attempt = await control.service.attempt({
      campaign_id: result.campaign_id,
      task_id: "task-001",
      attempt_id: "publication-recovery-attempt",
      action_id: launch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      evidence_digest: sha256("publication-recovery-evidence"),
      evidence_path: "recovery/evidence",
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
      const attempt: AttemptInput = {
        campaign_id: result.campaign_id,
        task_id: taskId,
        attempt_id: `worker-attempt-${String(index).padStart(3, "0")}`,
        action_id: parentLaunch.action_id,
        outcome: "complete",
        replacement_eligible: false,
        evidence_digest: sha256(taskId),
        evidence_path: `campaigns/${result.campaign_id}/${taskId}`,
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

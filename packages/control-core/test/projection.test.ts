import { type SandboxPolicy, sha256 } from "@harbor-hf/contracts";
import { createTestControl, type TestControl } from "@harbor-hf/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { Projection, ProjectionIntegrityError } from "../src/projection.js";
import type { ImmutableObjectStore, ObjectEntry } from "../src/store.js";

const controls: TestControl[] = [];
afterEach(async () =>
  Promise.all(controls.splice(0).map((control) => control.close())),
);
const input = {
  benchmark: "control-smoke",
  model: "control-smoke",
  harness: "control-smoke",
  deployment: "hf-cpu-smoke",
  launch_policy: "control-smoke",
  ceiling_microusd: 0,
  confirmed: true,
};

class ListingStore implements ImmutableObjectStore {
  constructor(
    private readonly source: ImmutableObjectStore,
    private readonly transform: (
      entries: readonly ObjectEntry[],
    ) => readonly ObjectEntry[],
    private readonly corrupt = false,
  ) {}
  async list(prefix: string): Promise<readonly ObjectEntry[]> {
    return this.transform(await this.source.list(prefix));
  }
  async read(key: string): Promise<Uint8Array> {
    const bytes = await this.source.read(key);
    return this.corrupt ? new Uint8Array([...bytes, 32]) : bytes;
  }
  create(key: string, bytes: Uint8Array) {
    return this.source.create(key, bytes);
  }
}

describe("projection replay", () => {
  it("is independent of Bucket listing order", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(
      { ...input, ceiling_microusd: 1_000 },
      "listing-order-key",
      {
        subject: "operator",
        role: "operator",
      },
    );
    const policy: SandboxPolicy = {
      image: `example.invalid/task@sha256:${"a".repeat(64)}`,
      hardware: "cpu-basic",
      timeout_seconds: 600,
      idle_timeout_seconds: 300,
      inference_token: "forbidden",
      reservation_microusd: 100,
      active_hourly_cost_microusd: 10,
      max_sandboxes: 1,
      max_commands: 8,
      max_command_seconds: 300,
      max_transfer_bytes: 1_048_576,
      allowed_roots: ["/app", "/tmp"],
    };
    const createActionId = "sandbox-create-listing-order";
    expect(
      await control.service.reserveSandbox(
        submitted.campaign_id,
        createActionId,
        new Date(Date.now() - 1_000).toISOString(),
        policy.reservation_microusd,
      ),
    ).toBe(true);
    const close = control.service.actionIntent(
      submitted.campaign_id,
      "sandbox.close",
      "sandbox-listing-order",
      0,
      {
        task_id: "control-smoke-task",
        sandbox_create_action_id: createActionId,
        resource_id: "sandbox-listing-order",
        sandbox: policy,
      },
    );
    await control.service.writeAction(close);
    const receipt = await control.service.receipt(close, {
      outcome: "completed",
      observed_state: "CANCELED",
      resource_id: "sandbox-listing-order",
      cost_microusd: 50,
    });
    await control.service.markAdvanced(close, receipt);
    const projection = await Projection.open(`${control.root}/reverse.sqlite`);
    await projection.rebuild(
      new ListingStore(control.store, (entries) => [...entries].reverse()),
    );
    expect(await projection.campaign(submitted.campaign_id)).toEqual(
      await control.projection.campaign(submitted.campaign_id),
    );
    await projection.close();
  });

  it("finds only dispatched pending Sandbox commands in one task", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(
      { ...input, ceiling_microusd: 1_000 },
      "pending-sandbox-command-key",
      { subject: "operator", role: "operator" },
    );
    const policy: SandboxPolicy = {
      image: `example.invalid/task@sha256:${"b".repeat(64)}`,
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
    const create = control.service.actionIntent(
      submitted.campaign_id,
      "sandbox.create",
      "sandbox-pending-command",
      0,
      { task_id: "task-001", sandbox: policy },
    );
    await control.service.writeAction(create);
    const createReceipt = await control.service.receipt(create, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: "sandbox-pending-command-resource",
    });
    await control.service.markAdvanced(create, createReceipt);
    const command = control.service.actionIntent(
      submitted.campaign_id,
      "sandbox.exec",
      "sandbox-pending-command",
      0,
      {
        task_id: "task-001",
        sandbox_create_action_id: create.action_id,
        resource_id: "sandbox-pending-command-resource",
        sandbox: policy,
        command: ["true"],
        cwd: "/app",
        timeout_seconds: 30,
      },
    );
    await control.service.writeAction(command);
    await control.service.dispatchAction(command, "2026-08-18T00:00:00.000Z");
    const undispatched = control.service.actionIntent(
      submitted.campaign_id,
      "sandbox.exec",
      "sandbox-undispatched-command",
      0,
      {
        task_id: "task-001",
        sandbox_create_action_id: create.action_id,
        resource_id: "sandbox-pending-command-resource",
        sandbox: policy,
        command: ["false"],
        cwd: "/app",
        timeout_seconds: 30,
      },
    );
    await control.service.writeAction(undispatched);

    expect(
      await control.projection.pendingDispatchedSandboxCommandActions(
        submitted.campaign_id,
        "task-001",
      ),
    ).toEqual([command]);
    expect(
      await control.projection.pendingDispatchedSandboxCommandActions(
        submitted.campaign_id,
        "another-task",
      ),
    ).toEqual([]);
    expect(await control.projection.actionAdvanced(command.action_id)).toBe(false);

    const ambiguous = await control.service.ambiguousSandboxReceipt(command, {
      subject: "operator",
      role: "operator",
    });
    await control.service.markAdvanced(command, ambiguous);
    const nextCommand = control.service.actionIntent(
      submitted.campaign_id,
      "sandbox.exec",
      "sandbox-next-command",
      0,
      {
        task_id: "task-001",
        sandbox_create_action_id: create.action_id,
        resource_id: "sandbox-pending-command-resource",
        sandbox: policy,
        command: ["false"],
        cwd: "/app",
        timeout_seconds: 30,
      },
    );
    await expect(control.service.admitSandboxCommand(nextCommand, 1)).rejects.toThrow(
      "Sandbox command count exceeds immutable policy",
    );
    expect(
      await control.projection.pendingDispatchedSandboxCommandActions(
        submitted.campaign_id,
        "task-001",
      ),
    ).toEqual([]);
    expect(await control.projection.actionAdvanced(command.action_id)).toBe(true);
  });

  it("rejects duplicate listings and conflicting bytes", async () => {
    const control = await createTestControl();
    controls.push(control);
    await control.service.submit(input, "duplicate-listing-key", {
      subject: "operator",
      role: "operator",
    });
    const entries = await control.store.list("control/schema=v1");
    const duplicate = await Projection.open(`${control.root}/duplicate.sqlite`);
    await expect(
      duplicate.rebuild(
        new ListingStore(control.store, () => [...entries, entries[0] as ObjectEntry]),
      ),
    ).rejects.toThrow();
    await duplicate.close();
    const corrupt = await Projection.open(`${control.root}/corrupt.sqlite`);
    await expect(
      corrupt.rebuild(new ListingStore(control.store, (items) => items, true)),
    ).rejects.toBeInstanceOf(ProjectionIntegrityError);
    expect(corrupt.system().ready).toBe(false);
    await corrupt.close();
  });

  it("lists only the latest observed state for each Job", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(
      { ...input, ceiling_microusd: 100_000 },
      "jobs-latest-state-key",
      {
        subject: "operator",
        role: "operator",
      },
    );
    const actor = { subject: "operator" as const, role: "operator" as const };
    const resourceId = "job-latest-state";
    const payload = {
      task_ids: ["control-smoke-task"],
      max_infrastructure_attempts: 1,
      success_without_worker_receipt: true,
      resource_id: resourceId,
    };
    const records: Array<{
      kind: "job.launch" | "job.observe";
      generation: number;
      createdAt: string;
      observedState: string;
      costMicrousd: number;
    }> = [
      {
        kind: "job.launch",
        generation: 0,
        createdAt: "2026-08-21T10:04:10.000Z",
        observedState: "SCHEDULING",
        costMicrousd: 0,
      },
      {
        kind: "job.observe",
        generation: 0,
        createdAt: "2026-08-21T10:04:20.000Z",
        observedState: "SCHEDULING",
        costMicrousd: 10_000,
      },
      {
        kind: "job.observe",
        generation: 1,
        createdAt: "2026-08-21T10:04:30.000Z",
        observedState: "RUNNING",
        costMicrousd: 20_000,
      },
      {
        kind: "job.observe",
        generation: 2,
        createdAt: "2026-08-21T10:04:40.000Z",
        observedState: "ERROR",
        costMicrousd: 40_000,
      },
    ];
    for (const record of records) {
      const intent = control.service.actionIntent(
        submitted.campaign_id,
        record.kind,
        resourceId,
        record.generation,
        payload,
        actor,
        record.createdAt,
      );
      await control.service.writeAction(intent);
      await control.service.receipt(intent, {
        outcome: record.kind === "job.launch" ? "created" : "completed",
        observed_state: record.observedState,
        resource_id: resourceId,
        cost_microusd: record.costMicrousd,
      });
    }

    const jobs = await control.projection.jobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      campaign_id: submitted.campaign_id,
      action_kind: "job.observe",
      observed_state: "ERROR",
      resource_id: resourceId,
      cost_microusd: 40_000,
      assigned_tasks: 1,
    });
    expect(jobs[0]?.created_at).toBe("2026-08-21T10:04:40.000Z");
    expect(await control.projection.jobs(100, 0, submitted.campaign_id)).toHaveLength(
      1,
    );
    expect(await control.projection.jobs(100, 0, "campaign-missing")).toHaveLength(0);
  });

  it("does not list a pending observe as a second Job", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(input, "jobs-pending-observe-key", {
      subject: "operator",
      role: "operator",
    });
    const actor = { subject: "operator" as const, role: "operator" as const };
    const resourceId = "job-pending-observe";
    const launch = control.service.actionIntent(
      submitted.campaign_id,
      "job.launch",
      "campaign-tasks",
      0,
      { task_ids: ["control-smoke-task"] },
      actor,
      "2026-08-21T11:00:00.000Z",
    );
    await control.service.writeAction(launch);
    await control.service.receipt(launch, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: resourceId,
    });
    const observed = control.service.actionIntent(
      submitted.campaign_id,
      "job.observe",
      resourceId,
      0,
      {
        resource_id: resourceId,
        launch_action_id: launch.action_id,
      },
      actor,
      "2026-08-21T11:00:10.000Z",
    );
    await control.service.writeAction(observed);
    await control.service.receipt(observed, {
      outcome: "completed",
      observed_state: "RUNNING",
      resource_id: resourceId,
    });
    const pending = control.service.actionIntent(
      submitted.campaign_id,
      "job.observe",
      resourceId,
      1,
      {
        resource_id: resourceId,
        launch_action_id: launch.action_id,
      },
      actor,
      "2026-08-21T11:00:20.000Z",
    );
    await control.service.writeAction(pending);

    const jobs = await control.projection.jobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      action_kind: "job.observe",
      observed_state: "RUNNING",
      resource_id: resourceId,
      receipt_body: expect.any(String),
    });
  });

  it("sums attempt receipts with Job hardware receipts", async () => {
    const control = await createTestControl(1, 1, 1_000);
    controls.push(control);
    const submitted = await control.service.submit(
      { ...input, ceiling_microusd: 1_000 },
      "jobs-observed-sum-key",
      {
        subject: "operator",
        role: "operator",
      },
    );
    const actor = { subject: "operator" as const, role: "operator" as const };
    const resourceId = "job-observed-sum";
    const launch = control.service.actionIntent(
      submitted.campaign_id,
      "job.launch",
      "campaign-tasks",
      0,
      { task_ids: ["control-smoke-task"] },
      actor,
      "2026-08-21T12:00:00.000Z",
    );
    await control.service.writeAction(launch);
    await control.service.receipt(launch, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: resourceId,
    });
    const observed = control.service.actionIntent(
      submitted.campaign_id,
      "job.observe",
      resourceId,
      0,
      { resource_id: resourceId, launch_action_id: launch.action_id },
      actor,
      "2026-08-21T12:00:10.000Z",
    );
    await control.service.writeAction(observed);
    await control.service.receipt(observed, {
      outcome: "completed",
      observed_state: "COMPLETED",
      resource_id: resourceId,
      cost_microusd: 40,
    });
    const evidenceBytes = new TextEncoder().encode("observed-sum-evidence");
    const evidenceDigest = sha256(evidenceBytes);
    const evidencePath = `evidence/test/${evidenceDigest.slice("sha256:".length)}`;
    await control.store.create(evidencePath, evidenceBytes);
    await control.service.attempt({
      campaign_id: submitted.campaign_id,
      task_id: "task-001",
      attempt_id: "attempt-observed-sum",
      action_id: launch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      evidence_digest: evidenceDigest,
      evidence_path: evidencePath,
      cost_microusd: 60,
      metrics: {},
      completed_at: "2026-08-21T12:00:20.000Z",
    });
    expect(await control.projection.campaign(submitted.campaign_id)).toMatchObject({
      observed_microusd: 100,
    });
  });
});

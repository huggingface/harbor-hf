import type { SandboxPolicy } from "@harbor-hf/contracts";
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
      await control.projection.pendingDispatchedSandboxExecActions(
        submitted.campaign_id,
        "task-001",
      ),
    ).toEqual([command]);
    expect(
      await control.projection.pendingDispatchedSandboxExecActions(
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
      await control.projection.pendingDispatchedSandboxExecActions(
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
});

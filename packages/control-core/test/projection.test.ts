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

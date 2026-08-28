import { setImmediate as scheduleImmediate } from "node:timers";
import type {
  AttemptReceipt,
  HarborHFControlRecordV1,
  ProfilePromotion,
} from "@harbor-hf/contracts";
import { canonicalJson, deterministicId, sha256 } from "@harbor-hf/contracts";
import { NoopActions } from "@harbor-hf/hf-adapters";
import { createTestControl, type TestControl } from "@harbor-hf/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { Projection, ProjectionIntegrityError } from "../src/projection.js";
import { ResultPublisher } from "../src/publication.js";
import { Reconciler } from "../src/reconciler.js";
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

class ReadCountingStore implements ImmutableObjectStore {
  readonly listedPrefixes: string[] = [];
  readonly readKeys: string[] = [];

  constructor(private readonly source: ImmutableObjectStore) {}

  list(prefix: string): Promise<readonly ObjectEntry[]> {
    this.listedPrefixes.push(prefix);
    return this.source.list(prefix);
  }

  async read(key: string): Promise<Uint8Array> {
    this.readKeys.push(key);
    return this.source.read(key);
  }

  create(key: string, bytes: Uint8Array) {
    return this.source.create(key, bytes);
  }
}

class RebuildCatchupStore implements ImmutableObjectStore {
  runListCount = 0;

  constructor(
    private readonly source: ImmutableObjectStore,
    private readonly afterFirstListing: () => Promise<void>,
  ) {}

  async list(prefix: string): Promise<readonly ObjectEntry[]> {
    const entries = await this.source.list(prefix);
    if (prefix === "control/schema=v1/runs/") {
      this.runListCount += 1;
      if (this.runListCount === 1) await this.afterFirstListing();
    }
    return entries;
  }

  read(key: string): Promise<Uint8Array> {
    return this.source.read(key);
  }

  create(key: string, bytes: Uint8Array) {
    return this.source.create(key, bytes);
  }
}

class ConcurrentReadStore implements ImmutableObjectStore {
  activeReads = 0;
  activeEvidenceReads = 0;
  maxActiveReads = 0;
  maxActiveEvidenceReads = 0;

  constructor(private readonly source: ImmutableObjectStore) {}

  list(prefix: string): Promise<readonly ObjectEntry[]> {
    return this.source.list(prefix);
  }

  async read(key: string): Promise<Uint8Array> {
    this.activeReads += 1;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    const isEvidence = key.startsWith("evidence/");
    if (isEvidence) {
      this.activeEvidenceReads += 1;
      this.maxActiveEvidenceReads = Math.max(
        this.maxActiveEvidenceReads,
        this.activeEvidenceReads,
      );
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await this.source.read(key);
    } finally {
      this.activeReads -= 1;
      if (isEvidence) this.activeEvidenceReads -= 1;
    }
  }

  create(key: string, bytes: Uint8Array) {
    return this.source.create(key, bytes);
  }
}

describe("projection replay", () => {
  it("keeps legacy profile objects and promotions out of the active catalog", async () => {
    const control = await createTestControl();
    controls.push(control);
    const legacyProfile = {
      schema_version: "v1",
      kind: "profile.object",
      record_id: "profile-legacy-model",
      created_at: "2026-08-16T00:00:00.000Z",
      actor: { subject: "migration", role: "migration" },
      profile_kind: "model",
      name: "legacy-model",
      spec: { model_id: "example/legacy", revision: "legacy" },
    } as const;
    const profileId = sha256(canonicalJson(legacyProfile));
    const promotion: ProfilePromotion = {
      schema_version: "v1",
      kind: "profile.promotion",
      record_id: "promotion-legacy-model",
      created_at: "2026-08-16T00:00:01.000Z",
      actor: { subject: "migration", role: "migration" },
      profile_kind: "model",
      alias: "legacy-model",
      profile_id: profileId,
      promotion_state: "approved",
      reason: "preserve historical profile metadata",
      evidence: [],
    };
    await control.service.append(legacyProfile as unknown as HarborHFControlRecordV1);
    await control.service.append(promotion);

    const rebuilt = await Projection.open(`${control.root}/legacy-profiles.sqlite`);
    await rebuilt.rebuild(control.store);
    expect((await rebuilt.profiles()).some((row) => row.name === "legacy-model")).toBe(
      false,
    );
    await rebuilt.close();
  });
  it("reads only Run-native control trees by default", async () => {
    const control = await createTestControl();
    controls.push(control);
    const legacyKey = "control/schema=v1/campaigns/legacy-record.json";
    await control.store.create(legacyKey, new TextEncoder().encode("not-json"));
    const store = new ReadCountingStore(control.store);
    const projection = await Projection.open(`${control.root}/run-native.sqlite`);

    await projection.rebuild(store);
    await projection.sync(store);

    expect(store.listedPrefixes).toEqual([
      "control/schema=v1/migrations/",
      "control/schema=v1/operators/",
      "control/schema=v1/profiles/",
      "control/schema=v1/runs/",
      "control/schema=v1/migrations/",
      "control/schema=v1/operators/",
      "control/schema=v1/profiles/",
      "control/schema=v1/runs/",
      "control/schema=v1/migrations/",
      "control/schema=v1/operators/",
      "control/schema=v1/profiles/",
      "control/schema=v1/runs/",
    ]);
    expect(store.readKeys).not.toContain(legacyKey);
    expect(projection.system()).toMatchObject({ ready: true, integrity_error: null });
    await projection.close();
  });

  it("catches up records written during a projection rebuild", async () => {
    const control = await createTestControl();
    controls.push(control);
    const record = {
      schema_version: "v1",
      kind: "operator.acl",
      record_id: "rebuild-catchup",
      created_at: "2026-08-26T10:00:00.000Z",
      actor: { subject: "projection-test", role: "migration" },
      operators: ["operator"],
      readers: [],
    } as const;
    const key = `control/schema=v1/operators/${record.record_id}.json`;
    const store = new RebuildCatchupStore(control.store, async () => {
      await control.store.create(key, new TextEncoder().encode(canonicalJson(record)));
    });
    const projection = await Projection.open(`${control.root}/catchup.sqlite`);

    await projection.rebuild(store);

    expect(store.runListCount).toBe(3);
    expect(await projection.objectDigest(key)).not.toBeNull();
    expect(await projection.latestAcl()).toMatchObject({
      record_id: record.record_id,
    });
    await projection.close();
  });

  it("prefetches rebuild objects with bounded concurrency", async () => {
    const control = await createTestControl();
    controls.push(control);
    const store = new ConcurrentReadStore(control.store);
    const projection = await Projection.open(`${control.root}/concurrent.sqlite`);

    await projection.rebuild(store);

    expect(store.maxActiveReads).toBeGreaterThan(1);
    expect(store.maxActiveReads).toBeLessThanOrEqual(16);
    await projection.close();
  });

  it("yields to the event loop while applying a projection rebuild", async () => {
    const control = await createTestControl();
    controls.push(control);
    for (let index = 0; index < 64; index += 1) {
      const record = {
        schema_version: "v1",
        kind: "operator.acl",
        record_id: `rebuild-yield-${index}`,
        created_at: `2026-08-24T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        actor: { subject: "projection-test", role: "migration" },
        operators: ["operator"],
        readers: [],
      } as const;
      await control.store.create(
        `control/schema=v1/operators/${record.record_id}.json`,
        new TextEncoder().encode(canonicalJson(record)),
      );
    }
    const projection = await Projection.open(`${control.root}/yield.sqlite`);
    let heartbeatObserved = false;
    scheduleImmediate(() => {
      heartbeatObserved = true;
    });

    await projection.rebuild(control.store);

    expect(heartbeatObserved).toBe(true);
    await projection.close();
  });

  it("verifies rebuild evidence with bounded concurrency", async () => {
    const control = await createTestControl(2);
    controls.push(control);
    const submitted = await control.service.submit(input, "concurrent-evidence-key", {
      subject: "operator",
      role: "operator",
    });
    for (const [index, taskId] of ["task-001", "task-002"].entries()) {
      const launch = control.service.actionIntent(
        submitted.run_id,
        "job.launch",
        taskId,
        0,
        {
          worker_role: "execution",
          task_id: taskId,
          task_ids: [taskId],
        },
      );
      await control.service.writeAction(launch);
      const evidenceBytes = new TextEncoder().encode(`evidence-${taskId}`);
      const evidenceDigest = sha256(evidenceBytes);
      const evidencePath = `evidence/test/${evidenceDigest.slice("sha256:".length)}`;
      await control.store.create(evidencePath, evidenceBytes);
      await control.service.attempt({
        run_id: submitted.run_id,
        task_id: taskId,
        attempt_id: `attempt-${taskId}`,
        action_id: launch.action_id,
        outcome: "complete",
        replacement_eligible: false,
        evidence_digest: evidenceDigest,
        evidence_path: evidencePath,
        cost_microusd: 0,
        metrics: {},
        completed_at: `2026-08-25T12:00:0${index}.000Z`,
      });
    }
    const store = new ConcurrentReadStore(control.store);
    const projection = await Projection.open(
      `${control.root}/evidence-concurrent.sqlite`,
    );

    await projection.rebuild(store);

    expect(store.maxActiveEvidenceReads).toBeGreaterThan(1);
    expect(store.maxActiveEvidenceReads).toBeLessThanOrEqual(16);
    await projection.close();
  });

  it("is independent of Bucket listing order", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(
      { ...input, ceiling_microusd: 1_000 },
      "listing-order-key",
      { subject: "operator", role: "operator" },
    );
    const projection = await Projection.open(`${control.root}/reverse.sqlite`);
    await projection.rebuild(
      new ListingStore(control.store, (entries) => [...entries].reverse()),
    );
    expect(await projection.run(submitted.run_id)).toEqual(
      await control.projection.run(submitted.run_id),
    );
    await projection.close();
  });

  it("replays scoped equal-timestamp events in insertion order", async () => {
    const control = await createTestControl();
    controls.push(control);
    const projection = await Projection.open(`${control.root}/events.sqlite`);
    const occurredAt = "2026-08-24T00:00:00.000Z";
    await projection.db
      .insertInto("objects")
      .values({
        key: "control/schema=v1/test/z-event.json",
        digest: `sha256:${"a".repeat(64)}`,
        source_identity: `xet:${"a".repeat(64)}`,
        kind: "action.intent",
        record_id: "z-event",
        created_at: occurredAt,
        body: canonicalJson({
          record_id: "z-event",
          run_id: "run-event",
          task_id: "task-event",
          action_kind: "job.observe",
          profile_kind: "capacity",
        }),
      })
      .execute();
    const firstPage = await projection.audit(null, 10);
    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]?.data).toMatchObject({
      run_id: "run-event",
      task_id: "task-event",
      action_kind: "job.observe",
      profile_kind: "capacity",
    });
    const firstEventCursor = firstPage[0]?.id;
    if (!firstEventCursor) throw new Error("first replay event has no cursor");

    await projection.db
      .insertInto("objects")
      .values({
        key: "control/schema=v1/test/a-event.json",
        digest: `sha256:${"b".repeat(64)}`,
        source_identity: `xet:${"b".repeat(64)}`,
        kind: "attempt.receipt",
        record_id: "a-event",
        created_at: occurredAt,
        body: canonicalJson({
          record_id: "a-event",
          run_id: "run-event",
          task_id: "task-event-2",
        }),
      })
      .execute();
    const secondPage = await projection.audit(firstEventCursor, 10);
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]).toMatchObject({
      type: "attempt.receipt",
      occurred_at: occurredAt,
      data: { run_id: "run-event", task_id: "task-event-2" },
    });
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

  it("reads only new objects and persists its computed digest", async () => {
    const control = await createTestControl();
    controls.push(control);
    const first = {
      schema_version: "v1",
      kind: "operator.acl",
      record_id: "operator-acl-first",
      created_at: "2026-08-24T00:00:00.000Z",
      actor: { subject: "projection-test", role: "migration" },
      operators: ["operator"],
      readers: [],
    } as const;
    const firstKey = "control/schema=v1/operators/operator-acl-first.json";
    const firstBytes = new TextEncoder().encode(canonicalJson(first));
    await control.store.create(firstKey, firstBytes);
    const rebuildKeys = (await control.store.list("control/schema=v1")).map(
      (entry) => entry.key,
    );

    const counting = new ReadCountingStore(control.store);
    const projection = await Projection.open(`${control.root}/read-count.sqlite`);
    await projection.rebuild(counting);
    expect(counting.readKeys).toEqual(rebuildKeys);
    expect(await projection.objectDigest(firstKey)).toBe(sha256(firstBytes));

    counting.readKeys.length = 0;
    expect(await projection.sync(counting)).toEqual([]);
    expect(counting.readKeys).toEqual([]);

    const second = {
      ...first,
      record_id: "operator-acl-second",
      created_at: "2026-08-24T00:00:01.000Z",
      readers: ["reader"],
    } as const;
    const secondKey = "control/schema=v1/operators/operator-acl-second.json";
    const secondBytes = new TextEncoder().encode(canonicalJson(second));
    await control.store.create(secondKey, secondBytes);

    const events = await projection.sync(counting);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "operator.acl",
      data: {
        key: secondKey,
        digest: sha256(secondBytes),
        record_id: second.record_id,
      },
    });
    expect(counting.readKeys).toEqual([secondKey]);
    expect(await projection.objectDigest(secondKey)).toBe(sha256(secondBytes));

    counting.readKeys.length = 0;
    expect(await projection.sync(counting)).toEqual([]);
    expect(counting.readKeys).toEqual([]);
    await projection.close();
  });

  it("detects an overwrite between create and the first Bucket sync", async () => {
    const control = await createTestControl();
    controls.push(control);
    const entries = await control.store.list("control/schema=v1");
    const adopted = entries[0];
    if (!adopted) throw new Error("expected an initialized control object");
    const counting = new ReadCountingStore(control.store);

    expect(await control.projection.sync(counting)).toEqual([]);
    expect(counting.readKeys).toEqual([]);

    const changed = new ReadCountingStore(
      new ListingStore(control.store, (listed) =>
        listed.map((entry) =>
          entry.key === adopted.key
            ? { ...entry, source_identity: `changed:${entry.source_identity}` }
            : entry,
        ),
      ),
    );
    await expect(control.projection.sync(changed)).rejects.toThrow(
      `source identity mismatch for ${adopted.key}`,
    );
    expect(changed.readKeys).toEqual([]);
    expect(control.projection.system().ready).toBe(false);
  });

  it("rejects ingestion when a store omits source identity", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(input, "missing-source-identity", {
      subject: "operator",
      role: "operator",
    });
    const lock = await control.projection.runLock(submitted.run_id);
    if (!lock) throw new Error("run lock is missing");
    const body = canonicalJson(lock);

    await expect(
      control.projection.ingest(
        "control/schema=v1/test/missing-source-identity.json",
        sha256(body),
        undefined as never,
        lock,
      ),
    ).rejects.toThrow("missing source identity");
  });

  it("detects a same-size overwrite from changed xetHash metadata without a read", async () => {
    const control = await createTestControl();
    controls.push(control);
    const first = {
      schema_version: "v1",
      kind: "operator.acl",
      record_id: "metadata-overwrite-xethash",
      created_at: "2026-08-24T00:00:00.000Z",
      actor: { subject: "projection-test", role: "migration" },
      operators: ["operator"],
      readers: [],
    } as const;
    const firstKey = `control/schema=v1/operators/${first.record_id}.json`;
    const firstBytes = new TextEncoder().encode(canonicalJson(first));
    await control.store.create(firstKey, firstBytes);
    const identity = (changed: boolean) => `xet:${(changed ? "b" : "a").repeat(64)}`;
    const listed = (changed: boolean) =>
      new ListingStore(control.store, (entries) =>
        entries.map((entry) =>
          entry.key === firstKey
            ? { ...entry, source_identity: identity(changed) }
            : entry,
        ),
      );
    const projection = await Projection.open(`${control.root}/metadata-xethash.sqlite`);
    await projection.rebuild(listed(false));
    const counting = new ReadCountingStore(listed(true));

    await expect(projection.sync(counting)).rejects.toBeInstanceOf(
      ProjectionIntegrityError,
    );
    expect(counting.readKeys).toEqual([]);
    expect(projection.system().ready).toBe(false);
    await projection.close();
  });

  it("returns active Runs without scanning completed history", async () => {
    const control = await createTestControl();
    controls.push(control);
    await control.service.setMaxActiveJobs(4, "projection-capacity-four");
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    const completed = await control.service.submit(input, "completed-active-runs-key", {
      subject: "operator",
      role: "operator",
    });
    for (let index = 0; index < 10; index += 1) await reconciler.tick();
    expect(await control.projection.run(completed.run_id)).toMatchObject({
      status: "completed",
    });

    const active = await control.service.submit(input, "active-runs-key", {
      subject: "operator",
      role: "operator",
    });
    expect((await control.projection.activeRuns()).map((run) => run.run_id)).toEqual([
      active.run_id,
    ]);
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
      task_id: "control-smoke-task",
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
    let launchActionId: string | null = null;
    for (const record of records) {
      const intent = control.service.actionIntent(
        submitted.run_id,
        record.kind,
        resourceId,
        record.generation,
        {
          ...payload,
          ...(launchActionId ? { launch_action_id: launchActionId } : {}),
        },
        actor,
        record.createdAt,
      );
      if (record.kind === "job.launch") launchActionId = intent.action_id;
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
      run_id: submitted.run_id,
      action_kind: "job.observe",
      observed_state: "ERROR",
      resource_id: resourceId,
      cost_microusd: 40_000,
      assigned_tasks: 1,
    });
    expect(jobs[0]?.created_at).toBe("2026-08-21T10:04:40.000Z");
    expect(await control.projection.jobs(100, 0, submitted.run_id)).toHaveLength(1);
    expect(await control.projection.jobs(100, 0, "run-missing")).toHaveLength(0);
  });

  it("keeps launch assignments on the latest cancellation row", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(
      input,
      "jobs-cancel-assignment-key",
      {
        subject: "operator",
        role: "operator",
      },
    );
    const resourceId = "job-cancel-assignment";
    const launch = control.service.actionIntent(
      submitted.run_id,
      "job.launch",
      "task-001",
      0,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
      },
      undefined,
      "2026-08-21T11:30:00.000Z",
    );
    await control.service.writeAction(launch);
    await control.service.receipt(launch, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: resourceId,
    });
    const cancellation = control.service.actionIntent(
      submitted.run_id,
      "job.cancel",
      resourceId,
      0,
      {
        resource_id: resourceId,
        launch_action_id: launch.action_id,
      },
      undefined,
      "2026-08-21T11:30:10.000Z",
    );
    await control.service.writeAction(cancellation);
    await control.service.receipt(cancellation, {
      outcome: "completed",
      observed_state: "CANCELED",
      resource_id: resourceId,
    });

    expect(await control.projection.jobs()).toMatchObject([
      {
        action_kind: "job.cancel",
        launch_action_id: launch.action_id,
        assigned_tasks: 1,
      },
    ]);
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
      submitted.run_id,
      "job.launch",
      "task-001",
      0,
      { task_id: "task-001", task_ids: ["task-001"] },
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
      submitted.run_id,
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
      submitted.run_id,
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

  it("paginates materialized Jobs without reducing action history", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(input, "jobs-page-key", {
      subject: "operator",
      role: "operator",
    });
    const actor = { subject: "operator" as const, role: "operator" as const };
    const launches: string[] = [];

    for (let jobIndex = 0; jobIndex < 3; jobIndex += 1) {
      const resourceId = `job-page-${jobIndex}`;
      const launch = control.service.actionIntent(
        submitted.run_id,
        "job.launch",
        `task-001-${jobIndex}`,
        0,
        {
          worker_role: "execution",
          task_id: "task-001",
          task_ids: ["task-001"],
          ...(jobIndex === 1 ? { prior_attempt_id: "attempt-infrastructure" } : {}),
        },
        actor,
        `2026-08-21T13:00:0${jobIndex}.000Z`,
      );
      launches.push(launch.action_id);
      await control.service.writeAction(launch);
      await control.service.receipt(launch, {
        outcome: "created",
        observed_state: "RUNNING",
        resource_id: resourceId,
      });

      for (let generation = 0; generation < 10; generation += 1) {
        const observed = control.service.actionIntent(
          submitted.run_id,
          "job.observe",
          resourceId,
          generation,
          {
            resource_id: resourceId,
            launch_action_id: launch.action_id,
          },
          actor,
          `2026-08-21T13:0${jobIndex + 1}:${String(generation).padStart(2, "0")}.000Z`,
        );
        await control.service.writeAction(observed);
        await control.service.receipt(observed, {
          outcome: "completed",
          observed_state: "RUNNING",
          resource_id: resourceId,
          cost_microusd: generation,
        });
      }
    }

    const cancellation = control.service.actionIntent(
      submitted.run_id,
      "job.cancel",
      "job-page-2",
      0,
      {
        resource_id: "job-page-2",
        launch_action_id: launches[2],
      },
      actor,
      "2026-08-21T13:04:00.000Z",
    );
    await control.service.writeAction(cancellation);
    await control.service.receipt(cancellation, {
      outcome: "completed",
      observed_state: "CANCELED",
      resource_id: "job-page-2",
    });
    const pending = control.service.actionIntent(
      submitted.run_id,
      "job.observe",
      "job-page-1",
      10,
      {
        resource_id: "job-page-1",
        launch_action_id: launches[1],
      },
      actor,
      "2026-08-21T13:05:00.000Z",
    );
    await control.service.writeAction(pending);

    const firstPage = await control.projection.jobs(2);
    const secondPage = await control.projection.jobs(2, 2);
    expect(firstPage.map((job) => job.launch_action_id)).toEqual([
      launches[2],
      launches[1],
    ]);
    expect(secondPage.map((job) => job.launch_action_id)).toEqual([launches[0]]);
    expect([...firstPage, ...secondPage].map((job) => job.assigned_tasks)).toEqual([
      1, 1, 1,
    ]);
    expect(firstPage[0]).toMatchObject({
      action_kind: "job.cancel",
      observed_state: "CANCELED",
    });
    expect(firstPage[1]).toMatchObject({
      action_kind: "job.observe",
      observed_state: "RUNNING",
      receipt_body: expect.any(String),
    });

    const runJobs = await control.projection.jobs(null, 0, submitted.run_id);
    expect(runJobs).toEqual([...firstPage, ...secondPage]);
    const projectedCount = await control.projection.db
      .selectFrom("jobs")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    const actionCount = await control.projection.db
      .selectFrom("actions")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(projectedCount.count)).toBe(3);
    expect(Number(actionCount.count)).toBeGreaterThan(30);

    expect(await control.projection.run(submitted.run_id)).toMatchObject({
      replacement_assigned_tasks: 1,
      replacement_recorded_tasks: 0,
    });

    const rebuilt = await Projection.open(`${control.root}/jobs-rebuilt.sqlite`);
    await rebuilt.rebuild(control.store);
    expect(await rebuilt.jobs(null, 0, submitted.run_id)).toEqual(runJobs);
    await rebuilt.close();
  });

  it("excludes suppressed replacement launches from running progress", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(
      input,
      "suppressed-replacement-key",
      {
        subject: "operator",
        role: "operator",
      },
    );
    const launch = control.service.actionIntent(
      submitted.run_id,
      "job.launch",
      "task-001-replacement",
      0,
      {
        worker_role: "execution",
        task_id: "task-001",
        task_ids: ["task-001"],
        prior_attempt_id: "attempt-infrastructure",
      },
      { subject: "operator", role: "operator" },
      "2026-08-21T13:00:00.000Z",
    );
    await control.service.writeAction(launch);
    await control.service.receipt(launch, {
      outcome: "completed",
      observed_state: "suppressed-paused",
      resource_id: null,
    });

    expect(await control.projection.jobs(null, 0, submitted.run_id)).toMatchObject([
      {
        observed_state: "suppressed-paused",
        receipt_body: expect.any(String),
      },
    ]);
    expect(await control.projection.run(submitted.run_id)).toMatchObject({
      replacement_assigned_tasks: 0,
      replacement_recorded_tasks: 0,
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
      submitted.run_id,
      "job.launch",
      "task-001",
      0,
      { task_id: "task-001", task_ids: ["task-001"] },
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
      submitted.run_id,
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
      run_id: submitted.run_id,
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
    expect(await control.projection.run(submitted.run_id)).toMatchObject({
      observed_microusd: 100,
    });
  });

  it("rejects a replayed attempt assigned to another Job task", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(input, "replay-task-binding", {
      subject: "operator",
      role: "operator",
    });
    const launch = control.service.actionIntent(
      submitted.run_id,
      "job.launch",
      "other-task",
      0,
      {
        worker_role: "execution",
        task_id: "other-task",
        task_ids: ["other-task"],
      },
    );
    await control.service.writeAction(launch);
    const attempt: AttemptReceipt = {
      schema_version: "v1",
      kind: "attempt.receipt",
      record_id: deterministicId("attempt-receipt", "replay-task-mismatch"),
      created_at: "2026-08-21T12:00:00.000Z",
      actor: { subject: "trusted-worker", role: "service" },
      run_id: submitted.run_id,
      task_id: "task-001",
      attempt_id: "replay-task-mismatch",
      action_id: launch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      evidence_digest: sha256("replay-task-mismatch"),
      evidence_path: "evidence/replay-task-mismatch",
      cost_microusd: 0,
      metrics: {},
      completed_at: "2026-08-21T12:00:00.000Z",
    };
    const attemptBody = canonicalJson(attempt);
    await expect(
      control.projection.ingest(
        "control/schema=v1/test/replay-task-mismatch.json",
        sha256(attemptBody),
        sha256(attemptBody),
        attempt,
      ),
    ).rejects.toThrow("attempt Job assignment mismatch");
  });
});

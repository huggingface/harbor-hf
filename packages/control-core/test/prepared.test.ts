import type {
  ActionIntent,
  ProfileObject,
  ProfilePromotion,
  SandboxPolicy,
} from "@harbor-hf/contracts";
import { canonicalJson, deterministicId, sha256 } from "@harbor-hf/contracts";
import {
  FilesystemObjectStore,
  Projection,
  type ControlService,
} from "@harbor-hf/control-core";
import { preparedProfiles } from "@harbor-hf/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExternalActionPort,
  type ExternalActionResult,
  Reconciler,
} from "../src/reconciler.js";
import { ResultPublisher } from "../src/publication.js";
import { ControlService as Service } from "../src/service.js";

const controls: Array<{
  root: string;
  projection: Projection;
  service: ControlService;
}> = [];

afterEach(async () => {
  for (const control of controls.splice(0)) {
    await control.projection.close();
    await rm(control.root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hhf-prepared-"));
  const bucket = join(root, "bucket");
  await mkdir(bucket);
  const store = new FilesystemObjectStore(bucket);
  const projection = await Projection.open(join(root, "projection.sqlite"));
  const profiles = preparedProfiles();
  const service = new Service("test", store, projection, profiles);
  await projection.rebuild(store);
  await service.initialize(profiles);
  controls.push({ root, projection, service });
  return { service, projection };
}

async function configureCapacity(service: Service): Promise<void> {
  const createdAt = "2026-08-22T00:00:00.000Z";
  const spec = {
    namespace: "test",
    max_active_sandboxes: 2,
    hardware_limits: [{ hardware: "cpu-basic", max_active_sandboxes: 1 }],
    start_burst: 2,
    start_refill_tokens: 1,
    start_refill_period_seconds: 60,
  };
  const profile: ProfileObject = {
    schema_version: "v1",
    kind: "profile.object",
    record_id: deterministicId(
      "profile",
      "capacity",
      "prepared-capacity",
      sha256(canonicalJson(spec)),
    ),
    created_at: createdAt,
    actor: { subject: "test", role: "service" },
    profile_kind: "capacity",
    name: "prepared-capacity",
    spec,
  };
  const promotion: ProfilePromotion = {
    schema_version: "v1",
    kind: "profile.promotion",
    record_id: deterministicId("profile-promotion", "capacity", "current"),
    created_at: createdAt,
    actor: { subject: "operator", role: "operator" },
    profile_kind: "capacity",
    alias: "current",
    profile_id: sha256(canonicalJson(profile)),
    promotion_state: "approved",
    reason: "test capacity policy",
    evidence: [],
  };
  await service.append(profile);
  await service.append(promotion);
  await service.refreshProfileResolver();
  service.configureCapacityProfile("current");
}

async function campaign(service: Service, idempotencyKey = "prepared-campaign") {
  const submitted = await service.submit(
    {
      benchmark: "prepared-benchmark",
      model: "prepared-model",
      harness: "prepared-harness",
      deployment: "prepared-deployment",
      launch_policy: "prepared-policy",
      ceiling_microusd: 1_000_000,
      confirmed: true,
    },
    idempotencyKey,
    { subject: "operator", role: "operator" },
  );
  const lock = await service.projection.campaignLock(submitted.campaign_id);
  if (!lock) throw new Error("campaign lock is missing");
  const launch = service.actionIntent(
    submitted.campaign_id,
    "job.launch",
    "campaign-preparation",
    0,
    {
      worker_role: "preparation",
      task_ids: lock.tasks.map((task) => task.task_id),
      job_image:
        "example.invalid/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      job_command: ["prepare-worker"],
      hardware: "cpu-basic",
      timeout_seconds: 600,
      trusted_worker: true,
      inference_token: "forbidden",
      campaign_lock_digest: sha256(canonicalJson(lock)),
    },
  );
  await service.writeAction(launch);
  return { campaignId: submitted.campaign_id, lock, launch };
}

class PreparationActions implements ExternalActionPort {
  prepared = false;
  failPreparation = false;
  readonly intents: ActionIntent[] = [];

  async execute(intent: ActionIntent): Promise<ExternalActionResult> {
    this.intents.push(intent);
    if (intent.action_kind === "campaign.admit")
      return { outcome: "completed", observed_state: "admitted" };
    if (intent.action_kind === "job.launch")
      return {
        outcome: "created",
        observed_state: "RUNNING",
        resource_id: `job-${intent.action_id}`,
      };
    if (intent.action_kind === "job.observe")
      return {
        outcome: "completed",
        observed_state:
          intent.payload.worker_role === "preparation" && this.failPreparation
            ? "ERROR"
            : intent.payload.worker_role === "preparation" && this.prepared
              ? "COMPLETED"
              : "RUNNING",
        resource_id: intent.payload.resource_id as string,
      };
    return { outcome: "completed", observed_state: "handled" };
  }
}

function trialPayload(inputDigest: string) {
  return {
    phase: "trial",
    task_id: "task-001-trial-1",
    source_task_id: "task-001",
    trial_index: 1,
    input_digest: inputDigest,
    trial_lock: {
      schema_version: 2,
      task: {
        name: "task-001",
        type: "git",
        digest: inputDigest,
        path: "tasks/task-001",
        git_url: "https://github.com/example/tasks.git",
        git_commit_id: "a".repeat(40),
      },
      agent: {
        import_path: "example.agent:Agent",
        model_name: "openai/example/model:provider",
      },
      environment: {
        import_path:
          "harbor_hf_agents.support.control_sandbox_environment:ControlSandboxEnvironment",
        delete: true,
        kwargs: {
          control_task_id: "task-001-trial-1",
          control_max_command_seconds: 900,
          control_keepalive_seconds: 300,
        },
      },
      verifier: { disable: false },
    },
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
}

function finalizePayload(createdAt: string) {
  return {
    phase: "finalize",
    harbor_version: "0.21.0",
    job_config: {
      n_attempts: 1,
      datasets: [
        {
          repo: `https://github.com/example/tasks.git@${"a".repeat(40)}`,
          path: "tasks",
        },
      ],
      agents: [
        {
          import_path: "example.agent:Agent",
          model_name: "openai/example/model:provider",
        },
      ],
      retry: { max_retries: 0 },
    },
    job_lock_header: {
      schema_version: 3,
      created_at: createdAt,
      harbor: { version: "0.21.0" },
      n_concurrent_trials: 1,
      retry: { max_retries: 0 },
    },
  };
}

async function settle(reconciler: Reconciler, rounds: number): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await reconciler.tick();
}

describe("prepared Harbor jobs", () => {
  it("reports hardware capacity before a queued campaign gets a Sandbox", async () => {
    const { service } = await setup();
    await configureCapacity(service);
    const first = await campaign(service, "hardware-view-first");
    const queued = await campaign(service, "hardware-view-queued");
    const policy: SandboxPolicy = {
      image: `registry.example/sandbox@sha256:${"d".repeat(64)}`,
      hardware: "cpu-basic",
      timeout_seconds: 3_600,
      idle_timeout_seconds: 600,
      inference_token: "forbidden",
      reservation_microusd: 100,
      active_hourly_cost_microusd: 10_000,
      max_sandboxes: 2,
      max_commands: 128,
      max_command_seconds: 3_600,
      max_transfer_bytes: 67_108_864,
      allowed_roots: ["/app", "/logs", "/tmp"],
    };
    const create = (campaignId: string) =>
      service.actionIntent(campaignId, "sandbox.create", "task-001-trial-1", 0, {
        task_id: "task-001-trial-1",
        sandbox: policy,
      });
    const firstIntent = create(first.campaignId);
    const queuedIntent = create(queued.campaignId);

    await expect(service.admitSandboxCreate(firstIntent, 2)).resolves.toEqual(
      expect.objectContaining({ status: "admitted" }),
    );
    await expect(service.admitSandboxCreate(queuedIntent, 2)).resolves.toEqual(
      expect.objectContaining({
        status: "deferred",
        limiting_factor: "hardware_sandbox_capacity",
      }),
    );

    await expect(service.sandboxCapacityView(queued.campaignId)).resolves.toEqual(
      expect.objectContaining({
        hardware_limit: 1,
        hardware_active: 1,
        limiting_factor: "hardware_sandbox_capacity",
      }),
    );
  });

  it("stores one exact immutable Harbor lock before execution", async () => {
    const { service } = await setup();
    const { campaignId, lock, launch } = await campaign(service);
    const task = lock.tasks[0];
    if (!task) throw new Error("campaign task is missing");

    const trial = await service.submitPreparedJob(
      campaignId,
      launch.action_id,
      trialPayload(task.input_digest),
    );
    expect(trial).toMatchObject({ phase: "trial", adopted: false });
    await expect(
      service.submitPreparedJob(
        campaignId,
        launch.action_id,
        trialPayload(task.input_digest),
      ),
    ).resolves.toMatchObject({ adopted: true });

    const finalized = await service.submitPreparedJob(
      campaignId,
      launch.action_id,
      finalizePayload(lock.created_at),
    );
    expect(finalized).toMatchObject({ phase: "finalize", adopted: false });
    const prepared = await service.preparedJob(campaignId);
    expect(prepared).toMatchObject({
      campaign_id: campaignId,
      harbor_version: "0.21.0",
      trials: [{ task_id: "task-001-trial-1" }],
    });
    expect(prepared?.harbor_lock_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("runs preparation before it launches benchmark execution", async () => {
    const { service, projection } = await setup();
    const submitted = await service.submit(
      {
        benchmark: "prepared-benchmark",
        model: "prepared-model",
        harness: "prepared-harness",
        deployment: "prepared-deployment",
        launch_policy: "prepared-policy",
        ceiling_microusd: 1_000_000,
        confirmed: true,
      },
      "prepared-reconciler-campaign",
      { subject: "operator", role: "operator" },
    );
    const actions = new PreparationActions();
    const reconciler = new Reconciler(
      service,
      projection,
      actions,
      new ResultPublisher(service.store, projection, service),
      {
        interval_ms: 100,
        observation_interval_ms: 0,
        worker_receipt_grace_ms: 0,
        batch_size: 16,
      },
    );
    await settle(reconciler, 5);
    const lock = await projection.campaignLock(submitted.campaign_id);
    if (!lock) throw new Error("campaign lock is missing");
    const preparation = (await projection.campaignActions(submitted.campaign_id))
      .map((row) => JSON.parse(row.intent_body) as ActionIntent)
      .find(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "preparation",
      );
    if (!preparation) throw new Error("preparation launch is missing");
    expect(actions.intents).not.toContainEqual(
      expect.objectContaining({
        action_kind: "job.launch",
        payload: expect.objectContaining({ worker_role: "execution" }),
      }),
    );
    const task = lock.tasks[0];
    if (!task) throw new Error("campaign task is missing");
    await service.submitPreparedJob(
      submitted.campaign_id,
      preparation.action_id,
      trialPayload(task.input_digest),
    );
    await service.submitPreparedJob(
      submitted.campaign_id,
      preparation.action_id,
      finalizePayload(lock.created_at),
    );
    actions.prepared = true;
    await settle(reconciler, 5);

    const execution = (await projection.campaignActions(submitted.campaign_id))
      .map((row) => JSON.parse(row.intent_body) as ActionIntent)
      .find(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "execution",
      );
    expect(execution?.payload).toMatchObject({
      task_ids: ["task-001-trial-1"],
      sandbox_authorized: true,
      worker_revision: "abcdef0",
    });
    expect(execution?.payload.prepared_job_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("prepares a start-paused campaign and adopts its repeated resume", async () => {
    const { service, projection } = await setup();
    const submitted = await service.submit(
      {
        benchmark: "prepared-benchmark",
        model: "prepared-model",
        harness: "prepared-harness",
        deployment: "prepared-deployment",
        launch_policy: "prepared-policy",
        ceiling_microusd: 1_000_000,
        start_paused: true,
        confirmed: true,
      },
      "prepared-paused-campaign",
      { subject: "operator", role: "operator" },
    );
    const actions = new PreparationActions();
    const reconciler = new Reconciler(
      service,
      projection,
      actions,
      new ResultPublisher(service.store, projection, service),
      {
        interval_ms: 100,
        observation_interval_ms: 0,
        worker_receipt_grace_ms: 0,
        batch_size: 16,
      },
    );
    await settle(reconciler, 5);
    const lock = await projection.campaignLock(submitted.campaign_id);
    if (!lock) throw new Error("campaign lock is missing");
    const preparation = (await projection.campaignActions(submitted.campaign_id))
      .map((row) => JSON.parse(row.intent_body) as ActionIntent)
      .find(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "preparation",
      );
    if (!preparation) throw new Error("preparation launch is missing");
    const task = lock.tasks[0];
    if (!task) throw new Error("campaign task is missing");
    await service.submitPreparedJob(
      submitted.campaign_id,
      preparation.action_id,
      trialPayload(task.input_digest),
    );
    await service.submitPreparedJob(
      submitted.campaign_id,
      preparation.action_id,
      finalizePayload(lock.created_at),
    );
    actions.prepared = true;
    await settle(reconciler, 5);

    expect(await service.preparedJob(submitted.campaign_id)).not.toBeNull();
    expect(await projection.campaign(submitted.campaign_id)).toMatchObject({
      status: "paused",
      paused: true,
      terminal_tasks: 0,
    });
    expect(
      actions.intents.filter(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "execution",
      ),
    ).toHaveLength(0);

    const first = await service.campaignAction(
      submitted.campaign_id,
      { action: "resume", task_limit: 1, confirmed: true },
      "prepared-paused-resume",
      { subject: "operator", role: "operator" },
    );
    const repeated = await service.campaignAction(
      submitted.campaign_id,
      { action: "resume", task_limit: 1, confirmed: true },
      "prepared-paused-resume",
      { subject: "operator", role: "operator" },
    );
    expect(repeated).toMatchObject({ action_id: first.action_id, adopted: true });
    await settle(reconciler, 4);

    expect(
      actions.intents.filter(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "execution",
      ),
    ).toHaveLength(1);
  });

  it("stops preparation after its configured attempt limit", async () => {
    const { service, projection } = await setup();
    const submitted = await service.submit(
      {
        benchmark: "prepared-benchmark",
        model: "prepared-model",
        harness: "prepared-harness",
        deployment: "prepared-deployment",
        launch_policy: "prepared-policy",
        ceiling_microusd: 1_000_000,
        confirmed: true,
      },
      "failed-preparation-campaign",
      { subject: "operator", role: "operator" },
    );
    const actions = new PreparationActions();
    actions.failPreparation = true;
    const reconciler = new Reconciler(
      service,
      projection,
      actions,
      new ResultPublisher(service.store, projection, service),
      {
        interval_ms: 100,
        observation_interval_ms: 0,
        worker_receipt_grace_ms: 0,
        batch_size: 16,
      },
    );

    await settle(reconciler, 24);

    const launches = (await projection.campaignActions(submitted.campaign_id))
      .map((row) => JSON.parse(row.intent_body) as ActionIntent)
      .filter(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "preparation",
      );
    expect(launches).toHaveLength(2);
    expect(launches.every((intent) => intent.target === "campaign-preparation")).toBe(
      true,
    );
    expect(await projection.campaign(submitted.campaign_id)).toMatchObject({
      terminal_tasks: 1,
      total_tasks: 1,
    });
  });

  it("rejects prepared task sources outside the benchmark profile", async () => {
    const { service } = await setup();
    const { campaignId, lock, launch } = await campaign(service);
    const task = lock.tasks[0];
    if (!task) throw new Error("campaign task is missing");
    const payload = trialPayload(task.input_digest);
    (payload.trial_lock.task as Record<string, unknown>).git_url =
      "https://github.com/example/other.git";

    await expect(
      service.submitPreparedJob(campaignId, launch.action_id, payload),
    ).rejects.toThrow("task source does not match");
  });

  it("accepts a historical prepared environment without explicit keepalive", async () => {
    const { service } = await setup();
    const { campaignId, lock, launch } = await campaign(service);
    const task = lock.tasks[0];
    if (!task) throw new Error("campaign task is missing");
    const payload = trialPayload(task.input_digest);
    delete (payload.trial_lock.environment.kwargs as Record<string, unknown>)
      .control_keepalive_seconds;

    await expect(
      service.submitPreparedJob(campaignId, launch.action_id, payload),
    ).resolves.toMatchObject({ phase: "trial", adopted: false });
  });

  it("rejects a prepared command limit that differs from task timeouts", async () => {
    const { service } = await setup();
    const { campaignId, lock, launch } = await campaign(service);
    const task = lock.tasks[0];
    if (!task) throw new Error("campaign task is missing");
    const payload = trialPayload(task.input_digest);
    (
      payload.trial_lock.environment.kwargs as Record<string, unknown>
    ).control_max_command_seconds = 899;

    await expect(
      service.submitPreparedJob(campaignId, launch.action_id, payload),
    ).rejects.toThrow("environment does not match control policy");
  });

  it("rejects a prepared keepalive that differs from task timeouts", async () => {
    const { service } = await setup();
    const { campaignId, lock, launch } = await campaign(service);
    const task = lock.tasks[0];
    if (!task) throw new Error("campaign task is missing");
    const payload = trialPayload(task.input_digest);
    (
      payload.trial_lock.environment.kwargs as Record<string, unknown>
    ).control_keepalive_seconds = 299;

    await expect(
      service.submitPreparedJob(campaignId, launch.action_id, payload),
    ).rejects.toThrow("environment does not match control policy");
  });

  it("rejects a changed prepared trial after the first durable write", async () => {
    const { service } = await setup();
    const { campaignId, lock, launch } = await campaign(service);
    const task = lock.tasks[0];
    if (!task) throw new Error("campaign task is missing");
    await service.submitPreparedJob(
      campaignId,
      launch.action_id,
      trialPayload(task.input_digest),
    );

    await expect(
      service.submitPreparedJob(campaignId, launch.action_id, {
        ...trialPayload(task.input_digest),
        cpus: 2,
      }),
    ).rejects.toThrow("conflicts with durable state");
  });
});

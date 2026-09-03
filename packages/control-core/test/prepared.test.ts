import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ActionIntent,
  ProfileObject,
  ProfilePromotion,
} from "@harbor-hf/contracts";
import { canonicalJson, deterministicId, sha256 } from "@harbor-hf/contracts";
import {
  type ControlService,
  FilesystemObjectStore,
  Projection,
} from "@harbor-hf/control-core";
import { preparedProfiles } from "@harbor-hf/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResultPublisher } from "../src/publication.js";
import {
  type ExternalActionPort,
  type ExternalActionResult,
  Reconciler,
} from "../src/reconciler.js";
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

async function setup(taskCount = 1) {
  const root = await mkdtemp(join(tmpdir(), "hhf-prepared-"));
  const bucket = join(root, "bucket");
  await mkdir(bucket);
  const store = new FilesystemObjectStore(bucket);
  const projection = await Projection.open(join(root, "projection.sqlite"));
  const profiles = preparedProfiles(taskCount);
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
    max_active_jobs: 2,
    hardware_limits: [{ hardware: "cpu-basic", max_active_jobs: 1 }],
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

async function run(service: Service, idempotencyKey = "prepared-run") {
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
  const lock = await service.projection.runLock(submitted.run_id);
  if (!lock) throw new Error("run lock is missing");
  const launch = service.actionIntent(
    submitted.run_id,
    "job.launch",
    "run-preparation",
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
      run_lock_digest: sha256(canonicalJson(lock)),
    },
  );
  await service.writeAction(launch);
  return { runId: submitted.run_id, lock, launch };
}

class PreparationActions implements ExternalActionPort {
  prepared = false;
  failPreparation = false;
  readonly intents: ActionIntent[] = [];

  async execute(intent: ActionIntent): Promise<ExternalActionResult> {
    this.intents.push(intent);
    if (intent.action_kind === "run.admit")
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

function trialPayload(
  inputDigest: string,
  taskId = "task-001-trial-1",
  sourceTaskId = "task-001",
) {
  return {
    phase: "trial",
    task_id: taskId,
    source_task_id: sourceTaskId,
    trial_index: 1,
    input_digest: inputDigest,
    trial_lock: {
      schema_version: 2,
      task: {
        name: sourceTaskId,
        type: "git",
        digest: inputDigest,
        path: `tasks/${sourceTaskId}`,
        git_url: "https://github.com/example/tasks.git",
        git_commit_id: "a".repeat(40),
      },
      agent: {
        import_path: "example.agent:Agent",
        model_name: "openai/example/model:provider",
        env: {
          OPENAI_API_KEY: `\${HF_INFERENCE_TOKEN}`,
          OPENAI_BASE_URL: "https://router.huggingface.co/v1",
          HARBOR_HF_MAX_OUTPUT_TOKENS: "32768",
          HARBOR_HF_PROVIDER_TIMEOUT_SECONDS: "600",
        },
        extra_allowed_hosts: ["router.huggingface.co"],
      },
      environment: {
        import_path: "example.environment:Environment",
        delete: true,
        kwargs: {
          control_task_id: taskId,
          control_max_command_seconds: 900,
          control_keepalive_seconds: 300,
          control_max_transfer_bytes: 1_073_741_824,
          control_max_transfer_file_bytes: 536_870_912,
          control_max_transfer_files: 10_000,
          control_max_transfer_path_depth: 32,
        },
      },
      verifier: { disable: false },
    },
    trial_lock_digest: `sha256:${"c".repeat(64)}`,
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
          env: {
            OPENAI_API_KEY: `\${HF_INFERENCE_TOKEN}`,
            OPENAI_BASE_URL: "https://router.huggingface.co/v1",
            HARBOR_HF_MAX_OUTPUT_TOKENS: "32768",
            HARBOR_HF_PROVIDER_TIMEOUT_SECONDS: "600",
          },
          extra_allowed_hosts: ["router.huggingface.co"],
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
  it("reports hardware capacity before a queued run gets a Job", async () => {
    const { service } = await setup();
    await configureCapacity(service);
    const first = await run(service, "hardware-view-first");
    const queued = await run(service, "hardware-view-queued");
    const launch = (runId: string) =>
      service.actionIntent(runId, "job.launch", "task-001-trial-1", 0, {
        worker_role: "execution",
        task_id: "task-001-trial-1",
        task_ids: ["task-001-trial-1"],
        hardware: "cpu-basic",
        max_jobs: 2,
      });
    const firstIntent = launch(first.runId);
    const queuedIntent = launch(queued.runId);

    await expect(service.admitJobLaunch(firstIntent)).resolves.toEqual(
      expect.objectContaining({ status: "admitted" }),
    );
    await expect(service.admitJobLaunch(queuedIntent)).resolves.toEqual(
      expect.objectContaining({
        status: "deferred",
        limiting_factor: "hardware_job_capacity",
      }),
    );

    await expect(service.jobCapacityView(queued.runId)).resolves.toEqual(
      expect.objectContaining({
        hardware_limit: 1,
        hardware_active: 1,
        limiting_factor: "hardware_job_capacity",
      }),
    );
  });

  it("stores one exact immutable Harbor lock before execution", async () => {
    const { service } = await setup();
    const { runId, lock, launch } = await run(service);
    const task = lock.tasks[0];
    if (!task) throw new Error("run task is missing");

    const trial = await service.submitPreparedJob(
      runId,
      launch.action_id,
      trialPayload(task.input_digest),
    );
    expect(trial).toMatchObject({ phase: "trial", adopted: false });
    await expect(
      service.submitPreparedJob(
        runId,
        launch.action_id,
        trialPayload(task.input_digest),
      ),
    ).resolves.toMatchObject({ adopted: true });

    const finalized = await service.submitPreparedJob(
      runId,
      launch.action_id,
      finalizePayload(lock.created_at),
    );
    expect(finalized).toMatchObject({ phase: "finalize", adopted: false });
    const prepared = await service.preparedJob(runId);
    expect(prepared).toMatchObject({
      run_id: runId,
      harbor_version: "0.21.0",
      trials: [{ task_id: "task-001-trial-1" }],
    });
    expect(await service.preparedTrial(runId, "task-001-trial-1")).toMatchObject({
      trial_lock_digest: `sha256:${"c".repeat(64)}`,
    });
    expect(prepared?.harbor_lock_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("persists preparations for independent Runs concurrently", async () => {
    const { service } = await setup();
    const first = await run(service, "parallel-preparation-first");
    const second = await run(service, "parallel-preparation-second");
    const firstTask = first.lock.tasks[0];
    const secondTask = second.lock.tasks[0];
    if (!firstTask || !secondTask) throw new Error("run task is missing");
    const create = service.store.create.bind(service.store);
    let activeCreates = 0;
    let maxActiveCreates = 0;
    vi.spyOn(service.store, "create").mockImplementation(async (key, bytes) => {
      activeCreates += 1;
      maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return await create(key, bytes);
      } finally {
        activeCreates -= 1;
      }
    });

    await Promise.all([
      service.submitPreparedJob(
        first.runId,
        first.launch.action_id,
        trialPayload(firstTask.input_digest),
      ),
      service.submitPreparedJob(
        second.runId,
        second.launch.action_id,
        trialPayload(secondTask.input_digest),
      ),
    ]);

    expect(maxActiveCreates).toBe(2);
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
      "prepared-reconciler-run",
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
    const lock = await projection.runLock(submitted.run_id);
    if (!lock) throw new Error("run lock is missing");
    const preparation = (await projection.runActions(submitted.run_id))
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
    if (!task) throw new Error("run task is missing");
    await service.submitPreparedJob(
      submitted.run_id,
      preparation.action_id,
      trialPayload(task.input_digest),
    );
    await service.submitPreparedJob(
      submitted.run_id,
      preparation.action_id,
      finalizePayload(lock.created_at),
    );
    actions.prepared = true;
    await settle(reconciler, 5);

    const execution = (await projection.runActions(submitted.run_id))
      .map((row) => JSON.parse(row.intent_body) as ActionIntent)
      .find(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "execution",
      );
    expect(execution?.payload).toMatchObject({
      task_id: "task-001-trial-1",
      task_ids: ["task-001-trial-1"],
      job_image: `example.invalid/worker@sha256:${"a".repeat(64)}`,
      task_image: `library/python@sha256:${"b".repeat(64)}`,
      job_command: ["run-worker"],
      hardware: "cpu-basic",
      timeout_seconds: 2_760,
      worker_revision: "abcdef0",
    });
    expect(execution?.payload.prepared_job_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("prepares a start-paused run and adopts its repeated resume", async () => {
    const { service, projection } = await setup(3);
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
      "prepared-paused-run",
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
    expect(
      actions.intents.filter((intent) => intent.action_kind === "job.launch"),
    ).toHaveLength(0);
    const first = await service.runAction(
      submitted.run_id,
      { action: "resume", task_limit: 1, confirmed: true },
      "prepared-paused-resume",
      { subject: "operator", role: "operator" },
    );
    const repeated = await service.runAction(
      submitted.run_id,
      { action: "resume", task_limit: 1, confirmed: true },
      "prepared-paused-resume",
      { subject: "operator", role: "operator" },
    );
    expect(repeated).toMatchObject({ action_id: first.action_id, adopted: true });
    await settle(reconciler, 4);
    const lock = await projection.runLock(submitted.run_id);
    if (!lock) throw new Error("run lock is missing");
    const preparation = (await projection.runActions(submitted.run_id))
      .map((row) => JSON.parse(row.intent_body) as ActionIntent)
      .find(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "preparation",
      );
    if (!preparation) throw new Error("preparation launch is missing");
    expect(preparation.payload.selected_task_ids).toEqual(["task-001-trial-1"]);
    for (const task of lock.tasks)
      await service.submitPreparedJob(
        submitted.run_id,
        preparation.action_id,
        trialPayload(task.input_digest, task.task_id, task.source_task_id),
      );
    await service.submitPreparedJob(
      submitted.run_id,
      preparation.action_id,
      finalizePayload(lock.created_at),
    );
    actions.prepared = true;
    await settle(reconciler, 5);

    expect(await service.preparedJob(submitted.run_id)).not.toBeNull();
    expect(await projection.run(submitted.run_id)).toMatchObject({
      paused: false,
      terminal_tasks: 0,
    });
    const execution = actions.intents.filter(
      (intent) =>
        intent.action_kind === "job.launch" &&
        intent.payload.worker_role === "execution",
    );
    expect(execution).toHaveLength(1);
    expect(execution[0]?.payload.task_ids).toEqual(["task-001-trial-1"]);
  });

  it("launches only nonterminal selected tasks after preparation", async () => {
    const { service, projection } = await setup(2);
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
      "prepared-task-cancellation",
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
    const lock = await projection.runLock(submitted.run_id);
    if (!lock) throw new Error("run lock is missing");
    const preparation = (await projection.runActions(submitted.run_id))
      .map((row) => JSON.parse(row.intent_body) as ActionIntent)
      .find(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "preparation",
      );
    if (!preparation) throw new Error("preparation launch is missing");
    await service.runAction(
      submitted.run_id,
      {
        action: "cancel",
        task_id: "task-001-trial-1",
        confirmed: true,
      },
      "cancel-prepared-task",
      { subject: "operator", role: "operator" },
    );
    await settle(reconciler, 3);
    for (const task of lock.tasks)
      await service.submitPreparedJob(
        submitted.run_id,
        preparation.action_id,
        trialPayload(task.input_digest, task.task_id, task.source_task_id),
      );
    await service.submitPreparedJob(
      submitted.run_id,
      preparation.action_id,
      finalizePayload(lock.created_at),
    );
    actions.prepared = true;

    await settle(reconciler, 5);

    const execution = (await projection.runActions(submitted.run_id))
      .map((row) => JSON.parse(row.intent_body) as ActionIntent)
      .filter(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "execution",
      );
    expect(execution).toHaveLength(1);
    expect(execution[0]?.payload.task_ids).toEqual(["task-002-trial-1"]);
    expect(await projection.run(submitted.run_id)).toMatchObject({
      terminal_tasks: 1,
      reserved_microusd: 100_000,
    });
  });

  it("finishes preparation observation when every selected task is cancelled", async () => {
    const { service, projection } = await setup(2);
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
      "prepared-all-tasks-cancelled",
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
    const lock = await projection.runLock(submitted.run_id);
    if (!lock) throw new Error("run lock is missing");
    const preparation = (await projection.runActions(submitted.run_id))
      .map((row) => JSON.parse(row.intent_body) as ActionIntent)
      .find(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "preparation",
      );
    if (!preparation) throw new Error("preparation launch is missing");
    for (const task of lock.tasks)
      await service.runAction(
        submitted.run_id,
        { action: "cancel", task_id: task.task_id, confirmed: true },
        `cancel-${task.task_id}`,
        { subject: "operator", role: "operator" },
      );
    await settle(reconciler, 3);
    expect(await projection.run(submitted.run_id)).toMatchObject({
      status: "cancelling",
      terminal_tasks: 2,
    });
    for (const task of lock.tasks)
      await service.submitPreparedJob(
        submitted.run_id,
        preparation.action_id,
        trialPayload(task.input_digest, task.task_id, task.source_task_id),
      );
    await service.submitPreparedJob(
      submitted.run_id,
      preparation.action_id,
      finalizePayload(lock.created_at),
    );
    actions.prepared = true;

    await settle(reconciler, 5);

    const runActions = await projection.runActions(submitted.run_id);
    expect(
      runActions.filter((row) => {
        if (row.action_kind !== "job.launch") return false;
        const intent = JSON.parse(row.intent_body) as ActionIntent;
        return intent.payload.worker_role === "execution";
      }),
    ).toHaveLength(0);
    expect(
      runActions.find(
        (row) =>
          row.action_kind === "job.observe" && row.observed_state === "COMPLETED",
      ),
    ).toBeDefined();
    expect(await projection.run(submitted.run_id)).toMatchObject({
      status: "cancelled",
      terminal_tasks: 2,
      pending_actions: 0,
      reserved_microusd: 0,
    });
    expect(await projection.activeJobAdmissions("test")).toEqual([]);
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
      "failed-preparation-run",
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

    const launches = (await projection.runActions(submitted.run_id))
      .map((row) => JSON.parse(row.intent_body) as ActionIntent)
      .filter(
        (intent) =>
          intent.action_kind === "job.launch" &&
          intent.payload.worker_role === "preparation",
      );
    expect(launches).toHaveLength(2);
    expect(launches.every((intent) => intent.target === "run-preparation")).toBe(true);
    expect(await projection.run(submitted.run_id)).toMatchObject({
      terminal_tasks: 1,
      total_tasks: 1,
      reserved_microusd: 0,
      exhausted_tasks: 1,
    });
    expect(await projection.runAttempts(submitted.run_id)).toHaveLength(0);
  });

  it("rejects prepared task sources outside the benchmark profile", async () => {
    const { service } = await setup();
    const { runId, lock, launch } = await run(service);
    const task = lock.tasks[0];
    if (!task) throw new Error("run task is missing");
    const payload = trialPayload(task.input_digest);
    (payload.trial_lock.task as Record<string, unknown>).git_url =
      "https://github.com/example/other.git";

    await expect(
      service.submitPreparedJob(runId, launch.action_id, payload),
    ).rejects.toThrow("task source does not match");
  });

  it("accepts a historical prepared environment without explicit keepalive", async () => {
    const { service } = await setup();
    const { runId, lock, launch } = await run(service);
    const task = lock.tasks[0];
    if (!task) throw new Error("run task is missing");
    const payload = trialPayload(task.input_digest);
    delete (payload.trial_lock.environment.kwargs as Record<string, unknown>)
      .control_keepalive_seconds;

    await expect(
      service.submitPreparedJob(runId, launch.action_id, payload),
    ).resolves.toMatchObject({ phase: "trial", adopted: false });
  });

  it("rejects a changed prepared trial after the first durable write", async () => {
    const { service } = await setup();
    const { runId, lock, launch } = await run(service);
    const task = lock.tasks[0];
    if (!task) throw new Error("run task is missing");
    await service.submitPreparedJob(
      runId,
      launch.action_id,
      trialPayload(task.input_digest),
    );

    await expect(
      service.submitPreparedJob(runId, launch.action_id, {
        ...trialPayload(task.input_digest),
        cpus: 2,
      }),
    ).rejects.toThrow("conflicts with durable state");
  });
});

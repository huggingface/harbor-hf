import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { get, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ActionIntent,
  OperatorAcl,
  ProfileObject,
  ProfilePromotion,
  PublicationReceipt,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sha256,
  validateLeaderboardSnapshot,
  workerEvidenceObjectPath,
} from "@harbor-hf/contracts";
import {
  compileAgentWorkbenchRecipe,
  encodeLeaderboardSqlite,
  eventCursor,
  fastAgentWorkbenchStarter,
  LEADERBOARD_RECEIPT_PREFIX,
  LEADERBOARD_SNAPSHOT_PREFIX,
  loadLatestLeaderboard,
  mintWorkerCapability,
} from "@harbor-hf/control-core";
import { approveSnapshotFixture } from "@harbor-hf/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, SSE_LIVE_BUFFER_LIMIT, SSE_REPLAY_LIMIT } from "../src/app.js";
import { AuthenticationService, AuthStore, safeReturnPath } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const roots: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(
  writeMode: AppConfig["write_mode"] = "enabled",
  seed?: (runtime: Runtime) => Promise<void>,
  capacityProfileAlias: string | null = null,
  seedCapacity = true,
): Promise<{
  runtime: Runtime;
  app: Awaited<ReturnType<typeof buildApp>>;
}> {
  const root = await mkdtemp(join(tmpdir(), "hhf-api-"));
  roots.push(root);
  const selectedCapacityAlias =
    capacityProfileAlias ?? (writeMode === "disabled" ? null : "capacity-test");
  const bucket = join(root, "bucket");
  await mkdir(bucket);
  const config: AppConfig = {
    node_env: "test",
    port: 7860,
    namespace: "test",
    bucket_id: "test/artifacts",
    bucket_root: bucket,
    store_mode: "filesystem",
    projection_path: join(root, "projection.sqlite"),
    auth_path: join(root, "auth.sqlite"),
    profiles_root: resolve("profiles"),
    capacity_profile_alias: selectedCapacityAlias,
    max_active_jobs: 16,
    task_image_mirror_repository: "mirror.example/harbor-hf/tasks",
    web_root: join(root, "web"),
    auth_mode: "development",
    write_mode: writeMode,
    public_origin: "http://127.0.0.1:7860",
    oauth: null,
    hf_token: "test-token-not-a-real-credential",
    hf_inference_token: null,
    reconcile_interval_ms: 60_000,
    sync_interval_ms: 30_000,
    observe_interval_ms: 0,
    worker_receipt_grace_ms: 0,
    source_revision: "test-revision",
    workbench_runner: "disabled",
    workbench_image: "python:3.12-slim",
    bootstrap_operator_subjects: [],
  };
  const runtime = await createRuntime(config);
  if (selectedCapacityAlias && seedCapacity)
    for (const record of capacityRecords())
      await runtime.store.create(
        controlRecordPath(record),
        new TextEncoder().encode(canonicalJson(record)),
      );
  if (seed) await seed(runtime);
  runtimes.push(runtime);
  const app = await buildApp(runtime);
  await runtime.initialize();
  await runtime.reconciler.stop();
  return { runtime, app };
}

const input = {
  benchmark: "control-smoke",
  model: "control-smoke",
  harness: "control-smoke",
  deployment: "hf-cpu-smoke",
  launch_policy: "control-smoke",
  ceiling_microusd: 0,
  confirmed: true,
};

function capacityRecords(): Array<ProfileObject | ProfilePromotion> {
  const spec = {
    namespace: "test",
    max_active_jobs: 1,
    hardware_limits: [{ hardware: "cpu-upgrade", max_active_jobs: 1 }],
    start_burst: 1,
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
    created_at: "2026-08-18T00:00:00.000Z",
    actor: { subject: "profile-import", role: "migration" },
    profile_kind: "capacity",
    name: "capacity-test",
    spec,
  };
  const profileId = sha256(canonicalJson(profile));
  const promotion: ProfilePromotion = {
    schema_version: "v1",
    kind: "profile.promotion",
    record_id: deterministicId(
      "promotion",
      "capacity",
      "capacity-test",
      profileId,
      "approved",
    ),
    created_at: "2026-08-18T00:00:01.000Z",
    actor: { subject: "profile-operator", role: "operator" },
    profile_kind: "capacity",
    alias: "capacity-test",
    profile_id: profileId,
    promotion_state: "approved",
    reason: "approved after capacity review",
    evidence: [sha256("capacity-canary-evidence")],
  };
  return [profile, promotion];
}

function legacyCapacityRecords(): Array<ProfileObject | ProfilePromotion> {
  const spec = {
    namespace: "test",
    max_active_sandboxes: 16,
    hardware_limits: [
      { hardware: "cpu-basic", max_active_sandboxes: 12 },
      { hardware: "cpu-upgrade", max_active_sandboxes: 4 },
    ],
    start_burst: 16,
    start_refill_tokens: 16,
    start_refill_period_seconds: 60,
  } as const;
  const profile = {
    schema_version: "v1",
    kind: "profile.object",
    record_id: deterministicId(
      "profile",
      "capacity",
      "capacity-legacy",
      sha256(canonicalJson(spec)),
    ),
    created_at: "2026-08-18T00:00:00.000Z",
    actor: { subject: "profile-import", role: "migration" },
    profile_kind: "capacity",
    name: "capacity-legacy",
    spec,
  } as ProfileObject;
  const profileId = sha256(canonicalJson(profile));
  const promotion: ProfilePromotion = {
    schema_version: "v1",
    kind: "profile.promotion",
    record_id: deterministicId(
      "promotion",
      "capacity",
      "capacity-legacy",
      profileId,
      "approved",
    ),
    created_at: "2026-08-18T00:00:01.000Z",
    actor: { subject: "profile-operator", role: "operator" },
    profile_kind: "capacity",
    alias: "capacity-legacy",
    profile_id: profileId,
    promotion_state: "approved",
    reason: "approved historical capacity policy",
    evidence: [],
  };
  return [profile, promotion];
}

function openSse(url: string): Promise<IncomingMessage> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = get(url, resolvePromise);
    request.on("error", rejectPromise);
  });
}

function readSseEnvelope(response: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffered += chunk;
      const frameEnd = buffered.indexOf("\n\n");
      if (frameEnd < 0) return;
      const data = buffered
        .slice(0, frameEnd)
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (data) resolvePromise(JSON.parse(data) as Record<string, unknown>);
    });
    response.on("error", rejectPromise);
  });
}

function readSseEnvelopes(
  response: IncomingMessage,
  count: number,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = "";
    const events: Record<string, unknown>[] = [];
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffered += chunk;
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (data) events.push(JSON.parse(data) as Record<string, unknown>);
      }
      if (events.length >= count) resolvePromise(events.slice(0, count));
    });
    response.on("error", rejectPromise);
  });
}

function backpressureNextCursorReset(server: Server): Promise<ServerResponse> {
  return new Promise((resolvePromise) => {
    server.prependListener("request", (request, response) => {
      if (!request.url?.startsWith("/api/v1/events")) return;
      const write = response.write.bind(response);
      response.write = ((
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | (() => void),
        callback?: () => void,
      ): boolean => {
        const written =
          typeof encodingOrCallback === "function"
            ? write(chunk, encodingOrCallback)
            : encodingOrCallback
              ? write(chunk, encodingOrCallback, callback)
              : write(chunk);
        if (!String(chunk).includes('"cursor.reset"')) return written;
        resolvePromise(response);
        return false;
      }) as typeof response.write;
    });
  });
}

describe("control API", () => {
  it("answers liveness before the projection rebuild finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhf-api-"));
    roots.push(root);
    const bucket = join(root, "bucket");
    await mkdir(bucket);
    const runtime = await createRuntime({
      node_env: "test",
      port: 7860,
      namespace: "test",
      bucket_id: "test/artifacts",
      bucket_root: bucket,
      store_mode: "filesystem",
      projection_path: join(root, "projection.sqlite"),
      auth_path: join(root, "auth.sqlite"),
      profiles_root: resolve("profiles"),
      capacity_profile_alias: null,
      max_active_jobs: 16,
      task_image_mirror_repository: "mirror.example/harbor-hf/tasks",
      web_root: join(root, "web"),
      auth_mode: "development",
      write_mode: "disabled",
      public_origin: "http://127.0.0.1:7860",
      oauth: null,
      hf_token: "test-token-not-a-real-credential",
      hf_inference_token: null,
      reconcile_interval_ms: 60_000,
      sync_interval_ms: 30_000,
      observe_interval_ms: 0,
      worker_receipt_grace_ms: 0,
      source_revision: "test-revision",
      bootstrap_operator_subjects: [],
    });
    runtimes.push(runtime);
    const app = await buildApp(runtime);
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(
      200,
    );
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: "initializing",
    });
    const system = await app.inject({ method: "GET", url: "/api/v1/system" });
    expect(system.statusCode).toBe(200);
    expect(system.json()).toMatchObject({
      initialization: { ready: false, status: "initializing" },
      projection: { ready: false },
    });
    const runs = await app.inject({ method: "GET", url: "/api/v1/runs" });
    expect(runs.statusCode).toBe(503);
    expect(runs.json()).toMatchObject({
      error: { code: "control_not_ready" },
    });
    const login = await app.inject({
      method: "GET",
      url: "/auth/login?return_to=%2Foverview",
    });
    expect(login.statusCode).toBe(503);
    expect(login.json()).toMatchObject({
      error: { code: "control_not_ready" },
    });
    expect((await app.inject({ method: "POST", url: "/auth/logout" })).statusCode).toBe(
      204,
    );
    await app.close();
  });

  it("previews command-agent recipes without exposing a real credential", async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/preview",
      payload: fastAgentWorkbenchStarter,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.setup_command).toContain("fast-agent-mcp==0.10.16");
    expect(body.run_command).toContain("<injected-model-base-url>");
    expect(body.environment).toContainEqual(
      expect.objectContaining({
        name: "OPENAI_API_KEY",
        value: "<injected-model-api-key>",
        redacted: true,
      }),
    );
    expect(body.harness_profile).toMatchObject({
      required_evidence: ["workspace", "verifier", "trajectory"],
      harbor_agent: {
        kwargs: {
          config: {
            run: {
              bindings: {
                OPENAI_API_KEY: "model_api_key",
                MODEL_BASE_URL: "model_base_url",
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(body.harness_profile)).not.toContain("route_base_url");
    expect(JSON.stringify(body.harness_profile)).not.toContain("route_api_key");
    expect(JSON.stringify(body)).not.toContain("test-token-not-a-real-credential");
  });

  it("builds a task-scoped secret-free Harbor config for local execution", async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/local-runs/preview",
      payload: {
        recipe: fastAgentWorkbenchStarter,
        task_names: ["adaptive-rejection-sampler"],
      },
    });
    expect(response.statusCode).toBe(200);
    const config = response.json().config;
    expect(config).toMatchObject({
      job_name: "local-preview",
      n_attempts: 1,
      n_concurrent_trials: 1,
      retry: { max_retries: 0 },
      datasets: [{ task_names: ["adaptive-rejection-sampler"] }],
      agents: [
        {
          import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
          model_name: "openai/openai/gpt-oss-20b:together",
          env: {
            OPENAI_API_KEY: ["$", "{HF_INFERENCE_TOKEN}"].join(""),
            OPENAI_BASE_URL: "https://router.huggingface.co/v1",
          },
          extra_allowed_hosts: ["router.huggingface.co"],
        },
      ],
    });
    expect(JSON.stringify(config)).not.toContain("test-token-not-a-real-credential");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/local-runs/preview",
      payload: {
        recipe: fastAgentWorkbenchStarter,
        task_names: ["not-a-canary-task"],
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe("policy_rejected");
  });

  it("rejects reserved and credential-like Workbench literals and disabled setup execution", async () => {
    const { app } = await setup();
    const reserved = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/preview",
      payload: {
        ...structuredClone(fastAgentWorkbenchStarter),
        environment: [
          { name: "HF_INFERENCE_TOKEN", source: "literal", value: "value" },
        ],
      },
    });
    expect(reserved.statusCode).toBe(422);
    expect(reserved.json().error.code).toBe("policy_rejected");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/preview",
      payload: {
        ...structuredClone(fastAgentWorkbenchStarter),
        environment: [
          { name: "SERVICE_API_KEY", source: "literal", value: "not-a-secret" },
        ],
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe("policy_rejected");

    const setupResponse = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/setup-tests",
      headers: { "idempotency-key": "workbench-disabled-setup" },
      payload: { recipe: fastAgentWorkbenchStarter, confirmed: true },
    });
    expect(setupResponse.statusCode).toBe(503);
    expect(setupResponse.json().error.code).toBe("control_not_ready");

    const missingCancel = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/setup-tests/missing-setup/cancel",
      headers: { "idempotency-key": "workbench-missing-cancel" },
      payload: { confirmed: true },
    });
    expect(missingCancel.statusCode).toBe(404);
    expect(missingCancel.json().error.code).toBe("not_found");
  });

  it("keeps routes unready after projection replay until runtime initialization ends", async () => {
    const { runtime, app } = await setup("disabled");
    const initializeService = runtime.service.initialize.bind(runtime.service);
    let releaseService = () => undefined;
    let markServiceStarted = () => undefined;
    const serviceBlocked = new Promise<void>((resolvePromise) => {
      releaseService = resolvePromise;
    });
    const serviceStarted = new Promise<void>((resolvePromise) => {
      markServiceStarted = resolvePromise;
    });
    vi.spyOn(runtime.service, "initialize").mockImplementationOnce(async (profiles) => {
      markServiceStarted();
      await serviceBlocked;
      await initializeService(profiles);
    });

    const initialize = runtime.initialize();
    await serviceStarted;
    expect(runtime.projection.system().ready).toBe(true);
    expect(runtime.ready).toBe(false);
    const system = await app.inject({ method: "GET", url: "/api/v1/system" });
    expect(system.statusCode).toBe(200);
    expect(system.json()).toMatchObject({
      initialization: { ready: false, status: "initializing" },
      projection: { ready: true },
    });
    expect((await app.inject({ method: "GET", url: "/health/ready" })).json()).toEqual({
      status: "initializing",
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/runs" })).statusCode).toBe(
      503,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/auth/login?return_to=%2Foverview",
        })
      ).statusCode,
    ).toBe(503);

    releaseService();
    await initialize;
    expect(runtime.ready).toBe(true);
    expect((await app.inject({ method: "GET", url: "/health/ready" })).json()).toEqual({
      status: "ready",
    });
    await app.close();
  });

  it("preserves a valid session while the ACL projection rebuilds", async () => {
    const acl: OperatorAcl = {
      schema_version: "v1",
      kind: "operator.acl",
      record_id: "operator-acl-rebuild",
      created_at: "2026-08-24T00:00:00.000Z",
      actor: { subject: "test", role: "migration" },
      operators: ["operator"],
      readers: [],
    };
    const { runtime, app } = await setup("disabled", async (seededRuntime) => {
      await seededRuntime.service.append(acl);
    });
    runtime.config.auth_mode = "oauth";
    const session = runtime.auth.store.createSession("operator", "test-user", 60);
    let releaseListing = () => undefined;
    let markListingStarted = () => undefined;
    const listingBlocked = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    const listingStarted = new Promise<void>((resolve) => {
      markListingStarted = resolve;
    });
    const rebuild = runtime.projection.rebuild({
      list: async (prefix) => {
        markListingStarted();
        await listingBlocked;
        return runtime.store.list(prefix);
      },
      read: (key) => runtime.store.read(key),
      create: (key, bytes) => runtime.store.create(key, bytes),
    });
    await listingStarted;

    const system = await app.inject({
      method: "GET",
      url: "/api/v1/system",
      headers: { cookie: `hhf_session=${session.id}` },
    });
    expect(system.statusCode).toBe(200);
    expect(system.json()).toMatchObject({
      initialization: { ready: false, status: "initializing" },
      projection: { ready: false },
    });
    expect(runtime.auth.store.session(session.id)).not.toBeNull();

    const rebuilding = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: `hhf_session=${session.id}` },
    });
    expect(rebuilding.statusCode).toBe(503);
    expect(rebuilding.json()).toMatchObject({
      error: { code: "control_not_ready" },
    });
    expect(runtime.auth.store.session(session.id)).not.toBeNull();

    releaseListing();
    await rebuild;
    const ready = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: `hhf_session=${session.id}` },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      authenticated: true,
      actor: { username: "test-user", role: "operator" },
    });
    await app.close();
  });

  it("reports liveness and projection readiness separately", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(
      200,
    );
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
    await app.close();
  });

  it("flushes SSE response headers before the first event", async () => {
    const { app } = await setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no TCP address");

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let receivedHeaders = false;
      const request = get(
        `http://127.0.0.1:${address.port}/api/v1/events`,
        (response) => {
          receivedHeaders = true;
          try {
            expect(response.statusCode).toBe(200);
            expect(response.headers["content-type"]).toBe("text/event-stream");
            response.destroy();
            resolvePromise();
          } catch (error) {
            response.destroy();
            rejectPromise(error);
          }
        },
      );
      request.setTimeout(2_000, () => {
        request.destroy(new Error("SSE response headers were not flushed"));
      });
      request.on("error", (error) => {
        if (!receivedHeaders) rejectPromise(error);
      });
    });
    await app.close();
  });

  it("streams records ingested by periodic Bucket sync without reconnecting", async () => {
    const { runtime, app } = await setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no TCP address");
    const cursor = runtime.projection.system().event_cursor;
    if (!cursor) throw new Error("projection has no event cursor");

    let closeResponse = () => undefined;
    const eventPromise = new Promise<Record<string, unknown>>(
      (resolvePromise, rejectPromise) => {
        const request = get(
          `http://127.0.0.1:${address.port}/api/v1/events?cursor=${encodeURIComponent(cursor)}`,
          (response) => {
            closeResponse = () => response.destroy();
            let buffered = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              buffered += chunk;
              const frames = buffered.split("\n\n");
              buffered = frames.pop() ?? "";
              for (const frame of frames) {
                const data = frame
                  .split("\n")
                  .find((line) => line.startsWith("data: "))
                  ?.slice("data: ".length);
                if (!data) continue;
                const event = JSON.parse(data) as Record<string, unknown>;
                if (event.type === "operator.acl") resolvePromise(event);
              }
            });
            response.on("error", rejectPromise);
          },
        );
        request.on("error", rejectPromise);
      },
    );
    await vi.waitFor(() => expect(runtime.service.events.listenerCount()).toBe(1));

    const record: OperatorAcl = {
      schema_version: "v1",
      kind: "operator.acl",
      record_id: "remote-sse-operator-acl",
      created_at: "2026-08-24T10:00:00.000Z",
      actor: { subject: "remote-sync-test", role: "migration" },
      operators: ["operator"],
      readers: ["reader"],
    };
    const key = controlRecordPath(record);
    const bytes = new TextEncoder().encode(canonicalJson(record));
    await runtime.store.create(key, bytes);
    await expect(runtime.service.syncProjection()).resolves.toBe(1);

    await expect(eventPromise).resolves.toMatchObject({
      type: "operator.acl",
      occurred_at: record.created_at,
      replay: false,
      cursor_reset: false,
      data: {
        key,
        digest: sha256(bytes),
        record_id: record.record_id,
      },
    });
    closeResponse();
    await vi.waitFor(() => expect(runtime.service.events.listenerCount()).toBe(0));
    await app.close();
  });

  it("unsubscribes an SSE listener when the client closes during replay", async () => {
    const { runtime, app } = await setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no TCP address");
    const cursor = runtime.projection.system().event_cursor;
    if (!cursor) throw new Error("projection has no event cursor");
    const originalAudit = runtime.projection.audit.bind(runtime.projection);
    let releaseReplay: () => void = () => undefined;
    const replayBlocked = new Promise<void>((resolvePromise) => {
      releaseReplay = resolvePromise;
    });
    let markReplayStarted: () => void = () => undefined;
    const replayStarted = new Promise<void>((resolvePromise) => {
      markReplayStarted = resolvePromise;
    });
    vi.spyOn(runtime.projection, "audit").mockImplementationOnce(
      async (replayCursor, limit) => {
        markReplayStarted();
        await replayBlocked;
        return originalAudit(replayCursor, limit);
      },
    );

    const response = await new Promise<IncomingMessage>(
      (resolvePromise, rejectPromise) => {
        const request = get(
          `http://127.0.0.1:${address.port}/api/v1/events?cursor=${encodeURIComponent(cursor)}`,
          resolvePromise,
        );
        request.on("error", rejectPromise);
      },
    );
    await replayStarted;
    expect(runtime.service.events.listenerCount()).toBe(1);
    response.destroy();
    await vi.waitFor(() => expect(runtime.service.events.listenerCount()).toBe(0));
    releaseReplay();
    await app.close();
  });

  it("resets an invalid SSE cursor and unsubscribes on disconnect", async () => {
    const { runtime, app } = await setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no TCP address");

    let closeResponse = () => undefined;
    const envelope = await new Promise<Record<string, unknown>>(
      (resolvePromise, rejectPromise) => {
        const request = get(
          `http://127.0.0.1:${address.port}/api/v1/events?cursor=invalid`,
          (response) => {
            closeResponse = () => response.destroy();
            response.setEncoding("utf8");
            let buffered = "";
            response.on("data", (chunk: string) => {
              buffered += chunk;
              const frameEnd = buffered.indexOf("\n\n");
              if (frameEnd < 0) return;
              const data = buffered
                .slice(0, frameEnd)
                .split("\n")
                .find((line) => line.startsWith("data: "))
                ?.slice("data: ".length);
              if (data) resolvePromise(JSON.parse(data) as Record<string, unknown>);
            });
            response.on("error", rejectPromise);
          },
        );
        request.on("error", rejectPromise);
      },
    );
    expect(envelope).toMatchObject({
      type: "cursor.reset",
      replay: true,
      cursor_reset: true,
      data: {
        reason: "invalid_cursor",
        latest_cursor: runtime.projection.system().event_cursor,
        replay_limit: SSE_REPLAY_LIMIT,
      },
    });
    closeResponse();
    await vi.waitFor(() => expect(runtime.service.events.listenerCount()).toBe(0));
    await app.close();
  });

  it("replays live events buffered while a cursor reset is backpressured", async () => {
    const { runtime, app } = await setup();
    const resetWrite = backpressureNextCursorReset(app.server);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no TCP address");

    const response = await openSse(
      `http://127.0.0.1:${address.port}/api/v1/events?cursor=invalid`,
    );
    const envelopes = readSseEnvelopes(response, 2);
    const blockedResponse = await resetWrite;
    runtime.service.events.publish({
      id: "event-during-reset-drain",
      type: "run.request",
      occurred_at: "2026-08-24T10:00:00.000Z",
      data: { run_id: "run-during-reset" },
    });
    blockedResponse.emit("drain");

    await expect(envelopes).resolves.toMatchObject([
      {
        type: "cursor.reset",
        data: { reason: "invalid_cursor" },
        cursor_reset: true,
      },
      {
        id: "event-during-reset-drain",
        type: "run.request",
        replay: false,
        cursor_reset: false,
      },
    ]);
    response.destroy();
    await vi.waitFor(() => expect(runtime.service.events.listenerCount()).toBe(0));
    await app.close();
  });

  it("disconnects cleanly when a backpressured reset buffer reaches its bound", async () => {
    const { runtime, app } = await setup();
    const resetWrite = backpressureNextCursorReset(app.server);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no TCP address");

    const response = await openSse(
      `http://127.0.0.1:${address.port}/api/v1/events?cursor=invalid`,
    );
    const resetEnvelope = readSseEnvelope(response);
    const disconnected = new Promise<void>((resolvePromise, rejectPromise) => {
      response.once("end", resolvePromise);
      response.once("error", rejectPromise);
    });
    const blockedResponse = await resetWrite;
    for (let index = 0; index <= SSE_LIVE_BUFFER_LIMIT; index += 1)
      runtime.service.events.publish({
        id: `reset-buffer-${index}`,
        type: "run.request",
        occurred_at: "2026-08-24T10:00:00.000Z",
        data: { run_id: `run-reset-buffer-${index}` },
      });
    blockedResponse.emit("drain");

    await expect(resetEnvelope).resolves.toMatchObject({
      type: "cursor.reset",
      data: { reason: "invalid_cursor" },
      cursor_reset: true,
    });
    await disconnected;
    expect(runtime.service.events.listenerCount()).toBe(0);
    await app.close();
  });

  it("resets a prior cursor epoch without replaying full history", async () => {
    const { runtime, app } = await setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no TCP address");
    const staleCursor = eventCursor("stale-server-epoch", 1);
    let closeResponse = () => undefined;

    const envelope = await new Promise<Record<string, unknown>>(
      (resolvePromise, rejectPromise) => {
        const request = get(
          `http://127.0.0.1:${address.port}/api/v1/events?cursor=${encodeURIComponent(staleCursor)}`,
          (response) => {
            closeResponse = () => response.destroy();
            response.setEncoding("utf8");
            let buffered = "";
            response.on("data", (chunk: string) => {
              buffered += chunk;
              const frameEnd = buffered.indexOf("\n\n");
              if (frameEnd < 0) return;
              const data = buffered
                .slice(0, frameEnd)
                .split("\n")
                .find((line) => line.startsWith("data: "))
                ?.slice("data: ".length);
              if (data) resolvePromise(JSON.parse(data) as Record<string, unknown>);
            });
            response.on("error", rejectPromise);
          },
        );
        request.on("error", rejectPromise);
      },
    );

    expect(envelope).toMatchObject({
      type: "cursor.reset",
      replay: true,
      cursor_reset: true,
      data: {
        reason: "epoch_changed",
        latest_cursor: runtime.projection.system().event_cursor,
        replay_limit: SSE_REPLAY_LIMIT,
      },
    });
    expect(envelope).not.toHaveProperty("id");
    closeResponse();
    await vi.waitFor(() => expect(runtime.service.events.listenerCount()).toBe(0));
    await app.close();
  });

  it("resets a current cursor when durable history exceeds the replay cap", async () => {
    const { runtime, app } = await setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no TCP address");
    const cursor = runtime.projection.system().event_cursor;
    if (!cursor) throw new Error("projection has no event cursor");
    vi.spyOn(runtime.projection, "audit").mockResolvedValue(
      Array.from({ length: SSE_REPLAY_LIMIT + 1 }, (_, index) => ({
        id: `event-${index}`,
        type: "run.request",
        occurred_at: "2026-08-24T10:00:00.000Z",
        data: { run_id: `run-${index}` },
      })),
    );

    const response = await openSse(
      `http://127.0.0.1:${address.port}/api/v1/events?cursor=${encodeURIComponent(cursor)}`,
    );
    const envelope = await readSseEnvelope(response);
    expect(envelope).toMatchObject({
      type: "cursor.reset",
      data: {
        reason: "replay_limit_exceeded",
        latest_cursor: runtime.projection.system().event_cursor,
        replay_limit: SSE_REPLAY_LIMIT,
      },
      replay: true,
      cursor_reset: true,
    });
    expect(runtime.projection.audit).toHaveBeenCalledWith(cursor, SSE_REPLAY_LIMIT + 1);
    response.destroy();
    await vi.waitFor(() => expect(runtime.service.events.listenerCount()).toBe(0));
    await app.close();
  });

  it("resets when live events exceed the bounded replay buffer", async () => {
    const { runtime, app } = await setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no TCP address");
    const cursor = runtime.projection.system().event_cursor;
    if (!cursor) throw new Error("projection has no event cursor");
    let releaseReplay = () => undefined;
    let markReplayStarted = () => undefined;
    const replayBlocked = new Promise<void>((resolvePromise) => {
      releaseReplay = resolvePromise;
    });
    const replayStarted = new Promise<void>((resolvePromise) => {
      markReplayStarted = resolvePromise;
    });
    vi.spyOn(runtime.projection, "audit").mockImplementationOnce(async () => {
      markReplayStarted();
      await replayBlocked;
      return [];
    });

    const response = await openSse(
      `http://127.0.0.1:${address.port}/api/v1/events?cursor=${encodeURIComponent(cursor)}`,
    );
    const envelope = readSseEnvelope(response);
    await replayStarted;
    for (let index = 0; index <= SSE_LIVE_BUFFER_LIMIT; index += 1)
      runtime.service.events.publish({
        id: `buffered-${index}`,
        type: "run.request",
        occurred_at: "2026-08-24T10:00:00.000Z",
        data: { run_id: `run-${index}` },
      });
    releaseReplay();

    await expect(envelope).resolves.toMatchObject({
      type: "cursor.reset",
      data: {
        reason: "buffer_limit_exceeded",
        replay_limit: SSE_REPLAY_LIMIT,
      },
      replay: true,
      cursor_reset: true,
    });
    response.destroy();
    await vi.waitFor(() => expect(runtime.service.events.listenerCount()).toBe(0));
    await app.close();
  });

  it("closes a live SSE connection when the client backpressures writes", async () => {
    const { runtime, app } = await setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no TCP address");

    const response = await openSse(`http://127.0.0.1:${address.port}/api/v1/events`);
    response.pause();
    await vi.waitFor(() => expect(runtime.service.events.listenerCount()).toBe(1));
    runtime.service.events.publish({
      id: "large-live-event",
      type: "run.request",
      occurred_at: "2026-08-24T10:00:00.000Z",
      data: { payload: "x".repeat(256 * 1024) },
    });

    await vi.waitFor(() => expect(runtime.service.events.listenerCount()).toBe(0));
    response.destroy();
    await app.close();
  });

  it("returns an empty capacity view before a trial Job starts", async () => {
    const { app } = await setup();
    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "empty-job-capacity" },
      payload: input,
    });
    const runId = submission.json().run_id as string;
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/capacity`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      run_limit: 1,
      run_active: 0,
      provider_limit: 0,
      provider_reserved: 0,
    });
    await app.close();
  });

  it("rejects continuation attachments for current runs", async () => {
    const { app } = await setup();
    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "current-continuation-run" },
      payload: input,
    });
    const runId = submission.json().run_id as string;
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/continuation`,
      headers: { "idempotency-key": "current-continuation-attachment" },
      payload: {
        reason: "not a historical run",
        confirmed: true,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { message: "current run locks do not need continuation" },
    });
    const repairResponse = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/continuation-repair`,
      headers: { "idempotency-key": "current-continuation-repair" },
      payload: {
        reason: "not a historical run",
        confirmed: true,
      },
    });
    expect(repairResponse.statusCode).toBe(422);
    expect(repairResponse.json()).toMatchObject({
      error: { message: "current run locks do not need continuation repair" },
    });
    const successorResponse = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/continuation-repair-successor`,
      headers: { "idempotency-key": "current-continuation-repair-successor" },
      payload: {
        reason: "not a historical run",
        confirmed: true,
      },
    });
    expect(successorResponse.statusCode).toBe(422);
    expect(successorResponse.json()).toMatchObject({
      error: {
        message: "current run locks do not need continuation repair successors",
      },
    });
    await app.close();
  });

  it("rejects lifecycle mutations after a Run completes", async () => {
    const { runtime, app } = await setup();
    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "terminal-run-api" },
      payload: input,
    });
    const runId = submission.json().run_id as string;
    const run = await runtime.projection.run(runId);
    if (!run) throw new Error("submitted Run is missing");
    vi.spyOn(runtime.projection, "run").mockResolvedValue({
      ...run,
      status: "completed",
    });

    for (const action of ["cancel", "pause"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/runs/${runId}/actions`,
        headers: { "idempotency-key": `terminal-run-${action}` },
        payload: { action, confirmed: true },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: {
          code: "policy_rejected",
          message: `terminal run cannot be ${action === "cancel" ? "cancelled" : "paused"}`,
        },
      });
    }
    await app.close();
  });

  it("reads and replaces the namespace Job cap", async () => {
    const { app } = await setup();
    const initial = await app.inject({ method: "GET", url: "/api/v1/capacity" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      alias: "capacity-test",
      configured: true,
      max_active_jobs: 1,
      active_jobs: 0,
      available_jobs: 1,
      queued_jobs: 0,
      observed_running_jobs: 0,
      observed_scheduling_jobs: 0,
      reserved_without_active_observation: 0,
      start_burst: 1,
      runs: [],
      hardware: [
        {
          hardware: "cpu-upgrade",
          max_active_jobs: 1,
          active_jobs: 0,
          available_jobs: 1,
        },
      ],
    });

    const updated = await app.inject({
      method: "POST",
      url: "/api/v1/capacity",
      headers: { "idempotency-key": "capacity-set-128" },
      payload: { max_active_jobs: 128, confirmed: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      alias: "capacity-test",
      configured: true,
      max_active_jobs: 128,
      start_burst: 128,
      start_refill_tokens: 128,
    });

    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/capacity",
      headers: { "idempotency-key": "capacity-set-128" },
      payload: { max_active_jobs: 128, confirmed: true },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().max_active_jobs).toBe(128);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/capacity",
      headers: { "idempotency-key": "capacity-set-128" },
      payload: { max_active_jobs: 64, confirmed: true },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: {
        code: "idempotency_conflict",
        message:
          "idempotency key already belongs to a different capacity policy request",
      },
    });
    await app.close();
  });

  it("seeds a missing namespace Job cap from the service default", async () => {
    const { app } = await setup("enabled", undefined, "current", false);
    const response = await app.inject({ method: "GET", url: "/api/v1/capacity" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      alias: "current",
      configured: true,
      max_active_jobs: 16,
      start_burst: 16,
      start_refill_tokens: 16,
    });
    await app.close();
  });

  it("preserves a historical capacity profile and appends a current Job cap", async () => {
    let legacyKey = "";
    let legacyBytes = new Uint8Array();
    const { runtime, app } = await setup(
      "enabled",
      async (selected) => {
        for (const record of legacyCapacityRecords()) {
          const bytes = new TextEncoder().encode(canonicalJson(record));
          await selected.store.create(controlRecordPath(record), bytes);
          if (record.kind === "profile.object") {
            legacyKey = controlRecordPath(record);
            legacyBytes = bytes;
          }
        }
      },
      "capacity-legacy",
      false,
    );

    const capacity = await app.inject({ method: "GET", url: "/api/v1/capacity" });
    expect(capacity.statusCode).toBe(200);
    expect(capacity.json()).toMatchObject({
      alias: "capacity-legacy",
      configured: true,
      max_active_jobs: 16,
      start_burst: 16,
      start_refill_tokens: 16,
    });
    expect(Buffer.from(await runtime.store.read(legacyKey))).toEqual(
      Buffer.from(legacyBytes),
    );
    const profiles = await app.inject({
      method: "GET",
      url: "/api/v1/profiles?limit=100",
    });
    expect(profiles.statusCode).toBe(200);
    const historical = profiles
      .json()
      .items.find(
        (item: { profile_kind: string; spec: Record<string, unknown> }) =>
          item.profile_kind === "capacity" && "max_active_sandboxes" in item.spec,
      );
    expect(historical.spec).toMatchObject({
      max_active_sandboxes: 16,
      hardware_limits: [
        { hardware: "cpu-basic", max_active_sandboxes: 12 },
        { hardware: "cpu-upgrade", max_active_sandboxes: 4 },
      ],
    });
    expect(historical.approved_aliases).toEqual([]);
    const selected = profiles
      .json()
      .items.find(
        (item: { profile_kind: string; approved_aliases: string[] }) =>
          item.profile_kind === "capacity" &&
          item.approved_aliases.includes("capacity-legacy"),
      );
    expect(selected.spec).toMatchObject({ max_active_jobs: 16 });
    await app.close();
  });

  it("rejects a namespace Job cap change when writes are disabled", async () => {
    const { app } = await setup("disabled");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capacity",
      headers: { "idempotency-key": "capacity-disabled" },
      payload: { max_active_jobs: 128, confirmed: true },
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("does not expose task Sandbox routes", async () => {
    const { app } = await setup();
    await app.ready();
    const openapi = app.swagger() as { paths: Record<string, unknown> };
    expect(Object.keys(openapi.paths).some((path) => path.includes("sandboxes"))).toBe(
      false,
    );
    await app.close();
  });

  it("loads approved durable profile aliases and ignores recommendations", async () => {
    const spec = {
      contract_version: "v1" as const,
      model_id: "example/durable-model",
      revision: sha256("durable-model-revision"),
      harbor_model_name: "openai/example/durable-model:provider",
      compatibility: {
        reasoning: false,
        inference_apis: ["chat-completions"] as const,
      },
    };
    const profile: ProfileObject = {
      schema_version: "v1",
      kind: "profile.object",
      record_id: deterministicId(
        "profile",
        "model",
        "durable-model",
        sha256(canonicalJson(spec)),
      ),
      created_at: "2026-08-16T00:00:00.000Z",
      actor: { subject: "profile-import", role: "migration" },
      profile_kind: "model",
      name: "durable-model",
      spec,
    };
    const profileId = sha256(canonicalJson(profile));
    const promotion = (
      alias: string,
      state: ProfilePromotion["promotion_state"],
      createdAt: string,
      targetProfileId = profileId,
    ): ProfilePromotion => ({
      schema_version: "v1",
      kind: "profile.promotion",
      record_id: deterministicId("promotion", "model", alias, targetProfileId, state),
      created_at: createdAt,
      actor: { subject: "profile-operator", role: "operator" },
      profile_kind: "model",
      alias,
      profile_id: targetProfileId,
      promotion_state: state,
      reason: `${state} after profile review`,
      evidence: [sha256(`${alias}-evidence`)],
    });
    const approved = promotion("control-smoke", "approved", "2026-08-16T00:00:01.000Z");
    const recommended = promotion(
      "recommended-only",
      "recommended",
      "2026-08-16T00:00:02.000Z",
    );
    const { runtime, app } = await setup("enabled", async (seedRuntime) => {
      for (const record of [profile, approved, recommended])
        await seedRuntime.store.create(
          controlRecordPath(record),
          new TextEncoder().encode(canonicalJson(record)),
        );
    });

    expect(runtime.service.resolver.get("model", "control-smoke").profile_id).toBe(
      profileId,
    );
    expect(() => runtime.service.resolver.get("model", "recommended-only")).toThrow(
      "unknown model profile",
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "durable-profile-run-key" },
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(202);
    const lock = await runtime.projection.runLock(response.json().run_id as string);
    const lockedModel = lock?.profiles.find((item) => item.kind === "model");
    expect(lockedModel).toMatchObject({
      name: "control-smoke",
      profile_id: profileId,
    });
    const replacementSpec = {
      contract_version: "v1" as const,
      model_id: "example/replacement-model",
      revision: sha256("replacement-model-revision"),
      harbor_model_name: "openai/example/replacement-model:provider",
      compatibility: {
        reasoning: false,
        inference_apis: ["chat-completions"] as const,
      },
    };
    const replacementProfile: ProfileObject = {
      ...profile,
      record_id: deterministicId(
        "profile",
        "model",
        "replacement-model",
        sha256(canonicalJson(replacementSpec)),
      ),
      created_at: "2026-08-16T00:00:03.000Z",
      name: "replacement-model",
      spec: replacementSpec,
    };
    const replacementProfileId = sha256(canonicalJson(replacementProfile));
    const movedAlias = promotion(
      "control-smoke",
      "approved",
      "2026-08-16T00:00:04.000Z",
      replacementProfileId,
    );
    await runtime.service.append(replacementProfile);
    await runtime.service.append(movedAlias);
    expect(runtime.service.resolver.get("model", "control-smoke").profile_id).toBe(
      replacementProfileId,
    );
    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "durable-profile-run-key" },
      payload: input,
    });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json()).toMatchObject({ adopted: true });
    expect(
      (
        await runtime.projection.runLock(repeated.json().run_id as string)
      )?.profiles.find((item) => item.kind === "model")?.profile_id,
    ).toBe(profileId);
    await app.close();
  });

  it("paginates bounded global collection responses", async () => {
    const { runtime, app } = await setup();
    await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "pagination-run-key" },
      payload: input,
    });
    await runtime.reconciler.tick();
    const urls = [
      "/api/v1/runs?limit=1",
      "/api/v1/jobs?limit=1",
      "/api/v1/endpoints?limit=1",
      "/api/v1/profiles?limit=1",
      "/api/v1/results?limit=1",
      "/api/v1/audit?limit=1",
    ];
    for (const url of urls) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty("items");
      expect(response.json()).toHaveProperty("next_cursor");
    }
    const firstProfiles = await app.inject({
      method: "GET",
      url: "/api/v1/profiles?limit=1",
    });
    const firstProfileItem = firstProfiles.json().items[0] as Record<string, unknown>;
    const firstProfile = firstProfileItem.profile_id as string;
    expect(firstProfileItem.approved_aliases).toEqual([expect.any(String)]);
    expect(firstProfileItem.spec).toEqual(expect.any(Object));
    const cursor = firstProfiles.json().next_cursor as string;
    const secondProfiles = await app.inject({
      method: "GET",
      url: `/api/v1/profiles?limit=1&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(secondProfiles.json().items[0].profile_id).not.toBe(firstProfile);
    const outsideWindow = Buffer.from("1000001").toString("base64url");
    const bounded = await app.inject({
      method: "GET",
      url: `/api/v1/results?cursor=${outsideWindow}`,
    });
    expect(bounded.statusCode).toBe(422);
    await app.close();
  });

  it("returns every logical task for one Run in a single response", async () => {
    const { runtime, app } = await setup();
    const run = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "bulk-task-list-key" },
      payload: input,
    });
    const runId = run.json().run_id as string;
    await runtime.projection.db
      .insertInto("tasks")
      .values(
        Array.from({ length: 125 }, (_, index) => ({
          run_id: runId,
          task_id: `bulk-task-${String(index).padStart(3, "0")}`,
          input_digest: `sha256:${String(index).padStart(64, "0")}`,
          terminal_outcome: null,
          selected_attempt_id: null,
        })),
      )
      .execute();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/tasks`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(126);
    expect(response.json().next_cursor).toBeNull();
    await app.close();
  });

  it("exposes Hub inspect URLs for Jobs", async () => {
    const { runtime, app } = await setup();
    const run = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "job-inspect-run-key" },
      payload: input,
    });
    expect(run.statusCode).toBe(202);
    await runtime.reconciler.tick();
    const jobs = await app.inject({ method: "GET", url: "/api/v1/jobs" });
    expect(jobs.statusCode).toBe(200);
    const items = jobs.json().items as Array<{
      resource_id: string | null;
      inspect_url: string | null;
    }>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.inspect_url).toBe(
        item.resource_id === null
          ? null
          : `https://huggingface.co/jobs/test/${encodeURIComponent(item.resource_id)}`,
      );
    }
    await app.close();
  });

  it("returns the latest observed state for each Job", async () => {
    const { runtime, app } = await setup();
    const run = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "job-latest-state-key" },
      payload: { ...input, ceiling_microusd: 100_000 },
    });
    expect(run.statusCode).toBe(202);
    const runId = run.json().run_id as string;
    const actor = { subject: "operator" as const, role: "operator" as const };
    const resourceId = "job-latest-state";
    const payload = {
      task_id: "control-smoke-task",
      task_ids: ["control-smoke-task"],
      max_infrastructure_attempts: 1,
      success_without_worker_receipt: true,
      resource_id: resourceId,
    };
    let launchActionId: string | null = null;
    for (const record of [
      {
        kind: "job.launch" as const,
        generation: 0,
        createdAt: "2026-08-21T10:04:10.000Z",
        observedState: "SCHEDULING",
        costMicrousd: 0,
      },
      {
        kind: "job.observe" as const,
        generation: 0,
        createdAt: "2026-08-21T10:04:20.000Z",
        observedState: "SCHEDULING",
        costMicrousd: 10_000,
      },
      {
        kind: "job.observe" as const,
        generation: 1,
        createdAt: "2026-08-21T10:04:30.000Z",
        observedState: "RUNNING",
        costMicrousd: 20_000,
      },
      {
        kind: "job.observe" as const,
        generation: 2,
        createdAt: "2026-08-21T10:04:40.000Z",
        observedState: "ERROR",
        costMicrousd: 40_000,
      },
    ]) {
      const intent = runtime.service.actionIntent(
        runId,
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
      await runtime.service.writeAction(intent);
      await runtime.service.receipt(intent, {
        outcome: record.kind === "job.launch" ? "created" : "completed",
        observed_state: record.observedState,
        resource_id: resourceId,
        cost_microusd: record.costMicrousd,
      });
    }
    const jobs = await app.inject({ method: "GET", url: "/api/v1/jobs" });
    expect(jobs.statusCode).toBe(200);
    const items = jobs.json().items as Array<{
      action_kind: string;
      observed_state: string | null;
      resource_id: string | null;
      cost_microusd: number;
    }>;
    const matching = items.filter((item) => item.resource_id === resourceId);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      worker_role: "execution",
      action_kind: "job.observe",
      launch_action_id: launchActionId,
      observed_state: "ERROR",
      resource_id: resourceId,
      cost_microusd: 40_000,
      assigned_tasks: 1,
      inspect_url: `https://huggingface.co/jobs/test/${resourceId}`,
    });
    const scoped = await app.inject({
      method: "GET",
      url: `/api/v1/jobs?run_id=${encodeURIComponent(runId)}`,
    });
    expect(scoped.statusCode).toBe(200);
    expect(
      (scoped.json().items as Array<{ run_id: string }>).every(
        (item) => item.run_id === runId,
      ),
    ).toBe(true);
    const empty = await app.inject({
      method: "GET",
      url: "/api/v1/jobs?run_id=run-missing",
    });
    expect(empty.json().items).toEqual([]);
    await app.close();
  });

  it("returns a stable unpaginated Run Job snapshot above 2,000 Jobs", async () => {
    const { runtime, app } = await setup();
    const runId = "bulk-jobs-run";
    const itemCount = 2_001;
    const intentBody = (index: number, launchActionId?: string) =>
      canonicalJson({
        payload: {
          task_ids: [`task-${index}`],
          resource_id: `job-${index}`,
          ...(launchActionId
            ? { launch_action_id: launchActionId }
            : { worker_role: "preparation" }),
        },
      });
    const launches = Array.from({ length: itemCount }, (_, index) => ({
      action_id: `bulk-launch-${String(index).padStart(4, "0")}`,
      run_id: runId,
      action_kind: "job.launch",
      generation: 0,
      target: `job-${index}`,
      intent_body: intentBody(index),
      receipt_body: null,
      outcome: null,
      observed_state: "SCHEDULING",
      resource_id: `job-${index}`,
      created_at: "2026-08-24T10:00:00.000Z",
    }));
    for (let offset = 0; offset < launches.length; offset += 250)
      await runtime.projection.db
        .insertInto("actions")
        .values(launches.slice(offset, offset + 250))
        .execute();
    const projectedJobs = launches.map((launch, index) => ({
      ...launch,
      launch_action_id: launch.action_id,
      assigned_tasks: 1,
      assigned_task_ids_body: canonicalJson([`task-${index}`]),
      cost_microusd: 0,
      is_replacement: 0,
    }));
    for (let offset = 0; offset < projectedJobs.length; offset += 250)
      await runtime.projection.db
        .insertInto("jobs")
        .values(projectedJobs.slice(offset, offset + 250))
        .execute();

    const first = await app.inject({
      method: "GET",
      url: `/api/v1/jobs?run_id=${runId}&limit=1&cursor=ignored`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(itemCount);
    expect(first.json().next_cursor).toBeNull();

    const observedIndex = 1_000;
    const launchActionId = launches[observedIndex]?.action_id;
    if (!launchActionId) throw new Error("bulk launch fixture is missing");
    await runtime.projection.db
      .insertInto("actions")
      .values({
        action_id: "bulk-observe-1000",
        run_id: runId,
        action_kind: "job.observe",
        generation: 1,
        target: `job-${observedIndex}`,
        intent_body: intentBody(observedIndex, launchActionId),
        receipt_body: canonicalJson({ cost_microusd: 42 }),
        outcome: "completed",
        observed_state: "RUNNING",
        resource_id: `job-${observedIndex}`,
        created_at: "2026-08-24T10:01:00.000Z",
      })
      .execute();
    await runtime.projection.db
      .updateTable("jobs")
      .set({
        action_id: "bulk-observe-1000",
        action_kind: "job.observe",
        generation: 1,
        target: `job-${observedIndex}`,
        intent_body: intentBody(observedIndex, launchActionId),
        receipt_body: canonicalJson({ cost_microusd: 42 }),
        outcome: "completed",
        observed_state: "RUNNING",
        resource_id: `job-${observedIndex}`,
        created_at: "2026-08-24T10:01:00.000Z",
        cost_microusd: 42,
      })
      .where("launch_action_id", "=", launchActionId)
      .execute();

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/jobs?run_id=${runId}`,
    });
    expect(second.json().items).toHaveLength(itemCount);
    expect(
      second
        .json()
        .items.find((item: { resource_id: string }) => item.resource_id === "job-1000"),
    ).toMatchObject({
      action_id: "bulk-observe-1000",
      launch_action_id: launchActionId,
      worker_role: "preparation",
      observed_state: "RUNNING",
      cost_microusd: 42,
    });
    expect(second.json().next_cursor).toBeNull();
    await app.close();
  });

  it("limits worker capabilities to their run action routes", async () => {
    const { runtime, app } = await setup();
    const submission = await runtime.service.submit(
      input,
      "worker-capability-submission",
      { subject: "operator", role: "operator" },
    );
    const lock = await runtime.projection.runLock(submission.run_id);
    expect(lock).not.toBeNull();
    if (!lock) throw new Error("run lock is missing");
    const taskId = lock.tasks[0]?.task_id;
    expect(taskId).toBeDefined();
    const token = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      run_id: submission.run_id,
      run_lock_digest: sha256(canonicalJson(lock)),
      action_id: "action-worker-capability",
      task_ids: [taskId ?? "missing"],
      operations: ["run.read", "attempt.submit", "evidence.write"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const headers = { "x-harbor-hf-worker-capability": token };

    const lockResponse = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${submission.run_id}/lock`,
      headers,
    });
    expect(lockResponse.statusCode).toBe(200);
    expect(lockResponse.json()).toEqual(lock);
    expect(sha256(canonicalJson(lockResponse.json()))).toBe(
      sha256(canonicalJson(lock)),
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/runs/${submission.run_id}/continuation`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/runs/${submission.run_id}/continuation-repair-successor`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/runs/${submission.run_id}/continuation-repair`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/profiles", headers }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/runs/run-other/lock",
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/runs/${submission.run_id}/tasks/${taskId}/attempts`,
          headers: { ...headers, "idempotency-key": "worker-scope-attempt" },
          payload: {
            action_id: "action-not-authorized",
            outcome: "complete",
            replacement_eligible: false,
            evidence_digest: `sha256:${"a".repeat(64)}`,
            evidence_path: "worker/evidence",
            cost_microusd: 0,
            metrics: { reward: 1 },
            completed_at: "2026-08-16T00:00:00Z",
            confirmed: true,
          },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });

  it("reports the two-secret resource contract", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/v1/system" });
    expect(response.statusCode).toBe(200);
    expect(response.json().resource_contract).toEqual({
      spaces: 1,
      buckets: 1,
      operator_secrets: 2,
    });
    await app.close();
  });

  it("keeps protected public ingress deny-by-default", async () => {
    const { runtime, app } = await setup();
    runtime.config.auth_mode = "oauth";
    const before = runtime.projection.system().object_count;

    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "live" });
    expect(live.headers["x-content-type-options"]).toBe("nosniff");
    expect(live.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(live.headers["content-security-policy"]).toContain(
      "frame-ancestors 'self' https://huggingface.co",
    );
    expect(live.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(live.headers["x-frame-options"]).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/health/ready" })).json()).toEqual({
      status: "ready",
    });

    for (const url of [
      "/api/v1/system",
      "/api/v1/runs",
      "/api/v1/jobs",
      "/api/v1/endpoints",
      "/api/v1/results",
      "/api/v1/profiles",
      "/api/v1/audit",
      "/api/v1/events",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: "authentication_required" },
      });
    }
    const leaderboard = await app.inject({
      method: "GET",
      url: "/api/v1/leaderboard",
    });
    expect(leaderboard.statusCode).toBe(200);
    expect(leaderboard.json()).toEqual({ snapshot: null, items: [] });
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
    });
    expect(session.statusCode).toBe(401);
    expect(session.json()).toEqual({
      authenticated: false,
      login_url: "/auth/login",
    });
    const mutation = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "anonymous-mutation" },
      payload: input,
    });
    expect(mutation.statusCode).toBe(401);
    expect(runtime.projection.system().object_count).toBe(before);

    const oversized = `{"padding":"${"x".repeat(2 * 1024 * 1024)}"}`;
    const anonymousOversized = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "anonymous-oversized",
      },
      payload: oversized,
    });
    expect(anonymousOversized.statusCode).toBe(401);
    runtime.config.auth_mode = "development";
    const authenticatedOversized = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "authenticated-oversized",
      },
      payload: oversized,
    });
    expect(authenticatedOversized.statusCode).toBe(413);

    const crossOrigin = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: "https://outside.example" },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({
      error: { code: "origin_rejected" },
    });
    await app.close();
  });

  it("does not trust unverified identity or forwarded headers for limits", async () => {
    const { runtime, app } = await setup();
    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: {
          authorization: `Bearer unverified-${index}`,
          cookie: `hhf_session=unverified-${index}`,
          "x-forwarded-for": `203.0.113.${(index % 250) + 1}`,
          "x-harbor-hf-worker-capability": `unverified-${index}`,
        },
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: {
        authorization: "Bearer unverified-limited",
        cookie: "hhf_session=unverified-limited",
        "x-forwarded-for": "192.0.2.99",
        "x-harbor-hf-worker-capability": "unverified-limited",
      },
    });
    expect(limited.statusCode).toBe(429);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/system" })).statusCode,
    ).toBe(200);
    const capability = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      run_id: "run-rate-limit",
      run_lock_digest: `sha256:${"a".repeat(64)}`,
      action_id: "action-rate-limit",
      task_ids: ["task-rate-limit"],
      operations: ["run.read"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/runs/run-rate-limit/lock",
          headers: { "x-harbor-hf-worker-capability": capability },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("limits rejected cross-origin requests before returning the error", async () => {
    const { app } = await setup();
    for (let index = 0; index < 240; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/system",
        headers: { origin: `https://outside-${index}.example` },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/system",
          headers: { origin: "https://outside-limited.example" },
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/system" })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("keeps unverified capabilities in the shared anonymous API limit", async () => {
    const { runtime, app } = await setup();
    for (let index = 0; index < 240; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/system",
        headers: {
          "x-harbor-hf-worker-capability": `unverified-${index}`,
        },
      });
      expect(response.statusCode).toBe(403);
    }
    const limited = await app.inject({
      method: "GET",
      url: "/api/v1/system",
      headers: {
        "x-harbor-hf-worker-capability": "unverified-limited",
      },
    });
    expect(limited.statusCode).toBe(429);

    const capability = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      run_id: "run-verified-limit",
      run_lock_digest: `sha256:${"a".repeat(64)}`,
      action_id: "action-verified-limit",
      task_ids: ["task-verified-limit"],
      operations: ["run.read"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/runs/run-verified-limit/lock",
          headers: { "x-harbor-hf-worker-capability": capability },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("isolates a verified session from anonymous session-check limits", async () => {
    const acl: OperatorAcl = {
      schema_version: "v1",
      kind: "operator.acl",
      record_id: "operator-acl-session-limit",
      created_at: "2026-08-16T00:00:00Z",
      actor: { subject: "test", role: "service" },
      operators: ["operator"],
      readers: [],
    };
    const { runtime, app } = await setup("enabled", async (seededRuntime) => {
      await seededRuntime.service.append(acl);
    });
    runtime.config.auth_mode = "oauth";
    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
      });
      expect(response.statusCode).toBe(401);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/session",
        })
      ).statusCode,
    ).toBe(429);

    const session = runtime.auth.store.createSession("operator", "test-user", 60);
    const authenticated = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: `hhf_session=${session.id}` },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({
      authenticated: true,
      actor: { username: "test-user", role: "operator" },
    });
    expect(authenticated.json().actor).not.toHaveProperty("subject");
    await app.close();
  });

  it("rejects and negatively caches invalid bearer credentials", async () => {
    const { runtime, app } = await setup();
    runtime.config.auth_mode = "oauth";
    const fetchIdentity = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchIdentity);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system",
      headers: { authorization: "Bearer invalid-test-credential" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_bearer_credential" },
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/system",
          headers: { authorization: "Bearer invalid-test-credential" },
        })
      ).statusCode,
    ).toBe(401);
    expect(fetchIdentity).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("limits unique bearer identity lookups before external requests", async () => {
    const { runtime, app } = await setup();
    runtime.config.auth_mode = "oauth";
    const fetchIdentity = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchIdentity);

    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/system",
        headers: { authorization: `Bearer invalid-unique-${index}` },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: "GET",
      url: "/api/v1/system",
      headers: { authorization: "Bearer invalid-unique-limited" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.json()).toMatchObject({
      error: { code: "rate_limit_exceeded" },
    });
    expect(fetchIdentity).toHaveBeenCalledTimes(120);
    await app.close();
  });

  it("accepts an ACL-listed bearer identity", async () => {
    const acl: OperatorAcl = {
      schema_version: "v1",
      kind: "operator.acl",
      record_id: "operator-acl-service-bearer",
      created_at: "2026-08-16T00:00:00Z",
      actor: { subject: "test", role: "service" },
      operators: ["operator"],
      readers: [],
    };
    const { runtime, app } = await setup("enabled", async (seededRuntime) => {
      await seededRuntime.service.append(acl);
    });
    runtime.config.auth_mode = "oauth";
    const fetchIdentity = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "operator" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchIdentity);

    const headers = {
      authorization: "Bearer test-token-not-a-real-credential",
    };
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/system", headers })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/system", headers })).statusCode,
    ).toBe(200);
    expect(fetchIdentity).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("ignores invalid result catalogs that no current publication references", async () => {
    const { runtime, app } = await setup();
    await runtime.store.create(
      "results/schema=v1/catalog/retired-invalid.json",
      new TextEncoder().encode(canonicalJson({ retired: true })),
    );

    const response = await app.inject({ method: "GET", url: "/api/v1/results" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], next_cursor: null });
    await app.close();
  });

  it("serves validated imported result catalogs", async () => {
    const { runtime, app } = await setup();
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(0);
    const catalog = {
      schema_version: "v1",
      kind: "result.catalog",
      record_id: "catalog-import-one",
      created_at: "2026-08-16T00:00:00Z",
      source_digest: `sha256:${"a".repeat(64)}`,
      entries: [
        {
          publication_id: "publication-one",
          run_id: "run-one",
          published_at: "2026-08-15T00:00:00Z",
          benchmark: "benchmark-one",
          model: "model-one",
          harness: "harness-one",
          inference_provider: "provider-one",
          run_outcome: "complete",
          quality: "clean",
          publication_role: "final",
          task_count: 89,
          scored_task_count: 89,
          strict_pass_count: 1,
          primary_metric: { name: "mean_reward", value: 0.75, unit: "score" },
          result_path: "imports/result-one.json",
        },
      ],
    };
    const listObjects = vi.spyOn(runtime.store, "list");
    const initial = await app.inject({ method: "GET", url: "/api/v1/results" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ items: [], next_cursor: null });
    expect(listObjects).toHaveBeenCalledTimes(1);

    await runtime.store.create(
      "results/schema=v1/catalog/imports/catalog-import-one.json",
      new TextEncoder().encode(canonicalJson(catalog)),
    );
    const stillCached = await app.inject({ method: "GET", url: "/api/v1/results" });
    expect(stillCached.json()).toEqual({ items: [], next_cursor: null });
    expect(listObjects).toHaveBeenCalledTimes(1);

    monotonicNow.mockReturnValue(runtime.config.sync_interval_ms);
    const response = await app.inject({ method: "GET", url: "/api/v1/results" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      publication_id: "publication-one",
      model: "model-one",
      primary_metric: { value: 0.75 },
      status: "published",
      catalog_source_digest: catalog.source_digest,
      pass_count: 1,
      pass_rate: 1 / 89,
      outputs_prefix: "imports",
      outputs_url: `https://huggingface.co/buckets/${runtime.config.bucket_id}/tree/imports`,
      hf_uri: `hf://buckets/${runtime.config.bucket_id}/imports`,
    });
    const filtered = await app.inject({
      method: "GET",
      url: "/api/v1/results?model=model-one&search=benchmark-one&sort=score&order=desc",
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items).toHaveLength(1);
    const empty = await app.inject({
      method: "GET",
      url: "/api/v1/results?agent=missing-agent",
    });
    expect(empty.json().items).toEqual([]);
    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/results/publication-one",
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ publication_id: "publication-one" });
    expect(listObjects).toHaveBeenCalledTimes(2);

    await runtime.projection.db
      .insertInto("publications")
      .values({
        publication_id: "publication-cache-invalidation",
        run_id: "run-cache-invalidation",
        status: "published",
        catalog_digest: null,
        body: "{}",
        created_at: "2026-08-16T00:00:01Z",
      })
      .execute();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/results" })).statusCode,
    ).toBe(200);
    expect(listObjects).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("hides a local publication when its committed row objects are missing", async () => {
    const { runtime, app } = await setup();
    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "missing-publication-rows-run" },
      payload: input,
    });
    const runId = submission.json().run_id as string;
    const publicationId = deterministicId("publication", runId);
    const resultPath = `results/schema=v1/publications/${publicationId}/receipt.json`;
    const catalog = {
      schema_version: "v1",
      kind: "result.catalog",
      record_id: deterministicId("result-catalog", publicationId),
      created_at: "2026-08-16T00:00:01.000Z",
      source_digest: `sha256:${"b".repeat(64)}`,
      entries: [
        {
          publication_id: publicationId,
          run_id: runId,
          published_at: "2026-08-16T00:00:01.000Z",
          benchmark: "control-smoke",
          model: "control-smoke",
          harness: "control-smoke",
          inference_provider: "test-provider",
          run_outcome: "complete",
          quality: "clean",
          publication_role: "diagnostic",
          task_count: 1,
          scored_task_count: 1,
          strict_pass_count: 1,
          primary_metric: { name: "mean_reward", value: 1, unit: "score" },
          result_path: resultPath,
        },
      ],
    };
    const catalogBytes = new TextEncoder().encode(canonicalJson(catalog));
    const catalogDigest = sha256(catalogBytes);
    const receipt: PublicationReceipt = {
      schema_version: "v1",
      kind: "publication.receipt",
      record_id: deterministicId("publication-receipt", publicationId),
      created_at: "2026-08-16T00:00:01.000Z",
      actor: { subject: "harbor-hf-control", role: "service" },
      run_id: runId,
      publication_id: publicationId,
      publication_state: "published",
      object_digests: [
        `sha256:${"1".repeat(64)}`,
        `sha256:${"2".repeat(64)}`,
        `sha256:${"3".repeat(64)}`,
        `sha256:${"4".repeat(64)}`,
        `sha256:${"5".repeat(64)}`,
      ],
      catalog_digest: catalogDigest,
      error_code: null,
    };
    await runtime.store.create(
      resultPath,
      new TextEncoder().encode(canonicalJson(receipt)),
    );
    await runtime.store.create(
      `results/schema=v1/catalog/records/${catalog.record_id}.json`,
      catalogBytes,
    );
    await runtime.service.writePublication(receipt);

    const response = await app.inject({ method: "GET", url: "/api/v1/results" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
    await app.close();
  });

  it("reads ranked leaderboard rows from the latest Bucket snapshot", async () => {
    const { runtime, app } = await setup("disabled");
    expect(await loadLatestLeaderboard(runtime.store)).toEqual({
      snapshot: null,
      rows: [],
    });
    const empty = await app.inject({ method: "GET", url: "/api/v1/leaderboard" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ snapshot: null, items: [] });

    const row = {
      configuration_digest: `sha256:${"b".repeat(64)}`,
      run_id: "run-leaderboard",
      publication_id: "publication-leaderboard",
      published_at: "2026-08-21T00:00:00.000Z",
      benchmark: "control-smoke",
      model: "control-smoke",
      harness: "control-smoke",
      inference_provider: "hf-cpu-smoke",
      reasoning_effort: "off",
      harbor_version: "0.21.0",
      trial_count: 1,
      task_count: 1,
      scored_task_count: 1,
      primary_metric_name: "mean_reward",
      primary_metric_value: 1,
      primary_metric_unit: "score",
      observed_microusd: 2500,
    };
    await approveSnapshotFixture(runtime.store, row);
    const bytes = await encodeLeaderboardSqlite([row]);
    const sqliteDigest = sha256(bytes);
    const sqliteKey = `${LEADERBOARD_SNAPSHOT_PREFIX}${sqliteDigest.slice("sha256:".length)}/leaderboard.sqlite`;
    await runtime.store.create(sqliteKey, bytes);
    const receipt = validateLeaderboardSnapshot({
      schema_version: "v1",
      kind: "leaderboard.snapshot",
      record_id: deterministicId("leaderboard-snapshot", sqliteDigest),
      created_at: row.published_at,
      actor: { subject: "harbor-hf-control", role: "service" },
      sqlite_key: sqliteKey,
      sqlite_digest: sqliteDigest,
      source_digest: sha256(canonicalJson([row.run_id])),
      entry_count: 1,
    });
    await runtime.store.create(
      `${LEADERBOARD_RECEIPT_PREFIX}${receipt.record_id}.json`,
      new TextEncoder().encode(canonicalJson(receipt)),
    );

    const response = await app.inject({ method: "GET", url: "/api/v1/leaderboard" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      snapshot: {
        record_id: receipt.record_id,
        created_at: receipt.created_at,
        sqlite_digest: receipt.sqlite_digest,
        source_digest: receipt.source_digest,
        entry_count: 1,
      },
      items: [{ ...row, rank: 1, pareto: true }],
    });
    await app.close();
  });

  it("accepts idempotent trusted-worker attempt receipts", async () => {
    const { runtime, app } = await setup();
    const run = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "run-request-key" },
      payload: input,
    });
    const runId = run.json().run_id as string;
    await runtime.reconciler.tick();
    const launch = (await runtime.projection.actions()).find(
      (action) => action.action_kind === "job.launch",
    );
    if (!launch) throw new Error("run admission did not create a Job launch");
    await runtime.service.receipt(JSON.parse(launch.intent_body) as ActionIntent, {
      outcome: "created",
      observed_state: "RUNNING",
      resource_id: "job-worker-attempt",
    });
    const lock = await runtime.projection.runLock(runId);
    if (!lock) throw new Error("run lock is missing");
    const capability = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      run_id: runId,
      run_lock_digest: sha256(canonicalJson(lock)),
      action_id: launch.action_id,
      task_ids: ["control-smoke-task"],
      operations: ["run.read", "attempt.submit", "evidence.write"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const capabilityHeaders = {
      "x-harbor-hf-worker-capability": capability,
    };
    const workerHeaders = {
      ...capabilityHeaders,
      "idempotency-key": "worker-attempt-key",
    };
    const chunk = Buffer.from("worker evidence chunk", "utf8");
    const chunkDigest = sha256(chunk);
    const chunkPath = workerEvidenceObjectPath(
      runId,
      launch.action_id,
      "control-smoke-task",
      chunkDigest,
    );
    const evidenceUrl = `/api/v1/runs/${runId}/tasks/control-smoke-task/attempts`;
    const evidencePayload = {
      operation: "upload_evidence",
      action_id: launch.action_id,
      digest: chunkDigest,
      content_base64: chunk.toString("base64"),
    };
    const missingEvidenceCapability = await app.inject({
      method: "POST",
      url: evidenceUrl,
      headers: { "idempotency-key": "evidence-missing-capability-key" },
      payload: evidencePayload,
    });
    expect(missingEvidenceCapability.statusCode).toBe(403);
    const wrongEvidenceAction = await app.inject({
      method: "POST",
      url: evidenceUrl,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "evidence-wrong-action-key",
      },
      payload: { ...evidencePayload, action_id: "wrong-action" },
    });
    expect(wrongEvidenceAction.statusCode).toBe(403);
    const wrongEvidenceDigest = await app.inject({
      method: "POST",
      url: evidenceUrl,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "evidence-wrong-digest-key",
      },
      payload: { ...evidencePayload, digest: `sha256:${"0".repeat(64)}` },
    });
    expect(wrongEvidenceDigest.statusCode).toBe(422);
    const chunkUpload = await app.inject({
      method: "POST",
      url: evidenceUrl,
      headers: { ...capabilityHeaders, "idempotency-key": "evidence-chunk-key" },
      payload: evidencePayload,
    });
    expect(chunkUpload.statusCode).toBe(201);
    const manifest = {
      schema_version: "v1",
      kind: "worker.evidence.manifest",
      run_id: runId,
      action_id: launch.action_id,
      task_id: "control-smoke-task",
      objects: [{ path: chunkPath, digest: chunkDigest, size: chunk.byteLength }],
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
    const manifestDigest = sha256(manifestBytes);
    const manifestPath = workerEvidenceObjectPath(
      runId,
      launch.action_id,
      "control-smoke-task",
      manifestDigest,
    );
    const manifestUpload = await app.inject({
      method: "POST",
      url: evidenceUrl,
      headers: { ...capabilityHeaders, "idempotency-key": "evidence-manifest-key" },
      payload: {
        operation: "upload_evidence",
        action_id: launch.action_id,
        digest: manifestDigest,
        content_base64: manifestBytes.toString("base64"),
      },
    });
    expect(manifestUpload.statusCode).toBe(201);
    const payload = {
      action_id: launch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      evidence_digest: manifestDigest,
      evidence_path: manifestPath,
      cost_microusd: 0,
      metrics: { reward: 1 },
      completed_at: "2026-08-16T00:00:00Z",
      confirmed: true,
    };
    const missingCapability = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/tasks/control-smoke-task/attempts`,
      headers: { "idempotency-key": "worker-attempt-key" },
      payload,
    });
    expect(missingCapability.statusCode).toBe(403);
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/tasks/control-smoke-task/attempts`,
      headers: workerHeaders,
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ adopted: false });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/tasks/control-smoke-task/attempts`,
      headers: workerHeaders,
      payload,
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({ adopted: true });
    const taskDetail = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/tasks/control-smoke-task`,
    });
    expect(taskDetail.statusCode).toBe(200);
    expect(taskDetail.json().attempts[0]).toMatchObject({
      action_id: launch.action_id,
      physical_job: {
        resource_id: "job-worker-attempt",
        observed_state: "RUNNING",
        inspect_url: expect.stringContaining("https://huggingface.co/jobs/test/"),
      },
    });
    expect(taskDetail.json().attempts[0]).not.toHaveProperty("evidence_path");
    expect(taskDetail.json().attempts[0]).not.toHaveProperty("evidence_digest");
    expect(JSON.stringify(taskDetail.json())).not.toContain(manifestPath);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/tasks/control-smoke-task/attempts`,
      headers: workerHeaders,
      payload: { ...payload, outcome: "semantic" },
    });
    expect(conflict.statusCode).toBe(409);
    const audit = await app.inject({ method: "GET", url: "/api/v1/audit" });
    const attemptEvent = audit
      .json()
      .items.find((event: { type: string }) => event.type === "attempt.receipt");
    expect(attemptEvent.data.record_id).toMatch(/^attempt-receipt-/);
    expect(attemptEvent.data).not.toHaveProperty("record");
    expect(JSON.stringify(attemptEvent)).not.toContain(payload.evidence_path);
    await app.close();
  });

  it("returns a client error for an unknown profile alias", async () => {
    const { app } = await setup("enabled");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "unknown-profile-key" },
      payload: { ...input, model: "unknown-model" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "profile_resolution_failed" },
    });
    await app.close();
  });

  it("rejects a run ceiling above the immutable launch-policy maximum", async () => {
    const { app } = await setup("enabled");
    const cappedInput = {
      benchmark: "terminal-bench-2-1-replacement",
      model: "deepseek-v4-flash-0731-together",
      harness: "pi-high",
      deployment: "tb21-deepseek-v4-flash-replacement",
      launch_policy: "tb21-replacement",
      ceiling_microusd: 180_000_001,
      confirmed: true,
    };
    const over = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "profile-ceiling-api-key" },
      payload: cappedInput,
    });
    expect(over.statusCode).toBe(422);
    expect(over.json()).toMatchObject({
      error: {
        code: "policy_rejected",
        message: "run ceiling exceeds the launch policy maximum",
        request_id: expect.any(String),
      },
    });
    const empty = await app.inject({ method: "GET", url: "/api/v1/runs" });
    expect(empty.json().items).toEqual([]);

    const exact = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "profile-ceiling-api-key" },
      payload: { ...cappedInput, ceiling_microusd: 180_000_000 },
    });
    expect(exact.statusCode).toBe(202);
    await app.close();
  });

  it("enforces profile resolution, confirmation, and idempotency", async () => {
    const { runtime, app } = await setup();
    const missingKey = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: input,
    });
    expect(missingKey.statusCode).toBe(409);
    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "request-key-0001" },
      payload: { ...input, confirmed: false },
    });
    expect(unconfirmed.statusCode).toBe(400);
    const wrongProfile = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "request-key-0002" },
      payload: { ...input, model: "other-model" },
    });
    expect(wrongProfile.statusCode).toBe(422);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "request-key-0003" },
      payload: input,
    });
    expect(response.statusCode).toBe(202);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "request-key-0003" },
      payload: input,
    });
    expect(duplicate.json()).toMatchObject({
      adopted: true,
      run_id: response.json().run_id,
    });
    const lock = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${response.json().run_id}/lock`,
    });
    expect(lock.statusCode).toBe(200);
    expect(lock.json()).toMatchObject({
      kind: "run.lock",
      run_id: response.json().run_id,
      tasks: [{ task_id: "control-smoke-task" }],
    });
    const audit = await app.inject({ method: "GET", url: "/api/v1/audit" });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items.length).toBeGreaterThanOrEqual(4);
    expect(runtime.projection.system().ready).toBe(true);
    await app.close();
  });

  it("locks an actor-attested Workbench recipe into a reviewed benchmark config", async () => {
    const { runtime, app } = await setup();
    const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
    const setupTestId = "setup-test-hosted-api";
    const attestor = vi
      .spyOn(runtime.workbench, "attestPassedSetup")
      .mockResolvedValue({
        setup_test_id: setupTestId,
        recipe_digest: preview.recipe_digest,
        revision_id: preview.revision_id,
        completed_at: "2026-09-02T23:00:00.000Z",
      });
    const submission = {
      benchmark_config: "tb21-gpt-oss-20b-canary",
      benchmark_config_revision: (await runtime.service.benchmarkConfigs())[0]
        ?.revision,
      harness: {
        type: "workbench",
        recipe: fastAgentWorkbenchStarter,
        setup_test_id: setupTestId,
      },
      ceiling_microusd: 1_000_000,
      confirmed: true,
    };
    const configs = await app.inject({
      method: "GET",
      url: "/api/v1/workbench/benchmark-configs",
    });
    expect(configs.statusCode).toBe(200);
    expect(configs.json()).toMatchObject({
      items: [
        {
          name: "tb21-gpt-oss-20b-canary",
          benchmark: "terminal-bench-2-1-canary",
          model: "gpt-oss-20b-together",
          task_count: 2,
          max_ceiling_microusd: 1_000_000,
          publication_role: "diagnostic",
        },
      ],
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "workbench-hosted-api-key" },
      payload: submission,
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(attestor).toHaveBeenCalledWith(
      setupTestId,
      expect.any(String),
      fastAgentWorkbenchStarter,
    );

    const runId = response.json().run_id as string;
    const lock = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/lock`,
    });
    expect(lock.statusCode).toBe(200);
    expect(lock.json()).toMatchObject({
      workbench: {
        benchmark_config: "tb21-gpt-oss-20b-canary",
        compiler_revision: "agent-workbench-compiler-v1",
        recipe: {
          name: fastAgentWorkbenchStarter.name,
          setup_command: "<redacted>",
          run_command: "<redacted>",
        },
        recipe_digest: preview.recipe_digest,
        revision_id: preview.revision_id,
        setup_attestation: {
          setup_test_id: setupTestId,
          completed_at: "2026-09-02T23:00:00.000Z",
        },
      },
    });
    expect(JSON.stringify(lock.json())).not.toContain(
      fastAgentWorkbenchStarter.setup_command,
    );
    expect(JSON.stringify(lock.json())).not.toContain(
      fastAgentWorkbenchStarter.run_command,
    );
    const durableLock = await runtime.projection.runLock(runId);
    expect(durableLock).toMatchObject({
      workbench: { recipe: fastAgentWorkbenchStarter },
      execution: {
        harbor_agent: preview.harness_profile.harbor_agent,
        harness: preview.harness_profile,
      },
    });
    const harness = durableLock?.profiles.find(
      (profile: { kind: string }) => profile.kind === "harness",
    ) as { name: string; spec: unknown; profile_id: string };
    expect(harness).toMatchObject({
      name: "fast-agent-0-10-16-command",
      spec: preview.harness_profile,
    });
    expect(harness.profile_id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(harness.profile_id).not.toBe(
      durableLock?.workbench?.template_harness.profile_id,
    );

    attestor.mockRejectedValue(new Error("setup state no longer exists"));
    const adopted = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "workbench-hosted-api-key" },
      payload: submission,
    });
    expect(adopted.json()).toMatchObject({ run_id: runId, adopted: true });
    expect(attestor).toHaveBeenCalledTimes(1);

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "workbench-hosted-api-key" },
      payload: {
        ...submission,
        harness: {
          ...submission.harness,
          recipe: {
            ...fastAgentWorkbenchStarter,
            run_command: `${fastAgentWorkbenchStarter.run_command}\nprintf changed`,
          },
        },
      },
    });
    expect(changed.statusCode).toBe(409);
    await app.close();
  });

  it("rejects unpassed Workbench setup evidence and config ceilings", async () => {
    const { runtime, app } = await setup();
    const attestor = vi
      .spyOn(runtime.workbench, "attestPassedSetup")
      .mockRejectedValue(new Error("setup test has not passed"));
    const submission = {
      benchmark_config: "tb21-gpt-oss-20b-canary",
      benchmark_config_revision: (await runtime.service.benchmarkConfigs())[0]
        ?.revision,
      harness: {
        type: "workbench",
        recipe: fastAgentWorkbenchStarter,
        setup_test_id: "setup-test-not-passed",
      },
      ceiling_microusd: 1_000_000,
      confirmed: true,
    };
    const staleConfig = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "workbench-stale-config-key" },
      payload: {
        ...submission,
        benchmark_config_revision: `sha256:${"0".repeat(64)}`,
      },
    });
    expect(staleConfig.statusCode).toBe(422);
    expect(staleConfig.json()).toMatchObject({
      error: {
        code: "policy_rejected",
        message:
          "benchmark configuration changed after it was reviewed; refresh and confirm again",
      },
    });
    expect(attestor).not.toHaveBeenCalled();
    const unpassed = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "workbench-unpassed-key" },
      payload: submission,
    });
    expect(unpassed.statusCode).toBe(422);
    expect(unpassed.json()).toMatchObject({
      error: { code: "policy_rejected", message: "setup test has not passed" },
    });

    const over = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "workbench-over-ceiling-key" },
      payload: { ...submission, ceiling_microusd: 1_000_001 },
    });
    expect(over.statusCode).toBe(422);
    expect(over.json()).toMatchObject({
      error: {
        code: "policy_rejected",
        message: "run ceiling exceeds the benchmark configuration maximum",
      },
    });
    expect(attestor).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe("authentication state", () => {
  it("keeps post-login redirects on the callback origin", () => {
    const callback = "https://control.example/auth/callback";
    expect(safeReturnPath("/runs?state=active#latest", callback)).toBe(
      "/runs?state=active#latest",
    );
    expect(safeReturnPath("/\\evil.example", callback)).toBe("/");
    expect(safeReturnPath("//evil.example", callback)).toBe("/");
    expect(safeReturnPath("https://evil.example", callback)).toBe("/");
  });

  it("uses secure partitioned cookies for embedded OAuth sessions", async () => {
    const { runtime, app } = await setup();
    vi.spyOn(runtime.auth, "login").mockResolvedValue({
      flow_id: "flow-id",
      url: new URL("https://identity.example/authorize"),
    });
    vi.spyOn(runtime.auth, "callback").mockResolvedValue({
      session_id: "session-id",
      csrf: "csrf-token",
      return_to: "/results",
      expires_at: Date.now() + 60_000,
    });

    const login = await app.inject({ method: "GET", url: "/auth/login" });
    expect(login.statusCode).toBe(302);
    expect(login.headers["set-cookie"]).toContain("hhf_oauth_flow=flow-id");
    expect(login.headers["set-cookie"]).toContain("SameSite=None");
    expect(login.headers["set-cookie"]).toContain("Partitioned");

    const callback = await app.inject({
      method: "GET",
      url: "/auth/callback?code=test-code&state=test-state",
      headers: { cookie: "hhf_oauth_flow=flow-id" },
    });
    expect(callback.statusCode).toBe(302);
    const callbackCookies = callback.headers["set-cookie"];
    expect(callbackCookies).toHaveLength(3);
    for (const setCookie of callbackCookies ?? []) {
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=None");
      expect(setCookie).toContain("Partitioned");
    }

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: "hhf_session=session-id; hhf_csrf=csrf-token" },
    });
    expect(logout.statusCode).toBe(204);
    for (const setCookie of logout.headers["set-cookie"] ?? []) {
      expect(setCookie).toContain("SameSite=None");
      expect(setCookie).toContain("Partitioned");
    }
    await app.close();
  });

  it("stores opaque sessions and rejects the wrong CSRF token", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhf-auth-"));
    roots.push(root);
    const store = await AuthStore.open(join(root, "auth.sqlite"));
    const session = store.createSession("subject-1", "test-user", 60);
    const row = store.session(session.id);
    expect(row).not.toBeNull();
    if (!row) throw new Error("session was not stored");
    expect(store.verifyCsrf(row, session.csrf)).toBe(true);
    expect(store.verifyCsrf(row, "wrong-token-that-is-long-enough-to-check")).toBe(
      false,
    );
    store.close();
  });

  it("keeps authenticated readers read-only unless listed as operators", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhf-auth-"));
    roots.push(root);
    const store = await AuthStore.open(join(root, "auth.sqlite"));
    const auth = new AuthenticationService("development", store, null, async () => ({
      schema_version: "v1",
      kind: "operator.acl",
      record_id: "operator-acl-test",
      created_at: "2026-08-16T00:00:00Z",
      actor: { subject: "test", role: "service" },
      operators: ["operator"],
      readers: ["reader"],
    }));
    expect(await auth.role("operator")).toBe("operator");
    expect(await auth.role("reader")).toBe("reader");
    expect(await auth.role("unlisted")).toBe("submitter");
    const unlisted = store.createSession("unlisted", "unlisted-user", 60);
    expect((await auth.sessionActor(unlisted.id))?.actor.role).toBe("submitter");
    expect(store.session(unlisted.id)).not.toBeNull();
    const unconfigured = new AuthenticationService(
      "oauth",
      store,
      null,
      async () => null,
    );
    expect(await unconfigured.role("unlisted")).toBeNull();
    expect(await unconfigured.sessionActor(unlisted.id)).toBeNull();
    store.close();
  });
});

describe("saved Workbench configuration API", () => {
  it("honors disabled writes and reader permissions", async () => {
    const { app, runtime } = await setup("disabled");
    const payload = fastAgentWorkbenchStarter;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/workbench/configurations",
          payload,
        })
      ).statusCode,
    ).toBe(422);
    const original = runtime.auth.developmentActor();
    vi.spyOn(runtime.auth, "developmentActor").mockReturnValue({
      ...original,
      role: "reader",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/workbench/configurations",
          payload,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("saves without launching and lists only the authenticated owner's recipes", async () => {
    const { app, runtime } = await setup();
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/configurations",
      payload: fastAgentWorkbenchStarter,
    });
    expect(saved.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workbench/configurations",
    });
    expect(list.json().items).toEqual([saved.json()]);
    const original = runtime.auth.developmentActor();
    vi.spyOn(runtime.auth, "developmentActor").mockReturnValue({
      ...original,
      subject: "another-owner",
    });
    const other = await app.inject({
      method: "GET",
      url: "/api/v1/workbench/configurations",
    });
    expect(other.json().items).toEqual([]);

    expect(
      (await app.inject({ method: "GET", url: "/api/v1/runs" })).json().items,
    ).toEqual([]);
  });
  it("rejects invalid recipes without saving", async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/configurations",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workbench/configurations",
    });
    expect(list.json().items).toEqual([]);
  });
});

describe("limited leaderboard submitter API", () => {
  it("uses an exact method/path allowlist, never reader-level control access", async () => {
    const { app, runtime } = await setup();
    vi.spyOn(runtime.auth, "developmentActor").mockReturnValue({
      subject: "ordinary-user",
      username: "Test submitter",
      role: "submitter",
      transport: "development",
    });
    for (const url of [
      "/api/v1/auth/session",
      "/api/v1/leaderboard",
      "/api/v1/leaderboard/submissions",
      "/api/v1/leaderboard/candidates",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
    for (const url of [
      "/api/v1/runs",
      "/api/v1/runs/run-test/lock",
      "/api/v1/results",
      "/api/v1/system",
      "/api/v1/events",
      "/api/v1/audit",
      "/api/v1/profiles",
      "/api/v1/jobs",
      "/api/v1/endpoints",
      "/api/v1/capacity",
      "/api/v1/workbench/configurations",
      "/api/v1/leaderboard/submissions/extra",
      "/api/v1/leaderboard/candidates/",
      "/api/v1/leaderboard%2fsubmissions",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(403);
    }
    for (const method of ["HEAD", "DELETE", "PUT", "PATCH"] as const) {
      expect(
        (await app.inject({ method, url: "/api/v1/leaderboard/submissions" }))
          .statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/leaderboard/submissions/missing/review",
          payload: {
            decision: "approved",
            confirmed: true,
            public_metadata_confirmed: true,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/leaderboard/submissions",
          payload: {
            run_id: "missing",
            catalog_digest: `sha256:${"a".repeat(64)}`,
            confirmed: true,
          },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/leaderboard/submissions",
          payload: {
            run_id: "missing",
            catalog_digest: `sha256:${"a".repeat(64)}`,
            confirmed: false,
          },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("requires session CSRF on submission and operator review and honors disabled writes", async () => {
    const { app, runtime } = await setup();
    runtime.config.auth_mode = "oauth";
    const session = runtime.auth.store.createSession("ordinary-user", "Test user", 60);
    const row = runtime.auth.store.session(session.id);
    if (!row) throw new Error("missing test session");
    const sessionSpy = vi.spyOn(runtime.auth, "sessionActor").mockResolvedValue({
      actor: {
        subject: row.subject,
        username: "Test user",
        role: "submitter",
        transport: "session",
      },
      session: row,
    });
    const headers = { cookie: `hhf_session=${session.id}` };
    const post = {
      method: "POST" as const,
      url: "/api/v1/leaderboard/submissions",
      payload: {
        run_id: "missing",
        catalog_digest: `sha256:${"a".repeat(64)}`,
        confirmed: true,
      },
    };
    expect((await app.inject({ ...post, headers })).json().error.code).toBe(
      "csrf_rejected",
    );
    expect(
      (
        await app.inject({
          ...post,
          headers: { ...headers, "x-csrf-token": session.csrf },
        })
      ).statusCode,
    ).toBe(404);
    runtime.config.write_mode = "disabled";
    expect(
      (
        await app.inject({
          ...post,
          headers: { ...headers, "x-csrf-token": session.csrf },
        })
      ).json().error.code,
    ).toBe("policy_rejected");
    sessionSpy.mockResolvedValue({
      actor: {
        subject: row.subject,
        username: "Test operator",
        role: "operator",
        transport: "session",
      },
      session: row,
    });
    const review = {
      method: "POST" as const,
      url: "/api/v1/leaderboard/submissions/missing/review",
      payload: {
        decision: "approved",
        confirmed: true,
        public_metadata_confirmed: true,
      },
    };
    expect((await app.inject({ ...review, headers })).json().error.code).toBe(
      "csrf_rejected",
    );
    expect(
      (
        await app.inject({
          ...review,
          headers: { ...headers, "x-csrf-token": session.csrf },
        })
      ).json().error.code,
    ).toBe("policy_rejected");
    runtime.config.write_mode = "enabled";
    expect(
      (
        await app.inject({
          ...review,
          payload: { decision: "approved", confirmed: true },
          headers: { ...headers, "x-csrf-token": session.csrf },
        })
      ).json().error.code,
    ).toBe("public_metadata_confirmation_required");
  });
});

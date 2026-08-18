import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  OperatorAcl,
  ProfileObject,
  ProfilePromotion,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sha256,
  workerEvidenceObjectPath,
} from "@harbor-hf/contracts";
import { mintWorkerCapability } from "@harbor-hf/control-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthStore, AuthenticationService, safeReturnPath } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const roots: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(
  writeMode: AppConfig["write_mode"] = "canary",
  seed?: (runtime: Runtime) => Promise<void>,
): Promise<{
  runtime: Runtime;
  app: Awaited<ReturnType<typeof buildApp>>;
}> {
  const root = await mkdtemp(join(tmpdir(), "hhf-api-"));
  roots.push(root);
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
    web_root: join(root, "web"),
    auth_mode: "development",
    write_mode: writeMode,
    public_origin: "http://127.0.0.1:7860",
    oauth: null,
    hf_token: "test-token-not-a-real-credential",
    hf_inference_token: null,
    reconcile_interval_ms: 60_000,
    observe_interval_ms: 0,
    worker_receipt_grace_ms: 0,
    source_revision: "test-revision",
    bootstrap_operator_subjects: [],
  };
  const runtime = await createRuntime(config);
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

function sandboxDeploymentRecords(): Array<ProfileObject | ProfilePromotion> {
  const sandbox = {
    image: `registry.example/sandbox@sha256:${"b".repeat(64)}`,
    hardware: "h200",
    timeout_seconds: 21_600,
    idle_timeout_seconds: 1_800,
    inference_token: "required" as const,
    inference_upstream: "https://route.example.endpoints.huggingface.cloud/v1",
    inference_model: "example/model",
    inference_api: "chat-completions" as const,
    inference_max_requests: 256,
    inference_max_concurrency: 1,
    inference_timeout_seconds: 1_800,
    inference_max_output_tokens: 32_768,
    root_bootstrap_command: ["/opt/worker/start-root-services"],
    reservation_microusd: 20_000_000,
    active_hourly_cost_microusd: 5_000_000,
    max_sandboxes: 1,
    max_commands: 8,
    max_command_seconds: 3_600,
    max_transfer_bytes: 1_048_576,
    allowed_roots: ["/app", "/logs"] as [string, ...string[]],
  };
  const spec = {
    route: "hf_job" as const,
    models: ["control-smoke"] as [string, ...string[]],
    harnesses: ["control-smoke"] as [string, ...string[]],
    job_image: `registry.example/worker@sha256:${"a".repeat(64)}`,
    job_command: ["python", "-m", "worker"] as [string, ...string[]],
    hardware: "cpu-basic",
    timeout_seconds: 7_200,
    trusted_worker: true,
    inference_token: "forbidden" as const,
    sandbox,
    task_sandboxes: [
      {
        task_id: "control-smoke-task",
        source_task_id: "control-smoke-task",
        trial_index: 1,
        image: `registry.example/task-sandbox@sha256:${"c".repeat(64)}`,
        hardware: "cpu-upgrade",
        timeout_seconds: 7_200,
        idle_timeout_seconds: 1_800,
        reservation_microusd: 2_000_000,
        active_hourly_cost_microusd: 30_000,
        max_command_seconds: 3_600,
      },
    ],
    inference_provider: "test-provider",
    input_price_microusd_per_million_tokens: 100_000,
    output_price_microusd_per_million_tokens: 200_000,
    harbor_version: "0.21.0",
    worker_revision: "abcdef0",
    worker_concurrency: 1,
    context_window: 131_072,
  };
  const profile: ProfileObject = {
    schema_version: "v1",
    kind: "profile.object",
    record_id: deterministicId(
      "profile",
      "deployment",
      "hf-sandbox-test",
      sha256(canonicalJson(spec)),
    ),
    created_at: "2026-08-18T00:00:00.000Z",
    actor: { subject: "profile-import", role: "migration" },
    profile_kind: "deployment",
    name: "hf-sandbox-test",
    spec,
  };
  const profileId = sha256(canonicalJson(profile));
  const promotion: ProfilePromotion = {
    schema_version: "v1",
    kind: "profile.promotion",
    record_id: deterministicId(
      "promotion",
      "deployment",
      "hf-sandbox-test",
      profileId,
      "approved",
    ),
    created_at: "2026-08-18T00:00:01.000Z",
    actor: { subject: "profile-operator", role: "operator" },
    profile_kind: "deployment",
    alias: "hf-sandbox-test",
    profile_id: profileId,
    promotion_state: "approved",
    reason: "approved after sandbox review",
    evidence: [sha256("sandbox-canary-evidence")],
  };
  const benchmarkSpec = {
    task_ids: ["control-smoke-task"] as [string],
    task_digests: [sha256("control-smoke-task")] as [string],
    benchmark: "control-smoke",
    revision: sha256("benchmark"),
    source_repository: "https://github.com/example/control-smoke.git",
    source_path: "tasks",
    trials_per_source_task: 1,
  };
  const benchmarkProfile: ProfileObject = {
    schema_version: "v1",
    kind: "profile.object",
    record_id: deterministicId(
      "profile",
      "benchmark",
      "control-smoke",
      sha256(canonicalJson(benchmarkSpec)),
    ),
    created_at: "2026-08-18T00:00:00.000Z",
    actor: { subject: "profile-import", role: "migration" },
    profile_kind: "benchmark",
    name: "control-smoke",
    spec: benchmarkSpec,
  };
  const benchmarkProfileId = sha256(canonicalJson(benchmarkProfile));
  const benchmarkPromotion: ProfilePromotion = {
    schema_version: "v1",
    kind: "profile.promotion",
    record_id: deterministicId(
      "promotion",
      "benchmark",
      "control-smoke",
      benchmarkProfileId,
      "approved",
    ),
    created_at: "2026-08-18T00:00:01.000Z",
    actor: { subject: "profile-operator", role: "operator" },
    profile_kind: "benchmark",
    alias: "control-smoke",
    profile_id: benchmarkProfileId,
    promotion_state: "approved",
    reason: "approved after sandbox review",
    evidence: [sha256("sandbox-canary-evidence")],
  };
  return [profile, promotion, benchmarkProfile, benchmarkPromotion];
}

describe("control API", () => {
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

  it("loads approved durable profile aliases and ignores recommendations", async () => {
    const spec = {
      model_id: "example/durable-model",
      revision: sha256("durable-model-revision"),
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
      evidence: [sha256(`${alias}-canary-evidence`)],
    });
    const approved = promotion("control-smoke", "approved", "2026-08-16T00:00:01.000Z");
    const recommended = promotion(
      "recommended-only",
      "recommended",
      "2026-08-16T00:00:02.000Z",
    );
    const { runtime, app } = await setup("canary", async (seedRuntime) => {
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
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "durable-profile-campaign-key" },
      payload: input,
    });
    expect(response.statusCode).toBe(202);
    const lock = await runtime.projection.campaignLock(
      response.json().campaign_id as string,
    );
    const lockedModel = lock?.profiles.find((item) => item.kind === "model");
    expect(lockedModel).toMatchObject({
      name: "control-smoke",
      profile_id: profileId,
    });
    const replacementSpec = {
      model_id: "example/replacement-model",
      revision: sha256("replacement-model-revision"),
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
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "durable-profile-campaign-key" },
      payload: input,
    });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json()).toMatchObject({ adopted: true });
    expect(
      (
        await runtime.projection.campaignLock(repeated.json().campaign_id as string)
      )?.profiles.find((item) => item.kind === "model")?.profile_id,
    ).toBe(profileId);
    await app.close();
  });

  it("paginates every collection response", async () => {
    const { runtime, app } = await setup();
    const campaign = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "pagination-campaign-key" },
      payload: input,
    });
    const campaignId = campaign.json().campaign_id as string;
    await runtime.reconciler.tick();
    const urls = [
      "/api/v1/campaigns?limit=1",
      `/api/v1/campaigns/${campaignId}/tasks?limit=1`,
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
    const firstProfile = firstProfiles.json().items[0].profile_id as string;
    const cursor = firstProfiles.json().next_cursor as string;
    const secondProfiles = await app.inject({
      method: "GET",
      url: `/api/v1/profiles?limit=1&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(secondProfiles.json().items[0].profile_id).not.toBe(firstProfile);
    await app.close();
  });

  it("limits worker capabilities to their campaign action routes", async () => {
    const { runtime, app } = await setup();
    const submission = await runtime.service.submit(
      input,
      "worker-capability-submission",
      { subject: "operator", role: "operator" },
    );
    const lock = await runtime.projection.campaignLock(submission.campaign_id);
    expect(lock).not.toBeNull();
    if (!lock) throw new Error("campaign lock is missing");
    const taskId = lock.tasks[0]?.task_id;
    expect(taskId).toBeDefined();
    const token = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      campaign_id: submission.campaign_id,
      campaign_lock_digest: sha256(canonicalJson(lock)),
      action_id: "action-worker-capability",
      task_ids: [taskId ?? "missing"],
      operations: ["campaign.read", "attempt.submit", "evidence.write"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const headers = { "x-harbor-hf-worker-capability": token };

    const lockResponse = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${submission.campaign_id}/lock`,
      headers,
    });
    expect(lockResponse.statusCode).toBe(200);
    expect(lockResponse.json().tasks).toMatchObject([{ task_id: taskId }]);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/profiles", headers }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/campaigns/campaign-other/lock",
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/campaigns/${submission.campaign_id}/tasks/${taskId}/attempts`,
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
    expect((await app.inject({ method: "GET", url: "/health/ready" })).json()).toEqual({
      status: "ready",
    });

    for (const url of [
      "/api/v1/system",
      "/api/v1/campaigns",
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
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "anonymous-mutation" },
      payload: input,
    });
    expect(mutation.statusCode).toBe(401);
    expect(runtime.projection.system().object_count).toBe(before);

    const oversized = `{"padding":"${"x".repeat(2 * 1024 * 1024)}"}`;
    const anonymousOversized = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
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
      url: "/api/v1/campaigns",
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
      campaign_id: "campaign-rate-limit",
      campaign_lock_digest: `sha256:${"a".repeat(64)}`,
      action_id: "action-rate-limit",
      task_ids: ["task-rate-limit"],
      operations: ["campaign.read"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/campaigns/campaign-rate-limit/lock",
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
      campaign_id: "campaign-verified-limit",
      campaign_lock_digest: `sha256:${"a".repeat(64)}`,
      action_id: "action-verified-limit",
      task_ids: ["task-verified-limit"],
      operations: ["campaign.read"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/campaigns/campaign-verified-limit/lock",
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
    const { runtime, app } = await setup("canary", async (seededRuntime) => {
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

    const session = runtime.auth.store.createSession("operator", 60);
    const authenticated = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: `hhf_session=${session.id}` },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({
      authenticated: true,
      actor: { subject: "operator", role: "operator" },
    });
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
    const { runtime, app } = await setup("canary", async (seededRuntime) => {
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

  it("serves validated imported result catalogs", async () => {
    const { runtime, app } = await setup();
    const catalog = {
      schema_version: "v1",
      kind: "result.catalog",
      record_id: "catalog-import-one",
      created_at: "2026-08-16T00:00:00Z",
      source_digest: `sha256:${"a".repeat(64)}`,
      entries: [
        {
          publication_id: "publication-one",
          campaign_id: "campaign-one",
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
    await runtime.store.create(
      "results/schema=v1/catalog/imports/catalog-import-one.json",
      new TextEncoder().encode(canonicalJson(catalog)),
    );

    const response = await app.inject({ method: "GET", url: "/api/v1/results" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      publication_id: "publication-one",
      model: "model-one",
      primary_metric: { value: 0.75 },
      status: "published",
    });
    await app.close();
  });

  it("accepts idempotent trusted-worker attempt receipts", async () => {
    const { runtime, app } = await setup();
    const campaign = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "campaign-request-key" },
      payload: input,
    });
    const campaignId = campaign.json().campaign_id as string;
    await runtime.reconciler.tick();
    const launch = (await runtime.projection.actions()).find(
      (action) => action.action_kind === "job.launch",
    );
    if (!launch) throw new Error("campaign admission did not create a Job launch");
    const lock = await runtime.projection.campaignLock(campaignId);
    if (!lock) throw new Error("campaign lock is missing");
    const capability = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      campaign_id: campaignId,
      campaign_lock_digest: sha256(canonicalJson(lock)),
      action_id: launch.action_id,
      task_ids: ["control-smoke-task"],
      operations: ["campaign.read", "attempt.submit", "evidence.write"],
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
      campaignId,
      launch.action_id,
      "control-smoke-task",
      chunkDigest,
    );
    const evidenceUrl = `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/attempts`;
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
      campaign_id: campaignId,
      action_id: launch.action_id,
      task_id: "control-smoke-task",
      objects: [{ path: chunkPath, digest: chunkDigest, size: chunk.byteLength }],
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
    const manifestDigest = sha256(manifestBytes);
    const manifestPath = workerEvidenceObjectPath(
      campaignId,
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
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/attempts`,
      headers: { "idempotency-key": "worker-attempt-key" },
      payload,
    });
    expect(missingCapability.statusCode).toBe(403);
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/attempts`,
      headers: workerHeaders,
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ adopted: false });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/attempts`,
      headers: workerHeaders,
      payload,
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({ adopted: true });
    const taskDetail = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task`,
    });
    expect(taskDetail.statusCode).toBe(200);
    expect(taskDetail.json().attempts[0]).not.toHaveProperty("evidence_path");
    expect(taskDetail.json().attempts[0]).not.toHaveProperty("evidence_digest");
    expect(JSON.stringify(taskDetail.json())).not.toContain(manifestPath);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/attempts`,
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

  it("keeps Sandbox lifecycle capability-scoped, durable, and topology-redacted", async () => {
    const records = sandboxDeploymentRecords();
    const { runtime, app } = await setup("enabled", async (seedRuntime) => {
      for (const record of records)
        await seedRuntime.store.create(
          controlRecordPath(record),
          new TextEncoder().encode(canonicalJson(record)),
        );
    });
    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "sandbox-campaign-key" },
      payload: {
        ...input,
        deployment: "hf-sandbox-test",
        ceiling_microusd: 20_000_000,
      },
    });
    expect(submission.statusCode).toBe(202);
    const campaignId = submission.json().campaign_id as string;
    await runtime.reconciler.tick();
    const lock = await runtime.projection.campaignLock(campaignId);
    if (!lock) throw new Error("campaign lock is missing");
    const launch = (await runtime.projection.campaignActions(campaignId)).find(
      (action) => action.action_kind === "job.launch",
    );
    if (!launch) throw new Error("campaign admission did not create a Job launch");
    const browserLock = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/lock`,
    });
    expect(browserLock.statusCode).toBe(200);
    const browserDeployment = browserLock
      .json()
      .profiles.find((profile: { kind: string }) => profile.kind === "deployment");
    expect(browserDeployment.spec).not.toHaveProperty("task_sandboxes");
    expect(browserDeployment.spec).toMatchObject({ sandbox_task_count: 1 });
    const capability = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      campaign_id: campaignId,
      campaign_lock_digest: sha256(canonicalJson(lock)),
      action_id: launch.action_id,
      task_ids: ["control-smoke-task"],
      operations: [
        "campaign.read",
        "attempt.submit",
        "evidence.write",
        "sandbox.create",
        "sandbox.observe",
        "sandbox.exec",
        "sandbox.write",
        "sandbox.read",
        "sandbox.close",
      ],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const capabilityHeaders = {
      "x-harbor-hf-worker-capability": capability,
    };
    const lifecycle = vi.spyOn(
      runtime.sandboxes as NonNullable<Runtime["sandboxes"]>,
      "lifecycle",
    );
    lifecycle.mockImplementation(async (intent) => ({
      outcome: intent.action_kind === "sandbox.create" ? "created" : "completed",
      observed_state: intent.action_kind === "sandbox.close" ? "CANCELED" : "RUNNING",
      resource_id: "private-remote-sandbox-id",
    }));
    vi.spyOn(
      runtime.sandboxes as NonNullable<Runtime["sandboxes"]>,
      "execute",
    ).mockResolvedValue({
      exit_code: 0,
      stdout: "ok\n",
      stderr: "",
      signal: null,
      timed_out: false,
      duration_ms: 12,
    });
    const write = vi
      .spyOn(runtime.sandboxes as NonNullable<Runtime["sandboxes"]>, "write")
      .mockResolvedValue();
    vi.spyOn(
      runtime.sandboxes as NonNullable<Runtime["sandboxes"]>,
      "read",
    ).mockResolvedValue({ bytes: Buffer.from("result", "utf8") });

    const operatorLock = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/lock`,
    });
    expect(JSON.stringify(operatorLock.json())).not.toContain(
      "route.example.endpoints.huggingface.cloud",
    );
    const workerLock = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/lock`,
      headers: capabilityHeaders,
    });
    expect(JSON.stringify(workerLock.json())).toContain(
      "route.example.endpoints.huggingface.cloud",
    );

    const limitedCapability = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      campaign_id: campaignId,
      campaign_lock_digest: sha256(canonicalJson(lock)),
      action_id: launch.action_id,
      task_ids: ["control-smoke-task"],
      operations: ["campaign.read"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const deniedCreate = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes`,
      headers: {
        "x-harbor-hf-worker-capability": limitedCapability,
        "idempotency-key": "sandbox-denied-create-key",
      },
    });
    expect(deniedCreate.statusCode).toBe(403);

    const create = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-create-key",
      },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json()).toMatchObject({ state: "RUNNING" });
    expect(JSON.stringify(create.json())).not.toContain("private-remote-sandbox-id");
    const createIntent = lifecycle.mock.calls[0]?.[0];
    expect(createIntent?.payload.sandbox).toMatchObject({
      image: `registry.example/task-sandbox@sha256:${"c".repeat(64)}`,
      hardware: "cpu-upgrade",
      reservation_microusd: 2_000_000,
    });
    const sandboxId = create.json().sandbox_id as string;
    const repeatedCreate = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-create-key",
      },
    });
    expect(repeatedCreate.json()).toEqual(create.json());
    expect(lifecycle).toHaveBeenCalledTimes(1);

    const exec = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes/${sandboxId}/exec`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-command-key",
      },
      payload: {
        command: ["python", "worker.py"],
        cwd: "/app",
        timeout_seconds: 60,
      },
    });
    expect(exec.statusCode).toBe(200);
    expect(exec.json()).toMatchObject({ exit_code: 0, stdout: "ok\n" });

    const content = Buffer.from("input", "utf8");
    const deniedUpload = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes/${sandboxId}/files`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-denied-upload-key",
      },
      payload: {
        path: "/etc/input.txt",
        content_digest: sha256(content),
        content_base64: content.toString("base64"),
      },
    });
    expect(deniedUpload.statusCode).toBe(422);
    const upload = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes/${sandboxId}/files`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-upload-key",
      },
      payload: {
        path: "/app/input.txt",
        content_digest: sha256(content),
        content_base64: content.toString("base64"),
        mode: "0600",
      },
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toEqual({ digest: sha256(content), size: 5 });
    expect(write).toHaveBeenCalledOnce();

    const download = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes/${sandboxId}/files/read`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-download-key",
      },
      payload: { path: "/logs/result.txt" },
    });
    expect(download.statusCode).toBe(200);
    expect(download.json()).toEqual({
      digest: sha256("result"),
      size: 6,
      content_base64: Buffer.from("result", "utf8").toString("base64"),
    });

    const close = await app.inject({
      method: "DELETE",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes/${sandboxId}`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-close-key",
      },
    });
    expect(close.statusCode).toBe(200);
    expect(close.json()).toEqual({ sandbox_id: sandboxId, state: "CANCELED" });
    expect(await runtime.projection.campaign(campaignId)).toMatchObject({
      reserved_microusd: 0,
      observed_microusd: 2_000_000,
    });
    const actionKinds = (await runtime.projection.campaignActions(campaignId)).map(
      (action) => action.action_kind,
    );
    expect(actionKinds).toEqual(
      expect.arrayContaining([
        "sandbox.create",
        "sandbox.exec",
        "sandbox.write",
        "sandbox.read",
        "sandbox.close",
      ]),
    );
    await app.close();
  });

  it("returns a client error for an unknown profile alias", async () => {
    const { app } = await setup("enabled");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "unknown-profile-key" },
      payload: { ...input, model: "unknown-model" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "profile_resolution_failed" },
    });
    await app.close();
  });

  it("enforces canary profiles, confirmation, and idempotency", async () => {
    const { runtime, app } = await setup();
    const missingKey = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      payload: input,
    });
    expect(missingKey.statusCode).toBe(409);
    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "request-key-0001" },
      payload: { ...input, confirmed: false },
    });
    expect(unconfirmed.statusCode).toBe(400);
    const wrongProfile = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "request-key-0002" },
      payload: { ...input, model: "other-model" },
    });
    expect(wrongProfile.statusCode).toBe(422);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "request-key-0003" },
      payload: input,
    });
    expect(response.statusCode).toBe(202);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "request-key-0003" },
      payload: input,
    });
    expect(duplicate.json()).toMatchObject({
      adopted: true,
      campaign_id: response.json().campaign_id,
    });
    const lock = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${response.json().campaign_id}/lock`,
    });
    expect(lock.statusCode).toBe(200);
    expect(lock.json()).toMatchObject({
      kind: "campaign.lock",
      campaign_id: response.json().campaign_id,
      tasks: [{ task_id: "control-smoke-task" }],
    });
    const audit = await app.inject({ method: "GET", url: "/api/v1/audit" });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items.length).toBeGreaterThanOrEqual(4);
    expect(runtime.projection.system().ready).toBe(true);
    await app.close();
  });
});

describe("authentication state", () => {
  it("keeps post-login redirects on the callback origin", () => {
    const callback = "https://control.example/auth/callback";
    expect(safeReturnPath("/campaigns?state=active#latest", callback)).toBe(
      "/campaigns?state=active#latest",
    );
    expect(safeReturnPath("/\\evil.example", callback)).toBe("/");
    expect(safeReturnPath("//evil.example", callback)).toBe("/");
    expect(safeReturnPath("https://evil.example", callback)).toBe("/");
  });

  it("stores opaque sessions and rejects the wrong CSRF token", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhf-auth-"));
    roots.push(root);
    const store = await AuthStore.open(join(root, "auth.sqlite"));
    const session = store.createSession("subject-1", 60);
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
    expect(await auth.role("unlisted")).toBeNull();
    const unlisted = store.createSession("unlisted", 60);
    expect(await auth.sessionActor(unlisted.id)).toBeNull();
    expect(store.session(unlisted.id)).toBeNull();
    store.close();
  });
});

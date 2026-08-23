import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  OperatorAcl,
  ProfileObject,
  ProfilePromotion,
  PublicationReceipt,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sandboxActionResultPath,
  sha256,
  validateLeaderboardSnapshot,
  workerEvidenceObjectPath,
} from "@harbor-hf/contracts";
import {
  encodeLeaderboardSqlite,
  LEADERBOARD_RECEIPT_PREFIX,
  LEADERBOARD_SNAPSHOT_PREFIX,
  loadLatestLeaderboard,
  mintWorkerCapability,
} from "@harbor-hf/control-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthenticationService, AuthStore, safeReturnPath } from "../src/auth.js";
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
  capacityProfileAlias: string | null = null,
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
  if (selectedCapacityAlias)
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

function sandboxDeploymentRecords(): Array<ProfileObject | ProfilePromotion> {
  const sandbox = {
    image: `registry.example/task-sandbox@sha256:${"c".repeat(64)}`,
    hardware: "cpu-upgrade",
    timeout_seconds: 7_200,
    idle_timeout_seconds: 1_800,
    inference_token: "required" as const,
    inference_upstream: "https://route.example.endpoints.huggingface.cloud/v1",
    inference_model: "example/model",
    inference_api: "chat-completions" as const,
    inference_max_requests: 256,
    inference_max_concurrency: 1,
    inference_max_total_concurrency: 1,
    inference_timeout_seconds: 1_800,
    inference_max_output_tokens: 32_768,
    root_bootstrap_command: ["/opt/worker/start-root-services"],
    reservation_microusd: 2_000_000,
    active_hourly_cost_microusd: 30_000,
    max_sandboxes: 1,
    max_commands: 1,
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
    active_hourly_cost_microusd: 10_000,
    timeout_seconds: 7_200,
    trusted_worker: true,
    inference_token: "forbidden" as const,
    sandbox,
    inference_provider: "test-provider",
    input_price_microusd_per_million_tokens: 100_000,
    output_price_microusd_per_million_tokens: 200_000,
    harbor_version: "0.21.0",
    worker_revision: "abcdef0",
    worker_concurrency: 1,
    worker_max_tasks_per_job: 1,
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

function capacityRecords(): Array<ProfileObject | ProfilePromotion> {
  const spec = {
    namespace: "test",
    max_active_sandboxes: 1,
    hardware_limits: [{ hardware: "cpu-upgrade", max_active_sandboxes: 1 }],
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

  it("returns an unavailable capacity view for campaigns without Sandboxes", async () => {
    const { app } = await setup();
    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "no-sandbox-capacity" },
      payload: input,
    });
    const campaignId = submission.json().campaign_id as string;
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/capacity`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      campaign_limit: 0,
      campaign_active: 0,
      provider_limit: 0,
    });
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

  it("exposes Hub inspect URLs for Jobs", async () => {
    const { runtime, app } = await setup();
    const campaign = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "job-inspect-campaign-key" },
      payload: input,
    });
    expect(campaign.statusCode).toBe(202);
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
    const campaign = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "job-latest-state-key" },
      payload: { ...input, ceiling_microusd: 100_000 },
    });
    expect(campaign.statusCode).toBe(202);
    const campaignId = campaign.json().campaign_id as string;
    const actor = { subject: "operator" as const, role: "operator" as const };
    const resourceId = "job-latest-state";
    const payload = {
      task_ids: ["control-smoke-task"],
      max_infrastructure_attempts: 1,
      success_without_worker_receipt: true,
      resource_id: resourceId,
    };
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
        campaignId,
        record.kind,
        resourceId,
        record.generation,
        payload,
        actor,
        record.createdAt,
      );
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
      action_kind: "job.observe",
      observed_state: "ERROR",
      resource_id: resourceId,
      cost_microusd: 40_000,
      assigned_tasks: 1,
      inspect_url: `https://huggingface.co/jobs/test/${resourceId}`,
    });
    const scoped = await app.inject({
      method: "GET",
      url: `/api/v1/jobs?campaign_id=${encodeURIComponent(campaignId)}`,
    });
    expect(scoped.statusCode).toBe(200);
    expect(
      (scoped.json().items as Array<{ campaign_id: string }>).every(
        (item) => item.campaign_id === campaignId,
      ),
    ).toBe(true);
    const empty = await app.inject({
      method: "GET",
      url: "/api/v1/jobs?campaign_id=campaign-missing",
    });
    expect(empty.json().items).toEqual([]);
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
    await app.close();
  });

  it("hides a local publication when its committed row objects are missing", async () => {
    const { runtime, app } = await setup();
    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "missing-publication-rows-campaign" },
      payload: input,
    });
    const campaignId = submission.json().campaign_id as string;
    const publicationId = deterministicId("publication", campaignId);
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
          campaign_id: campaignId,
          run_id: campaignId,
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
      campaign_id: campaignId,
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
      campaign_id: "run-leaderboard",
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
      source_digest: sha256(canonicalJson([row.campaign_id])),
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

  it("queues capacity-controlled Sandbox creates and reports the limiting state", async () => {
    const records = sandboxDeploymentRecords();
    const { runtime, app } = await setup(
      "enabled",
      async (seedRuntime) => {
        for (const record of records)
          await seedRuntime.store.create(
            controlRecordPath(record),
            new TextEncoder().encode(canonicalJson(record)),
          );
      },
      "capacity-test",
    );
    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "capacity-campaign-key" },
      payload: {
        ...input,
        deployment: "hf-sandbox-test",
        ceiling_microusd: 20_000_000,
      },
    });
    const campaignId = submission.json().campaign_id as string;
    await runtime.reconciler.tick();
    const lock = await runtime.projection.campaignLock(campaignId);
    const launch = (await runtime.projection.campaignActions(campaignId)).find(
      (action) => action.action_kind === "job.launch",
    );
    if (!lock || !launch) throw new Error("campaign launch is missing");
    const capability = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      campaign_id: campaignId,
      campaign_lock_digest: sha256(canonicalJson(lock)),
      action_id: launch.action_id,
      task_ids: ["control-smoke-task"],
      operations: ["campaign.read", "sandbox.create", "sandbox.close"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const headers = {
      "x-harbor-hf-worker-capability": capability,
      "idempotency-key": "capacity-create-key",
    };
    const campaignState = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}`,
      headers: { "x-harbor-hf-worker-capability": capability },
    });
    expect(campaignState.statusCode).toBe(200);
    expect(campaignState.json().cancellation_requested).toBe(false);
    const lifecycle = vi.spyOn(
      runtime.sandboxes as NonNullable<Runtime["sandboxes"]>,
      "lifecycle",
    );
    lifecycle.mockImplementation(async (intent) => ({
      outcome: intent.action_kind === "sandbox.create" ? "created" : "completed",
      observed_state: intent.action_kind === "sandbox.close" ? "CANCELED" : "RUNNING",
      resource_id: "private-capacity-sandbox-id",
      cost_microusd: 0,
    }));

    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes`,
      headers,
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({
      state: "QUEUED",
      limiting_factor: null,
    });
    await runtime.reconciler.tick();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes`,
      headers,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ state: "RUNNING" });
    expect(lifecycle).toHaveBeenCalledTimes(1);

    const capacity = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/capacity`,
    });
    expect(capacity.statusCode).toBe(200);
    expect(capacity.json()).toMatchObject({
      configured: true,
      namespace_limit: 1,
      namespace_active: 1,
      campaign_active: 1,
      provider_reserved: 1,
      start_tokens: 0,
    });
    expect(JSON.stringify(capacity.json())).not.toContain(
      "private-capacity-sandbox-id",
    );
    const profiles = await app.inject({ method: "GET", url: "/api/v1/profiles" });
    const capacityProfile = profiles
      .json()
      .items.find((item: { profile_kind: string }) => item.profile_kind === "capacity");
    expect(capacityProfile.spec).not.toHaveProperty("namespace");
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
    runtime.service.configureCapacityProfile(null);
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

    const competingCreates = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes`,
        headers: {
          ...capabilityHeaders,
          "idempotency-key": "sandbox-create-key",
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes`,
        headers: {
          ...capabilityHeaders,
          "idempotency-key": "sandbox-competing-create-key",
        },
      }),
    ]);
    const create = competingCreates.find((response) => response.statusCode === 200);
    const rejectedCreate = competingCreates.find(
      (response) => response.statusCode === 422,
    );
    if (!create) throw new Error("Sandbox create did not succeed");
    expect(rejectedCreate?.json().error.message).toContain("Sandbox count");
    expect(create.json()).toMatchObject({ state: "RUNNING" });
    expect(JSON.stringify(create.json())).not.toContain("private-remote-sandbox-id");
    const createIntent = lifecycle.mock.calls[0]?.[0];
    expect(lifecycle.mock.calls[0]?.[1]).toEqual({ adoption_only: false });
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

    const oversizedCommand = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes/${sandboxId}/exec`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-oversized-command-key",
      },
      payload: {
        command: ["python", "worker.py"],
        cwd: "/app",
        timeout_seconds: 3_601,
      },
    });
    expect(oversizedCommand.statusCode).toBe(422);
    expect(oversizedCommand.json().error.message).toContain("timeout");

    const competingCommands = await Promise.all([
      app.inject({
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
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes/${sandboxId}/exec`,
        headers: {
          ...capabilityHeaders,
          "idempotency-key": "sandbox-competing-command-key",
        },
        payload: {
          command: ["python", "other.py"],
          cwd: "/app",
          timeout_seconds: 60,
        },
      }),
    ]);
    const exec = competingCommands.find((response) => response.statusCode === 200);
    const rejectedCommand = competingCommands.find(
      (response) => response.statusCode === 422,
    );
    if (!exec) throw new Error("Sandbox command did not succeed");
    expect(exec.json()).toMatchObject({ exit_code: 0, stdout: "ok\n" });
    expect(rejectedCommand?.json().error.message).toContain("command count");
    const conflictingExec = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes/${sandboxId}/exec`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-command-key",
      },
      payload: {
        command: ["false"],
        cwd: "/app",
        timeout_seconds: 60,
      },
    });
    expect(conflictingExec.statusCode).toBe(409);

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

  it("terminalizes an ambiguous Sandbox command without replay", async () => {
    const records = sandboxDeploymentRecords();
    const { runtime, app } = await setup("enabled", async (seedRuntime) => {
      for (const record of records)
        await seedRuntime.store.create(
          controlRecordPath(record),
          new TextEncoder().encode(canonicalJson(record)),
        );
    });
    runtime.service.configureCapacityProfile(null);
    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "sandbox-ambiguous-campaign-key" },
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
    const capability = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      campaign_id: campaignId,
      campaign_lock_digest: sha256(canonicalJson(lock)),
      action_id: launch.action_id,
      task_ids: ["control-smoke-task"],
      operations: ["campaign.read", "sandbox.create", "sandbox.exec", "sandbox.close"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const capabilityHeaders = {
      "x-harbor-hf-worker-capability": capability,
    };
    vi.spyOn(
      runtime.sandboxes as NonNullable<Runtime["sandboxes"]>,
      "lifecycle",
    ).mockImplementation(async (intent) => ({
      outcome: intent.action_kind === "sandbox.create" ? "created" : "completed",
      observed_state: intent.action_kind === "sandbox.close" ? "CANCELED" : "RUNNING",
      resource_id: "private-ambiguous-sandbox-resource",
    }));
    const execute = vi
      .spyOn(runtime.sandboxes as NonNullable<Runtime["sandboxes"]>, "execute")
      .mockRejectedValue(
        new Error(
          "private adapter response at https://private.example.invalid contains topology",
        ),
      );
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-ambiguous-create-key",
      },
    });
    expect(create.statusCode).toBe(200);
    const sandboxId = create.json().sandbox_id as string;
    const execUrl = `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes/${sandboxId}/exec`;
    const execInput = {
      method: "POST" as const,
      url: execUrl,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-ambiguous-command-key",
      },
      payload: {
        command: ["python", "worker.py"],
        cwd: "/app",
        timeout_seconds: 60,
      },
    };
    const failed = await app.inject(execInput);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({
      error: {
        code: "sandbox_action_ambiguous",
        message: "Sandbox action outcome is unknown and cannot be replayed",
        request_id: expect.any(String),
      },
    });
    expect(JSON.stringify(failed.json())).not.toContain("private.example.invalid");
    expect(execute).toHaveBeenCalledOnce();
    const command = (await runtime.projection.campaignActions(campaignId)).find(
      (action) => action.action_kind === "sandbox.exec",
    );
    if (!command?.receipt_body) throw new Error("ambiguous receipt is missing");
    expect(JSON.parse(command.receipt_body)).toMatchObject({
      outcome: "failed",
      observed_state: "AMBIGUOUS",
      error_code: "sandbox_external_outcome_unknown",
    });
    expect(await runtime.projection.actionAdvanced(command.action_id)).toBe(true);
    const resultPath = sandboxActionResultPath(campaignId, command.action_id);
    const resultPrefix = resultPath.slice(0, -"/result.json".length);
    expect(await runtime.store.list(resultPrefix)).toEqual([]);
    expect(
      await runtime.projection.pendingDispatchedSandboxCommandActions(
        campaignId,
        "control-smoke-task",
      ),
    ).toEqual([]);

    const repeated = await app.inject(execInput);
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({
      error: { code: "idempotency_conflict" },
    });
    expect(execute).toHaveBeenCalledOnce();
    const close = await app.inject({
      method: "DELETE",
      url: `/api/v1/campaigns/${campaignId}/tasks/control-smoke-task/sandboxes/${sandboxId}`,
      headers: {
        ...capabilityHeaders,
        "idempotency-key": "sandbox-ambiguous-close-key",
      },
    });
    expect(close.statusCode).toBe(200);
    await app.close();
  });

  it("keeps historical disposition correction operator-scoped and redacted", async () => {
    const { runtime, app } = await setup("enabled");
    const correct = vi
      .spyOn(runtime.service, "correctHistoricalSandboxAmbiguities")
      .mockResolvedValue({
        batch_id: "disposition-batch-safe",
        batch_digest: `sha256:${"a".repeat(64)}`,
        items: [
          {
            action_id: "action-safe",
            disposition_record_id: "disposition-action-safe",
            created: true,
          },
        ],
      });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns/campaign-safe/tasks/task-safe/action-dispositions",
      headers: { "idempotency-key": "disposition-request-key" },
      payload: {
        action_ids: ["action-safe"],
        reason: "correct a proved historical observation",
        confirmed: true,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      batch_id: "disposition-batch-safe",
      batch_digest: `sha256:${"a".repeat(64)}`,
      items: [
        {
          action_id: "action-safe",
          disposition_record_id: "disposition-action-safe",
          created: true,
        },
      ],
    });
    expect(correct).toHaveBeenCalledWith(
      "campaign-safe",
      "task-safe",
      {
        action_ids: ["action-safe"],
        reason: "correct a proved historical observation",
        confirmed: true,
      },
      "disposition-request-key",
      expect.objectContaining({ role: "operator" }),
    );
    expect(JSON.stringify(response.json())).not.toContain("close_action_id");
    expect(JSON.stringify(response.json())).not.toContain("resource_id");

    vi.spyOn(runtime.projection, "actionDispositionViews").mockResolvedValue([
      {
        action_id: "action-safe",
        campaign_id: "campaign-safe",
        task_id: "task-safe",
        recorded_outcome: "completed",
        recorded_observed_state: "suppressed-sandbox-cleanup-ambiguous",
        effective_outcome: "failed",
        effective_observed_state: "AMBIGUOUS",
        effective_error_code: "sandbox_external_outcome_unknown",
        reason_code: "historical_non_replay_safe_command_ambiguity",
        corrected_at: "2026-08-21T00:00:00Z",
        actor_role: "operator",
        disposition_record_id: "disposition-action-safe",
        batch_id: "disposition-batch-safe",
        batch_size: 1,
      },
    ]);
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/campaigns/campaign-safe/tasks/task-safe/action-dispositions",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [
        {
          recorded_outcome: "completed",
          effective_outcome: "failed",
          effective_observed_state: "AMBIGUOUS",
        },
      ],
      next_cursor: null,
    });
    expect(JSON.stringify(listed.json())).not.toContain("receipt_digest");
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

  it("rejects a campaign ceiling above the immutable launch-policy maximum", async () => {
    const { app } = await setup("enabled");
    const cappedInput = {
      benchmark: "terminal-bench-2-1-replacement",
      model: "deepseek-v4-flash-0731-together",
      harness: "pi-0-84-2-high-deepseek-v4-flash-0731-together",
      deployment: "tb21-deepseek-v4-flash-replacement",
      launch_policy: "tb21-replacement",
      ceiling_microusd: 180_000_001,
      confirmed: true,
    };
    const over = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "profile-ceiling-api-key" },
      payload: cappedInput,
    });
    expect(over.statusCode).toBe(422);
    expect(over.json()).toMatchObject({
      error: {
        code: "policy_rejected",
        message: "campaign ceiling exceeds the launch policy maximum",
        request_id: expect.any(String),
      },
    });
    const empty = await app.inject({ method: "GET", url: "/api/v1/campaigns" });
    expect(empty.json().items).toEqual([]);

    const exact = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "idempotency-key": "profile-ceiling-api-key" },
      payload: { ...cappedInput, ceiling_microusd: 180_000_000 },
    });
    expect(exact.statusCode).toBe(202);
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
    expect(await auth.role("unlisted")).toBeNull();
    const unlisted = store.createSession("unlisted", "unlisted-user", 60);
    expect(await auth.sessionActor(unlisted.id)).toBeNull();
    expect(store.session(unlisted.id)).toBeNull();
    store.close();
  });
});

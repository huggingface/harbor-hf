import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson } from "@harbor-hf/contracts";
import { mintWorkerCapability } from "@harbor-hf/control-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthStore, AuthenticationService } from "../src/auth.js";
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

async function setup(writeMode: AppConfig["write_mode"] = "canary"): Promise<{
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
    reconcile_interval_ms: 60_000,
    observe_interval_ms: 0,
    source_revision: "test-revision",
    bootstrap_operator_subjects: [],
  };
  const runtime = await createRuntime(config);
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

describe("control API", () => {
  it("reports liveness and projection readiness separately", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(
      200,
    );
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ready" });
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
    const taskId = lock?.tasks[0]?.task_id;
    expect(taskId).toBeDefined();
    const token = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      campaign_id: submission.campaign_id,
      action_id: "action-worker-capability",
      task_ids: [taskId ?? "missing"],
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

  it("returns 401 for an invalid bearer credential", async () => {
    const { runtime, app } = await setup();
    runtime.config.auth_mode = "oauth";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system",
      headers: { authorization: "Bearer invalid-test-credential" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_bearer_credential" },
    });
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
    const capability = mintWorkerCapability(runtime.config.hf_token ?? "", {
      namespace: runtime.config.namespace,
      campaign_id: campaignId,
      action_id: launch.action_id,
      task_ids: ["control-smoke-task"],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const workerHeaders = {
      "idempotency-key": "worker-attempt-key",
      "x-harbor-hf-worker-capability": capability,
    };
    const payload = {
      action_id: launch.action_id,
      outcome: "complete",
      replacement_eligible: false,
      evidence_digest: `sha256:${"b".repeat(64)}`,
      evidence_path: `campaigns/${campaignId}/evidence/task-one`,
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
    store.close();
  });
});

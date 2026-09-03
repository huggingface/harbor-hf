import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const roots: string[] = [];
const runtimes: Runtime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(writeMode: "disabled" | "enabled" = "enabled"): Promise<{
  runtime: Runtime;
  app: Awaited<ReturnType<typeof buildApp>>;
}> {
  const root = await mkdtemp(join(tmpdir(), "harbor-hf-api-"));
  roots.push(root);
  const bucket = join(root, "bucket");
  const web = join(root, "web");
  await Promise.all([mkdir(bucket), mkdir(web)]);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Harbor-HF</title>");
  const config: AppConfig = {
    node_env: "test",
    port: 7860,
    namespace: "test",
    bucket_id: "test/artifacts",
    bucket_root: bucket,
    store_mode: "filesystem",
    projection_path: join(root, "projection.sqlite"),
    auth_path: join(root, "auth.sqlite"),
    presets_root: resolve("presets"),
    max_active_jobs: 16,
    parent_image: null,
    parent_hardware: "cpu-basic",
    parent_timeout_seconds: 86_400,
    web_root: web,
    auth_mode: "development",
    write_mode: "disabled",
    public_origin: "http://127.0.0.1:7860",
    oauth: null,
    hf_token: null,
    hf_inference_token: null,
    reconcile_interval_ms: 1_000,
    parent_restart_delay_ms: 0,
    source_revision: "test-revision",
    workbench_runner: "disabled",
    workbench_image: "python:3.12-slim",
    bootstrap_operator_subjects: [],
  };
  const runtime = await createRuntime(config);
  runtime.config.write_mode = writeMode;
  runtimes.push(runtime);
  const app = await buildApp(runtime);
  return { runtime, app };
}

const submission = {
  benchmark: { name: "terminal-bench-2-1", preset: "one-task-1-trial" },
  model: {
    id: "openai/gpt-oss-20b",
    provider: "together",
    reasoning_effort: "off",
  },
  harness: { agent: "pi", version: "0.84.2" },
  cost_ceiling_usd_per_trial: 0.25,
};

describe("control API", () => {
  it("allows the Hugging Face page to embed the console", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-frame-options"]).toBeUndefined();
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'self' https://huggingface.co",
    );
  });

  it("reports liveness before initialization and readiness after it", async () => {
    const { runtime, app } = await setup();
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(
      503,
    );
    await runtime.initialize();
    expect((await app.inject({ method: "GET", url: "/health/ready" })).json()).toEqual({
      status: "ready",
    });
  });

  it("submits an idempotent preset run and exposes its state", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "same-request" },
      payload: submission,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);
    expect(first.json().run.role).toBe("final");
    const runId = first.json().run.run_id as string;

    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "same-request" },
      payload: submission,
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().created).toBe(false);

    const list = await app.inject({ method: "GET", url: "/api/v1/runs" });
    expect(list.json().runs).toHaveLength(1);
    expect(list.json().runs[0].status).toBe("queued");
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().record.run_id).toBe(runId);
  });

  it("rejects an idempotency conflict and unknown input", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "conflict" },
      payload: submission,
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "conflict" },
      payload: { ...submission, cost_ceiling_usd_per_trial: 0.5 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("conflict");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "invalid" },
      payload: { ...submission, extra: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_request");

    const credential = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "credential" },
      payload: {
        ...submission,
        model: { ...submission.model, id: `hf_${"x".repeat(24)}` },
      },
    });
    expect(credential.statusCode).toBe(400);
    expect(credential.json().error.code).toBe("invalid_request");
  });

  it("pauses, resumes, and permanently cancels a run", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "actions" },
      payload: submission,
    });
    const runId = created.json().run.run_id as string;
    for (const action of ["pause", "resume", "cancel"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/runs/${runId}/${action}`,
      });
      expect(response.statusCode).toBe(200);
    }
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/resume`,
    });
    expect(rejected.statusCode).toBe(409);
  });

  it("keeps the leaderboard public and protects operator data", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    runtime.config.auth_mode = "oauth";
    const board = await app.inject({ method: "GET", url: "/api/v1/leaderboard" });
    expect(board.statusCode).toBe(200);
    expect(board.json()).toEqual({ rows: [] });
    const runs = await app.inject({ method: "GET", url: "/api/v1/runs" });
    expect(runs.statusCode).toBe(401);
    expect(runs.json().error.code).toBe("unauthorized");
  });

  it("blocks all API mutations while write mode is disabled", async () => {
    const { runtime, app } = await setup("disabled");
    await runtime.initialize();
    const submissionResponse = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "write-disabled" },
      payload: submission,
    });
    expect(submissionResponse.statusCode).toBe(503);
    expect(submissionResponse.json().error.code).toBe("write_disabled");
    expect(runtime.projection.listRuns()).toEqual([]);

    const actionResponse = await app.inject({
      method: "POST",
      url: "/api/v1/runs/run-0123456789abcdef01234567/pause",
    });
    expect(actionResponse.statusCode).toBe(503);
    expect(actionResponse.json().error.code).toBe("write_disabled");
  });

  it("rejects unsafe direct Harbor configuration", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs/config",
      headers: {
        "idempotency-key": "direct-unsafe",
        "x-harbor-hf-cost-ceiling-usd-per-trial": "0.25",
      },
      payload: {
        job_name: "caller-controlled",
        jobs_dir: "/tmp/outside",
        agents: [{ name: "pi", model_name: "openai/model:provider" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
  });
});

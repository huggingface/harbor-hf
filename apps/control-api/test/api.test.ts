import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
} from "@harbor-hf/control-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
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

const workbenchRecipe = structuredClone(fastAgentWorkbenchStarter);
const workbenchPreview = compileAgentWorkbenchRecipe(workbenchRecipe);
const workbenchSetup = {
  setup_test_id: "workbench-setup-0123456789abcdef01234567",
  recipe_digest: workbenchPreview.recipe_digest,
  revision_id: workbenchPreview.revision_id,
  status: "passed" as const,
  created_at: "2026-01-01T00:00:00.000Z",
  started_at: "2026-01-01T00:00:01.000Z",
  completed_at: "2026-01-01T00:00:02.000Z",
  exit_code: 0,
  error: null,
  files: [
    {
      file_id: "file-one",
      path: "ready.txt",
      root: "workspace" as const,
      size: 6,
      text: true,
    },
  ],
};

const submission = {
  benchmark: { name: "terminal-bench-2-1", preset: "one-task-1-trial" },
  model: {
    id: "openai/gpt-oss-20b",
    provider: "together",
    reasoning_effort: "off",
  },
  harness: { agent: "pi", version: "0.84.4" },
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

  it("returns only live Hugging Face providers for a model", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "Qwen/Qwen3.8-27B",
            inferenceProviderMapping: {
              deepinfra: { status: "live" },
              featherless: { status: "live" },
              unavailable: { status: "staging" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/model-providers?model=Qwen%2FQwen3.8-27B",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      model: "Qwen/Qwen3.8-27B",
      providers: ["deepinfra", "featherless"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://huggingface.co/api/models/Qwen/Qwen3.8-27B?expand%5B%5D=inferenceProviderMapping",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          "User-Agent": "harbor-hf-control/0.1",
        },
      }),
    );
  });

  it("reports a missing Hub model with a useful error", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Not Found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/model-providers?model=missing%2Fmodel",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "model_not_found",
        message: 'model "missing/model" was not found on the Hugging Face Hub',
      },
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
    expect(invalid.json().error.message).toContain("extra");

    const invalidProvider = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "invalid-provider" },
      payload: {
        ...submission,
        model: { ...submission.model, provider: "DeepInfra" },
      },
    });
    expect(invalidProvider.statusCode).toBe(400);
    expect(invalidProvider.json().error.message).toContain("model.provider");
    expect(invalidProvider.json().error.message).toContain(
      "lowercase letters, numbers, and hyphens",
    );

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

    for (const action of ["pause", "cancel"]) {
      const actionResponse = await app.inject({
        method: "POST",
        url: `/api/v1/runs/run-0123456789abcdef01234567/${action}`,
      });
      expect(actionResponse.statusCode).toBe(503);
      expect(actionResponse.json().error.code).toBe("write_disabled");
    }
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

  it("previews Workbench recipes while normal writes are disabled", async () => {
    const { runtime, app } = await setup("disabled");
    await runtime.initialize();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/preview",
      payload: workbenchRecipe,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      recipe_digest: workbenchPreview.recipe_digest,
      revision_id: workbenchPreview.revision_id,
      harbor_agent: {
        import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("harness_profile");
  });

  it("exposes an actor-scoped bounded setup lifecycle in local development", async () => {
    const { runtime, app } = await setup("disabled");
    await runtime.initialize();
    runtime.config.workbench_runner = "docker";
    vi.spyOn(runtime.workbench, "startSetup").mockResolvedValue(workbenchSetup);
    vi.spyOn(runtime.workbench, "listSetups").mockResolvedValue([workbenchSetup]);
    vi.spyOn(runtime.workbench, "getSetup").mockResolvedValue(workbenchSetup);
    vi.spyOn(runtime.workbench, "cancelSetup").mockResolvedValue({
      ...workbenchSetup,
      status: "cancelled",
    });
    vi.spyOn(runtime.workbench, "logs").mockResolvedValue({
      stdout: "ready\n",
      stderr: "",
    });
    vi.spyOn(runtime.workbench, "file").mockResolvedValue({
      content: "ready\n",
      truncated: false,
    });

    const started = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/setup-tests",
      headers: { "idempotency-key": "setup-local" },
      payload: { recipe: workbenchRecipe },
    });
    expect(started.statusCode).toBe(202);
    const setupId = workbenchSetup.setup_test_id;
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/workbench/setup-tests" }),
      app.inject({ method: "GET", url: `/api/v1/workbench/setup-tests/${setupId}` }),
      app.inject({
        method: "GET",
        url: `/api/v1/workbench/setup-tests/${setupId}/logs`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/workbench/setup-tests/${setupId}/files/file-one`,
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/workbench/setup-tests/${setupId}/cancel`,
      }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(responses[0]?.json().setups).toHaveLength(1);
    expect(responses[2]?.json().stdout).toBe("ready\n");
    expect(responses[3]?.json()).toEqual({ content: "ready\n", truncated: false });
    expect(runtime.workbench.startSetup).toHaveBeenCalledWith(
      workbenchRecipe,
      "development-operator",
      "setup-local",
    );
  });

  it("submits an attested Workbench recipe as one normal Harbor run", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const attestation = vi
      .spyOn(runtime.workbench, "attestPassedSetup")
      .mockResolvedValue({
        setup_test_id: workbenchSetup.setup_test_id,
        recipe_digest: workbenchSetup.recipe_digest,
        revision_id: workbenchSetup.revision_id,
        completed_at: workbenchSetup.completed_at ?? "",
        expires_at: "2026-01-01T01:00:02.000Z",
      });
    const payload = {
      benchmark: submission.benchmark,
      model: submission.model,
      cost_ceiling_usd_per_trial: 0.25,
      role: "diagnostic",
      workbench: {
        recipe: workbenchRecipe,
        setup_test_id: workbenchSetup.setup_test_id,
      },
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "workbench-run" },
      payload,
    });
    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "workbench-run" },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(repeated.statusCode).toBe(200);
    const record = first.json().run;
    expect(record.submission.harness).toEqual({
      agent: "command-agent",
      version: workbenchPreview.revision_id,
    });
    expect(record.harbor_job_config.agents).toHaveLength(1);
    expect(record.harbor_job_config.agents[0]).toMatchObject({
      import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
      model_name: "openai/openai/gpt-oss-20b:together",
    });
    expect(JSON.stringify(record)).not.toContain("harness_profile");
    expect(JSON.stringify(record)).not.toContain("promotion");
    expect(attestation).toHaveBeenCalledTimes(2);
  });

  it("does not create a Run when setup attestation is stale", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    vi.spyOn(runtime.workbench, "attestPassedSetup").mockRejectedValue(
      new Error("setup test has expired"),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "stale-workbench" },
      payload: {
        benchmark: submission.benchmark,
        model: submission.model,
        cost_ceiling_usd_per_trial: 0.25,
        role: "diagnostic",
        workbench: {
          recipe: workbenchRecipe,
          setup_test_id: workbenchSetup.setup_test_id,
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("setup test has expired");
    expect(runtime.projection.listRuns()).toEqual([]);
  });
});

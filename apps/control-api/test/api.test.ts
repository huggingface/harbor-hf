import { Ajv2020 } from "ajv/dist/2020.js";
import type { components } from "../../control-web/src/generated/api.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
  putJson,
} from "@harbor-hf/control-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { InvalidBearerCredentialError, OAuthCallbackError } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const roots: string[] = [];
const runtimes: Runtime[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(
  writeMode: "disabled" | "enabled" = "enabled",
  logging = false,
): Promise<{
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
    node_env: logging ? "development" : "test",
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
  it("validates actual single/list responses through generated OpenAPI component refs", async () => {
    const document = JSON.parse(
      await readFile(resolve("docs/control-api-v1.openapi.json"), "utf8"),
    );
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addFormat("date-time", (value: string) => Number.isFinite(Date.parse(value)));
    const single = ajv.compile({
      ...document.paths["/api/v1/runs/{run_id}"].get.responses["200"].content[
        "application/json"
      ].schema,
      components: document.components,
    });
    const list = ajv.compile({
      ...document.paths["/api/v1/runs"].get.responses["200"].content["application/json"]
        .schema,
      components: document.components,
    });
    const config = {
      agents: [{ name: "example", kwargs: { nested: { values: [true, 1, null] } } }],
      n_concurrent_trials: 2,
      environment: { type: "docker" },
    } satisfies components["schemas"]["RunRecord"]["harbor_job_config"];
    const { runtime, app } = await setup();
    await runtime.initialize();
    const submitted = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "response-schema" },
      payload: submission,
    });
    const record = { ...submitted.json().run, harbor_job_config: config };
    await putJson(runtime.store, `runs/${record.run_id}/run.json`, record);
    for (const status of [
      "queued",
      "running",
      "paused",
      "cancelled",
      "finished",
      "cost_stopped",
    ] as const) {
      const desired_state =
        status === "paused" || status === "cancelled" ? status : "run";
      const state = runtime.projection.run(record.run_id)?.state;
      await putJson(runtime.store, `runs/${record.run_id}/state.json`, {
        ...state,
        desired_state,
      });
      await putJson(runtime.store, `runs/${record.run_id}/job/result.json`, {
        finished_at: status === "finished" ? "2026-09-09T00:02:00Z" : null,
      });
      await putJson(runtime.store, `runs/${record.run_id}/job/task/result.json`, {
        agent_result: { cost_usd: status === "cost_stopped" ? 1 : 0 },
      });
      await runtime.projection.rebuild(
        runtime.store,
        status === "running"
          ? [
              {
                id: "parent-test",
                run_id: record.run_id,
                role: "parent",
                stage: "running",
                created_at: "2026-09-09T00:00:00Z",
                started_at: "2026-09-09T00:00:01Z",
                finished_at: null,
              },
            ]
          : [],
      );
      const archived = status !== "queued";
      const currentRevision =
        runtime.projection.run(record.run_id)?.presentation?.revision ?? 0;
      await runtime.service.setPresentation(
        record.run_id,
        archived,
        currentRevision,
        "fixture-subject",
      );
      const response = await app.inject({ url: `/api/v1/runs/${record.run_id}` });
      expect(response.statusCode).toBe(200);
      const view = response.json();
      expect(view.status).toBe(status);
      expect(view.presentation?.archived ?? false).toBe(archived);
      expect(view.presentation_available).toBe(true);
      expect(single({ ...view, presentation_available: "false" })).toBe(false);
      expect(single({ ...view, presentation: { archived: true } })).toBe(false);
      expect(single(view), JSON.stringify(single.errors)).toBe(true);
      expect(view.record.harbor_job_config).toEqual(config);
      expect(view.record).not.toHaveProperty("$defs");
      const overview = await app.inject({ url: "/api/v1/runs" });
      expect(overview.statusCode).toBe(200);
      expect(list(overview.json()), JSON.stringify(list.errors)).toBe(true);
      expect(single({ ...view, status: "invalid" })).toBe(false);
      expect(
        single({
          ...view,
          record: {
            ...view.record,
            submission: {
              ...view.record.submission,
              benchmark: { name: "INVALID", preset: "valid" },
            },
          },
        }),
      ).toBe(false);
      expect(
        single({ ...view, record: { ...view.record, harbor_job_config: [] } }),
      ).toBe(false);
    }
  });

  it("returns measured timing on authenticated run reads without remote reads or per-trial APIs", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const submitted = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "agent-time-summary" },
      payload: submission,
    });
    const id: string = submitted.json().run.run_id;
    await putJson(runtime.store, `runs/${id}/job/trial-one/result.json`, {
      trial_name: "trial-one",
      agent_execution: {
        started_at: "2026-09-09T00:00:00Z",
        finished_at: "2026-09-09T00:01:26Z",
        private: "do-not-echo",
      },
      config: { private: "do-not-echo" },
    });
    await runtime.projection.rebuild(runtime.store, []);
    const read = vi.spyOn(runtime.store, "read");
    const list = vi.spyOn(runtime.store, "list");
    for (const url of ["/api/v1/runs", `/api/v1/runs/${id}`]) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      const view = url.endsWith(id) ? response.json() : response.json().runs[0];
      expect(view.agent_timing).toEqual({
        duration_ms: 86000,
        complete_trials: 1,
        partial_trials: 0,
        unavailable_trials: 0,
      });
      expect(response.body).not.toContain("do-not-echo");
    }
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    runtime.config.auth_mode = "oauth";
    for (const url of ["/api/v1/runs", `/api/v1/runs/${id}`])
      expect((await app.inject({ url })).statusCode).toBe(401);
  });
  it("exposes authenticated native artifact observations without writing or changing completion", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const submitted = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "observed-progress" },
      payload: submission,
    });
    const id: string = submitted.json().run.run_id;
    await putJson(runtime.store, `runs/${id}/job/trial-one/config.json`, {
      trial_name: "trial-one",
      agent: { env: { PRIVATE_TEST_VALUE: "do-not-echo" } },
    });
    const response = await app.inject({ url: `/api/v1/runs/${id}/progress` });
    expect(response.statusCode).toBe(200);
    expect(response.json().trials[0].config).toEqual({ trial_name: "trial-one" });
    expect(response.json().trials[0].result).toBeNull();
    expect(response.body).not.toContain("do-not-echo");
    expect(runtime.projection.trials(id)).toEqual([]);
    runtime.config.auth_mode = "oauth";
    expect((await app.inject({ url: `/api/v1/runs/${id}/progress` })).statusCode).toBe(
      401,
    );
  });

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

  it("serves the HF hardware catalog and reports provider outages as 503", async () => {
    const { runtime, app } = await setup("disabled");
    await runtime.initialize();
    const hardware = [
      {
        name: "cpu-basic",
        prettyName: "CPU Basic",
        cpu: "2 vCPU",
        ram: "16 GB",
        ephemeralStorage: "50 GB",
        accelerator: null,
        unitCostUSD: 0.000167,
        unitLabel: "minute",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(hardware)),
    );
    const response = await app.inject({ url: "/api/v1/hardware" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(hardware);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    const unavailable = await app.inject({ url: "/api/v1/hardware" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe("hardware_unavailable");
  });

  it("returns native agent identity in trial lists and details", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "trial-identity" },
      payload: submission,
    });
    const runId = response.json().run.run_id;
    const trial = {
      run_id: runId,
      trial_name: "task__attempt",
      reward: 1,
      cost_usd: 0.1,
      status: "completed" as const,
      result: {
        config: {
          agent: {
            name: "openclaw",
            model_name: "openai/example/model:provider",
            kwargs: { version: "2026.7.1-2" },
          },
        },
        agent_info: { name: "openclaw", version: "2026.7.1-2" },
      },
    };
    const identity = { ...trial, result: { agent_info: trial.result.agent_info } };
    const readTrials = vi
      .spyOn(runtime.projection, "trials")
      .mockImplementation((_runId, result) =>
        result === "identity" ? [identity] : [trial],
      );
    const list = await app.inject({ url: `/api/v1/runs/${runId}/trials` });
    const detail = await app.inject({
      url: `/api/v1/runs/${runId}/trials/${trial.trial_name}`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().trials).toEqual([identity]);
    expect(readTrials).toHaveBeenCalledWith(runId, "identity");
    expect(detail.json()).toEqual(trial);
  });

  it("accepts a native Harbor trial concurrency override", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "custom-concurrency" },
      payload: { ...submission, n_concurrent_trials: 64 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().run.harbor_job_config.n_concurrent_trials).toBe(64);
    expect(response.json().run.submission).not.toHaveProperty("n_concurrent_trials");
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

    const invalidConcurrency = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "invalid-concurrency" },
      payload: { ...submission, n_concurrent_trials: 129 },
    });
    expect(invalidConcurrency.statusCode).toBe(400);
    expect(invalidConcurrency.json().error.message).toContain("n_concurrent_trials");

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

  it.each([undefined, "hf.example-org/runtime-model:together"])(
    "submits an attested Workbench recipe with native model override %s",
    async (model_name) => {
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
          ...(model_name === undefined ? {} : { harbor_agent: { model_name } }),
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
      expect(record.workbench_recipe).toEqual({ name: workbenchRecipe.name });
      expect(repeated.json().run.workbench_recipe).toEqual(record.workbench_recipe);
      expect(record.submission.harness).toEqual({
        agent: "command-agent",
        version: workbenchPreview.revision_id,
      });
      expect(record.harbor_job_config.agents).toHaveLength(1);
      expect(record.harbor_job_config.agents[0]).toMatchObject({
        import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
        model_name: model_name ?? "openai/openai/gpt-oss-20b:together",
      });
      expect(record.submission.model).toEqual(submission.model);
      expect(JSON.stringify(record)).not.toContain("harness_profile");
      expect(JSON.stringify(record)).not.toContain("promotion");
      expect(attestation).toHaveBeenCalledTimes(2);
      const changed = await app.inject({
        method: "POST",
        url: "/api/v1/runs",
        headers: { "idempotency-key": "workbench-run" },
        payload: {
          ...payload,
          workbench: {
            ...payload.workbench,
            recipe: { ...workbenchRecipe, name: "renamed-recipe" },
          },
        },
      });
      expect(changed.statusCode).toBe(409);
      expect(runtime.projection.listRuns()).toHaveLength(1);
      expect(runtime.projection.listRuns()[0]?.record.workbench_recipe).toEqual({
        name: workbenchRecipe.name,
      });
    },
  );

  it.each([
    { workbench_recipe: { name: "spoofed" } },
    { workbench_recipe_name: "spoofed" },
  ])("rejects independently supplied display provenance: %j", async (extra) => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const attestation = vi.spyOn(runtime.workbench, "attestPassedSetup");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "spoofed-provenance" },
      payload: {
        benchmark: submission.benchmark,
        model: submission.model,
        cost_ceiling_usd_per_trial: 0.25,
        workbench: {
          recipe: workbenchRecipe,
          setup_test_id: workbenchSetup.setup_test_id,
        },
        ...extra,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(attestation).not.toHaveBeenCalled();
    expect(runtime.projection.listRuns()).toEqual([]);
  });

  it.each([
    { model_name: "model", env: { OPENAI_API_KEY: "fixture" } },
    { model_name: "model", import_path: "other.module:Agent" },
    { model_name: "" },
    { model_name: 42 },
  ])(
    "rejects unsupported native agent overrides before attestation",
    async (harbor_agent) => {
      const { runtime, app } = await setup();
      await runtime.initialize();
      const attestation = vi.spyOn(runtime.workbench, "attestPassedSetup");
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/runs",
        headers: { "idempotency-key": "invalid-native-agent" },
        payload: {
          benchmark: submission.benchmark,
          model: submission.model,
          cost_ceiling_usd_per_trial: 0.25,
          role: "diagnostic",
          workbench: {
            recipe: workbenchRecipe,
            setup_test_id: workbenchSetup.setup_test_id,
            harbor_agent,
          },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(attestation).not.toHaveBeenCalled();
      expect(runtime.projection.listRuns()).toEqual([]);
    },
  );

  it.each([8, 10, 12, 16, 128, 0, 129, 1.5, "12"])(
    "uses shared concurrency admission for Workbench: %s",
    async (n_concurrent_trials) => {
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
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/runs",
        headers: { "idempotency-key": "workbench-concurrency" },
        payload: {
          benchmark: submission.benchmark,
          model: submission.model,
          n_concurrent_trials,
          cost_ceiling_usd_per_trial: 0.25,
          role: "diagnostic",
          workbench: {
            recipe: workbenchRecipe,
            setup_test_id: workbenchSetup.setup_test_id,
          },
        },
      });
      if (
        typeof n_concurrent_trials === "number" &&
        Number.isInteger(n_concurrent_trials) &&
        n_concurrent_trials >= 1 &&
        n_concurrent_trials <= 128
      ) {
        expect(response.statusCode).toBe(201);
        expect(response.json().run.harbor_job_config.n_concurrent_trials).toBe(
          n_concurrent_trials,
        );
        expect(response.json().run.submission).not.toHaveProperty(
          "n_concurrent_trials",
        );
        expect(attestation).toHaveBeenCalledOnce();
      } else {
        expect(response.statusCode).toBe(400);
        expect(attestation).not.toHaveBeenCalled();
        expect(runtime.projection.listRuns()).toEqual([]);
      }
    },
  );

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

describe("authentication response and log safety", () => {
  function captureLogs() {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    return lines;
  }

  it.each(["anonymous", "expired", "invalid-bearer"])(
    "sends exactly one response for an %s session",
    async (kind) => {
      const logs = captureLogs();
      const { runtime, app } = await setup("disabled", true);
      runtime.config.auth_mode = "oauth";
      vi.spyOn(runtime.auth, "sessionActor").mockResolvedValue(null);
      vi.spyOn(runtime.auth, "bearerActor").mockRejectedValue(
        new InvalidBearerCredentialError(),
      );
      const response = await app.inject({
        url: "/api/v1/session",
        cookies: kind === "expired" ? { hhf_session: "fixture-only" } : {},
        headers:
          kind === "invalid-bearer" ? { authorization: "Bearer fixture-only" } : {},
      });
      await app.close();
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
      expect(logs.join("")).not.toMatch(
        /FST_ERR_REP_ALREADY_SENT|Reply was already sent/,
      );
      expect(logs.join("").match(/request completed/g)).toHaveLength(1);
    },
  );

  it.each([
    ["flow", false, 400],
    ["token_exchange", false, 400],
    ["user_info", false, 500],
    ["authorization", true, 403],
    ["authorization", false, 500],
    ["configuration", false, 500],
    ["session", false, 500],
  ] as const)(
    "safely reports %s callback failures (denied=%s)",
    async (stage, denied, status) => {
      const logs = captureLogs();
      const { runtime, app } = await setup("disabled", true);
      vi.spyOn(runtime.auth, "callback").mockRejectedValue(
        new OAuthCallbackError(stage, denied),
      );
      const response = await app.inject({
        url: "/auth/callback?code=private-code-marker&state=private-state-marker",
        cookies: { hhf_oauth_flow: "private-cookie-marker" },
        headers: { authorization: "Bearer private-header-marker" },
      });
      await app.close();
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({
        error: { code: denied ? "access_denied" : "oauth_failed" },
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
      const output = logs.join("");
      expect(output).toContain(`"oauth_stage":"${stage}"`);
      expect(output).toContain('"url":"/auth/callback"');
      expect(output).not.toContain("private-");
      const diagnostic = logs
        .map((line) => JSON.parse(line))
        .find((line) => line.msg === "OAuth callback failed");
      expect(diagnostic.reqId).toEqual(expect.any(String));
    },
  );

  it("preserves successful callback cookies, redirect, and authenticated sessions", async () => {
    const { runtime, app } = await setup();
    vi.spyOn(runtime.auth, "callback").mockResolvedValue({
      session_id: "fixture-session",
      csrf: "fixture-csrf",
      expires_at: Date.now() + 60_000,
      return_to: "/runs",
    });
    const response = await app.inject({
      url: "/auth/callback?code=fixture-code",
      cookies: { hhf_oauth_flow: "fixture-flow" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/runs");
    expect(response.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "hhf_oauth_flow",
          value: "",
          path: "/auth/callback",
        }),
        expect.objectContaining({
          name: "hhf_session",
          value: "fixture-session",
          httpOnly: true,
          secure: true,
          sameSite: "None",
          partitioned: true,
        }),
        expect.objectContaining({
          name: "hhf_csrf",
          value: "fixture-csrf",
          secure: true,
          sameSite: "None",
          partitioned: true,
        }),
      ]),
    );
    const session = await app.inject({ url: "/api/v1/session" });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      authenticated: true,
      actor: { role: "operator" },
    });
    await app.close();
  });

  it("reports a missing flow cookie without invoking the provider", async () => {
    const { runtime, app } = await setup();
    const callback = vi.spyOn(runtime.auth, "callback");
    const response = await app.inject({ url: "/auth/callback" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "oauth_failed" } });
    expect(callback).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("configurable launch", () => {
  const input = {
    datasets: [{ name: "example/dataset", ref: `sha256:${"a".repeat(64)}` }],
    agents: [
      {
        name: "openclaw",
        model_name: "openai/example/model:provider",
        kwargs: { version: "2026.7.1-2" },
      },
      {
        name: "openclaw",
        model_name: "openai/example/model:provider",
        kwargs: { version: "2026.7.2" },
      },
    ],
  };
  const validation = {
    harbor_revision: "dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e",
    tasks: 3,
    agents: 2,
    trials: 6,
    warnings: [],
    not_performed: ["Model inference"],
    effective_config: input,
    fingerprint: "checked",
    credentials_available: true,
  };
  it("validates while writes are disabled without creating a run", async () => {
    const { runtime, app } = await setup("disabled");
    await runtime.initialize();
    const inspect = vi.spyOn(runtime.launch, "validate").mockResolvedValue(validation);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs/validate",
      payload: input,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().trials).toBe(6);
    expect(inspect).toHaveBeenCalledWith(input);
    expect(runtime.projection.listRuns()).toEqual([]);
    const launch = await app.inject({
      method: "POST",
      url: "/api/v1/runs/config",
      payload: input,
      headers: {
        "idempotency-key": "disabled",
        "x-harbor-hf-cost-ceiling-usd-per-trial": "1",
      },
    });
    expect(launch.statusCode).toBe(503);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it("revalidates launch, preserves multiple agents, and remains idempotent", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const inspect = vi.spyOn(runtime.launch, "validate").mockResolvedValue(validation);
    const request = {
      method: "POST" as const,
      url: "/api/v1/runs/config",
      payload: input,
      headers: {
        "idempotency-key": "multi-agent",
        "x-harbor-hf-cost-ceiling-usd-per-trial": "1",
        "x-harbor-hf-validation": "checked",
      },
    };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(first.json().run.harbor_job_config.agents).toHaveLength(2);
    expect(first.json().run.submission).not.toHaveProperty("model");
    const second = await app.inject(request);
    expect(second.statusCode).toBe(200);
    expect(second.json().run.run_id).toBe(first.json().run.run_id);
    expect(inspect).toHaveBeenCalledTimes(2);
  });
  it("rejects changed admission and unavailable credentials without creating a run", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const inspect = vi.spyOn(runtime.launch, "validate").mockResolvedValue(validation);
    const request = {
      method: "POST" as const,
      url: "/api/v1/runs/config",
      payload: input,
      headers: {
        "idempotency-key": "changed",
        "x-harbor-hf-cost-ceiling-usd-per-trial": "1",
        "x-harbor-hf-validation": "stale",
      },
    };
    expect((await app.inject(request)).statusCode).toBe(409);
    inspect.mockResolvedValue({ ...validation, credentials_available: false });
    expect((await app.inject(request)).statusCode).toBe(503);
    expect(runtime.projection.listRuns()).toEqual([]);
  });
});

describe("archive API", () => {
  it("uses projected GET/list responses, revision validation and shared operator writes", async () => {
    const { runtime, app } = await setup();
    const { run } = await runtime.service.submitPreset(
      submission,
      "archive-api",
      "fixture-subject",
    );
    const url = `/api/v1/runs/${run.run_id}/presentation`;
    const patch = (payload: object) => app.inject({ method: "PATCH", url, payload });
    const initialNoOp = await patch({ archived: false, expected_revision: 0 });
    expect(initialNoOp.statusCode).toBe(200);
    expect(initialNoOp.json()).toBeNull();
    expect(
      (await patch({ archived: true, expected_revision: 0 })).json(),
    ).toMatchObject({ archived: true, revision: 1 });
    expect((await patch({ archived: true, expected_revision: 0 })).statusCode).toBe(
      409,
    );
    for (const payload of [
      { archived: "true", expected_revision: 1 },
      { archived: false, expected_revision: -1 },
      { archived: false, expected_revision: 1.5 },
      { archived: false },
      { archived: true, expected_revision: 1, actor: "forged" },
    ])
      expect((await patch(payload)).statusCode).toBe(400);
    const read = vi.spyOn(runtime.store, "read");
    const list = vi.spyOn(runtime.store, "list");
    expect(
      (await app.inject(`/api/v1/runs/${run.run_id}`)).json().presentation.archived,
    ).toBe(true);
    expect(
      (await app.inject("/api/v1/runs")).json().runs[0].presentation.archived,
    ).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    runtime.config.write_mode = "disabled";
    expect(
      (await patch({ archived: false, expected_revision: 1 })).json().error.code,
    ).toBe("write_disabled");
    vi.spyOn(runtime.auth, "developmentActor").mockReturnValue({
      subject: "fixture-reader",
      username: "fixture-reader",
      role: "reader",
      transport: "development",
    });
    expect((await patch({ archived: false, expected_revision: 1 })).statusCode).toBe(
      403,
    );
    expect((await app.inject(`/api/v1/runs/${run.run_id}`)).statusCode).toBe(200);
    await app.close();
  });

  it("requires session CSRF and returns safe uncertain-write errors", async () => {
    const { runtime, app } = await setup();
    const { run } = await runtime.service.submitPreset(
      submission,
      "archive-csrf",
      "fixture-subject",
    );
    runtime.config.auth_mode = "oauth";
    const session = runtime.auth.store.createSession(
      "fixture-subject",
      "fixture-user",
      3600,
    );
    vi.spyOn(runtime.auth, "role").mockResolvedValue("operator");
    const url = `/api/v1/runs/${run.run_id}/presentation`;
    const payload = { archived: true, expected_revision: 0 };
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          payload,
          cookies: { hhf_session: session.id },
        })
      ).json().error.code,
    ).toBe("csrf_rejected");
    const request = {
      method: "PATCH" as const,
      url,
      payload,
      cookies: { hhf_session: session.id },
      headers: { "x-csrf-token": session.csrf },
    };
    vi.spyOn(runtime.projection, "updatePresentation").mockImplementationOnce(() => {
      throw new Error("private-fixture-marker");
    });
    const failure = await app.inject(request);
    expect(failure.statusCode).toBe(503);
    expect(failure.json().error.code).toBe("presentation_update_failed");
    expect(failure.body).not.toContain("private-fixture-marker");
    const getView = () =>
      app.inject({
        ...request,
        method: "GET",
        url: `/api/v1/runs/${run.run_id}`,
        payload: undefined,
      });
    expect((await getView()).json()).toMatchObject({
      presentation: null,
      presentation_available: false,
    });
    expect((await app.inject(request)).statusCode).toBe(409);
    expect((await getView()).json()).toMatchObject({
      presentation: { revision: 1 },
      presentation_available: true,
    });
    expect(
      (
        await app.inject({
          ...request,
          payload: { archived: false, expected_revision: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          ...request,
          method: "GET",
          url: `/api/v1/runs/${run.run_id}`,
          payload: undefined,
        })
      ).json().presentation.revision,
    ).toBe(2);

    await app.close();
  });
  it("returns fresh unavailable flags in SQL-only list/detail and rejects malformed writes without loss", async () => {
    const { runtime, app } = await setup();
    const { run } = await runtime.service.submitPreset(
      submission,
      "archive-invalid",
      "fixture-subject",
    );
    const path = `runs/${run.run_id}/presentation.json`;
    await putJson(runtime.store, path, {});
    await runtime.service.refresh();
    const read = vi.spyOn(runtime.store, "read");
    const list = vi.spyOn(runtime.store, "list");
    expect((await app.inject(`/api/v1/runs/${run.run_id}`)).json()).toMatchObject({
      presentation: null,
      presentation_available: false,
    });
    expect((await app.inject("/api/v1/runs")).json().runs[0]).toMatchObject({
      presentation: null,
      presentation_available: false,
    });
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    const put = vi.spyOn(runtime.store, "put");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/runs/${run.run_id}/presentation`,
      payload: { archived: true, expected_revision: 0 },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("presentation_update_failed");
    expect(put).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("launch pricing API boundary", () => {
  const pricing = {
    currency: "USD",
    input_usd_per_million: 2,
    cached_usd_per_million: 0.5,
    output_usd_per_million: 8,
  };
  const payload = {
    benchmark: { ...submission.benchmark, preset: "all-tasks-5-trials" },
    model: submission.model,
    cost_ceiling_usd_per_trial: 100,
    role: "final",
    pricing,
    workbench: { recipe: workbenchRecipe, setup_test_id: workbenchSetup.setup_test_id },
  };
  it("validates actual priced single/list/leaderboard responses and immutable conflicts", async () => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const attest = vi.spyOn(runtime.workbench, "attestPassedSetup").mockResolvedValue({
      setup_test_id: workbenchSetup.setup_test_id,
      recipe_digest: workbenchSetup.recipe_digest,
      revision_id: workbenchSetup.revision_id,
      completed_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-01T01:00:00Z",
    });
    const post = (body: unknown) =>
      app.inject({
        method: "POST",
        url: "/api/v1/runs",
        headers: { "idempotency-key": "launch-rates" },
        payload: body as Record<string, unknown>,
      });
    const first = await post(payload);
    expect(first.statusCode).toBe(201);
    expect((await post(payload)).statusCode).toBe(200);
    expect(
      (await post({ ...payload, pricing: { ...pricing, input_usd_per_million: 3 } }))
        .statusCode,
    ).toBe(409);
    expect(
      attest.mock.calls.every(
        (call) => JSON.stringify(call[2]) === JSON.stringify(workbenchRecipe),
      ),
    ).toBe(true);
    const record = first.json().run;
    expect(record.pricing).toEqual(pricing);
    expect(record.submission.model).not.toHaveProperty("pricing");
    expect(record.harbor_job_config).not.toHaveProperty("pricing");
    await putJson(runtime.store, `runs/${record.run_id}/job/result.json`, {
      finished_at: "2026-01-01T00:01:00Z",
      n_total_trials: 1,
      stats: {
        n_input_tokens: 1_000_000,
        n_output_tokens: 100_000,
        n_cache_tokens: 250_000,
        cost_usd: 77,
      },
    });
    await putJson(runtime.store, `runs/${record.run_id}/job/task/result.json`, {
      agent_result: { cost_usd: 77 },
      verifier_result: { rewards: { reward: 1 } },
      exception_info: null,
    });
    await runtime.service.refresh();
    const document = JSON.parse(
      await readFile(resolve("docs/control-api-v1.openapi.json"), "utf8"),
    );
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addFormat("date-time", (value: string) => Number.isFinite(Date.parse(value)));
    for (const [path, url] of [
      ["/api/v1/runs/{run_id}", `/api/v1/runs/${record.run_id}`],
      ["/api/v1/runs", "/api/v1/runs"],
      ["/api/v1/leaderboard", "/api/v1/leaderboard"],
    ]) {
      const validate = ajv.compile({
        ...document.paths[path!].get.responses["200"].content["application/json"]
          .schema,
        components: document.components,
      });
      const response = await app.inject({ url: url! });
      expect(response.statusCode).toBe(200);
      expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(runtime.projection.run(record.run_id)?.shared_estimate?.cost_usd).toBe(
      2.425,
    );
    expect(
      (await app.inject({ url: "/api/v1/leaderboard" })).json().rows[0],
    ).toMatchObject({
      cost_usd: 77,
      shared_estimate: { cost_usd: 2.425, estimated_runs: 1, total_runs: 1 },
    });
  });
  it.each([
    null,
    {},
    { ...pricing, currency: "EUR" },
    { ...pricing, cached_usd_per_million: -1 },
    { ...pricing, unexpected: 1 },
  ])("rejects tampered launch pricing before setup: %j", async (value) => {
    const { runtime, app } = await setup();
    await runtime.initialize();
    const attest = vi.spyOn(runtime.workbench, "attestPassedSetup");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "idempotency-key": "bad-rates" },
      payload: { ...payload, pricing: value },
    });
    expect(response.statusCode).toBe(400);
    expect(attest).not.toHaveBeenCalled();
    expect(runtime.projection.listRuns()).toEqual([]);
  });
  it("does not bypass authentication or disabled writes", async () => {
    const { runtime, app } = await setup("disabled");
    await runtime.initialize();
    const request = {
      method: "POST" as const,
      url: "/api/v1/runs",
      headers: { "idempotency-key": "protected-rates" },
      payload,
    };
    expect((await app.inject(request)).statusCode).toBe(503);
    const actor = vi.spyOn(runtime.auth, "developmentActor").mockReturnValue({
      subject: "synthetic-reader",
      username: "synthetic-reader",
      role: "reader",
      transport: "development",
    });
    expect((await app.inject(request)).statusCode).toBe(403);
    actor.mockRestore();
    runtime.config.auth_mode = "oauth";
    expect((await app.inject(request)).statusCode).toBe(401);
    expect(runtime.projection.listRuns()).toEqual([]);
  });
});

it("audits pricing through operator/CSRF/write gates with generated contracts and safe conflicts", async () => {
  const { runtime, app } = await setup();
  const { run } = await runtime.service.submitPreset(
    submission,
    "correction-api",
    "fixture-subject",
  );
  const url = `/api/v1/runs/${run.run_id}/pricing-corrections`;
  const payload = {
    expected_revision: 0,
    reason: "Correct swapped rates",
    pricing: {
      currency: "USD",
      input_usd_per_million: 2,
      output_usd_per_million: 8,
      cached_usd_per_million: 0.5,
    },
  };
  const patch = (body: unknown = payload) =>
    app.inject({ method: "PATCH", url, payload: body as object });
  expect((await patch({ ...payload, actor: "forged" })).statusCode).toBe(400);
  runtime.config.write_mode = "disabled";
  expect((await patch()).json().error.code).toBe("write_disabled");
  runtime.config.write_mode = "enabled";
  const actor = vi.spyOn(runtime.auth, "developmentActor").mockReturnValue({
    subject: "fixture-reader",
    username: "fixture-reader",
    role: "reader",
    transport: "development",
  });
  expect((await patch()).statusCode).toBe(403);
  actor.mockRestore();
  runtime.config.auth_mode = "oauth";
  const session = runtime.auth.store.createSession(
    "fixture-subject",
    "fixture-user",
    3600,
  );
  vi.spyOn(runtime.auth, "role").mockResolvedValue("operator");
  const req = {
    method: "PATCH" as const,
    url,
    payload,
    cookies: { hhf_session: session.id },
  };
  expect((await app.inject(req)).json().error.code).toBe("csrf_rejected");
  const authenticated = { ...req, headers: { "x-csrf-token": session.csrf } };
  const saved = await app.inject(authenticated);
  expect(saved.statusCode).toBe(200);
  expect(saved.json().revisions[0]).toMatchObject({
    actor: "fixture-subject",
    revision: 1,
    pricing: payload.pricing,
  });
  expect((await app.inject(authenticated)).json().error.code).toBe("pricing_conflict");
  const get = await app.inject({
    ...authenticated,
    method: "GET",
    payload: undefined,
    url: `/api/v1/runs/${run.run_id}`,
  });
  expect(get.json()).toMatchObject({
    pricing_corrections_available: true,
    pricing_corrections: saved.json(),
  });
  expect(get.json().record).not.toHaveProperty("pricing");
  vi.spyOn(runtime.projection.pricing, "update").mockImplementationOnce(() => {
    throw new Error("private-provider-error");
  });
  const failure = await app.inject({
    ...authenticated,
    payload: { ...payload, expected_revision: 1 },
  });
  expect(failure.statusCode).toBe(503);
  expect(failure.body).not.toContain("private-provider-error");
  await app.close();
});

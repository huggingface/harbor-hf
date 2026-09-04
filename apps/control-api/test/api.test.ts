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

const workbenchPreview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);

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

  it("previews Workbench recipes while normal writes are disabled", async () => {
    const { runtime, app } = await setup("disabled");
    await runtime.initialize();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/preview",
      payload: fastAgentWorkbenchStarter,
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
});

describe("execution-disabled boundary", () => {
  it.each(["enabled", "disabled"] as const)(
    "rejects direct execution APIs with writes %s before any side effect",
    async (mode) => {
      const { runtime, app } = await setup(mode);
      expect(await runtime.auth.role("unlisted-subject")).toBeNull();
      const create = vi.spyOn(runtime.store, "create");
      const put = vi.spyOn(runtime.store, "put");
      const start = vi.spyOn(runtime.service.jobs, "startParent");
      const cancel = vi.spyOn(runtime.service.jobs, "cancel");
      const setupJob = vi.spyOn(runtime.workbench, "startSetup");
      for (const url of [
        "/api/v1/runs",
        "/api/v1/runs/config",
        "/api/v1/runs/run-0123456789abcdef01234567/resume",
        "/api/v1/runs/run-0123456789abcdef01234567/pause",
        "/api/v1/runs/run-0123456789abcdef01234567/cancel",
        "/api/v1/workbench/setup-tests",
        "/api/v1/workbench/setup-tests/test/cancel",
      ]) {
        const response = await app.inject({ method: "POST", url, payload: {} });
        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe("execution_disabled");
      }
      for (const spy of [create, put, start, cancel, setupJob])
        expect(spy).not.toHaveBeenCalled();
      const system = await app.inject({ url: "/api/v1/system" });
      expect(system.json().workbench.setup_enabled).toBe(false);
      runtime.start();
      expect(start).not.toHaveBeenCalled();
      await app.close();
    },
  );
  it("saves and reloads immutable native authoring data without creating a Run", async () => {
    const { runtime, app } = await setup();
    const input = {
      name: "example-harness",
      harbor_job_config: { agents: [{ name: "terminus-2", kwargs: {} }] },
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/configurations",
      payload: input,
    });
    expect(first.statusCode).toBe(200);
    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/configurations",
      payload: input,
    });
    expect(repeated.json()).toEqual(first.json());
    const list = await app.inject({ url: "/api/v1/workbench/configurations" });
    expect(list.json().items).toEqual([first.json()]);
    expect(await runtime.store.list("runs/")).toEqual([]);
    await app.close();
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PersonalHuggingFace } from "@harbor-hf/hf-adapters";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
} from "@harbor-hf/control-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthenticationService } from "../src/auth.js";
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

describe("personal execution wiring", () => {
  const headers = { "x-hf-user-token": "hf_testusercredential" };
  const runId = "run-0123456789abcdef01234567";
  function identity() {
    vi.spyOn(PersonalHuggingFace.prototype, "identity").mockResolvedValue({
      id: "development-operator",
      name: "example-user",
    });
  }
  async function approve(runtime: Runtime) {
    const submission = {
      benchmark: { name: "terminal-bench-2-1", preset: "two-task-canary" },
      harness: { agent: "terminus-2", version: "2.0.0" },
      model: { id: "example/model", provider: "example", reasoning_effort: "default" },
      cost_ceiling_usd_per_trial: 1,
    };
    const config = runtime.presets.buildJobConfig(runId, submission, "/data");
    const file = join(runtime.config.bucket_root, "approval.json");
    await writeFile(
      file,
      JSON.stringify({
        run_id: runId,
        owner: "example-user",
        results_bucket: "private-results",
        submission,
        image: `example/runner@sha256:${"a".repeat(64)}`,
        hardware: "cpu-basic",
        runtime_seconds: 60,
        job_timeout_seconds: 300,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        total_budget_usd: 3,
        inference_limit_usd: 2,
        native_config_sha256: createHash("sha256")
          .update(JSON.stringify(config))
          .digest("hex"),
        credential_source: "supplied-user-token",
        credential_destinations:
          "control-request,hf-job-secret,harbor,sandbox,agent,hf-inference,hf-bucket",
        deployment_scope: "dedicated-user-owned-hf-job",
        cleanup: "selected-parent-only;children-best-effort",
        limits_reviewed: true,
      }),
    );
    runtime.config.personal_approval_file = file;
  }
  const launchPayload = {
    run_id: runId,
    approval_sha256: "0".repeat(64),
    confirm: true,
    accept_best_effort_cleanup_and_external_cost_limits: true,
  };
  async function acceptedPayload(app: Awaited<ReturnType<typeof buildApp>>) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/personal/approval",
      headers,
    });
    expect(response.statusCode).toBe(200);
    return {
      ...launchPayload,
      approval_sha256: response.json().approval.approval_sha256,
    };
  }

  it("does not fall back to control credentials", async () => {
    const { app } = await setup();
    const spy = vi.spyOn(PersonalHuggingFace.prototype, "identity");
    const response = await app.inject({ method: "POST", url: "/api/v1/personal/jobs" });
    expect(response.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("saves both central starters as native Workbench versions", async () => {
    const { app } = await setup("disabled");
    const starters = (await app.inject({ url: "/api/v1/workbench/starters" })).json()
      .items;
    expect(starters.map((item: { name: string }) => item.name)).toEqual([
      "fast-agent-0.10.19",
      "fx-0.0.6",
    ]);
    expect(JSON.stringify(starters[0])).toContain("fast-agent-mcp==0.10.19");
    for (const starter of starters) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/workbench/configurations",
        payload: { name: starter.name, harbor_job_config: starter.harbor_job_config },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
  });

  it("requires matching setup evidence before a saved version can launch a benchmark", async () => {
    const { runtime, app } = await setup("disabled");
    identity();
    const saved = (
      await app.inject({
        method: "POST",
        url: "/api/v1/workbench/configurations",
        payload: {
          name: "saved-pi",
          harbor_job_config: { agents: [{ name: "pi", kwargs: { thinking: "off" } }] },
        },
      })
    ).json();
    await approve(runtime);
    const file = runtime.config.personal_approval_file ?? "";
    const approval = JSON.parse(await readFile(file, "utf8"));
    approval.submission.harness = { agent: "workbench", version: saved.revision };
    approval.submission.model.reasoning_effort = "saved";
    approval.mode = "setup";
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/personal/preview",
      payload: { run_id: runId, submission: approval.submission, mode: "setup" },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().config.install_only).toBe(true);
    approval.native_config_sha256 = preview.json().native_config_sha256;
    await writeFile(file, JSON.stringify(approval));
    vi.spyOn(PersonalHuggingFace.prototype, "launch").mockResolvedValue({
      id: "example-setup",
      run_id: runId,
      url: "https://huggingface.co/jobs/example-user/example-setup",
      sandbox_cleanup: "unverified",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/personal/launch",
          headers,
          payload: await acceptedPayload(app),
        })
      ).statusCode,
    ).toBe(200);
    const setupRunId = runId;
    approval.mode = "benchmark";
    approval.run_id = "run-aaaaaaaaaaaaaaaaaaaaaaaa";
    approval.setup_test_run_id = setupRunId;
    approval.native_config_sha256 = (
      await app.inject({
        method: "POST",
        url: "/api/v1/personal/preview",
        payload: { run_id: approval.run_id, submission: approval.submission },
      })
    ).json().native_config_sha256;
    await writeFile(file, JSON.stringify(approval));
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/personal/approval", headers }))
        .statusCode,
    ).toBe(400);
    vi.spyOn(PersonalHuggingFace.prototype, "job").mockResolvedValue({
      id: "example-setup",
      stage: "STOPPED",
    });
    vi.spyOn(PersonalHuggingFace.prototype, "artifact").mockResolvedValue({
      text: JSON.stringify({
        finished_at: "2026-01-01T00:00:00Z",
        n_total_trials: 2,
        stats: {
          n_completed_trials: 2,
          n_errored_trials: 0,
          n_running_trials: 0,
          n_pending_trials: 0,
          n_cancelled_trials: 0,
        },
      }),
    });
    const checked = await app.inject({
      method: "POST",
      url: "/api/v1/personal/setup-result",
      headers,
      payload: { run_id: setupRunId },
    });
    expect(checked.json().status).toBe("passed");
    const approved = await app.inject({
      method: "POST",
      url: "/api/v1/personal/approval",
      headers,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/personal/launch",
          headers,
          payload: {
            ...launchPayload,
            run_id: approval.run_id,
            approval_sha256: approved.json().approval.approval_sha256,
          },
        })
      ).statusCode,
    ).toBe(200);
    approval.image = `example/runner@sha256:${"b".repeat(64)}`;
    await writeFile(file, JSON.stringify(approval));
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/personal/approval", headers }))
        .statusCode,
    ).toBe(400);
  });

  it("previews for ordinary users without token verification or side effects", async () => {
    const { runtime, app } = await setup("disabled");
    vi.spyOn(runtime.auth, "developmentActor").mockReturnValue({
      subject: "ordinary-subject",
      username: "example-user",
      role: "reader",
      transport: "development",
    });
    const identity = vi.spyOn(PersonalHuggingFace.prototype, "identity");
    const create = vi.spyOn(runtime.store, "create");
    const credentialRead = vi.fn(() => {
      throw new Error("Credential access forbidden");
    });
    Object.defineProperty(runtime.config, "hf_token", { get: credentialRead });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/personal/preview",
      payload: {
        run_id: runId,
        submission: {
          benchmark: { name: "terminal-bench-2-1", preset: "two-task-canary" },
          harness: { agent: "pi", version: "0.84.4" },
          model: { id: "example/model", provider: "example", reasoning_effort: "off" },
          cost_ceiling_usd_per_trial: 1,
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().config.n_attempts).toBe(1);
    expect(response.json().native_config_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(identity).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(credentialRead).not.toHaveBeenCalled();
  });

  it("allows owner-scoped Workbench authoring without enabling execution writes", async () => {
    const { runtime, app } = await setup("disabled");
    const actor = vi.spyOn(runtime.auth, "developmentActor").mockReturnValue({
      subject: "ordinary-subject",
      username: "example-user",
      role: "reader",
      transport: "development",
    });
    const input = {
      name: "my-harness",
      harbor_job_config: { agents: [{ name: "pi" }] },
    };
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/configurations",
      payload: input,
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/workbench/configurations" })).json().items,
    ).toEqual([saved.json()]);
    actor.mockReturnValue({
      subject: "different-subject",
      username: "another-user",
      role: "operator",
      transport: "development",
    });
    const other = await app.inject({ url: "/api/v1/workbench/configurations" });
    expect(other.json().items).toEqual([]);
    expect(other.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/workbench/configurations",
          payload: { ...input, owner: "ordinary-subject" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/workbench/setup-tests",
          payload: {},
        })
      ).statusCode,
    ).toBe(503);
    expect(await runtime.store.list("runs/")).toEqual([]);
    expect(runtime.config.write_mode).toBe("disabled");
  });

  it("retains session CSRF for tokenless authoring", async () => {
    const { runtime, app } = await setup("disabled");
    runtime.config.auth_mode = "oauth";
    const session = runtime.auth.store.createSession(
      "ordinary-subject",
      "example-user",
      3600,
    );
    const options = {
      method: "POST" as const,
      url: "/api/v1/workbench/configurations",
      headers: { cookie: `hhf_session=${session.id}` },
      payload: { name: "my-harness", harbor_job_config: { agents: [{ name: "pi" }] } },
    };
    expect((await app.inject(options)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          ...options,
          headers: { ...options.headers, "x-csrf-token": session.csrf },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("rejects mismatched token identities even for administrators", async () => {
    const { app } = await setup();
    vi.spyOn(PersonalHuggingFace.prototype, "identity").mockResolvedValue({
      id: "somebody-else",
      name: "another-user",
    });
    const jobs = vi.spyOn(PersonalHuggingFace.prototype, "jobs");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/personal/jobs",
      headers,
    });
    expect(response.statusCode).toBe(403);
    expect(jobs).not.toHaveBeenCalled();
  });

  it("allows a reader to access only personal interfaces", async () => {
    const { runtime, app } = await setup("disabled");
    identity();
    vi.spyOn(runtime.auth, "developmentActor").mockReturnValue({
      subject: "development-operator",
      username: "example-user",
      role: "reader",
      transport: "development",
    });
    vi.spyOn(PersonalHuggingFace.prototype, "jobs").mockResolvedValue([]);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/personal/jobs", headers }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject({ url: "/api/v1/runs" })).statusCode).toBe(403);
  });

  it("keeps dispatch disabled without exact approval", async () => {
    const { app } = await setup();
    identity();
    const launch = vi.spyOn(PersonalHuggingFace.prototype, "launch");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/personal/launch",
      headers,
      payload: launchPayload,
    });
    expect(response.statusCode).toBe(503);
    expect(launch).not.toHaveBeenCalled();
  });

  it("requires session CSRF for personal reads and mutations", async () => {
    const { runtime, app } = await setup();
    identity();
    runtime.config.auth_mode = "oauth";
    const session = runtime.auth.store.createSession(
      "ordinary-subject",
      "example-user",
      3600,
    );
    const options = {
      method: "POST" as const,
      url: "/api/v1/personal/identity",
      headers: { ...headers, cookie: `hhf_session=${session.id}` },
    };
    expect((await app.inject(options)).statusCode).toBe(403);
    const accepted = await app.inject({
      ...options,
      headers: { ...options.headers, "x-csrf-token": session.csrf },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["cache-control"]).toBe("no-store");
  });

  it("uses the verified username allowlist without granting other users admin", async () => {
    const { runtime } = await setup();
    const auth = new AuthenticationService(
      "development",
      runtime.auth.store,
      null,
      async () => null,
      { adminUsernames: ["example-admin"] },
    );
    expect(await auth.role("ordinary-subject", "example-user")).toBe("reader");
    expect(await auth.role("admin-subject", "example-admin")).toBe("operator");
    expect(await auth.role("example-admin")).toBe("reader");
  });

  it("dispatches exact approved native config once across app restart", async () => {
    const { runtime, app } = await setup("disabled");
    identity();
    await approve(runtime);
    const launch = vi.spyOn(PersonalHuggingFace.prototype, "launch").mockResolvedValue({
      id: "example-job",
      run_id: runId,
      url: "https://huggingface.co/jobs/example-user/example-job",
      sandbox_cleanup: "unverified",
    });
    const options = {
      method: "POST" as const,
      url: "/api/v1/personal/launch",
      headers,
      payload: await acceptedPayload(app),
    };
    expect((await app.inject(options)).statusCode).toBe(200);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "example-user", runId }),
    );
    expect(JSON.stringify(launch.mock.calls)).not.toContain(headers["x-hf-user-token"]);
    const restarted = await buildApp(runtime);
    expect((await restarted.inject(options)).statusCode).toBe(409);
    expect(launch).toHaveBeenCalledTimes(1);
    await restarted.close();
  });

  it("consumes ambiguous dispatch approval and suppresses provider errors", async () => {
    const { runtime, app } = await setup();
    identity();
    await approve(runtime);
    const launch = vi
      .spyOn(PersonalHuggingFace.prototype, "launch")
      .mockRejectedValue(new Error(headers["x-hf-user-token"]));
    const options = {
      method: "POST" as const,
      url: "/api/v1/personal/launch",
      headers,
      payload: await acceptedPayload(app),
    };
    const failed = await app.inject(options);
    expect(failed.statusCode).toBe(400);
    expect(failed.body).not.toContain(headers["x-hf-user-token"]);
    expect((await app.inject(options)).statusCode).toBe(409);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("requires renewed consent if an approval changes after review", async () => {
    const { runtime, app } = await setup();
    identity();
    await approve(runtime);
    const launch = vi.spyOn(PersonalHuggingFace.prototype, "launch");
    const claim = vi.spyOn(runtime.store, "create");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/personal/launch",
      headers,
      payload: launchPayload,
    });
    expect(response.statusCode).toBe(503);
    expect(launch).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects artifact traversal before provider download", async () => {
    const { app } = await setup();
    identity();
    const artifact = vi.spyOn(PersonalHuggingFace.prototype, "artifact");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/personal/artifact",
          headers,
          payload: {
            bucket: "private-results",
            run_id: runId,
            path: `runs/${runId}/../other/result.json`,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(artifact).not.toHaveBeenCalled();
  });
});

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
      // Verified ordinary users can use personal APIs, not historical mutations.
      expect(await runtime.auth.role("unlisted-subject")).toBe("reader");
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
  describe.each(["enabled", "disabled"] as const)(
    "untrusted configuration with writes %s",
    (mode) => {
      it.each([
        {
          case: "agent import",
          config: { agents: [{ import_path: "untrusted.module:Agent" }] },
        },
        {
          case: "name import selector",
          config: { agents: [{ name: "untrusted.module:Agent" }] },
        },
        {
          case: "controller plugin",
          config: { plugins: [{ import_path: "untrusted.module:Hook" }] },
        },
        {
          case: "CLI arguments",
          config: { args: ["--plugin", "untrusted.module:Hook"] },
        },
        {
          case: "control forwarding",
          config: {
            environment: { type: "hf-sandbox", kwargs: { forward_hf_token: true } },
          },
        },
        {
          case: "environment binding",
          config: { agents: [{ name: "pi", env: { HF_TOKEN: "$" + "{HF_TOKEN}" } }] },
        },
        {
          case: "verifier hook",
          config: { verifier: { import_path: "untrusted.module:Verifier" } },
        },
        {
          case: "host paths",
          config: { jobs_dir: "/controller", tasks: [{ path: "/controller/task" }] },
        },
      ])(
        "rejects $case before config inspection or credential resolution",
        async ({ config }) => {
          const { runtime, app } = await setup(mode);
          const credentialRead = vi.fn(() => {
            throw new Error("credential access forbidden");
          });
          for (const key of ["hf_token", "hf_inference_token"])
            Object.defineProperty(runtime.config, key, {
              configurable: true,
              get: credentialRead,
            });
          const network = vi.fn(() => {
            throw new Error("network forbidden");
          });
          vi.stubGlobal("fetch", network);
          const handlers = [
            vi.spyOn(runtime.service, "submitConfig"),
            vi.spyOn(runtime.store, "create"),
            vi.spyOn(runtime.store, "put"),
            vi.spyOn(runtime.service.jobs, "startParent"),
            vi.spyOn(runtime.service.jobs, "cancel"),
            vi.spyOn(runtime.reconciler, "start"),
          ];
          const response = await app.inject({
            method: "POST",
            url: "/api/v1/runs/config?preview=true",
            headers: {
              "idempotency-key": "offline-contract",
              "x-harbor-hf-cost-ceiling-usd-per-trial": "1",
            },
            payload: config,
          });
          expect(response.statusCode).toBe(503);
          expect(response.json().error.code).toBe("execution_disabled");
          expect(response.body).not.toContain("untrusted.module");
          runtime.start();
          for (const spy of [...handlers, credentialRead, network])
            expect(spy).not.toHaveBeenCalled();
          expect(await runtime.store.list("runs/")).toEqual([]);
          await app.close();
        },
      );
    },
  );
  it.each([
    { name: "pi", kwargs: { version: "0.84.4", thinking: "off" } },
    { name: "codex", kwargs: { version: "0.118.0", reasoning_effort: "low" } },
  ])(
    "round-trips native $name configuration without granting execution",
    async (agent) => {
      const { runtime, app } = await setup();
      const network = vi.fn(() => {
        throw new Error("network forbidden");
      });
      vi.stubGlobal("fetch", network);
      const input = {
        name: "review-candidate",
        harbor_job_config: {
          agents: [agent],
          environment: {
            type: "hf-sandbox",
            kwargs: { flavor: "cpu-basic", job_timeout: "30m" },
          },
        },
      };
      const saved = await app.inject({
        method: "POST",
        url: "/api/v1/workbench/configurations",
        payload: input,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().harbor_job_config).toEqual(input.harbor_job_config);
      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/runs/config",
        payload: saved.json().harbor_job_config,
      });
      expect(rejected.statusCode).toBe(503);
      expect(rejected.json().error.code).toBe("execution_disabled");
      expect(await runtime.store.list("runs/")).toEqual([]);
      expect(network).not.toHaveBeenCalled();
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

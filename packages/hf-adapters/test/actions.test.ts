import type { ActionIntent } from "@harbor-hf/contracts";
import {
  AmbiguousExternalActionError,
  verifyWorkerCapability,
} from "@harbor-hf/control-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HuggingFaceActions } from "../src/actions.js";

const testToken = ["hf", "not-a-real-control-credential"].join("_");
const testInferenceToken = ["hf", "not-a-real-inference-credential"].join("_");
const taskImageMirrorRepository = "mirror.example/harbor-hf/tasks";

const base: ActionIntent = {
  schema_version: "v1",
  kind: "action.intent",
  record_id: "action-test-0001",
  created_at: "2026-08-16T00:00:00Z",
  actor: { subject: "service", role: "service" },
  action_id: "action-test-0001",
  run_id: "run-test-0001",
  action_kind: "job.launch",
  generation: 0,
  target: "task-one",
  payload: {
    worker_role: "execution",
    task_id: "task-one",
    task_ids: ["task-one"],
    job_image:
      "alpine:3.22@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    task_image:
      "example.invalid/task@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    job_command: ["true"],
    hardware: "cpu-basic",
    timeout_seconds: 60,
    trusted_worker: true,
    run_lock_digest: `sha256:${"c".repeat(64)}`,
    prepared_job_digest: `sha256:${"d".repeat(64)}`,
    max_image_bytes: 20 * 1024 * 1024 * 1024,
    max_image_entries: 500_000,
  },
};

function expectedEnvironment(intent: ActionIntent): Record<string, string> {
  const payload = intent.payload;
  const actionId =
    intent.action_kind === "job.launch"
      ? intent.action_id
      : String(payload.launch_action_id);
  return {
    HARBOR_HF_RUN_ID: intent.run_id,
    HARBOR_HF_ACTION_ID: actionId,
    HARBOR_HF_TASK_IDS_JSON: JSON.stringify(payload.task_ids),
    HARBOR_HF_CONTROL_URL: "https://control.example",
    HARBOR_HF_CONTROL_RETRY_TIMEOUT_SECONDS: String(payload.timeout_seconds),
    HARBOR_HF_WORKER_ROLE: String(payload.worker_role ?? "execution"),
    HARBOR_HF_JOB_IMAGE: String(payload.job_image),
    ...(typeof payload.task_image === "string"
      ? { HARBOR_HF_TASK_IMAGE: payload.task_image }
      : {}),
    ...(typeof payload.task_image === "string"
      ? {
          HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY: taskImageMirrorRepository,
        }
      : {}),
    HARBOR_HF_RUN_LOCK_DIGEST: String(payload.run_lock_digest),
    PYTHONUNBUFFERED: "1",
    ...(typeof payload.worker_revision === "string"
      ? { HARBOR_HF_WORKER_REVISION: payload.worker_revision }
      : {}),
    ...(typeof payload.run_continuation_repair_id === "string"
      ? {
          HARBOR_HF_RUN_CONTINUATION_REPAIR_ID: payload.run_continuation_repair_id,
        }
      : {}),
    ...(typeof payload.run_continuation_repair_successor_id === "string"
      ? {
          HARBOR_HF_RUN_CONTINUATION_REPAIR_SUCCESSOR_ID:
            payload.run_continuation_repair_successor_id,
        }
      : {}),
    ...(typeof payload.prepared_job_digest === "string"
      ? { HARBOR_HF_PREPARED_JOB_DIGEST: payload.prepared_job_digest }
      : {}),
    ...(typeof payload.max_image_bytes === "number"
      ? { HARBOR_HF_MAX_IMAGE_BYTES: String(payload.max_image_bytes) }
      : {}),
    ...(typeof payload.max_image_entries === "number"
      ? { HARBOR_HF_MAX_IMAGE_ENTRIES: String(payload.max_image_entries) }
      : {}),
    ...(payload.inference_token === "required"
      ? {
          HARBOR_HF_INFERENCE_UPSTREAM: String(payload.inference_upstream),
          HARBOR_HF_INFERENCE_ALLOWED_MODEL: String(payload.inference_model),
          HARBOR_HF_INFERENCE_API: String(payload.inference_api),
          HARBOR_HF_INFERENCE_MAX_REQUESTS: String(payload.inference_max_requests),
          HARBOR_HF_INFERENCE_MAX_CONCURRENCY: String(
            payload.inference_max_concurrency,
          ),
          HARBOR_HF_INFERENCE_TIMEOUT_SECONDS: String(
            payload.inference_timeout_seconds,
          ),
          HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS: String(
            payload.inference_max_output_tokens,
          ),
        }
      : {}),
  };
}

function apiJob(
  intent: ActionIntent = base,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const launchActionId =
    intent.action_kind === "job.launch"
      ? intent.action_id
      : String(intent.payload.launch_action_id);
  return {
    type: "job",
    id: "job-1",
    createdAt: "2026-08-16T00:00:00Z",
    dockerImage: intent.payload.job_image,
    command: intent.payload.job_command,
    arguments: [],
    environment: expectedEnvironment(intent),
    flavor: intent.payload.hardware,
    arch: "amd64",
    timeout: intent.payload.timeout_seconds,
    retry: 0,
    spaceId: null,
    secrets:
      intent.payload.worker_role !== "preparation" &&
      typeof intent.payload.inference_upstream === "string"
        ? ["HARBOR_HF_WORKER_CAPABILITY", "HF_INFERENCE_TOKEN"]
        : ["HARBOR_HF_WORKER_CAPABILITY"],
    labels: {
      harbor_hf_action_id: launchActionId,
      harbor_hf_run_id: intent.run_id,
      harbor_hf_worker_role: intent.payload.worker_role ?? "execution",
    },
    volumes: [],
    status: {
      stage: "RUNNING",
      failureCount: 0,
      exposeUrls: null,
      sshUrl: null,
    },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("HuggingFaceActions", () => {
  it("adopts a Job with the deterministic action label", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([apiJob()]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });
    await expect(adapter.execute(base)).resolves.toMatchObject({
      outcome: "adopted",
      resource_id: "job-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect((firstCall?.[1] as RequestInit | undefined)?.method).toBeUndefined();
  });

  it("binds a continued historical Job to its worker repair", async () => {
    const intent: ActionIntent = {
      ...base,
      record_id: "action-test-repair",
      action_id: "action-test-repair",
      payload: {
        ...base.payload,
        run_continuation_id: "continuation-test",
        run_continuation_repair_id: "continuation-repair-test",
        run_continuation_repair_successor_id: "continuation-repair-successor-test",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([apiJob(intent)]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(intent)).resolves.toMatchObject({
      outcome: "adopted",
      resource_id: "job-1",
    });
  });

  it("rejects reuse of the control credential as a worker inference credential", () => {
    expect(
      () =>
        new HuggingFaceActions({
          namespace: "example",
          accessToken: testToken,
          taskImageMirrorRepository,
          inferenceToken: testToken,
        }),
    ).toThrow("control and inference credentials must be distinct");
  });

  it("creates one labelled Job when no matching action exists", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (!init?.method)
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        const request = JSON.parse(String(init.body)) as {
          labels: Record<string, string>;
          attempts: number;
          arch: string;
          environment: Record<string, string>;
          secrets: Record<string, string>;
          timeoutSeconds: number;
          volumes?: unknown[];
          expose?: unknown;
          spaceId?: unknown;
          ssh?: unknown;
        };
        expect(request.labels.harbor_hf_action_id).toBe(base.action_id);
        expect(request.attempts).toBe(1);
        expect(request.arch).toBe("amd64");
        expect(request.timeoutSeconds).toBe(60);
        expect(request.environment).toMatchObject({
          HARBOR_HF_RUN_ID: base.run_id,
          HARBOR_HF_ACTION_ID: base.action_id,
          HARBOR_HF_TASK_IDS_JSON: '["task-one"]',
          HARBOR_HF_CONTROL_URL: "https://control.example",
          HARBOR_HF_CONTROL_RETRY_TIMEOUT_SECONDS: "60",
          HARBOR_HF_JOB_IMAGE: base.payload.job_image,
          HARBOR_HF_TASK_IMAGE: base.payload.task_image,
          HARBOR_HF_RUN_LOCK_DIGEST: base.payload.run_lock_digest,
          HARBOR_HF_MAX_IMAGE_BYTES: String(base.payload.max_image_bytes),
          HARBOR_HF_MAX_IMAGE_ENTRIES: String(base.payload.max_image_entries),
          PYTHONUNBUFFERED: "1",
        });
        expect(request.environment).not.toHaveProperty("HARBOR_HF_WORKER_CAPABILITY");
        expect(request.secrets.HARBOR_HF_WORKER_CAPABILITY).toMatch(/^v1\./);
        expect(
          verifyWorkerCapability(
            testToken,
            request.secrets.HARBOR_HF_WORKER_CAPABILITY,
            "example",
          ),
        ).toMatchObject({
          run_lock_digest: base.payload.run_lock_digest,
          operations: ["attempt.submit", "evidence.write", "run.read"],
        });
        expect(JSON.stringify(request.environment)).not.toContain(testToken);
        expect(Object.keys(request.secrets)).toEqual(["HARBOR_HF_WORKER_CAPABILITY"]);
        expect(request.volumes).toBeUndefined();
        expect(request.spaceId).toBeUndefined();
        expect(request.ssh).toBeUndefined();
        expect(request.expose).toBeUndefined();
        return new Response(
          JSON.stringify(
            apiJob(base, {
              id: "job-2",
              environment: request.environment,
              labels: request.labels,
              secrets: Object.keys(request.secrets),
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });
    await expect(adapter.execute(base)).resolves.toMatchObject({
      outcome: "created",
      resource_id: "job-2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters concurrent adoption lookups by deterministic action label", async () => {
    const second: ActionIntent = {
      ...base,
      record_id: "action-test-0002",
      action_id: "action-test-0002",
      target: "task-two",
      payload: {
        ...base.payload,
        task_id: "task-two",
        task_ids: ["task-two"],
      },
    };
    const listRequestLabels: Array<string | null> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!init?.method) {
        const requestUrl = new URL(
          typeof url === "string" || url instanceof URL ? url : url.url,
        );
        listRequestLabels.push(requestUrl.searchParams.get("label"));
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const request = JSON.parse(String(init.body)) as {
        labels: Record<string, string>;
        environment: Record<string, string>;
        secrets: Record<string, string>;
      };
      const intent =
        request.labels.harbor_hf_action_id === base.action_id ? base : second;
      return new Response(
        JSON.stringify(
          apiJob(intent, {
            id: `job-${intent.target}`,
            environment: request.environment,
            labels: request.labels,
            secrets: Object.keys(request.secrets),
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(
      Promise.all([adapter.execute(base), adapter.execute(second)]),
    ).resolves.toEqual([
      expect.objectContaining({ outcome: "created", resource_id: "job-task-one" }),
      expect.objectContaining({ outcome: "created", resource_id: "job-task-two" }),
    ]);
    expect(listRequestLabels.sort()).toEqual([
      `harbor_hf_action_id=${base.action_id}`,
      `harbor_hf_action_id=${second.action_id}`,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("launches preparation Jobs with an encrypted preparation-only capability", async () => {
    const preparationIntent: ActionIntent = {
      ...base,
      action_id: "action-preparation",
      payload: {
        ...base.payload,
        worker_role: "preparation",
        worker_revision: "abcdef0",
      },
    };
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (!init?.method)
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        const request = JSON.parse(String(init.body)) as {
          labels: Record<string, string>;
          environment: Record<string, string>;
          secrets: Record<string, string>;
        };
        expect(request.labels.harbor_hf_worker_role).toBe("preparation");
        expect(request.environment).toMatchObject({
          HARBOR_HF_WORKER_ROLE: "preparation",
          HARBOR_HF_WORKER_REVISION: "abcdef0",
          PYTHONUNBUFFERED: "1",
        });
        expect(
          verifyWorkerCapability(
            testToken,
            request.secrets.HARBOR_HF_WORKER_CAPABILITY,
            "example",
          ),
        ).toMatchObject({
          operations: ["preparation.submit", "run.read"],
        });
        expect(request.environment).not.toHaveProperty("HARBOR_HF_WORKER_CAPABILITY");
        expect(Object.keys(request.secrets)).toEqual(["HARBOR_HF_WORKER_CAPABILITY"]);
        return new Response(
          JSON.stringify(
            apiJob(preparationIntent, {
              id: "job-preparation",
              environment: request.environment,
              labels: request.labels,
              secrets: Object.keys(request.secrets),
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(preparationIntent)).resolves.toMatchObject({
      outcome: "created",
      resource_id: "job-preparation",
    });
  });

  it("rejects duplicate or mismatched Job adoption labels as ambiguous", async () => {
    const job = apiJob(base, {
      id: "job-ambiguous",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([job, { ...job, id: "job-ambiguous-2" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });
    await expect(adapter.execute(base)).rejects.toBeInstanceOf(
      AmbiguousExternalActionError,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                ...job,
                labels: {
                  ...(job.labels as Record<string, string>),
                  harbor_hf_run_id: "run-other",
                },
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    await expect(adapter.execute(base)).rejects.toBeInstanceOf(
      AmbiguousExternalActionError,
    );
  });

  it("rejects adoption when any observable Job field is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([apiJob(base, { retry: undefined })]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(base)).rejects.toBeInstanceOf(
      AmbiguousExternalActionError,
    );
  });

  it("accepts SDK aliases and omitted observational defaults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              apiJob(base, {
                arguments: undefined,
                attempts: 1,
                retry: undefined,
                spaceId: undefined,
                status: { stage: "RUNNING", failureCount: 0 },
                timeout: undefined,
                timeoutSeconds: 60,
                volumes: undefined,
              }),
            ]),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(base)).resolves.toMatchObject({
      outcome: "adopted",
      resource_id: "job-1",
    });
  });

  it.each([
    ["architecture", { arch: "arm64" }],
    ["Space image", { spaceId: "example/space" }],
    [
      "SSH endpoint",
      {
        status: {
          stage: "RUNNING",
          failureCount: 0,
          exposeUrls: null,
          sshUrl: "ssh-enabled",
        },
      },
    ],
    [
      "exposed port",
      {
        status: {
          stage: "RUNNING",
          failureCount: 0,
          exposeUrls: ["https://job-1--8000.hf.jobs"],
          sshUrl: null,
        },
      },
    ],
    ["timeout", { timeout: 61 }],
    ["retry count", { retry: 1 }],
  ])("rejects adoption with mismatched %s", async (_label, overrides) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([apiJob(base, overrides)]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(base)).rejects.toBeInstanceOf(
      AmbiguousExternalActionError,
    );
  });

  it("rejects a multi-task execution Job at the adapter boundary", async () => {
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
    });
    await expect(
      adapter.execute({
        ...base,
        payload: {
          ...base.payload,
          task_id: null,
          task_ids: ["task-one", "task-two"],
        },
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      error_code: "remote_dependency_error",
    });
    await expect(
      adapter.execute({
        ...base,
        payload: {
          ...base.payload,
          task_id: null,
          task_ids: ["task-one"],
        },
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      error_code: "remote_dependency_error",
    });
  });

  it("injects the dedicated inference credential into a prepared trial Job", async () => {
    const inferenceIntent: ActionIntent = {
      ...base,
      action_id: "action-test-inference",
      payload: {
        ...base.payload,
        prepared_job_digest: `sha256:${"d".repeat(64)}`,
        inference_upstream: "https://router.huggingface.co/v1",
        inference_model: "example/model",
        inference_api: "chat-completions",
      },
    };
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (!init?.method)
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        const request = JSON.parse(String(init.body)) as {
          environment: Record<string, string>;
          secrets: Record<string, string>;
          labels: Record<string, string>;
        };
        expect(request.environment).not.toHaveProperty("HF_TOKEN");
        expect(request.environment).not.toHaveProperty("HF_INFERENCE_TOKEN");
        expect(request.environment).toMatchObject({
          HARBOR_HF_PREPARED_JOB_DIGEST: `sha256:${"d".repeat(64)}`,
        });
        expect(request.environment).not.toHaveProperty("HARBOR_HF_INFERENCE_UPSTREAM");
        expect(request.secrets).toEqual({
          HARBOR_HF_WORKER_CAPABILITY: expect.stringMatching(/^v1\./),
          HF_INFERENCE_TOKEN: testInferenceToken,
        });
        return new Response(
          JSON.stringify(
            apiJob(inferenceIntent, {
              id: "job-inference",
              environment: request.environment,
              labels: request.labels,
              secrets: Object.keys(request.secrets),
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      inferenceToken: testInferenceToken,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(inferenceIntent)).resolves.toMatchObject({
      outcome: "created",
      resource_id: "job-inference",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exports the bounded environment for a bridge-compatible worker", async () => {
    const inferenceIntent: ActionIntent = {
      ...base,
      action_id: "action-test-bridge-compatibility",
      payload: {
        ...base.payload,
        inference_token: "required",
        inference_upstream: "https://router.huggingface.co/v1",
        inference_model: "example/model",
        inference_api: "chat-completions",
        inference_max_requests: 64,
        inference_max_concurrency: 4,
        inference_timeout_seconds: 600,
        inference_max_output_tokens: 32768,
      },
    };
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (!init?.method)
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        const request = JSON.parse(String(init.body)) as {
          environment: Record<string, string>;
          secrets: Record<string, string>;
          labels: Record<string, string>;
        };
        expect(request.environment).toMatchObject({
          HARBOR_HF_INFERENCE_UPSTREAM: "https://router.huggingface.co/v1",
          HARBOR_HF_INFERENCE_ALLOWED_MODEL: "example/model",
          HARBOR_HF_INFERENCE_API: "chat-completions",
          HARBOR_HF_INFERENCE_MAX_REQUESTS: "64",
          HARBOR_HF_INFERENCE_MAX_CONCURRENCY: "4",
          HARBOR_HF_INFERENCE_TIMEOUT_SECONDS: "600",
          HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS: "32768",
        });
        return new Response(
          JSON.stringify(
            apiJob(inferenceIntent, {
              id: "job-bridge-compatibility",
              environment: request.environment,
              labels: request.labels,
              secrets: Object.keys(request.secrets),
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      inferenceToken: testInferenceToken,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(inferenceIntent)).resolves.toMatchObject({
      outcome: "created",
      resource_id: "job-bridge-compatibility",
    });
  });

  it("fails closed before a remote lookup when a required inference credential is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(
      adapter.execute({
        ...base,
        payload: {
          ...base.payload,
          inference_upstream: "https://router.huggingface.co/v1",
          inference_model: "example/model",
          inference_api: "chat-completions",
        },
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      error_code: "remote_dependency_error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous Job launch pending until it can adopt the action label", async () => {
    let call = 0;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        call += 1;
        if ((call === 1 || call === 2) && !init?.method)
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (call === 3 && init?.method) throw new TypeError("network disconnected");
        return new Response(
          JSON.stringify([apiJob(base, { id: "job-adopted-after-disconnect" })]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(base, { adoption_only: true })).rejects.toThrow(
      "no Job has the deterministic action label",
    );
    await expect(adapter.execute(base)).rejects.toThrow(
      "Job launch outcome is ambiguous",
    );
    await expect(adapter.execute(base, { adoption_only: true })).resolves.toMatchObject(
      {
        outcome: "adopted",
        resource_id: "job-adopted-after-disconnect",
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("cancels the exact Job bound to the launch action", async () => {
    const cancelIntent: ActionIntent = {
      ...base,
      action_kind: "job.cancel",
      target: "job-1",
      payload: {
        ...base.payload,
        resource_id: "job-1",
        launch_action_id: base.action_id,
      },
    };
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            apiJob(cancelIntent, {
              id: "job-1",
              status: {
                stage: init?.method ? "CANCELED" : "RUNNING",
                failureCount: 0,
              },
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });
    await expect(adapter.execute(cancelIntent)).resolves.toMatchObject({
      outcome: "completed",
      observed_state: "CANCELED",
      resource_id: "job-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a retryable failure while a cancellation leaves the Job running", async () => {
    const cancelIntent: ActionIntent = {
      ...base,
      action_kind: "job.cancel",
      target: "job-1",
      payload: {
        ...base.payload,
        resource_id: "job-1",
        launch_action_id: base.action_id,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(apiJob(cancelIntent)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(apiJob(cancelIntent)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(cancelIntent)).resolves.toMatchObject({
      outcome: "failed",
      observed_state: "RUNNING",
      resource_id: "job-1",
      error_code: "remote_dependency_error",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("settles a failed cancellation from a terminal Job observation", async () => {
    const cancelIntent: ActionIntent = {
      ...base,
      action_kind: "job.cancel",
      target: "job-1",
      payload: {
        ...base.payload,
        resource_id: "job-1",
        launch_action_id: base.action_id,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(apiJob(cancelIntent)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            apiJob(cancelIntent, {
              status: { stage: "ERROR", failureCount: 1 },
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(cancelIntent)).resolves.toMatchObject({
      outcome: "completed",
      observed_state: "ERROR",
      resource_id: "job-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("records locked hardware cost when observing a finished Job", async () => {
    const observeIntent: ActionIntent = {
      ...base,
      action_kind: "job.observe",
      target: "job-costed",
      payload: {
        ...base.payload,
        resource_id: "job-costed",
        launch_action_id: base.action_id,
        active_hourly_cost_microusd: 10_000,
      },
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            apiJob(observeIntent, {
              id: "job-costed",
              startedAt: "2026-08-21T12:00:00Z",
              finishedAt: "2026-08-21T13:00:00Z",
              status: { stage: "COMPLETED", failureCount: 0 },
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });
    await expect(adapter.execute(observeIntent)).resolves.toMatchObject({
      outcome: "completed",
      observed_state: "COMPLETED",
      resource_id: "job-costed",
      active_hourly_cost_microusd: 10_000,
      cost_microusd: 10_000,
    });
  });

  it("observes a historical Job created before task-image mirror routing", async () => {
    const observeIntent: ActionIntent = {
      ...base,
      action_kind: "job.observe",
      target: "job-historical",
      payload: {
        ...base.payload,
        resource_id: "job-historical",
        launch_action_id: base.action_id,
      },
    };
    const historicalJob = apiJob(observeIntent, {
      id: "job-historical",
      status: { stage: "COMPLETED", failureCount: 0 },
    });
    delete (historicalJob.environment as Record<string, string>)
      .HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([historicalJob]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.observeJobs([observeIntent])).resolves.toMatchObject([
      { outcome: "completed", observed_state: "COMPLETED" },
    ]);
  });

  it("still requires task-image mirror routing when adopting a new Job", async () => {
    const unmirroredJob = apiJob();
    delete (unmirroredJob.environment as Record<string, string>)
      .HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([unmirroredJob]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(base)).rejects.toBeInstanceOf(
      AmbiguousExternalActionError,
    );
  });

  it("caches and paginates batched Job observations by namespace", async () => {
    const first: ActionIntent = {
      ...base,
      action_kind: "job.observe",
      target: "job-one",
      payload: {
        ...base.payload,
        resource_id: "job-one",
        launch_action_id: base.action_id,
        active_hourly_cost_microusd: 10_000,
      },
    };
    const second: ActionIntent = {
      ...first,
      record_id: "action-observe-0002",
      action_id: "action-observe-0002",
      target: "job-two",
      payload: {
        ...first.payload,
        resource_id: "job-two",
        launch_action_id: "action-launch-0002",
        task_id: "task-two",
        task_ids: ["task-two"],
      },
    };
    const finished = {
      startedAt: "2026-08-21T12:00:00Z",
      finishedAt: "2026-08-21T13:00:00Z",
      status: { stage: "COMPLETED", failureCount: 0 },
    };
    const requestedUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      requestedUrls.push(url);
      if (url.searchParams.has("cursor"))
        return new Response(
          JSON.stringify([apiJob(second, { ...finished, id: "job-two" })]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      return new Response(
        JSON.stringify([apiJob(first, { ...finished, id: "job-one" })]),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: '<https://huggingface.co/api/jobs/example?cursor=next>; rel="next"',
          },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    const [batch, cached] = await Promise.all([
      adapter.observeJobs([first, second]),
      adapter.observeJobs([first]),
    ]);
    expect(batch).toMatchObject([
      {
        observed_state: "COMPLETED",
        resource_id: "job-one",
        cost_microusd: 10_000,
      },
      {
        observed_state: "COMPLETED",
        resource_id: "job-two",
        cost_microusd: 10_000,
      },
    ]);
    expect(cached).toMatchObject([
      { observed_state: "COMPLETED", resource_id: "job-one" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedUrls[0]?.searchParams.getAll("stage")).toEqual([
      "RUNNING",
      "SCHEDULING",
    ]);
  });

  it("inspects a terminal Job absent from the active namespace snapshot", async () => {
    const intent: ActionIntent = {
      ...base,
      action_kind: "job.observe",
      target: "job-one",
      payload: {
        ...base.payload,
        resource_id: "job-one",
        launch_action_id: base.action_id,
        active_hourly_cost_microusd: 10_000,
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (url.pathname === "/api/jobs/example")
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      return new Response(
        JSON.stringify(
          apiJob(intent, {
            id: "job-one",
            startedAt: "2026-08-21T12:00:00Z",
            finishedAt: "2026-08-21T13:00:00Z",
            status: { stage: "COMPLETED", failureCount: 0 },
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      controlUrl: "https://control.example",
    });

    await expect(adapter.observeJobs([intent])).resolves.toMatchObject([
      { observed_state: "COMPLETED", resource_id: "job-one" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("observes replicas when a pause response omits their state", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return new Response(
        call === 1
          ? JSON.stringify({ status: { state: "PAUSED" } })
          : JSON.stringify({
              status: { state: "PAUSED" },
              replicas: { ready: 2 },
            }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
      endpointsUrl: "https://endpoints.example/v2",
    });

    await expect(
      adapter.execute({
        ...base,
        action_kind: "endpoint.pause",
        payload: { endpoint_id: "endpoint-one" },
      }),
    ).resolves.toMatchObject({
      outcome: "completed",
      ready_replicas: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires an independently verified watchdog before endpoint resume", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      taskImageMirrorRepository,
    });
    const result = await adapter.execute({
      ...base,
      kind: "action.intent",
      action_kind: "endpoint.resume",
      payload: { endpoint_id: "endpoint-1", watchdog_verified: false },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      error_code: "remote_dependency_error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

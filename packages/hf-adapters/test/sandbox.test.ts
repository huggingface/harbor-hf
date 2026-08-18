import type { ActionIntent, SandboxPolicy } from "@harbor-hf/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HuggingFaceSandboxGateway } from "../src/sandbox.js";

const controlToken = "hf_not-a-real-control-credential";
const inferenceToken = "hf_not-a-real-inference-credential";
const sandboxActionId = "action-sandbox-create-test";
const campaignId = "campaign-sandbox-test";
const taskId = "task-sandbox-test";
const remoteId = "remote-sandbox-job";
const policy: SandboxPolicy = {
  image: `registry.example/worker@sha256:${"a".repeat(64)}`,
  hardware: "h200",
  timeout_seconds: 21_600,
  idle_timeout_seconds: 1_800,
  inference_token: "required",
  inference_upstream: "https://route.example.endpoints.huggingface.cloud/v1",
  inference_model: "example/model",
  inference_api: "chat-completions",
  inference_max_requests: 256,
  inference_max_concurrency: 1,
  inference_timeout_seconds: 1_800,
  inference_max_output_tokens: 32_768,
  root_bootstrap_command: ["/opt/worker/start-root-services"],
  reservation_microusd: 20_000_000,
  active_hourly_cost_microusd: 5_000_000,
  max_sandboxes: 1,
  max_commands: 128,
  max_command_seconds: 3_600,
  max_transfer_bytes: 1_048_576,
  allowed_roots: ["/app", "/logs"],
};

function intent(
  actionKind: ActionIntent["action_kind"],
  payload: ActionIntent["payload"],
): ActionIntent {
  const actionId =
    actionKind === "sandbox.create"
      ? sandboxActionId
      : `action-${actionKind.replace(".", "-")}-test`;
  return {
    schema_version: "v1",
    kind: "action.intent",
    record_id: actionId,
    created_at: "2026-08-18T00:00:00Z",
    actor: { subject: "worker", role: "service" },
    action_id: actionId,
    campaign_id: campaignId,
    action_kind: actionKind,
    generation: 0,
    target: taskId,
    payload,
  };
}

function rawJob(state = "RUNNING") {
  return {
    type: "job",
    id: remoteId,
    dockerImage: policy.image,
    flavor: policy.hardware,
    createdAt: "2026-08-18T00:00:00Z",
    status: {
      stage: state,
      failureCount: 0,
      exposeUrls: ["https://sandbox-job--49983.hf.jobs"],
    },
    labels: {
      "hf-sandbox": "1",
      "hf-sandbox-mode": "dedicated",
      "hf-sandbox-nonce": "nonce-for-test",
      harbor_hf_sandbox_action_id: sandboxActionId,
      harbor_hf_campaign_id: campaignId,
      harbor_hf_task_id: taskId,
    },
    secrets: ["HF_INFERENCE_TOKEN", "SBX_TOKEN"],
  };
}

const createIntent = intent("sandbox.create", { task_id: taskId, sandbox: policy });
const execIntent = intent("sandbox.exec", {
  task_id: taskId,
  sandbox_create_action_id: sandboxActionId,
  resource_id: remoteId,
  sandbox: policy,
  command: ["python", "worker.py"],
  cwd: "/app",
  timeout_seconds: 60,
});
const closeIntent = intent("sandbox.close", {
  task_id: taskId,
  sandbox_create_action_id: sandboxActionId,
  resource_id: remoteId,
  sandbox: policy,
});

afterEach(() => vi.unstubAllGlobals());

describe("HuggingFaceSandboxGateway", () => {
  it("creates a labelled Sandbox Job without forwarding the control credential", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (!init?.method)
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        const body = JSON.parse(String(init.body)) as {
          command: string[];
          environment: Record<string, string>;
          secrets: Record<string, string>;
          labels: Record<string, string>;
          volumes: Array<Record<string, unknown>>;
          expose: { ports: number[] };
        };
        expect(body.labels.harbor_hf_sandbox_action_id).toBe(sandboxActionId);
        expect(body.secrets.HF_INFERENCE_TOKEN).toBe(inferenceToken);
        expect(body.secrets.SBX_TOKEN).not.toBe(controlToken);
        expect(JSON.stringify(body)).not.toContain(controlToken);
        expect(body.command.join(" ")).not.toContain("SBX_DL_TOKEN");
        expect(body.command.join(" ")).toContain("unset HF_INFERENCE_TOKEN");
        expect(body.command.join(" ")).toContain("HARBOR_HF_INFERENCE_UPSTREAM");
        expect(body.environment.HARBOR_HF_INFERENCE_UPSTREAM).toBe(
          policy.inference_upstream,
        );
        expect(body.volumes).toEqual([
          {
            type: "bucket",
            source: "huggingface/sbx-server",
            mountPath: "/.hf-sbx-server",
            readOnly: true,
          },
        ]);
        expect(body.expose.ports).toEqual([49_983]);
        return new Response(JSON.stringify({ ...rawJob(), labels: body.labels }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new HuggingFaceSandboxGateway({
      namespace: "example",
      accessToken: controlToken,
      inferenceToken,
    });

    await expect(gateway.lifecycle(createIntent)).resolves.toMatchObject({
      outcome: "created",
      resource_id: remoteId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("adopts only the deterministic Sandbox action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([rawJob("SCHEDULING")]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const gateway = new HuggingFaceSandboxGateway({
      namespace: "example",
      accessToken: controlToken,
      inferenceToken,
    });

    await expect(
      gateway.lifecycle(createIntent, { adoption_only: true }),
    ).resolves.toMatchObject({ outcome: "adopted", observed_state: "SCHEDULING" });
  });

  it("keeps close pending until the remote Sandbox Job is terminal", async () => {
    let observation = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method)
          return new Response(JSON.stringify(rawJob("RUNNING")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        observation += 1;
        return new Response(
          JSON.stringify(rawJob(observation === 1 ? "RUNNING" : "CANCELED")),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const gateway = new HuggingFaceSandboxGateway({
      namespace: "example",
      accessToken: controlToken,
      inferenceToken,
    });

    await expect(gateway.lifecycle(closeIntent)).rejects.toThrow(
      "shutdown is still pending",
    );
    await expect(gateway.lifecycle(closeIntent)).resolves.toMatchObject({
      outcome: "completed",
      observed_state: "CANCELED",
    });
  });

  it("rejects an unscoped proxy before sending the control credential", async () => {
    const evil = rawJob();
    if (evil.status)
      evil.status.exposeUrls = [
        "https://sandbox-job--49983.hf.jobs.evil.example/scopes/x",
      ];
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(evil), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new HuggingFaceSandboxGateway({
      namespace: "example",
      accessToken: controlToken,
      inferenceToken,
    });

    await expect(gateway.execute(execIntent)).rejects.toThrow(
      "proxy URL is not an approved scoped HF host",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("executes through the hidden proxy identity and parses the bounded stream", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/api/jobs/"))
        return new Response(JSON.stringify(rawJob()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${controlToken}`);
      expect(headers.get("X-Sandbox-Token")).toMatch(/^[0-9a-f]{64}$/);
      expect(String(url)).not.toContain(remoteId);
      return new Response(
        `${JSON.stringify({ event: "stdout", data: "ok\n" })}\n${JSON.stringify({ event: "exit", exit_code: 0, duration_ms: 12 })}\n`,
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new HuggingFaceSandboxGateway({
      namespace: "example",
      accessToken: controlToken,
      inferenceToken,
    });

    await expect(gateway.execute(execIntent)).resolves.toEqual({
      exit_code: 0,
      stdout: "ok\n",
      stderr: "",
      signal: null,
      timed_out: false,
      duration_ms: 12,
    });
  });
});

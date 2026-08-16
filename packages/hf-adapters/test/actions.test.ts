import type { ActionIntent } from "@harbor-hf/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HuggingFaceActions } from "../src/actions.js";

const testToken = ["hf", "not-a-real-credential"].join("_");

const base: ActionIntent = {
  schema_version: "v1",
  kind: "action.intent",
  record_id: "action-test-0001",
  created_at: "2026-08-16T00:00:00Z",
  actor: { subject: "service", role: "service" },
  action_id: "action-test-0001",
  campaign_id: "campaign-test-0001",
  action_kind: "job.launch",
  generation: 0,
  target: "campaign-tasks",
  payload: {
    task_ids: ["task-one", "task-two"],
    job_image:
      "alpine:3.22@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    job_command: ["true"],
    hardware: "cpu-basic",
    timeout_seconds: 60,
    trusted_worker: true,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("HuggingFaceActions", () => {
  it("adopts a Job with the deterministic action label", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              type: "job",
              id: "job-1",
              createdAt: "2026-08-16T00:00:00Z",
              flavor: "cpu-basic",
              status: { stage: "RUNNING", failureCount: 0 },
              labels: { harbor_hf_action_id: base.action_id },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
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
          environment: Record<string, string>;
          secrets?: Record<string, string>;
          volumes?: unknown[];
        };
        expect(request.labels.harbor_hf_action_id).toBe(base.action_id);
        expect(request.attempts).toBe(1);
        expect(request.environment).toMatchObject({
          HARBOR_HF_CAMPAIGN_ID: base.campaign_id,
          HARBOR_HF_ACTION_ID: base.action_id,
          HARBOR_HF_TASK_IDS_JSON: '["task-one","task-two"]',
          HARBOR_HF_CONTROL_URL: "https://control.example",
        });
        expect(request.environment.HARBOR_HF_WORKER_CAPABILITY).toMatch(/^v1\./);
        expect(JSON.stringify(request.environment)).not.toContain(testToken);
        expect(request.secrets).toBeUndefined();
        expect(request.volumes).toBeUndefined();
        return new Response(
          JSON.stringify({
            type: "job",
            id: "job-2",
            createdAt: "2026-08-16T00:00:00Z",
            flavor: "cpu-basic",
            status: { stage: "RUNNING", failureCount: 0 },
            labels: request.labels,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      controlUrl: "https://control.example",
    });
    await expect(adapter.execute(base)).resolves.toMatchObject({
      outcome: "created",
      resource_id: "job-2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an ambiguous Job launch pending until it can adopt the action label", async () => {
    let call = 0;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        call += 1;
        if (call === 1 && !init?.method)
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (call === 2 && init?.method) throw new TypeError("network disconnected");
        return new Response(
          JSON.stringify([
            {
              type: "job",
              id: "job-adopted-after-disconnect",
              createdAt: "2026-08-16T00:00:00Z",
              flavor: "cpu-basic",
              status: { stage: "RUNNING", failureCount: 0 },
              labels: { harbor_hf_action_id: base.action_id },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
      controlUrl: "https://control.example",
    });

    await expect(adapter.execute(base)).rejects.toThrow(
      "Job launch outcome is ambiguous",
    );
    await expect(adapter.execute(base)).resolves.toMatchObject({
      outcome: "adopted",
      resource_id: "job-adopted-after-disconnect",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cancels the exact Job bound to the launch action", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: "job",
            id: "job-1",
            createdAt: "2026-08-16T00:00:00Z",
            flavor: "cpu-basic",
            status: { stage: "CANCELED", failureCount: 0 },
            labels: { harbor_hf_action_id: base.action_id },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
    });
    await expect(
      adapter.execute({
        ...base,
        action_kind: "job.cancel",
        target: "job-1",
        payload: {
          resource_id: "job-1",
          launch_action_id: base.action_id,
        },
      }),
    ).resolves.toMatchObject({
      outcome: "completed",
      observed_state: "CANCELED",
      resource_id: "job-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires an independently verified watchdog before endpoint resume", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceActions({
      namespace: "example",
      accessToken: testToken,
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

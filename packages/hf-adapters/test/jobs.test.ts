import { describe, expect, it } from "vitest";
import { HuggingFaceJobs, NoopJobs, ReadOnlyHuggingFaceJobs } from "../src/index.js";

const runId = "run-0123456789abcdef01234567";
const image = `ghcr.io/example/parent@sha256:${"a".repeat(64)}`;
const controlToken = ["hf", "control-value"].join("_");
const inferenceToken = ["hf", "inference-value"].join("_");

function apiJob(role: "parent" | "trial" = "parent") {
  return {
    type: "job",
    id: `${role}-job`,
    status: { stage: "RUNNING", failureCount: 0 },
    createdAt: "2026-09-04T00:00:00Z",
    startedAt: "2026-09-04T00:00:01Z",
    finishedAt: null,
    flavor: "cpu-basic",
    labels: { "harbor-hf-role": role, "harbor-hf-run": runId },
  };
}

describe("HuggingFaceJobs", () => {
  it("launches one immutable parent with the Bucket and two ephemeral secrets", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(apiJob()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const jobs = new HuggingFaceJobs({
      namespace: "example",
      accessToken: controlToken,
      inferenceToken,
      bucketId: "example/bucket",
      parentImage: image,
      fetch: fakeFetch,
    });
    const result = await jobs.startParent(runId);
    expect(result).toMatchObject({ run_id: runId, role: "parent", stage: "running" });
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      dockerImage: image,
      command: ["python", "-m", "harbor_hf_agents.parent_worker"],
      attempts: 1,
      labels: { "harbor-hf-role": "parent", "harbor-hf-run": runId },
      volumes: [
        {
          type: "bucket",
          source: "example/bucket",
          mountPath: "/data",
          readOnly: false,
        },
      ],
    });
    expect(body.secrets).toEqual({
      HF_TOKEN: controlToken,
      HF_INFERENCE_TOKEN: inferenceToken,
    });
  });

  it("filters unrelated Jobs and cancels an owned Job", async () => {
    const methods: string[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST")
        return new Response(
          JSON.stringify({
            ...apiJob(),
            status: { stage: "STOPPED", failureCount: 0 },
          }),
        );
      return new Response(
        JSON.stringify([
          apiJob(),
          apiJob("trial"),
          { ...apiJob(), id: "unrelated", labels: { other: "value" } },
        ]),
      );
    };
    const jobs = new HuggingFaceJobs({
      namespace: "example",
      accessToken: controlToken,
      inferenceToken,
      bucketId: "example/bucket",
      parentImage: image,
      fetch: fakeFetch,
    });
    expect(await jobs.list()).toHaveLength(2);
    await jobs.cancel("parent-job");
    expect(methods).toEqual(["GET", "POST"]);
  });

  it("observes owned Jobs without allowing lifecycle changes", async () => {
    const jobs = new ReadOnlyHuggingFaceJobs({
      namespace: "example",
      accessToken: controlToken,
      fetch: async () =>
        new Response(
          JSON.stringify([
            apiJob(),
            { ...apiJob(), id: "unrelated", labels: { other: "value" } },
          ]),
        ),
    });
    expect(await jobs.list()).toHaveLength(1);
    await expect(jobs.startParent(runId)).rejects.toThrow("launch is disabled");
    await expect(jobs.cancel("parent-job")).rejects.toThrow("cancellation is disabled");
  });

  it("rejects a mutable image and keeps local Jobs disabled", async () => {
    expect(
      () =>
        new HuggingFaceJobs({
          namespace: "example",
          accessToken: controlToken,
          inferenceToken,
          bucketId: "example/bucket",
          parentImage: "ghcr.io/example/parent:latest",
        }),
    ).toThrow("immutable");
    const jobs = new NoopJobs();
    expect(await jobs.list()).toEqual([]);
    await expect(jobs.startParent(runId)).rejects.toThrow("disabled");
    await expect(jobs.cancel("none")).resolves.toBeUndefined();
  });
});

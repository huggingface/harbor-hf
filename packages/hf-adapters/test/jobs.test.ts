import { describe, expect, it } from "vitest";
import { NoopJobs, ReadOnlyHuggingFaceJobs } from "../src/index.js";

const runId = "run-0123456789abcdef01234567";
const controlToken = ["hf", "control-placeholder"].join("_");

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

  it("keeps local Jobs disabled", async () => {
    const jobs = new NoopJobs();
    expect(await jobs.list()).toEqual([]);
    await expect(jobs.startParent(runId)).rejects.toThrow("disabled");
    await expect(jobs.cancel("none")).resolves.toBeUndefined();
  });
});

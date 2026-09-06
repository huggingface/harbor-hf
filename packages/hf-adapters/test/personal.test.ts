import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalHuggingFace } from "../src/personal.js";
import {
  cancelJob,
  getJob,
  listFiles,
  listJobs,
  runJob,
  streamJobLogs,
} from "@huggingface/hub";

vi.mock("@huggingface/hub", async (original) => ({
  ...(await original<typeof import("@huggingface/hub")>()),
  runJob: vi.fn(),
  listJobs: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn(),
  listFiles: vi.fn(),
  streamJobLogs: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

describe("personal HF adapter", () => {
  it("redacts the supplied token across provider log chunks", async () => {
    vi.mocked(streamJobLogs).mockImplementation(async function* () {
      yield { message: "hf_user", timestamp: new Date() };
      yield { message: "credential\nready", timestamp: new Date() };
    });
    const client = new PersonalHuggingFace("hf_usercredential");
    expect(await client.logs("example-user", "example-job")).toEqual({
      text: "[REDACTED]\nready",
      bounded_snapshot: true,
    });
  });

  it("lists only the selected private run prefix", async () => {
    vi.mocked(listFiles).mockImplementation(async function* () {
      yield { type: "file", path: "runs/example-run/result.json", size: 2 };
    });
    const client = new PersonalHuggingFace("hf_usercredential", async () =>
      Response.json({ private: true }),
    );
    expect(
      (await client.results("example-user", "private-results", "example-run")).files,
    ).toEqual([{ path: "runs/example-run/result.json", size: 2 }]);
    expect(listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: { type: "bucket", name: "example-user/private-results" },
        path: "runs/example-run",
      }),
    );
  });

  it("previews native artifacts without exposing the supplied token", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ private: true }))
      .mockResolvedValueOnce(new Response("native hf_usercredential output"));
    const client = new PersonalHuggingFace("hf_usercredential", transport);
    expect(
      await client.artifact(
        "example-user",
        "private-results",
        "runs/example-run/runner.log",
      ),
    ).toEqual({
      text: "native [REDACTED] output",
    });
  });

  it("rejects oversized artifact previews", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ private: true }))
      .mockResolvedValueOnce(new Response("x".repeat(256 * 1024 + 1)));
    const client = new PersonalHuggingFace("hf_usercredential", transport);
    await expect(
      client.artifact(
        "example-user",
        "private-results",
        "runs/example-run/result.json",
      ),
    ).rejects.toThrow("preview limit");
  });

  it("delivers only the user token as a server-side Job secret", async () => {
    vi.mocked(runJob).mockResolvedValue({ id: "example-job" } as Awaited<
      ReturnType<typeof runJob>
    >);
    const transport = vi.fn(async () => Response.json({ private: true }));
    const client = new PersonalHuggingFace("hf_usercredential", transport);
    const config = { n_attempts: 1 };
    const result = await client.launch({
      owner: "example-user",
      bucket: "private-results",
      runId: "example-run",
      image: `example/runner@sha256:${"a".repeat(64)}`,
      hardware: "cpu-basic",
      runtimeSeconds: 60,
      jobTimeoutSeconds: 300,
      config,
    });
    const request = vi.mocked(runJob).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      namespace: "example-user",
      accessToken: "hf_usercredential",
      attempts: 1,
      timeoutSeconds: 300,
      secrets: { HARBOR_HF_USER_TOKEN: "hf_usercredential" },
      labels: { "harbor-hf-role": "runner", "harbor-hf-run": "example-run" },
    });
    expect(JSON.stringify(request?.environment)).not.toContain("hf_usercredential");
    expect(JSON.stringify(request?.command)).not.toContain("hf_usercredential");
    expect(
      JSON.parse(
        Buffer.from(
          request?.environment?.HARBOR_HF_CONFIG_B64 ?? "",
          "base64",
        ).toString(),
      ),
    ).toEqual(config);
    expect(result.url).toBe("https://huggingface.co/jobs/example-user/example-job");
  });

  it("refuses a public Bucket before creating a Job", async () => {
    const client = new PersonalHuggingFace("hf_usercredential", async () =>
      Response.json({ private: false }),
    );
    await expect(
      client.launch({
        owner: "example-user",
        bucket: "public-results",
        runId: "example-run",
        image: "unused",
        hardware: "cpu-basic",
        runtimeSeconds: 60,
        jobTimeoutSeconds: 300,
        config: {},
      }),
    ).rejects.toThrow("private");
    expect(runJob).not.toHaveBeenCalled();
  });

  it("never exposes raw Job configuration or secrets", async () => {
    vi.mocked(listJobs).mockResolvedValue([
      {
        id: "example-job",
        status: { stage: "RUNNING" },
        environment: { SENSITIVE: "private" },
        secrets: { TOKEN: "private" },
      },
    ] as Awaited<ReturnType<typeof listJobs>>);
    const client = new PersonalHuggingFace("hf_usercredential");
    expect(JSON.stringify(await client.jobs("example-user"))).not.toContain("private");
  });

  it("cancels only the exact selected Job in the verified namespace", async () => {
    const client = new PersonalHuggingFace("hf_usercredential");
    expect(await client.cancel("example-user", "selected-job")).toEqual({
      parent_cancel_requested: true,
      sandbox_cleanup: "unverified",
    });
    expect(getJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "example-user", jobId: "selected-job" }),
    );
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "example-user", jobId: "selected-job" }),
    );
    expect(listJobs).not.toHaveBeenCalled();
  });
});

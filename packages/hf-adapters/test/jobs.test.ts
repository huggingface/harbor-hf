import { describe, expect, it, vi } from "vitest";
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
      environment: {
        HARBOR_HF_RUN_ID: runId,
        HARBOR_HF_MOUNT_ROOT: "/data",
        HARBOR_HF_NAMESPACE: "example",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "credential.https://huggingface.co.helper",
        GIT_CONFIG_VALUE_1: "harbor-hf",
      },
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
    const { secrets: _secrets, ...secretFreeBody } = body;
    expect(JSON.stringify(secretFreeBody)).not.toContain(controlToken);
    expect(JSON.stringify(body.environment)).not.toMatch(/HF_TOKEN|API_KEY/);
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
          { ...apiJob(), id: "unlabelled", labels: null },
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
    await expect(jobs.inspect("parent-job")).rejects.toThrow("unavailable");
    expect(await jobs.list()).toEqual([]);
    await expect(jobs.startParent(runId)).rejects.toThrow("disabled");
    await expect(jobs.cancel("none")).resolves.toBeUndefined();
  });
});

// Production adapter transport: synthetic source values only, never ambient env.
describe("reviewed provider parent transport", () => {
  it("substitutes one selected ref in the same runJob request without persisting values", async () => {
    const {
      fixture,
      actor,
      image: reviewedImage,
    } = await import("../../control-core/test/inference-fixture.js");
    const { InferenceBindings } = await import("@harbor-hf/control-core");
    const { validateRunRecord } = await import("@harbor-hf/contracts");
    const data = fixture();
    data.manifest.bindings[0]!.source_env = "EXAMPLE_API_KEY";
    const policy = new InferenceBindings(data.manifest);
    const record = validateRunRecord({
      schema_version: "v1",
      run_id: runId,
      created_at: "2026-01-01T00:00:00Z",
      submitted_by: actor,
      role: "diagnostic",
      harbor_revision: "a".repeat(40),
      submission: {
        benchmark: { name: "synthetic", preset: "synthetic" },
        cost_ceiling_usd: 1,
      },
      harbor_job_config: data.job(),
    });
    const before = JSON.stringify(record);
    const requests: Record<string, unknown>[] = [];
    let fail = false;
    const options = {
      namespace: "example",
      accessToken: controlToken,
      inferenceToken,
      bucketId: "example/bucket",
      parentImage: reviewedImage,
      secrets: { UNREVIEWED_API_KEY: "synthetic-must-not-forward" },
      environment: { AMBIENT_VALUE: "synthetic-must-not-forward" },
      fetch: (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        if (fail) throw Error("synthetic-selected-value EXAMPLE_API_KEY");
        return new Response(JSON.stringify(apiJob()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    };
    const jobs = new HuggingFaceJobs(options);
    options.parentImage = image; // Caller mutation cannot replace the reviewed image.
    const reads: string[] = [];
    const read = (source: string) => {
      reads.push(source);
      return "synthetic-selected-value";
    };
    await jobs.startReviewedParent(record, () => policy, read);
    expect(reads).toEqual(["EXAMPLE_API_KEY"]);
    expect(requests[0]?.dockerImage).toBe(reviewedImage);
    expect(requests[0]?.secrets).toEqual({
      HF_TOKEN: controlToken,
      INFERENCE_API_KEY_EXAMPLE: "synthetic-selected-value",
    });
    expect(JSON.stringify(requests[0])).not.toContain("synthetic-must-not-forward");
    expect(JSON.stringify(requests[0]?.environment)).not.toMatch(
      /API_KEY|TOKEN|synthetic-selected/,
    );
    expect(JSON.stringify(record)).toBe(before);
    expect(before).not.toContain("synthetic-selected-value");
    expect(before).not.toContain('"source_env"');
    await expect(
      jobs.startReviewedParent(
        record,
        () => policy,
        () => undefined,
      ),
    ).rejects.toThrow("missing");
    await expect(
      jobs.startReviewedParent(
        { ...record, submitted_by: "ungranted" },
        () => policy,
        read,
      ),
    ).rejects.toThrow("not reviewed");
    expect(requests).toHaveLength(1);
    fail = true;
    await expect(jobs.startReviewedParent(record, () => policy, read)).rejects.toThrow(
      /^Reviewed inference delivery failed$/,
    );
  });
});

describe("paginated Job reads", () => {
  function reader(transport: typeof fetch) {
    return new ReadOnlyHuggingFaceJobs({
      namespace: "example",
      accessToken: controlToken,
      fetch: transport,
    });
  }

  it("reads 100 children then the live parent, following relative and multi-rel Links", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            Array.from({ length: 100 }, (_, i) => ({
              ...apiJob("trial"),
              id: `child-${i}`,
            })),
          ),
          {
            headers: {
              link: '<?cursor=second>; rel="next alternate", </api/jobs/example>; rel="first"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([apiJob()])));
    const values = await reader(transport).list();
    expect(values).toHaveLength(101);
    expect(values.at(-1)?.role).toBe("parent");
    expect(transport.mock.calls[1]?.[0]).toBe(
      "https://huggingface.co/api/jobs/example?cursor=second",
    );
    expect(transport.mock.calls[1]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bearer ${controlToken}` },
    });
  });

  it.each([
    "https://untrusted.invalid/api/jobs/example",
    "//untrusted.invalid/api/jobs/example",
    "http://huggingface.co/api/jobs/example",
    "https://user:password@huggingface.co/api/jobs/example",
    "/api/other",
    "/api/jobs/example#fragment",
  ])("never requests an untrusted next target %s", async (target) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("[]", { headers: { link: `<${target}>; rel=next` } }),
      );
    await expect(reader(transport).list()).rejects.toThrow("Untrusted");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response("unavailable", { status: 503 }),
    new Response("redirect", {
      status: 302,
      headers: { location: "https://untrusted.invalid" },
    }),
    new Response("not json"),
    new Response("{}"),
    new Response(JSON.stringify([{ ...apiJob(), status: { stage: "UNKNOWN" } }])),
    new Response(JSON.stringify([{ ...apiJob(), createdAt: 123 }])),
    new Response(JSON.stringify([{ ...apiJob(), labels: [] }])),
  ])(
    "rejects a failed or malformed later page without partial results",
    async (response) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify([apiJob("trial")]), {
            headers: { link: "<?cursor=second>; rel=next" },
          }),
        )
        .mockResolvedValueOnce(response);
      await expect(reader(transport).list()).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "</api/jobs/example>; rel=next",
    "<?cursor=second>; rel=next, <?cursor=third>; rel=next",
    "malformed",
    '<?cursor=second>; rel="prev"; rel="next"',
  ])("fails closed on loops or malformed Links", async (link) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("[]", { headers: { link } }));
    await expect(reader(transport).list()).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate Jobs across distinct pages", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([apiJob()]), {
          headers: { link: "<?cursor=second>; rel=next" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([apiJob()])));
    await expect(reader(transport).list()).rejects.toThrow("Duplicate Job");
  });

  it.each(["http://untrusted.invalid", "https://user:password@example.invalid"])(
    "rejects unsafe configured endpoints before authentication",
    async (hubUrl) => {
      const transport = vi.fn<typeof fetch>();
      const jobs = new ReadOnlyHuggingFaceJobs({
        namespace: "example",
        accessToken: controlToken,
        hubUrl,
        fetch: transport,
      });
      await expect(jobs.list()).rejects.toThrow("Untrusted");
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["UPDATING", "running"],
    ["PENDING", "queued"],
    ["SCHEDULING", "queued"],
    ["ERROR", "error"],
    ["COMPLETED", "stopped"],
    ["CANCELED", "stopped"],
    ["DELETED", "stopped"],
    ["STOPPED", "stopped"],
    ["PAUSED", "stopped"],
    ["DELETING", "stopped"],
  ])("validates native stage %s", async (stage, expected) => {
    const jobs = new HuggingFaceJobs({
      namespace: "example",
      accessToken: controlToken,
      inferenceToken,
      bucketId: "example/bucket",
      parentImage: image,
      hubUrl: "https://example.invalid",
      fetch: async () =>
        new Response(JSON.stringify({ ...apiJob(), status: { stage } })),
    });
    expect((await jobs.inspect("parent-job")).stage).toBe(expected);
  });

  it.each([
    null,
    { ...apiJob(), id: "" },
    { ...apiJob(), labels: { "harbor-hf-run": 123 } },
    { ...apiJob(), startedAt: 42 },
  ])("rejects malformed inspected metadata", async (value) => {
    await expect(
      reader(async () => new Response(JSON.stringify(value))).inspect("parent-job"),
    ).rejects.toThrow();
  });

  it.each(["", ".", ".."])(
    "rejects invalid inspection identities before requesting",
    async (id) => {
      const transport = vi.fn<typeof fetch>();
      await expect(reader(transport).inspect(id)).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("directly inspects the requested Job with redirects disabled", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(apiJob())));
    expect(await reader(transport).inspect("parent-job")).toMatchObject({
      id: "parent-job",
      stage: "running",
    });
    expect(transport.mock.calls[0]?.[0]).toBe(
      "https://huggingface.co/api/jobs/example/parent-job",
    );
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it.each([
    new Response("missing", { status: 404 }),
    new Response(JSON.stringify(apiJob("trial"))),
    new Response(JSON.stringify({ ...apiJob(), labels: {} })),
  ])("fails closed on missing or mismatched inspection", async (response) => {
    await expect(reader(async () => response).inspect("parent-job")).rejects.toThrow();
  });
});

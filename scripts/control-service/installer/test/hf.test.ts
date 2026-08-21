import { describe, expect, it } from "vitest";
import { HfCli, HfCommandFailure } from "../hf.js";
import {
  type ProcessAdapter,
  ProcessFailure,
  type ProcessRequest,
} from "../process.js";

class QueueProcess implements ProcessAdapter {
  readonly requests: ProcessRequest[] = [];

  constructor(private readonly responses: unknown[]) {}

  async runJson(request: ProcessRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.responses.length === 0) throw new Error("unexpected process call");
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }

  async runSecretText(request: ProcessRequest): Promise<string> {
    this.requests.push(request);
    if (this.responses.length === 0) throw new Error("unexpected process call");
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response !== "string") throw new Error("expected secret text");
    return response;
  }
}

describe("Hugging Face CLI adapter", () => {
  it("accepts the compatible CLI range with structured JSON", async () => {
    const processAdapter = new QueueProcess([{ version: "1.23.7" }]);
    const hf = new HfCli(processAdapter);
    await expect(hf.version()).resolves.toBe("1.23.7");
    expect(processAdapter.requests[0]?.args.slice(-2)).toEqual(["--format", "json"]);
    await expect(
      new HfCli(new QueueProcess([{ version: "1.25.1" }])).version(),
    ).resolves.toBe("1.25.1");
    for (const version of ["1.22.9", "2.0.0", "1.25.1rc1", "invalid"]) {
      await expect(
        new HfCli(new QueueProcess([{ version }])).version(),
      ).rejects.toThrow(">=1.23.0");
    }
  });

  it("uses the CLI raw-token exception without adding the token to argv", async () => {
    const processAdapter = new QueueProcess(["token-placeholder"]);
    await expect(new HfCli(processAdapter).authToken()).resolves.toBe(
      "token-placeholder",
    );
    expect(processAdapter.requests[0]?.args).toEqual(["auth", "token"]);
  });

  it("propagates only a sanitized provider failure category", async () => {
    const hf = new HfCli(
      new QueueProcess([new ProcessFailure("nonzero", "forbidden")]),
    );
    await expect(hf.version()).rejects.toEqual(new HfCommandFailure("forbidden"));
  });

  it("creates protected rather than private Spaces without exist-ok", async () => {
    const processAdapter = new QueueProcess([
      {
        repo_id: "example/control",
        url: "https://huggingface.co/spaces/example-org/control",
      },
    ]);
    await new HfCli(processAdapter).createSpace(
      "example/control",
      "/tmp/variables.env",
      "/tmp/secrets.env",
    );
    const args = processAdapter.requests[0]?.args ?? [];
    expect(args).toContain("--protected");
    expect(args).toContain("--no-exist-ok");
    expect(args).not.toContain("--private");
  });

  it("creates bootstrap Spaces without transferring service secrets", async () => {
    const processAdapter = new QueueProcess([
      {
        repo_id: "example/control",
        url: "https://huggingface.co/spaces/example-org/control",
      },
    ]);
    await new HfCli(processAdapter).createSpace(
      "example/control",
      "/tmp/variables.env",
    );
    const args = processAdapter.requests[0]?.args ?? [];
    expect(args).toContain("--no-exist-ok");
    expect(args).not.toContain("--secrets-file");
  });

  it("classifies exact target absence from complete namespace listings", async () => {
    const processAdapter = new QueueProcess([
      { items: [{ id: "example/unrelated" }], next: null },
      { buckets: [{ id: "example/unrelated-artifacts" }] },
    ]);
    const state = await new HfCli(processAdapter).observe(
      "example",
      "example/control",
      "example/control-artifacts",
    );
    expect(state).toEqual({
      namespaceListingsComplete: true,
      space: null,
      bucket: null,
    });
    expect(JSON.stringify(state)).not.toContain("unrelated");
  });

  it("normalizes bounded flexible existing target envelopes", async () => {
    const variables = {
      HARBOR_HF_INSTALLER_MARKER: "harbor-hf.install-plan.v1",
    };
    const processAdapter = new QueueProcess([
      { spaces: [{ id: "example/control" }] },
      [{ id: "example/control-artifacts" }],
      {
        data: {
          id: "example/control",
          private: true,
          sdk: "Docker",
          subdomain: "placeholder-control",
          sha: "a".repeat(40),
          runtime: {
            stage: "RUNNING",
            hardware: "cpu-basic",
            requested_hardware: "cpu-basic",
          },
        },
      },
      { variables },
      { secrets: [{ key: "HF_TOKEN" }, { key: "HF_INFERENCE_TOKEN" }] },
      {
        result: {
          id: "example/control-artifacts",
          is_private: true,
        },
      },
    ]);
    const state = await new HfCli(processAdapter).observe(
      "example",
      "example/control",
      "example/control-artifacts",
    );
    expect(state.space).toMatchObject({
      id: "example/control",
      private: true,
      sdk: "docker",
      origin: "https://placeholder-control.hf.space",
      runtimeStage: "RUNNING",
      hardware: "cpu-basic",
      requestedHardware: "cpu-basic",
      variables,
      secretNames: ["HF_INFERENCE_TOKEN", "HF_TOKEN"],
    });
    expect(state.bucket).toEqual({
      id: "example/control-artifacts",
      private: true,
    });
  });

  it("accepts first-build metadata with only requested hardware", async () => {
    const processAdapter = new QueueProcess([
      [{ id: "example/control" }],
      [],
      {
        id: "example/control",
        private: true,
        sdk: "docker",
        subdomain: "placeholder-control",
        sha: null,
        runtime: {
          stage: "BUILDING",
          hardware: null,
          requested_hardware: "cpu-basic",
        },
      },
      [],
      [],
    ]);
    const state = await new HfCli(processAdapter).observe(
      "example",
      "example/control",
      "example/control-artifacts",
    );
    expect(state.space).toMatchObject({
      hardware: null,
      requestedHardware: "cpu-basic",
      runtimeStage: "BUILDING",
    });
  });

  it("fails closed on pagination, unknown shapes, and list failures", async () => {
    await expect(
      new HfCli(new QueueProcess([{ items: [], next: "another-page" }])).observe(
        "example",
        "example/control",
        "example/control-artifacts",
      ),
    ).rejects.toThrow("paginated");
    await expect(
      new HfCli(new QueueProcess([{ unknown: true }])).observe(
        "example",
        "example/control",
        "example/control-artifacts",
      ),
    ).rejects.toThrow("list JSON");
    await expect(
      new HfCli(new QueueProcess([new Error("list failed")])).observe(
        "example",
        "example/control",
        "example/control-artifacts",
      ),
    ).rejects.toThrow("list failed");
  });

  it("binds upload success to a commit SHA without putting secrets in argv", async () => {
    const processAdapter = new QueueProcess([
      {
        url: `https://huggingface.co/spaces/example-org/control/commit/${"d".repeat(40)}`,
      },
    ]);
    const sha = await new HfCli(processAdapter).uploadMirror(
      "example-org/control",
      "/tmp/bundle",
      "a".repeat(40),
    );
    expect(sha).toBe("d".repeat(40));
    expect(processAdapter.requests[0]?.args).toContain("--delete");
    expect(processAdapter.requests[0]?.args.join(" ")).not.toContain("TOKEN=");
  });

  it("accepts exact Bucket creation and restart envelopes", async () => {
    const processAdapter = new QueueProcess([
      {
        uri: "hf://buckets/example-org/control-artifacts",
        url: "https://huggingface.co/buckets/example-org/control-artifacts",
      },
      {
        space_id: "example/control",
        stage: "BUILDING",
        factory_reboot: false,
      },
    ]);
    const hf = new HfCli(processAdapter);
    await expect(
      hf.createBucket("example-org/control-artifacts", "example-user"),
    ).resolves.toBeUndefined();
    expect(processAdapter.requests[0]?.args).toContain("example-org/control-artifacts");
    await expect(hf.restart("example/control")).resolves.toBeUndefined();
    await expect(
      new HfCli(
        new QueueProcess([
          {
            uri: "hf://buckets/example-org/other",
            url: "https://huggingface.co/buckets/example-org/other",
          },
        ]),
      ).createBucket("example-org/control-artifacts", "example-user"),
    ).rejects.toThrow("unexpected target");
  });

  it("uses a bare Bucket name for the authenticated user's namespace", async () => {
    const processAdapter = new QueueProcess([
      {
        uri: "hf://buckets/example-org/control-artifacts",
        url: "https://huggingface.co/buckets/example-org/control-artifacts",
      },
    ]);
    await expect(
      new HfCli(processAdapter).createBucket(
        "example-org/control-artifacts",
        "example-org",
      ),
    ).resolves.toBeUndefined();
    expect(processAdapter.requests[0]?.args).toContain("control-artifacts");
    expect(processAdapter.requests[0]?.args).not.toContain(
      "example-org/control-artifacts",
    );
  });
});

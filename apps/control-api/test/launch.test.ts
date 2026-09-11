import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { lookupHuggingFaceHardware } from "../src/huggingface-hardware.js";
import { lookupHuggingFaceModelProviders } from "../src/huggingface-models.js";
import { NativeLaunch } from "../src/launch.js";

const hardware = {
  name: "cpu-basic",
  prettyName: "CPU Basic",
  cpu: "2 vCPU",
  ram: "16 GB",
  ephemeralStorage: "50 GB",
  accelerator: null,
  unitCostUSD: 0.000167,
  unitLabel: "minute",
};
vi.mock("../src/huggingface-hardware.js", () => ({
  lookupHuggingFaceHardware: vi.fn(),
}));

vi.mock("../src/huggingface-models.js", () => ({
  lookupHuggingFaceModelProviders: vi.fn(async () => ["provider"]),
}));
const roots: string[] = [];
const revision = "dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e";
const input = {
  datasets: [{ name: "example/dataset", ref: `sha256:${"a".repeat(64)}` }],
  agents: [
    {
      name: "openclaw",
      model_name: "openai/example/model:provider",
      kwargs: { version: "2026.7.1-2" },
    },
  ],
};
const inspection = {
  harbor_revision: revision,
  tasks: 2,
  agents: 1,
  trials: 2,
  warnings: [],
  not_performed: ["Model inference"],
};

async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "launch-inspector-test-"));
  roots.push(root);
  const executable = join(root, "inspector.mjs");
  await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return {
    ...loadConfig({
      NODE_ENV: "test",
      HARBOR_HF_NAMESPACE: "test",
      HARBOR_HF_BUCKET_ID: "test/artifacts",
      HARBOR_HF_AUTH_MODE: "development",
      HARBOR_HF_STORE_MODE: "filesystem",
    }),
    launch_python: executable,
  };
}
beforeEach(() => {
  vi.mocked(lookupHuggingFaceHardware).mockResolvedValue([hardware]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(lookupHuggingFaceModelProviders).mockResolvedValue(["provider"]);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded native inspector", () => {
  it("checks the selected flavor against the current HF catalog without rewriting it", async () => {
    const config = await fixture(
      `console.log(${JSON.stringify(JSON.stringify(inspection))});`,
    );
    const launch = new NativeLaunch(config);
    const gpu = {
      ...input,
      environment: { type: "hf-sandbox", kwargs: { flavor: "a100-large" } },
    };
    await expect(launch.validate(gpu)).rejects.toMatchObject({ status: 400 });
    vi.mocked(lookupHuggingFaceHardware).mockResolvedValue([
      { ...hardware, name: "a100-large" },
    ]);
    expect((await launch.validate(gpu)).effective_config).toMatchObject({
      environment: { kwargs: { flavor: "a100-large" } },
    });
  });
  it("rejects concurrent inspection instead of starting a queue", async () => {
    const config = await fixture(
      `console.log(${JSON.stringify(JSON.stringify({ harbor_revision: revision, agents: [], job_schema: {} }))});`,
    );
    const launch = new NativeLaunch(config);
    const first = launch.catalog();
    await expect(launch.validate(input)).rejects.toThrow("busy");
    await first;
  });
  it("times out a stuck process and releases inspection capacity", async () => {
    const timer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay: number,
    ) => timer(callback, delay === 90000 ? 50 : delay)) as typeof setTimeout);
    const config = await fixture("setInterval(() => {}, 1000);");
    const launch = new NativeLaunch(config);
    await expect(launch.catalog()).rejects.toThrow("exceeded 90 seconds");
    await expect(launch.catalog()).rejects.toThrow("exceeded 90 seconds");
  });
  it("rejects invalid native response shapes, invalid config, and a missing provider", async () => {
    const broken = await fixture('console.log("not JSON");');
    await expect(new NativeLaunch(broken).catalog()).rejects.toThrow(
      "invalid response",
    );
    const shape = await fixture('console.log("{}");');
    await expect(new NativeLaunch(shape).catalog()).rejects.toThrow("contract");
    await expect(new NativeLaunch(shape).validate(input)).rejects.toThrow("contract");
    const badRevision = await fixture(
      `console.log(${JSON.stringify(JSON.stringify({ ...inspection, harbor_revision: "wrong" }))});`,
    );
    await expect(new NativeLaunch(badRevision).validate(input)).rejects.toThrow(
      "revision mismatch",
    );
    const config = await fixture(
      `console.log(${JSON.stringify(JSON.stringify(inspection))});`,
    );
    const launch = new NativeLaunch(config);
    await expect(
      launch.validate({ ...input, jobs_dir: "/tmp/not-admitted" }),
    ).rejects.toThrow("JobConfig");
    await expect(
      launch.validate({
        ...input,
        agents: [{ ...input.agents[0], model_name: "openai/example/model" }],
      }),
    ).rejects.toThrow("explicit HF provider");
  });
  it("returns safe native admission errors and decodes split UTF-8", async () => {
    const rejected = await fixture(
      'console.log(JSON.stringify({error:"Source is not admitted",invalid:true})); process.exit(1);',
    );
    await expect(new NativeLaunch(rejected).validate(input)).rejects.toMatchObject({
      status: 400,
      message: "Source is not admitted",
    });
    const content = JSON.stringify({
      harbor_revision: revision,
      agents: [],
      job_schema: { title: "🍀" },
    });
    const split = await fixture(
      `const data=Buffer.from(${JSON.stringify(content)}); const index=data.indexOf(Buffer.from("🍀"))+2; process.stdout.write(data.subarray(0,index)); setTimeout(()=>process.stdout.write(data.subarray(index)),10);`,
    );
    expect((await new NativeLaunch(split).catalog()).job_schema.title).toBe("🍀");
  });
  it("removes inherited credentials and caches a pinned catalog", async () => {
    vi.stubEnv("HF_TOKEN", "test-only-control-value");
    vi.stubEnv("HF_INFERENCE_TOKEN", "test-only-inference-value");
    const config = await fixture(
      `if (process.env.HF_TOKEN || process.env.HF_INFERENCE_TOKEN || process.env.GITHUB_TOKEN) process.exit(9); console.log(${JSON.stringify(JSON.stringify({ harbor_revision: revision, agents: [], job_schema: {} }))});`,
    );
    const launch = new NativeLaunch({
      ...config,
      hf_token: "test-only-control-value",
      hf_inference_token: "test-only-inference-value",
    });
    const first = await launch.catalog();
    expect(first.harbor_revision).toBe(revision);
    expect(await launch.catalog()).toBe(first);
  });
  it("gives only validation the host-restricted Git credential bridge", async () => {
    const token = ["test", "control", "credential"].join("-");
    const config = await fixture(`
      if (process.env.HF_TOKEN !== ${JSON.stringify(token)}) process.exit(10);
      if (process.env.HF_INFERENCE_TOKEN || process.env.GITHUB_TOKEN) process.exit(17);
      if (process.env.GIT_CONFIG_COUNT !== "2") process.exit(11);
      if (process.env.GIT_CONFIG_KEY_0 !== "credential.helper") process.exit(12);
      if (process.env.GIT_CONFIG_VALUE_0 !== "") process.exit(13);
      if (process.env.GIT_CONFIG_KEY_1 !== "credential.https://huggingface.co.helper") process.exit(14);
      if (process.env.GIT_CONFIG_VALUE_1 !== "harbor-hf") process.exit(15);
      if (process.argv.some((value) => value.includes(${JSON.stringify(token)}))) process.exit(16);
      console.log(${JSON.stringify(JSON.stringify(inspection))});
    `);

    const result = await new NativeLaunch({
      ...config,
      hf_token: token,
      hf_inference_token: "test-inference-credential",
    }).validate(input);

    expect(JSON.stringify(result)).not.toContain(token);
  });
  it("prepares native config, checks provider availability and fingerprints current policy", async () => {
    const config = await fixture(
      `console.log(${JSON.stringify(JSON.stringify(inspection))});`,
    );
    const launch = new NativeLaunch({
      ...config,
      hf_token: "test-control",
      hf_inference_token: "test-inference",
    });
    const result = await launch.validate(input);
    expect(result.trials).toBe(2);
    expect(result.credentials_available).toBe(true);
    expect(result.effective_config.environment).toMatchObject({
      kwargs: { run_label: "run-000000000000000000000000" },
    });
    expect((await launch.validate(input)).fingerprint).toBe(result.fingerprint);
    expect(
      (
        await new NativeLaunch({ ...config, source_revision: "different" }).validate(
          input,
        )
      ).fingerprint,
    ).not.toBe(result.fingerprint);
    vi.mocked(lookupHuggingFaceModelProviders).mockResolvedValue([]);
    await expect(launch.validate(input)).rejects.toThrow(
      "provider is not currently available",
    );
  });
  it("deduplicates model checks and limits concurrent Hub requests", async () => {
    const config = await fixture(
      `console.log(${JSON.stringify(JSON.stringify(inspection))});`,
    );
    let active = 0;
    let maximum = 0;
    const lookup = vi.mocked(lookupHuggingFaceModelProviders).mockClear();
    lookup.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return ["provider", "other"];
    });
    await new NativeLaunch(config).validate({
      ...input,
      agents: Array.from({ length: 100 }, (_, index) => ({
        ...input.agents[0],
        model_name: `openai/example/model-${index % 10}:${index < 50 ? "provider" : "other"}`,
      })),
    });
    expect(lookup).toHaveBeenCalledTimes(10);
    expect(maximum).toBe(4);
  });
  it("uses one deadline and stops queued model checks after it expires", async () => {
    const config = await fixture(
      `console.log(${JSON.stringify(JSON.stringify(inspection))});`,
    );
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const lookup = vi.mocked(lookupHuggingFaceModelProviders).mockClear();
    lookup.mockImplementation(async (_model, signal) => {
      deadline.abort();
      signal?.throwIfAborted();
      return ["provider"];
    });
    await expect(
      new NativeLaunch(config).validate({
        ...input,
        agents: Array.from({ length: 20 }, (_, index) => ({
          ...input.agents[0],
          model_name: `openai/example/model-${index}:provider`,
        })),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it("cancels in-flight model checks on provider rejection", async () => {
    const config = await fixture(
      `console.log(${JSON.stringify(JSON.stringify(inspection))});`,
    );
    let cancelled = 0;
    const lookup = vi.mocked(lookupHuggingFaceModelProviders).mockClear();
    lookup.mockImplementation(async (model, signal) => {
      if (model.endsWith("-0")) return [];
      return new Promise<string[]>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            cancelled++;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    });
    await expect(
      new NativeLaunch(config).validate({
        ...input,
        agents: Array.from({ length: 10 }, (_, index) => ({
          ...input.agents[0],
          model_name: `openai/example/model-${index}:provider`,
        })),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(cancelled).toBe(3);
  });
  it("does not treat one reused credential as separate credentials", async () => {
    const config = await fixture(
      `console.log(${JSON.stringify(JSON.stringify(inspection))});`,
    );
    const result = await new NativeLaunch({
      ...config,
      hf_token: "same-test-value",
      hf_inference_token: "same-test-value",
    }).validate(input);
    expect(result.credentials_available).toBe(false);
  });
  it("fails closed on native revision mismatch and process errors", async () => {
    const wrong = await fixture(
      `console.log(${JSON.stringify(JSON.stringify({ harbor_revision: "wrong", agents: [], job_schema: {} }))});`,
    );
    await expect(new NativeLaunch(wrong).catalog()).rejects.toThrow(
      "revision mismatch",
    );
    const failure = await fixture(
      'console.log(JSON.stringify({error:"Native inspection failed"})); process.exit(1);',
    );
    await expect(new NativeLaunch(failure).catalog()).rejects.toThrow(
      "Native inspection failed",
    );
    await expect(
      new NativeLaunch({
        ...failure,
        launch_python: join(failure.launch_python, "missing"),
      }).catalog(),
    ).rejects.toThrow("unavailable");
  });
  it("kills an inspector that exceeds the response limit", async () => {
    const config = await fixture(
      'process.stdout.write("x".repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);',
    );
    await expect(new NativeLaunch(config).catalog()).rejects.toThrow(
      "exceeded its limit",
    );
  });
});

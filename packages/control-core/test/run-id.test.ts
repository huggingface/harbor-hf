import { sha256 } from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";
import { runIdentity, runtimeKind, runUnique, slugSegment } from "../src/run-id.js";

describe("run identity", () => {
  it("names a run from model, harness, reasoning, and runtime", () => {
    expect(
      runIdentity({
        model: "gpt-oss-20b",
        harness: "opencode",
        reasoning: "off",
        runtime: "providers",
        unique: "a1b2c3d4e5f6",
      }),
    ).toBe("run-gpt-oss-20b-opencode-off-providers-a1b2c3d4e5f6");
  });

  it("keeps the same idempotency key on the same unique suffix", () => {
    const keyDigest = sha256("stable-key");
    expect(runUnique("test", "operator-1", keyDigest)).toBe(
      runUnique("test", "operator-1", keyDigest),
    );
    expect(runUnique("test", "operator-1", keyDigest)).not.toBe(
      runUnique("test", "operator-1", sha256("other-key")),
    );
  });

  it("classifies provider and endpoint runtimes from the deployment spec", () => {
    expect(
      runtimeKind({
        route: "hf_job",
        models: ["gpt-oss-20b"],
        harnesses: ["opencode"],
        job_image: "example.invalid/worker@sha256:aa",
        job_command: ["true"],
        hardware: "cpu-basic",
        timeout_seconds: 1,
        trusted_worker: true,
        inference_provider: "together",
      }),
    ).toBe("providers");
    expect(
      runtimeKind({
        route: "hf_job",
        models: ["gpt-oss-20b"],
        harnesses: ["opencode"],
        job_image: "example.invalid/worker@sha256:aa",
        job_command: ["true"],
        hardware: "cpu-basic",
        timeout_seconds: 1,
        trusted_worker: true,
        trial_job_template: {
          flavors: [
            {
              hardware: "cpu-basic",
              cpus: 1,
              memory_mb: 1024,
              storage_mb: 1024,
              gpus: 0,
              active_hourly_cost_microusd: 1,
            },
          ],
          max_jobs: 1,
          inference_upstream: "https://endpoints.huggingface.cloud/v1",
        },
      }),
    ).toBe("endpoints");
    expect(
      runtimeKind({
        route: "hf_job",
        models: ["control-smoke"],
        harnesses: ["control-smoke"],
        job_image: "example.invalid/worker@sha256:aa",
        job_command: ["true"],
        hardware: "cpu-basic",
        timeout_seconds: 1,
        trusted_worker: true,
      }),
    ).toBe("none");
  });

  it("rejects an empty identity segment", () => {
    expect(() => slugSegment("???")).toThrow("run identity segment is empty");
  });
});

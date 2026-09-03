import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const environment = {
  NODE_ENV: "test",
  HARBOR_HF_NAMESPACE: "test",
  HARBOR_HF_BUCKET_ID: "test/artifacts",
  HARBOR_HF_AUTH_MODE: "oauth",
  OAUTH_CLIENT_ID: "client-id",
  OAUTH_CLIENT_SECRET: "client-secret",
  OPENID_PROVIDER_URL: "https://identity.example",
};

describe("control API configuration", () => {
  it("normalizes an origin trailing slash before deriving OAuth URLs", () => {
    const config = loadConfig({
      ...environment,
      HARBOR_HF_PUBLIC_ORIGIN: "https://control.example/",
    });

    expect(config.public_origin).toBe("https://control.example");
    expect(config.oauth?.callback_url).toBe("https://control.example/auth/callback");
  });

  it("loads the nonsecret capacity profile alias", () => {
    const config = loadConfig({
      ...environment,
      HARBOR_HF_CAPACITY_PROFILE_ALIAS: "capacity-current",
    });

    expect(config.capacity_profile_alias).toBe("capacity-current");
    expect(config.max_active_jobs).toBe(16);
  });

  it("loads an explicit namespace Job cap", () => {
    const config = loadConfig({
      ...environment,
      HARBOR_HF_MAX_ACTIVE_JOBS: "128",
    });

    expect(config.max_active_jobs).toBe(128);
  });

  it("loads the task image mirror repository", () => {
    expect(loadConfig(environment).task_image_mirror_repository).toBe(
      "ghcr.io/huggingface/harbor-hf-trial-worker",
    );
    const config = loadConfig({
      ...environment,
      HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY: "mirror.example/harbor-hf/tasks",
    });

    expect(config.task_image_mirror_repository).toBe("mirror.example/harbor-hf/tasks");
  });

  it("uses a 30-second Bucket sync cadence unless configured", () => {
    expect(loadConfig(environment).sync_interval_ms).toBe(30_000);
    expect(
      loadConfig({
        ...environment,
        HARBOR_HF_SYNC_INTERVAL_MS: "45000",
      }).sync_interval_ms,
    ).toBe(45_000);
  });

  it("keeps Workbench setup disabled outside development unless configured", () => {
    const defaultConfig = loadConfig(environment);
    expect(defaultConfig.workbench_runner).toBe("disabled");
    expect(defaultConfig.workbench_image).toBe("python:3.12-slim");

    const developmentConfig = loadConfig({
      ...environment,
      NODE_ENV: "development",
    });
    expect(developmentConfig.workbench_runner).toBe("docker");

    const configured = loadConfig({
      ...environment,
      HARBOR_HF_WORKBENCH_RUNNER: "docker",
      HARBOR_HF_WORKBENCH_IMAGE: "example.invalid/agent-setup@sha256:test",
    });
    expect(configured.workbench_runner).toBe("docker");
    expect(configured.workbench_image).toBe("example.invalid/agent-setup@sha256:test");

    const remote = loadConfig({
      ...environment,
      HF_TOKEN: "control-test-credential",
      HARBOR_HF_WORKBENCH_RUNNER: "hf-jobs",
      HARBOR_HF_WORKBENCH_IMAGE: "example.invalid/agent-setup@sha256:remote",
    });
    expect(remote.workbench_runner).toBe("hf-jobs");
    expect(remote.workbench_image).toBe("example.invalid/agent-setup@sha256:remote");
  });

  it("requires the control credential for Hugging Face Workbench Jobs", () => {
    expect(() =>
      loadConfig({
        ...environment,
        HARBOR_HF_WORKBENCH_RUNNER: "hf-jobs",
      }),
    ).toThrow("Hugging Face Workbench Jobs require HF_TOKEN");
  });

  it("loads a distinct worker inference credential without exposing it elsewhere", () => {
    const config = loadConfig({
      ...environment,
      HF_TOKEN: "control-test-credential",
      HF_INFERENCE_TOKEN: "inference-test-credential",
    });

    expect(config.hf_token).toBe("control-test-credential");
    expect(config.hf_inference_token).toBe("inference-test-credential");
  });

  it("rejects reuse of the control credential for inference", () => {
    expect(() =>
      loadConfig({
        ...environment,
        HF_TOKEN: "shared-test-credential",
        HF_INFERENCE_TOKEN: "shared-test-credential",
      }),
    ).toThrow("control and inference credentials must be distinct");
  });

  it.each([
    "https://control.example/base",
    "https://control.example/?query=value",
    "https://control.example/#fragment",
    "ftp://control.example/",
  ])("rejects a public URL that is not an HTTP origin: %s", (publicOrigin) => {
    expect(() =>
      loadConfig({
        ...environment,
        HARBOR_HF_PUBLIC_ORIGIN: publicOrigin,
      }),
    ).toThrow("public origin must contain only an HTTP or HTTPS origin");
  });
});

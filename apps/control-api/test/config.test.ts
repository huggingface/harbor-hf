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
  it("loads the simplified defaults", () => {
    const config = loadConfig(environment);
    expect(config.store_mode).toBe("filesystem");
    expect(config.max_active_jobs).toBe(16);
    expect(config.parent_hardware).toBe("cpu-basic");
    expect(config.parent_timeout_seconds).toBe(86_400);
    expect(config.write_mode).toBe("disabled");
  });

  it("normalizes an origin trailing slash before deriving OAuth URLs", () => {
    const config = loadConfig({
      ...environment,
      HARBOR_HF_PUBLIC_ORIGIN: "https://control.example/",
    });
    expect(config.public_origin).toBe("https://control.example");
    expect(config.oauth?.callback_url).toBe("https://control.example/auth/callback");
  });

  it("loads parent Job controls", () => {
    const config = loadConfig({
      ...environment,
      HARBOR_HF_MAX_ACTIVE_JOBS: "128",
      HARBOR_HF_PARENT_HARDWARE: "cpu-upgrade",
      HARBOR_HF_PARENT_TIMEOUT_SECONDS: "3600",
    });
    expect(config.max_active_jobs).toBe(128);
    expect(config.parent_hardware).toBe("cpu-upgrade");
    expect(config.parent_timeout_seconds).toBe(3_600);
  });

  it("rejects development authentication in production", () => {
    expect(() =>
      loadConfig({
        ...environment,
        NODE_ENV: "production",
        HARBOR_HF_AUTH_MODE: "development",
      }),
    ).toThrow("production service requires OAuth authentication");
  });

  it("requires two distinct credentials and an immutable image in write mode", () => {
    expect(() =>
      loadConfig({ ...environment, HARBOR_HF_WRITE_MODE: "enabled" }),
    ).toThrow("both approved credentials");
    expect(() =>
      loadConfig({
        ...environment,
        HARBOR_HF_WRITE_MODE: "enabled",
        HF_TOKEN: "control-test-credential",
        HF_INFERENCE_TOKEN: "inference-test-credential",
        HARBOR_HF_PARENT_IMAGE: "example/parent:latest",
      }),
    ).toThrow("immutable digest");

    expect(() =>
      loadConfig({
        ...environment,
        HARBOR_HF_WRITE_MODE: "enabled",
        HF_TOKEN: "control-test-credential",
        HF_INFERENCE_TOKEN: "inference-test-credential",
        HARBOR_HF_PARENT_IMAGE: `example/parent@sha256:${"a".repeat(64)}`,
      }),
    ).toThrow("requires Bucket storage");

    const config = loadConfig({
      ...environment,
      HARBOR_HF_WRITE_MODE: "enabled",
      HARBOR_HF_STORE_MODE: "bucket",
      HF_TOKEN: "control-test-credential",
      HF_INFERENCE_TOKEN: "inference-test-credential",
      HARBOR_HF_PARENT_IMAGE: `example/parent@sha256:${"a".repeat(64)}`,
    });
    expect(config.write_mode).toBe("enabled");
    expect(config.parent_image).toContain("@sha256:");
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

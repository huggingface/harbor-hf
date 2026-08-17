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

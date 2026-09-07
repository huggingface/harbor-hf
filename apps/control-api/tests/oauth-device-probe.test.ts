import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const now = Date.parse("2026-09-04T12:00:00Z");
const until = "2026-09-04T12:05:00Z";
const canary = "private-response-canary";
const config = () =>
  loadConfig({
    NODE_ENV: "production",
    HARBOR_HF_NAMESPACE: "example",
    HARBOR_HF_BUCKET_ID: "example/artifacts",
    OAUTH_CLIENT_ID: "example-client",
    OAUTH_CLIENT_SECRET: "example-secret",
    OPENID_PROVIDER_URL: "https://huggingface.co",
  });
const accepted = () =>
  Response.json({
    device_code: canary,
    user_code: canary,
    verification_uri: `https://example.com/${canary}`,
    expires_in: 300,
  });

beforeEach(() => vi.resetModules());

async function probe() {
  return (await import("../src/oauth-device-probe.js")).probeDeviceEligibility;
}

describe("bounded device eligibility startup diagnostic", () => {
  it.each([
    undefined,
    "",
    "bad",
    "2026-09-04T11:59:59Z",
    "2026-09-04T12:00:00Z",
    "2026-09-04T12:10:01Z",
    "2026-09-04T12:05:00+00:00",
  ])("does not request outside an explicit valid window: %s", async (gate) => {
    const request = vi.fn<typeof fetch>();
    const poisoned = new Proxy(config(), {
      get() {
        throw new Error("must not resolve credentials");
      },
    });
    expect(await (await probe())(poisoned, gate, request, () => now)).toBe(
      gate ? "invalidwindow" : "disabled",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("requests only issuance, once per process; never returns grant contents", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(accepted());
    const run = await probe();
    expect(await run(config(), until, request, () => now)).toBe("accepted");
    expect(await run(config(), until, request, () => now)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe("https://huggingface.co/oauth/device");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      body: "scope=openid+profile",
      headers: {
        authorization: `Basic ${Buffer.from("example-client:example-secret").toString("base64")}`,
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a later process can repeat within the window but cannot replay after expiry", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => accepted());
    expect(await (await probe())(config(), until, request, () => now)).toBe("accepted");
    vi.resetModules();
    expect(await (await probe())(config(), until, request, () => now)).toBe("accepted");
    vi.resetModules();
    expect(await (await probe())(config(), until, request, () => now + 600_000)).toBe(
      "invalidwindow",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    "invalid_client",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
    "invalid_request",
    "access_denied",
    canary,
  ])("returns only closed rejection category: %s", async (error) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error, error_description: canary }, { status: 400 }),
      );
    expect(await (await probe())(config(), until, request, () => now)).toBe(
      `rejected:${error === canary ? "unknown" : error}`,
    );
  });

  it.each([
    () =>
      new Response(canary, {
        status: 302,
        headers: { location: `https://example.com/${canary}` },
      }),
    () => new Response(canary),
    () => new Response(`"${canary.repeat(3000)}"`),
    () => Response.json({ device_code: canary }),
    () => Response.json(null),
    () => new Response(null),
  ])(
    "rejects redirects, malformed, oversized or incomplete responses",
    async (response) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(response());
      expect(await (await probe())(config(), until, request, () => now)).toBe(
        "invalidresponse",
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([200, 302])("hides stream cancellation failures: %s", async (status) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024 + 1));
      },
      cancel() {
        throw new Error(canary);
      },
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status }));
    expect(await (await probe())(config(), until, request, () => now)).toBe(
      "invalidresponse",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds requests to ten seconds and hides transport exception text without retry", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error(canary));
    const run = await probe();
    expect(await run(config(), until, request, () => now)).toBe("transporterror");
    expect(await run(config(), until, request, () => now)).toBeNull();
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(request).toHaveBeenCalledTimes(1);
    timeout.mockRestore();
  });

  it.each(["issuer", "writes", "development", "missing"])(
    "rejects unsafe configuration: %s",
    async (mode) => {
      const value = config();
      if (mode === "issuer" && value.oauth) value.oauth.issuer = "https://example.com";
      if (mode === "writes") value.write_mode = "enabled";
      if (mode === "development") value.node_env = "development";
      if (mode === "missing") value.oauth = null;
      const request = vi.fn<typeof fetch>();
      expect(await (await probe())(value, until, request, () => now)).toBe(
        "invalidconfig",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
});

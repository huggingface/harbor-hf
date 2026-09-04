import type { Browser, Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserApplicationAuth, browserEnvironment } from "../browser-auth.js";

const origin = "https://control.example.invalid";
const operator = {
  authenticated: true,
  actor: { username: "example-user", role: "operator", transport: "session" },
};
const system = new URL("/api/v1/system", origin);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(
  bodies: Array<{ status: number; body: unknown }> = [
    { status: 200, body: operator },
    { status: 200, body: { verified: true } },
  ],
) {
  vi.stubGlobal("location", { origin });
  const fetcher = vi.fn(async () => {
    const next = bodies.shift();
    return new Response(JSON.stringify(next?.body ?? { authenticated: false }), {
      status: next?.status ?? 401,
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const goto = vi.fn(async () => undefined);
  const evaluate = vi.fn(
    async (
      fn: (input: {
        origin: string;
        path: string;
        timeoutMs: number;
      }) => Promise<unknown>,
      input: { origin: string; path: string; timeoutMs: number },
    ) => await fn(input),
  );
  const url = vi.fn(() => origin);
  const page = { url, goto, evaluate } as unknown as Page;
  const close = vi.fn(async () => undefined);
  const newContext = vi.fn(async () => ({ newPage: async () => page }));
  const launch = vi.fn(async () => ({ newContext, close }) as unknown as Browser);
  const progress = vi.fn();
  const adapter = new BrowserApplicationAuth(origin, "example-user", {
    launch,
    environment: { DISPLAY: ":test", HF_TOKEN: "excluded", HF_DEBUG: "1" },
    progress,
    pollMs: 1,
    timeoutMs: 100,
  });
  return { adapter, fetcher, launch, close, newContext, goto, evaluate, progress, url };
}

describe("ephemeral browser application authentication", () => {
  it.each([401, 503])(
    "handles a non-JSON %s hosting response without disclosing it",
    async (status) => {
      const test = setup();
      test.fetcher.mockImplementationOnce(
        async () => new Response("<h1>Temporary proxy response</h1>", { status }),
      );
      expect(await test.adapter.getJson(system)).toEqual({
        status: 200,
        body: { verified: true },
      });
      expect(test.close).not.toHaveBeenCalled();
      await test.adapter.close();
    },
  );
  it("starts application login after a separate private-hosting login redirect", async () => {
    const test = setup([
      { status: 401, body: { authenticated: false } },
      { status: 200, body: operator },
      { status: 200, body: { verified: true } },
    ]);
    let current = origin;
    test.url.mockImplementation(() => current);
    test.goto.mockImplementation(async () => {
      if (test.goto.mock.calls.length === 1) {
        current = "https://login.example.invalid";
        setTimeout(() => {
          current = origin;
        }, 10);
      }
    });
    expect(await test.adapter.getJson(system)).toEqual({
      status: 200,
      body: { verified: true },
    });
    expect(test.goto).toHaveBeenCalledWith(`${origin}/auth/login`, expect.anything());
    expect(test.progress).toHaveBeenCalledTimes(1);
    await test.adapter.close();
  });

  it("uses only the verified planned operator session and bounded same-origin GETs", async () => {
    const test = setup();
    expect(await test.adapter.getJson(system)).toEqual({
      status: 200,
      body: { verified: true },
    });
    expect(test.fetcher.mock.calls).toHaveLength(2);
    expect(test.launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: false, env: { DISPLAY: ":test" } }),
    );
    expect(test.newContext).toHaveBeenCalledWith({ serviceWorkers: "block" });
    expect(test.fetcher).toHaveBeenNthCalledWith(
      1,
      `${origin}/api/v1/auth/session`,
      expect.objectContaining({
        credentials: "same-origin",
        redirect: "error",
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
    await test.adapter.close();
    expect(test.close).toHaveBeenCalled();
    await expect(test.adapter.getJson(system)).rejects.toThrow(
      "Browser verification failed",
    );
  });

  it.each([
    { ...operator.actor, username: "wrong-user" },
    { ...operator.actor, role: "reader" },
    { ...operator.actor, role: "submitter" },
    { ...operator.actor, transport: "bearer" },
    { ...operator.actor, transport: "development" },
  ])("rejects a mismatched actor without reading system: %j", async (actor) => {
    const test = setup([{ status: 200, body: { authenticated: true, actor } }]);
    await expect(test.adapter.getJson(system)).rejects.toThrow("planned operator");
    expect(test.fetcher).toHaveBeenCalledTimes(1);
    expect(test.close).toHaveBeenCalled();
  });

  it.each([
    "http://control.example.invalid",
    `${origin}/`,
    `${origin}/path`,
    "https://user:password@control.example.invalid",
    `${origin}?token=private`,
  ])("rejects non-exact HTTPS origins", (value) => {
    expect(() => new BrowserApplicationAuth(value, "example-user")).toThrow();
  });

  it.each([
    "https://other.example.invalid/api/v1/system",
    `${origin}/api/v1/runs`,
    `${origin}/api/v1/system?x=1`,
    `${origin}/api/v1/system#fragment`,
    `${origin}/auth/login`,
    `${origin}/api/v1/auth/session`,
  ])("refuses out-of-scope programmatic requests", async (url) => {
    const test = setup();
    await expect(test.adapter.getJson(new URL(url))).rejects.toThrow(
      "route is not allowed",
    );
    expect(test.launch).not.toHaveBeenCalled();
  });

  it("revisits existing OAuth after restart in the same ephemeral context", async () => {
    const test = setup([
      { status: 401, body: {} },
      { status: 200, body: operator },
      { status: 200, body: {} },
      { status: 401, body: {} },
      { status: 200, body: operator },
      { status: 200, body: { items: [], next_cursor: null } },
    ]);
    await test.adapter.getJson(system);
    await test.adapter.getJson(new URL("/api/v1/runs?limit=1", origin));
    expect(test.launch).toHaveBeenCalledTimes(1);
    expect(test.progress).toHaveBeenCalledTimes(2);
    expect(test.goto).toHaveBeenCalledWith(`${origin}/auth/login`, expect.anything());
    await test.adapter.close();
  });

  it("reauthenticates when expiry occurs between session and system reads", async () => {
    const test = setup([
      { status: 200, body: operator },
      { status: 401, body: {} },
      { status: 401, body: {} },
      { status: 200, body: operator },
      { status: 200, body: {} },
    ]);
    expect((await test.adapter.getJson(system)).status).toBe(200);
    expect(test.progress).toHaveBeenCalledTimes(1);
    await test.adapter.close();
  });

  it("bounds login waiting and closes on timeout", async () => {
    const test = setup([]);
    await expect(test.adapter.getJson(system)).rejects.toThrow(
      /timed out|Browser verification failed/,
    );
    expect(test.close).toHaveBeenCalled();
  });

  it.each(["redirect", "declared oversize", "stream oversize", "invalid JSON"])(
    "safely rejects %s responses and closes",
    async (kind) => {
      const test = setup();
      test.fetcher.mockImplementationOnce(async () => {
        if (kind === "redirect")
          throw new Error("https://private.invalid/callback?token=private");
        return new Response(
          kind === "stream oversize" ? "x".repeat(262145) : "invalid",
          {
            headers: kind === "declared oversize" ? { "content-length": "262145" } : {},
          },
        );
      });
      await expect(test.adapter.getJson(system)).rejects.toThrow(
        "Browser verification failed; retry and sign in in the opened browser.",
      );
      expect(test.close).toHaveBeenCalled();
    },
  );

  it("reports missing Chromium without exposing launcher errors", async () => {
    const test = setup();
    test.launch.mockRejectedValue(new Error("private callback URL"));
    await expect(test.adapter.getJson(system)).rejects.toThrow(
      "npx playwright install chromium",
    );
  });

  it("waits through restart readiness before revisiting login", async () => {
    const test = setup([
      { status: 503, body: {} },
      { status: 401, body: {} },
      { status: 200, body: operator },
      { status: 200, body: {} },
    ]);
    await test.adapter.getJson(system);
    expect(test.progress).toHaveBeenCalledTimes(1);
    await test.adapter.close();
  });

  it.each([null, {}, { authenticated: false }, { authenticated: true, actor: null }])(
    "rejects malformed session responses",
    async (body) => {
      const test = setup([{ status: 200, body }]);
      await expect(test.adapter.getJson(system)).rejects.toThrow();
      expect(test.fetcher).toHaveBeenCalledTimes(1);
      expect(test.close).toHaveBeenCalled();
    },
  );

  it("rejects unexpected session statuses without querying system", async () => {
    const test = setup([{ status: 403, body: {} }]);
    await expect(test.adapter.getJson(system)).rejects.toThrow(
      "Browser verification failed",
    );
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled response within the authentication deadline", async () => {
    const test = setup();
    vi.stubGlobal(
      "fetch",
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("private URL")),
            { once: true },
          );
        }),
    );
    await expect(test.adapter.getJson(system)).rejects.toThrow(
      "Browser verification failed",
    );
    expect(test.close).toHaveBeenCalled();
  });

  it("closes an existing browser on an out-of-scope request", async () => {
    const test = setup();
    await test.adapter.getJson(system);
    await expect(
      test.adapter.getJson(new URL("/api/v1/runs?limit=2", origin)),
    ).rejects.toThrow("route is not allowed");
    expect(test.close).toHaveBeenCalled();
  });

  it("excludes credential and browser profile environment", () => {
    expect(
      browserEnvironment({
        DISPLAY: ":test",
        HF_HOME: "/private",
        HOME: "/private",
        HF_TOKEN: "secret",
        HARBOR_HF_CONTROL_BEARER_TOKEN: "secret",
        HF_DEBUG: "1",
        HTTP_PROXY: "secret",
      }),
    ).toEqual({ DISPLAY: ":test" });
  });

  it("does not fall back when no display is available", async () => {
    if (process.platform !== "linux") return;
    const adapter = new BrowserApplicationAuth(origin, "example-user", {
      environment: {},
    });
    await expect(adapter.getJson(system)).rejects.toThrow("local graphical display");
  });
});

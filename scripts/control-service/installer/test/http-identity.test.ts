import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { HfCli } from "../hf.js";
import { BoundedHttpAdapter } from "../http.js";
import { StableIdentityAdapter } from "../identity.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function localServer(handler: RequestListener): Promise<URL> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}`);
}

describe("bounded HTTP and identity adapters", () => {
  it("reads bounded local JSON and rejects redirects and oversize bodies", async () => {
    const origin = await localServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/ok" }).end();
      } else if (request.url === "/large") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ value: "x".repeat(500) }));
      } else {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end('{"status":"ok"}');
      }
    });
    const adapter = new BoundedHttpAdapter();
    await expect(
      adapter.getJson(new URL("/ok", origin), {
        timeoutMs: 1_000,
        maxBytes: 100,
      }),
    ).resolves.toEqual({ status: 200, body: { status: "ok" } });
    await expect(
      adapter.getJson(new URL("/redirect", origin), {
        timeoutMs: 1_000,
        maxBytes: 100,
      }),
    ).rejects.toThrow("redirects");
    await expect(
      adapter.getJson(new URL("/large", origin), {
        timeoutMs: 1_000,
        maxBytes: 100,
      }),
    ).rejects.toThrow("size");
  });

  it("resolves the stable whoami-v2 ID without exposing the token", async () => {
    const requests: { bearer?: string }[] = [];
    const fakeHf = {
      whoamiUsername: async () => "example-user",
      authToken: async () => "local-token-placeholder",
    } as Pick<HfCli, "whoamiUsername" | "authToken">;
    const http = {
      getJson: async (
        _url: URL,
        options: { bearer?: string; timeoutMs: number; maxBytes: number },
      ) => {
        requests.push(options);
        return {
          status: 200,
          body: {
            id: "stable-subject",
            name: "example-user",
            orgs: [{ name: "example-org" }],
          },
        };
      },
    };
    const identity = new StableIdentityAdapter(fakeHf as HfCli, http);
    await expect(identity.resolve()).resolves.toEqual({
      subject: "stable-subject",
      username: "example-user",
      organizations: ["example-org"],
    });
    expect(requests).toEqual([
      {
        bearer: "local-token-placeholder",
        timeoutMs: 10_000,
        maxBytes: 256 * 1024,
      },
    ]);
  });
});

import { createHash } from "node:crypto";
import type { PresetSourceV1 } from "@harbor-hf/control-core";
import { describe, expect, it } from "vitest";
import { readPresetSource } from "../src/preset-source.js";

const token = ["hf", "preset-source"].join("_");
const repository = "example/preset-source";
const revision = "c".repeat(40);
const source: PresetSourceV1 = {
  repository,
  kind: "dataset",
  revision,
  path: "presets",
};

function blobId(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\u0000`)
    .update(bytes)
    .digest("hex");
}

function reply(body: unknown, url: string, status = 200): Response {
  const response = new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "content-type": "application/json" } },
  );
  Object.defineProperty(response, "url", { value: url });
  return response;
}

interface Hub {
  fetch: typeof fetch;
  requests: { url: string; authorization: string | null; redirect: RequestRedirect }[];
}

function hub(options: {
  entries?: unknown;
  sha?: string;
  files?: Record<string, { content: string; oid?: string }>;
  revisionStatus?: number;
  fileUrl?: string;
}): Hub {
  const requests: Hub["requests"] = [];
  const files = options.files ?? {
    "presets/agents/demo.json": { content: '{"agent":"demo"}' },
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      authorization: headers.get("authorization"),
      redirect: (init?.redirect ?? "follow") as RequestRedirect,
    });
    if (url.includes(`/revision/${revision}`))
      return options.revisionStatus && options.revisionStatus !== 200
        ? reply("nope", url, options.revisionStatus)
        : reply({ sha: options.sha ?? revision }, url);
    if (url.includes(`/tree/${revision}`))
      return reply(
        options.entries ??
          Object.entries(files).map(([path, file]) => ({
            type: "file",
            path,
            oid: file.oid ?? blobId(file.content),
            size: Buffer.byteLength(file.content),
          })),
        url,
      );
    const path = decodeURIComponent(url.split(`/resolve/${revision}/`)[1] ?? "");
    const file = files[path];
    if (!file) return reply("Entry not found", url, 404);
    return reply(file.content, options.fileUrl ?? url);
  };
  return { fetch: fetchImpl, requests };
}

describe("readPresetSource", () => {
  it("reads a pinned source and identities it by content digest", async () => {
    const { fetch, requests } = hub({});
    const snapshot = await readPresetSource(source, { accessToken: token, fetch });

    expect(snapshot.files).toEqual([
      { path: "agents/demo.json", content: '{"agent":"demo"}' },
    ]);
    expect(snapshot.digest).toBe(
      createHash("sha256")
        .update("agents/demo.json\u0000")
        .update('{"agent":"demo"}')
        .update("\n")
        .digest("hex"),
    );
    expect(snapshot.source).toEqual(source);
    expect(requests.map((request) => request.authorization)).toEqual([
      `Bearer ${token}`,
      `Bearer ${token}`,
      `Bearer ${token}`,
    ]);
    expect(requests[0]?.url).toContain(
      `/api/datasets/${repository}/revision/${revision}`,
    );
    expect(requests[1]?.url).toContain(
      `/api/datasets/${repository}/tree/${revision}/presets?recursive=true&expand=false`,
    );
    expect(requests[2]?.url).toBe(
      `https://huggingface.co/datasets/${repository}/resolve/${revision}/presets/agents/demo.json`,
    );
    expect(requests.map((request) => request.redirect)).toEqual([
      "error",
      "error",
      "follow",
    ]);
  });

  it("omits the credential when no token is configured", async () => {
    const { fetch, requests } = hub({});
    await readPresetSource(source, { fetch });
    expect(requests.map((request) => request.authorization)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("reads a model repository and files at the repository root", async () => {
    const { fetch, requests } = hub({
      files: { "agents/demo.json": { content: '{"agent":"demo"}' } },
    });
    await readPresetSource(
      {
        repository,
        kind: "model",
        revision,
        path: "",
      },
      { fetch },
    );
    expect(requests[0]?.url).toContain(
      `/api/models/${repository}/revision/${revision}`,
    );
    expect(requests[1]?.url).toContain(`/api/models/${repository}/tree/${revision}?`);
  });

  it("refuses a revision that resolves to another commit or is unavailable", async () => {
    await expect(
      readPresetSource(source, {
        fetch: hub({ sha: "d".repeat(40) }).fetch,
      }),
    ).rejects.toThrow("did not resolve to the requested commit");
    await expect(
      readPresetSource(source, { fetch: hub({ revisionStatus: 404 }).fetch }),
    ).rejects.toThrow("could not be resolved (HTTP 404)");
  });

  it("refuses an unavailable or invalid listing and an empty source", async () => {
    await expect(
      readPresetSource(source, { fetch: hub({ entries: {} }).fetch }),
    ).rejects.toThrow("invalid file listing");
    await expect(
      readPresetSource(source, { fetch: hub({ entries: [] }).fetch }),
    ).rejects.toThrow("holds no preset files");
    await expect(
      readPresetSource(source, {
        fetch: hub({
          entries: [
            {
              type: "file",
              path: "presets/docs/notes.json",
              oid: blobId("{}"),
              size: 2,
            },
          ],
        }).fetch,
      }),
    ).rejects.toThrow("which is not a preset file");
  });

  it("refuses content that does not match the pinned commit", async () => {
    await expect(
      readPresetSource(source, {
        fetch: hub({
          files: {
            "presets/agents/demo.json": { content: "{}", oid: blobId("other") },
          },
        }).fetch,
      }),
    ).rejects.toThrow("does not match its pinned commit");
  });

  it("refuses an oversized preset and an off-origin response", async () => {
    await expect(
      readPresetSource(source, {
        fetch: hub({
          entries: [
            {
              type: "file",
              path: "presets/agents/demo.json",
              oid: blobId("{}"),
              size: 300_000,
            },
          ],
        }).fetch,
      }),
    ).rejects.toThrow("larger than its size limit");
    await expect(
      readPresetSource(source, {
        fetch: hub({ fileUrl: "https://cdn.example.test/demo.json" }).fetch,
      }),
    ).rejects.toThrow("could not return agents/demo.json");
  });

  it("refuses an entry without a git identity", async () => {
    await expect(
      readPresetSource(source, {
        fetch: hub({
          entries: [{ type: "file", path: "presets/agents/demo.json", size: 2 }],
        }).fetch,
      }),
    ).rejects.toThrow("without a git identity");
  });
});

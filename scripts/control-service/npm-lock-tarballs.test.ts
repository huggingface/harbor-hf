import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { productionTarballUrls } from "./npm-lock-tarballs.ts";

describe("productionTarballUrls", () => {
  it("keeps production tarballs and skips workspaces and dev packages", () => {
    const urls = productionTarballUrls({
      packages: {
        "": { dev: false },
        "apps/control-api": {},
        "node_modules/@harbor-hf/control-api": { resolved: "apps/control-api" },
        "node_modules/fastify": {
          resolved: "https://registry.npmjs.org/fastify/-/fastify-5.12.0.tgz",
        },
        "node_modules/vitest": {
          resolved: "https://registry.npmjs.org/vitest/-/vitest-4.1.11.tgz",
          dev: true,
        },
        "node_modules/lightningcss-linux-x64-gnu": {
          resolved:
            "https://registry.npmjs.org/lightningcss-linux-x64-gnu/-/lightningcss-linux-x64-gnu-1.32.0.tgz",
        },
      },
    });
    expect(urls).toEqual([
      "https://registry.npmjs.org/fastify/-/fastify-5.12.0.tgz",
      "https://registry.npmjs.org/lightningcss-linux-x64-gnu/-/lightningcss-linux-x64-gnu-1.32.0.tgz",
    ]);
  });

  it.each([
    "http://registry.npmjs.org/weird/-/weird-1.0.0.tgz",
    "https://example.invalid/weird/-/weird-1.0.0.tgz",
    "https://registry.npmjs.org/weird.git",
  ])("rejects unsupported production package URL %s", (resolved) => {
    expect(() => {
      productionTarballUrls({
        packages: {
          "node_modules/weird": { resolved },
        },
      });
    }).toThrow("unsupported production package URL");
  });

  it("fails when the lockfile has no packages map", () => {
    expect(() =>
      productionTarballUrls({} as { packages: Record<string, never> }),
    ).toThrow("package-lock.json is missing packages");
  });

  it("selects only production tarballs from the committed lockfile", () => {
    const lockfile = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package-lock.json"), "utf8"),
    ) as { packages: Record<string, { resolved?: string; dev?: boolean }> };
    const urls = productionTarballUrls(lockfile);
    expect(urls.length).toBeGreaterThan(200);
    expect(
      urls.every((url) => {
        const parsed = new URL(url);
        return (
          parsed.protocol === "https:" &&
          parsed.origin === "https://registry.npmjs.org" &&
          parsed.pathname.endsWith(".tgz")
        );
      }),
    ).toBe(true);
    expect(urls.some((url) => url.includes("lightningcss-linux-x64-gnu"))).toBe(true);
    expect(urls.some((url) => url.includes("better-sqlite3"))).toBe(true);
    expect(urls.some((url) => url.includes("playwright"))).toBe(false);
    expect(urls.some((url) => url.includes("/vitest-"))).toBe(false);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { locateGitRepositoryRoot } from "../source.js";

it("locates the committed repository from the default and nested working directories", async () => {
  expect(await locateGitRepositoryRoot()).toBe(resolve(process.cwd()));
  expect(await locateGitRepositoryRoot(resolve("packages/control-core"))).toBe(
    resolve(process.cwd()),
  );
});

it("rejects a non-repository and a missing working directory with sanitized errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-location-test-"));
  try {
    await expect(locateGitRepositoryRoot(directory)).rejects.toThrow(
      "local source command failed",
    );
    await expect(locateGitRepositoryRoot(join(directory, "absent"))).rejects.toThrow(
      "local source command failed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

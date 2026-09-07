import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  FilesystemObjectStore,
  listWorkbenchConfigurations,
  saveWorkbenchConfiguration,
} from "../src/index.js";
it("isolates immutable native harness versions and rejects credential material", async () => {
  const root = await mkdtemp(join(tmpdir(), "authoring-"));
  try {
    const store = new FilesystemObjectStore(root);
    const input = {
      name: "harness",
      harbor_job_config: { agents: [{ name: "terminus-2", kwargs: {} }] },
    };
    const first = await saveWorkbenchConfiguration(store, "owner-a", input);
    expect(await saveWorkbenchConfiguration(store, "owner-a", input)).toEqual(first);
    expect(
      await listWorkbenchConfigurations(new FilesystemObjectStore(root), "owner-a"),
    ).toEqual([first]);
    expect(await listWorkbenchConfigurations(store, "owner-b")).toEqual([]);
    const second = await saveWorkbenchConfiguration(store, "owner-a", {
      ...input,
      harbor_job_config: { agents: [{ name: "oracle" }] },
    });
    expect(second.revision).not.toBe(first.revision);
    await expect(
      saveWorkbenchConfiguration(store, "owner-a", {
        ...input,
        harbor_job_config: { agents: [{ env: { HF_TOKEN: "placeholder" } }] },
      }),
    ).rejects.toThrow("credential");
    expect(await listWorkbenchConfigurations(store, "owner-a")).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionPrefix, FilesystemObjectStore } from "@harbor-hf/control-core";
import { PersonalHuggingFace } from "@harbor-hf/hf-adapters";
import { afterEach, expect, it, vi } from "vitest";
import { checkSetup } from "../src/setup-evidence.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each(["pass", "error", "incomplete", "running", "wrong-owner"] as const)(
  "records installation evidence only for complete matching setup: %s",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "setup-evidence-"));
    roots.push(root);
    const store = new FilesystemObjectStore(root);
    const prefix = `${executionPrefix("subject")}run-example/`;
    await store.create(
      `${prefix}execution.json`,
      Buffer.from(
        JSON.stringify({
          run_id: "run-example",
          owner: "example-user",
          bucket: "private-results",
          mode: "setup",
          revision: "sha256:example",
          context: "context",
        }),
      ),
    );
    await store.create(
      `${prefix}job.json`,
      Buffer.from(JSON.stringify({ id: "example-job" })),
    );
    vi.spyOn(PersonalHuggingFace.prototype, "job").mockResolvedValue({
      id: "example-job",
      stage: outcome === "running" ? "RUNNING" : "STOPPED",
    });
    const artifact = vi
      .spyOn(PersonalHuggingFace.prototype, "artifact")
      .mockResolvedValue({
        text: JSON.stringify({
          finished_at: "2026-01-01T00:00:00Z",
          n_total_trials: 2,
          stats: {
            n_completed_trials: outcome === "incomplete" ? 1 : 2,
            n_errored_trials: outcome === "error" ? 1 : 0,
            n_pending_trials: 0,
            n_running_trials: 0,
            n_cancelled_trials: 0,
          },
        }),
      });
    const client = new PersonalHuggingFace("hf_testcredential");
    if (outcome === "wrong-owner") {
      await expect(
        checkSetup(store, client, "other-subject", "other-user", "run-example"),
      ).rejects.toThrow();
      expect(artifact).not.toHaveBeenCalled();
    } else {
      const receipt = await checkSetup(
        store,
        client,
        "subject",
        "example-user",
        "run-example",
      );
      expect(receipt.status).toBe(
        outcome === "pass" ? "passed" : outcome === "running" ? "pending" : "failed",
      );
    }
    const receipts = (await store.list(executionPrefix("subject"))).filter((item) =>
      item.key.endsWith("/receipt.json"),
    );
    expect(receipts).toHaveLength(outcome === "pass" ? 1 : 0);
  },
);

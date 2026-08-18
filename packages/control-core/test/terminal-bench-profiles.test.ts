import { readFile } from "node:fs/promises";
import type { ProfileObject } from "@harbor-hf/contracts";
import { validateControlRecord } from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";

async function profile(kind: string, name: string): Promise<ProfileObject> {
  const value = JSON.parse(await readFile(`profiles/${kind}/${name}.json`, "utf8"));
  return validateControlRecord<ProfileObject>(value);
}

describe("Terminal-Bench 2.1 profiles", () => {
  it("lock the official five-trial task set", async () => {
    const record = await profile("benchmark", "terminal-bench-2-1-official-5");
    const spec = record.spec as {
      task_ids: string[];
      task_digests: string[];
      source_task_ids: string[];
      trial_indices: number[];
      harbor_job: { n_attempts: number };
    };

    expect(spec.task_ids).toHaveLength(445);
    expect(new Set(spec.task_ids).size).toBe(445);
    expect(new Set(spec.source_task_ids).size).toBe(89);
    expect(spec.task_digests).toHaveLength(445);
    expect(spec.trial_indices.filter((value) => value === 1)).toHaveLength(89);
    expect(spec.trial_indices.filter((value) => value === 5)).toHaveLength(89);
    expect(spec.harbor_job.n_attempts).toBe(5);
  });

  it("keep inference credentials in the Sandbox root bridge", async () => {
    const record = await profile("deployment", "tb21-deepseek-v4-flash-official-5");
    const spec = record.spec as {
      inference_token: string;
      worker_revision: string;
      worker_max_tasks_per_job: number;
      sandbox_template: {
        inference_token: string;
        inference_model: string;
        root_bootstrap_command: string[];
      };
    };

    expect(spec.inference_token).toBe("forbidden");
    expect(spec.sandbox_template.inference_token).toBe("required");
    expect(spec.sandbox_template.inference_model).toBe(
      "deepseek-ai/DeepSeek-V4-Flash-0731:together",
    );
    expect(spec.worker_revision).toBe("2981da7c0349e6fe31383bc0f44b36f0a39c214f");
    expect(spec.worker_max_tasks_per_job).toBe(445);
    expect(spec.sandbox_template.root_bootstrap_command.join("\n")).not.toContain(
      "HF_TOKEN=",
    );
  });
});

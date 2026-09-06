import { createHash } from "node:crypto";
import { executionPrefix, type ObjectStore } from "@harbor-hf/control-core";
import type { PersonalHuggingFace } from "@harbor-hf/hf-adapters";
import { z } from "zod";

export const executionRecord = z.object({
  run_id: z.string(),
  owner: z.string(),
  bucket: z.string(),
  mode: z.enum(["setup", "benchmark"]),
  revision: z.string(),
  context: z.string(),
});
const nativeResult = z.object({
  finished_at: z.string().min(1),
  n_total_trials: z.number().int().positive(),
  stats: z.object({
    n_completed_trials: z.number().int(),
    n_errored_trials: z.number().int(),
    n_pending_trials: z.number().int(),
    n_running_trials: z.number().int(),
    n_cancelled_trials: z.number().int(),
  }),
});
export const setupReceipt = executionRecord.extend({
  status: z.literal("passed"),
  evidence_sha256: z.string(),
  observed_at: z.string(),
  evidence_origin: z.literal("user-owned-native-artifacts"),
});

export async function checkSetup(
  store: ObjectStore,
  personal: PersonalHuggingFace,
  subject: string,
  owner: string,
  runId: string,
) {
  const prefix = `${executionPrefix(subject)}${runId}/`;
  const record = executionRecord.parse(
    JSON.parse(new TextDecoder().decode(await store.read(`${prefix}execution.json`))),
  );
  if (record.owner !== owner || record.mode !== "setup")
    throw new Error("Not an authorized setup run");
  const job = z
    .object({ id: z.string() })
    .parse(JSON.parse(new TextDecoder().decode(await store.read(`${prefix}job.json`))));
  const observation = await personal.job(owner, job.id);
  if (
    !["COMPLETED", "STOPPED", "ERROR", "CANCELED", "CANCELLED"].includes(
      observation.stage,
    )
  )
    return { status: "pending", run_id: runId };
  if (["ERROR", "CANCELED", "CANCELLED"].includes(observation.stage))
    return { status: "failed", run_id: runId };
  const artifact = await personal.artifact(
    owner,
    record.bucket,
    `runs/${runId}/${runId}/result.json`,
  );
  const result = nativeResult.parse(JSON.parse(artifact.text));
  const stats = result.stats;
  if (
    stats.n_completed_trials !== result.n_total_trials ||
    stats.n_errored_trials !== 0 ||
    stats.n_pending_trials !== 0 ||
    stats.n_running_trials !== 0 ||
    stats.n_cancelled_trials !== 0
  )
    return { status: "failed", run_id: runId };
  const receipt = setupReceipt.parse({
    ...record,
    status: "passed",
    evidence_sha256: createHash("sha256").update(artifact.text).digest("hex"),
    observed_at: new Date().toISOString(),
    evidence_origin: "user-owned-native-artifacts",
  });
  await store.put(`${prefix}receipt.json`, Buffer.from(JSON.stringify(receipt)));
  return receipt;
}

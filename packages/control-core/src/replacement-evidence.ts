import {
  canonicalJson,
  sha256,
  validateRunRecord,
  type RunRecordV1,
} from "@harbor-hf/contracts";
import type { ObjectStore } from "./store.js";

export const NATIVE_PAYLOAD_LIMIT = 32 * 1024 * 1024;
export interface SourceBundle {
  record: RunRecordV1;
  config: Record<string, unknown>;
  lock: Record<string, unknown>;
  result: Record<string, unknown>;
  trials: Record<string, unknown>[];
}
export interface ReplacementPart {
  evidence: SourceBundle;
  parts: ReplacementPart[];
}
export interface ReplacementInspection {
  harbor_revision: string;
  tasks: number;
  agents: number;
  trials: number;
  warnings: string[];
  not_performed: string[];
  effective_config: Record<string, unknown>;
  /** Native sha256-prefixed source identity, not the public review hash. */
  fingerprint: string;
  credentials_available: boolean;
}
export interface ReplacementNativePort {
  replacementReview(input: {
    original: SourceBundle;
    original_ancestors: SourceBundle[];
    trial_ids: string[];
    run_id: string;
    local_root: string;
  }): Promise<ReplacementInspection>;
  replacementAggregate(input: {
    original: SourceBundle;
    original_ancestors: SourceBundle[];
    parts: ReplacementPart[];
  }): Promise<{ result: Record<string, unknown> }>;
}
export interface ReplacementInput {
  trial_ids: string[];
  cost_ceiling_usd: number;
}
export class ReplacementError extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
export function replacementInput(input: ReplacementInput): ReplacementInput {
  if (
    !Array.isArray(input.trial_ids) ||
    !input.trial_ids.length ||
    input.trial_ids.some(
      (id) =>
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id),
    ) ||
    new Set(input.trial_ids).size !== input.trial_ids.length ||
    !Number.isFinite(input.cost_ceiling_usd) ||
    input.cost_ceiling_usd <= 0 ||
    input.cost_ceiling_usd > 10_000
  )
    throw new ReplacementError(
      400,
      "Select unique native trial UUIDs and a positive campaign ceiling",
    );
  return {
    trial_ids: [...input.trial_ids].sort(),
    cost_ceiling_usd: input.cost_ceiling_usd,
  };
}
/** Bare public review hash binds the native source identity, UUIDs and budget. */
export function reviewFingerprint(source: string, input: ReplacementInput): string {
  return sha256(
    canonicalJson({ source_fingerprint: source, ...replacementInput(input) }),
  );
}
export function nativeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReplacementError(409, "Native replacement evidence is unavailable");
  return value as Record<string, unknown>;
}
/** A bounded worker pool, not an execution scheduler. */
export async function evidenceMap<T, U>(
  values: readonly T[],
  read: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  const entries = values.entries();
  await Promise.all(
    Array.from({ length: Math.min(8, values.length) }, async () => {
      for (const [index, value] of entries) output[index] = await read(value);
    }),
  );
  return output;
}
export class ReplacementEvidence {
  private bytes = 0;
  readonly identities: string[] = [];
  constructor(readonly store: ObjectStore) {}
  async read(key: string): Promise<Record<string, unknown>> {
    const bytes = await this.store.read(key, { fresh: true });
    this.bytes += bytes.byteLength;
    if (this.bytes > NATIVE_PAYLOAD_LIMIT)
      throw new ReplacementError(
        409,
        "Replacement evidence exceeds its bounded inspection limit",
      );
    this.identities.push(`${key}:${sha256(bytes)}`);
    return nativeObject(JSON.parse(new TextDecoder().decode(bytes)));
  }
  async records(): Promise<RunRecordV1[]> {
    const listing = await this.store.listDirectory("runs/", []);
    return evidenceMap(listing.directories, async (prefix) => {
      const record = validateRunRecord(await this.read(`${prefix}run.json`));
      if (prefix !== `runs/${record.run_id}/`)
        throw new ReplacementError(409, "Run record identity mismatch");
      return record;
    });
  }
  async bundle(id: string): Promise<SourceBundle> {
    if (!/^run-[0-9a-f]{24}$/.test(id))
      throw new ReplacementError(409, "Invalid source identity");
    const prefix = `runs/${id}/`;
    const record = validateRunRecord(await this.read(`${prefix}run.json`));
    if (record.run_id !== id)
      throw new ReplacementError(409, "Source record identity mismatch");
    const job = `${prefix}job/`;
    const [config, lock, result] = await Promise.all(
      ["config.json", "lock.json", "result.json"].map((name) =>
        this.read(`${job}${name}`),
      ),
    );
    if (!config || !lock || !result)
      throw new ReplacementError(409, "Missing native evidence");
    const listing = await this.store.listDirectory(job, []);
    const results = await evidenceMap(listing.directories, async (directory) => {
      const files = await this.store.listDirectory(directory, ["result.json"]);
      const entry = files.files.find((file) => file.key === `${directory}result.json`);
      if (!entry)
        throw new ReplacementError(409, "Source has unfinished native trial artifacts");
      const trial = await this.read(entry.key);
      if (`${job}${String(trial.trial_name)}/` !== directory)
        throw new ReplacementError(409, "Native trial artifact identity mismatch");
      return trial;
    });
    return {
      record,
      config,
      lock,
      result,
      trials: results.filter((item) => item !== null),
    };
  }
  async ancestors(source: SourceBundle): Promise<SourceBundle[]> {
    const output: SourceBundle[] = [];
    const seen = new Set([source.record.run_id]);
    let selection = source.record.operator_selection;
    while (selection) {
      if (seen.has(selection.original_run_id))
        throw new ReplacementError(409, "Cyclic replacement ancestry");
      seen.add(selection.original_run_id);
      const bundle = await this.bundle(selection.original_run_id);
      output.push(bundle);
      selection = bundle.record.operator_selection;
    }
    return output;
  }
}

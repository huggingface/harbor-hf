import {
  canonicalJson,
  sha256,
  validateAttemptCost,
  type RunRecordV1,
} from "@harbor-hf/contracts";
import {
  authoritativeAttemptCosts,
  summarizeTrial,
  type Projection,
  type RunStatus,
} from "./projection.js";
import {
  ReplacementEvidence,
  ReplacementError,
  evidenceMap,
  nativeObject,
  type ReplacementNativePort,
  type ReplacementPart,
  type SourceBundle,
} from "./replacement-evidence.js";
import type { ObjectStore } from "./store.js";

export interface ReportedAttemptCostCoverage {
  cost_usd: number | null;
  reported_attempts: number;
  unknown_attempts: number;
  total_attempts: number;
}
export interface ReplacementView {
  run_id: string;
  operator_selection: NonNullable<RunRecordV1["operator_selection"]> | null;
  children: Array<{
    run_id: string;
    status: RunStatus | null;
    operator_selection: NonNullable<RunRecordV1["operator_selection"]>;
  }>;
  assembly: {
    availability: "none" | "pending" | "available" | "unavailable";
    result: Record<string, unknown> | null;
  };
  incurred: ReportedAttemptCostCoverage | null;
  selected_cost_usd: number | null;
}

/** View-only native assembly. Never written to RunView, SQLite or job artifacts. */
export class Replacements {
  private readonly cache = new Map<
    string,
    { key: string; result: Record<string, unknown>; bytes: number }
  >();
  private cacheBytes = 0;
  private readonly inspecting = new Map<string, Promise<ReplacementView>>();
  constructor(
    private readonly store: ObjectStore,
    private readonly projection: Projection,
    private readonly native: ReplacementNativePort,
    private readonly complete: (source: SourceBundle) => Promise<void>,
  ) {}

  private remember(id: string, key: string, result: Record<string, unknown>): void {
    const previous = this.cache.get(id);
    if (previous) {
      this.cacheBytes -= previous.bytes;
      this.cache.delete(id);
    }
    const bytes = Buffer.byteLength(canonicalJson(result));
    if (bytes > 32 * 1024 * 1024) return;
    while (this.cache.size >= 8 || this.cacheBytes + bytes > 32 * 1024 * 1024) {
      const first = this.cache.entries().next().value;
      if (!first) break;
      this.cacheBytes -= first[1].bytes;
      this.cache.delete(first[0]);
    }
    this.cache.set(id, { key, result: structuredClone(result), bytes });
    this.cacheBytes += bytes;
  }

  private async tree(
    source: SourceBundle,
    records: RunRecordV1[],
    reader: ReplacementEvidence,
    seen: Set<string>,
  ): Promise<ReplacementPart[]> {
    if (seen.has(source.record.run_id))
      throw new ReplacementError(409, "Cyclic replacement tree");
    seen.add(source.record.run_id);
    await this.complete(source);
    const parts: ReplacementPart[] = [];
    for (const record of records.filter(
      (record) => record.operator_selection?.original_run_id === source.record.run_id,
    )) {
      const evidence = await reader.bundle(record.run_id);
      parts.push({ evidence, parts: await this.tree(evidence, records, reader, seen) });
    }
    return parts;
  }

  private descendants(
    id: string,
    records: RunRecordV1[],
    seen = new Set<string>(),
  ): string[] {
    if (seen.has(id)) throw new ReplacementError(409, "Cyclic replacement tree");
    seen.add(id);
    return [
      id,
      ...records
        .filter((record) => record.operator_selection?.original_run_id === id)
        .flatMap((record) => this.descendants(record.run_id, records, seen)),
    ];
  }

  private async incurred(
    ids: string[],
    reader: ReplacementEvidence,
  ): Promise<ReportedAttemptCostCoverage> {
    const receipts = (
      await evidenceMap(ids, async (id) => {
        const prefix = `runs/${id}/attempt-costs/`;
        const { files } = await reader.directory(prefix);
        return evidenceMap(
          files.filter((file) => file.key.endsWith(".json")),
          async (file) => {
            const receipt = validateAttemptCost(await reader.read(file.key));
            if (file.key !== `${prefix}${receipt.attempt_id}.json`)
              throw new Error("Receipt identity mismatch");
            return receipt;
          },
        );
      })
    ).flat();
    if (new Set(receipts.map((receipt) => receipt.attempt_id)).size !== receipts.length)
      throw new Error("Duplicate native receipt identity");
    const trials = (
      await evidenceMap(ids, async (id) => {
        const job = `runs/${id}/job/`;
        const { directories } = await reader.directory(job, []);
        return (
          await evidenceMap(directories, async (directory) => {
            const trial = await reader.trialResult(directory);
            return trial ? summarizeTrial(id, "", trial) : null;
          })
        ).filter((trial) => trial !== null);
      })
    ).flat();
    const trialIds = trials.flatMap((trial) =>
      typeof trial.result.id === "string" ? [trial.result.id] : [],
    );
    if (new Set(trialIds).size !== trialIds.length)
      throw new Error("Duplicate native trial identity");
    const costs = authoritativeAttemptCosts(receipts, trials);
    const reported = costs.filter((cost): cost is number => cost !== null);
    return {
      cost_usd: reported.length ? reported.reduce((a, b) => a + b, 0) : null,
      reported_attempts: reported.length,
      unknown_attempts: costs.length - reported.length,
      total_attempts: costs.length,
    };
  }

  async view(id: string): Promise<ReplacementView> {
    const reader = new ReplacementEvidence(this.store);
    // Every caller rediscovers relationships before joining unfinished work.
    // A newly added descendant must never join an older graph's inspection.
    const records = await reader.records();
    const key = `${id}:${sha256(canonicalJson(records))}`;
    let pending = this.inspecting.get(key);
    if (!pending) {
      pending = this.inspect(id, reader, records).finally(() =>
        this.inspecting.delete(key),
      );
      this.inspecting.set(key, pending);
    }
    // Only in-flight work is shared; isolate responses and retain no failures.
    return structuredClone(await pending);
  }

  private async inspect(
    id: string,
    reader: ReplacementEvidence,
    records: RunRecordV1[],
  ): Promise<ReplacementView> {
    const record = records.find((record) => record.run_id === id);
    if (!record) throw new ReplacementError(400, "Run was not found");
    const children = records
      .filter((record) => record.operator_selection?.original_run_id === id)
      .map((record) => ({
        run_id: record.run_id,
        status: this.projection.run(record.run_id)?.status ?? null,
        operator_selection: record.operator_selection!,
      }));
    const view: ReplacementView = {
      run_id: id,
      operator_selection: record.operator_selection ?? null,
      children,
      assembly: { availability: children.length ? "pending" : "none", result: null },
      incurred: null,
      selected_cost_usd: null,
    };
    try {
      view.incurred = await this.incurred(this.descendants(id, records), reader);
    } catch {
      /* Unknown coverage, never zero. */
    }
    if (!children.length) return view;
    let nativeReady = false;
    try {
      const original = await reader.bundle(id);
      const original_ancestors = await reader.ancestors(original);
      const parts = await this.tree(original, records, reader, new Set());
      nativeReady = true;
      const key = sha256(canonicalJson(reader.identities.sort()));
      const cached = this.cache.get(id);
      const result =
        cached?.key === key
          ? structuredClone(cached.result)
          : (
              await this.native.replacementAggregate({
                original,
                original_ancestors,
                parts,
              })
            ).result;
      this.remember(id, key, result);
      view.assembly = { availability: "available", result };
      const cost = nativeObject(result.stats).cost_usd;
      view.selected_cost_usd =
        typeof cost === "number" && Number.isFinite(cost) ? cost : null;
    } catch {
      const pending =
        !nativeReady &&
        this.descendants(id, records).some((run) => {
          const status = this.projection.run(run)?.status;
          return status === "queued" || status === "running" || status === "paused";
        });
      view.assembly = {
        availability: pending ? "pending" : "unavailable",
        result: null,
      };
    }
    return view;
  }
}

import { canonicalJson, sha256, type AttemptCostV1 } from "@harbor-hf/contracts";
import { isLiveJob } from "./jobs.js";
import {
  authoritativeAttemptCosts,
  type Projection,
  type RunView,
  type TrialSummary,
} from "./projection.js";
import {
  evidenceMap,
  nativeObject,
  NATIVE_PAYLOAD_LIMIT,
  ReplacementError,
  ReplacementEvidence,
  type SourceBundle,
} from "./replacement-evidence.js";
import type { ObjectEntry, ObjectStore } from "./store.js";

type Source = Pick<RunView, "record" | "state" | "status" | "result"> & {
  trials: TrialSummary[];
  objects: readonly ObjectEntry[];
  receipts: readonly AttemptCostV1[];
};
const identity = (entries: readonly ObjectEntry[]) =>
  canonicalJson(
    entries
      .map(({ key, size, source_identity }) => [key, size, source_identity])
      .sort(),
  );

/** One synchronous read of existing projection data. Never execution authority. */
export class ReplacementObservation {
  readonly sources = new Map<string, Source>();
  readonly descendants: string[] = [];
  readonly ancestors: string[] = [];
  readonly observed_at: string | null;
  readonly key: string;
  readonly live: boolean;
  private readonly reader: ReplacementEvidence;

  constructor(
    store: ObjectStore,
    projection: Projection,
    readonly id: string,
  ) {
    this.reader = new ReplacementEvidence(store);
    const rows = new Map(projection.listRuns().map((row) => [row.record.run_id, row]));
    const capture = (id: string) => {
      const row = rows.get(id);
      if (!row) throw new ReplacementError(400, "Run was not found in the projection");
      const { record, state, status, result } = row;
      this.sources.set(id, {
        record,
        state,
        status,
        result,
        trials: projection.trials(id),
        objects: projection.replacementObjects(id),
        receipts: projection.replacementReceipts(id),
      });
      return row;
    };
    const visit = (id: string) => {
      if (this.sources.has(id))
        throw new ReplacementError(409, "Cyclic replacement tree");
      capture(id);
      this.descendants.push(id);
      for (const row of rows.values())
        if (row.record.operator_selection?.original_run_id === id)
          visit(row.record.run_id);
    };
    visit(id);
    let parent = this.source(id).record.operator_selection?.original_run_id;
    while (parent) {
      if (this.sources.has(parent))
        throw new ReplacementError(409, "Cyclic replacement ancestry");
      this.ancestors.push(parent);
      parent = capture(parent).record.operator_selection?.original_run_id;
    }
    const observations = projection.jobObservations();
    this.observed_at = observations.observed_at;
    const jobs = observations.jobs.filter((job) =>
      this.descendants.includes(job.run_id),
    );
    this.live = jobs.some(isLiveJob);
    const bytes = canonicalJson({ sources: [...this.sources].sort(), jobs });
    if (Buffer.byteLength(bytes) > NATIVE_PAYLOAD_LIMIT)
      throw new ReplacementError(
        409,
        "Projected replacement evidence exceeds its bound",
      );
    this.key = sha256(bytes);
  }

  source(id: string): Source {
    const source = this.sources.get(id);
    if (!source) throw new ReplacementError(409, "Missing projected source");
    return source;
  }

  children(id: string): Source[] {
    return [...this.sources.values()].filter(
      (source) => source.record.operator_selection?.original_run_id === id,
    );
  }

  private async files(id: string) {
    const prefix = `runs/${id}/job/`;
    const filenames = ["config.json", "lock.json"];
    const select = (entries: readonly ObjectEntry[]) =>
      entries.filter(
        (entry) =>
          entry.key.startsWith(prefix) &&
          filenames.includes(entry.key.slice(prefix.length)),
      );
    const expected = select(this.source(id).objects);
    if (expected.length !== filenames.length)
      throw new ReplacementError(409, "Missing projected native metadata");
    const values = await evidenceMap(expected, (entry) => this.reader.read(entry.key));
    // Fence the few bytes not stored in SQLite with their projected provider
    // identities. Never enumerate or download individual trial artifacts here.
    const observed = await this.reader.directory(prefix, filenames);
    if (identity(select(observed.files)) !== identity(expected))
      throw new ReplacementError(409, "Native metadata changed since projection");
    return expected.map((entry, index) => ({ key: entry.key, value: values[index] }));
  }

  async bundle(id: string): Promise<SourceBundle> {
    const source = this.source(id);
    const prefix = `runs/${id}/job/`;
    const files = await this.files(id);
    return {
      record: source.record,
      config: nativeObject(
        files.find((entry) => entry.key === `${prefix}config.json`)?.value,
      ),
      lock: nativeObject(
        files.find((entry) => entry.key === `${prefix}lock.json`)?.value,
      ),
      result: nativeObject(source.result),
      trials: source.trials.map((trial) => trial.result),
    };
  }

  incurred() {
    const receipts = this.descendants.flatMap((id) => this.source(id).receipts);
    const trials = this.descendants.flatMap((id) => this.source(id).trials);
    const ids = trials.flatMap((trial) =>
      typeof trial.result.id === "string" ? [trial.result.id] : [],
    );
    if (
      new Set(ids).size !== ids.length ||
      new Set(receipts.map((receipt) => receipt.attempt_id)).size !== receipts.length
    )
      throw new Error("Duplicate native attempt identity");
    const costs = authoritativeAttemptCosts(receipts, trials);
    const reported = costs.filter((cost): cost is number => cost !== null);
    return {
      cost_usd: reported.length ? reported.reduce((a, b) => a + b, 0) : null,
      reported_attempts: reported.length,
      unknown_attempts: costs.length - reported.length,
      total_attempts: costs.length,
    };
  }
}

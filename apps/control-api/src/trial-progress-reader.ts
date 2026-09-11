import { projectNativeAgentTiming } from "@harbor-hf/contracts/agent-timing";
import {
  assertRunId,
  sha256,
  validateTrialProgress,
  type TrialProgressV1 as TrialProgress,
} from "@harbor-hf/contracts";
import {
  type JobObservation,
  type ObjectEntry,
  type ObjectStore,
  summarizeTrial,
} from "@harbor-hf/control-core";

const filenames = ["config.json", "lock.json", "result.json"] as const;
type Trial = TrialProgress["trials"][number];
type RecordObservation = {
  trial: Trial;
  identity: string;
  observedAt: number;
};
type Snapshot = {
  value: Promise<TrialProgress>;
  expiresAt: number;
  pending: boolean;
  trials: Map<string, RecordObservation>;
  lock: { identity: string; value: TrialProgress["lock"] } | undefined;
};

function identity(files: readonly ObjectEntry[]): string {
  return JSON.stringify(
    files.map(({ key, size, source_identity }) => [key, size, source_identity]).sort(),
  );
}

// Disposable artifact observations only: no execution state or native aggregation.
export class TrialProgressReader {
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(
    private readonly store: ObjectStore,
    private readonly options: {
      now?: () => number;
      ttlMs?: number;
      reconcileMs?: number;
      maxSnapshots?: number;
      maxTrials?: number;
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async snapshot(
    runId: string,
    jobs: readonly JobObservation[],
    jobsObservedAt: string | null,
  ): Promise<TrialProgress> {
    assertRunId(runId);
    let entry = this.snapshots.get(runId);
    if (!entry || (!entry.pending && entry.expiresAt <= this.now())) {
      if (!entry && this.snapshots.size >= (this.options.maxSnapshots ?? 64)) {
        const settled = [...this.snapshots].find(([, value]) => !value.pending);
        if (!settled) throw new Error("Trial snapshot capacity reached; retry later");
        this.snapshots.delete(settled[0]);
      }
      const fresh: Snapshot = {
        value: Promise.resolve().then(() => this.load(runId, fresh)),
        expiresAt: 0,
        pending: true,
        trials: entry?.trials ?? new Map(),
        lock: entry?.lock,
      };
      this.snapshots.delete(runId);
      this.snapshots.set(runId, fresh);
      fresh.value = fresh.value
        .then((value) => {
          fresh.pending = false;
          fresh.expiresAt = this.now() + (this.options.ttlMs ?? 30_000);
          return value;
        })
        .catch((error: unknown) => {
          // Discard even previously successful records after any failed refresh.
          this.snapshots.delete(runId);
          throw error;
        });
      entry = fresh;
    }
    const artifacts = await entry.value;
    return validateTrialProgress({
      ...artifacts,
      jobs_observed_at: jobsObservedAt,
      jobs: jobs.filter((job) => job.run_id === runId),
    });
  }

  private async read(entry: ObjectEntry | undefined): Promise<unknown> {
    if (!entry) return null;
    // Bypass lower-level byte caches: this identity has not been read by us.
    const bytes = await this.store.read(entry.key, { fresh: true });
    if (
      bytes.byteLength !== entry.size ||
      (/^[0-9a-f]{64}$/.test(entry.source_identity) &&
        sha256(bytes) !== entry.source_identity)
    )
      throw new Error("Artifact changed while reading trial progress");
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  private async observeTrial(
    runId: string,
    trial_name: string,
    base: string,
    previous: RecordObservation | undefined,
  ): Promise<RecordObservation | null> {
    const observedAt = this.now();
    const { files } = await this.store.listDirectory(base, filenames);
    if (!files.length) return null;
    const source = identity(files);
    if (previous?.identity === source) return { ...previous, observedAt };
    const entries = new Map(files.map((entry) => [entry.key, entry]));
    const result = await this.read(entries.get(`${base}result.json`));
    const config = await this.read(entries.get(`${base}config.json`));
    const lock = await this.read(entries.get(`${base}lock.json`));
    // Xet identities are provider hashes, not SHA-256. Fence new reads with
    // metadata observations instead of comparing them to a different hash type.
    if (identity((await this.store.listDirectory(base, filenames)).files) !== source)
      throw new Error("Artifact changed while reading trial progress");
    const summary = result === null ? null : summarizeTrial(runId, trial_name, result);
    const trial = validateTrialProgress({
      observed_at: new Date(observedAt).toISOString(),
      jobs_observed_at: null,
      lock: null,
      jobs: [],
      trials: [
        {
          trial_name,
          config,
          lock,
          result: summary ? projectNativeAgentTiming(summary.result) : null,
          reward: summary?.reward ?? null,
          cost_usd: summary?.cost_usd ?? null,
        },
      ],
    }).trials[0];
    if (!trial) throw new Error("Missing trial projection");
    if (
      [trial.config?.trial_name, trial.result?.trial_name].some(
        (name) => name !== undefined && name !== trial_name,
      )
    )
      throw new Error("Native trial identity does not match its artifact folder");
    return { trial, identity: source, observedAt };
  }

  private async load(runId: string, snapshot: Snapshot): Promise<TrialProgress> {
    const observedAt = this.now();
    const prefix = `runs/${runId}/job/`;
    const listing = await this.store.listDirectory(prefix, ["lock.json"]);
    const lockIdentity = identity(listing.files);
    let lock: unknown = snapshot.lock?.value ?? null;
    if (snapshot.lock?.identity !== lockIdentity) {
      lock = await this.read(
        listing.files.find((file) => file.key === `${prefix}lock.json`),
      );
      if (
        identity((await this.store.listDirectory(prefix, ["lock.json"])).files) !==
        lockIdentity
      )
        throw new Error("Artifact changed while reading trial progress");
    }
    const directories = [...new Set(listing.directories)].sort();
    const records = new Map<string, RecordObservation>();
    // Bound concurrent Bucket operations, never recurse into logs/trajectories.
    for (let start = 0; start < directories.length; start += 6) {
      await Promise.all(
        directories.slice(start, start + 6).map(async (base) => {
          const name = base.slice(prefix.length, -1);
          if (
            !base.startsWith(prefix) ||
            !base.endsWith("/") ||
            !name ||
            name.includes("/") ||
            [".", ".."].includes(name)
          )
            throw new Error("Invalid trial directory observation");
          const previous = snapshot.trials.get(name);
          const record =
            previous?.trial.result?.finished_at &&
            observedAt >= previous.observedAt &&
            observedAt - previous.observedAt < (this.options.reconcileMs ?? 300_000)
              ? previous
              : await this.observeTrial(runId, name, base, previous);
          if (record) records.set(name, record);
        }),
      );
    }
    const ordered = [...records.values()].sort((a, b) =>
      a.trial.trial_name.localeCompare(b.trial.trial_name),
    );
    const value = validateTrialProgress({
      // Discovery freshness is independent of retained completed observations.
      observed_at: new Date(observedAt).toISOString(),
      jobs_observed_at: null,
      lock,
      trials: ordered.map((record) => ({
        ...record.trial,
        observed_at: new Date(record.observedAt).toISOString(),
      })),
      jobs: [],
    });
    snapshot.trials = new Map([...records].slice(0, this.options.maxTrials ?? 8192));
    snapshot.lock = { identity: lockIdentity, value: value.lock };
    return value;
  }
}

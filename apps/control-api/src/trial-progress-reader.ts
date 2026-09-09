import { projectNativeAgentTiming } from "@harbor-hf/contracts/agent-timing";
import {
  assertRunId,
  validateTrialProgress,
  type TrialProgressV1 as TrialProgress,
} from "@harbor-hf/contracts";
import {
  type JobObservation,
  type ObjectEntry,
  type ObjectStore,
  readJson,
  summarizeTrial,
} from "@harbor-hf/control-core";

// Read-only adapter. Cache artifact snapshots, never provider or lifecycle state.
// No logs, trajectories, credentials, or raw config fields enter the API payload.
export class TrialProgressReader {
  private readonly cache = new Map<string, { identity: string; value: unknown }>();
  private readonly snapshots = new Map<
    string,
    {
      value: Promise<TrialProgress>;
      expiresAt: number;
      pending: boolean;
    }
  >();
  constructor(
    private readonly store: ObjectStore,
    private readonly options: {
      now?: () => number;
      ttlMs?: number;
      maxSnapshots?: number;
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
    const now = this.now();
    for (const [id, entry] of this.snapshots) {
      if (!entry.pending && entry.expiresAt <= now) this.snapshots.delete(id);
    }
    let entry = this.snapshots.get(runId);
    if (!entry) {
      if (this.snapshots.size >= (this.options.maxSnapshots ?? 64)) {
        const settled = [...this.snapshots].find(([, value]) => !value.pending);
        if (!settled) throw new Error("Trial snapshot capacity reached; retry later");
        this.snapshots.delete(settled[0]);
      }
      const fresh = { value: this.load(runId), expiresAt: 0, pending: true };
      this.snapshots.set(runId, fresh);
      fresh.value = fresh.value
        .then((value) => {
          fresh.pending = false;
          fresh.expiresAt = this.now() + (this.options.ttlMs ?? 10_000);
          return value;
        })
        .catch((error: unknown) => {
          this.snapshots.delete(runId);
          // Failed refresh must not fall back to a previously successful snapshot
          // or retain partially decoded artifacts from a failed observation.
          for (const key of this.cache.keys()) {
            if (key.startsWith(`runs/${runId}/job/`)) this.cache.delete(key);
          }
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
    const cached = this.cache.get(entry.key);
    if (cached?.identity === entry.source_identity) return cached.value;
    const value = await readJson(this.store, entry.key);
    if (this.cache.size >= 8192) this.cache.clear();
    this.cache.set(entry.key, { identity: entry.source_identity, value });
    return value;
  }

  private async load(runId: string): Promise<TrialProgress> {
    const prefix = `runs/${runId}/job/`;
    const entries = new Map(
      (await this.store.list(prefix)).map((entry) => [entry.key, entry]),
    );
    const names = [
      ...new Set(
        [...entries.keys()].flatMap((key) => {
          const parts = key.slice(prefix.length).split("/");
          return key.startsWith(prefix) &&
            parts.length === 2 &&
            parts[0] !== undefined &&
            parts[1] !== undefined &&
            ["config.json", "lock.json", "result.json"].includes(parts[1])
            ? [parts[0]]
            : [];
        }),
      ),
    ].sort();
    const trials: unknown[] = [];
    // Bound parallel Bucket reads, including on large multi-attempt benchmarks.
    for (let start = 0; start < names.length; start += 6) {
      trials.push(
        ...(await Promise.all(
          names.slice(start, start + 6).map(async (trial_name) => {
            const base = `${prefix}${trial_name}/`;
            const result = await this.read(entries.get(`${base}result.json`));
            // TrialLock.task.digest is not the legacy result.task_checksum.
            // Keep locks for finalized trials too; only config reads can be skipped.
            const config = await this.read(entries.get(`${base}config.json`));
            const lock = await this.read(entries.get(`${base}lock.json`));
            const summary =
              result === null ? null : summarizeTrial(runId, trial_name, result);
            return {
              trial_name,
              config,
              lock,
              result: summary ? projectNativeAgentTiming(summary.result) : null,
              reward: summary?.reward ?? null,
              cost_usd: summary?.cost_usd ?? null,
            };
          }),
        )),
      );
    }
    const snapshot = validateTrialProgress({
      observed_at: new Date(this.now()).toISOString(),
      jobs_observed_at: null,
      lock: await this.read(entries.get(`${prefix}lock.json`)),
      trials,
      jobs: [],
    });
    for (const trial of snapshot.trials) {
      if (
        [trial.config?.trial_name, trial.result?.trial_name].some(
          (name) => name !== undefined && name !== trial.trial_name,
        )
      )
        throw new Error("Native trial identity does not match its artifact folder");
    }
    return snapshot;
  }
}

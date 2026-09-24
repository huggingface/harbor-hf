import { canonicalJson, type RunRecordV1 } from "@harbor-hf/contracts";
import type { Projection, RunStatus } from "./projection.js";
import {
  ReplacementError,
  nativeObject,
  type ReplacementNativePort,
  type ReplacementPart,
  type SourceBundle,
} from "./replacement-evidence.js";
import { ReplacementObservation } from "./replacement-observation.js";
import type { ObjectStore } from "./store.js";

export interface ReportedAttemptCostCoverage {
  cost_usd: number | null;
  reported_attempts: number;
  unknown_attempts: number;
  total_attempts: number;
}
export interface ReplacementView {
  run_id: string;
  /** Last full projection observation, not a new execution safety check. */
  observed_at: string | null;
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

/** Native display observations only. Never used to authorize execution. */
export class Replacements {
  private readonly cache = new Map<
    string,
    { key: string; view: ReplacementView; bytes: number }
  >();
  private cacheBytes = 0;
  private readonly inspecting = new Map<string, Promise<ReplacementView>>();
  constructor(
    private readonly store: ObjectStore,
    private readonly projection: Projection,
    private readonly native: ReplacementNativePort,
  ) {}

  private remember(id: string, key: string, view: ReplacementView): void {
    const previous = this.cache.get(id);
    if (previous) {
      this.cacheBytes -= previous.bytes;
      this.cache.delete(id);
    }
    const bytes = Buffer.byteLength(canonicalJson(view));
    if (bytes > 32 * 1024 * 1024) return;
    while (this.cache.size >= 8 || this.cacheBytes + bytes > 32 * 1024 * 1024) {
      const first = this.cache.entries().next().value;
      if (!first) break;
      this.cacheBytes -= first[1].bytes;
      this.cache.delete(first[0]);
    }
    this.cache.set(id, { key, view: structuredClone(view), bytes });
    this.cacheBytes += bytes;
  }

  private async tree(
    source: SourceBundle,
    observation: ReplacementObservation,
  ): Promise<ReplacementPart[]> {
    const parts: ReplacementPart[] = [];
    for (const child of observation.children(source.record.run_id)) {
      const evidence = await observation.bundle(child.record.run_id);
      parts.push({ evidence, parts: await this.tree(evidence, observation) });
    }
    return parts;
  }

  async view(id: string): Promise<ReplacementView> {
    const observation = new ReplacementObservation(this.store, this.projection, id);
    if (observation.observed_at === null) return this.inspect(observation);
    const cached = this.cache.get(id);
    if (cached?.key === observation.key)
      return { ...structuredClone(cached.view), observed_at: observation.observed_at };
    const key = `${id}:${observation.key}`;
    let pending = this.inspecting.get(key);
    if (!pending) {
      pending = this.inspect(observation).finally(() => this.inspecting.delete(key));
      this.inspecting.set(key, pending);
    }
    const view = await pending;
    const latest = new ReplacementObservation(this.store, this.projection, id);
    if (latest.key !== observation.key || latest.observed_at === null)
      throw new ReplacementError(
        409,
        "Projected evidence changed during inspection; retry",
      );
    if (
      view.incurred !== null &&
      (view.assembly.availability === "available" ||
        view.assembly.availability === "none")
    )
      this.remember(id, observation.key, view);
    return { ...structuredClone(view), observed_at: latest.observed_at };
  }

  private async inspect(observation: ReplacementObservation): Promise<ReplacementView> {
    const { id, observed_at } = observation;
    const source = observation.source(id);
    const children = observation.children(id).map(({ record, status }) => ({
      run_id: record.run_id,
      status,
      operator_selection: record.operator_selection!,
    }));
    const view: ReplacementView = {
      run_id: id,
      observed_at,
      operator_selection: source.record.operator_selection ?? null,
      children,
      assembly: {
        availability: children.length ? "unavailable" : "none",
        result: null,
      },
      incurred: null,
      selected_cost_usd: null,
    };
    // Reopened SQLite alone is not an observed source; wait for the normal rebuild.
    if (observed_at === null) return view;
    try {
      view.incurred = observation.incurred();
    } catch {
      /* Unknown coverage, never zero; do not cache a failed cost inspection. */
    }
    if (!children.length) return view;
    const statuses = observation.descendants.map((id) => observation.source(id).status);
    if (observation.live || statuses.some((status) => status !== "finished")) {
      if (
        observation.live ||
        statuses.some((status) => ["queued", "running", "paused"].includes(status))
      )
        view.assembly.availability = "pending";
      return view;
    }
    try {
      const original = await observation.bundle(id);
      const original_ancestors: SourceBundle[] = [];
      for (const ancestor of observation.ancestors)
        original_ancestors.push(await observation.bundle(ancestor));
      const parts = await this.tree(original, observation);
      const { result } = await this.native.replacementAggregate({
        original,
        original_ancestors,
        parts,
      });
      view.assembly = { availability: "available", result };
      const cost = nativeObject(result.stats).cost_usd;
      view.selected_cost_usd =
        typeof cost === "number" && Number.isFinite(cost) ? cost : null;
    } catch {
      view.assembly = { availability: "unavailable", result: null };
    }
    return view;
  }
}

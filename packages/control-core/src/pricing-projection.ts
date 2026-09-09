import type Database from "better-sqlite3";
import {
  validateRunPricingCorrections,
  type RunPricingCorrectionsV1,
} from "@harbor-hf/contracts";
import {
  assertHistoryExtension,
  readPricingCorrections,
  type PricingProjectionView,
} from "./pricing-corrections.js";
import type { ObjectStore } from "./store.js";

/** Disposable columns in the existing runs table; generations fence overlapping rebuilds. */
export class PricingProjection {
  generation = 0;
  private readonly uncertain = new Set<string>();
  private readonly mutations = new Map<string, number>();
  constructor(private readonly db: Database.Database) {
    const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{
      name: string;
    }>;
    for (const [name, definition] of [
      ["pricing_corrections_body", "TEXT"],
      ["pricing_corrections_available", "INTEGER NOT NULL DEFAULT 0"],
    ])
      if (!columns.some((column) => column.name === name))
        db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
  }
  note(id: string): void {
    this.mutations.set(id, ++this.generation);
  }
  committed(id: string): void {
    this.uncertain.delete(id);
    this.note(id);
  }
  read(id: string): PricingProjectionView {
    const row = this.db
      .prepare(
        "SELECT pricing_corrections_body AS body, pricing_corrections_available AS available FROM runs WHERE run_id = ?",
      )
      .get(id) as { body: string | null; available: number } | undefined;
    return this.decode(row?.body ?? null, Boolean(row?.available), id);
  }
  decode(body: string | null, available: boolean, id: string): PricingProjectionView {
    try {
      const history =
        body === null ? null : validateRunPricingCorrections(JSON.parse(body));
      if (history && history.run_id !== id)
        throw new Error("pricing history identity mismatch");
      return {
        pricing_corrections: history,
        pricing_corrections_available: available && !this.uncertain.has(id),
      };
    } catch {
      // Disposable display corruption must not block native run reads or repair.
      return { pricing_corrections: null, pricing_corrections_available: false };
    }
  }

  write(id: string, value: PricingProjectionView): void {
    const result = this.db
      .prepare(
        "UPDATE runs SET pricing_corrections_body = ?, pricing_corrections_available = ? WHERE run_id = ?",
      )
      .run(
        value.pricing_corrections ? JSON.stringify(value.pricing_corrections) : null,
        value.pricing_corrections_available ? 1 : 0,
        id,
      );
    if (result.changes !== 1)
      throw new Error("pricing projection synchronization failed");
  }
  update(id: string, history: RunPricingCorrectionsV1 | null): void {
    assertHistoryExtension(this.read(id).pricing_corrections, history);
    this.write(id, {
      pricing_corrections: history,
      pricing_corrections_available: true,
    });
    this.committed(id);
  }
  unavailable(id: string): void {
    // SQL synchronization can itself fail. Fence readers in memory before trying
    // the disposable write, so readable stale SQL cannot imply confirmed prices.
    this.uncertain.add(id);
    this.note(id);
    try {
      this.write(id, { ...this.read(id), pricing_corrections_available: false });
    } catch {
      /* Rebuild or validated synchronization must clear uncertainty. */
    }
  }
  async load(store: ObjectStore, id: string): Promise<PricingProjectionView> {
    const epoch = this.generation;
    const previous = this.read(id);
    try {
      const history = await readPricingCorrections(store, id);
      assertHistoryExtension(previous.pricing_corrections, history);
      return { pricing_corrections: history, pricing_corrections_available: true };
    } catch {
      // Fail closed before the rebuild transaction: later reads or its commit
      // may fail. An older failed read must not fence a newer synchronization.
      if ((this.mutations.get(id) ?? 0) <= epoch) this.unavailable(id);
      return { ...previous, pricing_corrections_available: false };
    }
  }
  retain(
    id: string,
    epoch: number,
    incoming: PricingProjectionView,
  ): PricingProjectionView {
    const current = this.read(id);
    if ((this.mutations.get(id) ?? 0) > epoch) return current;
    try {
      assertHistoryExtension(current.pricing_corrections, incoming.pricing_corrections);
    } catch {
      return { ...current, pricing_corrections_available: false };
    }
    return incoming;
  }
}

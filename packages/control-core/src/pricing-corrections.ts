import {
  canonicalJson,
  validatePricingCorrectionRequest,
  validateRunPricingCorrections,
  type RunPricingCorrectionsV1,
} from "@harbor-hf/contracts";
import { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
import type { Projection } from "./projection.js";
import { putJson, type ObjectStore } from "./store.js";

export const pricingCorrectionsPath = (id: string): string =>
  `runs/${id}/pricing-corrections.json`;
export interface PricingProjectionView {
  pricing_corrections: RunPricingCorrectionsV1 | null;
  pricing_corrections_available: boolean;
}
export function assertHistoryExtension(
  previous: RunPricingCorrectionsV1 | null,
  next: RunPricingCorrectionsV1 | null,
): void {
  if (
    previous &&
    (!next ||
      previous.revisions.some(
        (entry, index) => canonicalJson(entry) !== canonicalJson(next.revisions[index]),
      ))
  )
    throw new Error("pricing history changed or regressed");
}
export async function readPricingCorrections(
  store: ObjectStore,
  id: string,
): Promise<RunPricingCorrectionsV1 | null> {
  try {
    const value = validateRunPricingCorrections(
      JSON.parse(
        new TextDecoder().decode(
          await store.read(pricingCorrectionsPath(id), { fresh: true }),
        ),
      ),
    );
    if (value.run_id !== id) throw new Error("pricing history identity mismatch");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export class PricingConflictError extends Error {
  constructor() {
    super("Pricing revision changed; review current history before retrying");
  }
}
export class PricingUpdateError extends Error {
  constructor() {
    super(
      "Pricing correction could not be confirmed; reload and review history before retrying",
    );
  }
}
/** Caller holds the existing authority's run lock. No execution or Jobs operations. */
export async function correctPricing(
  store: ObjectStore,
  projection: Projection,
  id: string,
  body: unknown,
  actor: string,
): Promise<RunPricingCorrectionsV1> {
  const input = validatePricingCorrectionRequest(body);
  if (containsCredentialMaterial(input))
    throw new Error("Pricing correction contains a credential literal");
  const view = projection.run(id);
  if (!view) throw new Error("run was not found");
  try {
    const current = await readPricingCorrections(store, id);
    assertHistoryExtension(view.pricing_corrections ?? null, current);
    // Synchronize even stale intents and ambiguous retries before reporting conflict.
    projection.pricing.update(id, current);
    if ((current?.revisions.length ?? 0) !== input.expected_revision)
      throw new PricingConflictError();
    const next = validateRunPricingCorrections({
      schema_version: "v1",
      run_id: id,
      revisions: [
        ...(current?.revisions ?? []),
        {
          revision: input.expected_revision + 1,
          actor,
          updated_at: new Date().toISOString(),
          reason: input.reason.trim(),
          pricing: input.pricing,
        },
      ],
    });
    await putJson(store, pricingCorrectionsPath(id), next);
    projection.pricing.update(id, next);
    return next;
  } catch (error) {
    if (error instanceof PricingConflictError) throw error;
    projection.pricing.unavailable(id);
    throw new PricingUpdateError();
  }
}

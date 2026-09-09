import type { LaunchPricingV1 } from "@harbor-hf/contracts";
import type { RunView, LeaderboardRow } from "./api";
import validatePricing from "./generated/launch-pricing-validator.js";
import { parseRate } from "./pricing";
import { CostValue } from "./run-summary-cards";
import { Hint } from "./ui";
import type { WorkbenchDraft } from "./workbench-draft";

export const emptyLaunchPricing = { enabled: false, input: "", cached: "", output: "" };
export function finalizedPricing(
  draft: NonNullable<WorkbenchDraft["pricing"]>,
): LaunchPricingV1 | null {
  const value = {
    currency: "USD",
    input_usd_per_million: parseRate(draft.input),
    cached_usd_per_million: parseRate(draft.cached),
    output_usd_per_million: parseRate(draft.output),
  };
  return validatePricing(value) ? value : null;
}
export const estimateMeaning =
  "Estimate from immutable launch rates and reported usage, not billed charges. Reported aggregates may be partial; availability does not establish complete usage coverage.";
export function pricingDescription(pricing: LaunchPricingV1 | undefined): string {
  return pricing
    ? `USD/M: input ${pricing.input_usd_per_million}, cached ${pricing.cached_usd_per_million}, output ${pricing.output_usd_per_million}. Input includes cache; cached tokens are charged only at the cached rate.`
    : "Launch pricing was not recorded.";
}
export function LaunchEstimate({ run }: { run: RunView }) {
  return (
    <Hint text={`${pricingDescription(run.record.pricing)} ${estimateMeaning}`}>
      <span>
        <CostValue
          value={run.shared_estimate?.cost_usd ?? null}
          label="Launch estimate (USD)"
        />
      </span>
    </Hint>
  );
}
export function GroupLaunchEstimate({ row }: { row: LeaderboardRow }) {
  const estimate = row.shared_estimate;
  return (
    <Hint text={estimateMeaning}>
      <span>
        <CostValue value={estimate?.cost_usd ?? null} label="Launch estimate (USD)" />
        {estimate &&
        estimate.estimated_runs > 0 &&
        estimate.estimated_runs < estimate.total_runs ? (
          <span className="block text-xs text-slate-400">
            {estimate.estimated_runs}/{estimate.total_runs} runs · partial subtotal
          </span>
        ) : null}
      </span>
    </Hint>
  );
}

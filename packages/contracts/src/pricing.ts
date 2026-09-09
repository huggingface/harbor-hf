import type { LaunchPricingV1, SharedEstimateV1 } from "./generated/index.js";
export interface TokenUsage {
  input: number | null;
  output: number | null;
  cached: number | null;
}
export interface TokenRates {
  input: number | null;
  output: number | null;
  cached: number | null;
}
export const MAX_TOKEN_RATE = 1_000_000;
export function estimateScenario(usage: TokenUsage, rates: TokenRates): number | null {
  const { input, output, cached } = usage;
  if (
    input === null ||
    output === null ||
    cached === null ||
    ![input, output, cached].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    cached > input
  )
    return null;
  const { input: rateIn, output: rateOut, cached: rateCache } = rates;
  if (
    rateIn === null ||
    rateOut === null ||
    rateCache === null ||
    ![rateIn, rateOut, rateCache].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= MAX_TOKEN_RATE,
    )
  )
    return null;
  return (
    ((input - cached) * rateIn + cached * rateCache + output * rateOut) / 1_000_000
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function launchEstimate(
  pricing: LaunchPricingV1 | undefined,
  result: unknown,
): SharedEstimateV1 {
  const stats = object(object(result)?.stats);
  const token = (key: string): number | null =>
    typeof stats?.[key] === "number" ? stats[key] : null;
  const cost = pricing
    ? estimateScenario(
        {
          input: token("n_input_tokens"),
          output: token("n_output_tokens"),
          cached: token("n_cache_tokens"),
        },
        {
          input: pricing.input_usd_per_million,
          output: pricing.output_usd_per_million,
          cached: pricing.cached_usd_per_million,
        },
      )
    : null;
  return {
    basis: "launch_rates_reported_usage",
    cost_usd: cost,
    unavailable_reason: !pricing
      ? "pricing_unset"
      : cost === null
        ? "usage_unavailable"
        : null,
  };
}

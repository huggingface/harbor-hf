import { resultStat } from "./run-summary";

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
export const DEFAULT_CONTEXT_THRESHOLD = 272_000;
export const MAX_TOKEN_RATE = 1_000_000;
export const TIER_LIMITATION =
  "Per-request tier usage is unavailable. The request-input threshold cannot be applied to cumulative run or trial tokens.";

export function reportedUsage(result: unknown): TokenUsage {
  return {
    input: resultStat(result, "n_input_tokens"),
    output: resultStat(result, "n_output_tokens"),
    cached: resultStat(result, "n_cache_tokens"),
  };
}

export function parseRate(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= MAX_TOKEN_RATE ? value : null;
}

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

// No threshold argument: cumulative usage cannot determine request-level tiers.
export function pricingScenarios(
  usage: TokenUsage,
  standard: TokenRates,
  longContext: TokenRates,
) {
  return {
    standard: estimateScenario(usage, standard),
    longContext: estimateScenario(usage, longContext),
    actual: null,
  };
}

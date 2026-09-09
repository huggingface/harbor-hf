import {
  estimateScenario,
  MAX_TOKEN_RATE,
  type TokenUsage,
  type TokenRates,
} from "@harbor-hf/contracts/pricing";
export {
  estimateScenario,
  MAX_TOKEN_RATE,
  type TokenUsage,
  type TokenRates,
} from "@harbor-hf/contracts/pricing";
import { resultStat } from "./run-summary";

export const DEFAULT_CONTEXT_THRESHOLD = 272_000;

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

import { describe, expect, it } from "vitest";
import { validateLaunchPricing } from "../src/index.js";
import { estimateScenario, launchEstimate } from "../src/pricing.js";
import browserValidator from "../../../apps/control-web/src/generated/launch-pricing-validator.js";

const pricing = {
  currency: "USD",
  input_usd_per_million: 2,
  cached_usd_per_million: 0.5,
  output_usd_per_million: 8,
} as const;
const stats = {
  n_input_tokens: 1_000_000,
  n_cache_tokens: 250_000,
  n_output_tokens: 100_000,
};
describe("immutable launch pricing", () => {
  it("uses inclusive cache arithmetic and preserves unknown pricing", () => {
    expect(launchEstimate(pricing, { stats }).cost_usd).toBe(2.425);
    expect(launchEstimate(undefined, { stats })).toEqual({
      basis: "launch_rates_reported_usage",
      cost_usd: null,
      unavailable_reason: "pricing_unset",
    });
    expect(
      launchEstimate(pricing, {
        stats: { ...stats, cost_usd: 99 },
        finished_at: "2026-01-01",
      }).cost_usd,
    ).toBe(2.425);
  });
  it.each([0, 1_000_000])("accepts schema bounds including free rates: %s", (rate) => {
    const value = {
      ...pricing,
      input_usd_per_million: rate,
      cached_usd_per_million: rate,
      output_usd_per_million: rate,
    };
    expect(validateLaunchPricing(value)).toEqual(value);
    expect(browserValidator(value)).toBe(true);
    expect(launchEstimate(value, { stats }).cost_usd).toBe(rate * 1.1);
  });
  it.each([
    null,
    {},
    { ...pricing, currency: "EUR" },
    { ...pricing, extra: 1 },
    ...["input", "output", "cached"].flatMap((key) =>
      [undefined, null, "", "0", -1, Infinity, NaN, 1_000_001].map((value) => ({
        ...pricing,
        [`${key}_usd_per_million`]: value,
      })),
    ),
  ])("rejects invalid schema and CSP validator inputs: %j", (value) => {
    expect(() => validateLaunchPricing(value)).toThrow();
    expect(browserValidator(value)).toBe(false);
  });
  it.each(["n_input_tokens", "n_output_tokens", "n_cache_tokens"])(
    "requires safe integer %s even for free rates",
    (key) => {
      for (const value of [
        undefined,
        null,
        -1,
        0.5,
        Infinity,
        NaN,
        Number.MAX_SAFE_INTEGER + 1,
        "0",
      ]) {
        expect(
          launchEstimate(pricing, { stats: { ...stats, [key]: value } }),
        ).toMatchObject({ cost_usd: null, unavailable_reason: "usage_unavailable" });
      }
    },
  );
  it("rejects cache exceeding input and preserves all-zero usage", () => {
    expect(
      launchEstimate(pricing, { stats: { ...stats, n_cache_tokens: 1_000_001 } })
        .cost_usd,
    ).toBeNull();
    expect(
      estimateScenario(
        { input: 0, output: 0, cached: 0 },
        { input: 2, output: 8, cached: 0.5 },
      ),
    ).toBe(0);
    for (const result of [undefined, null, [], { stats: [] }, { stats: null }])
      expect(launchEstimate(pricing, result).cost_usd).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  estimateScenario,
  parseRate,
  pricingScenarios,
  reportedUsage,
} from "../src/pricing";

const rates = { input: 2, output: 8, cached: 0.5 };
const usage = { input: 1_000_000, output: 100_000, cached: 250_000 };
describe("display-only pricing", () => {
  it("subtracts cache from inclusive input instead of double counting", () => {
    expect(estimateScenario(usage, rates)).toBe(2.425);
    expect(estimateScenario({ input: 100, cached: 100, output: 0 }, rates)).toBe(
      0.00005,
    );
    expect(estimateScenario({ input: 100, cached: 0, output: 0 }, rates)).toBe(0.0002);
  });
  it("preserves zero rates and zero usage", () => {
    expect(estimateScenario(usage, { input: 0, output: 0, cached: 0 })).toBe(0);
    expect(estimateScenario({ input: 0, output: 0, cached: 0 }, rates)).toBe(0);
  });
  it.each([null, -1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid usage %s in each field",
    (value) => {
      for (const key of ["input", "output", "cached"] as const)
        expect(estimateScenario({ ...usage, [key]: value }, rates)).toBeNull();
    },
  );
  it.each([null, -1, Infinity, NaN, 1_000_001])(
    "rejects invalid rates %s in each field",
    (value) => {
      for (const key of ["input", "output", "cached"] as const)
        expect(estimateScenario(usage, { ...rates, [key]: value })).toBeNull();
    },
  );
  it("rejects cache exceeding input", () => {
    expect(estimateScenario({ ...usage, cached: usage.input + 1 }, rates)).toBeNull();
  });
  it.each(["", " ", "NaN", "Infinity", "-0.01", "1000001", "bad"])(
    "does not turn missing or invalid rate %j into zero",
    (text) => expect(parseRate(text)).toBeNull(),
  );
  it.each([
    ["0", 0],
    ["0.25", 0.25],
    [" 2 ", 2],
    ["1000000", 1_000_000],
  ])("accepts rate %s", (text, expected) =>
    expect(parseRate(String(text))).toBe(expected),
  );
  it("reads only native numeric usage and preserves missing fields", () => {
    expect(reportedUsage(null)).toEqual({ input: null, output: null, cached: null });
    expect(
      reportedUsage({ stats: { n_input_tokens: 0, n_output_tokens: "1" } }),
    ).toEqual({ input: 0, output: null, cached: null });
    expect(
      estimateScenario(
        reportedUsage({ stats: { n_input_tokens: 12, n_output_tokens: 4 } }),
        rates,
      ),
    ).toBeNull();
  });
  it.each([0, 272_000, 272_001, 1_000_000, 9_000_000])(
    "cumulative input %s never selects a tier",
    (input) => {
      const value = { input, cached: 0, output: 0 };
      expect(
        pricingScenarios(value, rates, { input: 4, cached: 1, output: 16 }),
      ).toEqual({
        standard: (input * 2) / 1e6,
        longContext: (input * 4) / 1e6,
        actual: null,
      });
    },
  );
});

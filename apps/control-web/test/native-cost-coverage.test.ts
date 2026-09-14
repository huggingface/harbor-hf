import { describe, expect, it } from "vitest";
import { costCoverageLabel, nativeCostCoverage } from "../src/native-cost-coverage";

const result = (...trial_results: unknown[]) => ({ trial_results });
describe("native cost coverage", () => {
  it("counts native zero as reported and null/absent contexts as missing", () => {
    expect(
      nativeCostCoverage(
        result(
          { agent_result: { cost_usd: 0 } },
          { agent_result: { cost_usd: 2 } },
          { agent_result: { cost_usd: null } },
          { agent_result: null },
          {},
        ),
      ),
    ).toEqual({ total: 5, missing: 3 });
  });
  it("gives a present agent context precedence over step costs", () => {
    expect(
      nativeCostCoverage(
        result({
          agent_result: { cost_usd: null },
          step_results: [{ agent_result: { cost_usd: 3 } }],
        }),
      ),
    ).toEqual({ total: 1, missing: 1 });
  });
  it("counts a partially reported multistep native total as reported, not fully covered", () => {
    const input = result(
      {
        step_results: [
          { agent_result: null },
          { agent_result: { cost_usd: 2 } },
          { agent_result: { cost_usd: null } },
        ],
      },
      { step_results: [{ agent_result: {} }] },
      { step_results: [] },
    );
    expect(nativeCostCoverage(input)).toEqual({ total: 3, missing: 2 });
    expect(costCoverageLabel(input)).toContain(
      "2 of 3 native trial results missing reported cost",
    );
    expect(costCoverageLabel(input)).toContain("partial within a trial");
  });
  it.each([
    null,
    {},
    { trial_results: null },
    { trial_results: {} },
    result(null),
    result(4),
    result({ agent_result: [] }),
    result({ step_results: {} }),
    result({ step_results: [null] }),
    ...[NaN, Infinity, -1, "2"].map((cost_usd) =>
      result({ agent_result: { cost_usd } }),
    ),
  ])("does not invent coverage for absent or malformed evidence %j", (input) => {
    expect(nativeCostCoverage(input)).toBeNull();
    expect(costCoverageLabel(input)).toMatch(/^Cost coverage unavailable/);
  });
  it("distinguishes an explicitly empty selected cohort", () => {
    expect(nativeCostCoverage(result())).toEqual({ total: 0, missing: 0 });
  });
});

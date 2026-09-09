import { cacheHitRate } from "../src/run-summary";
import { describe, expect, it } from "vitest";
import { categoryCounts, exceptionCategory } from "../src/exception-categories";
import { projectRunExceptions } from "../src/run-diagnostics";
import {
  millionTokens,
  nativeScore,
  progressPercent,
  resultStat,
  roundedScore,
} from "../src/run-summary";

const result = (metrics: unknown, reward_stats: unknown = { reward: {} }) => ({
  stats: { evals: { one: { metrics, reward_stats } } },
});
describe("native summary", () => {
  it("rounds display only and retains the native metric label", () => {
    const score = nativeScore(result([{ mean: 0.5168539325842697 }]));
    expect(score).toEqual({ value: 0.5168539325842697, label: "Score · reward mean" });
    expect(roundedScore(score.value)).toBe("0.517");
    expect(nativeScore(result([{ mean: 0 }])).value).toBe(0);
    expect(roundedScore(0)).toBe("0.000");
  });
  it.each([
    null,
    {},
    result([]),
    result(null),
    result([null]),
    result([{ mean: null }]),
    result([{ mean: Infinity }]),
    result([{ accuracy: 0.5 }]),
    result([{ mean: 0.5 }, { mean: 1 }]),
    result([{ mean: 0.5, other: 1 }]),
    {
      stats: {
        evals: { one: { metrics: [{ mean: 0.5 }] }, two: { metrics: [{ mean: 1 }] } },
      },
    },
  ])("does not manufacture a score for %j", (value) => {
    expect(nativeScore(value).value).toBeNull();
    expect(roundedScore(nativeScore(value).value)).toBe("-");
  });
  it("uses mean label when reward identity is missing or ambiguous", () => {
    expect(nativeScore(result([{ mean: 0.5 }], {})).label).toBe("Score · mean");
    expect(nativeScore(result([{ mean: 0.5 }], { a: {}, b: {} })).label).toBe(
      "Score · mean",
    );
  });
  it("reports million-scale tokens without changing raw stats", () => {
    expect(millionTokens(1_234_567)).toBe("1.235M");
    expect(millionTokens(0)).toBe("0.000M");
    expect(millionTokens(null)).toBe("-");
    expect(resultStat({ stats: { n_input_tokens: 1_234_567 } }, "n_input_tokens")).toBe(
      1_234_567,
    );
  });
  it.each([1, 120, 499, 500])("keeps positive small usage %i visible", (value) => {
    expect(millionTokens(value)).toBe("<0.001M");
  });
  it("shows the million-scale boundary", () => {
    expect(millionTokens(1000)).toBe("0.001M");
  });
  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite formatter input %s",
    (value) => {
      expect(millionTokens(value)).toBe("-");
      expect(roundedScore(value)).toBe("-");
    },
  );
  it("rejects negative usage", () => expect(millionTokens(-1)).toBe("-"));
  it("converts completed ratios into percent, not fraction", () => {
    expect(progressPercent(89, 89)).toBe(100);
    expect(progressPercent(1, 4)).toBe(25);
    expect(progressPercent(0, 89)).toBe(0);
  });
  it.each([
    [null, 89],
    [1, null],
    [1, 0],
    [-1, 89],
    [90, 89],
    [Infinity, 89],
    [1, NaN],
  ])("keeps invalid progress unknown", (completed, total) =>
    expect(progressPercent(completed, total)).toBeNull(),
  );
});

describe("conservative exact exception categories", () => {
  it.each([
    "EnvironmentStartTimeoutError",
    "GKEExecStreamClosedError",
    "NetworkConnectionError",
  ])("categorizes %s as environment/transport", (type) =>
    expect(exceptionCategory(type)).toBe("Environment / transport"),
  );
  it.each([
    "ApiInternalServerError",
    "ApiOverloadedError",
    "ApiConnectionClosedError",
    "ApiResponseStalledError",
  ])("categorizes %s as provider failure", (type) =>
    expect(exceptionCategory(type)).toBe("Provider failure"),
  );
  it.each([
    "VerifierTimeoutError",
    "AddTestsDirError",
    "VerifierOutputParseError",
    "DownloadVerifierDirError",
    "RewardFileNotFoundError",
    "RewardFileEmptyError",
  ])("keeps %s separate from infra", (type) =>
    expect(exceptionCategory(type)).toBe("Verifier exception"),
  );
  it.each([
    "RuntimeError",
    "environmentstarttimeouterror",
    "ApiOverloadedError: failure",
    "toString",
    "__proto__",
    "reward 0",
  ])("does not infer %s", (type) =>
    expect(exceptionCategory(type)).toBe("Unclassified"),
  );
  it("deduplicates affected and infra trials across types and partial evaluations", () => {
    const evidence = projectRunExceptions({
      stats: {
        evals: {
          a: {
            exception_stats: {
              EnvironmentStartTimeoutError: ["a", "a"],
              ApiOverloadedError: ["a", "b"],
              ApiRateLimitError: ["c"],
              RewardFileEmptyError: ["d"],
              RuntimeError: ["e"],
            },
          },
          missing: {},
        },
      },
    });
    expect(evidence.complete).toBe(false);
    expect(evidence.affectedTrials).toBe(5);
    expect(categoryCounts(evidence.groups).infra).toBe(2);
    expect(categoryCounts(evidence.groups).categories).toContainEqual({
      category: "Rate limit",
      count: 1,
    });
  });
  it("does not turn zero reward into an exception", () => {
    const evidence = projectRunExceptions({
      stats: {
        evals: { a: { exception_stats: {}, reward_stats: { reward: { 0: ["a"] } } } },
      },
    });
    expect(evidence.affectedTrials).toBe(0);
    expect(categoryCounts(evidence.groups).infra).toBe(0);
  });
});

describe("cache hit percentage", () => {
  it.each([
    [0, 100, "0.0%"],
    [1, 3, "33.3%"],
    [2, 3, "66.7%"],
    [100, 100, "100.0%"],
    [0, 0, "-"],
    [null, 100, "-"],
    [undefined, 100, "-"],
    [0, null, "-"],
    [0, undefined, "-"],
    [-1, 100, "-"],
    [0, -1, "-"],
    [101, 100, "-"],
    [NaN, 100, "-"],
    [1, Infinity, "-"],
    [Infinity, 100, "-"],
    [1, NaN, "-"],
  ])("formats cache %s / input %s", (cached, input, expected) => {
    expect(cacheHitRate(cached, input)).toBe(expected);
  });
});

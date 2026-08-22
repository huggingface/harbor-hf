import { describe, expect, it } from "vitest";
import { attemptAdmissibility } from "../src/attempt-admissibility.js";

const required = ["input_tokens", "output_tokens"];

function check(metrics: Record<string, number>, outcome = "complete") {
  return attemptAdmissibility({ outcome: outcome as "complete", metrics }, required);
}

describe("attempt admissibility", () => {
  it("accepts positive integer input and output tokens", () => {
    expect(check({ input_tokens: 1, output_tokens: 2 })).toEqual({
      admissible: true,
      reason: null,
    });
  });

  it.each([
    [{ output_tokens: 1 }, "missing required metric: input_tokens"],
    [{ input_tokens: 1 }, "missing required metric: output_tokens"],
    [
      { input_tokens: 0, output_tokens: 1 },
      "required metric is not positive: input_tokens",
    ],
    [
      { input_tokens: 1, output_tokens: 0 },
      "required metric is not positive: output_tokens",
    ],
    [
      { input_tokens: -1, output_tokens: 1 },
      "required metric is not positive: input_tokens",
    ],
    [
      { input_tokens: 1.5, output_tokens: 1 },
      "required metric is not positive: input_tokens",
    ],
    [
      { input_tokens: Number.NaN, output_tokens: 1 },
      "required metric is not positive: input_tokens",
    ],
    [
      { input_tokens: Number.POSITIVE_INFINITY, output_tokens: 1 },
      "required metric is not positive: input_tokens",
    ],
  ])("rejects invalid required metrics", (metrics, reason) => {
    expect(check(metrics as Record<string, number>)).toEqual({
      admissible: false,
      reason,
    });
  });

  it("ignores token metrics that the locked policy does not require", () => {
    expect(
      attemptAdmissibility({ outcome: "complete", metrics: { input_tokens: 0 } }, []),
    ).toEqual({ admissible: true, reason: null });
  });

  it("rejects infrastructure and cancelled outcomes", () => {
    expect(
      attemptAdmissibility(
        { outcome: "infrastructure", metrics: { input_tokens: 1, output_tokens: 1 } },
        required,
      ),
    ).toMatchObject({ admissible: false });
    expect(
      attemptAdmissibility(
        { outcome: "cancelled", metrics: { input_tokens: 1, output_tokens: 1 } },
        required,
      ),
    ).toMatchObject({ admissible: false });
  });
});

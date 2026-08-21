import { describe, expect, it } from "vitest";
import { historicalDispositionResourceMatches } from "../src/disposition-policy.js";

describe("historical disposition resource policy", () => {
  it("accepts an omitted or matching source observation", () => {
    expect(historicalDispositionResourceMatches(null, "sandbox-one")).toBe(true);
    expect(historicalDispositionResourceMatches("sandbox-one", "sandbox-one")).toBe(
      true,
    );
  });

  it("rejects missing, malformed, or conflicting evidence", () => {
    expect(historicalDispositionResourceMatches("sandbox-two", "sandbox-one")).toBe(
      false,
    );
    expect(historicalDispositionResourceMatches(undefined, "sandbox-one")).toBe(false);
    expect(historicalDispositionResourceMatches(null, undefined)).toBe(false);
    expect(historicalDispositionResourceMatches(null, "")).toBe(false);
    expect(historicalDispositionResourceMatches(null, 1)).toBe(false);
  });
});

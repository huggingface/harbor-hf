import { describe, expect, it } from "vitest";
import {
  asRecord,
  formatDuration,
  formatMoney,
  formatMoneyUsd,
  formatPercent,
  formatTokens,
  humanize,
  logicalOutcomeHint,
  logicalOutcomeLabel,
  numberValue,
  runNameClass,
  shortId,
  stringValue,
} from "../src/lib";

describe("display formatting", () => {
  it("formats money, rates, tokens, durations, and identifiers", () => {
    expect(formatMoney(250_000)).toContain("0.25");
    expect(formatMoneyUsd(0.0025)).toContain("0.0025");
    expect(formatMoneyUsd(null)).toBe("Unavailable");
    expect(formatPercent(0.5)).toBe("50.0%");
    expect(formatTokens(191_573).replace(/\D/g, "")).toBe("191573");
    expect(formatTokens(null)).toBe("Unavailable");
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T01:02:03Z")).toBe(
      "1h 2m",
    );
    expect(formatDuration(null, null)).toBe("Unavailable");
    expect(shortId("run-0123456789abcdef0123456789abcdef")).toContain("…");
    expect(humanize("cost_stopped")).toBe("Cost Stopped");
  });

  it("wraps complete run names instead of forcing a wide column", () => {
    expect(runNameClass).toContain("break-all");
    expect(runNameClass).toContain("min-w-0");
    expect(runNameClass).not.toContain("min-w-[20rem]");
  });
});

describe("safe result readers", () => {
  it("accepts only the expected primitive shapes", () => {
    expect(asRecord({ reward: 1 })).toEqual({ reward: 1 });
    expect(asRecord([])).toBeNull();
    expect(numberValue(1.5)).toBe(1.5);
    expect(numberValue(Number.NaN)).toBeNull();
    expect(stringValue("value")).toBe("value");
    expect(stringValue("")).toBeNull();
  });
});

describe("logical outcome labels", () => {
  it("uses stable plain-language labels and safe fallbacks", () => {
    expect(logicalOutcomeLabel("policy")).toBe("Provider rejected the request");
    expect(logicalOutcomeHint("policy")).toContain("provider");
    expect(logicalOutcomeLabel("agent")).toBe("Agent ended without a score");
    expect(logicalOutcomeLabel("complete")).toBe("Complete");
    expect(logicalOutcomeLabel(null)).toBe("Not complete");
    expect(logicalOutcomeLabel("future_status")).toBe("Future Status");
    expect(logicalOutcomeHint("future_status")).toBe("Harbor reported this outcome.");
  });
});

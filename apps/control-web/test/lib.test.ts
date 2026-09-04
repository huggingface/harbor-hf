import { describe, expect, it } from "vitest";
import {
  estimateLaunchReservationMicrousd,
  formatPercent,
  formatPercentInterval,
  formatTokens,
  logicalOutcomeHint,
  logicalOutcomeLabel,
  runNameClass,
} from "../src/lib";

describe("launch reservation estimate", () => {
  it("counts one execution reservation per trial Job", () => {
    expect(
      estimateLaunchReservationMicrousd(
        445,
        { preparation: "required" },
        {
          reservation_microusd: 5_100_000,
          preparation_reservation_microusd: 100_000,
          max_preparation_attempts: 2,
        },
      ),
    ).toBe(2_269_700_000);
  });

  it("counts every trial Job", () => {
    expect(
      estimateLaunchReservationMicrousd(10, {}, { reservation_microusd: 1_000_000 }),
    ).toBe(10_000_000);
  });
});

describe("result formatting", () => {
  it("renders percents and token counts for the Results page", () => {
    expect(formatPercent(0.5)).toBe("50.0%");
    expect(formatPercentInterval({ low: 0.095, high: 0.905 })).toBe("9.5%–90.5%");
    expect(formatTokens(191_573).replace(/\D/g, "")).toBe("191573");
    expect(formatTokens(null)).toBe("—");
  });

  it("wraps complete run names instead of forcing a wide column", () => {
    expect(runNameClass).toContain("break-all");
    expect(runNameClass).toContain("min-w-0");
    expect(runNameClass).not.toContain("min-w-[20rem]");
    expect(runNameClass).not.toContain("min-w-[22rem]");
  });
});

describe("logical outcome labels", () => {
  it("names policy and agent failures in words", () => {
    expect(logicalOutcomeLabel("policy")).toBe("Provider rejected the request");
    expect(logicalOutcomeHint("policy")).toContain("authentication");
    expect(logicalOutcomeLabel("agent")).toBe("Agent ended without a score");
    expect(logicalOutcomeHint("agent")).toContain("no valid final response");
    expect(logicalOutcomeLabel("complete")).toBe("Scored success");
    expect(logicalOutcomeLabel(null)).toBe("Not sealed yet");
  });

  it("rejects an unknown outcome instead of showing the raw token", () => {
    expect(() => logicalOutcomeLabel("mystery")).toThrow("unknown logical outcome");
  });
});

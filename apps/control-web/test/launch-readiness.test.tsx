// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaunchReadiness, type LaunchChecks } from "../src/launch-readiness";
import { finalizedPricing, launchRateError } from "../src/launch-pricing";

const ready: LaunchChecks = {
  setup_matches: true,
  direct_route: true,
  confirmed: true,
  pricing_valid: true,
  reasoning_valid: true,
  writes_allowed: true,
  idle: true,
  operator: true,
};
const pricing = { enabled: true, input: "0.006", cached: "0", output: "0.06" };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("launch rate errors", () => {
  it.each(["0", "0.006", " 0.006 ", "0.000001", "1000000", "6e-3"])(
    "accepts %s consistently with submission validation",
    (text) => {
      expect(launchRateError(text)).toBeNull();
      expect(finalizedPricing({ ...pricing, cached: text })).not.toBeNull();
    },
  );
  it.each(["", " \t "])("distinguishes missing rate %j from zero", (text) => {
    expect(launchRateError(text)).toBe("Enter a rate. Blank is not zero.");
    expect(finalizedPricing({ ...pricing, cached: text })).toBeNull();
  });
  it.each(["0,006", "$0.006", "0.006 USD/M", "-0.1", "1000001", "NaN", "Infinity"])(
    "explains invalid rate %s without echoing it",
    (text) => {
      expect(launchRateError(text)).toBe(
        "Use a number from 0 to 1,000,000, such as 0.006 (decimal point).",
      );
      expect(finalizedPricing({ ...pricing, cached: text })).toBeNull();
    },
  );
});

describe("launch readiness", () => {
  it.each(Object.keys(ready) as (keyof LaunchChecks)[])(
    "identifies the %s gate",
    (key) => {
      render(<LaunchReadiness checks={{ ...ready, [key]: false }} pricing={pricing} />);
      expect(screen.getByText("Launch is blocked:")).toBeVisible();
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
      const summary = screen.getByLabelText<HTMLTextAreaElement>(
        "Launch diagnostic summary",
      );
      const diagnostic: unknown = JSON.parse(summary.value);
      expect(diagnostic).toMatchObject({ checks: { [key]: false } });
    },
  );

  it("does not equate form readiness with server credential approval", () => {
    render(<LaunchReadiness checks={ready} pricing={pricing} />);
    expect(
      screen.getByText(
        "Launch checks passed. Required form fields and server approval are still checked on submission.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Launch is blocked:")).toBeNull();
    expect(
      screen.getByText(/Pricing and benchmark changes do not require/),
    ).toBeVisible();
  });

  it("projects only allowlisted flags and parsed rates, never raw inputs or extra fields", () => {
    const checks = {
      ...ready,
      pricing_valid: false,
      internal_identity: "synthetic-private-identity",
    };
    const input = {
      ...pricing,
      input: "synthetic-sensitive-input",
      cached: "",
      credential_ref: "synthetic-private-reference",
    };
    render(<LaunchReadiness checks={checks} pricing={input} />);
    const summary = screen.getByLabelText<HTMLTextAreaElement>(
      "Launch diagnostic summary",
    );
    expect(summary).toHaveAttribute("readonly");
    expect(summary.value).not.toContain("synthetic-");
    const diagnostic: unknown = JSON.parse(summary.value);
    expect(diagnostic).toEqual({
      checks: { ...ready, pricing_valid: false },
      pricing: {
        enabled: true,
        rates: {
          input: { state: "invalid", usd_per_million: null },
          cached: { state: "blank", usd_per_million: null },
          output: { state: "valid", usd_per_million: 0.06 },
        },
      },
      server_credential_approval: "checked by server on submission, not by setup",
    });
  });

  it("copies numeric rates without treating copy as a submission", async () => {
    const user = userEvent.setup();
    render(<LaunchReadiness checks={ready} pricing={pricing} />);
    await user.click(screen.getByText("Show launch checks (no secrets)"));
    const button = screen.getByRole("button", { name: "Copy launch checks" });
    expect(button).toHaveAttribute("type", "button");
    await user.click(button);
    expect(await screen.findByText("Launch checks copied.")).toBeVisible();
    const diagnostic: unknown = JSON.parse(await navigator.clipboard.readText());
    expect(diagnostic).toMatchObject({
      pricing: {
        rates: { input: { usd_per_million: 0.006 }, cached: { usd_per_million: 0 } },
      },
    });
  });

  it("offers manual copying if the clipboard is unavailable", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
      new Error("denied"),
    );
    render(<LaunchReadiness checks={ready} pricing={{ ...pricing, enabled: false }} />);
    await user.click(screen.getByText("Show launch checks (no secrets)"));
    await user.click(screen.getByRole("button", { name: "Copy launch checks" }));
    expect(
      await screen.findByText(
        "Clipboard unavailable. Select and copy the summary above.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Launch diagnostic summary")).toBeVisible();
  });
});

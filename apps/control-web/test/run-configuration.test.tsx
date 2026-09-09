// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../src/api";
import { RunConfiguration } from "../src/run-configuration";

afterEach(cleanup);

describe("stored agent configuration display", () => {
  it("preserves mixed-run attribution without claiming runtime defaults", () => {
    const record = {
      harbor_job_config: {
        agents: [
          {
            name: "alpha",
            model_name: "provider/first",
            kwargs: { reasoning_effort: "high", version: "1" },
          },
          {
            import_path: "example.agent:Agent",
            model_name: "provider/second?reasoning=max",
            kwargs: {},
          },
        ],
      },
    } as RunRecord;
    render(<RunConfiguration record={record} />);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByText("reasoning_effort=high")).toBeInTheDocument();
    expect(within(rows[0]).getByText("provider/first")).toBeInTheDocument();
    expect(
      within(rows[1]).getByText("Not recorded in native kwargs"),
    ).toBeInTheDocument();
    expect(
      within(rows[1]).getByText("provider/second?reasoning=max"),
    ).toBeInTheDocument();
    expect(screen.getByText(/not verified provider requests/)).toBeInTheDocument();
    expect(
      screen.getByText(/Missing reasoning options do not mean reasoning is off/),
    ).toBeInTheDocument();
  });

  it("shows unavailable rather than a guessed agent when configuration is missing", () => {
    render(<RunConfiguration record={{ harbor_job_config: {} } as RunRecord} />);
    expect(screen.getByText("Agent configuration unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});

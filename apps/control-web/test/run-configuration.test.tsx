// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../src/api";
import { RunConfiguration } from "../src/run-configuration";

afterEach(cleanup);

describe("stored agent configuration display", () => {
  it.each(["100", "75", "high", "  custom value  ", "", "off"])(
    "shows exact recorded intent separately from configuration: %j",
    (reasoning_effort) => {
      const record = {
        submission: { model: { reasoning_effort } },
        harbor_job_config: { agents: [] },
      } as unknown as RunRecord;
      const { container } = render(<RunConfiguration record={record} />);
      expect(container.querySelector("dd")?.textContent).toBe(
        reasoning_effort === "" ? "Unset (empty text)" : reasoning_effort,
      );
      expect(container.querySelector("dd")).toHaveClass("whitespace-pre-wrap");
      expect(
        screen.getByText("Recorded reasoning intent (submission metadata)"),
      ).toBeInTheDocument();
    },
  );
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

describe("reasoning provenance", () => {
  it.each([
    ["off", "off"],
    ["", "Unset (empty text)"],
    [undefined, "Unavailable"],
  ])(
    "does not present recorded %j as effective native configuration",
    (intent, expected) => {
      const record = {
        workbench_recipe: { name: "example-recipe" },
        submission: { model: { reasoning_effort: intent } },
        harbor_job_config: {
          agents: [
            {
              model_name: "route/model?reasoning=max&temperature=0",
              kwargs: { reasoning_effort: "high" },
            },
          ],
        },
      } as RunRecord;
      const before = structuredClone(record);
      const { container } = render(<RunConfiguration record={record} />);
      expect(container.querySelector("dd")?.textContent).toBe(expected);
      expect(screen.getByText("reasoning_effort=high")).toBeInTheDocument();
      expect(
        screen.getByText("route/model?reasoning=max&temperature=0"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Recorded intent is not native kwargs or verified effective provider configuration.",
        ),
      ).toBeInTheDocument();
      expect(record).toEqual(before);
    },
  );
});

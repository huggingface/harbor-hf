// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Hint } from "../src/ui";

afterEach(cleanup);

describe("Hint", () => {
  it("does not attach a native title beside the styled tooltip", () => {
    render(<Hint text="Explanation">Replacement eligible</Hint>);
    expect(screen.getByText("Replacement eligible")).not.toHaveAttribute("title");
    const tooltip = screen.getByRole("tooltip", { hidden: true });
    expect(tooltip).toHaveTextContent("Explanation");
    expect(tooltip).toHaveClass("fixed", "invisible");
    expect(tooltip.parentElement).toBe(document.body);
  });

  it("opens a standalone tooltip from keyboard focus", async () => {
    const user = userEvent.setup();
    render(<Hint text="Explanation">Replacement eligible</Hint>);

    await user.tab();

    expect(screen.getByText("Replacement eligible").parentElement).toHaveFocus();
    expect(screen.getByRole("tooltip")).toBeVisible();
  });
});

it("keeps a tall tooltip within the viewport instead of assuming a short hint", async () => {
  render(<Hint text={"Details\n".repeat(12)}>Trial details</Hint>);
  const tooltip = screen.getByRole("tooltip", { hidden: true });
  const anchor = screen.getByText("Trial details").parentElement;
  if (!anchor) throw new Error("missing hint anchor");
  anchor.getBoundingClientRect = () => ({
    top: 200,
    bottom: 224,
    left: 20,
    right: 80,
    width: 60,
    height: 24,
    x: 20,
    y: 200,
    toJSON: () => ({}),
  });
  tooltip.getBoundingClientRect = () => ({
    top: 0,
    bottom: 400,
    left: 0,
    right: 288,
    width: 288,
    height: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  await userEvent.setup().tab();
  expect(tooltip).toHaveStyle({ top: "232px" });
  expect(tooltip).toHaveClass("whitespace-pre-line");
});

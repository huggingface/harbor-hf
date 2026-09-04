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

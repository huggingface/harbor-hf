// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ColumnDef } from "@tanstack/react-table";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable } from "../src/components/data-table";
import { Hint } from "../src/ui";

interface ExampleRow {
  name: string;
  state: string;
}

const columns: ColumnDef<ExampleRow>[] = [
  {
    accessorKey: "name",
    header: () => <Hint text="Stable record name">Name</Hint>,
  },
  {
    accessorKey: "state",
    header: "State",
  },
];

afterEach(cleanup);

describe("DataTable", () => {
  it("keeps its shared header sticky and filters each accessor column", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DataTable
        columns={columns}
        data={[
          { name: "alpha", state: "running" },
          { name: "beta", state: "completed" },
          { name: "gamma", state: "running" },
        ]}
      />,
    );

    expect(container.querySelector("thead")).toHaveClass("sticky", "top-0");
    expect(screen.getByLabelText("Filter name")).toBeVisible();
    expect(screen.getByLabelText("Filter state")).toBeVisible();

    await user.type(screen.getByLabelText("Filter name"), "beta");
    expect(screen.getByText("beta")).toBeVisible();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3 rows")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("alpha")).toBeVisible();
    expect(screen.getByText("3 rows")).toBeVisible();
  });

  it("opens a portaled header tooltip on keyboard focus without breaking sort", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        data={[
          { name: "beta", state: "running" },
          { name: "alpha", state: "completed" },
        ]}
      />,
    );

    await user.tab();
    const sortButton = screen.getByRole("button", { name: "Name" });
    expect(sortButton).toHaveFocus();
    expect(sortButton.querySelector("[tabindex]")).toBeNull();
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toBeVisible();
    expect(tooltip).toHaveTextContent("Stable record name");
    expect(tooltip).toHaveClass("fixed");
    expect(tooltip.parentElement).toBe(document.body);
    expect(sortButton).toHaveAttribute("aria-describedby", tooltip.id);

    await user.keyboard("{Enter}");
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("alpha");
  });
});

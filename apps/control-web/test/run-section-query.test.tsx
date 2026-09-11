// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RunSectionQuery } from "../src/run-section-query";

afterEach(cleanup);
const base = {
  data: undefined as unknown,
  error: null as unknown,
  isPending: true,
  isFetching: true,
  refetch: vi.fn(async () => {}),
};
it("announces initial loading without rendering empty evidence", () => {
  render(
    <RunSectionQuery label="trials" query={base}>
      No trials
    </RunSectionQuery>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading trials…");
  expect(screen.queryByText("No trials")).not.toBeInTheDocument();
});
it("retains values during refresh and distinguishes failed refresh from initial error", () => {
  const { rerender } = render(
    <RunSectionQuery label="trials" query={{ ...base, data: [], isPending: false }}>
      Saved trial
    </RunSectionQuery>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Refreshing trials…");
  expect(screen.getByText("Saved trial")).toBeVisible();
  const failed = {
    ...base,
    isPending: false,
    isFetching: false,
    error: new Error("Unavailable"),
  };
  rerender(
    <RunSectionQuery label="trials" query={{ ...failed, data: [] }}>
      Saved trial
    </RunSectionQuery>,
  );
  expect(screen.getByText("Showing saved data")).toBeVisible();
  expect(screen.getByText("Saved trial")).toBeVisible();
  rerender(
    <RunSectionQuery label="trials" query={failed}>
      No trials
    </RunSectionQuery>,
  );
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.queryByText("No trials")).not.toBeInTheDocument();
});
it("renders a confirmed empty result without loading feedback", () => {
  render(
    <RunSectionQuery
      label="trials"
      query={{ ...base, data: [], isPending: false, isFetching: false }}
    >
      No trials
    </RunSectionQuery>,
  );
  expect(screen.getByText("No trials")).toBeVisible();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

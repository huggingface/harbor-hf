// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RunView } from "../src/api";
import { ControlStateProvider } from "../src/control-state";
import { RunArchive } from "../src/run-archive";
import { keys } from "../src/queries";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const run = {
  record: { run_id: "run-0123456789abcdef01234567" },
  status: "finished",
  presentation: { archived: true, revision: 7 },
} as RunView;
function mount(
  role: "operator" | "reader" = "operator",
  writeMode: "disabled" | "enabled" = "enabled",
  view: RunView = run,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const refetch = vi.spyOn(client, "refetchQueries").mockResolvedValue();
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  render(
    <QueryClientProvider client={client}>
      <ControlStateProvider
        actor={{ username: "fixture-user", role, transport: "session" }}
        writeMode={writeMode}
      >
        <RunArchive run={view} />
      </ControlStateProvider>
    </QueryClientProvider>,
  );
  return { refetch, invalidate };
}
it("restores terminal runs with the exact revision, no optimistic cache writes and narrow invalidation", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(
        JSON.stringify({ ...run.presentation, archived: false, revision: 8 }),
      ),
    );
  const { refetch, invalidate } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "PATCH",
    body: JSON.stringify({ archived: false, expected_revision: 7 }),
  });
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith(
      { queryKey: keys.runs },
      { throwOnError: true },
    ),
  );
  expect(refetch).toHaveBeenCalledWith(
    { queryKey: keys.run(run.record.run_id), exact: true },
    { throwOnError: true },
  );
  expect(run.presentation?.archived).toBe(true);
});
it.each([
  ["reader", "enabled"],
  ["operator", "disabled"],
] as const)("hides writes for %s/%s", (role, mode) => {
  mount(role, mode);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("shows conflict feedback and blocks writes when authoritative refetch fails", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        error: { code: "presentation_conflict", message: "Archive revision changed" },
      }),
      { status: 409 },
    ),
  );
  const { refetch } = mount();
  refetch.mockRejectedValue(new Error("fixture failure"));
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByText(/Archive revision changed/);
  expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
  refetch.mockResolvedValue();
  fireEvent.click(screen.getByRole("button", { name: "Reload archive state" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled(),
  );
});

it("disables pending writes instead of sending duplicate intents", async () => {
  let complete = (_response: Response) => {};
  const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(
    new Promise<Response>((resolve) => {
      complete = resolve;
    }),
  );
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  expect(fetch).toHaveBeenCalledTimes(1);
  complete(new Response("null"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled(),
  );
});

it.each([null, run.presentation])(
  "blocks unavailable metadata despite successful cached refetch (%j)",
  async (presentation) => {
    mount("operator", "enabled", {
      ...run,
      presentation,
      presentation_available: false,
    });
    const action = screen.getByRole("button", {
      name: presentation?.archived ? "Restore" : "Archive",
    });
    expect(action).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload archive state" }));
    await waitFor(() => expect(action).toBeDisabled());
    expect(screen.getByText(/Archive visibility is unconfirmed/)).toBeVisible();
  },
);

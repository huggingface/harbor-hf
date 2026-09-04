// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { ControlStateProvider, type DisplayActor } from "../src/control-state";
import { SubmissionsPage } from "../src/submissions-page";

const digest = `sha256:${"a".repeat(64)}`;
const candidate = {
  run_id: "run-owned",
  publication_id: "publication-owned",
  catalog_digest: digest,
  public_row: {
    model: "example-model",
    benchmark: "example-benchmark",
    run_id: "run-owned",
    primary_metric_value: 0.5,
  },
};
const submission = {
  id: "submission-owned",
  run_id: "run-owned",
  publication_id: "publication-owned",
  catalog_digest: digest,
  created_at: "2026-09-04T10:00:00Z",
  status: "pending",
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function provider(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/submissions"]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}
function page(
  role: DisplayActor["role"] = "submitter",
  writeMode: "enabled" | "disabled" | "unknown" = "unknown",
) {
  return render(
    provider(
      <ControlStateProvider
        actor={{ username: "Example user", role, transport: "session" }}
        writeMode={writeMode}
      >
        <SubmissionsPage />
      </ControlStateProvider>,
    ),
  );
}
function mockApi(items: unknown[] = []) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/candidates")) return Response.json({ items: [candidate] });
    if (init?.method === "POST") return Response.json(submission);
    return Response.json({ items });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
it("requires consent and submits the exact previewed digest without publishing", async () => {
  const fetch = mockApi();
  page();
  await userEvent.selectOptions(await screen.findByLabelText("Hosted result"), digest);
  const button = screen.getByRole("button", { name: "Submit for review" });
  expect(button).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(button);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Nothing has been published yet",
  );
  const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({
    run_id: "run-owned",
    catalog_digest: digest,
    confirmed: true,
  });
  expect(fetch.mock.calls.some(([url]) => url.includes("/review"))).toBe(false);
});
it("requires exact metadata consent and explicit admin confirmation to approve", async () => {
  const fetch = mockApi([submission]);
  page("operator", "enabled");
  const approve = await screen.findByRole("button", { name: "Approve & publish" });
  expect(approve).toBeDisabled();
  await userEvent.click(screen.getByLabelText(/I reviewed every field/));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await userEvent.click(approve);
  await waitFor(() =>
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/review"))).toBe(true),
  );
  const post = fetch.mock.calls.find(([url]) => url.endsWith("/review"));
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({
    decision: "approved",
    confirmed: true,
    public_metadata_confirmed: true,
  });
});
it("never approves a different catalog revision", async () => {
  mockApi([{ ...submission, catalog_digest: `sha256:${"b".repeat(64)}` }]);
  page("operator", "enabled");
  expect(
    await screen.findByRole("button", { name: "Approve & publish" }),
  ).toBeDisabled();
  expect(screen.getByText(/no longer eligible/)).toBeInTheDocument();
});
it("keeps readers and disabled writes read-only", async () => {
  mockApi();
  const view = page("reader", "enabled");
  await userEvent.selectOptions(await screen.findByLabelText("Hosted result"), digest);
  await userEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Submit for review" })).toBeDisabled();
  view.unmount();
  page("operator", "disabled");
  await userEvent.selectOptions(await screen.findByLabelText("Hosted result"), digest);
  await userEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Submit for review" })).toBeDisabled();
});
it("renders the limited submitter shell without requesting system or events", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/auth/session"))
        return Response.json({
          authenticated: true,
          actor: { username: "Example user", role: "submitter", transport: "session" },
        });
      return Response.json({ items: [] });
    }),
  );
  render(provider(<App />));
  expect(
    await screen.findByRole("heading", { name: "Submit your results" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Workbench" })).not.toBeInTheDocument();
  expect(calls.some((url) => /\/system|\/events|\/runs/.test(url))).toBe(false);
  expect(
    screen.getByText(/External bundle uploads are not available/),
  ).toBeInTheDocument();
});

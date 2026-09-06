// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PersonalPage } from "../src/personal";
import { api, getPresets } from "../src/api";

vi.mock("../src/api", () => ({ api: vi.fn(), getPresets: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it("keeps supplied credentials out of browser storage and request bodies", async () => {
  vi.mocked(getPresets).mockResolvedValue({ benchmarks: [], agents: [] });
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith("identity") ? { owner: "example-user" } : { jobs: [] },
  );
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const user = userEvent.setup();
  render(<PersonalPage />);
  await user.type(screen.getByLabelText("User HF token"), "hf_testusercredential");
  await user.click(
    screen.getByRole("button", { name: "Verify token and load my Jobs" }),
  );
  await screen.findByText("Verified token owner: example-user");
  expect(storage).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledWith(
    "/api/v1/personal/identity",
    expect.objectContaining({
      headers: { "X-HF-User-Token": "hf_testusercredential" },
      body: "{}",
    }),
  );
  await user.clear(screen.getByLabelText("User HF token"));
  expect(
    screen.queryByText("Verified token owner: example-user"),
  ).not.toBeInTheDocument();
});

it("does not cancel until the user confirms the exact Job", async () => {
  vi.mocked(getPresets).mockResolvedValue({ benchmarks: [], agents: [] });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith("identity")) return { owner: "example-user" };
    if (path.endsWith("jobs"))
      return {
        jobs: [
          {
            id: "example-job",
            stage: "RUNNING",
            url: "https://huggingface.co/jobs/example-user/example-job",
            run_id: null,
          },
        ],
      };
    return {};
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const user = userEvent.setup();
  render(<PersonalPage />);
  await user.type(screen.getByLabelText("User HF token"), "hf_testusercredential");
  await user.click(
    screen.getByRole("button", { name: "Verify token and load my Jobs" }),
  );
  await user.click(await screen.findByRole("button", { name: "Cancel selected Job" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("example-job"));
  expect(api).not.toHaveBeenCalledWith("/api/v1/personal/cancel", expect.anything());
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Cancel selected Job" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      "/api/v1/personal/cancel",
      expect.objectContaining({
        body: JSON.stringify({ job_id: "example-job", confirm: true }),
      }),
    ),
  );
});

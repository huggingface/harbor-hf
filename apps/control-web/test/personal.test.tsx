// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PersonalPage } from "../src/personal";
import {
  api,
  getModelProviders,
  getPresets,
  listSavedConfigurations,
} from "../src/api";
import type { AgentPreset } from "../src/api";

vi.mock("../src/api", () => ({
  api: vi.fn(),
  getPresets: vi.fn(),
  getModelProviders: vi.fn(),
  listSavedConfigurations: vi.fn(),
}));
beforeEach(() => vi.mocked(listSavedConfigurations).mockResolvedValue({ items: [] }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it("allows selection and preview without a token, using the agent's reasoning options", async () => {
  const agent: AgentPreset = {
    schema_version: "v1",
    agent: "pi",
    version: "0.84.4",
    harbor_agent: { name: "pi", kwargs: {} },
    reasoning_option: "thinking",
    reasoning_values: ["off", "high"],
  };
  vi.mocked(getPresets).mockResolvedValue({
    benchmarks: [
      {
        schema_version: "v1",
        benchmark: "terminal-bench-2-1",
        preset: "two-task-canary",
        leaderboard_eligible: false,
        job: {},
      },
    ],
    agents: [agent],
  });
  vi.mocked(getModelProviders).mockResolvedValue({
    model: "example/model",
    providers: ["example-provider"],
  });
  vi.mocked(api).mockResolvedValue({
    native_config_sha256: "a".repeat(64),
    config: {},
  });
  const user = userEvent.setup();
  render(<PersonalPage />);
  const select = screen.getByRole("combobox", { name: "Agent and version" });
  await waitFor(() => expect(select).toBeEnabled());
  expect(screen.getByRole("combobox", { name: "Benchmark" })).toBeEnabled();
  await user.selectOptions(select, "pi/0.84.4");
  expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toHaveValue("off");
  await user.type(screen.getByLabelText("Model (organization/model)"), "example/model");
  await user.click(screen.getByRole("button", { name: "Find model providers" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "HF inference provider" })).toHaveValue(
      "example-provider",
    ),
  );
  await user.click(screen.getByRole("button", { name: "Preview for launch approval" }));
  expect(api).toHaveBeenCalledWith(
    "/api/v1/personal/preview",
    expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"reasoning_effort":"off"'),
    }),
  );
  expect(vi.mocked(api).mock.calls[0]?.[1]?.headers).toBeUndefined();
  expect(
    screen.getByRole("button", { name: "Load my exact launch approval" }),
  ).toBeDisabled();
  expect(screen.getByLabelText("User HF token")).toHaveValue("");
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
  expect(screen.getByText("Authentication: explicit token override")).toBeVisible();
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

it("uses OAuth without a token header and requires explicit private Bucket creation consent", async () => {
  vi.mocked(getPresets).mockResolvedValue({ benchmarks: [], agents: [] });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith("identity"))
      return { owner: "example-user", results_bucket: "private-results" };
    if (path.endsWith("jobs")) return { jobs: [] };
    return {};
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const user = userEvent.setup();
  render(<PersonalPage />);
  await user.click(screen.getByRole("button", { name: "Connect with OAuth" }));
  expect(screen.getByText("Authentication: OAuth — no token required")).toBeVisible();
  await screen.findByText("Verified token owner: example-user");
  expect(api).toHaveBeenCalledWith("/api/v1/personal/identity", {
    method: "POST",
    body: "{}",
  });
  expect(screen.getByLabelText("Existing private Bucket name")).toHaveValue(
    "private-results",
  );
  await user.click(screen.getByRole("button", { name: "Create private Bucket" }));
  expect(api).not.toHaveBeenCalledWith(
    "/api/v1/personal/create-bucket",
    expect.anything(),
  );
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Create private Bucket" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/api/v1/personal/create-bucket", {
      method: "POST",
      body: JSON.stringify({ bucket: "private-results", confirm: true }),
    }),
  );
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

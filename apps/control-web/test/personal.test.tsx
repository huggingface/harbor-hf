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
  await user.type(screen.getByLabelText("Declared model identity"), "example/model");
  await user.click(screen.getByRole("button", { name: "Find model providers" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "HF inference provider" })).toHaveValue(
      "example-provider",
    ),
  );
  await user.click(screen.getByRole("button", { name: "Apply HF routing hints" }));
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

it("previews a free-form declaration with unchanged CLI spelling and editable environment without provider lookup", async () => {
  const revision = `sha256:${"c".repeat(64)}`;
  vi.mocked(listSavedConfigurations).mockResolvedValue({
    items: [
      {
        schema_version: "v1",
        name: "my-command",
        revision,
        harbor_job_config: { agents: [{ name: "pi" }] },
      },
    ],
  });
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
    agents: [],
  });
  vi.mocked(api).mockResolvedValue({
    config: {},
    native_config_sha256: "a".repeat(64),
  });
  const user = userEvent.setup();
  render(<PersonalPage />);
  await screen.findByRole("option", { name: /my-command/ });
  await user.selectOptions(
    screen.getByLabelText("Agent and version"),
    `workbench/${revision}`,
  );
  await user.type(
    screen.getByLabelText("Declared model identity"),
    "A model under evaluation",
  );
  await user.type(
    screen.getByLabelText("Exact harness model string"),
    "codexresponses.my-alias",
  );
  await user.type(screen.getByLabelText("Declared provider"), "custom provider");
  await user.clear(screen.getByLabelText("Harness environment overrides (JSON)"));
  await user.click(screen.getByLabelText("Harness environment overrides (JSON)"));
  await user.paste('[{"name":"MY_SETTING","value":"custom"}]');
  await user.clear(screen.getByLabelText("Declared model identity"));
  await user.type(
    screen.getByLabelText("Declared model identity"),
    "Edited model identity",
  );
  expect(screen.getByLabelText("Exact harness model string")).toHaveValue(
    "codexresponses.my-alias",
  );
  await user.clear(screen.getByLabelText("Declared provider"));
  await user.type(screen.getByLabelText("Declared provider"), "edited provider");
  await user.type(
    screen.getByLabelText("Declared model revision (optional)"),
    "revision-2",
  );
  expect(screen.getByLabelText("Exact harness model string")).toHaveValue(
    "codexresponses.my-alias",
  );
  await user.click(screen.getByRole("button", { name: "Preview for launch approval" }));
  const body = JSON.parse(String(vi.mocked(api).mock.calls[0]?.[1]?.body));
  expect(body.submission).toMatchObject({
    model: {
      id: "Edited model identity",
      provider: "edited provider",
      revision: "revision-2",
    },
    runtime: {
      model_name: "codexresponses.my-alias",
      environment: [{ name: "MY_SETTING", value: "custom" }],
    },
  });
  expect(getModelProviders).not.toHaveBeenCalled();
});

it("retains the exact declaration and runtime when initialSelection changes from setup to another benchmark revision", async () => {
  const setupRevision = `sha256:${"d".repeat(64)}`;
  const benchmarkRevision = `sha256:${"e".repeat(64)}`;
  const savedItems = [setupRevision, benchmarkRevision].map((revision, index) => ({
    schema_version: "v1" as const,
    name: `saved-command-${index}`,
    revision,
    harbor_job_config: { agents: [{ name: "pi" }] },
  }));
  vi.mocked(listSavedConfigurations)
    .mockResolvedValueOnce({ items: savedItems.slice(0, 1) })
    .mockResolvedValue({ items: savedItems });
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
    agents: [],
  });
  vi.mocked(api).mockResolvedValue({
    config: {},
    native_config_sha256: "a".repeat(64),
  });
  const user = userEvent.setup();
  const { rerender } = render(
    <PersonalPage initialSelection={{ revision: setupRevision, mode: "setup" }} />,
  );
  await screen.findByRole("option", { name: /saved-command-0/ });
  expect(screen.getByLabelText("Run purpose")).toHaveValue("setup");
  expect(screen.getByLabelText("Agent and version")).toHaveValue(
    `workbench/${setupRevision}`,
  );
  const environment = '[{"name":"MY_SETTING","value":"custom"}]';
  const fields = {
    "Declared model identity": "A model under evaluation",
    "Declared provider": "custom provider",
    "Declared model revision (optional)": "model-revision-2",
    "Exact harness model string": "codexresponses.my-alias",
    "Model endpoint": "https://model.example.test/v1",
    "Harness environment overrides (JSON)": environment,
    "Run ID": "run-retained-selection",
    "Requested per-trial USD allowance (not an enforced cap)": "2.5",
  };
  for (const [label, value] of Object.entries(fields)) {
    await user.clear(screen.getByLabelText(label));
    await user.click(screen.getByLabelText(label));
    await user.paste(value);
  }
  await user.selectOptions(screen.getByLabelText("Harness model credentials"), "none");
  await user.click(screen.getByRole("button", { name: "Preview for launch approval" }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  const setupBody = JSON.parse(String(vi.mocked(api).mock.calls[0]?.[1]?.body));
  expect(setupBody).toMatchObject({
    mode: "setup",
    submission: { harness: { agent: "workbench", version: setupRevision } },
  });

  rerender(
    <PersonalPage
      initialSelection={{ revision: benchmarkRevision, mode: "benchmark" }}
    />,
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Run purpose")).toHaveValue("benchmark");
    expect(screen.getByLabelText("Agent and version")).toHaveValue(
      `workbench/${benchmarkRevision}`,
    );
  });
  for (const [label, value] of Object.entries(fields)) {
    expect(screen.getByLabelText(label)).toHaveValue(
      label.startsWith("Requested") ? Number(value) : value,
    );
  }
  expect(screen.getByLabelText("Harness model credentials")).toHaveValue("none");
  expect(screen.getByLabelText("Benchmark")).toHaveValue(
    "terminal-bench-2-1/two-task-canary",
  );
  await user.click(screen.getByRole("button", { name: "Preview for launch approval" }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  const benchmarkBody = JSON.parse(String(vi.mocked(api).mock.calls[1]?.[1]?.body));
  expect(benchmarkBody).toEqual({
    ...setupBody,
    mode: "benchmark",
    submission: {
      ...setupBody.submission,
      harness: { agent: "workbench", version: benchmarkRevision },
    },
  });
  expect(benchmarkBody.submission.runtime).toEqual({
    model_name: "codexresponses.my-alias",
    endpoint: "https://model.example.test/v1",
    credentials: "none",
    environment: JSON.parse(environment),
  });
  expect(getModelProviders).not.toHaveBeenCalled();
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

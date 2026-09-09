// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, getModelProviders, getPresets } from "../src/api";
import { ControlStateProvider } from "../src/control-state";
import {
  draftKey,
  initialDraft,
  loadDraft,
  saveDraft,
  setField,
} from "../src/launch-draft";
import { JsonInput, SchemaFields } from "../src/launch-fields";
import { LaunchPage } from "../src/launch-page";
import { draftUrl } from "../src/launch-url";

vi.mock("../src/api", () => ({
  api: vi.fn(),
  getModelProviders: vi.fn(),
  getPresets: vi.fn(),
}));
const draft = {
  datasets: [{ name: "example/dataset", ref: `sha256:${"a".repeat(64)}` }],
  agents: [
    {
      name: "openclaw",
      model_name: "openai/example/model:provider",
      kwargs: { version: "2026.7.1-2" },
    },
  ],
  environment: {
    type: "hf-sandbox",
    kwargs: { flavor: "cpu-upgrade", job_timeout: "none" },
  },
};
const catalog = {
  harbor_revision: "a".repeat(40),
  agents: [
    {
      label: "openclaw",
      config: { name: "openclaw", kwargs: { version: "2026.7.1-2" } },
      options_schema: {
        properties: {
          version: { type: "string" },
          thinking: { type: "string", enum: ["off", "high"] },
        },
      },
    },
  ],
  job_schema: {
    properties: {
      n_attempts: { type: "integer", default: 1 },
      retry: { type: "object" },
      verifier: { type: "object" },
    },
  },
};
const hardware = ["cpu-basic", "cpu-upgrade", "a100-large"].map((name) => ({
  name,
  prettyName: name,
  cpu: "2 vCPU",
  ram: "16 GB",
  ephemeralStorage: "50 GB",
  accelerator: null,
  unitCostUSD: 0.01,
  unitLabel: "minute",
}));
const validation = {
  harbor_revision: "a".repeat(40),
  tasks: 3,
  agents: 1,
  trials: 3,
  warnings: [],
  not_performed: ["Model inference"],
  effective_config: draft,
  fingerprint: "checked",
  credentials_available: true,
};

beforeEach(() => {
  vi.mocked(getPresets).mockResolvedValue({ benchmarks: [], agents: [] });
  vi.mocked(getModelProviders).mockImplementation(async (model) => ({
    model,
    providers: ["provider"],
  }));
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/v1/agents"
      ? catalog
      : path === "/api/v1/hardware"
        ? hardware
        : path === "/api/v1/runs/validate"
          ? validation
          : { run: { run_id: "run-created" } },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.resetAllMocks();
});

function page(
  role: "operator" | "reader" = "operator",
  writeMode: "enabled" | "disabled" = "enabled",
  entry = "/runs/new",
) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[entry]}>
        <ControlStateProvider
          actor={{ username: "test", role, transport: "development" }}
          writeMode={writeMode}
        >
          <Routes>
            <Route path="/runs/new" element={<LaunchPage />} />
            <Route path="/runs/:id" element={<p>Run created</p>} />
          </Routes>
        </ControlStateProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("native launch draft", () => {
  it("loads a URL before local storage, shares native configuration, and requires validation", async () => {
    saveDraft({ agents: [], extra_instructions: ["older local draft"] });
    const shared = new URL(draftUrl("https://example.test", draft, "2.5"));
    page("operator", "enabled", shared.pathname + shared.search);
    await screen.findByDisplayValue("example/model");
    expect(
      (screen.getByLabelText("Post-trial cost limit (USD)") as HTMLInputElement).value,
    ).toBe("2.5");
    expect(
      (screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      vi
        .mocked(api)
        .mock.calls.every(
          ([path]) =>
            path !== "/api/v1/runs/validate" && path !== "/api/v1/runs/config",
        ),
    ).toBe(true);
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Sandbox flavor" }) as HTMLSelectElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Sandbox flavor" }), {
      target: { value: "a100-large" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy draft link" }));
    const link = await screen.findByLabelText("Draft link");
    const url = new URL((link as HTMLInputElement).value);
    expect(JSON.parse(url.searchParams.get("draft") ?? "")).toMatchObject({
      environment: { kwargs: { flavor: "a100-large" } },
    });
    expect(url.searchParams.get("cost_ceiling_usd_per_trial")).toBe("2.5");
    fireEvent.change(screen.getByLabelText("Post-trial cost limit (USD)"), {
      target: { value: "3" },
    });
    expect(screen.queryByLabelText("Draft link")).toBeNull();
  });
  it("rejects a bad URL without silently loading or overwriting the local draft", async () => {
    saveDraft(draft);
    page("operator", "enabled", "/runs/new?draft=broken");
    await screen.findByText("Draft link contains malformed JSON");
    expect(screen.queryByDisplayValue("example/model")).toBeNull();
    expect(loadDraft()).toEqual(draft);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));
    await waitFor(() => expect(loadDraft()).toEqual(initialDraft()));
    expect(screen.queryByText("Draft link contains malformed JSON")).toBeNull();
  });
  it("preserves false, zero, null, empty text and unset", () => {
    const value = { flag: false, count: 0, optional: null, text: "", list: [] };
    expect(saveDraft(value)).toBe(true);
    expect(loadDraft()).toEqual(value);
    expect(setField(value, "flag", undefined)).not.toHaveProperty("flag");
  });
  it("does not save credential material and removes an older saved draft", () => {
    saveDraft(draft);
    expect(saveDraft({ env: { HF_TOKEN: "not-a-real-credential" } })).toBe(false);
    expect(localStorage.getItem(draftKey)).toBeNull();
    localStorage.setItem(
      draftKey,
      JSON.stringify({ env: { API_KEY: "not-a-real-credential" } }),
    );
    expect(loadDraft()).toEqual(initialDraft());
  });
  it("handles damaged and oversized stored content", () => {
    localStorage.setItem(draftKey, "{");
    expect(loadDraft()).toEqual(initialDraft());
    expect(saveDraft({ text: "x".repeat(200000) })).toBe(false);
  });
  it("keeps invalid JSON visible and blocked when another field changes", () => {
    const change = vi.fn();
    const invalid = vi.fn();
    const view = render(
      <JsonInput
        label="Native JSON"
        value={{ count: 1 }}
        onChange={change}
        invalid={invalid}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "{" } });
    expect(change).not.toHaveBeenCalled();
    expect(invalid).toHaveBeenLastCalledWith(expect.any(String), true);
    view.rerender(
      <JsonInput
        label="Native JSON"
        value={{ count: 2 }}
        onChange={change}
        invalid={invalid}
      />,
    );
    expect((input as HTMLTextAreaElement).value).toBe("{");
    fireEvent.change(input, { target: { value: '{"count":0}' } });
    expect(change).toHaveBeenCalledWith({ count: 0 });
  });
  it("distinguishes unset, false and null in schema controls", () => {
    const change = vi.fn();
    render(
      <SchemaFields
        schema={{
          properties: { enabled: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
        }}
        value={{ enabled: false }}
        onChange={change}
        invalid={vi.fn()}
      />,
    );
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Set null" }));
    expect(change).toHaveBeenLastCalledWith({ enabled: null });
    fireEvent.click(screen.getByRole("button", { name: "Unset" }));
    expect(change).toHaveBeenLastCalledWith({});
  });
});

describe("launch page", () => {
  it("adds, edits, changes and removes all source modes without losing native fields", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    page();
    fireEvent.click(screen.getByRole("button", { name: "Add dataset" }));
    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "example/dataset" },
    });
    fireEvent.change(screen.getByLabelText("ref"), {
      target: { value: "sha256:hash" },
    });
    fireEvent.change(screen.getByLabelText("task_names (one glob per line)"), {
      target: { value: "a*\nb*" },
    });
    fireEvent.change(screen.getByLabelText("exclude_task_names (one glob per line)"), {
      target: { value: "skip*" },
    });
    fireEvent.change(screen.getByLabelText("n_tasks"), { target: { value: "3" } });
    expect(loadDraft().datasets).toMatchObject([
      { n_tasks: 3, task_names: ["a*", "b*"] },
    ]);
    fireEvent.change(screen.getByLabelText("n_tasks"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("task_names (one glob per line)"), {
      target: { value: "" },
    });
    confirm.mockReturnValue(false);
    fireEvent.change(screen.getByLabelText("Source type"), {
      target: { value: "git" },
    });
    expect(screen.getByLabelText("name")).toBeTruthy();
    confirm.mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("Source type"), {
      target: { value: "git" },
    });
    fireEvent.change(screen.getByLabelText("repo"), {
      target: { value: "https://github.com/example/tasks.git@commit" },
    });
    fireEvent.change(screen.getByLabelText("path"), { target: { value: "tasks" } });
    fireEvent.change(screen.getByLabelText("path"), { target: { value: "" } });
    expect(loadDraft().datasets).toEqual([
      { repo: "https://github.com/example/tasks.git@commit" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getAllByLabelText("Source type")[1] as HTMLElement, {
      target: { value: "git" },
    });
    fireEvent.change(screen.getByLabelText("git_url"), {
      target: { value: "https://github.com/example/task.git" },
    });
    fireEvent.change(screen.getByLabelText("git_commit_id"), {
      target: { value: "a".repeat(40) },
    });
    fireEvent.change(screen.getAllByLabelText("path")[1] as HTMLElement, {
      target: { value: "one" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove source" })[0] as HTMLElement,
    );
    expect(loadDraft().tasks).toMatchObject([
      { path: "one", git_commit_id: "a".repeat(40) },
    ]);
    fireEvent.change(screen.getByLabelText("Source type"), {
      target: { value: "package" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove source" }));
    expect(loadDraft().tasks).toEqual([]);
  });
  it("loads a preset, edits job settings, keeps agents, and clears the draft explicitly", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    saveDraft(draft);
    vi.mocked(getPresets).mockResolvedValue({
      benchmarks: [
        {
          schema_version: "v1",
          benchmark: "example",
          preset: "one",
          leaderboard_eligible: false,
          job: {
            datasets: [
              { repo: "https://github.com/example/tasks.git@commit", path: "tasks" },
            ],
            n_attempts: 2,
            n_concurrent_trials: 1,
            environment: {
              type: "hf-sandbox",
              kwargs: { flavor: "cpu-basic", job_timeout: "none" },
            },
          },
        },
      ],
      agents: [],
    });
    page();
    await screen.findByRole("option", { name: "example / one" });
    fireEvent.change(screen.getByLabelText("Benchmark preset"), {
      target: { value: "0" },
    });
    expect(loadDraft().agents).toEqual(draft.agents);
    fireEvent.change(screen.getByLabelText("n_attempts"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Sandbox flavor"), {
      target: { value: "cpu-upgrade" },
    });
    fireEvent.change(screen.getByLabelText("Post-trial cost limit (USD)"), {
      target: { value: "0" },
    });
    expect(
      (screen.getByRole("button", { name: "Validate" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Post-trial cost limit (USD)"), {
      target: { value: "0.5" },
    });
    expect(loadDraft().environment).toMatchObject({
      kwargs: { flavor: "cpu-upgrade", job_timeout: "none" },
    });
    fireEvent.change(screen.getByLabelText("Native environment"), {
      target: { value: '{"type":"hf-sandbox","kwargs":{"flavor":"cpu-basic"}}' },
    });
    confirm.mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));
    expect(loadDraft().agents).toHaveLength(1);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));
    expect(loadDraft()).toEqual(initialDraft());
  });
  it("configures a custom ACP source and confirms replacement of existing options", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const entries = {
      ...catalog,
      agents: [
        ...catalog.agents,
        { label: "acp", config: { name: "acp" }, options_schema: {} },
      ],
    };
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/api/v1/hardware" ? hardware : entries,
    );
    page();
    fireEvent.click(screen.getByRole("button", { name: "Add agent", exact: true }));
    await screen.findByRole("option", { name: "openclaw" });
    fireEvent.change(screen.getByLabelText("Agent implementation"), {
      target: { value: "openclaw" },
    });
    fireEvent.change(screen.getByLabelText("version"), {
      target: { value: "2026.7.2" },
    });
    fireEvent.change(screen.getByLabelText("thinking"), {
      target: { value: '"high"' },
    });
    confirm.mockReturnValue(false);
    fireEvent.change(screen.getByLabelText("Agent implementation"), {
      target: { value: "acp" },
    });
    expect(
      (screen.getByLabelText("Agent implementation") as HTMLSelectElement).value,
    ).toBe("openclaw");
    confirm.mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("Agent implementation"), {
      target: { value: "acp" },
    });
    for (const [label, value] of [
      ["repo_url", "https://github.com/example/agent.git"],
      ["ref", "a".repeat(40)],
      ["source_dir", "."],
      ["manifest_path", "harbor-agent.json"],
    ])
      fireEvent.change(screen.getByLabelText(label as string), { target: { value } });
    expect(loadDraft().agents).toMatchObject([
      {
        name: "acp",
        kwargs: { source: { source_dir: ".", manifest_path: "harbor-agent.json" } },
      },
    ]);
    fireEvent.change(screen.getByLabelText("source_dir"), { target: { value: "" } });
    fireEvent.change(
      screen.getByLabelText(
        "Native agent fields (including kwargs, env, and timeouts)",
      ),
      { target: { value: "[]" } },
    );
    expect(
      (screen.getByRole("button", { name: "Validate" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(
      screen.getByLabelText(
        "Native agent fields (including kwargs, env, and timeouts)",
      ),
      { target: { value: '{"name":"acp","kwargs":{}}' } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove agent" }));
    expect(loadDraft().agents).toEqual([]);
  });
  it("shows validation and launch failures and focuses the error summary", async () => {
    saveDraft(draft);
    page();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Validate" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    vi.mocked(api).mockRejectedValueOnce(new Error("Source could not be checked"));
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    const error = await screen.findByText("Source could not be checked");
    expect(document.activeElement).toBe(error);
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await screen.findByText("Validated configuration");
    vi.mocked(api).mockRejectedValueOnce(new Error("Launch rejected"));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await screen.findByText("Launch rejected");
    expect(screen.queryByText("Validated configuration")).toBeNull();
  });
  it("blocks readers, disabled writes, missing credentials, and credential-bearing drafts", async () => {
    saveDraft(draft);
    const first = page("reader");
    expect(
      (screen.getByRole("button", { name: "Validate" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    first.unmount();
    const second = page("operator", "disabled");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Validate" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await screen.findByText("Validated configuration");
    expect(
      (screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    second.unmount();
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/api/v1/agents"
        ? catalog
        : path === "/api/v1/hardware"
          ? hardware
          : { ...validation, credentials_available: false },
    );
    page();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Validate" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await screen.findByText("Separate credentials: missing; launch blocked");
    fireEvent.change(screen.getByLabelText("JobConfig JSON"), {
      target: { value: JSON.stringify({ ...draft, env: { API_KEY: "test-only" } }) },
    });
    await screen.findByText(
      "Remove credential material before saving, validating, or launching.",
    );
    expect(localStorage.getItem(draftKey)).toBeNull();
  });
  it("shows catalog and model-provider lookup failures without selecting a fallback", async () => {
    saveDraft(draft);
    let catalogFailures = 1;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/v1/hardware") return hardware;
      if (catalogFailures-- > 0) throw new Error("Catalog unavailable");
      return catalog;
    });
    vi.mocked(getModelProviders).mockRejectedValue(new Error("Lookup unavailable"));
    page();
    await screen.findByText(/Native agent catalog unavailable/);
    const retries = screen.getAllByRole("button", { name: "Retry" });
    fireEvent.click(retries[0] as HTMLElement);
    await screen.findByRole("option", { name: "openclaw" });
    await screen.findByText(/Provider lookup failed/);
    vi.mocked(getModelProviders).mockResolvedValue({
      model: "example/model",
      providers: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No compatible provider mappings are available.");
    expect((screen.getByLabelText("HF provider") as HTMLSelectElement).value).toBe(
      "provider",
    );
  });
  it("requires fresh validation, submits native JSON and opens the run", async () => {
    saveDraft(draft);
    page();
    const validate = await screen.findByRole("button", { name: "Validate" });
    await waitFor(() => expect((validate as HTMLButtonElement).disabled).toBe(false));
    expect(
      (screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(validate);
    await screen.findByText("3 resolved tasks · 1 agents · 3 trials");
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await screen.findByText("Run created");
    expect(api).toHaveBeenCalledWith(
      "/api/v1/runs/config",
      expect.objectContaining({
        body: JSON.stringify(draft),
        headers: expect.objectContaining({ "X-Harbor-Hf-Validation": "checked" }),
      }),
    );
  });
  it("invalidates validation after an edit and never restores approval", async () => {
    saveDraft(draft);
    const view = page();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Validate" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await screen.findByText("Validated configuration");
    fireEvent.change(screen.getByLabelText("Sandbox idle timeout"), {
      target: { value: "15m" },
    });
    expect(screen.queryByText("Validated configuration")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    view.unmount();
    page();
    expect(screen.queryByText("Validated configuration")).toBeNull();
  });
  it("clears the provider when the model changes", async () => {
    saveDraft(draft);
    page();
    await screen.findByRole("option", { name: "provider" });
    fireEvent.change(screen.getByLabelText("HF model"), {
      target: { value: "example/other-model" },
    });
    expect((screen.getByLabelText("HF provider") as HTMLSelectElement).value).toBe("");
    await waitFor(() =>
      expect(loadDraft().agents).toEqual([
        { ...draft.agents[0], model_name: "openai/example/other-model" },
      ]),
    );
  });
  it("blocks validation while the full native JSON is invalid", async () => {
    saveDraft(draft);
    page();
    const input = await screen.findByLabelText("JobConfig JSON");
    fireEvent.change(input, { target: { value: "{" } });
    expect(
      (screen.getByRole("button", { name: "Validate" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

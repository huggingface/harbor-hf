// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../src/api";
import { ControlStateProvider } from "../src/control-state";
import { CombinedReplacementView, RunReplacements } from "../src/run-replacements";

const runId = "run-0123456789abcdef01234567";
const childId = "run-abcdef0123456789abcdef01";
const id = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const run = { record: { run_id: runId }, status: "finished" } as api.RunView;
const trial = (
  uuid: string | null,
  status: api.TrialIdentity["status"] = "error",
  reward = 1,
): api.TrialIdentity => ({
  run_id: runId,
  trial_name: `task-${uuid}`,
  status,
  reward,
  cost_usd: null,
  result: {
    id: uuid,
    exception_info: { exception_type: "SyntheticError" },
    config: { agent: { name: null, import_path: null, model_name: null } },
    agent_info: { version: null },
  },
});
const empty: api.ReplacementView = {
  run_id: runId,
  operator_selection: null,
  children: [],
  assembly: { availability: "none", result: null },
  incurred: null,
  selected_cost_usd: null,
};
const child: api.ReplacementView["children"][number] = {
  run_id: childId,
  status: "queued",
  operator_selection: {
    original_run_id: runId,
    trial_ids: [id],
    source_fingerprint: `sha256:${"a".repeat(64)}`,
  },
};
const validation: api.LaunchValidation = {
  harbor_revision: "b".repeat(40),
  tasks: 1,
  agents: 1,
  trials: 1,
  warnings: ["Synthetic warning"],
  not_performed: ["No inference performed"],
  effective_config: { n_attempts: 1 },
  fingerprint: "c".repeat(64),
  credentials_available: true,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount({
  role = "operator",
  mode = "enabled",
  current = run,
  trials = [
    trial(id),
    trial(secondId),
    trial(null),
    trial("00000000-0000-4000-8000-000000000003", "completed", 0),
  ],
}: {
  role?: "reader" | "operator";
  mode?: "enabled" | "disabled";
  current?: api.RunView;
  trials?: api.TrialIdentity[];
} = {}) {
  const get = vi.spyOn(api, "getReplacements").mockResolvedValue(empty);
  const validate = vi.spyOn(api, "validateReplacements").mockResolvedValue(validation);
  const submit = vi
    .spyOn(api, "submitReplacements")
    .mockResolvedValue({ created: true, run: { run_id: childId } as api.RunRecord });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ControlStateProvider
          actor={{ username: "fixture-user", role, transport: "session" }}
          writeMode={mode}
        >
          <RunReplacements run={current} trials={trials} />
        </ControlStateProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { get, validate, submit, client };
}
async function open() {
  fireEvent.click(
    screen.getByRole("button", { name: "Replace infrastructure failures" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText("Refreshing replacement evidence…"),
    ).not.toBeInTheDocument(),
  );
}
function select() {
  fireEvent.click(screen.getByLabelText(id));
  fireEvent.change(screen.getByLabelText("Replacement cost ceiling (USD)"), {
    target: { value: "12.5" },
  });
  fireEvent.click(screen.getByLabelText("I reviewed these as infrastructure failures"));
}
async function review() {
  fireEvent.click(screen.getByRole("button", { name: "Review replacements" }));
  await screen.findByRole("region", { name: "Replacement budget review" });
}
it("loads lazily, selects native UUIDs regardless of reward and submits the reviewed body without navigation", async () => {
  const { get, validate, submit } = mount();
  expect(get).not.toHaveBeenCalled();
  await open();
  expect(screen.getByLabelText(id)).not.toBeChecked();
  expect(
    screen.queryByLabelText("00000000-0000-4000-8000-000000000003"),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review replacements" })).toBeDisabled();
  select();
  await review();
  expect(validate).toHaveBeenCalledWith(runId, {
    trial_ids: [id],
    cost_ceiling_usd: 12.5,
  });
  expect(screen.getByText("Synthetic warning")).toBeInTheDocument();
  expect(screen.getByText("No inference performed")).toBeInTheDocument();
  expect(screen.getByText(/"n_attempts": 1/)).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm and create replacement run" }),
  );
  expect(await screen.findByRole("link", { name: childId })).toHaveAttribute(
    "href",
    `/runs/${childId}`,
  );
  expect(submit).toHaveBeenCalledWith(
    runId,
    { trial_ids: [id], cost_ceiling_usd: 12.5, fingerprint: validation.fingerprint },
    expect.any(String),
  );
  expect(
    screen.getByRole("button", { name: "Replacements", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText(/Original execution remains below/)).toBeInTheDocument();
});
it.each([
  ["reader", "enabled", "finished"],
  ["operator", "disabled", "finished"],
  ["operator", "enabled", "running"],
  ["operator", "enabled", "cost_stopped"],
] as const)("gates selection for %s %s %s", async (role, mode, status) => {
  mount({ role, mode, current: { ...run, status } });
  await open();
  expect(screen.getByLabelText(id)).toBeDisabled();
  expect(screen.getByRole("button", { name: "Review replacements" })).toBeDisabled();
});
it("links a replacement parent even with its panel closed", () => {
  const { get } = mount({
    current: {
      ...run,
      record: { ...run.record, operator_selection: child.operator_selection },
    },
  });
  expect(screen.getByRole("link", { name: "Original run" })).toHaveAttribute(
    "href",
    `/runs/${runId}`,
  );
  expect(get).not.toHaveBeenCalled();
});
it("disables already used UUIDs and select-all is explicit and only unused candidates", async () => {
  const { get, validate } = mount();
  get.mockResolvedValue({ ...empty, children: [child] });
  await open();
  expect(screen.getByLabelText(id)).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Select all unused candidates" }));
  expect(screen.getByLabelText(secondId)).toBeChecked();
  fireEvent.change(screen.getByLabelText("Replacement cost ceiling (USD)"), {
    target: { value: "3" },
  });
  fireEvent.click(screen.getByLabelText("I reviewed these as infrastructure failures"));
  await review();
  expect(validate).toHaveBeenCalledWith(runId, {
    trial_ids: [secondId],
    cost_ceiling_usd: 3,
  });
  fireEvent.click(screen.getByRole("button", { name: "Replacements", exact: true }));
  expect(screen.getByText(/queued · 1 exact attempts selected/)).toBeInTheDocument();
});
it.each(["budget", "selection", "classification"])(
  "invalidates review on %s edits, including late in-flight reviews",
  async (change) => {
    const { validate } = mount();
    await open();
    select();
    let resolve!: (value: api.LaunchValidation) => void;
    validate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review replacements" }));
    const edit = () => {
      if (change === "budget")
        fireEvent.change(screen.getByLabelText("Replacement cost ceiling (USD)"), {
          target: { value: "17" },
        });
      else
        fireEvent.click(
          screen.getByLabelText(
            change === "selection"
              ? secondId
              : "I reviewed these as infrastructure failures",
          ),
        );
    };
    edit();
    await act(async () => resolve(validation));
    expect(
      screen.queryByRole("region", { name: "Replacement budget review" }),
    ).not.toBeInTheDocument();
    if (change !== "budget")
      fireEvent.click(
        screen.getByLabelText("I reviewed these as infrastructure failures"),
      );
    await review();
    if (change === "budget")
      fireEvent.change(screen.getByLabelText("Replacement cost ceiling (USD)"), {
        target: { value: "0" },
      });
    else edit();
    expect(
      screen.queryByRole("region", { name: "Replacement budget review" }),
    ).not.toBeInTheDocument();
  },
);
it("retains uncertain POST body and key through polling overlap and closing; only explicit replay submits", async () => {
  const { submit, client, get } = mount();
  await open();
  select();
  await review();
  submit.mockRejectedValueOnce(new Error("Response lost"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm and create replacement run" }),
  );
  await screen.findByText(/Creation is unconfirmed/);
  const initial = submit.mock.calls[0];
  get.mockResolvedValue({ ...empty, children: [child] });
  await act(async () => {
    await client.refetchQueries({ queryKey: ["replacements", runId] });
  });
  expect(screen.getByLabelText(id)).toBeDisabled();
  expect(screen.getByLabelText("Replacement cost ceiling (USD)")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Close replacements" }));
  await open();
  expect(submit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Replay reviewed submission" }));
  await screen.findByText("Replacement created:");
  expect(submit.mock.calls[1]).toEqual(initial);
});
it("retains query error notices and retry access, plus review failures", async () => {
  const { get, validate, client } = mount();
  get.mockRejectedValueOnce(new Error("unavailable"));
  await open();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Replacement evidence could not be refreshed",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry replacement evidence" }));
  await waitFor(() => expect(screen.getByLabelText(id)).toBeEnabled());
  select();
  validate.mockRejectedValueOnce(new Error("Source changed"));
  fireEvent.click(screen.getByRole("button", { name: "Review replacements" }));
  await screen.findByText(/Source changed/);
  await review();
  get.mockRejectedValue(new Error("offline"));
  await act(async () => {
    await client.refetchQueries({ queryKey: ["replacements", runId] });
  });
  expect(await screen.findByText(/Showing saved data/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Confirm and create replacement run" }),
  ).toBeDisabled();
});
it("shows empty candidates and unknown child status; combined is separate", async () => {
  const { get } = mount({ trials: [] });
  get.mockResolvedValue({ ...empty, children: [{ ...child, status: null }] });
  await open();
  expect(
    screen.getByText("No errored native UUID candidates available."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Replacements", exact: true }));
  expect(screen.getByText(/Status unavailable/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Combined", exact: true }));
  expect(screen.getByText("Combined · none")).toBeInTheDocument();
});
it("displays native mean and full source evidence, separating selected cost from all incurred coverage", () => {
  const result = {
    stats: {
      n_completed_trials: 2,
      n_errored_trials: 1,
      evals: { synthetic: { metrics: [{ mean: 0.25 }], reward_stats: { reward: {} } } },
    },
    trial_results: [{ id, source: "synthetic-source" }],
  };
  render(
    <CombinedReplacementView
      view={{
        ...empty,
        assembly: { availability: "available", result },
        incurred: {
          cost_usd: 4,
          reported_attempts: 2,
          unknown_attempts: 1,
          total_attempts: 3,
        },
        selected_cost_usd: 2,
      }}
    />,
  );
  expect(screen.getByText("Score · reward mean: 0.250")).toBeInTheDocument();
  expect(
    screen.getByText(/Native completed trials: 2 · Native errors: 1/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/2 reported · 1 unknown-cost · 3 observed/),
  ).toBeInTheDocument();
  expect(screen.getByText(/Selected native cohort cost:.*2/)).toBeInTheDocument();
  expect(
    screen.getByText(/All-incurred reported agent-cost subtotal:.*4/),
  ).toBeInTheDocument();
  const href =
    screen
      .getByRole("link", { name: "Download combined native JSON" })
      .getAttribute("href") ?? "";
  expect(JSON.parse(decodeURIComponent(href.split(",")[1] ?? ""))).toEqual(result);
  expect(screen.getByText(/"synthetic-source"/)).toBeInTheDocument();
});
it.each(["none", "pending", "unavailable"] as const)(
  "displays %s availability without fallback or invented zero costs",
  (availability) => {
    render(
      <CombinedReplacementView
        view={{ ...empty, assembly: { availability, result: null } }}
      />,
    );
    expect(screen.getByText(`Combined · ${availability}`)).toBeInTheDocument();
    expect(
      screen.getByText("Selected native cohort cost: Unknown"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("All-incurred reported agent-cost subtotal: Unknown"),
    ).toBeInTheDocument();
    expect(screen.getByText("Attempt-cost coverage unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  },
);
it("does not invent means for arbitrary metrics or equate null subtotal with zero", () => {
  render(
    <CombinedReplacementView
      view={{
        ...empty,
        assembly: {
          availability: "available",
          result: { stats: { evals: { synthetic: { metrics: [{ custom: 1 }] } } } },
        },
        incurred: {
          cost_usd: null,
          reported_attempts: 0,
          unknown_attempts: 2,
          total_attempts: 2,
        },
      }}
    />,
  );
  expect(screen.getByText("Score: -")).toBeInTheDocument();
  expect(
    screen.getByText("All-incurred reported agent-cost subtotal: Unknown"),
  ).toBeInTheDocument();
  expect(screen.getByText(/0 reported · 2 unknown-cost/)).toBeInTheDocument();
});
it("shows native review with no warnings or credentials and deselects exact IDs", async () => {
  const { validate } = mount();
  validate.mockResolvedValue({
    ...validation,
    warnings: [],
    credentials_available: false,
  });
  await open();
  select();
  fireEvent.click(screen.getByLabelText(id));
  expect(screen.getByRole("button", { name: "Review replacements" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText(id));
  fireEvent.click(screen.getByLabelText("I reviewed these as infrastructure failures"));
  await review();
  expect(screen.getByText("None reported.")).toBeInTheDocument();
  expect(screen.getByText("Credentials available: no")).toBeInTheDocument();
});

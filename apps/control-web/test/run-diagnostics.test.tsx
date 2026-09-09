// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { RunView } from "../src/api";
import {
  projectRunExceptions,
  RunDiagnostics,
  RunDiagnosticsSummary,
} from "../src/run-diagnostics";

afterEach(cleanup);

function run(result: RunView["result"], runId = "run-a"): RunView {
  return {
    record: {
      schema_version: "v1",
      run_id: runId,
      created_at: "2026-01-01T00:00:00Z",
      submitted_by: "test-operator",
      role: "diagnostic",
      harbor_revision: "dcd0a7ac",
      submission: {
        benchmark: { name: "example", preset: "example" },
        cost_ceiling_usd_per_trial: 1,
      },
      harbor_job_config: {},
    },
    state: {
      schema_version: "v1",
      run_id: runId,
      revision: 1,
      updated_at: "2026-01-01T00:00:00Z",
      desired_state: "run",
      actor: "test-operator",
      parent_jobs: [],
    },
    status: "finished",
    result,
  };
}

const resultWith = (exception_stats: unknown) => ({
  stats: { evals: { agent__model__dataset: { exception_stats } } },
});

function panel(value: RunView) {
  return render(<RunDiagnostics run={value} />, { wrapper: MemoryRouter });
}

describe("native exception projection", () => {
  it.each([
    null,
    undefined,
    false,
    [],
    "unavailable",
    {},
    { stats: [] },
    { stats: { evals: null } },
    { stats: { evals: [] } },
    { stats: { evals: { first: null } } },
    { stats: { evals: { first: {} } } },
    resultWith(null),
    resultWith([]),
    resultWith("message"),
    resultWith({ RuntimeError: "task-a" }),
    resultWith({ RuntimeError: [null, 42, {}, "", " ", "\ud800"] }),
    resultWith({ "": ["task-a"] }),
  ])("keeps missing or malformed evidence unknown: %j", (result) => {
    expect(projectRunExceptions(result)).toEqual({
      complete: false,
      groups: [],
      affectedTrials: 0,
    });
  });

  it("preserves partial evidence without claiming a full count or zero", () => {
    const result = {
      stats: {
        evals: {
          first: {
            exception_stats: {
              RuntimeError: ["task-a", null, "task-b"],
              OtherError: 4,
            },
          },
          second: null,
          third: { exception_stats: {} },
        },
      },
    };
    expect(projectRunExceptions(result)).toEqual({
      complete: false,
      groups: [{ type: "RuntimeError", trials: ["task-a", "task-b"] }],
      affectedTrials: 2,
    });
    panel(run(result));
    expect(
      screen.getByText("At least 2 affected trials · partial evidence"),
    ).toBeVisible();
    expect(screen.getByText(/full counts are unknown/)).toBeVisible();
    expect(screen.queryByText("No recorded exceptions")).not.toBeInTheDocument();
  });

  it("deduplicates within and across evals and types with deterministic sorting", () => {
    const first = { exception_stats: { ZError: ["task-b", "task-a", "task-a"] } };
    const second = { exception_stats: { AError: ["task-b"], ZError: ["task-c"] } };
    const project = (evals: unknown) => projectRunExceptions({ stats: { evals } });
    const expected = {
      complete: true,
      groups: [
        { type: "AError", trials: ["task-b"] },
        { type: "ZError", trials: ["task-a", "task-b", "task-c"] },
      ],
      affectedTrials: 3,
    };
    expect(project({ first, second, empty: { exception_stats: {} } })).toEqual(
      expected,
    );
    expect(project({ second, first })).toEqual(expected);
    expect(first.exception_stats.ZError).toEqual(["task-b", "task-a", "task-a"]);
  });

  it.each([{}, { RuntimeError: [] }])(
    "accepts validated empty exception maps: %j",
    (exceptions) => {
      expect(projectRunExceptions(resultWith(exceptions))).toEqual({
        complete: true,
        groups: [],
        affectedTrials: 0,
      });
      panel(run(resultWith(exceptions)));
      expect(screen.getByText("No recorded exceptions")).toBeVisible();
      expect(
        screen.getByText(
          /Absence of recorded exceptions is not proof of valid scoring/,
        ),
      ).toBeVisible();
    },
  );

  it("accepts an empty native evals map but not an empty map mixed with missing evidence", () => {
    expect(projectRunExceptions({ stats: { evals: {} } }).complete).toBe(true);
    panel(run({ stats: { evals: { first: { exception_stats: {} }, second: {} } } }));
    expect(screen.getByText("Unknown / unavailable")).toBeVisible();
    expect(screen.queryByText("No recorded exceptions")).not.toBeInTheDocument();
  });
});

describe("run diagnostics presentation", () => {
  it("shows schema-shaped 14+1 native groups without inventing infrastructure classification", () => {
    const result = {
      id: "00000000-0000-4000-8000-000000000001",
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:01:00Z",
      n_total_trials: 15,
      stats: {
        n_completed_trials: 15,
        n_errored_trials: 15,
        n_running_trials: 0,
        n_pending_trials: 0,
        n_cancelled_trials: 0,
        n_retries: 0,
        evals: {
          agent__model__dataset: {
            n_trials: 0,
            n_errors: 15,
            metrics: [],
            pass_at_k: {},
            reward_stats: {},
            exception_stats: {
              RemoteProtocolError: Array.from(
                { length: 14 },
                (_, index) => `task-a-${index}`,
              ),
              RuntimeError: ["task-b"],
            },
          },
        },
      },
      trial_results: [
        {
          exception_info: {
            exception_message: "synthetic message must not display",
            exception_traceback: "synthetic traceback must not display",
          },
        },
      ],
    };
    const before = JSON.stringify(result);
    panel(run(result));
    expect(
      screen.getByRole("region", { name: "Harbor-reported exceptions" }),
    ).toHaveAttribute("id", "diagnostics");
    expect(screen.getByText("15 affected trials")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "RemoteProtocolError 14 trials" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "RuntimeError 1 trial" })).toBeVisible();
    expect(screen.getAllByRole("link")).toHaveLength(15);
    expect(screen.getByText(/Completed includes errored trials/)).toHaveTextContent(
      /Infrastructure classification is not recorded by pinned Harbor/,
    );
    expect(screen.getByText(/This read-only view/)).toHaveTextContent(
      "does not retry trials or modify scores",
    );
    expect(screen.queryByText(/synthetic .* must not display/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(JSON.stringify(result)).toBe(before);
  });

  it("encodes run and trial segments and renders identifiers as text, not markup", () => {
    const runId = "run/a ?#%";
    const name = "<img src=x>/task ?#%";
    panel(run(resultWith({ "<b>Error</b>": [name] }), runId));
    expect(screen.getByRole("link", { name })).toHaveAttribute(
      "href",
      `/runs/${encodeURIComponent(runId)}/trials/${encodeURIComponent(name)}`,
    );
    expect(screen.getByText("<b>Error</b>")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("tolerates malformed Unicode in a run ID without crashing or generating a broken link", () => {
    panel(run(resultWith({ RuntimeError: ["task-a"] }), "\ud800"));
    expect(screen.getByText("task-a")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("bounds trial links initially while keeping full counts and accessible expansion", async () => {
    panel(
      run(
        resultWith({
          RuntimeError: Array.from(
            { length: 25 },
            (_, i) => `task-${String(i).padStart(2, "0")}`,
          ),
        }),
      ),
    );
    expect(screen.getByText("25 affected trials")).toBeVisible();
    expect(screen.getAllByRole("link")).toHaveLength(20);
    const disclosure = screen.getByText("Show 5 more trial names for RuntimeError");
    fireEvent.click(disclosure);
    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(25));
    expect(screen.getByRole("link", { name: "task-24" })).toBeVisible();
    fireEvent.click(disclosure);
    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(20));
  });

  it("also bounds exception groups without discarding counts", async () => {
    panel(
      run(
        resultWith(
          Object.fromEntries(
            Array.from({ length: 22 }, (_, i) => [`Error${i}`, [`task-${i}`]]),
          ),
        ),
      ),
    );
    expect(screen.getByText("22 affected trials")).toBeVisible();
    expect(screen.getAllByRole("link")).toHaveLength(20);
    fireEvent.click(screen.getByText("Show 2 more exception types"));
    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(22));
  });

  it("refreshes both summary and panel without stale counts or names", () => {
    const view = (value: RunView) => (
      <MemoryRouter>
        <RunDiagnosticsSummary run={value} />
        <RunDiagnostics run={value} />
      </MemoryRouter>
    );
    const { rerender } = render(view(run(null)));
    expect(screen.getAllByText("Unknown / unavailable")).toHaveLength(2);
    rerender(view(run(resultWith({ RuntimeError: ["task-a"] }))));
    expect(screen.getAllByText("1 affected trial")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "task-a" })).toBeVisible();
    rerender(view(run(resultWith({}))));
    expect(screen.getAllByText("No recorded exceptions")).toHaveLength(2);
    expect(screen.queryByText("task-a")).not.toBeInTheDocument();
    rerender(view(run(resultWith({ RuntimeError: false }))));
    expect(screen.getAllByText("Unknown / unavailable")).toHaveLength(2);
    expect(screen.queryByText("No recorded exceptions")).not.toBeInTheDocument();
  });

  it("links compact summaries to the encoded diagnostics anchor and warns on zero", () => {
    render(<RunDiagnosticsSummary run={run(resultWith({}), "run/a #")} />, {
      wrapper: MemoryRouter,
    });
    const link = screen.getByRole("link", { name: /Harbor-reported exceptions/ });
    expect(link).toHaveAttribute("href", "/runs/run%2Fa%20%23#diagnostics");
    expect(within(link).getByText("No recorded exceptions")).toBeVisible();
    expect(link).toHaveTextContent(
      "Absence of recorded exceptions is not proof of valid scoring",
    );
  });

  it("marks compact partial evidence and unavailable run links honestly", () => {
    const { rerender } = render(
      <RunDiagnosticsSummary
        run={run(resultWith({ RuntimeError: ["task-a", null] }))}
      />,
      { wrapper: MemoryRouter },
    );
    expect(screen.getByRole("link")).toHaveTextContent(
      "At least 1 affected trial · partial evidence",
    );
    rerender(<RunDiagnosticsSummary run={run(null, "\ud800")} />);
    expect(screen.getByText("Unknown / unavailable")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

it.each([1, -1, 1.5, null, "0"])(
  "does not claim zero exceptions when native error count is inconsistent (%s)",
  (reportedErrors) => {
    const evidence = projectRunExceptions({
      stats: {
        n_errored_trials: reportedErrors,
        evals: { example: { exception_stats: {} } },
      },
    });
    expect(evidence).toMatchObject({ complete: false, affectedTrials: 0 });
  },
);

it("accepts a matching native error counter", () => {
  expect(
    projectRunExceptions({
      stats: {
        n_errored_trials: 1,
        evals: {
          example: { exception_stats: { RemoteProtocolError: ["trial-a"] } },
        },
      },
    }),
  ).toMatchObject({ complete: true, affectedTrials: 1 });
});

describe("per-evaluation error counters", () => {
  it.each([1, -1, 1.5, null, "0"])(
    "keeps contradictory or malformed counters partial: %j",
    (n_errors) => {
      expect(
        projectRunExceptions({
          stats: {
            n_errored_trials: 0,
            evals: { first: { n_errors, exception_stats: {} } },
          },
        }).complete,
      ).toBe(false);
    },
  );
  it("checks each evaluation independently and deduplicates its names", () => {
    const result = {
      stats: {
        n_errored_trials: 1,
        evals: {
          first: {
            n_errors: 1,
            exception_stats: { RuntimeError: ["task-a", "task-a"] },
          },
          second: { n_errors: 0, exception_stats: {} },
        },
      },
    };
    expect(projectRunExceptions(result).complete).toBe(true);
    result.stats.evals.first.n_errors = 0;
    result.stats.evals.second.n_errors = 1;
    expect(projectRunExceptions(result).complete).toBe(false);
  });
});

it.each([
  [null, "Infra-related trials: - · unclassified: -"],
  [resultWith({}), "Infra-related trials: 0 · unclassified: 0"],
  [
    {
      stats: {
        evals: { a: { exception_stats: { ApiOverloadedError: ["a"] } }, missing: {} },
      },
    },
    "Infra-related trials: ≥1 · unclassified: -",
  ],
  [
    {
      stats: {
        evals: { a: { exception_stats: { RuntimeError: ["a"] } }, missing: {} },
      },
    },
    "Infra-related trials: - · unclassified: ≥1",
  ],
] as const)(
  "distinguishes unknown category zeros from complete evidence",
  (result, text) => {
    render(<RunDiagnosticsSummary run={run(result)} />, { wrapper: MemoryRouter });
    expect(screen.getByText(text)).toBeInTheDocument();
  },
);

it("colors positive affected and group counts red, retaining neutral zero/missing", () => {
  const { unmount } = render(
    <RunDiagnosticsSummary run={run(resultWith({ RuntimeError: ["trial-a"] }))} />,
    { wrapper: MemoryRouter },
  );
  expect(screen.getByText("1 affected trial")).toHaveClass("text-red-400");
  expect(screen.getByText(/Infra-related trials: 0/)).not.toHaveClass("text-red-400");
  unmount();
  const panel = render(
    <RunDiagnostics run={run(resultWith({ RuntimeError: ["trial-a"] }))} />,
    { wrapper: MemoryRouter },
  );
  expect(screen.getByText("1 trial", { exact: true })).toHaveClass("text-red-400");
  panel.unmount();
  const zero = render(<RunDiagnosticsSummary run={run(resultWith({}))} />, {
    wrapper: MemoryRouter,
  });
  expect(screen.getByText("No recorded exceptions")).toHaveClass("text-slate-400");
  zero.unmount();
  render(<RunDiagnosticsSummary run={run(null)} />, { wrapper: MemoryRouter });
  expect(screen.getByText("Unknown / unavailable")).toHaveClass("text-slate-400");
});

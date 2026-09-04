import type { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CircleDollarSign,
  Clock3,
  Cpu,
  ListChecks,
  Pause,
  Play,
  Plus,
  RotateCw,
  ServerCog,
  Square,
  TerminalSquare,
} from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  actOnRun,
  type ParentJob,
  type PresetSubmission,
  type PresetsResponse,
  type RunView,
  submitRun,
  type TrialDetail,
  type TrialSummary,
} from "./api";
import { DataTable } from "./components/data-table";
import { useControlState } from "./control-state";
import { PageHeader } from "./layout";
import {
  asRecord,
  formatDate,
  formatDuration,
  formatMoneyUsd,
  formatTokens,
  humanize,
  numberValue,
  runNameClass,
  shortId,
  stringValue,
} from "./lib";
import {
  keys,
  useJobs,
  usePresets,
  useRun,
  useRuns,
  useSystem,
  useTrial,
  useTrials,
} from "./queries";
import { Badge, Button, Card, Empty, ErrorNotice, Progress, QueryContent } from "./ui";

function stats(run: RunView): Record<string, unknown> | null {
  return asRecord(run.result?.stats);
}

function stat(run: RunView, key: string): number | null {
  return numberValue(stats(run)?.[key]);
}

function progress(run: RunView): { completed: number; total: number | null } {
  return {
    completed: stat(run, "n_completed_trials") ?? 0,
    total: numberValue(run.result?.n_total_trials),
  };
}

function averageReward(run: RunView): number | null {
  const evals = asRecord(stats(run)?.evals);
  if (!evals) return null;
  const values: number[] = [];
  for (const evaluation of Object.values(evals)) {
    const metrics = asRecord(evaluation)?.metrics;
    if (!Array.isArray(metrics)) continue;
    for (const metric of metrics) {
      const mean = numberValue(asRecord(metric)?.mean);
      if (mean !== null) values.push(mean);
    }
  }
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function Stat({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
            {label}
          </p>
          <div className="mt-2 break-words text-2xl font-semibold text-white">
            {value}
          </div>
          {detail ? <div className="mt-2 text-xs text-slate-500">{detail}</div> : null}
        </div>
        {icon ? (
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-cyan-400/10 text-cyan-300">
            {icon}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-slate-200">{children}</dd>
    </div>
  );
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="rounded-lg border border-slate-800 bg-slate-950/60">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
        {label}
      </summary>
      <pre className="max-h-[36rem] overflow-auto border-t border-slate-800 p-4 text-xs leading-5 text-slate-300">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function fieldClass(): string {
  return "mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-400";
}

function SubmissionForm({ presets }: { presets: PresetsResponse }) {
  const client = useQueryClient();
  const firstBenchmark = presets.benchmarks[0];
  const firstAgent = presets.agents[0];
  const [benchmarkKey, setBenchmarkKey] = useState(
    firstBenchmark ? `${firstBenchmark.benchmark}\n${firstBenchmark.preset}` : "",
  );
  const [agentKey, setAgentKey] = useState(
    firstAgent ? `${firstAgent.agent}\n${firstAgent.version}` : "",
  );
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [reasoning, setReasoning] = useState(firstAgent?.reasoning_values[0] ?? "off");
  const [ceiling, setCeiling] = useState("1");
  const [role, setRole] = useState<"final" | "diagnostic">("diagnostic");
  const [createdRun, setCreatedRun] = useState<string | null>(null);
  const selectedBenchmark = presets.benchmarks.find(
    (item) => `${item.benchmark}\n${item.preset}` === benchmarkKey,
  );
  const selectedAgent = presets.agents.find(
    (item) => `${item.agent}\n${item.version}` === agentKey,
  );
  const mutation = useMutation({
    mutationFn: (input: PresetSubmission) => submitRun(input),
    onSuccess: async ({ run }) => {
      setCreatedRun(run.run_id);
      await client.invalidateQueries({ queryKey: keys.runs });
    },
  });

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatedRun(null);
    const [benchmark, preset] = benchmarkKey.split("\n");
    const [agent, version] = agentKey.split("\n");
    if (!(benchmark && preset && agent && version && model.trim() && provider.trim()))
      return;
    mutation.mutate({
      benchmark: { name: benchmark, preset },
      model: {
        id: model.trim(),
        provider: provider.trim(),
        reasoning_effort: reasoning,
      },
      harness: { agent, version },
      cost_ceiling_usd_per_trial: Number(ceiling),
      role,
    });
  }

  return (
    <form className="space-y-4" onSubmit={send}>
      <label className="block text-sm text-slate-300">
        Benchmark preset
        <select
          className={fieldClass()}
          required
          value={benchmarkKey}
          onChange={(event) => setBenchmarkKey(event.target.value)}
        >
          {presets.benchmarks.map((item) => (
            <option
              key={`${item.benchmark}:${item.preset}`}
              value={`${item.benchmark}\n${item.preset}`}
            >
              {item.benchmark} · {item.preset} · {item.job.environment_flavor}
            </option>
          ))}
        </select>
        {selectedBenchmark ? (
          <span className="mt-1 block text-xs text-slate-500">
            {`${selectedBenchmark.job.environment_flavor} · ${selectedBenchmark.job.n_attempts} ${selectedBenchmark.job.n_attempts === 1 ? "attempt" : "attempts"} · ${selectedBenchmark.job.n_concurrent_trials} concurrent ${selectedBenchmark.job.n_concurrent_trials === 1 ? "trial" : "trials"}`}
          </span>
        ) : null}
      </label>
      <label className="block text-sm text-slate-300">
        Agent
        <select
          className={fieldClass()}
          required
          value={agentKey}
          onChange={(event) => {
            setAgentKey(event.target.value);
            const next = presets.agents.find(
              (item) => `${item.agent}\n${item.version}` === event.target.value,
            );
            setReasoning(next?.reasoning_values[0] ?? "off");
          }}
        >
          {presets.agents.map((item) => (
            <option
              key={`${item.agent}:${item.version}`}
              value={`${item.agent}\n${item.version}`}
            >
              {item.agent} · {item.version}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm text-slate-300">
          Model
          <input
            className={fieldClass()}
            maxLength={320}
            placeholder="publisher/model"
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <label className="block text-sm text-slate-300">
          Provider
          <input
            className={fieldClass()}
            pattern="[a-z0-9][a-z0-9-]{0,62}"
            placeholder="provider"
            required
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          />
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block text-sm text-slate-300">
          Reasoning
          <select
            className={fieldClass()}
            value={reasoning}
            onChange={(event) => setReasoning(event.target.value)}
          >
            {(selectedAgent?.reasoning_values ?? ["off"]).map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-slate-300">
          Cost limit per trial
          <input
            className={fieldClass()}
            min="0.000001"
            max="10000"
            step="0.000001"
            type="number"
            required
            value={ceiling}
            onChange={(event) => setCeiling(event.target.value)}
          />
        </label>
        <label className="block text-sm text-slate-300">
          Result role
          <select
            className={fieldClass()}
            value={role}
            onChange={(event) => setRole(event.target.value as "final" | "diagnostic")}
          >
            <option value="diagnostic">Diagnostic</option>
            <option value="final">Final</option>
          </select>
        </label>
      </div>
      {mutation.error ? <ErrorNotice error={mutation.error} /> : null}
      {createdRun ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300">
          Run created.{" "}
          <Link className="underline" to={`/runs/${createdRun}`}>
            Open it
          </Link>
          .
        </p>
      ) : null}
      <Button disabled={mutation.isPending} type="submit">
        <Plus size={15} aria-hidden="true" />
        {mutation.isPending ? "Submitting" : "Submit run"}
      </Button>
    </form>
  );
}

export function OverviewPage() {
  const system = useSystem();
  const runs = useRuns();
  const jobs = useJobs();
  const presets = usePresets();
  const { actor } = useControlState();
  if (!system.data) return <QueryContent query={system}>{null}</QueryContent>;
  const activeJobs = jobs.data?.filter((job) =>
    ["queued", "running"].includes(job.stage),
  ).length;
  return (
    <>
      <PageHeader
        title="Overview"
        description="Current Harbor runs, trials, parent Jobs, and reviewed benchmark submission."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Runs"
          value={system.data.projection.runs}
          icon={<ListChecks size={18} />}
        />
        <Stat
          label="Trials"
          value={system.data.projection.trials}
          icon={<TerminalSquare size={18} />}
        />
        <Stat
          label="Parent Jobs"
          value={system.data.projection.parent_jobs}
          detail={`${activeJobs ?? "Unavailable"} active`}
          icon={<ServerCog size={18} />}
        />
        <Stat
          label="Capacity"
          value={system.data.capacity.max_active_parent_jobs}
          detail="Maximum active parent Jobs"
          icon={<Cpu size={18} />}
        />
      </div>
      <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)]">
        <Card>
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold text-white">Recent runs</h2>
              <p className="mt-1 text-xs text-slate-500">
                Latest projected Harbor state
              </p>
            </div>
            <Link className="text-sm text-cyan-300" to="/runs">
              All runs
            </Link>
          </div>
          <QueryContent query={runs}>
            {runs.data?.length === 0 ? <Empty>No runs are available.</Empty> : null}
            <div className="space-y-2">
              {runs.data?.slice(0, 6).map((run) => {
                const current = progress(run);
                return (
                  <Link
                    className="flex flex-col gap-2 rounded-lg border border-slate-800 px-4 py-3 hover:border-slate-700 hover:bg-slate-900/60 sm:flex-row sm:items-center sm:justify-between"
                    key={run.record.run_id}
                    to={`/runs/${run.record.run_id}`}
                  >
                    <span className="min-w-0">
                      <strong className="block truncate text-sm text-slate-100">
                        {run.record.submission.model.id}
                      </strong>
                      <span className="block truncate text-xs text-slate-500">
                        {run.record.submission.benchmark.name} ·{" "}
                        {run.record.submission.harness.agent}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      {current.total !== null ? (
                        <span className="text-xs text-slate-500">
                          {current.completed}/{current.total}
                        </span>
                      ) : null}
                      <Badge status={run.status}>{humanize(run.status)}</Badge>
                    </span>
                  </Link>
                );
              })}
            </div>
          </QueryContent>
        </Card>
        <Card>
          <h2 className="font-semibold text-white">New run</h2>
          <p className="mt-1 text-xs text-slate-500">
            Harbor expands tasks and owns trial execution.
          </p>
          <div className="mt-5">
            <QueryContent query={presets}>
              {presets.data && actor.role === "operator" ? (
                <SubmissionForm presets={presets.data} />
              ) : (
                <Empty>Your account has read-only access.</Empty>
              )}
            </QueryContent>
          </div>
        </Card>
      </div>
    </>
  );
}

export function RunsPage() {
  const query = useRuns();
  const columns = useMemo<ColumnDef<RunView>[]>(
    () => [
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge status={row.original.status}>{humanize(row.original.status)}</Badge>
        ),
      },
      {
        id: "model",
        header: "Model",
        accessorFn: (run) => run.record.submission.model.id,
        cell: ({ row }) => (
          <Link
            className="font-medium text-cyan-300"
            to={`/runs/${row.original.record.run_id}`}
          >
            {row.original.record.submission.model.id}
            <span className="block text-xs font-normal text-slate-500">
              {row.original.record.submission.model.provider}
            </span>
          </Link>
        ),
      },
      {
        id: "benchmark",
        header: "Benchmark",
        accessorFn: (run) => run.record.submission.benchmark.name,
        cell: ({ row }) => (
          <span>
            {row.original.record.submission.benchmark.name}
            <span className="block text-xs text-slate-500">
              {row.original.record.submission.benchmark.preset}
            </span>
          </span>
        ),
      },
      {
        id: "agent",
        header: "Agent",
        accessorFn: (run) => run.record.submission.harness.agent,
        cell: ({ row }) => (
          <span>
            {row.original.record.submission.harness.agent}
            <span className="block text-xs text-slate-500">
              {row.original.record.submission.harness.version}
            </span>
          </span>
        ),
      },
      {
        id: "progress",
        header: "Progress",
        accessorFn: (run) => progress(run).completed,
        enableColumnFilter: false,
        cell: ({ row }) => {
          const value = progress(row.original);
          return value.total === null
            ? "Unavailable"
            : `${value.completed} / ${value.total}`;
        },
      },
      {
        id: "cost",
        header: "Cost",
        accessorFn: (run) => stat(run, "cost_usd") ?? -1,
        enableColumnFilter: false,
        cell: ({ row }) => formatMoneyUsd(stat(row.original, "cost_usd")),
      },
      {
        id: "created",
        header: "Created",
        accessorFn: (run) => run.record.created_at,
        enableColumnFilter: false,
        cell: ({ row }) => formatDate(row.original.record.created_at),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Runs"
        description="One logical Run owns one Harbor job. Progress and totals come from Harbor result files."
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            <RotateCw size={14} aria-hidden="true" /> Refresh
          </Button>
        }
      />
      <QueryContent query={query}>
        {query.data ? (
          <DataTable
            columns={columns}
            data={query.data}
            empty="No runs are available"
          />
        ) : null}
      </QueryContent>
    </>
  );
}

function RunActions({ run }: { run: RunView }) {
  const client = useQueryClient();
  const { writesAllowed } = useControlState();
  const mutation = useMutation({
    mutationFn: (action: "pause" | "resume" | "cancel") =>
      actOnRun(run.record.run_id, action),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.run(run.record.run_id) }),
        client.invalidateQueries({ queryKey: keys.runs }),
      ]);
    },
  });
  const live = run.status === "queued" || run.status === "running";
  const paused = run.status === "paused";
  if (!live && !paused) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {live ? (
        <Button
          variant="outline"
          disabled={!writesAllowed || mutation.isPending}
          onClick={() => mutation.mutate("pause")}
        >
          <Pause size={14} aria-hidden="true" /> Pause
        </Button>
      ) : null}
      {paused ? (
        <Button
          disabled={!writesAllowed || mutation.isPending}
          onClick={() => mutation.mutate("resume")}
        >
          <Play size={14} aria-hidden="true" /> Resume
        </Button>
      ) : null}
      <Button
        variant="destructive"
        disabled={!writesAllowed || mutation.isPending}
        onClick={() => mutation.mutate("cancel")}
      >
        <Square size={13} aria-hidden="true" /> Cancel
      </Button>
      {mutation.error ? <ErrorNotice error={mutation.error} /> : null}
    </div>
  );
}

export function RunPage() {
  const { runId = "" } = useParams();
  const run = useRun(runId);
  const trials = useTrials(runId);
  const jobs = useJobs();
  if (!run.data)
    return (
      <QueryContent query={run}>
        <Empty>Run not found.</Empty>
      </QueryContent>
    );
  const item = run.data;
  const current = progress(item);
  const jobIds = new Set(item.state.parent_jobs.map((job) => job.id));
  const runJobs = jobs.data?.filter(
    (job) => job.run_id === item.record.run_id || jobIds.has(job.id),
  );
  return (
    <>
      <PageHeader
        title="Run detail"
        description={item.record.run_id}
        action={<RunActions run={item} />}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          label="Status"
          value={<Badge status={item.status}>{humanize(item.status)}</Badge>}
        />
        <Stat
          label="Progress"
          value={
            current.total === null
              ? "Unavailable"
              : `${current.completed} / ${current.total}`
          }
          detail={
            current.total && current.total > 0 ? (
              <Progress
                value={current.completed / current.total}
                label="Trial progress"
              />
            ) : undefined
          }
        />
        <Stat label="Reward" value={averageReward(item) ?? "Unavailable"} />
        <Stat label="Input tokens" value={formatTokens(stat(item, "n_input_tokens"))} />
        <Stat
          label="Inference cost"
          value={formatMoneyUsd(stat(item, "cost_usd"))}
          icon={<CircleDollarSign size={18} />}
        />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-white">Run identity</h2>
          <dl className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field label="Run ID">
              <code className={runNameClass}>{item.record.run_id}</code>
            </Field>
            <Field label="Created">{formatDate(item.record.created_at)}</Field>
            <Field label="Submitted by">{item.record.submitted_by}</Field>
            <Field label="Role">{humanize(item.record.role)}</Field>
            <Field label="Desired state">{humanize(item.state.desired_state)}</Field>
            <Field label="State updated">{formatDate(item.state.updated_at)}</Field>
            <Field label="Harbor revision">
              <code className={runNameClass}>{item.record.harbor_revision}</code>
            </Field>
            <Field label="State revision">{item.state.revision}</Field>
          </dl>
        </Card>
        <Card>
          <h2 className="font-semibold text-white">Submission</h2>
          <dl className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field label="Benchmark">
              {item.record.submission.benchmark.name} ·{" "}
              {item.record.submission.benchmark.preset}
            </Field>
            <Field label="Model">{item.record.submission.model.id}</Field>
            <Field label="Provider">{item.record.submission.model.provider}</Field>
            <Field label="Reasoning">
              {humanize(item.record.submission.model.reasoning_effort)}
            </Field>
            <Field label="Agent">
              {item.record.submission.harness.agent} ·{" "}
              {item.record.submission.harness.version}
            </Field>
            <Field label="Cost limit per trial">
              {formatMoneyUsd(item.record.submission.cost_ceiling_usd_per_trial)}
            </Field>
          </dl>
        </Card>
      </div>
      <Card className="mt-6">
        <h2 className="font-semibold text-white">Harbor totals</h2>
        <dl className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Completed">
            {stat(item, "n_completed_trials") ?? "Unavailable"}
          </Field>
          <Field label="Errors">
            {stat(item, "n_errored_trials") ?? "Unavailable"}
          </Field>
          <Field label="Cancelled">
            {stat(item, "n_cancelled_trials") ?? "Unavailable"}
          </Field>
          <Field label="Retries">{stat(item, "n_retries") ?? "Unavailable"}</Field>
          <Field label="Pending">
            {stat(item, "n_pending_trials") ?? "Unavailable"}
          </Field>
          <Field label="Running">
            {stat(item, "n_running_trials") ?? "Unavailable"}
          </Field>
          <Field label="Output tokens">
            {formatTokens(stat(item, "n_output_tokens"))}
          </Field>
          <Field label="Cache tokens">
            {formatTokens(stat(item, "n_cache_tokens"))}
          </Field>
        </dl>
      </Card>
      <Card className="mt-6">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-white">Trials</h2>
            <p className="mt-1 text-xs text-slate-500">
              Full trial data is loaded only when a trial is opened.
            </p>
          </div>
          <Badge>{trials.data?.length ?? 0} projected</Badge>
        </div>
        <QueryContent query={trials}>
          {trials.data ? <TrialsTable trials={trials.data} /> : null}
        </QueryContent>
      </Card>
      <Card className="mt-6">
        <h2 className="font-semibold text-white">Parent Jobs</h2>
        <div className="mt-5">
          <QueryContent query={jobs}>
            {runJobs ? <JobsTable jobs={runJobs} showRun={false} /> : null}
          </QueryContent>
        </div>
      </Card>
      <div className="mt-6 space-y-3">
        <JsonDetails label="Harbor JobConfig" value={item.record.harbor_job_config} />
        {item.result ? (
          <JsonDetails label="Complete Harbor job result" value={item.result} />
        ) : null}
      </div>
    </>
  );
}

function TrialsTable({ trials }: { trials: TrialSummary[] }) {
  if (trials.length === 0) return <Empty>No trial result is available yet.</Empty>;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full min-w-[620px] border-collapse text-left text-sm">
        <thead className="bg-slate-950/70 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-4 py-3">Trial</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Reward</th>
            <th className="px-4 py-3 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {trials.map((trial) => (
            <tr
              className="border-t border-slate-800 hover:bg-slate-900/60"
              key={trial.trial_name}
            >
              <td className="px-4 py-3">
                <Link
                  className="font-mono text-xs text-cyan-300"
                  to={`/runs/${encodeURIComponent(trial.run_id)}/trials/${encodeURIComponent(trial.trial_name)}`}
                >
                  {trial.trial_name}
                </Link>
              </td>
              <td className="px-4 py-3">
                <Badge status={trial.status}>{humanize(trial.status)}</Badge>
              </td>
              <td className="px-4 py-3 text-right text-slate-300">
                {trial.reward ?? "Unavailable"}
              </td>
              <td className="px-4 py-3 text-right text-slate-300">
                {formatMoneyUsd(trial.cost_usd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function agentResult(trial: TrialDetail): Record<string, unknown> | null {
  return asRecord(trial.result.agent_result);
}

export function TrialPage() {
  const { runId = "", trialName = "" } = useParams();
  const query = useTrial(runId, trialName);
  if (!query.data)
    return (
      <QueryContent query={query}>
        <Empty>Trial not found.</Empty>
      </QueryContent>
    );
  const trial = query.data;
  const result = trial.result;
  const agent = agentResult(trial);
  const exception = asRecord(result.exception_info);
  const trajectory = result.trajectory ?? agent?.trajectory ?? result.agent_trajectory;
  const started = stringValue(result.started_at);
  const finished = stringValue(result.finished_at);
  return (
    <>
      <PageHeader
        title="Trial detail"
        description={trial.trial_name}
        action={
          <Link className="text-sm text-cyan-300" to={`/runs/${trial.run_id}`}>
            Back to run
          </Link>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          label="Status"
          value={<Badge status={trial.status}>{humanize(trial.status)}</Badge>}
        />
        <Stat label="Reward" value={trial.reward ?? "Unavailable"} />
        <Stat label="Cost" value={formatMoneyUsd(trial.cost_usd)} />
        <Stat
          label="Duration"
          value={formatDuration(started, finished)}
          icon={<Clock3 size={18} />}
        />
        <Stat
          label="Requests"
          value={
            numberValue(agent?.n_api_calls) ??
            numberValue(agent?.n_requests) ??
            "Unavailable"
          }
        />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-white">Trial identity</h2>
          <dl className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field label="Trial">
              <code className={runNameClass}>{trial.trial_name}</code>
            </Field>
            <Field label="Run">
              <Link className="text-cyan-300" to={`/runs/${trial.run_id}`}>
                {trial.run_id}
              </Link>
            </Field>
            <Field label="Task">{stringValue(result.task_name) ?? "Unavailable"}</Field>
            <Field label="Started">{formatDate(started)}</Field>
            <Field label="Finished">{formatDate(finished)}</Field>
            <Field label="Verifier mode">
              {stringValue(result.verifier_environment_mode) ?? "Unavailable"}
            </Field>
          </dl>
        </Card>
        <Card>
          <h2 className="font-semibold text-white">Agent totals</h2>
          <dl className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field label="Input tokens">
              {formatTokens(
                numberValue(agent?.n_input_tokens) ?? numberValue(agent?.input_tokens),
              )}
            </Field>
            <Field label="Output tokens">
              {formatTokens(
                numberValue(agent?.n_output_tokens) ??
                  numberValue(agent?.output_tokens),
              )}
            </Field>
            <Field label="Cache tokens">
              {formatTokens(
                numberValue(agent?.n_cache_tokens) ?? numberValue(agent?.cache_tokens),
              )}
            </Field>
            <Field label="Cost">
              {formatMoneyUsd(numberValue(agent?.cost_usd) ?? trial.cost_usd)}
            </Field>
          </dl>
        </Card>
      </div>
      {exception ? (
        <Card className="mt-6 border-rose-500/40 bg-rose-500/5">
          <h2 className="font-semibold text-rose-200">Exception</h2>
          <p className="mt-3 text-sm font-medium text-slate-200">
            {stringValue(exception.exception_type) ?? "Unknown exception"}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-400">
            {stringValue(exception.exception_message) ??
              stringValue(exception.message) ??
              "No message was recorded."}
          </p>
          {stringValue(exception.traceback) ? (
            <pre className="mt-4 max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-4 text-xs leading-5 text-slate-300">
              {stringValue(exception.traceback)}
            </pre>
          ) : null}
        </Card>
      ) : null}
      <Card className="mt-6">
        <h2 className="font-semibold text-white">Verifier result</h2>
        <div className="mt-4">
          {result.verifier_result ? (
            <JsonDetails label="Verifier data" value={result.verifier_result} />
          ) : (
            <Empty>No verifier result was recorded.</Empty>
          )}
        </div>
      </Card>
      <Card className="mt-6">
        <h2 className="font-semibold text-white">Trajectory</h2>
        <p className="mt-1 text-xs text-slate-500">
          Result text is displayed as data and never rendered as HTML.
        </p>
        <div className="mt-4">
          {trajectory ? (
            <pre className="max-h-[42rem] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950 p-4 text-xs leading-5 text-slate-300">
              {typeof trajectory === "string"
                ? trajectory
                : JSON.stringify(trajectory, null, 2)}
            </pre>
          ) : (
            <Empty>No trajectory was included in this result.</Empty>
          )}
        </div>
      </Card>
      <div className="mt-6 space-y-3">
        {agent ? <JsonDetails label="Agent result" value={agent} /> : null}
        <JsonDetails label="Complete trial result" value={result} />
      </div>
    </>
  );
}

function JobsTable({ jobs, showRun = true }: { jobs: ParentJob[]; showRun?: boolean }) {
  if (jobs.length === 0) return <Empty>No parent Jobs are available.</Empty>;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full min-w-[700px] border-collapse text-left text-sm">
        <thead className="bg-slate-950/70 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-4 py-3">Job</th>
            {showRun ? <th className="px-4 py-3">Run</th> : null}
            <th className="px-4 py-3">Stage</th>
            <th className="px-4 py-3">Started</th>
            <th className="px-4 py-3">Duration</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr
              className="border-t border-slate-800 hover:bg-slate-900/60"
              key={job.id}
            >
              <td className="px-4 py-3 font-mono text-xs text-slate-300" title={job.id}>
                {shortId(job.id)}
              </td>
              {showRun ? (
                <td className="px-4 py-3">
                  <Link
                    className="font-mono text-xs text-cyan-300"
                    to={`/runs/${job.run_id}`}
                  >
                    {shortId(job.run_id)}
                  </Link>
                </td>
              ) : null}
              <td className="px-4 py-3">
                <Badge status={job.stage}>{humanize(job.stage)}</Badge>
              </td>
              <td className="px-4 py-3 text-slate-400">
                {formatDate(job.started_at ?? job.created_at)}
              </td>
              <td className="px-4 py-3 text-slate-400">
                {formatDuration(job.started_at, job.finished_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JobsPage() {
  const query = useJobs();
  return (
    <>
      <PageHeader
        title="Parent Jobs"
        description="Each entry is one parent HF Job for one logical Harbor run. Harbor owns its trial Jobs."
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            <RotateCw size={14} aria-hidden="true" /> Refresh
          </Button>
        }
      />
      <QueryContent query={query}>
        {query.data ? <JobsTable jobs={query.data} /> : null}
      </QueryContent>
    </>
  );
}

export function NotFoundPage() {
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div>
        <p className="text-sm font-medium text-cyan-300">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-white">Page not found</h1>
        <p className="mt-2 text-sm text-slate-500">
          The requested Harbor-HF page does not exist.
        </p>
        <Link className="mt-5 inline-block text-sm text-cyan-300" to="/overview">
          Go to overview
        </Link>
      </div>
    </div>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  ArrowRight,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  Gauge,
  PauseCircle,
  Percent,
  PlayCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  type AuditResponse,
  actOnRun,
  type Capacity,
  type EndpointList,
  type JobList,
  type NamespaceCapacity,
  type ProfileList,
  type ResultDetail,
  type ResultList,
  type RunAction,
  type RunList,
  type TaskList,
} from "./api";
import { DataTable } from "./components/data-table";
import { useControlState } from "./control-state";
import { hints } from "./hints";
import { counted, labeledHarness } from "./launch";
import { PageHeader } from "./layout";
import {
  cn,
  formatDate,
  formatExactMoney,
  formatMoney,
  formatPercent,
  formatPercentInterval,
  formatTokens,
  humanize,
  runNameClass,
  shortId,
} from "./lib";
import { NewRunPanel } from "./new-run";
import {
  keys,
  useAudit,
  useCapacity,
  useEndpoints,
  useInfrastructureCapacity,
  useJobs,
  useProfiles,
  useResult,
  useResults,
  useRun,
  useRunJobs,
  useRuns,
  useSystem,
  useTask,
  useTasks,
} from "./queries";
import {
  Badge,
  Button,
  Card,
  Empty,
  Hint,
  OutcomeBadge,
  Progress,
  QueryContent,
  statusTextClass,
} from "./ui";

type RunRow = RunList["items"][number];
type TaskRow = TaskList["items"][number];
type JobRow = JobList["items"][number];
type EndpointRow = EndpointList["items"][number];
type ProfileRow = ProfileList["items"][number];
type ResultRow = ResultList["items"][number];
type ResultTask = NonNullable<ResultDetail["tasks"]>[number];
type AuditRow = AuditResponse["items"][number];

function runIsFinished(status: string): boolean {
  return status === "completed" || status === "cancelled";
}

function runHasSealedFailures(run: RunRow): boolean {
  return run.status === "completed" && run.successful_tasks !== run.total_tasks;
}

function runIsRecovering(run: RunRow): boolean {
  return run.replacement_assigned_tasks > 0;
}

function runResultStatus(run: RunRow): string {
  if (runIsRecovering(run)) return "active";
  if (run.status === "failed") return "error";
  if (run.status === "completed-invalid") return "warning";
  return runHasSealedFailures(run) ? "warning" : run.status;
}

function runStatusLabel(run: RunRow): string {
  if (runIsRecovering(run)) return "Replacement in progress";
  if (run.status === "completed-invalid") return "Completed with invalid results";
  if (run.status === "failed") return "Failed safely";
  return runHasSealedFailures(run) ? "Completed with failures" : humanize(run.status);
}

function runStatusNote(run: RunRow): string {
  const publication = run.publication_status
    ? humanize(run.publication_status)
    : "Not published";
  if (runIsRecovering(run)) {
    const assigned = run.replacement_assigned_tasks;
    const recorded = run.replacement_recorded_tasks;
    const pending = run.pending_actions;
    return `${recorded} of ${assigned} replacement tasks recorded. ${counted(pending, "pending action")} on this run.`;
  }
  if (run.status === "cancelled") {
    const cancelled = run.total_tasks - run.successful_tasks;
    return `${publication}. ${cancelled} sealed ${cancelled === 1 ? "task" : "tasks"} cancelled.`;
  }
  if (run.status === "failed")
    return `${publication}. ${run.exhausted_tasks} exhausted ${run.exhausted_tasks === 1 ? "task" : "tasks"}.`;
  if (run.status === "completed-invalid")
    return `${publication}. ${run.invalid_selected_tasks} invalid selected ${run.invalid_selected_tasks === 1 ? "attempt" : "attempts"}.`;
  if (run.status !== "completed") return publication;
  if (run.successful_tasks === run.total_tasks) return publication;
  const failed = run.total_tasks - run.successful_tasks;
  return `${publication}. ${failed} sealed ${failed === 1 ? "task" : "tasks"} did not succeed.`;
}

function RunName({ runId, to }: { runId: string; to: string }) {
  return (
    <Link className={cn(runNameClass, "text-cyan-300 hover:underline")} to={to}>
      {runId}
    </Link>
  );
}

function jobColumns(includeRun: boolean): ColumnDef<JobRow>[] {
  const runColumn: ColumnDef<JobRow> = {
    accessorKey: "run_id",
    header: () => <Hint text={hints.jobs.run}>Run</Hint>,
    meta: { className: "min-w-0" },
    cell: ({ getValue }) => (
      <RunName runId={String(getValue())} to={`/runs/${String(getValue())}`} />
    ),
  };
  return [
    {
      accessorKey: "resource_id",
      header: () => <Hint text={hints.jobs.hfJob}>HF Job</Hint>,
      cell: ({ row }) => {
        const resourceId = row.original.resource_id;
        const inspectUrl = row.original.inspect_url;
        if (!resourceId || !inspectUrl)
          return (
            <span className="font-mono text-xs">
              {String(row.original.observed_state ?? "").startsWith("suppressed-")
                ? "Not created"
                : "Queued"}
            </span>
          );
        return (
          <a
            className="inline-flex items-center gap-1 font-mono text-xs text-cyan-300 hover:underline"
            href={inspectUrl}
            rel="noreferrer"
            target="_blank"
          >
            {shortId(resourceId)}
            <ExternalLink size={12} aria-hidden="true" />
            <span className="sr-only">Open Hugging Face Job</span>
          </a>
        );
      },
    },
    ...(includeRun ? [runColumn] : []),
    {
      accessorKey: "worker_role",
      header: "Worker role",
      cell: ({ getValue }) => humanize(String(getValue())),
    },
    {
      accessorKey: "action_kind",
      header: () => <Hint text={hints.jobs.action}>Action</Hint>,
      cell: ({ getValue }) => humanize(String(getValue())),
    },
    {
      accessorKey: "outcome",
      header: "Action outcome",
      cell: ({ getValue }) =>
        getValue() == null ? "Not reported" : humanize(String(getValue())),
    },
    {
      accessorKey: "observed_state",
      header: () => <Hint text={hints.jobs.observed}>Observed</Hint>,
      cell: ({ getValue }) => (
        <Badge status={String(getValue() ?? "queued").toLowerCase()}>
          {humanize(String(getValue() ?? "queued"))}
        </Badge>
      ),
    },
    {
      accessorKey: "assigned_tasks",
      header: () => <Hint text={hints.jobs.assigned}>Assigned</Hint>,
      cell: ({ getValue }) => {
        const value = getValue();
        if (typeof value !== "number")
          throw new Error("Job assigned task count is missing");
        return counted(value, "task");
      },
    },
    {
      accessorKey: "cost_microusd",
      header: () => <Hint text={hints.jobs.cost}>Cost</Hint>,
      cell: ({ getValue }) => {
        const value = getValue();
        if (typeof value !== "number") throw new Error("Job cost is missing");
        return formatMoney(value);
      },
    },
    {
      accessorKey: "created_at",
      header: () => <Hint text={hints.jobs.recorded}>Recorded</Hint>,
      cell: ({ getValue }) => formatDate(String(getValue())),
    },
  ];
}

function jobIsActive(job: JobRow): boolean {
  const state = String(job.observed_state ?? "pending").toUpperCase();
  return (
    !["CANCELED", "CANCELLED", "COMPLETED", "DELETED", "ERROR", "STOPPED"].includes(
      state,
    ) && !state.startsWith("SUPPRESSED-")
  );
}

function ReplacementProgress({
  run,
  capacity,
}: {
  run: RunRow;
  capacity: Capacity | undefined;
}) {
  const assigned = run.replacement_assigned_tasks;
  const recorded = run.replacement_recorded_tasks;
  const active = capacity?.run_active;
  const queued = capacity?.queued;
  const burst = capacity?.start_burst;
  return (
    <Card className="my-6 border-cyan-500/40 bg-cyan-950/20">
      <h2 className="text-base font-semibold text-cyan-100">
        Replacement Jobs on this Run
      </h2>
      <p className="mt-2 text-sm text-cyan-100">
        {recorded} of {assigned} assigned tasks have a replacement receipt. This is not
        a new run.
      </p>
      {typeof active === "number" ? (
        <p className="mt-2 text-sm text-cyan-100/80">
          {counted(active, "physical Job")} active
          {typeof queued === "number" ? `, ${counted(queued, "queued admission")}` : ""}
          .
          {typeof burst === "number"
            ? ` The Job start burst is ${burst}.`
            : " Job admission is waiting for available capacity."}
        </p>
      ) : null}
      <p className="mt-2 text-sm text-cyan-100/80">
        The task list still shows selected seals. Rows stay Infrastructure until a
        replacement attempt is chosen.
      </p>
      <div className="mt-4">
        <Progress
          label={`${recorded}/${assigned} replacement receipts`}
          value={(recorded / assigned) * 100}
        />
      </div>
    </Card>
  );
}

function RunJobs({ runId }: { runId: string }) {
  const query = useRunJobs(runId);
  const jobs = query.data?.items ?? [];
  const active = jobs.filter(jobIsActive).length;
  return (
    <section className="mt-8">
      {jobs.some((job) => job.worker_role === "preparation") ? (
        <Card className="my-6 border-amber-700" role="status">
          <h2 className="font-semibold">Hosted preparation</h2>
          {jobs.some(
            (job) =>
              job.worker_role === "preparation" &&
              (["ERROR", "FAILED"].includes((job.observed_state ?? "").toUpperCase()) ||
                job.outcome === "failed"),
          ) ? (
            <p className="mt-2 text-sm text-amber-200">
              A preparation Job reported failure. Review its recorded state and logs
              below; later attempts may supersede it.
            </p>
          ) : null}
          <p className="mt-2 text-sm">
            Recorded preparation Job states (not task outcomes):
          </p>
          <ul className="mt-2 space-y-2 text-sm">
            {jobs
              .filter((job) => job.worker_role === "preparation")
              .map((job) => (
                <li key={job.launch_action_id}>
                  <span className="font-mono">
                    {shortId(job.resource_id ?? job.launch_action_id)}
                  </span>
                  {": "}
                  {job.observed_state ?? "Queued"}
                  {" · Action outcome: "}
                  {job.outcome ?? "Not reported"}
                  {job.inspect_url ? (
                    <a
                      className="ml-3 text-cyan-300 hover:underline"
                      href={job.inspect_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Preparation Job logs
                    </a>
                  ) : (
                    <span> · Logs unavailable until a remote Job is recorded.</span>
                  )}
                </li>
              ))}
          </ul>
        </Card>
      ) : null}
      <h2 className="text-lg font-semibold text-white">
        <Hint text={hints.run.jobs}>Physical HF Jobs</Hint>
      </h2>
      <p className="mb-4 mt-1 text-sm text-slate-400">
        {query.data
          ? `${counted(jobs.length, "Job")} recorded, ${active} active. `
          : null}
        Preparation Jobs build the hosted execution inputs. Each physical trial Job runs
        one logical trial attempt. A logical trial can retain multiple Jobs after
        infrastructure replacements, but only one valid attempt becomes its selected
        result.
      </p>
      <QueryContent query={query}>
        <DataTable
          columns={jobColumns(false)}
          data={jobs}
          empty="No Jobs have been launched"
        />
      </QueryContent>
    </section>
  );
}

function useCursorNavigation() {
  const [searchParams, setSearchParams] = useSearchParams();
  const cursor = searchParams.get("cursor") ?? undefined;
  const history = searchParams.getAll("previous_cursor");
  const next = (nextCursor: string) => {
    const updated = new URLSearchParams(searchParams);
    updated.append("previous_cursor", cursor ?? "");
    updated.set("cursor", nextCursor);
    setSearchParams(updated);
  };
  const previous = () => {
    const updated = new URLSearchParams(searchParams);
    const prior = updated.getAll("previous_cursor");
    const previousCursor = prior.at(-1);
    updated.delete("previous_cursor");
    for (const value of prior.slice(0, -1)) updated.append("previous_cursor", value);
    if (previousCursor) updated.set("cursor", previousCursor);
    else updated.delete("cursor");
    setSearchParams(updated);
  };
  const first = () => {
    const updated = new URLSearchParams(searchParams);
    updated.delete("cursor");
    updated.delete("previous_cursor");
    setSearchParams(updated);
  };
  return { cursor, history, next, previous, first };
}

function CursorPager({
  navigation,
  nextCursor,
}: {
  navigation: ReturnType<typeof useCursorNavigation>;
  nextCursor: string | null | undefined;
}) {
  if (!navigation.cursor && !nextCursor) return null;
  return (
    <nav
      aria-label="Collection pages"
      className="mt-4 flex flex-wrap items-center justify-end gap-2"
    >
      <span className="mr-auto text-xs text-slate-500">
        Page {navigation.history.length + 1}
      </span>
      <Button disabled={!navigation.cursor} variant="ghost" onClick={navigation.first}>
        First
      </Button>
      <Button
        disabled={!navigation.cursor}
        variant="secondary"
        onClick={navigation.previous}
      >
        Previous
      </Button>
      <Button
        disabled={!nextCursor}
        onClick={() => nextCursor && navigation.next(nextCursor)}
      >
        Next
      </Button>
    </nav>
  );
}

/** Plot observed run spend oldest to newest, with a USD Y scale. */
function SpendChart({
  data,
}: {
  data: Array<{ name: string; spendMicrousd: number }>;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const width = 640;
  const height = 248;
  const left = 96;
  const right = 16;
  const top = 16;
  const bottom = 44;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const observed = data.map((item) => item.spendMicrousd);
  const maximum = Math.max(...observed, 0);
  const scale = maximum > 0 ? maximum : 1_000_000;
  const point = (value: number, index: number) => {
    const x =
      data.length === 1
        ? left + plotWidth / 2
        : left + (index / (data.length - 1)) * plotWidth;
    const y = top + plotHeight - (value / scale) * plotHeight;
    return [x, y] as const;
  };
  const points = data.map((item, index) => point(item.spendMicrousd, index));
  const line = points.map(([x, y]) => `${x},${y}`).join(" ");
  const baseline = top + plotHeight;
  const area = `${left},${baseline} ${line} ${left + plotWidth},${baseline}`;
  const ticks = [0, 0.5, 1].map((ratio) => ({
    ratio,
    y: top + plotHeight - ratio * plotHeight,
    label: formatMoney(ratio * scale),
  }));
  const yAxisCenter = top + plotHeight / 2;
  const activeItem = activeIndex === null ? undefined : data[activeIndex];
  const activePoint = activeIndex === null ? undefined : points[activeIndex];
  const active =
    activeItem && activePoint
      ? {
          item: activeItem,
          x: activePoint[0],
          y: activePoint[1],
        }
      : null;
  const tooltipWidth = 300;
  const tooltipHeight = 52;
  const tooltipX = active
    ? Math.min(
        Math.max(active.x - tooltipWidth / 2, left),
        width - tooltipWidth - right,
      )
    : 0;
  const tooltipY = active
    ? active.y - tooltipHeight - 10 >= top
      ? active.y - tooltipHeight - 10
      : active.y + 10
    : 0;
  return (
    <svg
      className="h-full w-full"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Observed run spend in USD, from oldest run to newest"
    >
      <title>Observed run spend in USD, from oldest run to newest</title>
      <defs>
        <linearGradient id="spend-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      {ticks.map((tick) => (
        <g key={tick.ratio}>
          <line
            x1={left}
            x2={left + plotWidth}
            y1={tick.y}
            y2={tick.y}
            stroke="#1e293b"
            strokeDasharray="4 6"
          />
          <text
            x={left - 8}
            y={tick.y}
            dy="0.35em"
            textAnchor="end"
            className="fill-slate-400"
            fontSize="11"
          >
            {tick.label}
          </text>
        </g>
      ))}
      <line
        x1={left}
        x2={left}
        y1={top}
        y2={baseline}
        stroke="#334155"
        strokeWidth="1.5"
      />
      <line
        x1={left}
        x2={left + plotWidth}
        y1={baseline}
        y2={baseline}
        stroke="#334155"
        strokeWidth="1.5"
      />
      <text
        x={14}
        y={yAxisCenter}
        transform={`rotate(-90 14 ${yAxisCenter})`}
        textAnchor="middle"
        className="fill-slate-400"
        fontSize="12"
      >
        Observed spend (USD)
      </text>
      <text
        x={left + plotWidth / 2}
        y={height - 10}
        textAnchor="middle"
        className="fill-slate-400"
        fontSize="12"
      >
        Runs, oldest to newest
      </text>
      <polygon points={area} fill="url(#spend-gradient)" />
      <polyline
        points={line}
        fill="none"
        stroke="#22d3ee"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map(([x, y], index) => {
        const item = data[index];
        if (!item) return null;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: Each chart point is keyboard-focusable and exposes the same tooltip on focus.
          <g
            key={item.name}
            aria-label={`${item.name} observed spend`}
            className="cursor-help outline-none"
            tabIndex={0}
            onBlur={() => setActiveIndex(null)}
            onFocus={() => setActiveIndex(index)}
            onMouseEnter={() => setActiveIndex(index)}
            onMouseLeave={() => setActiveIndex(null)}
          >
            <circle cx={x} cy={y} r="10" fill="transparent" />
            <circle
              cx={x}
              cy={y}
              r={activeIndex === index ? 6 : 4}
              fill="#67e8f9"
              stroke={activeIndex === index ? "#f8fafc" : "none"}
              strokeWidth={activeIndex === index ? 2 : 0}
            />
            <title>{`${item.name}: ${formatExactMoney(item.spendMicrousd)}`}</title>
          </g>
        );
      })}
      {active ? (
        <g pointerEvents="none">
          <rect
            x={tooltipX}
            y={tooltipY}
            width={tooltipWidth}
            height={tooltipHeight}
            rx="6"
            fill="#0f172a"
            stroke="#334155"
          />
          <text
            x={tooltipX + 10}
            y={tooltipY + 19}
            className="fill-slate-300"
            fontSize="10"
          >
            {active.item.name}
          </text>
          <text
            x={tooltipX + 10}
            y={tooltipY + 39}
            className="fill-slate-100"
            fontSize="12"
            fontWeight="600"
          >
            {`Observed spend: ${formatExactMoney(active.item.spendMicrousd)}`}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function Stat({
  label,
  value,
  note,
  icon: Icon,
  hint,
  status,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Clock3;
  hint?: string;
  status?: string;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            {hint ? <Hint text={hint}>{label}</Hint> : label}
          </p>
          <p className={cn("mt-2 text-2xl font-semibold", statusTextClass(status))}>
            {value}
          </p>
          <p className="mt-1 text-xs text-slate-500">{note}</p>
        </div>
        <span className="rounded-lg bg-cyan-400/10 p-2 text-cyan-300">
          <Icon size={18} />
        </span>
      </div>
    </Card>
  );
}

function InfrastructureCapacityCard({
  capacity,
  pending,
  failed,
}: {
  capacity: NamespaceCapacity | undefined;
  pending: boolean;
  failed: boolean;
}) {
  const limit = capacity?.max_active_jobs;
  const active = capacity?.active_jobs ?? 0;
  const percent =
    typeof limit === "number" && limit > 0 ? Math.min(100, (active / limit) * 100) : 0;
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Gauge size={18} className="text-cyan-300" aria-hidden="true" />
            Job infrastructure
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Control reservations and the latest observed Hugging Face Job states.
          </p>
        </div>
        <Badge status={failed ? "error" : capacity?.configured ? "ready" : "warning"}>
          {failed
            ? "Unavailable"
            : capacity?.configured
              ? "Configured"
              : "Unconfigured"}
        </Badge>
      </div>
      {pending && !capacity ? (
        <p className="mt-6 text-sm text-slate-400">Loading capacity…</p>
      ) : failed || !capacity ? (
        <p className="mt-6 text-sm text-red-300">
          Current infrastructure capacity could not be loaded.
        </p>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-500">
                Reserved slots
              </p>
              <p className="mt-1 text-xl font-semibold text-white">
                {active}/{limit ?? "unconfigured"}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-500">
                Available slots
              </p>
              <p className="mt-1 text-xl font-semibold text-emerald-300">
                {capacity.available_jobs ?? "unconfigured"}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-500">
                Queued launches
              </p>
              <p className="mt-1 text-xl font-semibold text-amber-300">
                {capacity.queued_jobs}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-500">
                Running on HF
              </p>
              <p className="mt-1 text-xl font-semibold text-cyan-300">
                {capacity.observed_running_jobs}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-500">
                Scheduling on HF
              </p>
              <p className="mt-1 text-xl font-semibold text-cyan-300">
                {capacity.observed_scheduling_jobs}
              </p>
            </div>
          </div>
          <div className="mt-5">
            <Progress label="Reserved namespace capacity" value={percent} />
          </div>
          {capacity.runs.length ? (
            <div className="mt-5">
              <h3 className="text-sm font-medium text-white">
                Per-run reservations ({capacity.runs.length})
              </h3>
              <ul className="mt-3 grid gap-2 md:grid-cols-2">
                {capacity.runs.map((run) => (
                  <li
                    className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-3 text-sm"
                    key={run.run_id}
                  >
                    <RunName runId={run.run_id} to={`/runs/${run.run_id}`} />
                    <span className="shrink-0 text-slate-400">
                      {run.active_jobs}/{run.max_active_jobs} reserved,{" "}
                      {run.available_jobs} available
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {capacity.hardware.map((item) => (
              <div
                className="rounded-lg border border-slate-800 bg-slate-950/50 p-4"
                key={item.hardware}
              >
                <p className="font-medium text-white">{humanize(item.hardware)}</p>
                <p className="mt-1 text-sm text-slate-400">
                  {item.active_jobs}/{item.max_active_jobs} reserved,{" "}
                  {item.available_jobs} available
                </p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-5 text-slate-500">
            {capacity.reserved_without_active_observation} reserved slots do not
            currently have a Running or Scheduling observation. Start tokens:{" "}
            {capacity.start_tokens ?? "unconfigured"}/
            {capacity.start_burst ?? "unconfigured"}. Refill:{" "}
            {capacity.start_refill_tokens ?? "unconfigured"} every{" "}
            {capacity.start_refill_period_seconds ?? "unconfigured"} seconds.
          </p>
        </>
      )}
    </Card>
  );
}

export function OverviewPage() {
  const runs = useRuns();
  const endpoints = useEndpoints();
  const system = useSystem();
  const capacity = useInfrastructureCapacity();
  const items = runs.data?.items ?? [];
  const active = items.filter((item) => !runIsFinished(item.status)).length;
  const failures = items.filter((item) =>
    ["failed", "manual_intervention"].includes(item.status),
  ).length;
  const spend = items.reduce((sum, item) => sum + item.observed_microusd, 0);
  const unsafe = (endpoints.data?.items ?? []).filter(
    (item) => !item.cleanup_verified || item.ready_replicas > 0,
  ).length;
  const chart = [...items]
    .reverse()
    .slice(-20)
    .map((item) => ({
      name: item.run_id,
      spendMicrousd: item.observed_microusd,
    }));
  return (
    <QueryContent query={runs}>
      <QueryContent query={endpoints}>
        <QueryContent query={system}>
          <PageHeader
            title="Overview"
            description="Run progress, spend, publication and endpoint safety from the immutable control record."
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Active runs"
              value={String(active)}
              note={`${items.length} total`}
              icon={PlayCircle}
              hint={hints.overview.active}
            />
            <Stat
              label="Policy stops"
              value={String(failures)}
              note="Requires operator review"
              icon={AlertTriangle}
              hint={hints.overview.policyStops}
            />
            <Stat
              label="Observed spend"
              value={formatMoney(spend)}
              note="Across projected runs"
              icon={CircleDollarSign}
              hint={hints.overview.observedSpend}
            />
            <Stat
              label="Unsafe endpoints"
              value={String(unsafe)}
              note={unsafe ? "Cleanup required" : "All observed endpoints safe"}
              icon={ShieldCheck}
              hint={hints.overview.unsafeEndpoints}
            />
          </div>
          <InfrastructureCapacityCard
            capacity={capacity.data}
            failed={capacity.isError}
            pending={capacity.isPending}
          />
          <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
            <Card>
              <h2 className="font-semibold">
                <Hint text={hints.overview.spendChart}>Recent run spend</Hint>
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Observed cost in USD; reserved ceilings remain separate.
              </p>
              <div className="mt-6 h-72">
                {chart.length ? (
                  <SpendChart data={chart} />
                ) : (
                  <div className="grid h-full place-items-center text-sm text-slate-500">
                    No run spend yet
                  </div>
                )}
              </div>
              {items.length > 0 ? (
                <ul className="mt-4 space-y-2 border-t border-slate-800 pt-4">
                  {[...items].slice(0, 8).map((item) => (
                    <li key={item.run_id}>
                      <RunName runId={item.run_id} to={`/runs/${item.run_id}`} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
            <Card>
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Control readiness</h2>
                <Badge status={system.data?.initialization.ready ? "ready" : "pending"}>
                  {system.data?.initialization.ready ? "Ready" : "Initializing"}
                </Badge>
              </div>
              <dl className="mt-5 space-y-4 text-sm">
                <div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">
                      <Hint text={hints.overview.writeMode}>Write mode</Hint>
                    </dt>
                    <dd>{humanize(String(system.data?.write_mode ?? "unknown"))}</dd>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Write mode is a deployment safety switch. User roles are checked
                    separately.
                  </p>
                </div>
                <div>
                  <dt className="text-slate-500">
                    <Hint text={hints.overview.sourceRevision}>Source revision</Hint>
                  </dt>
                  <dd className="mt-1 break-all font-mono text-xs select-all">
                    {String(system.data?.source_revision ?? "unknown")}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">
                    <Hint text={hints.overview.projectedObjects}>
                      Projected objects
                    </Hint>
                  </dt>
                  <dd>{String(system.data?.projection?.object_count ?? 0)}</dd>
                </div>
                <div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">
                      <Hint text={hints.overview.projectionFreshness}>
                        Projection freshness
                      </Hint>
                    </dt>
                    <dd>
                      {system.data?.projection?.last_sync_at
                        ? formatDate(system.data.projection.last_sync_at)
                        : "No successful sync"}
                    </dd>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    The projection is a disposable read view rebuilt from immutable
                    records.
                  </p>
                </div>
              </dl>
            </Card>
          </div>
        </QueryContent>
      </QueryContent>
    </QueryContent>
  );
}

export function RunsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const handoff = useRef<{
    launch: boolean;
    harness: string | undefined;
  } | null>(null);
  if (!handoff.current) {
    handoff.current = {
      launch: searchParams.get("launch") === "1",
      harness: searchParams.get("harness") ?? undefined,
    };
  }
  const navigation = useCursorNavigation();
  const initialHarness = handoff.current.harness;
  const [launching, setLaunching] = useState(handoff.current.launch);
  const query = useRuns(navigation.cursor);
  const { writesAllowed, writeMode } = useControlState();
  const filter = searchParams.get("status") ?? "all";
  useEffect(() => {
    if (!searchParams.has("launch") && !searchParams.has("harness")) return;
    const updated = new URLSearchParams(searchParams);
    updated.delete("launch");
    updated.delete("harness");
    setSearchParams(updated, { replace: true });
  }, [searchParams, setSearchParams]);
  const items = (query.data?.items ?? []).filter(
    (item) => filter === "all" || item.status === filter,
  );
  const columns = useMemo<ColumnDef<RunRow>[]>(
    () => [
      {
        accessorKey: "run_id",
        header: () => <Hint text={hints.run.identity}>Run</Hint>,
        meta: { className: "min-w-0" },
        cell: ({ row }) => (
          <RunName runId={row.original.run_id} to={`/runs/${row.original.run_id}`} />
        ),
      },
      {
        accessorKey: "status",
        header: () => <Hint text={hints.run.status}>State</Hint>,
        cell: ({ row }) => (
          <Badge status={runResultStatus(row.original)}>
            {runStatusLabel(row.original)}
          </Badge>
        ),
      },
      {
        accessorFn: (row) => {
          const recovering = runIsRecovering(row) && row.replacement_assigned_tasks > 0;
          return recovering
            ? `${row.replacement_recorded_tasks}/${row.replacement_assigned_tasks} replacement tasks`
            : `${row.terminal_tasks}/${row.total_tasks} tasks`;
        },
        id: "progress",
        header: () => <Hint text={hints.run.logicalTasks}>Logical progress</Hint>,
        cell: ({ row }) => {
          const recovering =
            runIsRecovering(row.original) &&
            row.original.replacement_assigned_tasks > 0;
          const done = recovering
            ? row.original.replacement_recorded_tasks
            : row.original.terminal_tasks;
          const total = recovering
            ? row.original.replacement_assigned_tasks
            : row.original.total_tasks;
          return (
            <Progress
              label={
                recovering
                  ? `${done}/${total} replacement tasks`
                  : `${row.original.terminal_tasks}/${row.original.total_tasks} tasks`
              }
              value={total ? (done / total) * 100 : 0}
            />
          );
        },
      },
      {
        accessorKey: "observed_microusd",
        header: () => <Hint text={hints.run.observedCost}>Observed</Hint>,
        cell: ({ getValue }) => formatMoney(Number(getValue())),
      },
      {
        accessorKey: "ceiling_microusd",
        header: () => <Hint text={hints.launch.hardCeiling}>Ceiling</Hint>,
        cell: ({ getValue }) => formatMoney(Number(getValue())),
      },
      {
        accessorKey: "created_at",
        header: () => <Hint text={hints.audit.time}>Created</Hint>,
        cell: ({ getValue }) => formatDate(String(getValue())),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Runs"
        description="Each run locks a benchmark, model, harness, reasoning, and cost ceiling. Logical tasks stay sealed; only infrastructure failures can be replaced."
        action={
          <Button
            disabled={!writesAllowed}
            title={
              writesAllowed
                ? "Start a run"
                : `Launch is unavailable while write mode is ${writeMode}`
            }
            onClick={() => setLaunching((value) => !value)}
          >
            <Plus size={16} />
            Start a run
          </Button>
        }
      />
      {launching ? (
        <NewRunPanel
          {...(initialHarness ? { initialHarness } : {})}
          onClose={() => setLaunching(false)}
        />
      ) : null}
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter runs">
        {["all", "active", "cancelling", "publishing", "completed", "cancelled"].map(
          (status) => (
            <Button
              key={status}
              variant={filter === status ? "secondary" : "ghost"}
              onClick={() => setSearchParams(status === "all" ? {} : { status })}
            >
              {humanize(status)}
            </Button>
          ),
        )}
      </nav>
      <QueryContent query={query}>
        <DataTable columns={columns} data={items} empty="No runs match this filter" />
        <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
      </QueryContent>
    </>
  );
}

export function RunPage() {
  const { runId = "" } = useParams();
  const run = useRun(runId);
  const capacity = useCapacity(runId);
  const tasks = useTasks(runId);
  const client = useQueryClient();
  const { writesAllowed, writeMode } = useControlState();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelAcknowledged, setCancelAcknowledged] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const closeCancel = () => {
    setCancelOpen(false);
    setCancelAcknowledged(false);
  };
  const closeRetry = () => setRetryOpen(false);
  const cancel = useMutation({
    mutationFn: () =>
      actOnRun(runId, {
        action: "cancel",
        task_id: null,
        reason: "operator cancellation",
        confirmed: true,
      } as RunAction),
    onSuccess: () => {
      closeCancel();
      return client.invalidateQueries({ queryKey: keys.run(runId) });
    },
  });
  const retryInfrastructure = useMutation({
    mutationFn: () =>
      actOnRun(runId, {
        action: "retry_infrastructure",
        task_id: null,
        reason: "retry eligible infrastructure failures",
        confirmed: true,
      } as RunAction),
    onSuccess: () => {
      closeRetry();
      return client.invalidateQueries({ queryKey: keys.run(runId) });
    },
  });
  if (!run.data)
    return (
      <QueryContent query={run}>
        <Empty>Run not found</Empty>
      </QueryContent>
    );
  const item = run.data;
  const columns: ColumnDef<TaskRow>[] = [
    {
      accessorKey: "task_id",
      header: () => <Hint text={hints.run.logicalTasks}>Task</Hint>,
      cell: ({ row }) => (
        <Link
          className="font-mono text-xs text-cyan-300 hover:underline"
          to={`/runs/${runId}/tasks/${row.original.task_id}`}
        >
          {shortId(row.original.task_id)}
        </Link>
      ),
    },
    {
      accessorKey: "terminal_outcome",
      header: () => <Hint text={hints.run.outcome}>Outcome</Hint>,
      cell: ({ getValue }) => (
        <OutcomeBadge outcome={String(getValue() ?? "pending")} />
      ),
    },
    {
      accessorKey: "selected_attempt_id",
      header: () => <Hint text={hints.run.selectedAttempt}>Selected attempt</Hint>,
      cell: ({ getValue }) => (
        <span className="font-mono text-xs">
          {getValue() ? shortId(String(getValue())) : "—"}
        </span>
      ),
    },
    {
      accessorKey: "input_digest",
      header: () => <Hint text={hints.run.inputDigest}>Input</Hint>,
      cell: ({ getValue }) => (
        <span className="font-mono text-xs text-slate-500">
          {shortId(String(getValue()))}
        </span>
      ),
    },
  ];
  return (
    <QueryContent query={run}>
      <PageHeader
        title={runId}
        titleClassName="break-all font-mono text-lg sm:text-xl"
        description="Run lock, logical outcomes, cost and publication state."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!writesAllowed || retryInfrastructure.isPending}
              title={
                writesAllowed
                  ? "Retry eligible infrastructure failures"
                  : `Retry is unavailable while write mode is ${writeMode}`
              }
              onClick={() => setRetryOpen(true)}
            >
              <RefreshCw size={16} />
              Retry infrastructure failures
            </Button>
            {!runIsFinished(item.status) &&
            item.status !== "publishing" &&
            !item.cancellation_requested ? (
              <Button
                variant="destructive"
                disabled={!writesAllowed || cancel.isPending}
                title={
                  writesAllowed
                    ? "Cancel this run"
                    : `Cancellation is unavailable while write mode is ${writeMode}`
                }
                onClick={() => setCancelOpen(true)}
              >
                <PauseCircle size={16} />
                Cancel run
              </Button>
            ) : null}
          </div>
        }
      />
      {retryOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
          <Card
            className="w-full max-w-lg border-cyan-500/40"
            role="dialog"
            aria-modal="true"
            aria-labelledby="retry-infra-title"
            aria-describedby="retry-infra-effect"
          >
            <h2 id="retry-infra-title" className="text-lg font-semibold text-white">
              Retry infrastructure failures?
            </h2>
            <p id="retry-infra-effect" className="mt-2 text-sm text-slate-300">
              This queues replacement Jobs only for eligible infrastructure failures.
              Scored misses and other sealed outcomes stay sealed.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={closeRetry}
                disabled={retryInfrastructure.isPending}
              >
                Keep sealed
              </Button>
              <Button
                disabled={!writesAllowed || retryInfrastructure.isPending}
                onClick={() => retryInfrastructure.mutate()}
              >
                {retryInfrastructure.isPending ? "Retrying…" : "Confirm retry"}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
      {cancelOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
          <Card
            className="w-full max-w-lg border-rose-500/40"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-run-title"
            aria-describedby="cancel-run-effect"
          >
            <h2 id="cancel-run-title" className="text-lg font-semibold text-white">
              Cancel run?
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Target <span className="break-all font-mono text-xs">{runId}</span> has{" "}
              {item.total_tasks - item.terminal_tasks} open logical tasks.
            </p>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">Observed</dt>
                <dd>{formatMoney(item.observed_microusd)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Reserved</dt>
                <dd>{formatMoney(item.reserved_microusd)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Ceiling</dt>
                <dd>{formatMoney(item.ceiling_microusd)}</dd>
              </div>
            </dl>
            <p id="cancel-run-effect" className="mt-4 text-sm text-slate-300">
              This stops or observes active remote Jobs, prevents queued launches, and
              seals open tasks as cancelled. Evidence is retained, and publication still
              waits for endpoint cleanup.
            </p>
            <label className="mt-4 flex items-start gap-3 text-sm text-slate-200">
              <input
                className="mt-1 h-4 w-4 accent-rose-500"
                type="checkbox"
                checked={cancelAcknowledged}
                onChange={(event) => setCancelAcknowledged(event.target.checked)}
              />
              I understand this cancellation cannot reopen sealed logical tasks.
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={closeCancel} disabled={cancel.isPending}>
                Keep running
              </Button>
              <Button
                variant="destructive"
                disabled={!writesAllowed || !cancelAcknowledged || cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                {cancel.isPending ? "Cancelling…" : "Confirm cancellation"}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Status"
          value={runStatusLabel(item)}
          note={runStatusNote(item)}
          icon={RefreshCw}
          hint={hints.run.status}
          status={runResultStatus(item)}
        />
        <Stat
          label="Logical tasks"
          value={`${item.terminal_tasks}/${item.total_tasks}`}
          note={`${item.admissible_tasks} valid, ${item.exhausted_tasks} exhausted, ${item.pending_actions} pending actions`}
          icon={Clock3}
          hint={hints.run.logicalTasks}
        />
        <Stat
          label="Observed cost"
          value={formatMoney(item.observed_microusd)}
          note={`All recorded run sources. ${formatMoney(item.reserved_microusd)} reserved`}
          icon={CircleDollarSign}
          hint={hints.run.observedCost}
        />
        <Stat
          label="Endpoint cleanup"
          value={item.cleanup_pending ? "Pending" : "Clear"}
          note="Required before completion"
          icon={ShieldCheck}
          hint={hints.run.endpointCleanup}
        />
      </div>
      {runIsRecovering(item) ? (
        <ReplacementProgress run={item} capacity={capacity.data} />
      ) : null}
      {item.invalid_selected_tasks > 0 || item.exhausted_tasks > 0 ? (
        <Card className="my-6 border-amber-800 bg-amber-950/30">
          <p className="text-sm text-amber-200">
            This run cannot publish a valid result. It has {item.invalid_selected_tasks}{" "}
            invalid selected attempts and {item.exhausted_tasks} exhausted tasks.
          </p>
        </Card>
      ) : null}
      <RunJobs runId={runId} />
      <Card className="my-6">
        <Progress
          label="Terminal logical outcomes"
          value={item.total_tasks ? (item.terminal_tasks / item.total_tasks) * 100 : 0}
        />
      </Card>
      {capacity.data ? (
        <Card className="my-6">
          <h2 className="text-base font-semibold text-white">Job capacity</h2>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-slate-500">Run slots</dt>
              <dd className="mt-1">
                {capacity.data.run_active}/{capacity.data.run_limit} reserved,{" "}
                {Math.max(0, capacity.data.run_limit - capacity.data.run_active)}{" "}
                available
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Namespace slots</dt>
              <dd className="mt-1">
                {capacity.data.namespace_active}/
                {capacity.data.namespace_limit ?? "unconfigured"} reserved
                {capacity.data.namespace_limit === null
                  ? ""
                  : `, ${Math.max(
                      0,
                      capacity.data.namespace_limit - capacity.data.namespace_active,
                    )} available`}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Hardware slots</dt>
              <dd className="mt-1">
                {capacity.data.hardware_active}/
                {capacity.data.hardware_limit ?? "unconfigured"} reserved
                {capacity.data.hardware_limit === null
                  ? ""
                  : `, ${Math.max(
                      0,
                      capacity.data.hardware_limit - capacity.data.hardware_active,
                    )} available`}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Start tokens</dt>
              <dd className="mt-1">
                {capacity.data.start_tokens ?? "unconfigured"}/
                {capacity.data.start_burst ?? "unconfigured"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Queued launches</dt>
              <dd className="mt-1">{capacity.data.queued}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-slate-500">Current limit</dt>
              <dd className="mt-1">
                {capacity.data.limiting_factor
                  ? humanize(capacity.data.limiting_factor)
                  : "None"}
              </dd>
            </div>
          </dl>
        </Card>
      ) : null}
      <section className="mt-8">
        <h2 className="text-lg font-semibold text-white">
          <Hint text={hints.run.logicalTasks}>Logical benchmark tasks</Hint>
        </h2>
        <p className="mb-4 mt-1 text-sm text-slate-400">
          One row per locked logical trial. Infrastructure failures may create multiple
          physical Job attempts, but only one valid attempt can become the selected
          result.
        </p>
        <QueryContent query={tasks}>
          {runIsRecovering(item) ? (
            <p className="mb-3 text-sm text-slate-400">
              Outcome is the selected seal. A replacement Job can be assigned to a row
              that still shows Infrastructure.
            </p>
          ) : null}
          <DataTable
            columns={columns}
            data={tasks.data?.items ?? []}
            empty="No tasks are locked"
          />
        </QueryContent>
      </section>
    </QueryContent>
  );
}

export function TaskPage() {
  const { runId = "", taskId = "" } = useParams();
  const detail = useTask(runId, taskId);
  if (!detail.data)
    return (
      <QueryContent query={detail}>
        <Empty>Task not found</Empty>
      </QueryContent>
    );
  return (
    <QueryContent query={detail}>
      <PageHeader
        title={shortId(taskId)}
        description="One logical trial can have multiple physical Job attempts. Every attempt stays visible, but only one valid result can be selected."
      />
      <Card>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">
              <Hint text={hints.run.outcome}>Outcome</Hint>
            </dt>
            <dd className="mt-1">
              <OutcomeBadge outcome={detail.data.task.terminal_outcome} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">
              <Hint text={hints.run.selectedAttempt}>Selected attempt</Hint>
            </dt>
            <dd className="mt-1 font-mono text-xs">
              {detail.data.task.selected_attempt_id ?? "—"}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-slate-500">
              <Hint text={hints.run.inputDigest}>Input digest</Hint>
            </dt>
            <dd className="mt-1 break-all font-mono text-xs">
              {detail.data.task.input_digest}
            </dd>
          </div>
        </dl>
      </Card>
      <div className="mt-6 space-y-4">
        {detail.data.attempts.map((attempt, index) => (
          <Card key={attempt.attempt_id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-500">
                  Attempt {index + 1}
                </p>
                <p className="mt-1 font-mono text-sm">{attempt.attempt_id}</p>
              </div>
              <div className="flex items-center gap-2">
                {detail.data.task.selected_attempt_id === attempt.attempt_id ? (
                  <Badge status="ready">Selected result</Badge>
                ) : null}
                <OutcomeBadge outcome={attempt.outcome} />
              </div>
            </div>
            <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
              <div className="sm:col-span-3">
                <dt className="text-slate-500">
                  {attempt.physical_job ? (
                    <Hint text={hints.run.launchAction}>job.launch action</Hint>
                  ) : (
                    "Source action"
                  )}
                </dt>
                <dd className="mt-1 break-all font-mono text-xs">
                  {attempt.action_id}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-slate-500">
                  <Hint text={hints.run.physicalJob}>Physical HF Job</Hint>
                </dt>
                <dd className="mt-1">
                  {attempt.physical_job?.resource_id ? (
                    attempt.physical_job.inspect_url ? (
                      <a
                        className="inline-flex items-center gap-1 break-all font-mono text-xs text-cyan-300 hover:underline"
                        href={attempt.physical_job.inspect_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {attempt.physical_job.resource_id}
                        <ExternalLink size={12} />
                      </a>
                    ) : (
                      <span className="break-all font-mono text-xs">
                        {attempt.physical_job.resource_id}
                      </span>
                    )
                  ) : (
                    <span className="text-slate-500">Not projected</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  <Hint text={hints.run.physicalJobStatus}>Job status</Hint>
                </dt>
                <dd className="mt-1">
                  {attempt.physical_job?.observed_state ? (
                    <Badge status={attempt.physical_job.observed_state.toLowerCase()}>
                      {humanize(attempt.physical_job.observed_state)}
                    </Badge>
                  ) : (
                    <span className="text-slate-500">Not observed</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  <Hint text={hints.run.replacementEligible}>Replacement eligible</Hint>
                </dt>
                <dd>{attempt.replacement_eligible ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  <Hint text={hints.run.attemptCost}>Cost</Hint>
                </dt>
                <dd>{formatMoney(attempt.cost_microusd)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  <Hint text={hints.run.attemptRecorded}>Recorded</Hint>
                </dt>
                <dd>{formatDate(attempt.created_at)}</dd>
              </div>
              <div className="sm:col-span-3">
                <dt className="text-slate-500">
                  <Hint text={hints.run.attemptMetrics}>Metrics</Hint>
                </dt>
                <dd className="mt-1 flex flex-wrap gap-2">
                  {Object.entries(attempt.metrics).length ? (
                    Object.entries(attempt.metrics).map(([name, value]) => (
                      <Badge key={name}>{`${name}: ${value}`}</Badge>
                    ))
                  ) : (
                    <span className="text-slate-500">No metrics</span>
                  )}
                </dd>
              </div>
            </dl>
          </Card>
        ))}
      </div>
    </QueryContent>
  );
}

export function JobsPage() {
  const navigation = useCursorNavigation();
  const query = useJobs(navigation.cursor);
  return (
    <>
      <PageHeader
        title="Jobs"
        description="Current HF Job identity, ownership, latest observed state, and recorded hardware cost."
      />
      <QueryContent query={query}>
        <DataTable columns={jobColumns(true)} data={query.data?.items ?? []} />
        <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
      </QueryContent>
    </>
  );
}

export function EndpointsPage() {
  const navigation = useCursorNavigation();
  const query = useEndpoints(navigation.cursor);
  const columns: ColumnDef<EndpointRow>[] = [
    {
      accessorKey: "endpoint_id",
      header: () => <Hint text={hints.endpoints.endpoint}>Endpoint</Hint>,
      cell: ({ getValue }) => (
        <span className="font-mono text-xs">{shortId(String(getValue()))}</span>
      ),
    },
    {
      accessorKey: "run_id",
      header: () => <Hint text={hints.endpoints.run}>Run</Hint>,
      meta: { className: "min-w-0" },
      cell: ({ getValue }) => (
        <RunName runId={String(getValue())} to={`/runs/${String(getValue())}`} />
      ),
    },
    {
      accessorKey: "desired_state",
      header: () => <Hint text={hints.endpoints.desired}>Desired</Hint>,
      cell: ({ getValue }) => humanize(String(getValue())),
    },
    {
      accessorKey: "observed_state",
      header: () => <Hint text={hints.endpoints.observed}>Observed</Hint>,
      cell: ({ getValue }) => (
        <Badge status={String(getValue()).toLowerCase()}>
          {humanize(String(getValue()))}
        </Badge>
      ),
    },
    {
      accessorKey: "ready_replicas",
      header: () => <Hint text={hints.endpoints.readyReplicas}>Ready replicas</Hint>,
    },
    {
      accessorKey: "cleanup_verified",
      header: () => <Hint text={hints.endpoints.cleanup}>Cleanup</Hint>,
      cell: ({ getValue }) =>
        Number(getValue()) ? (
          <Badge status="ready">Verified</Badge>
        ) : (
          <Badge status="pending">Pending</Badge>
        ),
    },
    {
      accessorKey: "active_hourly_cost_microusd",
      header: () => <Hint text={hints.endpoints.hourly}>Active hourly cost</Hint>,
      cell: ({ getValue }) => formatMoney(Number(getValue())),
    },
  ];
  return (
    <>
      <PageHeader
        title="Endpoints"
        description="Requested and observed state remain separate. Completion requires verified pause with zero ready replicas."
      />
      <QueryContent query={query}>
        <DataTable columns={columns} data={query.data?.items ?? []} />
        <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
      </QueryContent>
    </>
  );
}

export function ResultsPage() {
  const navigation = useCursorNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = {
    model: searchParams.get("model") ?? undefined,
    benchmark: searchParams.get("benchmark") ?? undefined,
    agent: searchParams.get("agent") ?? undefined,
    status: searchParams.get("result_status") ?? undefined,
    search: searchParams.get("search") ?? undefined,
    published_after: searchParams.get("published_after") ?? undefined,
    published_before: searchParams.get("published_before") ?? undefined,
    sort: (searchParams.get("sort") ?? "published_at") as
      | "published_at"
      | "model"
      | "benchmark"
      | "status"
      | "score",
    order: (searchParams.get("order") ?? "desc") as "asc" | "desc",
  };
  const query = useResults(navigation.cursor, filters);
  const columns: ColumnDef<ResultRow>[] = [
    {
      accessorKey: "run_id",
      header: () => <Hint text={hints.run.identity}>Run</Hint>,
      meta: { className: "min-w-0" },
      cell: ({ row }) => (
        <RunName runId={row.original.run_id} to={`/runs/${row.original.run_id}`} />
      ),
    },
    {
      accessorKey: "model",
      header: () => (
        <Hint text={hints.results.modelBenchmark}>Model and benchmark</Hint>
      ),
      cell: ({ row }) => (
        <Link
          className="block text-cyan-300 hover:underline"
          to={`/results/${row.original.publication_id}`}
        >
          <div className="max-w-52 truncate font-medium">
            {String(row.original.model ?? "—")}
          </div>
          <div className="max-w-52 truncate text-xs text-slate-500">
            {String(row.original.benchmark ?? "")}
          </div>
        </Link>
      ),
    },
    {
      accessorKey: "agent",
      header: () => <Hint text={hints.results.agent}>Agent</Hint>,
      cell: ({ row }) => labeledHarness(row.original.agent ?? row.original.harness),
    },
    {
      accessorFn: (row) =>
        row.primary_metric
          ? `${row.primary_metric.value.toFixed(4)} ${row.primary_metric.unit}`
          : "—",
      id: "score",
      header: () => <Hint text={hints.results.primaryMetric}>Primary metric</Hint>,
      cell: ({ row }) => {
        const metric = row.original.primary_metric;
        return metric ? `${metric.value.toFixed(4)} ${metric.unit}` : "—";
      },
    },
    {
      accessorFn: (row) => formatPassRate(row),
      id: "pass_rate",
      header: () => <Hint text={hints.results.passRate}>Pass rate</Hint>,
      cell: ({ row }) => formatPassRate(row.original),
    },
    {
      accessorFn: (row) =>
        row.inference_cost_microusd === null ||
        row.inference_cost_microusd === undefined
          ? "—"
          : formatMoney(row.inference_cost_microusd),
      id: "inference_cost",
      header: () => <Hint text={hints.results.tokenCost}>Token cost</Hint>,
      cell: ({ row }) =>
        row.original.inference_cost_microusd === null ||
        row.original.inference_cost_microusd === undefined
          ? "—"
          : formatMoney(row.original.inference_cost_microusd),
    },
    {
      accessorKey: "status",
      header: () => <Hint text={hints.results.state}>State</Hint>,
      cell: ({ getValue }) => (
        <Badge status={String(getValue())}>{humanize(String(getValue()))}</Badge>
      ),
    },
    {
      accessorKey: "published_at",
      header: () => <Hint text={hints.results.published}>Published</Hint>,
      cell: ({ getValue }) => formatDate(String(getValue())),
    },
  ];
  return (
    <>
      <PageHeader
        title="Results"
        description="Published catalog scores after every logical task is sealed. Open a model for pass rate CIs, publication identity, and the Hugging Face Bucket prefix."
      />
      <form
        className="mb-5 grid gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4 sm:grid-cols-2 xl:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const next = new URLSearchParams();
          for (const key of [
            "search",
            "model",
            "benchmark",
            "agent",
            "result_status",
            "sort",
            "order",
          ] as const) {
            const value = String(data.get(key) ?? "").trim();
            if (
              value &&
              !(
                (key === "sort" && value === "published_at") ||
                (key === "order" && value === "desc")
              )
            )
              next.set(key, value);
          }
          const after = String(data.get("published_after") ?? "");
          const before = String(data.get("published_before") ?? "");
          if (after) next.set("published_after", `${after}T00:00:00.000Z`);
          if (before) next.set("published_before", `${before}T23:59:59.999Z`);
          setSearchParams(next);
        }}
      >
        {(["search", "model", "benchmark", "agent"] as const).map((name) => (
          <label className="space-y-1 text-sm" key={name}>
            <span className="text-slate-400">
              <Hint text={hints.results[name]}>{humanize(name)}</Hint>
            </span>
            <input
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
              name={name}
              defaultValue={searchParams.get(name) ?? ""}
              type={name === "search" ? "search" : "text"}
            />
          </label>
        ))}
        <label className="space-y-1 text-sm">
          <span className="text-slate-400">
            <Hint text={hints.results.status}>Status</Hint>
          </span>
          <select
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
            name="result_status"
            defaultValue={filters.status ?? ""}
          >
            <option value="">All</option>
            <option value="published">Published</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-400">
            <Hint text={hints.results.fromDate}>From date</Hint>
          </span>
          <input
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
            name="published_after"
            type="date"
            defaultValue={filters.published_after?.slice(0, 10) ?? ""}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-400">
            <Hint text={hints.results.throughDate}>Through date</Hint>
          </span>
          <input
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
            name="published_before"
            type="date"
            defaultValue={filters.published_before?.slice(0, 10) ?? ""}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-400">
              <Hint text={hints.results.sort}>Sort</Hint>
            </span>
            <select
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
              name="sort"
              defaultValue={filters.sort}
            >
              <option value="published_at">Published</option>
              <option value="score">Score</option>
              <option value="model">Model</option>
              <option value="benchmark">Benchmark</option>
              <option value="status">Status</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-400">
              <Hint text={hints.results.order}>Order</Hint>
            </span>
            <select
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
              name="order"
              defaultValue={filters.order}
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </label>
        </div>
        <div className="flex items-end gap-2 sm:col-span-2 xl:col-span-4">
          <Button type="submit">Apply filters</Button>
          <Button type="button" variant="ghost" onClick={() => setSearchParams({})}>
            Clear
          </Button>
        </div>
      </form>
      <QueryContent query={query}>
        <DataTable
          columns={columns}
          data={query.data?.items ?? []}
          empty="No results match these filters"
        />
        <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
      </QueryContent>
    </>
  );
}

function ResultField({
  label,
  value,
  hint,
}: {
  label: string;
  value: unknown;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-slate-500">
        {hint ? <Hint text={hint}>{label}</Hint> : label}
      </dt>
      <dd className="mt-1 break-all">
        {value === null || value === undefined || value === "" ? "—" : String(value)}
      </dd>
    </div>
  );
}

function formatPassRate(item: {
  pass_rate?: number | null;
  pass_rate_ci95?: { low: number; high: number } | null;
}): string {
  if (item.pass_rate === null || item.pass_rate === undefined) return "—";
  const rate = formatPercent(item.pass_rate);
  return item.pass_rate_ci95
    ? `${rate} (${formatPercentInterval(item.pass_rate_ci95)})`
    : rate;
}

function BucketOutputsLink({
  item,
}: {
  item: {
    outputs_url?: string | null;
    outputs_prefix?: string | null;
    hf_uri?: string | null;
  };
}) {
  if (!item.outputs_url) return <span className="text-slate-500">—</span>;
  return (
    <a
      className="inline-flex max-w-64 items-center gap-1 font-mono text-xs text-cyan-300 hover:underline"
      href={item.outputs_url}
      rel="noreferrer"
      target="_blank"
    >
      <span className="truncate">{item.outputs_prefix ?? "Open Bucket"}</span>
      <ExternalLink size={12} aria-hidden="true" />
      <span className="sr-only">Open Hugging Face Bucket outputs</span>
    </a>
  );
}

export function ResultPage() {
  const { publicationId = "" } = useParams();
  const result = useResult(publicationId);
  if (!result.data)
    return (
      <QueryContent query={result}>
        <Empty>Result not found</Empty>
      </QueryContent>
    );
  const item: ResultDetail = result.data;
  const taskColumns: ColumnDef<ResultTask>[] = [
    {
      accessorKey: "task_id",
      header: () => <Hint text={hints.results.taskId}>Task</Hint>,
      cell: ({ row }) => (
        <Link
          className="font-mono text-xs text-cyan-300 hover:underline"
          to={`/runs/${item.run_id}/tasks/${row.original.task_id}`}
        >
          {row.original.task_id}
        </Link>
      ),
    },
    {
      accessorKey: "outcome",
      header: () => <Hint text={hints.results.taskOutcome}>Outcome</Hint>,
      cell: ({ getValue }) => <OutcomeBadge outcome={String(getValue())} />,
    },
    {
      accessorKey: "reward",
      header: () => <Hint text={hints.results.taskReward}>Reward</Hint>,
      cell: ({ getValue }) => {
        const value = getValue();
        return value === null || value === undefined ? "—" : Number(value).toFixed(2);
      },
    },
    {
      accessorKey: "cost_microusd",
      header: () => <Hint text={hints.results.taskCost}>Token cost</Hint>,
      cell: ({ row }) => formatMoney(row.original.cost_microusd),
    },
    {
      accessorFn: (row) =>
        `${formatTokens(row.input_tokens)} in / ${formatTokens(row.output_tokens)} out`,
      id: "tokens",
      header: () => <Hint text={hints.results.taskTokens}>Tokens</Hint>,
      cell: ({ row }) =>
        `${formatTokens(row.original.input_tokens)} in / ${formatTokens(row.original.output_tokens)} out`,
    },
  ];
  return (
    <QueryContent query={result}>
      <PageHeader
        title={shortId(item.publication_id)}
        description="Published pass rate, 95% confidence intervals, token cost, and the Bucket prefix for generated result objects."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Stat
          label="Pass rate"
          value={
            item.pass_rate === null || item.pass_rate === undefined
              ? "—"
              : formatPercent(item.pass_rate)
          }
          note={
            item.pass_rate_ci95
              ? `${item.pass_count ?? 0}/${item.task_count ?? 0} complete. 95% CI ${formatPercentInterval(item.pass_rate_ci95)}`
              : `${item.pass_count ?? 0}/${item.task_count ?? 0} complete`
          }
          icon={Percent}
          hint={hints.results.passRate}
        />
        <Stat
          label="Primary metric"
          value={item.primary_metric ? item.primary_metric.value.toFixed(4) : "—"}
          note={
            item.primary_metric
              ? `${item.primary_metric.name} (${item.primary_metric.unit})`
              : "No score"
          }
          icon={Gauge}
          hint={hints.results.primaryMetric}
        />
        <Stat
          label="Token cost"
          value={
            item.inference_cost_microusd === null ||
            item.inference_cost_microusd === undefined
              ? "—"
              : formatMoney(item.inference_cost_microusd)
          }
          note={tokenCostNote(item)}
          icon={CircleDollarSign}
          hint={hints.results.tokenCost}
        />
        <Stat
          label="Observed cost"
          value={
            item.observed_cost_microusd === null ||
            item.observed_cost_microusd === undefined
              ? "—"
              : formatMoney(item.observed_cost_microusd)
          }
          note="Attempt receipts plus recorded physical Job hardware"
          icon={CircleDollarSign}
          hint={hints.results.observedCost}
        />
        <Stat
          label="Scored tasks"
          value={`${item.scored_task_count ?? 0}/${item.task_count ?? 0}`}
          note={`${item.strict_pass_count ?? 0} strict passes`}
          icon={ShieldCheck}
          hint={hints.results.scoredTasks}
        />
        <Stat
          label="Published"
          value={formatDate(item.published_at)}
          note={item.publication_role ? humanize(item.publication_role) : "No role"}
          icon={Clock3}
          hint={hints.results.published}
        />
      </div>
      <Card className="mt-6">
        <h2 className="font-semibold">Bucket outputs</h2>
        <p className="mt-1 text-sm text-slate-500">
          Normalized Parquet tables, the publication receipt, and catalog objects live
          under this prefix in the canonical artifact Bucket. The browser has no Bucket
          credential. The Hub page uses your Hugging Face login.
        </p>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">
              <Hint text={hints.results.outputs}>Hub path</Hint>
            </dt>
            <dd className="mt-1">
              <BucketOutputsLink item={item} />
            </dd>
          </div>
          <ResultField label="hf URI" value={item.hf_uri} hint={hints.results.hfUri} />
          <ResultField label="Result record path" value={item.result_path} />
        </dl>
      </Card>
      <Card className="mt-6">
        <h2 className="font-semibold">Result</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <ResultField label="Model" value={item.model} />
          <ResultField label="Benchmark" value={item.benchmark} />
          <ResultField
            label="Agent"
            value={labeledHarness(item.agent ?? item.harness)}
          />
          <ResultField label="Outcome" value={item.run_outcome} />
          <ResultField label="Quality" value={item.quality} />
          <ResultField label="Status" value={item.status} />
          <ResultField
            label="Superseded by"
            value={item.superseded_by_publication_id}
          />
          <ResultField label="Model revision" value={item.model_revision} />
          <ResultField label="Benchmark revision" value={item.benchmark_revision} />
          <ResultField label="Harness revision" value={item.harness_revision} />
          <div>
            <dt className="text-slate-500">Run</dt>
            <dd className="mt-1">
              <RunName runId={item.run_id} to={`/runs/${item.run_id}`} />
            </dd>
          </div>
        </dl>
      </Card>
      <Card className="mt-6">
        <h2 className="font-semibold">Selected tasks</h2>
        <p className="mt-1 text-sm text-slate-500">
          One sealed attempt per locked task. Token cost is the inference receipt for
          that attempt, not Job hardware.
        </p>
        <div className="mt-4">
          <DataTable
            columns={taskColumns}
            data={item.tasks ?? []}
            empty="No selected attempt metrics are projected for this publication"
          />
        </div>
      </Card>
      <Card className="mt-6">
        <h2 className="font-semibold">Allowlisted provenance</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <ResultField label="Publication ID" value={item.publication_id} />
          <ResultField label="Run ID" value={item.run_id} />
          <ResultField label="Catalog digest" value={item.catalog_digest} />
          <ResultField
            label="Catalog source digest"
            value={item.catalog_source_digest}
          />
          <ResultField label="Profile source revision" value={item.source_revision} />
          {Object.entries(item.profile_ids ?? {}).map(([kind, id]) => (
            <ResultField key={kind} label={`${humanize(kind)} profile ID`} value={id} />
          ))}
        </dl>
      </Card>
    </QueryContent>
  );
}

function tokenCostNote(item: ResultDetail): string {
  const tokens = `${formatTokens(item.input_tokens)} in / ${formatTokens(item.output_tokens)} out`;
  if (
    item.mean_task_cost_microusd === null ||
    item.mean_task_cost_microusd === undefined
  )
    return tokens;
  const mean = `Mean ${formatMoney(item.mean_task_cost_microusd)} / task`;
  return item.task_cost_ci95
    ? `${tokens}. ${mean}. 95% CI ${formatMoney(item.task_cost_ci95.low)}–${formatMoney(item.task_cost_ci95.high)}`
    : `${tokens}. ${mean}`;
}

export function ProfilesPage() {
  const navigation = useCursorNavigation();
  const query = useProfiles(navigation.cursor);
  const columns: ColumnDef<ProfileRow>[] = [
    {
      accessorKey: "name",
      header: () => <Hint text={hints.profiles.name}>Name</Hint>,
      cell: ({ row }) => (
        <div>
          <div className="font-medium">
            {row.original.profile_kind === "harness"
              ? labeledHarness(
                  typeof row.original.spec.agent === "string"
                    ? row.original.spec.agent
                    : row.original.name,
                )
              : row.original.name}
          </div>
          <div className="font-mono text-xs text-slate-500">
            {shortId(row.original.profile_id)}
          </div>
        </div>
      ),
    },
    {
      accessorKey: "profile_kind",
      header: () => <Hint text={hints.profiles.kind}>Kind</Hint>,
      cell: ({ getValue }) => humanize(String(getValue())),
    },
    {
      accessorKey: "source",
      header: () => <Hint text={hints.profiles.source}>Source</Hint>,
      cell: ({ getValue }) => <Badge>{humanize(String(getValue()))}</Badge>,
    },
    {
      accessorKey: "promotion_state",
      header: () => <Hint text={hints.profiles.approval}>Approval</Hint>,
      cell: ({ getValue }) => (
        <Badge status={String(getValue() ?? "built-in")}>
          {humanize(String(getValue() ?? "built-in"))}
        </Badge>
      ),
    },
    {
      accessorKey: "approved_aliases",
      header: () => <Hint text={hints.profiles.aliases}>Approved aliases</Hint>,
      cell: ({ row }) => row.original.approved_aliases.join(", ") || "—",
    },
  ];
  return (
    <>
      <PageHeader
        title="Profiles"
        description="Resolved, immutable benchmark, model, harness, deployment and launch-policy records."
      />
      <QueryContent query={query}>
        <DataTable columns={columns} data={query.data?.items ?? []} />
        <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
      </QueryContent>
    </>
  );
}

export function AuditPage() {
  const navigation = useCursorNavigation();
  const query = useAudit(navigation.cursor);
  const columns: ColumnDef<AuditRow>[] = [
    {
      accessorKey: "occurred_at",
      header: () => <Hint text={hints.audit.time}>Time</Hint>,
      cell: ({ getValue }) => formatDate(String(getValue())),
    },
    {
      accessorKey: "type",
      header: () => <Hint text={hints.audit.record}>Record</Hint>,
      cell: ({ getValue }) => <Badge>{humanize(String(getValue()))}</Badge>,
    },
    {
      accessorFn: (row) => {
        const runId = row.data.run_id;
        return typeof runId === "string" ? runId : String(row.data.record_id ?? row.id);
      },
      id: "record_id",
      header: () => <Hint text={hints.audit.identity}>Identity</Hint>,
      meta: { className: "min-w-0" },
      cell: ({ row }) => {
        const runId = row.original.data.run_id;
        if (typeof runId === "string")
          return <RunName runId={runId} to={`/runs/${runId}`} />;
        return (
          <span className="font-mono text-xs">
            {shortId(String(row.original.data.record_id ?? row.original.id))}
          </span>
        );
      },
    },
    {
      accessorFn: (row) => String(row.data.digest ?? "—"),
      id: "digest",
      header: () => <Hint text={hints.audit.digest}>Digest</Hint>,
      cell: ({ row }) => (
        <span className="font-mono text-xs text-slate-500">
          {shortId(String(row.original.data.digest ?? "—"))}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="Audit"
        description="Immutable intents, receipts, actors and integrity-relevant state changes."
      />
      <QueryContent query={query}>
        <DataTable columns={columns} data={query.data?.items ?? []} />
        <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
      </QueryContent>
    </>
  );
}

export { LeaderboardPage } from "./leaderboard-page";

export function NotFoundPage() {
  return (
    <Empty>
      <p>That control view does not exist.</p>
      <Link
        className="mt-4 inline-flex items-center gap-2 text-cyan-300 hover:underline"
        to="/overview"
      >
        Return to overview <ArrowRight size={15} />
      </Link>
    </Empty>
  );
}

import type { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertTriangle,
  ArrowRight,
  CircleDollarSign,
  Clock3,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { z } from "zod";
import {
  actOnCampaign,
  submitCampaign,
  type AuditResponse,
  type CampaignAction,
  type CampaignList,
  type CampaignSubmission,
  type EndpointList,
  type JobList,
  type ProfileList,
  type ResultList,
  type TaskList,
} from "./api";
import { DataTable } from "./components/data-table";
import { PageHeader } from "./layout";
import { formatDate, formatMoney, humanize, shortId } from "./lib";
import {
  keys,
  useAudit,
  useCampaign,
  useCampaigns,
  useEndpoints,
  useJobs,
  useProfiles,
  useResults,
  useSystem,
  useTask,
  useTasks,
} from "./queries";
import { Badge, Button, Card, Empty, Loading, Progress } from "./ui";

type CampaignRow = CampaignList["items"][number];
type TaskRow = TaskList["items"][number];
type JobRow = JobList["items"][number];
type EndpointRow = EndpointList["items"][number];
type ProfileRow = ProfileList["items"][number];
type ResultRow = ResultList["items"][number];
type AuditRow = AuditResponse["items"][number];

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

const launchSchema = z.object({
  benchmark: z.string().min(3),
  model: z.string().min(3),
  harness: z.string().min(3),
  deployment: z.string().min(3).optional(),
  launch_policy: z.string().min(3),
  ceiling_microusd: z.number().int().nonnegative(),
  confirmed: z
    .boolean()
    .refine((value) => value, "Confirm the resolved target and cost ceiling"),
});

function SpendChart({ data }: { data: Array<{ name: string; spend: number }> }) {
  const width = 640;
  const height = 240;
  const padding = 24;
  const maximum = Math.max(...data.map((item) => item.spend), 1);
  const point = (value: number, index: number) => {
    const x =
      data.length === 1
        ? width / 2
        : padding + (index / (data.length - 1)) * (width - padding * 2);
    const y = height - padding - (value / maximum) * (height - padding * 2);
    return [x, y] as const;
  };
  const points = data.map((item, index) => point(item.spend, index));
  const line = points.map(([x, y]) => `${x},${y}`).join(" ");
  const area = `${padding},${height - padding} ${line} ${width - padding},${height - padding}`;
  return (
    <svg
      className="h-full w-full"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Observed campaign spend trend"
    >
      <title>Observed campaign spend trend</title>
      <defs>
        <linearGradient id="spend-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((ratio) => {
        const y = height - padding - ratio * (height - padding * 2);
        return (
          <line
            key={ratio}
            x1={padding}
            x2={width - padding}
            y1={y}
            y2={y}
            stroke="#1e293b"
            strokeDasharray="4 6"
          />
        );
      })}
      <polygon points={area} fill="url(#spend-gradient)" />
      <polyline
        points={line}
        fill="none"
        stroke="#22d3ee"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map(([x, y], index) => (
        <circle key={data[index]?.name} cx={x} cy={y} r="4" fill="#67e8f9">
          <title>{`${data[index]?.name}: ${formatMoney(data[index]?.spend ?? 0)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

function Stat({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Clock3;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            {label}
          </p>
          <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
          <p className="mt-1 text-xs text-slate-500">{note}</p>
        </div>
        <span className="rounded-lg bg-cyan-400/10 p-2 text-cyan-300">
          <Icon size={18} />
        </span>
      </div>
    </Card>
  );
}

export function OverviewPage() {
  const campaigns = useCampaigns();
  const endpoints = useEndpoints();
  const system = useSystem();
  if (campaigns.isLoading || endpoints.isLoading || system.isLoading)
    return <Loading />;
  const items = campaigns.data?.items ?? [];
  const active = items.filter((item) => item.status !== "completed").length;
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
      name: shortId(item.campaign_id),
      spend: item.observed_microusd / 1_000_000,
      progress: item.total_tasks
        ? Math.round((item.terminal_tasks / item.total_tasks) * 100)
        : 0,
    }));
  return (
    <>
      <PageHeader
        title="Overview"
        description="Campaign progress, spend, publication and endpoint safety from the immutable control record."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Active campaigns"
          value={String(active)}
          note={`${items.length} total`}
          icon={PlayCircle}
        />
        <Stat
          label="Policy stops"
          value={String(failures)}
          note="Requires operator review"
          icon={AlertTriangle}
        />
        <Stat
          label="Observed spend"
          value={formatMoney(spend)}
          note="Across projected campaigns"
          icon={CircleDollarSign}
        />
        <Stat
          label="Unsafe endpoints"
          value={String(unsafe)}
          note={unsafe ? "Cleanup required" : "All observed endpoints safe"}
          icon={ShieldCheck}
        />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <h2 className="font-semibold">Recent campaign spend</h2>
          <p className="mt-1 text-xs text-slate-500">
            Observed cost in USD; reserved ceilings remain separate.
          </p>
          <div className="mt-6 h-72">
            {chart.length ? (
              <SpendChart data={chart} />
            ) : (
              <div className="grid h-full place-items-center text-sm text-slate-500">
                No campaign spend yet
              </div>
            )}
          </div>
        </Card>
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Control readiness</h2>
            <Badge status={system.data?.projection?.ready ? "ready" : "pending"}>
              {system.data?.projection?.ready ? "Ready" : "Rebuilding"}
            </Badge>
          </div>
          <dl className="mt-5 space-y-4 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Write mode</dt>
              <dd>{humanize(String(system.data?.write_mode ?? "unknown"))}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Source revision</dt>
              <dd className="font-mono text-xs">
                {shortId(String(system.data?.source_revision ?? "unknown"))}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Projected objects</dt>
              <dd>{String(system.data?.projection?.object_count ?? 0)}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}

function LaunchPanel({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const form = useForm<z.infer<typeof launchSchema>>({
    resolver: zodResolver(launchSchema),
    defaultValues: {
      benchmark: "control-smoke",
      model: "control-smoke",
      harness: "control-smoke",
      deployment: "hf-cpu-smoke",
      launch_policy: "control-smoke",
      ceiling_microusd: 0,
      confirmed: false,
    },
  });
  const mutation = useMutation({
    mutationFn: (input: CampaignSubmission) => submitCampaign(input),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: keys.campaigns });
      navigate(`/campaigns/${result.campaign_id}`);
    },
  });
  return (
    <Card className="mb-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-semibold">Launch campaign</h2>
          <p className="mt-1 text-sm text-slate-400">
            Resolve immutable profiles before any paid action.
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <form
        className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
        onSubmit={form.handleSubmit((value) =>
          mutation.mutate(value as CampaignSubmission),
        )}
      >
        {(
          ["benchmark", "model", "harness", "deployment", "launch_policy"] as const
        ).map((field) => (
          <label className="space-y-1.5 text-sm" key={field}>
            <span className="text-slate-400">{humanize(field)}</span>
            <input
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-400"
              {...form.register(field)}
            />
          </label>
        ))}
        <label className="space-y-1.5 text-sm">
          <span className="text-slate-400">Cost ceiling, micro-USD</span>
          <input
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-400"
            type="number"
            {...form.register("ceiling_microusd", { valueAsNumber: true })}
          />
        </label>
        <label className="flex items-start gap-3 md:col-span-2 xl:col-span-3">
          <input
            className="mt-1 h-4 w-4 accent-cyan-400"
            type="checkbox"
            {...form.register("confirmed")}
          />
          <span className="text-sm text-slate-300">
            I confirm the resolved profiles, logical task count and cumulative cost
            ceiling.
          </span>
        </label>
        {form.formState.errors.confirmed ? (
          <p className="text-sm text-rose-300 md:col-span-2 xl:col-span-3">
            {form.formState.errors.confirmed.message}
          </p>
        ) : null}
        {mutation.error ? (
          <p className="text-sm text-rose-300 md:col-span-2 xl:col-span-3">
            {mutation.error.message}
          </p>
        ) : null}
        <div className="md:col-span-2 xl:col-span-3">
          <Button disabled={mutation.isPending} type="submit">
            <PlayCircle size={16} />
            {mutation.isPending ? "Submitting" : "Create immutable campaign"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function CampaignsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useCursorNavigation();
  const [launching, setLaunching] = useState(false);
  const query = useCampaigns(navigation.cursor);
  const filter = searchParams.get("status") ?? "all";
  const items = (query.data?.items ?? []).filter(
    (item) => filter === "all" || item.status === filter,
  );
  const columns = useMemo<ColumnDef<CampaignRow>[]>(
    () => [
      {
        accessorKey: "campaign_id",
        header: "Campaign",
        cell: ({ row }) => (
          <Link
            className="font-mono text-xs text-cyan-300 hover:underline"
            to={`/campaigns/${row.original.campaign_id}`}
          >
            {shortId(row.original.campaign_id)}
          </Link>
        ),
      },
      {
        accessorKey: "status",
        header: "State",
        cell: ({ getValue }) => (
          <Badge status={String(getValue())}>{humanize(String(getValue()))}</Badge>
        ),
      },
      {
        id: "progress",
        header: "Logical progress",
        cell: ({ row }) => (
          <div className="min-w-40">
            <Progress
              label={`${row.original.terminal_tasks}/${row.original.total_tasks} tasks`}
              value={
                row.original.total_tasks
                  ? (row.original.terminal_tasks / row.original.total_tasks) * 100
                  : 0
              }
            />
          </div>
        ),
      },
      {
        accessorKey: "observed_microusd",
        header: "Observed",
        cell: ({ getValue }) => formatMoney(Number(getValue())),
      },
      {
        accessorKey: "ceiling_microusd",
        header: "Ceiling",
        cell: ({ getValue }) => formatMoney(Number(getValue())),
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ getValue }) => formatDate(String(getValue())),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Logical tasks remain separate from physical attempts and infrastructure repairs."
        action={
          <Button onClick={() => setLaunching((value) => !value)}>
            <Plus size={16} />
            Launch
          </Button>
        }
      />
      {launching ? <LaunchPanel onClose={() => setLaunching(false)} /> : null}
      <nav className="mb-4 flex gap-2" aria-label="Filter campaigns">
        {["all", "active", "publishing", "completed"].map((status) => (
          <Button
            key={status}
            variant={filter === status ? "secondary" : "ghost"}
            onClick={() => setSearchParams(status === "all" ? {} : { status })}
          >
            {humanize(status)}
          </Button>
        ))}
      </nav>
      {query.isLoading ? (
        <Loading />
      ) : (
        <>
          <DataTable
            columns={columns}
            data={items}
            empty="No campaigns match this filter"
          />
          <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
        </>
      )}
    </>
  );
}

export function CampaignPage() {
  const { campaignId = "" } = useParams();
  const navigation = useCursorNavigation();
  const campaign = useCampaign(campaignId);
  const tasks = useTasks(campaignId, navigation.cursor);
  const client = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelAcknowledged, setCancelAcknowledged] = useState(false);
  const closeCancel = () => {
    setCancelOpen(false);
    setCancelAcknowledged(false);
  };
  const cancel = useMutation({
    mutationFn: () =>
      actOnCampaign(campaignId, {
        action: "cancel",
        task_id: null,
        reason: "operator cancellation",
        confirmed: true,
      } as CampaignAction),
    onSuccess: () => {
      closeCancel();
      return client.invalidateQueries({ queryKey: keys.campaign(campaignId) });
    },
  });
  if (campaign.isLoading || tasks.isLoading) return <Loading />;
  if (!campaign.data) return <Empty>Campaign not found</Empty>;
  const item = campaign.data;
  const columns: ColumnDef<TaskRow>[] = [
    {
      accessorKey: "task_id",
      header: "Task",
      cell: ({ row }) => (
        <Link
          className="font-mono text-xs text-cyan-300 hover:underline"
          to={`/campaigns/${campaignId}/tasks/${row.original.task_id}`}
        >
          {shortId(row.original.task_id)}
        </Link>
      ),
    },
    {
      accessorKey: "terminal_outcome",
      header: "Outcome",
      cell: ({ getValue }) => (
        <Badge status={String(getValue() ?? "pending")}>
          {humanize(String(getValue() ?? "pending"))}
        </Badge>
      ),
    },
    {
      accessorKey: "selected_attempt_id",
      header: "Selected attempt",
      cell: ({ getValue }) => (
        <span className="font-mono text-xs">
          {getValue() ? shortId(String(getValue())) : "—"}
        </span>
      ),
    },
    {
      accessorKey: "input_digest",
      header: "Input",
      cell: ({ getValue }) => (
        <span className="font-mono text-xs text-slate-500">
          {shortId(String(getValue()))}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={shortId(campaignId)}
        description="Campaign lock, logical outcomes, cost and publication state."
        action={
          item.status !== "completed" ? (
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => setCancelOpen(true)}
            >
              <PauseCircle size={16} />
              Cancel campaign
            </Button>
          ) : undefined
        }
      />
      {cancelOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
          <Card
            className="w-full max-w-lg border-rose-500/40"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-campaign-title"
            aria-describedby="cancel-campaign-effect"
          >
            <h2 id="cancel-campaign-title" className="text-lg font-semibold text-white">
              Cancel campaign?
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Target <span className="font-mono">{shortId(campaignId)}</span> has{" "}
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
            <p id="cancel-campaign-effect" className="mt-4 text-sm text-slate-300">
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
                disabled={!cancelAcknowledged || cancel.isPending}
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
          value={humanize(item.status)}
          note={item.publication_status ?? "Not published"}
          icon={RefreshCw}
        />
        <Stat
          label="Logical tasks"
          value={`${item.terminal_tasks}/${item.total_tasks}`}
          note={`${item.pending_actions} pending actions`}
          icon={Clock3}
        />
        <Stat
          label="Observed cost"
          value={formatMoney(item.observed_microusd)}
          note={`${formatMoney(item.reserved_microusd)} reserved`}
          icon={CircleDollarSign}
        />
        <Stat
          label="Endpoint cleanup"
          value={item.cleanup_pending ? "Pending" : "Clear"}
          note="Required before completion"
          icon={ShieldCheck}
        />
      </div>
      <Card className="my-6">
        <Progress
          label="Terminal logical outcomes"
          value={item.total_tasks ? (item.terminal_tasks / item.total_tasks) * 100 : 0}
        />
      </Card>
      <DataTable
        columns={columns}
        data={tasks.data?.items ?? []}
        empty="No tasks are locked"
      />
      <CursorPager navigation={navigation} nextCursor={tasks.data?.next_cursor} />
    </>
  );
}

export function TaskPage() {
  const { campaignId = "", taskId = "" } = useParams();
  const detail = useTask(campaignId, taskId);
  if (detail.isLoading) return <Loading />;
  if (!detail.data) return <Empty>Task not found</Empty>;
  return (
    <>
      <PageHeader
        title={shortId(taskId)}
        description="One logical task with every immutable physical attempt."
      />
      <Card>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Outcome</dt>
            <dd className="mt-1">
              <Badge status={detail.data.task.terminal_outcome ?? "pending"}>
                {humanize(detail.data.task.terminal_outcome ?? "pending")}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Selected attempt</dt>
            <dd className="mt-1 font-mono text-xs">
              {detail.data.task.selected_attempt_id ?? "—"}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-slate-500">Input digest</dt>
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
                  Physical attempt {index + 1}
                </p>
                <p className="mt-1 font-mono text-sm">{attempt.attempt_id}</p>
              </div>
              <Badge status={attempt.outcome}>{humanize(attempt.outcome)}</Badge>
            </div>
            <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">Replacement eligible</dt>
                <dd>{attempt.replacement_eligible ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Cost</dt>
                <dd>{formatMoney(attempt.cost_microusd)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Recorded</dt>
                <dd>{formatDate(attempt.created_at)}</dd>
              </div>
              <div className="sm:col-span-3">
                <dt className="text-slate-500">Metrics</dt>
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
    </>
  );
}

export function JobsPage() {
  const navigation = useCursorNavigation();
  const query = useJobs(navigation.cursor);
  const columns: ColumnDef<JobRow>[] = [
    {
      accessorKey: "resource_id",
      header: "HF Job",
      cell: ({ getValue }) => (
        <span className="font-mono text-xs">
          {getValue() ? shortId(String(getValue())) : "Pending"}
        </span>
      ),
    },
    {
      accessorKey: "campaign_id",
      header: "Campaign",
      cell: ({ getValue }) => (
        <Link
          className="font-mono text-xs text-cyan-300"
          to={`/campaigns/${String(getValue())}`}
        >
          {shortId(String(getValue()))}
        </Link>
      ),
    },
    {
      accessorKey: "action_kind",
      header: "Action",
      cell: ({ getValue }) => humanize(String(getValue())),
    },
    {
      accessorKey: "observed_state",
      header: "Observed",
      cell: ({ getValue }) => (
        <Badge status={String(getValue() ?? "pending").toLowerCase()}>
          {humanize(String(getValue() ?? "pending"))}
        </Badge>
      ),
    },
    {
      accessorKey: "created_at",
      header: "Recorded",
      cell: ({ getValue }) => formatDate(String(getValue())),
    },
  ];
  return (
    <>
      <PageHeader
        title="Jobs"
        description="HF Job identity, ownership and infrastructure state tied to deterministic actions."
      />
      {query.isLoading ? (
        <Loading />
      ) : (
        <>
          <DataTable columns={columns} data={query.data?.items ?? []} />
          <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
        </>
      )}
    </>
  );
}

export function EndpointsPage() {
  const navigation = useCursorNavigation();
  const query = useEndpoints(navigation.cursor);
  const columns: ColumnDef<EndpointRow>[] = [
    {
      accessorKey: "endpoint_id",
      header: "Endpoint",
      cell: ({ getValue }) => (
        <span className="font-mono text-xs">{shortId(String(getValue()))}</span>
      ),
    },
    {
      accessorKey: "campaign_id",
      header: "Campaign",
      cell: ({ getValue }) => (
        <Link
          className="font-mono text-xs text-cyan-300"
          to={`/campaigns/${String(getValue())}`}
        >
          {shortId(String(getValue()))}
        </Link>
      ),
    },
    {
      accessorKey: "desired_state",
      header: "Desired",
      cell: ({ getValue }) => humanize(String(getValue())),
    },
    {
      accessorKey: "observed_state",
      header: "Observed",
      cell: ({ getValue }) => (
        <Badge status={String(getValue()).toLowerCase()}>
          {humanize(String(getValue()))}
        </Badge>
      ),
    },
    { accessorKey: "ready_replicas", header: "Ready replicas" },
    {
      accessorKey: "cleanup_verified",
      header: "Cleanup",
      cell: ({ getValue }) =>
        Number(getValue()) ? (
          <Badge status="ready">Verified</Badge>
        ) : (
          <Badge status="pending">Pending</Badge>
        ),
    },
    {
      accessorKey: "active_hourly_cost_microusd",
      header: "Active hourly cost",
      cell: ({ getValue }) => formatMoney(Number(getValue())),
    },
  ];
  return (
    <>
      <PageHeader
        title="Endpoints"
        description="Requested and observed state remain separate. Completion requires verified pause with zero ready replicas."
      />
      {query.isLoading ? (
        <Loading />
      ) : (
        <>
          <DataTable columns={columns} data={query.data?.items ?? []} />
          <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
        </>
      )}
    </>
  );
}

export function ResultsPage() {
  const navigation = useCursorNavigation();
  const query = useResults(navigation.cursor);
  const columns: ColumnDef<ResultRow>[] = [
    {
      accessorKey: "publication_id",
      header: "Publication",
      cell: ({ getValue }) => (
        <span className="font-mono text-xs">{shortId(String(getValue()))}</span>
      ),
    },
    {
      accessorKey: "campaign_id",
      header: "Campaign",
      cell: ({ getValue }) => (
        <Link
          className="font-mono text-xs text-cyan-300"
          to={`/campaigns/${String(getValue())}`}
        >
          {shortId(String(getValue()))}
        </Link>
      ),
    },
    {
      accessorKey: "model",
      header: "Model",
      cell: ({ row }) => (
        <div>
          <div className="max-w-52 truncate font-medium">
            {String(row.original.model ?? "—")}
          </div>
          <div className="max-w-52 truncate text-xs text-slate-500">
            {String(row.original.benchmark ?? "")}
          </div>
        </div>
      ),
    },
    {
      id: "score",
      header: "Primary metric",
      cell: ({ row }) => {
        const metric = row.original.primary_metric;
        if (!metric) return "—";
        return (
          <span title={`${metric.name} (${metric.unit})`}>
            {metric.value.toFixed(4)}
          </span>
        );
      },
    },
    {
      id: "tasks",
      header: "Scored tasks",
      cell: ({ row }) =>
        row.original.task_count === null || row.original.task_count === undefined
          ? "—"
          : `${row.original.scored_task_count ?? 0}/${row.original.task_count}`,
    },
    {
      accessorKey: "status",
      header: "State",
      cell: ({ getValue }) => (
        <Badge status={String(getValue())}>{humanize(String(getValue()))}</Badge>
      ),
    },
    {
      accessorKey: "catalog_digest",
      header: "Catalog",
      cell: ({ getValue }) => (
        <span className="font-mono text-xs text-slate-500">
          {getValue() ? shortId(String(getValue())) : "—"}
        </span>
      ),
    },
    {
      accessorKey: "published_at",
      header: "Published",
      cell: ({ getValue }) => formatDate(String(getValue())),
    },
  ];
  return (
    <>
      <PageHeader
        title="Results"
        description="Normalized publications and provenance projected from immutable Bucket objects."
      />
      {query.isLoading ? (
        <Loading />
      ) : (
        <>
          <DataTable columns={columns} data={query.data?.items ?? []} />
          <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
        </>
      )}
    </>
  );
}

export function ProfilesPage() {
  const navigation = useCursorNavigation();
  const query = useProfiles(navigation.cursor);
  const columns: ColumnDef<ProfileRow>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.name}</div>
          <div className="font-mono text-xs text-slate-500">
            {shortId(row.original.profile_id)}
          </div>
        </div>
      ),
    },
    {
      accessorKey: "profile_kind",
      header: "Kind",
      cell: ({ getValue }) => humanize(String(getValue())),
    },
    {
      accessorKey: "source",
      header: "Source",
      cell: ({ getValue }) => <Badge>{humanize(String(getValue()))}</Badge>,
    },
    {
      accessorKey: "promotion_state",
      header: "Approval",
      cell: ({ getValue }) => (
        <Badge status={String(getValue() ?? "built-in")}>
          {humanize(String(getValue() ?? "built-in"))}
        </Badge>
      ),
    },
    {
      accessorKey: "alias",
      header: "Alias",
      cell: ({ getValue }) => String(getValue() ?? "—"),
    },
  ];
  return (
    <>
      <PageHeader
        title="Profiles"
        description="Resolved, immutable benchmark, model, harness, deployment and launch-policy records."
      />
      {query.isLoading ? (
        <Loading />
      ) : (
        <>
          <DataTable columns={columns} data={query.data?.items ?? []} />
          <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
        </>
      )}
    </>
  );
}

export function AuditPage() {
  const navigation = useCursorNavigation();
  const query = useAudit(navigation.cursor);
  const columns: ColumnDef<AuditRow>[] = [
    {
      accessorKey: "occurred_at",
      header: "Time",
      cell: ({ getValue }) => formatDate(String(getValue())),
    },
    {
      accessorKey: "type",
      header: "Record",
      cell: ({ getValue }) => <Badge>{humanize(String(getValue()))}</Badge>,
    },
    {
      id: "record_id",
      header: "Identity",
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {shortId(String(row.original.data.record_id ?? row.original.id))}
        </span>
      ),
    },
    {
      id: "digest",
      header: "Digest",
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
      {query.isLoading ? (
        <Loading />
      ) : (
        <>
          <DataTable columns={columns} data={query.data?.items ?? []} />
          <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
        </>
      )}
    </>
  );
}

export function NotFoundPage() {
  return (
    <Empty>
      <p>That control view does not exist.</p>
      <Link
        className="mt-4 inline-flex items-center gap-2 text-cyan-300 hover:underline"
        to="/"
      >
        Return to overview <ArrowRight size={15} />
      </Link>
    </Empty>
  );
}

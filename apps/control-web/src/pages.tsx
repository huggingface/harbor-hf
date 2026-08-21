import { zodResolver } from "@hookform/resolvers/zod";
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
import { useForm } from "react-hook-form";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { z } from "zod";
import {
  type AuditResponse,
  actOnCampaign,
  type CampaignAction,
  type CampaignList,
  type CampaignSubmission,
  type EndpointList,
  type JobList,
  type ProfileList,
  type ResultDetail,
  type ResultList,
  submitCampaign,
  type TaskList,
} from "./api";
import { DataTable } from "./components/data-table";
import { useControlState } from "./control-state";
import { hints } from "./hints";
import {
  doubleReservationMicrousd,
  harnessAgent,
  LAUNCH_DEFAULTS,
  launchPolicyForBenchmark,
  profileLabel,
  REASONING_OPTIONS,
  selectDeploymentAlias,
  selectHarnessAlias,
} from "./launch";
import { PageHeader } from "./layout";
import {
  cn,
  estimateLaunchReservationMicrousd,
  formatDate,
  formatMoney,
  formatPercent,
  formatPercentInterval,
  formatTokens,
  humanize,
  runNameClass,
  shortId,
} from "./lib";
import {
  keys,
  useAudit,
  useCampaign,
  useCampaigns,
  useCapacity,
  useEndpoints,
  useJobs,
  useProfiles,
  useResult,
  useResults,
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

type CampaignRow = CampaignList["items"][number];
type TaskRow = TaskList["items"][number];
type JobRow = JobList["items"][number];
type EndpointRow = EndpointList["items"][number];
type ProfileRow = ProfileList["items"][number];
type ResultRow = ResultList["items"][number];
type ResultTask = NonNullable<ResultDetail["tasks"]>[number];
type AuditRow = AuditResponse["items"][number];

function campaignIsFinished(status: string): boolean {
  return status === "completed" || status === "cancelled";
}

function campaignHasSealedFailures(campaign: CampaignRow): boolean {
  return (
    campaign.status === "completed" &&
    campaign.successful_tasks !== campaign.total_tasks
  );
}

function campaignResultStatus(campaign: CampaignRow): string {
  return campaignHasSealedFailures(campaign) ? "warning" : campaign.status;
}

function campaignStatusLabel(campaign: CampaignRow): string {
  return campaignHasSealedFailures(campaign)
    ? "Completed with failures"
    : humanize(campaign.status);
}

function campaignStatusNote(campaign: CampaignRow): string {
  const publication = campaign.publication_status
    ? humanize(campaign.publication_status)
    : "Not published";
  if (campaign.status === "cancelled") {
    const cancelled = campaign.total_tasks - campaign.successful_tasks;
    return `${publication}. ${cancelled} sealed ${cancelled === 1 ? "task" : "tasks"} cancelled.`;
  }
  if (campaign.status !== "completed") return publication;
  if (campaign.successful_tasks === campaign.total_tasks) return publication;
  const failed = campaign.total_tasks - campaign.successful_tasks;
  return `${publication}. ${failed} sealed ${failed === 1 ? "task" : "tasks"} did not succeed.`;
}

function RunName({ campaignId, to }: { campaignId: string; to: string }) {
  return (
    <Link className={cn(runNameClass, "text-cyan-300 hover:underline")} to={to}>
      {campaignId}
    </Link>
  );
}

function jobColumns(includeCampaign: boolean): ColumnDef<JobRow>[] {
  const campaignColumn: ColumnDef<JobRow> = {
    accessorKey: "campaign_id",
    header: () => <Hint text={hints.jobs.campaign}>Run</Hint>,
    meta: { className: "min-w-0" },
    cell: ({ getValue }) => (
      <RunName campaignId={String(getValue())} to={`/runs/${String(getValue())}`} />
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
          return <span className="font-mono text-xs">Pending</span>;
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
    ...(includeCampaign ? [campaignColumn] : []),
    {
      accessorKey: "action_kind",
      header: () => <Hint text={hints.jobs.action}>Action</Hint>,
      cell: ({ getValue }) => humanize(String(getValue())),
    },
    {
      accessorKey: "observed_state",
      header: () => <Hint text={hints.jobs.observed}>Observed</Hint>,
      cell: ({ getValue }) => (
        <Badge status={String(getValue() ?? "pending").toLowerCase()}>
          {humanize(String(getValue() ?? "pending"))}
        </Badge>
      ),
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

function CampaignJobs({ campaignId }: { campaignId: string }) {
  const query = useJobs(undefined, campaignId);
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-white">
        <Hint text={hints.campaign.jobs}>Jobs</Hint>
      </h2>
      <p className="mb-4 mt-1 text-sm text-slate-400">
        HF Jobs launched for this campaign, with Hub inspect links, latest observed
        state, and recorded hardware cost.
      </p>
      <QueryContent query={query}>
        <DataTable
          columns={jobColumns(false)}
          data={query.data?.items ?? []}
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

const launchSchema = z.object({
  benchmark: z.string().min(2),
  model: z.string().min(2),
  harnessAgent: z.string().min(2),
  reasoning: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  deploymentKind: z.enum(["providers", "endpoints"]),
  ceiling_usd: z.number().nonnegative(),
  confirmed: z
    .boolean()
    .refine((value) => value, "Confirm the resolved target and cost ceiling"),
});

/** Plot observed run spend oldest to newest, with a USD Y scale. */
function SpendChart({
  data,
}: {
  data: Array<{ name: string; spendMicrousd: number }>;
}) {
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
      {points.map(([x, y], index) => (
        <circle key={data[index]?.name} cx={x} cy={y} r="4" fill="#67e8f9">
          <title>{`${data[index]?.name}: ${formatMoney(data[index]?.spendMicrousd ?? 0)}`}</title>
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

export function OverviewPage() {
  const campaigns = useCampaigns();
  const endpoints = useEndpoints();
  const system = useSystem();
  const items = campaigns.data?.items ?? [];
  const active = items.filter((item) => !campaignIsFinished(item.status)).length;
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
      name: item.campaign_id,
      spendMicrousd: item.observed_microusd,
    }));
  return (
    <QueryContent query={campaigns}>
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
              note="Across projected campaigns"
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
                    <li key={item.campaign_id}>
                      <RunName
                        campaignId={item.campaign_id}
                        to={`/runs/${item.campaign_id}`}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
            <Card>
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Control readiness</h2>
                <Badge status={system.data?.projection?.ready ? "ready" : "pending"}>
                  {system.data?.projection?.ready ? "Ready" : "Rebuilding"}
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

function LaunchPanel({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const profiles = useProfiles();
  const { writesAllowed, writeMode } = useControlState();
  const ceilingEdited = useRef(false);
  const form = useForm<z.infer<typeof launchSchema>>({
    resolver: zodResolver(launchSchema),
    defaultValues: {
      benchmark: LAUNCH_DEFAULTS.benchmark,
      model: LAUNCH_DEFAULTS.model,
      harnessAgent: LAUNCH_DEFAULTS.harnessAgent,
      reasoning: LAUNCH_DEFAULTS.reasoning,
      deploymentKind: LAUNCH_DEFAULTS.deploymentKind,
      ceiling_usd: 0,
      confirmed: false,
    },
  });
  const values = form.watch();
  const approved = (profiles.data?.items ?? []).flatMap((profile) =>
    profile.approved_aliases.map((approved_alias) => ({
      ...profile,
      approved_alias,
      spec: profile.spec as Record<string, unknown>,
    })),
  );
  const ofKind = (kind: string) =>
    approved.filter((profile) => profile.profile_kind === kind);
  const uniqueAgents = [
    ...new Set(ofKind("harness").map((profile) => harnessAgent(profile.spec))),
  ];
  let resolved:
    | {
        harness: string;
        deployment: string;
        launch_policy: string;
      }
    | undefined;
  let resolvedError: string | undefined;
  try {
    resolved = {
      harness: selectHarnessAlias(
        ofKind("harness").map((profile) => ({
          alias: profile.approved_alias,
          spec: profile.spec,
        })),
        values.harnessAgent,
        values.reasoning,
      ),
      deployment: "",
      launch_policy: launchPolicyForBenchmark(values.benchmark),
    };
    resolved.deployment = selectDeploymentAlias(
      ofKind("deployment").map((profile) => ({
        alias: profile.approved_alias,
        spec: profile.spec,
      })),
      values.deploymentKind,
      values.model,
      resolved.harness,
    );
  } catch (error) {
    resolvedError = error instanceof Error ? error.message : String(error);
  }
  const selected = approved.filter((profile) => {
    if (!resolved) return false;
    if (profile.profile_kind === "benchmark")
      return profile.approved_alias === values.benchmark;
    if (profile.profile_kind === "model")
      return profile.approved_alias === values.model;
    if (profile.profile_kind === "harness")
      return profile.approved_alias === resolved.harness;
    if (profile.profile_kind === "deployment")
      return profile.approved_alias === resolved.deployment;
    if (profile.profile_kind === "launch_policy")
      return profile.approved_alias === resolved.launch_policy;
    return false;
  });
  const specOf = (kind: string) =>
    selected.find((profile) => profile.profile_kind === kind)?.spec;
  const benchmarkSpec = specOf("benchmark");
  const modelSpec = specOf("model");
  const deploymentSpec = specOf("deployment");
  const policySpec = specOf("launch_policy");
  const taskCount = Array.isArray(benchmarkSpec?.task_ids)
    ? benchmarkSpec.task_ids.length
    : 0;
  const estimatedMicrousd = estimateLaunchReservationMicrousd(
    taskCount,
    deploymentSpec,
    policySpec,
  );
  useEffect(() => {
    if (ceilingEdited.current) return;
    form.setValue(
      "ceiling_usd",
      doubleReservationMicrousd(estimatedMicrousd) / 1_000_000,
    );
  }, [estimatedMicrousd, form]);
  const mutation = useMutation({
    mutationFn: (input: CampaignSubmission) => submitCampaign(input),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: keys.campaigns });
      navigate(`/runs/${result.campaign_id}`);
    },
  });
  return (
    <Card className="mb-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">Start a run</h2>
          <p className="mt-1 text-sm text-slate-400">
            Choose the benchmark, model, runtime, harness, and reasoning. The hard
            ceiling follows twice the estimated reservation until you edit it. Submit
            locks those choices onto the run.
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {!writesAllowed ? (
        <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-200">
          Launch is unavailable because write mode is {humanize(writeMode)}. Your role
          and deployment write mode are separate controls.
        </p>
      ) : null}
      <QueryContent query={profiles}>
        <form
          className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
          onSubmit={form.handleSubmit((value) => {
            if (!resolved) return;
            mutation.mutate({
              benchmark: value.benchmark,
              model: value.model,
              harness: resolved.harness,
              deployment: resolved.deployment,
              launch_policy: resolved.launch_policy,
              ceiling_microusd: Math.round(value.ceiling_usd * 1_000_000),
              confirmed: value.confirmed,
            });
          })}
        >
          <div className="space-y-1.5 text-sm">
            <Hint text={hints.launch.benchmark} icon>
              Benchmark
            </Hint>
            <select
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50"
              disabled={!writesAllowed}
              aria-label="Benchmark"
              {...form.register("benchmark")}
            >
              {ofKind("benchmark").map((profile) => (
                <option key={profile.profile_id} value={profile.approved_alias}>
                  {profileLabel("benchmark", profile.approved_alias, profile.spec)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 text-sm">
            <Hint text={hints.launch.model} icon>
              Model
            </Hint>
            <select
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50"
              disabled={!writesAllowed}
              aria-label="Model"
              {...form.register("model")}
            >
              {ofKind("model").map((profile) => (
                <option key={profile.profile_id} value={profile.approved_alias}>
                  {profileLabel("model", profile.approved_alias, profile.spec)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 text-sm">
            <Hint text={hints.launch.deployment} icon>
              Runtime
            </Hint>
            <select
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50"
              disabled={!writesAllowed}
              aria-label="Runtime"
              {...form.register("deploymentKind")}
            >
              <option value="providers">Inference Providers</option>
              <option value="endpoints">Inference Endpoints</option>
            </select>
          </div>
          <div className="space-y-1.5 text-sm">
            <Hint text={hints.launch.harness} icon>
              Harness
            </Hint>
            <select
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50"
              disabled={!writesAllowed}
              aria-label="Harness"
              {...form.register("harnessAgent")}
            >
              {uniqueAgents.map((agent) => (
                <option key={agent} value={agent}>
                  {profileLabel("harness", agent, { agent })}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 text-sm">
            <Hint text={hints.launch.reasoning} icon>
              Reasoning
            </Hint>
            <select
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50"
              disabled={!writesAllowed}
              aria-label="Reasoning"
              {...form.register("reasoning")}
            >
              {REASONING_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 text-sm">
            <Hint text={hints.launch.ceiling} icon>
              Cost ceiling, USD
            </Hint>
            <input
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50"
              type="number"
              min="0"
              step="0.01"
              disabled={!writesAllowed}
              aria-label="Cost ceiling, USD"
              {...form.register("ceiling_usd", {
                setValueAs: (value) => Number(value),
                onChange: () => {
                  ceilingEdited.current = true;
                },
              })}
            />
          </div>
          <Card className="md:col-span-2 xl:col-span-3">
            <h3 className="font-medium">What this run will lock</h3>
            {resolvedError ? (
              <p className="mt-3 text-sm text-rose-300">{resolvedError}</p>
            ) : (
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="text-slate-500">
                    <Hint text={hints.launch.logicalTasks}>Tasks</Hint>
                  </dt>
                  <dd>{taskCount}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">
                    <Hint text={hints.launch.modelRevision}>Model revision</Hint>
                  </dt>
                  <dd className="break-all font-mono text-xs">
                    {String(modelSpec?.revision ?? "Unavailable")}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">
                    <Hint text={hints.launch.estimatedReservation}>
                      Estimated reservation
                    </Hint>
                  </dt>
                  <dd>{formatMoney(estimatedMicrousd)}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">
                    <Hint text={hints.launch.hardCeiling}>Hard ceiling</Hint>
                  </dt>
                  <dd>
                    {formatMoney(Math.round((values.ceiling_usd || 0) * 1_000_000))}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Locked harness</dt>
                  <dd className="font-mono text-xs">{resolved?.harness}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Locked deployment</dt>
                  <dd className="font-mono text-xs">{resolved?.deployment}</dd>
                </div>
              </dl>
            )}
          </Card>
          <div className="md:col-span-2 xl:col-span-3">
            <label className="flex items-start gap-3">
              <input
                className="mt-1 h-4 w-4 shrink-0 accent-cyan-400"
                type="checkbox"
                disabled={!writesAllowed}
                {...form.register("confirmed")}
              />
              <span className="min-w-0 text-sm text-slate-300">
                I confirm the benchmark, model, runtime, harness, reasoning, task count,
                and cost ceiling. After submit those values are locked on the run.
                <span className="mt-1.5 block text-slate-400">
                  <Hint text={hints.launch.confirmed} icon>
                    Why is this required?
                  </Hint>
                </span>
              </span>
            </label>
          </div>
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
            <Button
              disabled={
                !writesAllowed || !values.confirmed || !resolved || mutation.isPending
              }
              type="submit"
            >
              <PlayCircle size={16} />
              {mutation.isPending ? "Submitting" : "Start run"}
            </Button>
          </div>
        </form>
      </QueryContent>
    </Card>
  );
}

export function CampaignsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useCursorNavigation();
  const [launching, setLaunching] = useState(false);
  const query = useCampaigns(navigation.cursor);
  const { writesAllowed, writeMode } = useControlState();
  const filter = searchParams.get("status") ?? "all";
  const items = (query.data?.items ?? []).filter(
    (item) => filter === "all" || item.status === filter,
  );
  const columns = useMemo<ColumnDef<CampaignRow>[]>(
    () => [
      {
        accessorKey: "campaign_id",
        header: () => <Hint text={hints.campaign.identity}>Run</Hint>,
        meta: { className: "min-w-0" },
        cell: ({ row }) => (
          <RunName
            campaignId={row.original.campaign_id}
            to={`/runs/${row.original.campaign_id}`}
          />
        ),
      },
      {
        accessorKey: "status",
        header: () => <Hint text={hints.campaign.status}>State</Hint>,
        cell: ({ row }) => (
          <Badge status={campaignResultStatus(row.original)}>
            {campaignStatusLabel(row.original)}
          </Badge>
        ),
      },
      {
        id: "progress",
        header: () => <Hint text={hints.campaign.logicalTasks}>Logical progress</Hint>,
        cell: ({ row }) => (
          <Progress
            label={`${row.original.terminal_tasks}/${row.original.total_tasks} tasks`}
            value={
              row.original.total_tasks
                ? (row.original.terminal_tasks / row.original.total_tasks) * 100
                : 0
            }
          />
        ),
      },
      {
        accessorKey: "observed_microusd",
        header: () => <Hint text={hints.campaign.observedCost}>Observed</Hint>,
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
        description="Each run locks a benchmark, model, harness, reasoning, runtime, and cost ceiling. Logical tasks stay sealed; only infrastructure failures can be replaced."
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
      {launching ? <LaunchPanel onClose={() => setLaunching(false)} /> : null}
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter runs">
        {["all", "active", "publishing", "completed", "cancelled"].map((status) => (
          <Button
            key={status}
            variant={filter === status ? "secondary" : "ghost"}
            onClick={() => setSearchParams(status === "all" ? {} : { status })}
          >
            {humanize(status)}
          </Button>
        ))}
      </nav>
      <QueryContent query={query}>
        <DataTable columns={columns} data={items} empty="No runs match this filter" />
        <CursorPager navigation={navigation} nextCursor={query.data?.next_cursor} />
      </QueryContent>
    </>
  );
}

export function CampaignPage() {
  const { campaignId = "" } = useParams();
  const navigation = useCursorNavigation();
  const campaign = useCampaign(campaignId);
  const capacity = useCapacity(campaignId);
  const tasks = useTasks(campaignId, navigation.cursor);
  const client = useQueryClient();
  const { writesAllowed, writeMode } = useControlState();
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
  if (!campaign.data)
    return (
      <QueryContent query={campaign}>
        <Empty>Run not found</Empty>
      </QueryContent>
    );
  const item = campaign.data;
  const columns: ColumnDef<TaskRow>[] = [
    {
      accessorKey: "task_id",
      header: () => <Hint text={hints.campaign.logicalTasks}>Task</Hint>,
      cell: ({ row }) => (
        <Link
          className="font-mono text-xs text-cyan-300 hover:underline"
          to={`/runs/${campaignId}/tasks/${row.original.task_id}`}
        >
          {shortId(row.original.task_id)}
        </Link>
      ),
    },
    {
      accessorKey: "terminal_outcome",
      header: () => <Hint text={hints.campaign.outcome}>Outcome</Hint>,
      cell: ({ getValue }) => (
        <OutcomeBadge outcome={String(getValue() ?? "pending")} />
      ),
    },
    {
      accessorKey: "selected_attempt_id",
      header: () => <Hint text={hints.campaign.selectedAttempt}>Selected attempt</Hint>,
      cell: ({ getValue }) => (
        <span className="font-mono text-xs">
          {getValue() ? shortId(String(getValue())) : "—"}
        </span>
      ),
    },
    {
      accessorKey: "input_digest",
      header: () => <Hint text={hints.campaign.inputDigest}>Input</Hint>,
      cell: ({ getValue }) => (
        <span className="font-mono text-xs text-slate-500">
          {shortId(String(getValue()))}
        </span>
      ),
    },
  ];
  return (
    <QueryContent query={campaign}>
      <PageHeader
        title={campaignId}
        titleClassName="break-all font-mono text-lg sm:text-xl"
        description="Run lock, logical outcomes, cost and publication state."
        action={
          !campaignIsFinished(item.status) ? (
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
          ) : undefined
        }
      />
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
              Target <span className="break-all font-mono text-xs">{campaignId}</span>{" "}
              has {item.total_tasks - item.terminal_tasks} open logical tasks.
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
          value={campaignStatusLabel(item)}
          note={campaignStatusNote(item)}
          icon={RefreshCw}
          hint={hints.campaign.status}
          status={campaignResultStatus(item)}
        />
        <Stat
          label="Logical tasks"
          value={`${item.terminal_tasks}/${item.total_tasks}`}
          note={`${item.pending_actions} pending actions`}
          icon={Clock3}
          hint={hints.campaign.logicalTasks}
        />
        <Stat
          label="Observed cost"
          value={formatMoney(item.observed_microusd)}
          note={`All recorded campaign sources. ${formatMoney(item.reserved_microusd)} reserved`}
          icon={CircleDollarSign}
          hint={hints.campaign.observedCost}
        />
        <Stat
          label="Endpoint cleanup"
          value={item.cleanup_pending ? "Pending" : "Clear"}
          note="Required before completion"
          icon={ShieldCheck}
          hint={hints.campaign.endpointCleanup}
        />
      </div>
      <Card className="my-6">
        <Progress
          label="Terminal logical outcomes"
          value={item.total_tasks ? (item.terminal_tasks / item.total_tasks) * 100 : 0}
        />
      </Card>
      {capacity.data ? (
        <Card className="my-6">
          <h2 className="text-base font-semibold text-white">Sandbox capacity</h2>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-slate-500">Campaign</dt>
              <dd className="mt-1">
                {capacity.data.campaign_active}/{capacity.data.campaign_limit} active
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Namespace</dt>
              <dd className="mt-1">
                {capacity.data.namespace_active}/
                {capacity.data.namespace_limit ?? "unconfigured"} active
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Provider requests</dt>
              <dd className="mt-1">
                {capacity.data.provider_reserved}/{capacity.data.provider_limit}{" "}
                reserved
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
              <dt className="text-slate-500">Queued creates</dt>
              <dd className="mt-1">{capacity.data.queued}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Cleanup-held slots</dt>
              <dd className="mt-1">{capacity.data.cleanup_held}</dd>
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
      <QueryContent query={tasks}>
        <DataTable
          columns={columns}
          data={tasks.data?.items ?? []}
          empty="No tasks are locked"
        />
        <CursorPager navigation={navigation} nextCursor={tasks.data?.next_cursor} />
      </QueryContent>
      <CampaignJobs campaignId={campaignId} />
    </QueryContent>
  );
}

export function TaskPage() {
  const { campaignId = "", taskId = "" } = useParams();
  const detail = useTask(campaignId, taskId);
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
        description="One logical task with every immutable physical attempt."
      />
      <Card>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">
              <Hint text={hints.campaign.outcome}>Outcome</Hint>
            </dt>
            <dd className="mt-1">
              <OutcomeBadge outcome={detail.data.task.terminal_outcome} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">
              <Hint text={hints.campaign.selectedAttempt}>Selected attempt</Hint>
            </dt>
            <dd className="mt-1 font-mono text-xs">
              {detail.data.task.selected_attempt_id ?? "—"}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-slate-500">
              <Hint text={hints.campaign.inputDigest}>Input digest</Hint>
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
                  Physical attempt {index + 1}
                </p>
                <p className="mt-1 font-mono text-sm">{attempt.attempt_id}</p>
              </div>
              <OutcomeBadge outcome={attempt.outcome} />
            </div>
            <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">
                  <Hint text={hints.campaign.replacementEligible}>
                    Replacement eligible
                  </Hint>
                </dt>
                <dd>{attempt.replacement_eligible ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  <Hint text={hints.campaign.attemptCost}>Cost</Hint>
                </dt>
                <dd>{formatMoney(attempt.cost_microusd)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  <Hint text={hints.campaign.attemptRecorded}>Recorded</Hint>
                </dt>
                <dd>{formatDate(attempt.created_at)}</dd>
              </div>
              <div className="sm:col-span-3">
                <dt className="text-slate-500">
                  <Hint text={hints.campaign.attemptMetrics}>Metrics</Hint>
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
      <CampaignJobs campaignId={campaignId} />
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
      accessorKey: "campaign_id",
      header: () => <Hint text={hints.endpoints.campaign}>Run</Hint>,
      meta: { className: "min-w-0" },
      cell: ({ getValue }) => (
        <RunName campaignId={String(getValue())} to={`/runs/${String(getValue())}`} />
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
      accessorKey: "campaign_id",
      header: () => <Hint text={hints.campaign.identity}>Run</Hint>,
      meta: { className: "min-w-0" },
      cell: ({ row }) => (
        <RunName
          campaignId={row.original.campaign_id}
          to={`/runs/${row.original.campaign_id}`}
        />
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
      cell: ({ row }) => String(row.original.agent ?? row.original.harness ?? "—"),
    },
    {
      id: "score",
      header: () => <Hint text={hints.results.primaryMetric}>Primary metric</Hint>,
      cell: ({ row }) => {
        const metric = row.original.primary_metric;
        return metric ? `${metric.value.toFixed(4)} ${metric.unit}` : "—";
      },
    },
    {
      id: "pass_rate",
      header: () => <Hint text={hints.results.passRate}>Pass rate</Hint>,
      cell: ({ row }) => formatPassRate(row.original),
    },
    {
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
          to={`/runs/${item.campaign_id}/tasks/${row.original.task_id}`}
        >
          {row.original.task_id}
        </Link>
      ),
    },
    {
      accessorKey: "outcome",
      header: () => <Hint text={hints.results.taskOutcome}>Outcome</Hint>,
      cell: ({ getValue }) => (
        <Badge status={String(getValue())}>{humanize(String(getValue()))}</Badge>
      ),
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
          note="Attempt receipts plus recorded Job and Sandbox hardware"
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
          <ResultField label="Agent" value={item.agent ?? item.harness} />
          <ResultField label="Outcome" value={item.run_outcome} />
          <ResultField label="Quality" value={item.quality} />
          <ResultField label="Status" value={item.status} />
          <ResultField label="Model revision" value={item.model_revision} />
          <ResultField label="Benchmark revision" value={item.benchmark_revision} />
          <ResultField label="Harness revision" value={item.harness_revision} />
          <div>
            <dt className="text-slate-500">Run</dt>
            <dd className="mt-1">
              <RunName campaignId={item.campaign_id} to={`/runs/${item.campaign_id}`} />
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
          <div className="font-medium">{row.original.name}</div>
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
      id: "record_id",
      header: () => <Hint text={hints.audit.identity}>Identity</Hint>,
      meta: { className: "min-w-0" },
      cell: ({ row }) => {
        const campaignId = row.original.data.campaign_id;
        if (typeof campaignId === "string")
          return <RunName campaignId={campaignId} to={`/runs/${campaignId}`} />;
        return (
          <span className="font-mono text-xs">
            {shortId(String(row.original.data.record_id ?? row.original.id))}
          </span>
        );
      },
    },
    {
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

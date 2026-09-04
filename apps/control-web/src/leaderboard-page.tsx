import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import type { LeaderboardRow } from "./api";
import { DataTable } from "./components/data-table";
import { PageHeader } from "./layout";
import {
  type LeaderboardPlotRow,
  LEADERBOARD_PLOT_SIZE,
  leaderboardPlotLayout,
} from "./leaderboard-plot";
import { formatMoneyUsd, formatPercent, humanize } from "./lib";
import { useLeaderboard } from "./queries";
import { Badge, Card, Empty, QueryContent } from "./ui";

function key(row: LeaderboardRow): string {
  return [
    row.benchmark,
    row.preset,
    row.agent,
    row.agent_version,
    row.model,
    row.provider,
    row.reasoning_effort,
    row.n_attempts,
  ].join("\u0000");
}

function plotRows(rows: LeaderboardRow[]): LeaderboardPlotRow[] {
  const values = rows
    .filter((row) => row.cost_usd !== null && row.n_trials > 0)
    .map((row) => ({
      key: key(row),
      model: row.model,
      agent: row.agent,
      cost_usd_per_trial: (row.cost_usd as number) / row.n_trials,
      pass_rate: row.pass_rate,
      pareto: false,
    }));
  return values.map((candidate) => ({
    ...candidate,
    pareto: !values.some(
      (other) =>
        other.key !== candidate.key &&
        other.cost_usd_per_trial <= candidate.cost_usd_per_trial &&
        other.pass_rate >= candidate.pass_rate &&
        (other.cost_usd_per_trial < candidate.cost_usd_per_trial ||
          other.pass_rate > candidate.pass_rate),
    ),
  }));
}

function ParetoPlot({ rows }: { rows: LeaderboardPlotRow[] }) {
  const layout = useMemo(() => leaderboardPlotLayout(rows), [rows]);
  const { width, height } = LEADERBOARD_PLOT_SIZE;
  const baseline = layout.top + layout.plotHeight;
  if (rows.length === 0) return null;
  return (
    <svg
      className="h-full w-full"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Observed cost per trial versus pass rate, with the Pareto frontier highlighted"
    >
      <title>Observed cost per trial versus pass rate</title>
      {layout.yTicks.map((tick) => (
        <g key={`y-${tick.value}`}>
          <line
            x1={layout.left}
            x2={layout.left + layout.plotWidth}
            y1={tick.y}
            y2={tick.y}
            stroke="#1e293b"
            strokeDasharray="4 6"
          />
          <text
            x={layout.left - 8}
            y={tick.y}
            dy="0.35em"
            textAnchor="end"
            className="fill-slate-400"
            fontSize="11"
          >
            {formatPercent(tick.value)}
          </text>
        </g>
      ))}
      {layout.xTicks.map((tick) => (
        <text
          key={`x-${tick.labelUsd}`}
          x={tick.x}
          y={height - 14}
          textAnchor="middle"
          className="fill-slate-400"
          fontSize="11"
        >
          {formatMoneyUsd(tick.labelUsd)}
        </text>
      ))}
      <line
        x1={layout.left}
        x2={layout.left + layout.plotWidth}
        y1={baseline}
        y2={baseline}
        stroke="#475569"
      />
      <line
        x1={layout.left}
        x2={layout.left}
        y1={layout.top}
        y2={baseline}
        stroke="#475569"
      />
      <text
        transform={`translate(14 ${layout.top + layout.plotHeight / 2}) rotate(-90)`}
        textAnchor="middle"
        className="fill-slate-400"
        fontSize="12"
      >
        Pass rate
      </text>
      <text
        x={layout.left + layout.plotWidth / 2}
        y={height - 2}
        textAnchor="middle"
        className="fill-slate-400"
        fontSize="12"
      >
        Observed cost per trial
      </text>
      {layout.frontier.length > 1 ? (
        <polyline
          points={layout.frontier.map((point) => `${point.x},${point.y}`).join(" ")}
          fill="none"
          stroke="#fbbf24"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : null}
      {layout.points.map((point) => (
        <circle
          key={point.row.key}
          cx={point.x}
          cy={point.y}
          r={5}
          fill={point.row.pareto ? "#fbbf24" : "#67e8f9"}
        >
          <title>{`${point.row.model} · ${point.row.agent}: ${formatPercent(point.row.pass_rate)} at ${formatMoneyUsd(point.row.cost_usd_per_trial)} per trial`}</title>
        </circle>
      ))}
    </svg>
  );
}

export function LeaderboardPage() {
  const query = useLeaderboard();
  const items = query.data ?? [];
  const chartRows = useMemo(() => plotRows(items), [items]);
  const columns: ColumnDef<LeaderboardRow>[] = [
    {
      accessorKey: "pass_rate",
      header: "Score",
      enableColumnFilter: false,
      cell: ({ getValue }) => (
        <span className="font-semibold text-cyan-300">
          {formatPercent(Number(getValue()))}
        </span>
      ),
    },
    {
      accessorKey: "model",
      header: "Model",
      cell: ({ row }) => (
        <span>
          <strong className="block text-slate-100">{row.original.model}</strong>
          <span className="text-xs text-slate-500">{row.original.provider}</span>
        </span>
      ),
    },
    {
      accessorKey: "agent",
      header: "Agent",
      cell: ({ row }) => `${row.original.agent} ${row.original.agent_version}`,
    },
    {
      accessorKey: "benchmark",
      header: "Benchmark",
      cell: ({ row }) => (
        <span>
          {row.original.benchmark}
          <span className="block text-xs text-slate-500">{row.original.preset}</span>
        </span>
      ),
    },
    {
      accessorKey: "n_trials",
      header: "Trials",
      enableColumnFilter: false,
    },
    {
      accessorKey: "reasoning_effort",
      header: "Reasoning",
      cell: ({ getValue }) => humanize(String(getValue())),
    },
    {
      accessorKey: "cost_usd",
      header: "Observed cost",
      enableColumnFilter: false,
      cell: ({ row }) => formatMoneyUsd(row.original.cost_usd),
    },
    {
      id: "frontier",
      header: "Frontier",
      enableColumnFilter: false,
      accessorFn: (row) =>
        chartRows.find((item) => item.key === key(row))?.pareto ?? false,
      cell: ({ getValue }) =>
        getValue() ? <Badge status="complete">Pareto</Badge> : "—",
    },
  ];
  return (
    <>
      <PageHeader
        title="Leaderboard"
        description="Final eligible Harbor runs, grouped by benchmark, model, provider, agent, and reasoning setting."
      />
      <QueryContent query={query}>
        {items.length === 0 ? (
          <Empty>No eligible completed runs are available.</Empty>
        ) : (
          <div className="space-y-6">
            {chartRows.length > 0 ? (
              <Card>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold">Cost and score frontier</h2>
                    <p className="mt-1 text-sm text-slate-400">
                      Gold points are not beaten by another row that is both cheaper and
                      higher scoring. Cost is normalized per scored trial.
                    </p>
                  </div>
                  <p className="font-mono text-xs text-slate-500">
                    {items.length} configurations
                  </p>
                </div>
                <div className="mt-4 h-80">
                  <ParetoPlot rows={chartRows} />
                </div>
              </Card>
            ) : null}
            <DataTable columns={columns} data={items} empty="No leaderboard rows" />
          </div>
        )}
      </QueryContent>
    </>
  );
}

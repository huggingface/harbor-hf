import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Leaderboard } from "./api";
import { DataTable } from "./components/data-table";
import { hints } from "./hints";
import { labeledHarness } from "./launch";
import { PageHeader } from "./layout";
import { LEADERBOARD_PLOT_SIZE, leaderboardPlotLayout } from "./leaderboard-plot";
import { formatDate, formatMoney, humanize } from "./lib";
import { useLeaderboard } from "./queries";
import { Badge, Card, Empty, Hint, QueryContent } from "./ui";

type LeaderboardRow = Leaderboard["items"][number];

function scoreLabel(row: {
  primary_metric_value: number;
  primary_metric_unit: string;
}): string {
  return `${row.primary_metric_value.toFixed(3)} ${row.primary_metric_unit}`;
}

function ParetoPlot({
  rows,
  activeId,
  onHover,
}: {
  rows: LeaderboardRow[];
  activeId: string | null;
  onHover(id: string | null): void;
}) {
  const layout = useMemo(() => leaderboardPlotLayout(rows), [rows]);
  const { width, height } = LEADERBOARD_PLOT_SIZE;
  const baseline = layout.top + layout.plotHeight;
  const active = layout.points.find((point) => point.row.publication_id === activeId);
  if (rows.length === 0) return null;
  return (
    <svg
      className="h-full w-full"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Cost versus score, with the Pareto frontier highlighted"
    >
      <title>Cost versus score, with the Pareto frontier highlighted</title>
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
            {tick.value.toFixed(2)}
          </text>
        </g>
      ))}
      {layout.xTicks.map((tick) => (
        <text
          key={`x-${tick.labelMicrousd}`}
          x={tick.x}
          y={height - 14}
          textAnchor="middle"
          className="fill-slate-400"
          fontSize="11"
        >
          {formatMoney(tick.labelMicrousd)}
        </text>
      ))}
      <line
        x1={layout.left}
        x2={layout.left}
        y1={layout.top}
        y2={baseline}
        stroke="#334155"
        strokeWidth="1.5"
      />
      <line
        x1={layout.left}
        x2={layout.left + layout.plotWidth}
        y1={baseline}
        y2={baseline}
        stroke="#334155"
        strokeWidth="1.5"
      />
      <text
        x={16}
        y={layout.top + layout.plotHeight / 2}
        transform={`rotate(-90 16 ${layout.top + layout.plotHeight / 2})`}
        textAnchor="middle"
        className="fill-slate-400"
        fontSize="12"
      >
        Score
      </text>
      <text
        x={layout.left + layout.plotWidth / 2}
        y={height - 2}
        textAnchor="middle"
        className="fill-slate-400"
        fontSize="12"
      >
        Observed cost (USD)
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
      {layout.points.map((point) => {
        const selected = point.row.publication_id === activeId;
        return (
          <Link
            key={point.row.publication_id}
            to={`/results/${point.row.publication_id}`}
            onMouseEnter={() => onHover(point.row.publication_id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(point.row.publication_id)}
            onBlur={() => onHover(null)}
          >
            <circle
              cx={point.x}
              cy={point.y}
              r={selected ? 7 : 5}
              fill={point.row.pareto ? "#fbbf24" : "#67e8f9"}
              stroke={selected ? "#f8fafc" : "none"}
              strokeWidth={selected ? 2 : 0}
            >
              <title>
                {`${point.row.model} ${labeledHarness(point.row.harness)}: ${scoreLabel(point.row)} at ${formatMoney(point.row.observed_microusd)}`}
              </title>
            </circle>
          </Link>
        );
      })}
      {active ? (
        <g>
          <rect
            x={Math.min(active.x + 10, width - 230)}
            y={Math.max(active.y - 52, 8)}
            width="220"
            height="48"
            rx="6"
            fill="#0f172a"
            stroke="#334155"
          />
          <text
            x={Math.min(active.x + 20, width - 220)}
            y={Math.max(active.y - 32, 24)}
            className="fill-slate-100"
            fontSize="11"
          >
            {`${active.row.model} · ${labeledHarness(active.row.harness)}`}
          </text>
          <text
            x={Math.min(active.x + 20, width - 220)}
            y={Math.max(active.y - 16, 40)}
            className="fill-slate-300"
            fontSize="11"
          >
            {`${scoreLabel(active.row)} · ${formatMoney(active.row.observed_microusd)}`}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

export function LeaderboardPage() {
  const query = useLeaderboard();
  const [activeId, setActiveId] = useState<string | null>(null);
  const items = query.data?.items ?? [];
  const columns: ColumnDef<LeaderboardRow>[] = [
    {
      accessorKey: "rank",
      header: () => <Hint text={hints.leaderboard.rank}>Rank</Hint>,
    },
    {
      accessorKey: "model",
      header: () => <Hint text={hints.leaderboard.model}>Model</Hint>,
      cell: ({ row }) => (
        <Link
          className="text-cyan-300 hover:underline"
          to={`/results/${row.original.publication_id}`}
        >
          {row.original.model}
        </Link>
      ),
    },
    {
      accessorKey: "harness",
      header: () => <Hint text={hints.leaderboard.harness}>Harness</Hint>,
      cell: ({ getValue }) => labeledHarness(String(getValue())),
    },
    {
      accessorKey: "benchmark",
      header: () => <Hint text={hints.leaderboard.benchmark}>Benchmark</Hint>,
    },
    {
      accessorFn: (row) => scoreLabel(row),
      id: "score",
      header: () => <Hint text={hints.leaderboard.score}>Score</Hint>,
      cell: ({ row }) => scoreLabel(row.original),
    },
    {
      accessorKey: "observed_microusd",
      header: () => <Hint text={hints.leaderboard.cost}>Cost</Hint>,
      cell: ({ getValue }) => formatMoney(Number(getValue())),
    },
    {
      accessorKey: "trial_count",
      header: () => <Hint text={hints.leaderboard.trials}>Trials</Hint>,
    },
    {
      accessorKey: "reasoning_effort",
      header: () => <Hint text={hints.leaderboard.reasoning}>Reasoning</Hint>,
      cell: ({ getValue }) => humanize(String(getValue())),
    },
    {
      accessorKey: "pareto",
      header: () => <Hint text={hints.leaderboard.pareto}>Frontier</Hint>,
      cell: ({ getValue }) =>
        getValue() ? <Badge status="complete">Pareto</Badge> : "—",
    },
    {
      accessorKey: "published_at",
      header: () => <Hint text={hints.leaderboard.published}>Published</Hint>,
      cell: ({ getValue }) => formatDate(String(getValue())),
    },
  ];
  return (
    <>
      <PageHeader
        title="Leaderboard"
        action={
          <Link
            to="/submissions"
            className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300"
          >
            Submit results
          </Link>
        }
        description="Admin-approved results. Only final, clean, fully scored hosted runs appear. Submission and publication are separate."
      />
      <QueryContent query={query}>
        {items.length === 0 ? (
          <Empty>
            No approved results yet. Submit an eligible hosted result for admin review.
          </Empty>
        ) : (
          <div className="space-y-6">
            <Card>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold">
                    <Hint text={hints.leaderboard.plot}>Cost and score frontier</Hint>
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">
                    Gold points are undominated: no other row is both cheaper and higher
                    scoring. Hover a point for the score and cost. Click to open the
                    publication.
                  </p>
                </div>
                {query.data?.snapshot ? (
                  <p className="font-mono text-xs text-slate-500">
                    {query.data.snapshot.entry_count} configurations
                  </p>
                ) : null}
              </div>
              <div className="mt-4 h-80">
                <ParetoPlot rows={items} activeId={activeId} onHover={setActiveId} />
              </div>
            </Card>
            <DataTable
              columns={columns}
              data={items}
              empty="No official leaderboard rows"
              rowClassName={(row) =>
                row.publication_id === activeId ? "bg-slate-800/80" : undefined
              }
            />
          </div>
        )}
      </QueryContent>
    </>
  );
}

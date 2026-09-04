export interface LeaderboardPlotRow {
  key: string;
  model: string;
  agent: string;
  cost_usd_per_trial: number;
  pass_rate: number;
  pareto: boolean;
}

export interface LeaderboardPlotPoint {
  x: number;
  y: number;
  row: LeaderboardPlotRow;
}

export interface LeaderboardPlotLayout {
  left: number;
  top: number;
  plotWidth: number;
  plotHeight: number;
  points: LeaderboardPlotPoint[];
  frontier: Array<{ x: number; y: number }>;
  xTicks: Array<{ x: number; labelUsd: number }>;
  yTicks: Array<{ y: number; value: number }>;
}

const WIDTH = 720;
const HEIGHT = 360;
const LEFT = 72;
const RIGHT = 24;
const TOP = 20;
const BOTTOM = 48;

function span(values: number[]): { min: number; max: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return { min: Math.max(0, min - pad), max: max + pad };
  }
  const pad = (max - min) * 0.08;
  return { min: Math.max(0, min - pad), max: max + pad };
}

/** Place observed cost per trial on X and pass rate on Y. */
export function leaderboardPlotLayout(
  rows: readonly LeaderboardPlotRow[],
): LeaderboardPlotLayout {
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  if (rows.length === 0) {
    return {
      left: LEFT,
      top: TOP,
      plotWidth,
      plotHeight,
      points: [],
      frontier: [],
      xTicks: [],
      yTicks: [],
    };
  }
  const xSpan = span(rows.map((row) => row.cost_usd_per_trial));
  const ySpan = span(rows.map((row) => row.pass_rate));
  const xScale = (value: number) =>
    LEFT + ((value - xSpan.min) / (xSpan.max - xSpan.min)) * plotWidth;
  const yScale = (value: number) =>
    TOP + plotHeight - ((value - ySpan.min) / (ySpan.max - ySpan.min)) * plotHeight;
  const points = rows.map((row) => ({
    x: xScale(row.cost_usd_per_trial),
    y: yScale(row.pass_rate),
    row,
  }));
  const frontier = [...points]
    .filter((point) => point.row.pareto)
    .sort((left, right) => left.row.cost_usd_per_trial - right.row.cost_usd_per_trial)
    .map((point) => ({ x: point.x, y: point.y }));
  return {
    left: LEFT,
    top: TOP,
    plotWidth,
    plotHeight,
    points,
    frontier,
    xTicks: [0, 0.5, 1].map((ratio) => ({
      x: LEFT + ratio * plotWidth,
      labelUsd: xSpan.min + ratio * (xSpan.max - xSpan.min),
    })),
    yTicks: [0, 0.5, 1].map((ratio) => ({
      y: TOP + plotHeight - ratio * plotHeight,
      value: ySpan.min + ratio * (ySpan.max - ySpan.min),
    })),
  };
}

export const LEADERBOARD_PLOT_SIZE = { width: WIDTH, height: HEIGHT };

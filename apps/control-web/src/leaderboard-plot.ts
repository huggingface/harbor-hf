export interface LeaderboardPlotRow {
  publication_id: string;
  model: string;
  harness: string;
  observed_microusd: number;
  primary_metric_value: number;
  primary_metric_unit: string;
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
  xTicks: Array<{ x: number; labelMicrousd: number }>;
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
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

/**
 * Place cost on X and score on Y. The frontier line follows rising cost.
 */
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
  const xSpan = span(rows.map((row) => row.observed_microusd));
  const ySpan = span(rows.map((row) => row.primary_metric_value));
  const xScale = (value: number) =>
    LEFT + ((value - xSpan.min) / (xSpan.max - xSpan.min)) * plotWidth;
  const yScale = (value: number) =>
    TOP + plotHeight - ((value - ySpan.min) / (ySpan.max - ySpan.min)) * plotHeight;
  const points = rows.map((row) => ({
    x: xScale(row.observed_microusd),
    y: yScale(row.primary_metric_value),
    row,
  }));
  const frontier = [...points]
    .filter((point) => point.row.pareto)
    .sort((left, right) => left.row.observed_microusd - right.row.observed_microusd)
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
      labelMicrousd: xSpan.min + ratio * (xSpan.max - xSpan.min),
    })),
    yTicks: [0, 0.5, 1].map((ratio) => ({
      y: TOP + plotHeight - ratio * plotHeight,
      value: ySpan.min + ratio * (ySpan.max - ySpan.min),
    })),
  };
}

export const LEADERBOARD_PLOT_SIZE = { width: WIDTH, height: HEIGHT };

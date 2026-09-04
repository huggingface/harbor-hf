import { describe, expect, it } from "vitest";
import { leaderboardPlotLayout } from "../src/leaderboard-plot";

describe("leaderboard plot layout", () => {
  it("places a cheaper higher-scoring point up and left of a dominated point", () => {
    const layout = leaderboardPlotLayout([
      {
        publication_id: "cheap-strong",
        model: "model-a",
        harness: "opencode",
        observed_microusd: 10_000,
        primary_metric_value: 0.9,
        primary_metric_unit: "score",
        pareto: true,
      },
      {
        publication_id: "costly-weak",
        model: "model-b",
        harness: "pi",
        observed_microusd: 90_000,
        primary_metric_value: 0.2,
        primary_metric_unit: "score",
        pareto: false,
      },
    ]);
    const cheap = layout.points.find(
      (point) => point.row.publication_id === "cheap-strong",
    );
    const costly = layout.points.find(
      (point) => point.row.publication_id === "costly-weak",
    );
    expect(cheap).toBeDefined();
    expect(costly).toBeDefined();
    expect(cheap?.x).toBeLessThan(costly?.x ?? 0);
    expect(cheap?.y).toBeLessThan(costly?.y ?? 0);
    expect(layout.frontier).toHaveLength(1);
    expect(layout.frontier[0]).toEqual({ x: cheap?.x, y: cheap?.y });
  });
});

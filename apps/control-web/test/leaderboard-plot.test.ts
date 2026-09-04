import { describe, expect, it } from "vitest";
import { leaderboardPlotLayout } from "../src/leaderboard-plot";

describe("leaderboard plot layout", () => {
  it("places a cheaper higher-scoring point up and left of a dominated point", () => {
    const layout = leaderboardPlotLayout([
      {
        key: "cheap-strong",
        model: "model-a",
        agent: "command-agent",
        cost_usd_per_trial: 0.01,
        pass_rate: 0.9,
        pareto: true,
      },
      {
        key: "costly-weak",
        model: "model-b",
        agent: "pi",
        cost_usd_per_trial: 0.09,
        pass_rate: 0.2,
        pareto: false,
      },
    ]);
    const cheap = layout.points.find((point) => point.row.key === "cheap-strong");
    const costly = layout.points.find((point) => point.row.key === "costly-weak");
    expect(cheap).toBeDefined();
    expect(costly).toBeDefined();
    expect(cheap?.x).toBeLessThan(costly?.x ?? 0);
    expect(cheap?.y).toBeLessThan(costly?.y ?? 0);
    expect(layout.frontier).toEqual([{ x: cheap?.x, y: cheap?.y }]);
  });

  it("returns an empty plot without invalid scales", () => {
    expect(leaderboardPlotLayout([])).toMatchObject({
      points: [],
      frontier: [],
      xTicks: [],
      yTicks: [],
    });
  });
});

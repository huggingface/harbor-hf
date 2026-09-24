import type { ReplacementView } from "../src/api";

export function noReplacements(runId: string): ReplacementView {
  return {
    run_id: runId,
    operator_selection: null,
    children: [],
    observed_at: "2026-01-01T00:00:00Z",
    assembly: { availability: "none", result: null },
    incurred: null,
    selected_cost_usd: null,
  };
}

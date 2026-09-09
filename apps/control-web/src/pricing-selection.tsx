import type { BrowserPricingV1 } from "@harbor-hf/contracts";
import type { ColumnDef } from "@tanstack/react-table";
import type { RunView } from "./api";
import { estimateScenario, reportedUsage } from "./pricing";
import { activeScenario, pricingStore, usePricingPreferences } from "./pricing-store";
import { CostValue } from "./run-summary-cards";

export function selectedEstimate(result: unknown, preferences: BrowserPricingV1) {
  const scenario = activeScenario(preferences);
  return scenario
    ? estimateScenario(reportedUsage(result), scenario[preferences.tier])
    : null;
}
export type ScenarioRun = RunView & { scenarioEstimate: number | null };
// New row objects invalidate TanStack's cached accessor values on preference changes.
export function scenarioRows(
  runs: RunView[],
  preferences: BrowserPricingV1,
): ScenarioRun[] {
  return runs.map((run) => ({
    ...run,
    scenarioEstimate: selectedEstimate(run.result, preferences),
  }));
}
export function scenarioCostColumn(): ColumnDef<ScenarioRun> {
  return {
    id: "scenarioEstimate",
    header: "Scenario estimate",
    accessorFn: (run) => run.scenarioEstimate ?? undefined,
    sortUndefined: "last",
    sortingFn: "basic",
    enableColumnFilter: false,
    cell: ({ row }) => (
      <CostValue value={row.original.scenarioEstimate} label="Scenario estimate USD" />
    ),
  };
}
export function PricingSelection({
  onSelect,
}: {
  onSelect?: (id: string | null) => void;
} = {}) {
  const { preferences, status, blocked, pending } = usePricingPreferences();
  return (
    <div className="my-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <label>
          Saved scenario{" "}
          <select
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
            aria-label="Saved scenario"
            value={preferences.selected_id ?? ""}
            disabled={blocked || pending}
            onChange={async (event) => {
              const id = event.target.value || null;
              if (await pricingStore.select(id)) onSelect?.(id);
            }}
          >
            <option value="">None</option>
            {preferences.scenarios.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scenario tier{" "}
          <select
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
            aria-label="Scenario tier"
            value={preferences.tier}
            disabled={blocked || pending}
            onChange={async (event) =>
              await pricingStore.select(
                preferences.selected_id,
                event.target.value === "longContext" ? "longContext" : "standard",
              )
            }
          >
            <option value="standard">All-standard</option>
            <option value="longContext">All-long-context</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-x-3 text-slate-400">
        <p>Saved in this browser</p>
        <details className="text-slate-400">
          <summary className="cursor-pointer">About scenario estimates</summary>
          <p>
            Uniform rates across all displayed runs and routes. Reported usage may be
            partial; estimates are not billing, recorded spend, or budget policy. No
            automatic prices or tiers. Save &amp; Use saves the name and all draft rates
            together. Draft previews do not change the selected estimate.
          </p>
          <p>
            Preferences belong to this browser origin, not your account. Clear saved
            pricing on shared browsers; do not enter secrets in names. Saving requires
            Web Locks support.
          </p>
        </details>
      </div>
      {status && (
        <p role="status" aria-label="Pricing storage status">
          {status}
        </p>
      )}
      {blocked && (
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            await pricingStore.reset();
          }}
        >
          Reset saved pricing
        </button>
      )}
    </div>
  );
}
export function ActiveScenarioEstimate({ result }: { result: unknown }) {
  const { preferences } = usePricingPreferences();
  return (
    <p>
      Scenario estimate:{" "}
      <CostValue
        value={selectedEstimate(result, preferences)}
        label="Scenario estimate USD"
      />
    </p>
  );
}

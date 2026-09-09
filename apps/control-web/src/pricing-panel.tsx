import { useEffect, useState } from "react";
import {
  DEFAULT_CONTEXT_THRESHOLD,
  MAX_TOKEN_RATE,
  parseRate,
  pricingScenarios,
  reportedUsage,
  TIER_LIMITATION,
} from "./pricing";
import { CostValue, ExactValue } from "./run-summary-cards";
import { Button, Card } from "./ui";
import { ActiveScenarioEstimate, PricingSelection } from "./pricing-selection";
import {
  activeScenario,
  pricingStore,
  usePricingPreferences,
  type SavedScenario,
  sameScenario,
} from "./pricing-store";

// Unsaved new-scenario draft lasts only for this tab; never used by the list.
const blankDraft = {
  name: "",
  input: "",
  output: "",
  cached: "",
  longInput: "",
  longOutput: "",
  longCached: "",
  threshold: String(DEFAULT_CONTEXT_THRESHOLD),
};
type Draft = typeof blankDraft;
type EditorState = { values: Draft; base: SavedScenario | undefined; dirty: boolean };
const drafts = new Map<string, EditorState>();
function savedDraft(selected: SavedScenario | undefined): EditorState {
  return {
    base: selected,
    dirty: false,
    values: selected
      ? {
          name: selected.name,
          input: String(selected.standard.input ?? ""),
          output: String(selected.standard.output ?? ""),
          cached: String(selected.standard.cached ?? ""),
          longInput: String(selected.longContext.input ?? ""),
          longOutput: String(selected.longContext.output ?? ""),
          longCached: String(selected.longContext.cached ?? ""),
          threshold: String(selected.threshold),
        }
      : { ...blankDraft },
  };
}
const fields = [
  ["input", "Standard input"],
  ["output", "Standard output"],
  ["cached", "Standard cached"],
  ["longInput", "Long-context input"],
  ["longOutput", "Long-context output"],
  ["longCached", "Long-context cached"],
] as const;

export function PricingPanel({ result }: { result: unknown }) {
  const { preferences } = usePricingPreferences();
  const [expanded, setExpanded] = useState(false);
  const active = activeScenario(preferences);
  const [editorId, setEditorId] = useState<string | null>(active?.id ?? null);
  const identity = editorId === null ? "new" : `saved:${editorId}`;
  useEffect(() => {
    if (!drafts.get(identity)?.dirty) setEditorId(active?.id ?? null);
  }, [active, identity]);
  const selected = preferences.scenarios.find((item) => item.id === editorId);
  return (
    <Card className="mt-4">
      <PricingSelection onSelect={setEditorId} />
      <ActiveScenarioEstimate result={result} />
      <PricingEditor
        key={identity}
        identity={identity}
        onSelect={setEditorId}
        selectionChanged={editorId !== (active?.id ?? null)}
        result={result}
        selected={selected}
        expanded={expanded}
        setExpanded={setExpanded}
      />
    </Card>
  );
}

function PricingEditor({
  identity,
  onSelect,
  selectionChanged,
  result,
  selected,
  expanded,
  setExpanded,
}: {
  identity: string;
  onSelect: (id: string | null) => void;
  selectionChanged: boolean;
  result: unknown;
  selected: SavedScenario | undefined;
  expanded: boolean;
  setExpanded: (value: boolean) => void;
}) {
  const { pending, preferences } = usePricingPreferences();
  const [editor, setEditor] = useState(
    () => drafts.get(identity) ?? savedDraft(selected),
  );
  const update = (next: EditorState) => {
    drafts.set(identity, next);
    setEditor(next);
  };
  useEffect(() => {
    if (!editor.dirty && !sameScenario(editor.base, selected)) {
      const next = savedDraft(selected);
      drafts.set(identity, next);
      setEditor(next);
    }
  }, [selected, editor, identity]);
  const rates = editor.values;
  const name = rates.name;
  const conflict =
    editor.dirty && (!sameScenario(editor.base, selected) || selectionChanged);
  const change = (key: keyof Draft, value: string) => {
    update({ ...editor, dirty: true, values: { ...rates, [key]: value } });
  };
  const estimates = pricingScenarios(
    reportedUsage(result),
    {
      input: parseRate(rates.input),
      output: parseRate(rates.output),
      cached: parseRate(rates.cached),
    },
    {
      input: parseRate(rates.longInput),
      output: parseRate(rates.longOutput),
      cached: parseRate(rates.longCached),
    },
  );
  const threshold = Number(rates.threshold);
  const validThreshold =
    rates.threshold.trim() !== "" && Number.isSafeInteger(threshold) && threshold >= 0;
  const valid =
    validThreshold &&
    name.trim().length > 0 &&
    name.trim().length <= 80 &&
    fields.every(([key]) => !rates[key].trim() || parseRate(rates[key]) !== null);
  const save = async () => {
    if (
      await pricingStore.save(
        {
          id: selected?.id,
          name: name.trim(),
          threshold,
          standard: {
            input: parseRate(rates.input),
            output: parseRate(rates.output),
            cached: parseRate(rates.cached),
          },
          longContext: {
            input: parseRate(rates.longInput),
            output: parseRate(rates.longOutput),
            cached: parseRate(rates.longCached),
          },
        },
        editor.base,
      )
    ) {
      const saved = activeScenario(pricingStore.getSnapshot().preferences);
      drafts.delete(identity);
      if (saved) drafts.set(`saved:${saved.id}`, savedDraft(saved));
      if (selected) update(savedDraft(saved));
      onSelect(saved?.id ?? null);
    }
  };
  return (
    <div>
      <details
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="cursor-pointer font-semibold">
          Pricing scenarios · editable USD / million tokens
        </summary>
        <fieldset disabled={pending}>
          {conflict && (
            <p role="alert">
              Saved scenario changed in another tab. Your draft is retained; reload
              saved values before saving.
            </p>
          )}
          <Button
            type="button"
            onClick={() => {
              drafts.delete(identity);
              const active = activeScenario(preferences);
              if (!selectionChanged) update(savedDraft(selected));
              onSelect(active?.id ?? null);
            }}
          >
            Reload saved values
          </Button>
          <label>
            Scenario name{" "}
            <input
              className="rounded border border-slate-700 bg-slate-950 p-2"
              aria-label="Scenario name"
              maxLength={80}
              value={name}
              onChange={(event) => change("name", event.target.value)}
            />
          </label>
          <div className="my-3 flex flex-wrap gap-3">
            <Button type="button" disabled={!valid || conflict} onClick={save}>
              Save &amp; Use
            </Button>
            <Button
              type="button"
              onClick={async () => {
                if (await pricingStore.select(null)) {
                  drafts.delete("new");
                  if (!selected) update(savedDraft(undefined));
                  onSelect(null);
                }
              }}
            >
              New scenario
            </Button>
            {selected && (
              <Button
                type="button"
                onClick={async () => {
                  if (await pricingStore.remove(selected.id, editor.base)) {
                    drafts.delete(`saved:${selected.id}`);
                    drafts.delete("new");
                    onSelect(null);
                  }
                }}
              >
                Delete scenario
              </Button>
            )}
            <Button
              type="button"
              onClick={async () => {
                if (await pricingStore.reset()) {
                  drafts.clear();
                  if (!selected) update(savedDraft(undefined));
                  onSelect(null);
                }
              }}
            >
              Clear saved pricing
            </Button>
          </div>
          <p className="my-2 text-sm">Draft previews (not applied to the Runs list)</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {fields.map(([key, label]) => {
              const invalid = rates[key] !== "" && parseRate(rates[key]) === null;
              return (
                <label key={key} className="text-sm">
                  {label} (USD/M)
                  <input
                    className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 p-2"
                    type="number"
                    aria-label={`${label} (USD/M)`}
                    min="0"
                    max={MAX_TOKEN_RATE}
                    step="any"
                    value={rates[key]}
                    aria-invalid={invalid}
                    onChange={(event) => change(key, event.target.value)}
                  />
                  {invalid && (
                    <span role="alert">
                      Enter a finite rate from 0 to {MAX_TOKEN_RATE}.
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          <label className="my-3 block text-sm">
            Long context when request input exceeds
            <input
              className="ml-2 rounded border border-slate-700 bg-slate-950 p-2"
              type="number"
              min="0"
              step="1"
              value={rates.threshold}
              aria-invalid={!validThreshold}
              onChange={(event) => change("threshold", event.target.value)}
            />{" "}
            tokens (including cache)
          </label>
          {!validThreshold && (
            <p role="alert">Enter a nonnegative whole-token threshold.</p>
          )}
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt>All-standard scenario</dt>
              <dd>
                <CostValue value={estimates.standard} label="Standard scenario USD" />
              </dd>
            </div>
            <div>
              <dt>All-long-context scenario</dt>
              <dd>
                <CostValue
                  value={estimates.longContext}
                  label="Long-context scenario USD"
                />
              </dd>
            </div>
            <div>
              <dt>Actual tier-adjusted estimate</dt>
              <dd>
                <ExactValue value={null} text="-" label="Actual tier-adjusted USD" />
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-sm text-slate-400">
            {TIER_LIMITATION} Missing usage or rates show “-”; zero is valid. Cached
            input is subtracted from standard input before applying its separate rate.
          </p>
        </fieldset>
      </details>
    </div>
  );
}

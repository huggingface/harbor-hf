import { useState } from "react";
import {
  DEFAULT_CONTEXT_THRESHOLD,
  MAX_TOKEN_RATE,
  parseRate,
  pricingScenarios,
  reportedUsage,
  TIER_LIMITATION,
} from "./pricing";
import { CostValue, ExactValue } from "./run-summary-cards";
import { Card } from "./ui";

// Browser-module lifetime only: retain edits through polling and route navigation,
// never write configuration, durable storage, or a server-side pricing record.
let draft = {
  input: "",
  output: "",
  cached: "",
  longInput: "",
  longOutput: "",
  longCached: "",
  threshold: String(DEFAULT_CONTEXT_THRESHOLD),
};
const fields = [
  ["input", "Standard input"],
  ["output", "Standard output"],
  ["cached", "Standard cached"],
  ["longInput", "Long-context input"],
  ["longOutput", "Long-context output"],
  ["longCached", "Long-context cached"],
] as const;

export function PricingPanel({ result }: { result: unknown }) {
  const [rates, setRates] = useState(() => ({ ...draft }));
  const change = (key: keyof typeof draft, value: string) => {
    setRates((previous) => {
      draft = { ...previous, [key]: value };
      return draft;
    });
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
  return (
    <Card className="mt-4">
      <details>
        <summary className="cursor-pointer font-semibold">
          Pricing scenarios · editable USD / million tokens
        </summary>
        <p className="my-3 text-sm text-slate-400">
          Uniform rates across all configured routes, chosen explicitly by you; no
          automatic provider prices. Edits remain during navigation in this browser tab
          until reload. Estimates use reported usage, which may be partial—not billing
          or recorded spend.
        </p>
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
          {TIER_LIMITATION} Missing usage or rates show “-”; zero is valid. Cached input
          is subtracted from standard input before applying its separate rate.
        </p>
      </details>
    </Card>
  );
}

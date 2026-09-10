import { useState } from "react";
import { parseRate } from "./pricing";
import type { WorkbenchDraft } from "./workbench-draft";

const messages = {
  setup_matches: "Pass setup for the current recipe.",
  direct_route:
    "Select an inference credential binding, or the legacy HF URL and key bindings.",
  confirmed: "Check the launch and cost confirmation after your final edit.",
  pricing_valid:
    "Correct the highlighted pricing fields; all three rates are required when recording prices.",
  reasoning_valid: "Correct the recorded reasoning intent.",
  writes_allowed: "Operator writes must be enabled to launch.",
  idle: "Wait for the current submission to finish.",
  operator: "Sign in with operator access.",
} as const;
export type LaunchChecks = Record<keyof typeof messages, boolean>;
type PricingDraft = NonNullable<WorkbenchDraft["pricing"]>;

export function LaunchReadiness({
  checks,
  pricing,
}: {
  checks: LaunchChecks;
  pricing: PricingDraft;
}) {
  const [copyMessage, setCopyMessage] = useState("");
  const keys = Object.keys(messages) as (keyof LaunchChecks)[];
  const blocked = keys.filter((key) => !checks[key]);
  // Explicit projection: never serialize recipes, identity, refs, or raw fields.
  const diagnostics = JSON.stringify(
    {
      checks: Object.fromEntries(keys.map((key) => [key, checks[key]])),
      pricing: {
        enabled: pricing.enabled,
        rates: Object.fromEntries(
          (["input", "cached", "output"] as const).map((key) => {
            const value = parseRate(pricing[key]);
            return [
              key,
              {
                state: !pricing[key].trim()
                  ? "blank"
                  : value === null
                    ? "invalid"
                    : "valid",
                usd_per_million: value,
              },
            ];
          }),
        ),
      },
      server_credential_approval: "checked by server on submission, not by setup",
    },
    null,
    2,
  );
  return (
    <section aria-label="Launch readiness" className="space-y-2 text-sm">
      <div id="workbench-launch-readiness" role="status">
        {blocked.length ? (
          <>
            <p className="font-medium text-amber-200">Launch is blocked:</p>
            <ul className="list-disc pl-5 text-amber-200">
              {blocked.map((key) => (
                <li key={key}>{messages[key]}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-emerald-300">
            Launch checks passed. Required form fields and server approval are still
            checked on submission.
          </p>
        )}
      </div>
      <p className="text-xs text-slate-400">
        Setup checks installation only. Review and approve credential use in Manage
        secrets for the current recipe, harness model and runner image. Pricing and
        benchmark changes do not require a new credential approval.
      </p>
      <details>
        <summary className="cursor-pointer text-sky-300">
          Show launch checks (no secrets)
        </summary>
        <textarea
          aria-label="Launch diagnostic summary"
          className="mt-2 h-48 w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs"
          readOnly
          value={diagnostics}
        />
        <button
          type="button"
          className="text-sky-300 underline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(diagnostics);
              setCopyMessage("Launch checks copied.");
            } catch {
              setCopyMessage(
                "Clipboard unavailable. Select and copy the summary above.",
              );
            }
          }}
        >
          Copy launch checks
        </button>
        <p role="status">{copyMessage}</p>
      </details>
    </section>
  );
}

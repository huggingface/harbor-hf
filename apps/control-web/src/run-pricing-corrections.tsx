import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PricingCorrectionRequestV1 } from "@harbor-hf/contracts";
import { api, type RunView } from "./api";
import { useControlState } from "./control-state";
import { finalizedPricing, pricingDescription } from "./launch-pricing";
import { keys } from "./queries";
import { Button } from "./ui";

export function RunPricingCorrections({ run }: { run: RunView }) {
  const { writesAllowed } = useControlState();
  const [editing, setEditing] = useState(false);
  const history = run.pricing_corrections;
  return (
    <section
      className="mb-4 rounded border border-slate-700 p-3 text-sm"
      aria-label="Shared pricing correction"
    >
      <details>
        <summary>Shared estimate rates · {history ? "corrected" : "launch"}</summary>
        <p>Original launch: {pricingDescription(run.record.pricing)}</p>
        <p>
          Reported native costs, execution, cost limits and browser scenarios never
          change.
        </p>
        {!run.pricing_corrections_available && (
          <p role="alert">
            Correction history unavailable. Shared estimates and editing are disabled;
            displayed history is last-known only.
          </p>
        )}
        <ol>
          {history?.revisions.map((entry) => (
            <li key={entry.revision} className="mt-2">
              Revision {entry.revision} · {entry.updated_at} · {entry.actor}
              <br />
              Reason: {entry.reason}
              <br />
              {pricingDescription(entry.pricing)}
            </li>
          ))}
        </ol>
      </details>
      {writesAllowed && !editing && (
        <Button
          variant="outline"
          disabled={
            !run.pricing_corrections_available ||
            (history?.revisions.length ?? 0) >= 1000
          }
          onClick={() => setEditing(true)}
        >
          {run.record.pricing || history
            ? "Correct shared rates"
            : "Add shared rates (unpriced launch)"}
        </Button>
      )}
      {writesAllowed && editing && (
        <CorrectionEditor run={run} close={() => setEditing(false)} />
      )}
    </section>
  );
}

function CorrectionEditor({ run, close }: { run: RunView; close: () => void }) {
  const client = useQueryClient();
  const [revision] = useState(run.pricing_corrections?.revisions.length ?? 0);
  const [draft, setDraft] = useState(() => {
    const pricing =
      run.pricing_corrections?.revisions.at(-1)?.pricing ?? run.record.pricing;
    return {
      enabled: true,
      input: pricing ? String(pricing.input_usd_per_million) : "",
      output: pricing ? String(pricing.output_usd_per_million) : "",
      cached: pricing ? String(pricing.cached_usd_per_million) : "",
    };
  });
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const pricing = finalizedPricing(draft);
  const reload = async () => {
    await Promise.all(
      [keys.run(run.record.run_id), keys.runs, keys.leaderboard].map((queryKey) =>
        client.invalidateQueries({ queryKey }, { throwOnError: true }),
      ),
    );
  };
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!pricing) throw new Error("All three finite nonnegative rates are required");
      const body: PricingCorrectionRequestV1 = {
        expected_revision: revision,
        reason: reason.trim(),
        pricing,
      };
      return api(
        `/api/v1/runs/${encodeURIComponent(run.record.run_id)}/pricing-corrections`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
    },
    onSuccess: async () => {
      setBlocked(true);
      try {
        await reload();
        close();
      } catch {
        /* Require a new review after ambiguous synchronization. */
      }
    },
    onError: async () => {
      setBlocked(true);
      try {
        await reload();
      } catch {
        /* Keep writes blocked. */
      }
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
      className="mt-3 space-y-2"
    >
      <p>
        USD per million tokens. Input includes cached tokens. Review output and cached
        rates carefully. This saves rates shared by all users, without rerunning.
      </p>
      {(["input", "output", "cached"] as const).map((key) => (
        <label key={key} className="block">
          {key} USD/M{" "}
          <input
            aria-label={`Correction ${key} USD/M`}
            type="number"
            min="0"
            max="1000000"
            step="any"
            required
            value={draft[key]}
            onChange={(event) => {
              setConfirmed(false);
              setDraft({ ...draft, [key]: event.target.value });
            }}
          />
        </label>
      ))}
      <label className="block">
        Reason{" "}
        <input
          aria-label="Correction reason"
          maxLength={1000}
          required
          value={reason}
          onChange={(event) => {
            setConfirmed(false);
            setReason(event.target.value);
          }}
        />
      </label>
      <p>
        {pricing
          ? pricingDescription(pricing)
          : "All three rates are required; zero is allowed, missing is not zero."}
      </p>
      <label className="block">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{" "}
        I confirm these shared rates and the audit reason.
      </label>
      <Button
        type="submit"
        disabled={
          !pricing ||
          !reason.trim() ||
          !confirmed ||
          blocked ||
          mutation.isPending ||
          !run.pricing_corrections_available ||
          revision !== (run.pricing_corrections?.revisions.length ?? 0)
        }
      >
        Save audited correction
      </Button>
      <Button type="button" variant="outline" onClick={close}>
        Close
      </Button>
      {(blocked || mutation.isError) && (
        <p role="alert">
          Review refreshed history before trying again. Close and reopen the editor; an
          uncertain save may already be durable.
        </p>
      )}
    </form>
  );
}

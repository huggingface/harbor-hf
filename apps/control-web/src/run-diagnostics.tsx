import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import type { RunView } from "./api";
import { categoryCounts, exceptionCategory } from "./exception-categories";
import { Badge, Card } from "./ui";

interface ExceptionGroup {
  type: string;
  trials: string[];
}

interface ExceptionProjection {
  complete: boolean;
  groups: ExceptionGroup[];
  affectedTrials: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function segment(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    // Malformed Unicode must not prevent the rest of the evidence rendering.
    return undefined;
  }
}

// Display-only projection of JobResult.stats.evals[*].exception_stats at dcd0a7ac.
// Never consult trial messages, tracebacks, rewards, or names for classification.
export function projectRunExceptions(result: unknown): ExceptionProjection {
  const evals = record(record(record(result)?.stats)?.evals);
  let complete = evals !== undefined;
  const groups = new Map<string, Set<string>>();
  for (const evaluation of Object.values(evals ?? {})) {
    const exceptions = record(record(evaluation)?.exception_stats);
    if (!exceptions) {
      complete = false;
      continue;
    }
    const evaluationTrials = new Set<string>();
    for (const [type, names] of Object.entries(exceptions)) {
      if (!type.trim() || !Array.isArray(names)) {
        complete = false;
        continue;
      }
      for (const name of names) {
        if (typeof name !== "string" || !name.trim() || segment(name) === undefined) {
          complete = false;
          continue;
        }
        const trials = groups.get(type) ?? new Set<string>();
        trials.add(name);
        evaluationTrials.add(name);
        groups.set(type, trials);
      }
    }
    const reported = record(evaluation)?.n_errors;
    if (
      reported !== undefined &&
      (!Number.isSafeInteger(reported) || reported !== evaluationTrials.size)
    )
      complete = false;
  }
  const sorted = [...groups.keys()].sort().map((type) => ({
    type,
    trials: [...(groups.get(type) ?? [])].sort(),
  }));
  const affectedTrials = new Set(sorted.flatMap((group) => group.trials)).size;
  const reportedErrors = record(record(result)?.stats)?.n_errored_trials;
  if (
    reportedErrors !== undefined &&
    (!Number.isSafeInteger(reportedErrors) || reportedErrors !== affectedTrials)
  )
    complete = false;
  return { complete, groups: sorted, affectedTrials };
}

const AGENT_TIMEOUT_HELP =
  "Agent execution timeouts are separate from infrastructure-related errors; native type alone does not prove timeout origin.";

const SCORING_CAVEAT = "Absence of recorded exceptions is not proof of valid scoring.";

function summary(evidence: ExceptionProjection): string {
  if (evidence.affectedTrials > 0) {
    return `${evidence.complete ? "" : "At least "}${evidence.affectedTrials} affected ${evidence.affectedTrials === 1 ? "trial" : "trials"}${evidence.complete ? "" : " · partial evidence"}`;
  }
  return evidence.complete ? "No recorded exceptions" : "Unknown / unavailable";
}

function evidenceCount(count: number, complete: boolean): string {
  return complete ? String(count) : count > 0 ? `≥${count}` : "-";
}

export function RunDiagnosticsSummary({ run }: { run: RunView }) {
  const evidence = projectRunExceptions(run.result);
  const runId = segment(run.record.run_id);
  const counts = categoryCounts(evidence.groups);
  const agentTimeouts =
    counts.categories.find((entry) => entry.category === "Agent execution timeout")
      ?.count ?? 0;
  const label = (
    <>
      <span className="block text-xs text-slate-400">Harbor-reported exceptions</span>
      <span className={evidence.affectedTrials > 0 ? "text-red-400" : "text-slate-400"}>
        {summary(evidence)}
      </span>
      <span
        className="block text-xs text-slate-400"
        title="Exact environment/transport and provider exception types only; not an inferred infrastructure cause"
      >
        Infra-related trials: {evidenceCount(counts.infra, evidence.complete)} ·
        unclassified:{" "}
        {evidenceCount(
          counts.categories.find((entry) => entry.category === "Unclassified")?.count ??
            0,
          evidence.complete,
        )}
      </span>
      {agentTimeouts > 0 && (
        <span className="block text-xs text-slate-400" title={AGENT_TIMEOUT_HELP}>
          Agent timeouts: {evidenceCount(agentTimeouts, evidence.complete)}
        </span>
      )}
      {evidence.complete && evidence.affectedTrials === 0 && (
        <span className="block text-xs text-slate-400">{SCORING_CAVEAT}</span>
      )}
    </>
  );
  return runId === undefined ? (
    <span>{label}</span>
  ) : (
    <Link className="text-cyan-300 hover:underline" to={`/runs/${runId}#diagnostics`}>
      {label}
    </Link>
  );
}

// Bound the initial DOM for both groups and names; retain full counts and make
// every remaining item available via native keyboard-accessible disclosure.
function BoundedItems<T>({
  items,
  renderItem,
  label,
}: {
  items: T[];
  renderItem: (item: T) => ReactNode;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ul className="space-y-2">{items.slice(0, 20).map(renderItem)}</ul>
      {items.length > 20 && (
        <details onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-cyan-300">
            Show {items.length - 20} more {label}
          </summary>
          {open && <ul className="space-y-2">{items.slice(20).map(renderItem)}</ul>}
        </details>
      )}
    </>
  );
}

export function RunDiagnostics({ run }: { run: RunView }) {
  const evidence = projectRunExceptions(run.result);
  const runId = segment(run.record.run_id);
  return (
    <Card id="diagnostics" role="region" aria-label="Harbor-reported exceptions">
      <h2 className="text-lg font-semibold">Harbor-reported exceptions</h2>
      <p className={evidence.affectedTrials > 0 ? "text-red-400" : "text-slate-400"}>
        {summary(evidence)}
      </p>
      <p className="text-sm text-slate-400">
        {categoryCounts(evidence.groups)
          .categories.map(
            ({ category, count }) =>
              `${category}: ${evidence.complete ? "" : "at least "}${count}`,
          )
          .join(" · ")}
      </p>
      {!evidence.complete && (
        <p className="text-sm text-slate-400">
          Exception evidence is missing or malformed. Counts shown cover only valid
          recorded trial names; full counts are unknown / unavailable.
        </p>
      )}
      <BoundedItems
        items={evidence.groups}
        label="exception types"
        renderItem={(group) => (
          <li key={group.type} className="break-words">
            <h3>
              <Badge>{group.type}</Badge> {evidence.complete ? "" : "At least "}
              <span
                className={group.trials.length > 0 ? "text-red-400" : "text-slate-400"}
              >
                {group.trials.length} {group.trials.length === 1 ? "trial" : "trials"}
              </span>
            </h3>
            <p className="text-xs text-slate-400">{exceptionCategory(group.type)}</p>
            <BoundedItems
              items={group.trials}
              label={`trial names for ${group.type}`}
              renderItem={(name) => (
                <li key={name}>
                  {runId === undefined ? (
                    name
                  ) : (
                    <Link
                      className="text-cyan-300 hover:underline"
                      to={`/runs/${runId}/trials/${segment(name)}`}
                    >
                      {name}
                    </Link>
                  )}
                </li>
              )}
            />
          </li>
        )}
      />
      <p className="mt-3 text-sm text-slate-400">
        {AGENT_TIMEOUT_HELP} Setup and verifier timeouts remain separate from agent
        execution timeouts. Measured wall time does not establish a numeric budget or
        budget exhaustion.
      </p>
      <p className="mt-3 text-sm text-slate-400">
        Completed includes errored trials. Infrastructure classification is not recorded
        by pinned Harbor and remains unknown. Root cause is not inferred. Display
        categories use only reviewed exact exception types; counts may overlap across
        categories. These are native exception groups, not root-cause classifications.
        This read-only view does not retry trials or modify scores. {SCORING_CAVEAT}
      </p>
    </Card>
  );
}

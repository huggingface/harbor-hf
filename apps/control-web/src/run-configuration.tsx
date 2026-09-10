import type { RunRecord } from "./api";
import { runAgentIdentities } from "./run-identity";
import { Card } from "./ui";

export function RunConfiguration({ record }: { record: RunRecord }) {
  const agents = runAgentIdentities(record);
  return (
    <Card className="mt-6" aria-label="Configured agents">
      <h2 className="font-semibold text-white">Configured agents</h2>
      <p className="mt-2 text-sm text-slate-400">
        These are stored Harbor JobConfig values, not verified provider requests.
        Missing reasoning options do not mean reasoning is off. Model-string and recipe
        options are preserved in JobConfig below, not interpreted here.
        Provider-effective reasoning and sampling are not established by these records.
      </p>
      <dl className="mt-3 text-sm">
        <dt className="text-slate-400">
          Recorded reasoning intent (submission metadata)
        </dt>
        <dd className="whitespace-pre-wrap break-all text-slate-200">
          {record.submission?.model?.reasoning_effort === ""
            ? "Unset (empty text)"
            : (record.submission?.model?.reasoning_effort ?? "Unavailable")}
        </dd>
      </dl>
      {agents.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">Agent configuration unavailable.</p>
      ) : (
        <ol className="mt-4 space-y-4">
          {agents.map((agent, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: immutable JobConfig entries retain their position and have no native ID.
            <li key={index} className="rounded-lg border border-slate-800 p-4">
              <h3 className="font-medium text-slate-200">Agent {index + 1}</h3>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                {[
                  ["Implementation", agent.agent],
                  ["Model / route", agent.model],
                  ["Configured version / source ref", agent.version],
                  ["Configured reasoning kwargs", agent.reasoning],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-slate-500">{label}</dt>
                    <dd className="mt-1 break-all text-slate-200">{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

import type { RunRecord } from "./api";
import { object } from "./launch-draft";

function scalar(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? value
    : typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ? String(value)
      : fallback;
}

/** Stored configuration, not proof of effective provider requests or defaults. */
export function runAgentIdentities(record: RunRecord) {
  const agents = Array.isArray(record.harbor_job_config.agents)
    ? record.harbor_job_config.agents.map(object)
    : [];
  return agents.map((agent) => {
    const kwargs = object(agent.kwargs);
    const options = ["thinking", "reasoning_effort"]
      .filter((key) => kwargs[key] !== undefined && kwargs[key] !== null)
      .map((key) => `${key}=${scalar(kwargs[key], "Unrecognized value")}`);
    return {
      model: scalar(agent.model_name, "Unspecified"),
      provider:
        scalar(agent.model_name, "").split(":").slice(1).join(":") || "Unspecified",
      agent: scalar(agent.import_path ?? agent.name, "Unspecified"),
      version: scalar(
        kwargs.version ?? object(kwargs.source).ref,
        "Not explicitly configured",
      ),
      reasoning: options.join(", ") || "Not recorded in native kwargs",
    };
  });
}

/** Aggregate labels are only for the table; detail preserves per-agent attribution. */
export function runIdentity(record: RunRecord) {
  const agents = runAgentIdentities(record);
  const join = (field: keyof (typeof agents)[number]) =>
    [...new Set(agents.map((agent) => agent[field]))].join(", ") || "Unavailable";
  return {
    model: join("model"),
    provider: join("provider"),
    agent: join("agent"),
    version: join("version"),
    reasoning: join("reasoning"),
  };
}

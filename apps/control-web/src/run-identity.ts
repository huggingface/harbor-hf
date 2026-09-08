import type { RunRecord } from "./api";
import { object } from "./launch-draft";

/** Display every native agent; never attribute a mixed run to its first agent. */
export function runIdentity(record: RunRecord) {
  const agents = Array.isArray(record.harbor_job_config.agents)
    ? record.harbor_job_config.agents.map(object)
    : [];
  const join = (values: string[]) => [...new Set(values)].join(", ") || "Unavailable";
  return {
    model: join(agents.map((agent) => String(agent.model_name ?? "Unspecified"))),
    provider: join(
      agents.map(
        (agent) =>
          String(agent.model_name ?? "")
            .split(":")
            .slice(1)
            .join(":") || "Unspecified",
      ),
    ),
    agent: join(
      agents.map((agent) => String(agent.import_path ?? agent.name ?? "Unspecified")),
    ),
    version: join(
      agents.map((agent) =>
        String(
          object(agent.kwargs).version ??
            object(object(agent.kwargs).source).ref ??
            "Harbor bundled",
        ),
      ),
    ),
    reasoning: join(
      agents.map((agent) =>
        String(
          object(agent.kwargs).thinking ??
            object(agent.kwargs).reasoning_effort ??
            "Native default",
        ),
      ),
    ),
  };
}

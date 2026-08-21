import { humanize } from "./lib";

export const REASONING_OPTIONS = [
  ["off", "None"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
] as const;

export type ReasoningOption = (typeof REASONING_OPTIONS)[number][0];
export type DeploymentKind = "providers" | "endpoints";

export type LaunchSelection = {
  model: string;
  harnessAgent: string;
  reasoning: ReasoningOption;
  deploymentKind: DeploymentKind;
};

type ApprovedProfile = {
  alias: string;
  spec: Record<string, unknown>;
};

export function approvedAlias(
  selected: string,
  available: readonly string[],
  kind = "profile",
): string {
  if (!available.includes(selected))
    throw new Error(`approved ${kind} ${selected || "selection"} is missing`);
  return selected;
}

export function doubleReservationMicrousd(estimatedMicrousd: number): number {
  return estimatedMicrousd * 2;
}

export function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function deploymentKind(
  spec: Record<string, unknown>,
): DeploymentKind | "other" {
  if (typeof spec.inference_provider === "string" && spec.inference_provider.length > 0)
    return "providers";
  const template = spec.sandbox_template;
  if (!template || typeof template !== "object") return "other";
  const upstream = (template as Record<string, unknown>).inference_upstream;
  if (typeof upstream !== "string" || upstream.length === 0) return "other";
  if (upstream.includes("router.huggingface.co")) return "providers";
  if (upstream === "<redacted>") return "other";
  return "endpoints";
}

export function harnessAgent(spec: Record<string, unknown>): string {
  const agent = spec.agent;
  if (typeof agent !== "string" || agent.length === 0)
    throw new Error("harness profile is missing agent");
  return agent;
}

export function harnessReasoning(spec: Record<string, unknown>): ReasoningOption {
  const value = spec.reasoning_effort;
  return REASONING_OPTIONS.some(([option]) => option === value)
    ? (value as ReasoningOption)
    : "off";
}

export function profileLabel(
  kind: string,
  alias: string,
  spec: Record<string, unknown>,
): string {
  if (kind === "benchmark") {
    const benchmark = typeof spec.benchmark === "string" ? spec.benchmark : alias;
    const sources = Array.isArray(spec.source_task_ids)
      ? new Set(spec.source_task_ids).size
      : 0;
    const tasks =
      sources > 0 ? sources : Array.isArray(spec.task_ids) ? spec.task_ids.length : 0;
    const trials = Array.isArray(spec.trial_indices)
      ? new Set(spec.trial_indices).size
      : 0;
    const name =
      benchmark === "terminal-bench-2-1" ? "Terminal-Bench 2.1" : humanize(benchmark);
    if (tasks === 0) return name;
    if (trials > 1)
      return `${name} · ${counted(tasks, "task")} with ${counted(trials, "trial")} each`;
    return `${name} · ${counted(tasks, "task")}`;
  }
  if (kind === "model")
    return typeof spec.model_id === "string" ? spec.model_id : alias;
  if (kind === "harness") {
    const agent = typeof spec.agent === "string" ? spec.agent : alias;
    if (agent === "opencode") return "OpenCode";
    if (agent === "pi") return "Pi";
    if (agent === "control-smoke") return "Control smoke";
    return humanize(agent);
  }
  return alias;
}

export function selectHarnessAlias(
  harnesses: ReadonlyArray<{ alias: string; spec: Record<string, unknown> }>,
  agent: string,
  reasoning: string,
): string {
  const match = harnesses.find(
    (item) =>
      harnessAgent(item.spec) === agent && harnessReasoning(item.spec) === reasoning,
  );
  if (!match)
    throw new Error(
      `no approved ${agent} harness with reasoning ${reasoning} is available`,
    );
  return match.alias;
}

export function selectDeploymentAlias(
  deployments: ReadonlyArray<ApprovedProfile>,
  kind: DeploymentKind,
  model: string,
  harness: string,
): string {
  const match = deployments.find((item) => {
    const models = item.spec.models;
    const harnesses = item.spec.harnesses;
    return (
      deploymentKind(item.spec) === kind &&
      Array.isArray(models) &&
      models.includes(model) &&
      Array.isArray(harnesses) &&
      harnesses.includes(harness)
    );
  });
  if (!match)
    throw new Error(
      `no approved ${kind} deployment is available for ${model} and ${harness}`,
    );
  return match.alias;
}

export function firstCompatibleLaunchSelection(
  models: ReadonlyArray<ApprovedProfile>,
  harnesses: ReadonlyArray<ApprovedProfile>,
  deployments: ReadonlyArray<ApprovedProfile>,
): LaunchSelection {
  const modelAliases = new Set(models.map((profile) => profile.alias));
  const harnessByAlias = new Map(harnesses.map((profile) => [profile.alias, profile]));
  for (const deployment of deployments) {
    const kind = deploymentKind(deployment.spec);
    if (kind === "other") continue;
    const deploymentModels = deployment.spec.models;
    const deploymentHarnesses = deployment.spec.harnesses;
    if (!Array.isArray(deploymentModels) || !Array.isArray(deploymentHarnesses))
      continue;
    for (const model of deploymentModels) {
      if (typeof model !== "string" || !modelAliases.has(model)) continue;
      for (const harnessAlias of deploymentHarnesses) {
        if (typeof harnessAlias !== "string") continue;
        const harness = harnessByAlias.get(harnessAlias);
        if (!harness) continue;
        const agent = harnessAgent(harness.spec);
        const reasoning = harnessReasoning(harness.spec);
        const selectedHarness = harnesses.find(
          (profile) =>
            harnessAgent(profile.spec) === agent &&
            harnessReasoning(profile.spec) === reasoning,
        );
        if (!selectedHarness || !deploymentHarnesses.includes(selectedHarness.alias))
          continue;
        return {
          model,
          harnessAgent: agent,
          reasoning,
          deploymentKind: kind,
        };
      }
    }
  }
  throw new Error("no compatible approved launch profile combination is available");
}

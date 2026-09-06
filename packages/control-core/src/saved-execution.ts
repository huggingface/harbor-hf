import { validateHarborJobConfig, sha256 } from "@harbor-hf/contracts";
import { listWorkbenchConfigurations } from "./saved-workbench.js";
import type { ObjectStore } from "./store.js";
import type { PresetCatalog, PresetSubmission } from "./presets.js";

export type ExecutionMode = "setup" | "benchmark";

/** Compose only agent settings; benchmark tasks, environment and retries stay native. */
export async function buildSavedExecution(
  store: ObjectStore,
  presets: PresetCatalog,
  subject: string,
  runId: string,
  input: PresetSubmission,
  mode: ExecutionMode,
) {
  if (input.harness.agent !== "workbench") {
    if (mode === "benchmark" && input.harness.agent === "fx")
      throw new Error(
        "FX gateway credentials are not supported by the HF inference runner",
      );
    const config = presets.buildJobConfig(runId, input, "/data");
    return mode === "setup" ? { ...config, install_only: true } : config;
  }
  const saved = (await listWorkbenchConfigurations(store, subject)).find(
    (item) => item.revision === input.harness.version,
  );
  if (!saved) throw new Error("Workbench version was not found for this owner");
  if (input.model.reasoning_effort !== "saved")
    throw new Error("Workbench agents use their saved reasoning settings");
  const fragment = saved.harbor_job_config as Record<string, unknown>;
  if (Object.keys(fragment).some((key) => key !== "agents"))
    throw new Error(
      "Workbench execution requires an agents-only fragment; benchmark settings come from the catalog",
    );
  if (!Array.isArray(fragment.agents) || fragment.agents.length !== 1)
    throw new Error("Workbench execution requires exactly one saved agent");
  const agent = fragment.agents[0] as Record<string, unknown>;
  if (
    mode === "benchmark" &&
    (agent.name === "fx" || JSON.stringify(agent).includes("AI_GATEWAY_API_KEY"))
  )
    throw new Error(
      "FX gateway credentials are not supported by the HF inference runner",
    );
  // Model and credentials are selected/injected at admission, never stored in drafts.
  for (const field of ["env", "model_name", "load_trajectory", "mcp_servers"]) {
    if (field in agent) throw new Error(`Workbench execution cannot override ${field}`);
  }
  const pi =
    agent.name === "pi" || agent.import_path === "harbor_hf_agents.pi.agent:PiAgent";
  const job = presets.benchmark(input.benchmark.name, input.benchmark.preset).job;
  return validateHarborJobConfig({
    ...structuredClone(job),
    job_name: "job",
    jobs_dir: `/data/runs/${runId}`,
    ...(mode === "setup" ? { install_only: true } : {}),
    agents: [
      {
        ...structuredClone(agent),
        model_name: `${pi ? "huggingface" : "openai"}/${input.model.id}:${input.model.provider}`,
        env: pi
          ? { HF_TOKEN: `\${HF_INFERENCE_TOKEN}` }
          : {
              OPENAI_BASE_URL: "https://router.huggingface.co/v1",
              OPENAI_API_KEY: `\${HF_INFERENCE_TOKEN}`,
            },
      },
    ],
  });
}

/** Run IDs and install-only mode differ; all effective setup inputs must match. */
export function setupContext(
  config: unknown,
  revision: string,
  image: string,
  hardware: string,
) {
  const native = structuredClone(config) as Record<string, unknown>;
  delete native.job_name;
  delete native.jobs_dir;
  delete native.install_only;
  return sha256(JSON.stringify({ revision, image, hardware, native }));
}

export function executionPrefix(subject: string) {
  return `workbench/executions/${sha256(subject)}/`;
}

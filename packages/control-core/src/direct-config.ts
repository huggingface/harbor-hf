import {
  type HarborJobConfigV1,
  validateHarborJobConfig,
  validateStrictHarborJobConfig,
} from "@harbor-hf/contracts";
import { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
import {
  INFERENCE_TOKEN_TEMPLATE,
  LABELED_ENVIRONMENT,
  ROUTER_URL,
} from "./hf-config.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function admittedEnvironment(value: unknown): Record<string, unknown> {
  const env = record(value ?? {}, "environment variables");
  for (const key of Object.keys(env)) {
    if (!["LANG", "LC_ALL", "TZ", "NO_COLOR", "TERM"].includes(key))
      throw new Error(`Environment variable ${key} is not admitted`);
  }
  return env;
}

export function prepareDirectJobConfig(
  runId: string,
  value: unknown,
  mountRoot: string,
): HarborJobConfigV1 {
  const input = record(structuredClone(value), "Harbor JobConfig");
  validateStrictHarborJobConfig(input);
  for (const field of [
    "extra_instruction_paths",
    "jobs_dir",
    "job_name",
    "source_jobs",
    "user_agent",
    "metrics",
    "artifacts",
    "install_only",
  ]) {
    if (field in input) throw new Error(`direct Harbor JobConfig cannot set ${field}`);
  }
  if (containsCredentialMaterial(input))
    throw new Error("direct Harbor JobConfig contains credential material");
  if (
    !Array.isArray(input.agents) ||
    input.agents.length < 1 ||
    input.agents.length > 8
  )
    throw new Error("direct Harbor JobConfig must contain one to eight agents");
  const agents = input.agents.map((item) => {
    const agent = record(item, "agent");
    for (const field of [
      "load_trajectory",
      "resume_trajectory",
      "skills",
      "mcp_servers",
      "extra_allowed_hosts",
      "include_logs",
      "exclude_logs",
    ]) {
      if (field in agent)
        throw new Error(`direct Harbor JobConfig agent cannot set ${field}`);
    }
    const env = admittedEnvironment(agent.env);
    // Credential delivery follows the explicit native route. The pinned native
    // inspector checks that route against the reviewed implementation template.
    const nativeHf =
      typeof agent.model_name === "string" &&
      agent.model_name.startsWith("huggingface/");
    const prefix = nativeHf ? "huggingface/" : "openai/";
    if (typeof agent.model_name !== "string" || !agent.model_name.startsWith(prefix))
      throw new Error(`agent model_name must use the ${prefix} route`);
    if (record(agent.kwargs ?? {}, "agent kwargs").model_api !== undefined)
      throw new Error("model_api is controlled by the reviewed HF integration");
    return {
      ...agent,
      env: {
        ...env,
        ...(nativeHf
          ? { HF_TOKEN: INFERENCE_TOKEN_TEMPLATE }
          : {
              OPENAI_BASE_URL: ROUTER_URL,
              OPENAI_API_KEY: INFERENCE_TOKEN_TEMPLATE,
            }),
      },
    };
  });
  for (const [index, item] of (Array.isArray(input.datasets)
    ? input.datasets
    : []
  ).entries()) {
    const dataset = record(item, `dataset ${index}`);
    if (dataset.path !== undefined && dataset.repo === undefined)
      throw new Error("direct Harbor JobConfig cannot use a local dataset path");
    if (dataset.download_dir !== undefined)
      throw new Error("direct Harbor JobConfig cannot set a dataset download path");
    if (dataset.registry_path !== undefined)
      throw new Error("direct Harbor JobConfig cannot set a dataset registry path");
    if (dataset.registry_url !== undefined)
      throw new Error("direct Harbor JobConfig cannot set a dataset registry URL");
  }
  const environment = record(
    input.environment ?? { type: "hf-sandbox" },
    "environment",
  );
  if (environment.type !== "hf-sandbox" || environment.import_path !== undefined)
    throw new Error("direct Harbor JobConfig must use hf-sandbox");
  for (const key of Object.keys(environment)) {
    if (!["type", "kwargs", "env", "delete"].includes(key))
      throw new Error(`HF Sandbox does not admit environment.${key}`);
  }
  if (environment.delete === false)
    throw new Error("HF Sandboxes must be deleted after execution");
  const kwargs = record(environment.kwargs ?? {}, "environment kwargs");
  for (const key of Object.keys(kwargs)) {
    if (!["flavor", "job_timeout"].includes(key))
      throw new Error(`environment.kwargs.${key} is not admitted`);
  }
  if (
    kwargs.flavor !== undefined &&
    !["cpu-basic", "cpu-upgrade"].includes(String(kwargs.flavor))
  )
    throw new Error("HF Sandbox flavor must be cpu-basic or cpu-upgrade");
  if (
    kwargs.job_timeout !== undefined &&
    (typeof kwargs.job_timeout !== "string" ||
      !/^[1-9][0-9]*(s|m|h)$/.test(kwargs.job_timeout))
  )
    throw new Error(
      "Sandbox idle timeout must be a positive duration, for example 30m",
    );
  const verifier = record(input.verifier ?? {}, "verifier");
  admittedEnvironment(verifier.env);
  if (Object.keys(record(verifier.kwargs ?? {}, "verifier kwargs")).length)
    throw new Error("Verifier kwargs require a reviewed integration");
  return validateHarborJobConfig({
    ...input,
    job_name: "job",
    jobs_dir: `${mountRoot}/runs/${runId}`,
    agents,
    environment: {
      import_path: LABELED_ENVIRONMENT,
      env: admittedEnvironment(environment.env),
      kwargs: { flavor: "cpu-basic", job_timeout: "30m", ...kwargs, run_label: runId },
    },
  });
}

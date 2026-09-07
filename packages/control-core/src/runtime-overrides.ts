import { validateHarborJobConfig, type HarborJobConfigV1 } from "@harbor-hf/contracts";
import { containsCredentialMaterial } from "./presets.js";

export interface HarnessRuntimeOverrides {
  model_name?: string | undefined;
  endpoint?: string | undefined;
  credentials?: "hf-inference" | "none" | undefined;
  environment?:
    | Array<
        | { name: string; value: string }
        | { name: string; secret_ref: "hf-inference-token" }
      >
    | undefined;
}

const HF_ENDPOINT = "https://router.huggingface.co/v1";
const TOKEN_REFERENCE = "$" + "{HF_INFERENCE_TOKEN}";
const COMMAND_AGENT = "harbor_hf_agents.command_agent.agent:CommandAgent";
const RESERVED =
  /^(?:HARBOR_.*|HF_.*|HOME|USER|LOGNAME|PATH|LD_.*|PYTHON.*|BASH_ENV|ENV|SHELL|IFS|CDPATH|NVM_DIR|DEBIAN_FRONTEND|OLDPWD|PWD|PROMPT_COMMAND|PS4|AGENT_HOME|TASK_INSTRUCTION_PATH|TASK_WORKSPACE|AGENT_RESULTS_PATH|AGENT_TRAJECTORY_PATH)$/;
const SENSITIVE_NAME = /(KEY|SECRET|TOKEN(?!S)|PASSWORD|CREDENTIAL|AUTH)/i;
const ENDPOINT_NAMES = new Set([
  "OPENAI_BASE_URL",
  "MODEL_BASE_URL",
  "ANTHROPIC_BASE_URL",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Apply only explicit overrides. Metadata is deliberately not used as a model alias. */
export function applyRuntimeOverrides(
  config: HarborJobConfigV1,
  overrides?: HarnessRuntimeOverrides,
) {
  overrides ??= {};
  if (containsCredentialMaterial(overrides))
    throw new Error("Runtime overrides contain credential material");
  const result = structuredClone(config);
  const agent = result.agents?.[0] as Record<string, unknown> | undefined;
  if (!agent) throw new Error("Runtime overrides require one agent");
  const generic = agent.import_path === COMMAND_AGENT;
  const credentials = overrides.credentials ?? "hf-inference";
  const endpoint = overrides.endpoint ?? HF_ENDPOINT;
  const url = new URL(endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Runtime endpoint must be an HTTP(S) URL without credentials, query or fragment",
    );
  if (credentials === "hf-inference" && endpoint !== HF_ENDPOINT)
    throw new Error(
      "HF inference credentials require the HF router endpoint; use no model credentials for an anonymous route",
    );
  if (credentials === "none" && !generic)
    throw new Error(
      "No model credentials currently requires a command harness with explicit isolated bindings",
    );
  if (overrides.model_name !== undefined) {
    if (
      !overrides.model_name ||
      [...overrides.model_name].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("Invalid exact harness model string");
    agent.model_name = overrides.model_name;
  }
  const env = record(agent.env);
  agent.env = credentials === "none" ? {} : env;
  if (
    credentials !== "none" &&
    ("OPENAI_BASE_URL" in env || overrides.endpoint !== undefined)
  )
    env.OPENAI_BASE_URL = endpoint;
  const command = record(record(agent.kwargs).config);
  const phases = generic ? [record(command.setup), record(command.run)] : [];
  if (credentials === "none") {
    for (const phase of phases) {
      const bindings = record(phase.bindings);
      const literals = record(phase.literals);
      phase.literals = literals;
      for (const [name, source] of Object.entries(bindings)) {
        if (source === "model_api_key") delete bindings[name];
        if (source === "model_base_url") {
          delete bindings[name];
          literals[name] = endpoint;
        }
      }
    }
  }
  const seen = new Set<string>();
  for (const entry of overrides.environment ?? []) {
    if (
      !/^[A-Z_][A-Z0-9_]*$/.test(entry.name) ||
      RESERVED.test(entry.name) ||
      seen.has(entry.name)
    )
      throw new Error(
        "Runtime environment names must be unique and not reserved infrastructure variables",
      );
    seen.add(entry.name);
    if ("secret_ref" in entry) {
      if (
        entry.secret_ref !== "hf-inference-token" ||
        credentials !== "hf-inference" ||
        entry.name !== "OPENAI_API_KEY"
      )
        throw new Error(
          "Only the declared HF inference reference bound to OPENAI_API_KEY is supported",
        );
      env[entry.name] = TOKEN_REFERENCE;
      if (generic) {
        const run = record(command.run);
        run.bindings = { ...record(run.bindings), [entry.name]: "model_api_key" };
        delete record(run.literals)[entry.name];
      }
      continue;
    }
    if (
      SENSITIVE_NAME.test(entry.name) ||
      containsCredentialMaterial(entry.value, entry.name) ||
      entry.value.includes("\0")
    )
      throw new Error(
        "Environment values must be non-secret literals; use a supported reference for credentials",
      );
    if (ENDPOINT_NAMES.has(entry.name) && entry.value !== endpoint)
      throw new Error(
        "Model endpoint variables must match the declared runtime endpoint",
      );
    if (generic) {
      // Command harnesses use clean environments. Updating agent.env alone would
      // silently drop these values before invocation.
      for (const phase of phases) {
        delete record(phase.bindings)[entry.name];
        phase.literals = { ...record(phase.literals), [entry.name]: entry.value };
      }
    } else {
      env[entry.name] = entry.value;
    }
  }
  if (credentials === "hf-inference") {
    for (const values of [
      record(agent.env),
      ...phases.map((phase) => record(phase.literals)),
    ]) {
      for (const name of ENDPOINT_NAMES) {
        if (name in values && values[name] !== HF_ENDPOINT)
          throw new Error(
            "Runtime endpoint literals conflict with the HF credential route",
          );
      }
    }
  }
  return validateHarborJobConfig(result);
}

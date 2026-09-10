import type { AgentWorkbenchRecipeV1 } from "@harbor-hf/contracts";

/** Opt-in declarative variation. Existing HF starters and saved drafts are untouched. */
export function nativeFastAgentStarter(
  base: AgentWorkbenchRecipeV1,
): AgentWorkbenchRecipeV1 {
  const recipe = structuredClone(base);
  return {
    ...recipe,
    name: "fast-agent-native",
    route_api: "native",
    environment: [
      ...recipe.environment.filter(
        (entry) => !["model_api_key", "model_base_url"].includes(entry.source),
      ),
      { name: "EXAMPLE_API_KEY", source: "model_api_key" },
    ],
    run_command: [
      "set -eu",
      'ca_bundle="$("$AGENT_HOME/venv/bin/python" -c \'import certifi; print(certifi.where())\')"',
      'test -r "$ca_bundle" || {',
      '  printf "%s\\n" "certifi CA bundle is not readable" >&2',
      "  exit 1",
      "}",
      'SSL_CERT_FILE="$ca_bundle" \\',
      '"$AGENT_HOME/venv/bin/fast-agent" go \\',
      '  --model "$AGENT_MODEL" \\',
      '  --prompt-file "$TASK_INSTRUCTION_PATH" \\',
      '  --workspace "$TASK_WORKSPACE" \\',
      '  --home "$AGENT_HOME/runtime" \\',
      '  --results "$AGENT_RESULTS_PATH" \\',
      '  --trajectory-output "$AGENT_TRAJECTORY_PATH" \\',
      "  --shell \\",
      "  --quiet",
    ].join("\n"),
  };
}

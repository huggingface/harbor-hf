import type {
  AgentWorkbenchRecipeV1,
  InferenceBindingManifestV1,
} from "@harbor-hf/contracts";
import { validateHarborJobConfig } from "@harbor-hf/contracts";
import { InferenceBindings, inferenceRecipeDigest } from "../src/inference-bindings.js";
import { compileAgentWorkbenchRecipe } from "../src/workbench.js";
export const image = `example.invalid/worker@sha256:${"a".repeat(64)}`;
export const actor = "synthetic-operator";
export function fixture(suffix = "EXAMPLE", baseUrl: string | null = null) {
  const recipe: AgentWorkbenchRecipeV1 = {
    schema_version: "v1",
    name: "synthetic-native",
    setup_command: "true",
    run_command: 'agent --model "$MODEL"',
    route_api: "native",
    setup_timeout_seconds: 30,
    environment: [
      {
        name: `${suffix}_API_KEY`,
        source: "model_api_key",
        credential_ref: `INFERENCE_API_KEY_${suffix}`,
      },
      { name: "MODEL", source: "model_name" },
      ...(baseUrl ? [{ name: "MODEL_URL", source: "model_base_url" as const }] : []),
    ],
    outputs: { results_path: "/logs/agent/result.json", trajectory_path: null },
  };
  const preview = compileAgentWorkbenchRecipe(recipe);
  const manifest: InferenceBindingManifestV1 = {
    schema_version: "v1",
    bindings: [
      {
        ref: `INFERENCE_API_KEY_${suffix}`,
        source_env: `INFERENCE_SECRET_${suffix}`,
        label: "Synthetic inference",
        enabled: true,
        uses: [
          {
            operator_subjects: [actor],
            worker_image: image,
            agent_import_path: preview.harbor_agent.import_path,
            recipe_digest: inferenceRecipeDigest(preview.harbor_agent),
            destination_env: [`${suffix}_API_KEY`],
            route_api: "native",
            allowed_models: [
              `${suffix.toLowerCase()}:unchanged/model`,
              "example:native",
            ],
            base_url: baseUrl,
            allowed_hosts: baseUrl ? [new URL(baseUrl).hostname] : [],
          },
        ],
      },
    ],
  };
  const policy = new InferenceBindings(manifest);
  const compile = () =>
    policy.compile(
      recipe,
      actor,
      image,
      `${suffix.toLowerCase()}:unchanged/model`,
      () => true,
    );
  const job = () => validateHarborJobConfig({ agents: [compile()] });
  return { recipe, manifest, policy, compile, job };
}

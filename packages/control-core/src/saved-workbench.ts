import {
  canonicalJson,
  type SavedWorkbenchConfigurationV1,
  sha256,
  validateSavedWorkbench,
  validateStrictHarborJobConfig,
} from "@harbor-hf/contracts";
import { createJson, type ObjectStore } from "./store.js";
import { containsCredentialMaterial } from "./presets.js";

function ownerPrefix(owner: string): string {
  return `workbench/configurations/${sha256(owner)}/`;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function containsSavedCredentialMaterial(input: {
  name: string;
  harbor_job_config: unknown;
}) {
  const copy = structuredClone(input);
  const agents = object(copy.harbor_job_config).agents;
  if (Array.isArray(agents)) {
    for (const candidate of agents) {
      const agent = object(candidate);
      if (agent.import_path !== "harbor_hf_agents.command_agent.agent:CommandAgent")
        continue;
      const run = object(object(object(agent.kwargs).config).run);
      const bindings = object(run.bindings);
      // These are explicit late-bound references, not credential values. No
      // exception for HF_TOKEN, arbitrary keys, other plugins or literal secrets.
      for (const name of ["OPENAI_API_KEY", "AI_GATEWAY_API_KEY"]) {
        if (bindings[name] === "model_api_key") delete bindings[name];
      }
    }
  }
  return containsCredentialMaterial(copy);
}
export async function saveWorkbenchConfiguration(
  store: ObjectStore,
  owner: string,
  input: { name: string; harbor_job_config: unknown },
): Promise<SavedWorkbenchConfigurationV1> {
  if (containsSavedCredentialMaterial(input))
    throw new Error("Workbench configuration contains credential material");
  const config = validateStrictHarborJobConfig(input.harbor_job_config);
  const content = { name: input.name, harbor_job_config: config };
  const record = validateSavedWorkbench({
    schema_version: "v1",
    revision: `sha256:${sha256(canonicalJson(content))}`,
    ...content,
  });
  await createJson(
    store,
    `${ownerPrefix(owner)}${record.revision.slice(7)}.json`,
    record,
  );
  return record;
}
export async function listWorkbenchConfigurations(
  store: ObjectStore,
  owner: string,
): Promise<SavedWorkbenchConfigurationV1[]> {
  const prefix = ownerPrefix(owner);
  const records = await Promise.all(
    (await store.list(prefix)).map(async (entry) => {
      const record = validateSavedWorkbench(
        JSON.parse(new TextDecoder().decode(await store.read(entry.key))),
      );
      const digest =
        "sha256:" +
        sha256(
          canonicalJson({
            name: record.name,
            harbor_job_config: record.harbor_job_config,
          }),
        );
      if (
        record.revision !== digest ||
        entry.key !== `${prefix}${digest.slice(7)}.json`
      )
        throw new Error("saved configuration integrity check failed");
      return record;
    }),
  );
  return records.sort(
    (a, b) => a.name.localeCompare(b.name) || a.revision.localeCompare(b.revision),
  );
}

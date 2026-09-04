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
export async function saveWorkbenchConfiguration(
  store: ObjectStore,
  owner: string,
  input: { name: string; harbor_job_config: unknown },
): Promise<SavedWorkbenchConfigurationV1> {
  if (containsCredentialMaterial(input))
    throw new Error("configuration contains credential material");
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

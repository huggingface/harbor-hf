import {
  canonicalJson,
  type SavedWorkbenchConfigurationV1,
  sha256,
  validateSavedWorkbench,
} from "@harbor-hf/contracts";
import { createJson, type ImmutableObjectStore } from "./store.js";
import { compileAgentWorkbenchRecipe } from "./workbench.js";

function ownerPrefix(owner: string): string {
  return `control/schema=v1/workbench/configurations/${sha256(owner).slice(7)}/`;
}

export async function saveWorkbenchConfiguration(
  store: ImmutableObjectStore,
  owner: string,
  input: unknown,
): Promise<SavedWorkbenchConfigurationV1> {
  const preview = compileAgentWorkbenchRecipe(input);
  const record: SavedWorkbenchConfigurationV1 = {
    schema_version: "v1",
    revision: preview.recipe_digest,
    recipe: preview.recipe,
  };
  await createJson(
    store,
    `${ownerPrefix(owner)}${record.revision.slice(7)}.json`,
    record,
  );
  return record;
}

export async function listWorkbenchConfigurations(
  store: ImmutableObjectStore,
  owner: string,
): Promise<SavedWorkbenchConfigurationV1[]> {
  const prefix = ownerPrefix(owner);
  const entries = await store.list(prefix);
  const records = await Promise.all(
    entries.map(async (entry) => {
      const record = validateSavedWorkbench<SavedWorkbenchConfigurationV1>(
        JSON.parse(new TextDecoder().decode(await store.read(entry.key))),
      );
      if (
        record.revision !== sha256(canonicalJson(record.recipe)) ||
        entry.key !== `${prefix}${record.revision.slice(7)}.json`
      )
        throw new Error("saved configuration integrity check failed");
      return record;
    }),
  );
  return records.sort(
    (a, b) =>
      a.recipe.name.localeCompare(b.recipe.name) ||
      a.revision.localeCompare(b.revision),
  );
}

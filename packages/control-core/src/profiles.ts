import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileObject, ResolvedProfile, TaskLock } from "@harbor-hf/contracts";
import {
  canonicalJson,
  deterministicId,
  sha256,
  validateControlRecord,
} from "@harbor-hf/contracts";

export interface LoadedProfile {
  profile: ProfileObject;
  profile_id: string;
}

async function jsonFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await jsonFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files.sort();
}

export async function loadBuiltInProfiles(root: string): Promise<LoadedProfile[]> {
  const output: LoadedProfile[] = [];
  for (const path of await jsonFiles(root)) {
    const raw = await readFile(path, "utf8");
    const value = validateControlRecord<ProfileObject>(JSON.parse(raw));
    if (value.kind !== "profile.object")
      throw new Error(`built-in profile is not a profile object: ${path}`);
    const expectedRecordId = deterministicId(
      "profile",
      value.profile_kind,
      value.name,
      sha256(canonicalJson(value.spec)),
    );
    if (value.record_id !== expectedRecordId)
      throw new Error(`built-in profile record ID is not content-derived: ${path}`);
    output.push({ profile: value, profile_id: sha256(canonicalJson(value)) });
  }
  return output;
}

export class ProfileResolutionError extends Error {}

function scalarArray(spec: ProfileObject["spec"], key: string): string[] {
  const value = (spec as unknown as Record<string, unknown>)[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ProfileResolutionError(`profile spec ${key} must be an array of strings`);
  }
  return value;
}

export class ProfileResolver {
  private readonly profiles: Map<string, LoadedProfile>;

  constructor(profiles: readonly LoadedProfile[]) {
    this.profiles = new Map(
      profiles.map((item) => [
        `${item.profile.profile_kind}:${item.profile.name}`,
        item,
      ]),
    );
  }

  get(kind: ProfileObject["profile_kind"], name: string): LoadedProfile {
    const profile = this.profiles.get(`${kind}:${name}`);
    if (!profile) throw new ProfileResolutionError(`unknown ${kind} profile: ${name}`);
    return profile;
  }

  selectDeployment(
    model: string,
    harness: string,
    requested?: string | null,
  ): LoadedProfile {
    if (requested) return this.get("deployment", requested);
    const candidates = [...this.profiles.values()].filter((item) => {
      if (item.profile.profile_kind !== "deployment") return false;
      return (
        scalarArray(item.profile.spec, "models").includes(model) &&
        scalarArray(item.profile.spec, "harnesses").includes(harness)
      );
    });
    if (candidates.length !== 1) {
      throw new ProfileResolutionError(
        `expected one compatible deployment, found ${candidates.length}`,
      );
    }
    return candidates[0] as LoadedProfile;
  }

  resolve(input: {
    benchmark: string;
    model: string;
    harness: string;
    deployment?: string | null;
    launch_policy: string;
  }): ResolvedProfile[] {
    const selected = [
      this.get("benchmark", input.benchmark),
      this.get("model", input.model),
      this.get("harness", input.harness),
      this.selectDeployment(input.model, input.harness, input.deployment),
      this.get("launch_policy", input.launch_policy),
    ];
    const deployment = selected[3] as LoadedProfile;
    if (
      !scalarArray(deployment.profile.spec, "models").includes(input.model) ||
      !scalarArray(deployment.profile.spec, "harnesses").includes(input.harness)
    ) {
      throw new ProfileResolutionError(
        "deployment is incompatible with the selected model or harness",
      );
    }
    return selected.map(
      (item) =>
        ({
          kind: item.profile.profile_kind,
          profile_id: item.profile_id,
          name: item.profile.name,
          spec: item.profile.spec,
        }) as ResolvedProfile,
    );
  }

  tasks(benchmark: string): TaskLock[] {
    const spec = this.get("benchmark", benchmark).profile.spec;
    const ids = scalarArray(spec, "task_ids");
    const digests = scalarArray(spec, "task_digests");
    if (ids.length !== digests.length || ids.length === 0)
      throw new ProfileResolutionError(
        "benchmark task IDs and digests must have equal non-zero length",
      );
    return ids.map((task_id, index) => ({
      task_id,
      input_digest: digests[index] as string,
    }));
  }

  sourceRevision(): string {
    return sha256(
      canonicalJson([...this.profiles.values()].map((item) => item.profile_id).sort()),
    );
  }
}

export function profileSpec<T>(
  profiles: readonly ResolvedProfile[],
  kind: ResolvedProfile["kind"],
): T {
  const profile = profiles.find((item) => item.kind === kind);
  if (!profile) throw new ProfileResolutionError(`resolved profile is missing ${kind}`);
  return profile.spec as T;
}

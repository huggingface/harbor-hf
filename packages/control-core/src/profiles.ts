import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BenchmarkProfileSpec,
  DeploymentProfileSpec,
  ProfileObject,
  ResolvedProfile,
  SandboxPolicy,
  TaskLock,
} from "@harbor-hf/contracts";
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

export interface PromotedProfile extends LoadedProfile {
  alias: string;
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

type TaskSandboxSpec = {
  task_id: string;
  source_task_id: string;
  trial_index: number;
  image: string;
  hardware: string;
  timeout_seconds: number;
  idle_timeout_seconds: number;
  reservation_microusd: number;
  active_hourly_cost_microusd: number;
  max_command_seconds: number;
};

function taskSandboxSpecs(deployment: DeploymentProfileSpec): TaskSandboxSpec[] | null {
  const value = (deployment as unknown as Record<string, unknown>).task_sandboxes;
  if (value === undefined) return null;
  if (!Array.isArray(value))
    throw new ProfileResolutionError("deployment task_sandboxes must be an array");
  return value as TaskSandboxSpec[];
}

export function validateTaskSandboxCoverage(
  deployment: DeploymentProfileSpec,
  tasks: readonly TaskLock[],
  benchmark?: BenchmarkProfileSpec,
): void {
  const specs = taskSandboxSpecs(deployment);
  if (!specs) return;
  if (
    benchmark &&
    (!benchmark.source_repository ||
      !benchmark.source_path ||
      !benchmark.trials_per_source_task)
  )
    throw new ProfileResolutionError(
      "task Sandbox profiles require a pinned benchmark source",
    );
  if (deployment.route !== "hf_job" || !deployment.sandbox)
    throw new ProfileResolutionError(
      "task Sandbox profiles require an HF Job deployment Sandbox policy",
    );
  const expected = new Set(tasks.map((task) => task.task_id));
  const seen = new Set<string>();
  const trials = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.task_id))
      throw new ProfileResolutionError(
        `duplicate task Sandbox profile: ${spec.task_id}`,
      );
    seen.add(spec.task_id);
    if (!expected.has(spec.task_id))
      throw new ProfileResolutionError(
        `task Sandbox profile is outside the benchmark: ${spec.task_id}`,
      );
    const trial = `${spec.source_task_id}:${spec.trial_index}`;
    if (trials.has(trial))
      throw new ProfileResolutionError(`duplicate source task trial: ${trial}`);
    trials.add(trial);
    if (
      spec.idle_timeout_seconds > spec.timeout_seconds ||
      spec.max_command_seconds > spec.timeout_seconds
    )
      throw new ProfileResolutionError(
        `task Sandbox time limits exceed lifetime: ${spec.task_id}`,
      );
  }
  if (seen.size !== expected.size || [...expected].some((task) => !seen.has(task)))
    throw new ProfileResolutionError(
      "task Sandbox profiles must cover every benchmark task exactly once",
    );
}

export function taskSandboxPolicy(
  deployment: DeploymentProfileSpec,
  taskId: string,
): SandboxPolicy | null {
  if (deployment.route !== "hf_job") return null;
  const base = deployment.sandbox;
  const specs = taskSandboxSpecs(deployment);
  if (!specs) return base ?? null;
  if (!base)
    throw new ProfileResolutionError("task Sandbox profile has no base policy");
  const selected = specs.find((spec) => spec.task_id === taskId);
  if (!selected)
    throw new ProfileResolutionError(`task Sandbox profile is missing: ${taskId}`);
  return {
    ...base,
    image: selected.image,
    hardware: selected.hardware,
    timeout_seconds: selected.timeout_seconds,
    idle_timeout_seconds: selected.idle_timeout_seconds,
    reservation_microusd: selected.reservation_microusd,
    active_hourly_cost_microusd: selected.active_hourly_cost_microusd,
    max_command_seconds: selected.max_command_seconds,
  };
}

export function taskSandboxSpec(
  deployment: DeploymentProfileSpec,
  taskId: string,
): TaskSandboxSpec | null {
  return taskSandboxSpecs(deployment)?.find((spec) => spec.task_id === taskId) ?? null;
}

function scalarArray(spec: ProfileObject["spec"], key: string): string[] {
  const value = (spec as unknown as Record<string, unknown>)[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ProfileResolutionError(`profile spec ${key} must be an array of strings`);
  }
  return value;
}

function profileKey(kind: ProfileObject["profile_kind"], alias: string): string {
  return `${kind}:${alias}`;
}

function indexProfiles<T extends LoadedProfile>(
  profiles: readonly T[],
  alias: (profile: T) => string,
): Map<string, LoadedProfile> {
  const output = new Map<string, LoadedProfile>();
  for (const item of profiles) {
    const key = profileKey(item.profile.profile_kind, alias(item));
    const existing = output.get(key);
    if (existing && existing.profile_id !== item.profile_id)
      throw new ProfileResolutionError(`conflicting profile alias: ${key}`);
    output.set(key, item);
  }
  return output;
}

export class ProfileResolver {
  private readonly builtInProfiles: Map<string, LoadedProfile>;
  private promotedProfiles = new Map<string, LoadedProfile>();

  constructor(profiles: readonly LoadedProfile[]) {
    this.builtInProfiles = indexProfiles(profiles, (item) => item.profile.name);
  }

  replacePromotedProfiles(profiles: readonly PromotedProfile[]): void {
    this.promotedProfiles = indexProfiles(profiles, (item) => item.alias);
  }

  private availableProfiles(): Map<string, LoadedProfile> {
    return new Map([...this.builtInProfiles, ...this.promotedProfiles]);
  }

  get(kind: ProfileObject["profile_kind"], name: string): LoadedProfile {
    const key = profileKey(kind, name);
    const profile = this.promotedProfiles.get(key) ?? this.builtInProfiles.get(key);
    if (!profile) throw new ProfileResolutionError(`unknown ${kind} profile: ${name}`);
    return profile;
  }

  selectDeployment(
    model: string,
    harness: string,
    requested?: string | null,
  ): LoadedProfile {
    if (requested) return this.get("deployment", requested);
    const candidates = new Map<string, LoadedProfile>();
    for (const item of this.availableProfiles().values()) {
      if (item.profile.profile_kind !== "deployment") continue;
      if (
        scalarArray(item.profile.spec, "models").includes(model) &&
        scalarArray(item.profile.spec, "harnesses").includes(harness)
      )
        candidates.set(item.profile_id, item);
    }
    if (candidates.size !== 1) {
      throw new ProfileResolutionError(
        `expected one compatible deployment, found ${candidates.size}`,
      );
    }
    return [...candidates.values()][0] as LoadedProfile;
  }

  resolve(input: {
    benchmark: string;
    model: string;
    harness: string;
    deployment?: string | null;
    launch_policy: string;
  }): ResolvedProfile[] {
    const deploymentProfile = this.selectDeployment(
      input.model,
      input.harness,
      input.deployment,
    );
    const selected: Array<[LoadedProfile, string]> = [
      [this.get("benchmark", input.benchmark), input.benchmark],
      [this.get("model", input.model), input.model],
      [this.get("harness", input.harness), input.harness],
      [deploymentProfile, input.deployment ?? deploymentProfile.profile.name],
      [this.get("launch_policy", input.launch_policy), input.launch_policy],
    ];
    const deployment = selected[3]?.[0] as LoadedProfile;
    if (
      !scalarArray(deployment.profile.spec, "models").includes(input.model) ||
      !scalarArray(deployment.profile.spec, "harnesses").includes(input.harness)
    ) {
      throw new ProfileResolutionError(
        "deployment is incompatible with the selected model or harness",
      );
    }
    return selected.map(
      ([item, alias]) =>
        ({
          kind: item.profile.profile_kind,
          profile_id: item.profile_id,
          name: alias,
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
    const aliases: Array<[string, string]> = [...this.availableProfiles()].map(
      ([alias, item]) => [alias, item.profile_id],
    );
    aliases.sort((left, right) => left[0].localeCompare(right[0]));
    return sha256(canonicalJson(aliases));
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

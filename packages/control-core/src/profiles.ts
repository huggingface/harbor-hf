import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BenchmarkProfileSpec,
  DeploymentProfileSpec,
  HarnessProfileSpec,
  ModelProfileSpec,
  PreparedTrial,
  ProfileObject,
  ResolvedProfile,
  SandboxPolicy,
  SandboxTemplate,
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

function objectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function preparationRequired(deployment: DeploymentProfileSpec): boolean {
  return deployment.route === "hf_job" && deployment.preparation === "required";
}

export function validatePreparedCampaignProfiles(
  deployment: DeploymentProfileSpec,
  benchmark: BenchmarkProfileSpec,
  model: ModelProfileSpec,
  harness: HarnessProfileSpec,
  tasks: readonly TaskLock[],
): void {
  if (!preparationRequired(deployment)) return;
  if (!objectValue(benchmark.harbor_job))
    throw new ProfileResolutionError(
      "prepared campaigns require a Harbor job in the benchmark profile",
    );
  if (!Array.isArray(benchmark.source_task_ids))
    throw new ProfileResolutionError(
      "prepared campaigns require benchmark source task IDs",
    );
  if (!Array.isArray(benchmark.trial_indices))
    throw new ProfileResolutionError(
      "prepared campaigns require benchmark trial numbers",
    );
  if (
    benchmark.source_task_ids.length !== tasks.length ||
    benchmark.trial_indices.length !== tasks.length
  )
    throw new ProfileResolutionError(
      "prepared benchmark task mappings must cover every logical task",
    );
  const sourceTrials = new Set<string>();
  for (const task of tasks) {
    if (!task.source_task_id || !task.trial_index)
      throw new ProfileResolutionError(
        `prepared benchmark task has no source mapping: ${task.task_id}`,
      );
    const sourceTrial = `${task.source_task_id}:${task.trial_index}`;
    if (sourceTrials.has(sourceTrial))
      throw new ProfileResolutionError(
        `duplicate benchmark source trial: ${sourceTrial}`,
      );
    sourceTrials.add(sourceTrial);
  }
  if (!model.harbor_model_name)
    throw new ProfileResolutionError(
      "prepared campaigns require a Harbor model name in the model profile",
    );
  if (!objectValue(harness.harbor_agent))
    throw new ProfileResolutionError(
      "prepared campaigns require a Harbor agent in the harness profile",
    );
  if (deployment.route !== "hf_job" || !deployment.sandbox_template)
    throw new ProfileResolutionError(
      "prepared campaigns require an HF Job Sandbox template",
    );
  if ((deployment.inference_token ?? "forbidden") !== "forbidden")
    throw new ProfileResolutionError(
      "prepared execution Jobs must not receive an inference credential",
    );
}

function selectFlavor(template: SandboxTemplate, trial: PreparedTrial) {
  const matches = template.flavors.filter(
    (flavor) =>
      flavor.cpus >= trial.cpus &&
      flavor.memory_mb >= trial.memory_mb &&
      flavor.storage_mb >= trial.storage_mb &&
      flavor.gpus >= trial.gpus,
  );
  matches.sort(
    (left, right) =>
      left.active_hourly_cost_microusd - right.active_hourly_cost_microusd ||
      left.gpus - right.gpus ||
      left.cpus - right.cpus ||
      left.memory_mb - right.memory_mb ||
      left.storage_mb - right.storage_mb ||
      left.hardware.localeCompare(right.hardware),
  );
  const selected = matches[0];
  if (!selected)
    throw new ProfileResolutionError(
      `no Sandbox flavor can run prepared task: ${trial.task_id}`,
    );
  return selected;
}

export function preparedSandboxPolicy(
  deployment: DeploymentProfileSpec,
  trial: PreparedTrial,
): SandboxPolicy {
  if (deployment.route !== "hf_job" || !deployment.sandbox_template)
    throw new ProfileResolutionError("deployment has no prepared Sandbox template");
  const template = deployment.sandbox_template;
  const {
    flavors: _flavors,
    default_cpus: _defaultCpus,
    default_memory_mb: _defaultMemory,
    default_storage_mb: _defaultStorage,
    default_gpus: _defaultGpus,
    max_timeout_seconds: _maxTimeout,
    lifetime_overhead_seconds: _lifetimeOverhead,
    idle_timeout_overhead_seconds: _idleOverhead,
    ...base
  } = template;
  const flavor = selectFlavor(template, trial);
  const maxCommandSeconds = Math.max(
    trial.agent_timeout_seconds,
    trial.verifier_timeout_seconds,
    trial.environment_build_timeout_seconds,
    trial.agent_setup_timeout_seconds,
  );
  const timeoutSeconds =
    trial.agent_timeout_seconds +
    trial.verifier_timeout_seconds +
    trial.environment_build_timeout_seconds +
    trial.agent_setup_timeout_seconds +
    template.lifetime_overhead_seconds;
  const idleTimeoutSeconds = Math.min(
    timeoutSeconds,
    maxCommandSeconds + template.idle_timeout_overhead_seconds,
  );
  if (
    maxCommandSeconds > template.max_command_seconds ||
    timeoutSeconds > template.max_timeout_seconds
  )
    throw new ProfileResolutionError(
      `prepared task time limits exceed deployment limits: ${trial.task_id}`,
    );
  return {
    ...base,
    image: trial.image,
    hardware: flavor.hardware,
    timeout_seconds: timeoutSeconds,
    idle_timeout_seconds: idleTimeoutSeconds,
    reservation_microusd: Math.ceil(
      (flavor.active_hourly_cost_microusd * timeoutSeconds) / 3600,
    ),
    active_hourly_cost_microusd: flavor.active_hourly_cost_microusd,
    max_command_seconds: maxCommandSeconds,
  };
}

export function staticSandboxPolicy(
  deployment: DeploymentProfileSpec,
): SandboxPolicy | null {
  if (deployment.route !== "hf_job") return null;
  return deployment.sandbox ?? null;
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
    const sources = (spec as BenchmarkProfileSpec).source_task_ids;
    const trialIndices = (spec as BenchmarkProfileSpec).trial_indices;
    if (
      (sources !== undefined || trialIndices !== undefined) &&
      (!Array.isArray(sources) ||
        !Array.isArray(trialIndices) ||
        sources.length !== ids.length ||
        trialIndices.length !== ids.length)
    )
      throw new ProfileResolutionError(
        "benchmark source task IDs and trial numbers must cover every task",
      );
    return ids.map((task_id, index) => ({
      task_id,
      input_digest: digests[index] as string,
      ...(sources && trialIndices
        ? {
            source_task_id: sources[index] as string,
            trial_index: trialIndices[index] as number,
          }
        : {}),
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

import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BenchmarkProfileSpec,
  DeploymentProfileSpec,
  HarnessProfileSpec,
  LaunchPolicySpec,
  ModelProfileSpec,
  PreparedTrial,
  ProfileObject,
  ResolvedExecutionContract,
  ResolvedProfile,
  TaskLock,
  TrialJobTemplate,
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
    assertActiveProfile(value, path);
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

function activeProfile(profile: ProfileObject): boolean {
  if (
    profile.profile_kind !== "model" &&
    profile.profile_kind !== "harness" &&
    profile.profile_kind !== "deployment"
  )
    return true;
  return (
    (profile.spec as unknown as { contract_version?: string }).contract_version === "v1"
  );
}

function assertActiveProfile(profile: ProfileObject, source: string): void {
  if (!activeProfile(profile))
    throw new ProfileResolutionError(
      `historical profile cannot enter the active catalog: ${source}`,
    );
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(arguments_: string[]): string {
  if (arguments_.length === 0)
    throw new ProfileResolutionError("job command must not be empty");
  return arguments_.map(shellQuote).join(" ");
}

function trialJobCommand(
  rootBootstrapCommand: string[],
  workerCommand: string[],
): [string, string, string] {
  return [
    "/bin/sh",
    "-c",
    [
      "set -eu",
      shellCommand(rootBootstrapCommand),
      "unset HF_INFERENCE_TOKEN HARBOR_HF_INFERENCE_TOKEN",
      `exec ${shellCommand(workerCommand)}`,
    ].join("\n"),
  ];
}

export function preparationRequired(deployment: DeploymentProfileSpec): boolean {
  return deployment.route === "hf_job" && deployment.preparation === "required";
}

export function validatePreparedRunProfiles(
  execution: ResolvedExecutionContract,
  benchmark: BenchmarkProfileSpec,
  tasks: readonly TaskLock[],
): void {
  const deployment = execution.deployment;
  if (!preparationRequired(deployment)) return;
  if (!objectValue(benchmark.harbor_job))
    throw new ProfileResolutionError(
      "prepared runs require a Harbor job in the benchmark profile",
    );
  if (!Array.isArray(benchmark.source_task_ids))
    throw new ProfileResolutionError("prepared runs require benchmark source task IDs");
  if (!Array.isArray(benchmark.trial_indices))
    throw new ProfileResolutionError("prepared runs require benchmark trial numbers");
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
  if (!execution.harbor_agent)
    throw new ProfileResolutionError(
      "prepared runs require a composed Harbor agent in the execution contract",
    );
  if (!execution.inference)
    throw new ProfileResolutionError(
      "prepared runs require composed inference settings in the execution contract",
    );
  if (!deployment.trial_job_template)
    throw new ProfileResolutionError("prepared runs require an HF trial Job template");
}

function selectFlavor(template: TrialJobTemplate, trial: PreparedTrial) {
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
      `no trial Job flavor can run prepared task: ${trial.task_id}`,
    );
  return selected;
}

export interface PreparedTrialJobLaunch {
  job_image: string;
  task_image: string;
  job_command: [string, ...string[]];
  hardware: string;
  timeout_seconds: number;
  active_hourly_cost_microusd: number;
  max_jobs: number;
  max_image_bytes: number;
  max_image_entries: number;
  inference_token: "forbidden" | "required";
  inference_upstream?: string;
  inference_model?: string;
  inference_api?: "chat-completions" | "responses";
  inference_max_requests?: number;
  inference_max_concurrency?: number;
  inference_max_total_concurrency?: number;
  inference_timeout_seconds?: number;
  inference_max_output_tokens?: number;
}

export function preparedTrialJobLaunch(
  execution: ResolvedExecutionContract,
  trial: PreparedTrial,
): PreparedTrialJobLaunch {
  const deployment = execution.deployment;
  if (!deployment.trial_job_template)
    throw new ProfileResolutionError("deployment has no prepared trial Job template");
  const template = deployment.trial_job_template;
  const flavor = selectFlavor(template, trial);
  if (!/^.+@sha256:[0-9a-f]{64}$/.test(deployment.job_image))
    throw new ProfileResolutionError(
      "prepared trial worker image must be digest-pinned",
    );
  if (deployment.job_image === trial.image)
    throw new ProfileResolutionError(
      "prepared trial worker image must differ from the benchmark task image",
    );
  const timeoutSeconds =
    trial.agent_timeout_seconds +
    trial.verifier_timeout_seconds +
    trial.environment_build_timeout_seconds +
    trial.agent_setup_timeout_seconds +
    template.lifetime_overhead_seconds;
  if (timeoutSeconds > template.max_timeout_seconds)
    throw new ProfileResolutionError(
      `prepared task time limits exceed deployment limits: ${trial.task_id}`,
    );
  return {
    job_image: deployment.job_image,
    task_image: trial.image,
    job_command: trialJobCommand(
      template.root_bootstrap_command,
      deployment.job_command,
    ),
    hardware: flavor.hardware,
    timeout_seconds: timeoutSeconds,
    active_hourly_cost_microusd: flavor.active_hourly_cost_microusd,
    max_jobs: template.max_jobs,
    max_image_bytes: template.max_image_bytes,
    max_image_entries: template.max_image_entries,
    inference_token: template.inference_token ?? "forbidden",
    ...(execution.inference
      ? {
          inference_upstream: execution.inference.upstream,
          inference_model: execution.inference.bridge_model,
          inference_api: execution.inference.api,
        }
      : {}),
    ...(template.inference_max_requests
      ? { inference_max_requests: template.inference_max_requests }
      : {}),
    ...(template.inference_max_concurrency
      ? { inference_max_concurrency: template.inference_max_concurrency }
      : {}),
    ...(template.inference_max_total_concurrency
      ? {
          inference_max_total_concurrency: template.inference_max_total_concurrency,
        }
      : {}),
    ...(template.inference_timeout_seconds
      ? { inference_timeout_seconds: template.inference_timeout_seconds }
      : {}),
    ...(template.inference_max_output_tokens
      ? { inference_max_output_tokens: template.inference_max_output_tokens }
      : {}),
  };
}

function scalarArray(spec: ProfileObject["spec"], key: string): string[] {
  const value = (spec as unknown as Record<string, unknown>)[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ProfileResolutionError(`profile spec ${key} must be an array of strings`);
  }
  return value;
}

function validateLaunchPolicyConstraints(
  benchmark: LoadedProfile,
  model: LoadedProfile,
  harness: LoadedProfile,
  deployment: LoadedProfile,
  launchPolicy: LoadedProfile,
): void {
  const benchmarkSpec = benchmark.profile.spec as BenchmarkProfileSpec;
  const policySpec = launchPolicy.profile.spec as LaunchPolicySpec;
  const constraints = policySpec.profile_constraints;
  if (benchmarkSpec.launch_policy_constraints_required && !constraints)
    throw new ProfileResolutionError(
      "benchmark requires a profile-constrained launch policy",
    );
  if (!constraints) return;
  const selected = {
    benchmarks: benchmark.profile.name,
    models: model.profile.name,
    harnesses: harness.profile.name,
    deployments: deployment.profile.name,
  } as const;
  for (const [kind, name] of Object.entries(selected)) {
    if (!constraints[kind as keyof typeof constraints].includes(name))
      throw new ProfileResolutionError(
        `launch policy is incompatible with the selected ${kind.slice(0, -1)}`,
      );
  }
}

function deploymentInferenceApi(
  spec: DeploymentProfileSpec,
): "chat-completions" | "responses" | "" | null {
  if (spec.route !== "hf_job") return null;
  const source = spec.trial_job_template ?? spec;
  const inferenceRequired =
    spec.inference_token === "required" ||
    spec.trial_job_template?.inference_token === "required";
  if (!inferenceRequired) return null;
  return source.inference_api ?? "";
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

function indexBuiltInProfiles(
  profiles: readonly LoadedProfile[],
): Map<string, LoadedProfile> {
  const output = indexProfiles(profiles, (item) => item.profile.name);
  for (const item of profiles) {
    const aliases = (item.profile.spec as { aliases?: readonly string[] }).aliases;
    for (const alias of aliases ?? []) {
      const key = profileKey(item.profile.profile_kind, alias);
      const existing = output.get(key);
      if (existing && existing.profile_id !== item.profile_id)
        throw new ProfileResolutionError(`conflicting profile alias: ${key}`);
      output.set(key, item);
    }
  }
  return output;
}

export class ProfileResolver {
  private readonly builtInProfiles: Map<string, LoadedProfile>;
  private promotedProfiles = new Map<string, LoadedProfile>();

  constructor(profiles: readonly LoadedProfile[]) {
    this.builtInProfiles = indexBuiltInProfiles(profiles);
  }

  replacePromotedProfiles(profiles: readonly PromotedProfile[]): void {
    this.promotedProfiles = indexProfiles(
      profiles.filter((item) => activeProfile(item.profile)),
      (item) => item.alias,
    );
  }

  /**
   * Prefer the deployed profile when an approved alias still points at an older
   * digest of the same checked-in name. Keep promotions that introduce a new
   * alias or remap a name to a different profile.
   */
  private resolveAlias(key: string): LoadedProfile | undefined {
    const builtIn = this.builtInProfiles.get(key);
    const promoted = this.promotedProfiles.get(key);
    if (builtIn && promoted && promoted.profile.name === builtIn.profile.name)
      return builtIn;
    return promoted ?? builtIn;
  }

  private availableProfiles(): Map<string, LoadedProfile> {
    const output = new Map<string, LoadedProfile>();
    for (const key of new Set([
      ...this.builtInProfiles.keys(),
      ...this.promotedProfiles.keys(),
    ])) {
      const profile = this.resolveAlias(key);
      if (profile) output.set(key, profile);
    }
    return output;
  }

  aliases(): Array<{
    kind: ProfileObject["profile_kind"];
    alias: string;
    profile_id: string;
  }> {
    return [...this.availableProfiles()].map(([key, profile]) => ({
      kind: profile.profile.profile_kind,
      alias: key.slice(key.indexOf(":") + 1),
      profile_id: profile.profile_id,
    }));
  }

  get(kind: ProfileObject["profile_kind"], name: string): LoadedProfile {
    const profile = this.resolveAlias(profileKey(kind, name));
    if (!profile) throw new ProfileResolutionError(`unknown ${kind} profile: ${name}`);
    return profile;
  }

  promoted(kind: ProfileObject["profile_kind"], alias: string): LoadedProfile {
    const profile = this.promotedProfiles.get(profileKey(kind, alias));
    if (!profile)
      throw new ProfileResolutionError(`unapproved ${kind} profile: ${alias}`);
    return profile;
  }

  selectDeployment(
    model: string,
    harness: string,
    requested?: string | null,
  ): LoadedProfile {
    if (requested) return this.get("deployment", requested);
    const modelProfile = this.get("model", model);
    const harnessProfile = this.get("harness", harness);
    const modelApis =
      (modelProfile.profile.spec as ModelProfileSpec).compatibility.inference_apis ??
      [];
    const harnessApis = (harnessProfile.profile.spec as HarnessProfileSpec).capabilities
      .inference_apis;
    const candidates = new Map<string, LoadedProfile>();
    for (const item of this.availableProfiles().values()) {
      if (item.profile.profile_kind !== "deployment") continue;
      if (
        !scalarArray(item.profile.spec, "models").includes(model) ||
        !scalarArray(item.profile.spec, "harnesses").includes(harness)
      )
        continue;
      const api = deploymentInferenceApi(item.profile.spec as DeploymentProfileSpec);
      if (
        api !== null &&
        (!api ||
          !(modelApis as readonly string[]).includes(api) ||
          !(harnessApis as readonly string[]).includes(api))
      )
        continue;
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
    const benchmark = selected[0]?.[0] as LoadedProfile;
    const model = selected[1]?.[0] as LoadedProfile;
    const harness = selected[2]?.[0] as LoadedProfile;
    const deployment = selected[3]?.[0] as LoadedProfile;
    const launchPolicy = selected[4]?.[0] as LoadedProfile;
    if (
      !scalarArray(deployment.profile.spec, "models").includes(input.model) ||
      !scalarArray(deployment.profile.spec, "harnesses").includes(input.harness)
    ) {
      throw new ProfileResolutionError(
        "deployment is incompatible with the selected model or harness",
      );
    }
    validateLaunchPolicyConstraints(
      benchmark,
      model,
      harness,
      deployment,
      launchPolicy,
    );
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
  profiles: readonly { kind: string; spec: unknown }[],
  kind: ResolvedProfile["kind"],
): T {
  const profile = profiles.find((item) => item.kind === kind);
  if (!profile) throw new ProfileResolutionError(`resolved profile is missing ${kind}`);
  return profile.spec as T;
}

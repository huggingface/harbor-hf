import type {
  BenchmarkConfig,
  ProfileList,
  WorkbenchPreview,
  WorkbenchSetup,
} from "./api";

export function approvedProfile(
  profiles: ProfileList["items"],
  kind: string,
  alias: string,
) {
  return profiles.find(
    (profile) =>
      profile.profile_kind === kind && profile.approved_aliases.includes(alias),
  );
}

/** Match display text to reviewed routes, never turn free text into an execution route. */
export function matchingConfigurations(
  configs: BenchmarkConfig[],
  profiles: ProfileList["items"],
  benchmark: string,
  model: string,
) {
  return configs.filter(
    (config) =>
      config.benchmark === benchmark &&
      approvedProfile(profiles, "model", config.model)?.spec.model_id === model,
  );
}

export function matchingSetup(preview: WorkbenchPreview, setups: WorkbenchSetup[]) {
  return setups.find(
    (setup) =>
      setup.status === "passed" &&
      setup.recipe_digest === preview.recipe_digest &&
      setup.revision_id === preview.revision_id,
  );
}

/** A UI hint only: the existing server resolver still validates all five profiles. */
export function builtinRouteAvailable(
  config: BenchmarkConfig,
  profiles: ProfileList["items"],
  harness: string,
): boolean {
  const deployment = approvedProfile(profiles, "deployment", config.deployment);
  return Boolean(
    approvedProfile(profiles, "harness", harness) &&
      Array.isArray(deployment?.spec.harnesses) &&
      deployment.spec.harnesses.includes(harness),
  );
}

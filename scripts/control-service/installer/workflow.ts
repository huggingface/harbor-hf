import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import type { ApplicationAuthFactory } from "./browser-auth.js";
import type { BucketWriteProbeAdapter } from "./bucket-write-probe.js";
import { canonicalJson } from "./canonical.js";
import type { InstallerClock } from "./clock.js";
import { ConfigureDiagnostics } from "./configure-diagnostics.js";
import {
  type ControlTokenScopeAdapter,
  ControlTokenScopeError,
} from "./control-token-scope.js";
import { type HfAdapter, HfCommandFailure } from "./hf.js";
import type { HttpAdapter } from "./http.js";
import type { IdentityAdapter } from "./identity.js";
import type { InferenceTokenScopeAdapter } from "./inference-token-scope.js";
import {
  assertManifestEqual,
  buildBundleManifest,
  createInstallId,
  expectedVariables,
  type InstallPhase,
  type InstallPlan,
  isInstallId,
  manifestDigest,
  parseTargetIds,
  type RemoteState,
  readPrivatePlan,
  SECRET_NAMES,
  type SpaceState,
  validateOrigin,
  workbenchVariables,
  writePrivatePlan,
} from "./model.js";
import type { SourceAdapter } from "./source.js";
import type { BootstrapReceipt } from "./state.js";

export interface InstallerDependencies {
  hf: HfAdapter;
  identity: IdentityAdapter;
  http: HttpAdapter;
  applicationAuth?: ApplicationAuthFactory;
  assertNotCancelled?: () => void;
  source: SourceAdapter;
  clock: InstallerClock;
  configureStartupPolicy?: ConfigureStartupPolicy;
  reportConfigureProgress?: (event: ConfigureProgressEvent) => void | Promise<void>;
  bucketWriteProbe?: BucketWriteProbeAdapter;
  controlTokenScope?: ControlTokenScopeAdapter;
  inferenceTokenScope?: InferenceTokenScopeAdapter;
  reportControlCredentialWarnings?: (warnings: readonly string[]) => void;
  environment?: NodeJS.ProcessEnv;
  secretInput?: InstallerSecretInput;
}

export interface InstallerSecretInput {
  read(name: "HF_TOKEN" | "HF_INFERENCE_TOKEN"): Promise<string | undefined>;
}

class InstallerInputError extends Error {}
class InstallerReadinessTimeoutError extends Error {}

export interface ConfigureStartupPolicy {
  runtimeHeartbeatMilliseconds: number;
  readinessPollMilliseconds: number;
  readinessHeartbeatMilliseconds: number;
  readinessTimeoutMilliseconds: number;
  readinessRequestTimeoutMilliseconds: number;
}

export type ConfigureProgressEvent =
  | { kind: "runtime_wait_started" }
  | { kind: "runtime_waiting"; elapsedMilliseconds: number }
  | { kind: "runtime_wait_complete"; elapsedMilliseconds: number }
  | { kind: "readiness_wait_started" }
  | { kind: "readiness_initializing"; elapsedMilliseconds: number }
  | { kind: "readiness_ready"; elapsedMilliseconds: number }
  | { kind: "readiness_timed_out"; elapsedMilliseconds: number };

export const DEFAULT_CONFIGURE_STARTUP_POLICY: ConfigureStartupPolicy = {
  runtimeHeartbeatMilliseconds: 30_000,
  readinessPollMilliseconds: 15_000,
  readinessHeartbeatMilliseconds: 60_000,
  readinessTimeoutMilliseconds: 90 * 60_000,
  readinessRequestTimeoutMilliseconds: 10_000,
};

function providerFailureSuffix(error: unknown): string {
  if (error instanceof HfCommandFailure) {
    return `; provider category: ${error.category}`;
  }
  return error instanceof InstallerReadinessTimeoutError
    ? "; verification category: readiness-timeout"
    : "";
}

function configureClock(dependencies: InstallerDependencies): InstallerClock {
  return dependencies.clock;
}

function configureStartupPolicy(
  dependencies: InstallerDependencies,
): ConfigureStartupPolicy {
  return dependencies.configureStartupPolicy ?? DEFAULT_CONFIGURE_STARTUP_POLICY;
}

function reportConfigureProgress(
  dependencies: InstallerDependencies,
  event: ConfigureProgressEvent,
): void {
  try {
    const pending = dependencies.reportConfigureProgress?.(event);
    if (pending) void pending.catch(() => undefined);
  } catch {
    // Progress output is observational and must not alter installer behavior.
  }
}

async function waitForConfigureRuntime(
  spaceId: string,
  dependencies: InstallerDependencies,
): Promise<void> {
  const clock = configureClock(dependencies);
  const policy = configureStartupPolicy(dependencies);
  const startedAt = clock.monotonicMilliseconds();
  const heartbeatController = new AbortController();
  reportConfigureProgress(dependencies, { kind: "runtime_wait_started" });
  const heartbeat = (async () => {
    while (!heartbeatController.signal.aborted) {
      await clock.sleep(
        policy.runtimeHeartbeatMilliseconds,
        heartbeatController.signal,
      );
      if (!heartbeatController.signal.aborted) {
        reportConfigureProgress(dependencies, {
          kind: "runtime_waiting",
          elapsedMilliseconds: Math.max(0, clock.monotonicMilliseconds() - startedAt),
        });
      }
    }
  })().catch(() => undefined);
  try {
    await dependencies.hf.wait(spaceId);
  } finally {
    heartbeatController.abort();
    await heartbeat;
  }
  reportConfigureProgress(dependencies, {
    kind: "runtime_wait_complete",
    elapsedMilliseconds: Math.max(0, clock.monotonicMilliseconds() - startedAt),
  });
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));
}

function legacyVariables(
  namespace: string,
  bucketId: string,
  origin: string,
  subject: string,
  revision: string,
): Record<string, string> {
  return {
    HARBOR_HF_AUTH_MODE: "oauth",
    HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS: subject,
    HARBOR_HF_BUCKET_ID: bucketId,
    HARBOR_HF_INSTALLER_MARKER: "harbor-hf.install-plan.v1",
    HARBOR_HF_INSTALLER_VERSION: "1",
    HARBOR_HF_NAMESPACE: namespace,
    HARBOR_HF_PUBLIC_ORIGIN: validateOrigin(origin),
    HARBOR_HF_SOURCE_REVISION: revision,
    HARBOR_HF_STORE_MODE: "bucket",
    HARBOR_HF_WRITE_MODE: "disabled",
  };
}

function isLegacySpace(space: SpaceState): boolean {
  return (
    space.variables.HARBOR_HF_INSTALLER_MARKER === "harbor-hf.install-plan.v1" &&
    space.variables.HARBOR_HF_INSTALLER_VERSION === "1"
  );
}

function assertLegacyInstalledSafe(
  state: RemoteState,
  expected: {
    spaceId: string;
    bucketId: string;
    namespace: string;
    subject: string;
  },
): void {
  const space = state.space;
  if (
    !space ||
    !isLegacySpace(space) ||
    space.id !== expected.spaceId ||
    !space.private ||
    space.sdk !== "docker" ||
    space.requestedHardware !== "cpu-basic" ||
    (space.hardware !== null && space.hardware !== "cpu-basic") ||
    !state.bucket ||
    state.bucket.id !== expected.bucketId ||
    !state.bucket.private ||
    !sameStrings(space.secretNames, SECRET_NAMES)
  ) {
    throw new Error("legacy installed resources do not match the installer contract");
  }
  const revision = space.variables.HARBOR_HF_SOURCE_REVISION;
  if (!revision || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("legacy Space source revision is invalid");
  }
  if (
    canonicalJson(space.variables) !==
    canonicalJson(
      legacyVariables(
        expected.namespace,
        expected.bucketId,
        space.origin,
        expected.subject,
        revision,
      ),
    )
  ) {
    throw new Error("legacy Space variables do not match");
  }
}

function assertRemoteSafe(
  state: RemoteState,
  expected: {
    spaceId: string;
    bucketId: string;
    variables: Record<string, string | null>;
  },
  options: { requireRunning: boolean; requireAllSecrets: boolean },
): void {
  if (!state.namespaceListingsComplete) {
    throw new Error("namespace listings are incomplete");
  }
  if (!state.space) {
    if (state.bucket) {
      throw new Error("an existing Bucket cannot be adopted without a marked Space");
    }
    return;
  }
  if (
    state.space.id !== expected.spaceId ||
    !state.space.private ||
    state.space.sdk !== "docker" ||
    state.space.requestedHardware !== "cpu-basic" ||
    (state.space.hardware !== null && state.space.hardware !== "cpu-basic") ||
    (options.requireRunning && state.space.hardware !== "cpu-basic") ||
    (expected.variables.HARBOR_HF_PUBLIC_ORIGIN !== null &&
      state.space.origin !== expected.variables.HARBOR_HF_PUBLIC_ORIGIN)
  ) {
    throw new Error("existing Space settings do not match the installer contract");
  }
  if (
    state.space.variables.HARBOR_HF_INSTALLER_MARKER !==
      expected.variables.HARBOR_HF_INSTALLER_MARKER ||
    state.space.variables.HARBOR_HF_INSTALLER_VERSION !==
      expected.variables.HARBOR_HF_INSTALLER_VERSION
  ) {
    throw new Error("existing Space is not installer-marked");
  }
  const expectedKeys = Object.keys(expected.variables).sort();
  const observedKeys = Object.keys(state.space.variables).sort();
  const partialKeys = expectedKeys.filter((key) => key !== "HARBOR_HF_PUBLIC_ORIGIN");
  const missingOnlyUnresolvedOrigin =
    JSON.stringify(partialKeys) === JSON.stringify(observedKeys) &&
    state.space.variables.HARBOR_HF_PUBLIC_ORIGIN === undefined;
  if (
    JSON.stringify(expectedKeys) !== JSON.stringify(observedKeys) &&
    !missingOnlyUnresolvedOrigin
  ) {
    throw new Error("existing Space variables do not match");
  }
  for (const [key, value] of Object.entries(expected.variables)) {
    if (key === "HARBOR_HF_PUBLIC_ORIGIN" && missingOnlyUnresolvedOrigin) continue;
    if (key === "HARBOR_HF_SOURCE_REVISION") {
      if (!/^[a-f0-9]{40}$/.test(state.space.variables[key] ?? "")) {
        throw new Error("existing Space source revision is invalid");
      }
    } else if (key === "HARBOR_HF_BUNDLE_MANIFEST_DIGEST") {
      if (!/^sha256:[a-f0-9]{64}$/.test(state.space.variables[key] ?? "")) {
        throw new Error("existing Space bundle manifest digest is invalid");
      }
    } else if (value === null || state.space.variables[key] !== value) {
      throw new Error("existing Space variables do not match");
    }
  }
  const unknownSecrets = state.space.secretNames.filter(
    (name) => !SECRET_NAMES.includes(name as (typeof SECRET_NAMES)[number]),
  );
  if (unknownSecrets.length > 0) throw new Error("existing Space has extra secrets");
  if (
    options.requireAllSecrets &&
    !sameStrings(state.space.secretNames, SECRET_NAMES)
  ) {
    throw new Error("Space secret names do not match");
  }
  if (options.requireRunning && state.space.runtimeStage !== "RUNNING") {
    throw new Error("Space runtime is not RUNNING");
  }
  if (state.bucket) {
    if (state.bucket.id !== expected.bucketId || !state.bucket.private) {
      throw new Error("existing Bucket does not match the installer contract");
    }
  }
}

function assertPreconditionsEqual(expected: RemoteState, observed: RemoteState): void {
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    throw new Error("remote preconditions drifted after planning");
  }
}

function variablesForPhase(
  plan: InstallPlan,
  origin: string | null,
  phase: InstallPhase,
): Record<string, string | null> {
  return expectedVariables(
    plan.targets.namespace,
    plan.targets.bucket_id,
    origin,
    plan.principal.subject,
    plan.source.revision,
    {
      installId: plan.install_id,
      manifestDigest: plan.bundle.manifest_digest,
      phase,
    },
    workbenchVariables(plan.expected_variables),
  );
}

function observedPhase(space: SpaceState): InstallPhase | null {
  const phase = space.variables.HARBOR_HF_INSTALL_PHASE;
  if (
    phase === "credentials_required" ||
    phase === "source_staged" ||
    phase === "installed"
  ) {
    return phase;
  }
  return null;
}

function isCredentialBootstrapStopped(runtimeStage: string | null): boolean {
  return runtimeStage === "PAUSED" || runtimeStage === "NO_APP_FILE";
}

function assertExactPlanBinding(plan: InstallPlan, state: RemoteState): void {
  const space = state.space;
  if (
    !space ||
    space.variables.HARBOR_HF_INSTALL_ID !== plan.install_id ||
    space.variables.HARBOR_HF_SOURCE_REVISION !== plan.source.revision ||
    space.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST !== plan.bundle.manifest_digest
  ) {
    throw new Error("remote bootstrap does not match the install plan");
  }
}

function assertFreshContinuationSafe(
  plan: InstallPlan,
  state: RemoteState,
): InstallPhase {
  const space = state.space;
  if (!space) throw new Error("remote bootstrap Space is missing");
  const phase = observedPhase(space);
  if (!phase) throw new Error("remote bootstrap phase is invalid");
  assertRemoteSafe(
    state,
    {
      spaceId: plan.targets.space_id,
      bucketId: plan.targets.bucket_id,
      variables: variablesForPhase(plan, space.origin, phase),
    },
    { requireRunning: false, requireAllSecrets: false },
  );
  assertExactPlanBinding(plan, state);
  return phase;
}

function assertFreshCompletionEntrySafe(
  plan: InstallPlan,
  state: RemoteState,
): InstallPhase {
  const phase = assertFreshContinuationSafe(plan, state);
  const space = state.space;
  if (!space || !state.bucket) {
    throw new Error("bootstrap resources are incomplete");
  }
  if (
    phase === "credentials_required" &&
    (!isCredentialBootstrapStopped(space.runtimeStage) || space.secretNames.length > 0)
  ) {
    throw new Error("credential bootstrap entry state is invalid");
  }
  if (
    phase === "source_staged" &&
    (space.runtimeStage !== "PAUSED" || space.sha === null)
  ) {
    throw new Error("source-staged bootstrap entry state is invalid");
  }
  if (phase === "installed" && !sameStrings(space.secretNames, SECRET_NAMES)) {
    throw new Error("installed bootstrap credential names do not match");
  }
  return phase;
}

function isFreshPlan(plan: InstallPlan): boolean {
  return (
    plan.observed_preconditions.space === null &&
    plan.observed_preconditions.bucket === null
  );
}

function isBootstrapPlan(plan: InstallPlan): boolean {
  const space = plan.observed_preconditions.space;
  return (
    space !== null &&
    (observedPhase(space) === "credentials_required" ||
      observedPhase(space) === "source_staged")
  );
}

function isCredentialRebindPlan(plan: InstallPlan): boolean {
  const observed = plan.observed_preconditions;
  return (
    observed.space !== null &&
    observedPhase(observed.space) === "credentials_required" &&
    observed.bucket === null &&
    (observed.space.variables.HARBOR_HF_SOURCE_REVISION !== plan.source.revision ||
      observed.space.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST !==
        plan.bundle.manifest_digest)
  );
}

function isLegacyMigrationPlan(plan: InstallPlan): boolean {
  return (
    plan.observed_preconditions.space !== null &&
    isLegacySpace(plan.observed_preconditions.space)
  );
}

function assertReceipt(
  plan: InstallPlan,
  planDigest: string,
  receipt: BootstrapReceipt,
): void {
  if (
    receipt.schema_version !== "harbor-hf.install-bootstrap-receipt.v1" ||
    receipt.install_id !== plan.install_id ||
    receipt.plan_digest !== planDigest ||
    receipt.space_id !== plan.targets.space_id ||
    receipt.bucket_id !== plan.targets.bucket_id ||
    receipt.source_revision !== plan.source.revision ||
    receipt.manifest_digest !== plan.bundle.manifest_digest
  ) {
    throw new Error("bootstrap receipt does not match the install plan");
  }
}

function assertManagedVariablesForPause(plan: InstallPlan, space: SpaceState): void {
  const phase = observedPhase(space);
  const sourceRevision = space.variables.HARBOR_HF_SOURCE_REVISION;
  const bundleDigest = space.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST;
  if (
    !phase ||
    !/^[a-f0-9]{40}$/.test(sourceRevision ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(bundleDigest ?? "")
  ) {
    throw new Error("managed Space binding is invalid");
  }
  const previous = plan.observed_preconditions.space?.variables;
  const acceptedBindings = [
    {
      source: plan.source.revision,
      manifest: plan.bundle.manifest_digest,
    },
    ...(previous
      ? [
          {
            source: previous.HARBOR_HF_SOURCE_REVISION,
            manifest: previous.HARBOR_HF_BUNDLE_MANIFEST_DIGEST,
          },
        ]
      : []),
  ];
  if (
    !acceptedBindings.some(
      (binding) =>
        binding.source === sourceRevision && binding.manifest === bundleDigest,
    )
  ) {
    throw new Error("managed Space binding changed");
  }
  const variables = expectedVariables(
    plan.targets.namespace,
    plan.targets.bucket_id,
    space.origin,
    plan.principal.subject,
    sourceRevision as string,
    {
      installId: plan.install_id,
      manifestDigest: bundleDigest as string,
      phase,
    },
    workbenchVariables(plan.expected_variables),
  );
  if (
    canonicalJson(space.variables) !== canonicalJson(variables) &&
    canonicalJson(space.variables) !== canonicalJson(nonNullVariables(variables)) &&
    canonicalJson(space.variables) !==
      canonicalJson(
        Object.fromEntries(
          Object.entries(nonNullVariables(variables)).filter(
            ([key]) => key !== "HARBOR_HF_PUBLIC_ORIGIN",
          ),
        ),
      )
  ) {
    throw new Error("managed Space variables changed");
  }
}

function assertLegacyVariablesForPause(plan: InstallPlan, space: SpaceState): void {
  const previous = plan.observed_preconditions.space;
  if (
    !previous ||
    !isLegacySpace(previous) ||
    !isLegacySpace(space) ||
    canonicalJson(space.variables) !== canonicalJson(previous.variables)
  ) {
    throw new Error("legacy managed Space variables changed");
  }
}

function assertPlanVariableTransitionSafe(plan: InstallPlan, state: RemoteState): void {
  const previous = plan.observed_preconditions.space;
  const space = state.space;
  if (
    !previous ||
    !space ||
    !state.namespaceListingsComplete ||
    space.id !== plan.targets.space_id ||
    !space.private ||
    space.sdk !== "docker" ||
    space.origin !== previous.origin ||
    space.requestedHardware !== "cpu-basic" ||
    (space.hardware !== null && space.hardware !== "cpu-basic") ||
    !state.bucket ||
    state.bucket.id !== plan.targets.bucket_id ||
    !state.bucket.private ||
    previous.secretNames.some((name) => !space.secretNames.includes(name)) ||
    space.secretNames.some(
      (name) => !SECRET_NAMES.includes(name as (typeof SECRET_NAMES)[number]),
    )
  ) {
    throw new Error("managed variable transition settings changed");
  }
  const next = concreteVariables(plan, space.origin);
  const keys = new Set([
    ...Object.keys(previous.variables),
    ...Object.keys(next),
    ...Object.keys(space.variables),
  ]);
  for (const key of keys) {
    const value = space.variables[key];
    if (value !== previous.variables[key] && value !== next[key]) {
      throw new Error("managed variable transition changed");
    }
  }
}

async function pauseManagedTarget(
  plan: InstallPlan,
  dependencies: InstallerDependencies,
  options: { pauseNoAppFile?: boolean } = {},
): Promise<void> {
  const observed = await dependencies.hf.observe(
    plan.targets.namespace,
    plan.targets.space_id,
    plan.targets.bucket_id,
  );
  const space = observed.space;
  if (
    !space ||
    space.id !== plan.targets.space_id ||
    !space.private ||
    space.sdk !== "docker" ||
    space.requestedHardware !== "cpu-basic"
  ) {
    return;
  }
  try {
    if (isLegacyMigrationPlan(plan) && isLegacySpace(space)) {
      assertLegacyVariablesForPause(plan, space);
    } else {
      assertManagedVariablesForPause(plan, space);
    }
  } catch {
    try {
      assertPlanVariableTransitionSafe(plan, observed);
    } catch {
      return;
    }
  }
  const phase = observedPhase(space);
  if (
    space.secretNames.some(
      (name) => !SECRET_NAMES.includes(name as (typeof SECRET_NAMES)[number]),
    ) ||
    (phase !== "credentials_required" &&
      (!observed.bucket ||
        observed.bucket.id !== plan.targets.bucket_id ||
        !observed.bucket.private))
  ) {
    return;
  }
  if (
    !options.pauseNoAppFile &&
    phase === "credentials_required" &&
    space.runtimeStage === "NO_APP_FILE"
  ) {
    return;
  }
  await dependencies.hf.pause(plan.targets.space_id);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

function assertPrivateOutputPaths(
  repositoryRoot: string,
  bundleDirectory: string,
  planPath: string,
): void {
  const bundle = resolve(bundleDirectory);
  const plan = resolve(planPath);
  if (
    isInside(repositoryRoot, bundle) ||
    isInside(repositoryRoot, plan) ||
    isInside(bundle, plan) ||
    isInside(plan, bundle)
  ) {
    throw new Error("bundle and plan paths must be separate and outside the checkout");
  }
}

export async function planInstall(
  input: {
    space: string;
    bucket?: string;
    bundleDirectory: string;
    planPath: string;
  },
  dependencies: InstallerDependencies,
): Promise<{ path: string; digest: string; plan: InstallPlan }> {
  const ids = parseTargetIds(input.space, input.bucket);
  const sourceBefore = await dependencies.source.inspect();
  assertPrivateOutputPaths(
    sourceBefore.repositoryRoot,
    input.bundleDirectory,
    input.planPath,
  );
  const hfCliVersion = await dependencies.hf.version();
  const principal = await dependencies.identity.resolve();
  await mkdir(resolve(input.bundleDirectory, ".."), { recursive: true });
  await dependencies.source.bundle(input.bundleDirectory);
  const sourceAfter = await dependencies.source.inspect();
  if (canonicalJson(sourceBefore) !== canonicalJson(sourceAfter)) {
    throw new Error("source changed while planning");
  }
  const manifest = await buildBundleManifest(input.bundleDirectory);
  const bundleManifestDigest = manifestDigest(manifest);
  const observed = await dependencies.hf.observe(
    ids.namespace,
    ids.spaceId,
    ids.bucketId,
  );
  const observedInstallId = observed.space?.variables.HARBOR_HF_INSTALL_ID;
  const installId = observedInstallId ?? createInstallId();
  if (!isInstallId(installId)) {
    throw new Error("existing Space install ID is invalid");
  }
  const origin = observed.space?.origin ?? null;
  const workbench = workbenchVariables(observed.space?.variables ?? {});
  const variables = expectedVariables(
    ids.namespace,
    ids.bucketId,
    origin,
    principal.subject,
    sourceBefore.revision,
    {
      installId,
      manifestDigest: bundleManifestDigest,
      phase: "installed",
    },
    workbench,
  );
  const phase = observed.space ? observedPhase(observed.space) : null;
  let variablesForObserved =
    phase && phase !== "installed"
      ? expectedVariables(
          ids.namespace,
          ids.bucketId,
          origin,
          principal.subject,
          sourceBefore.revision,
          {
            installId,
            manifestDigest: bundleManifestDigest,
            phase,
          },
          workbench,
        )
      : variables;
  const observedWriteMode = observed.space?.variables.HARBOR_HF_WRITE_MODE;
  if (
    phase === "installed" &&
    (observedWriteMode === "enabled" || observedWriteMode === "disabled")
  ) {
    variablesForObserved = {
      ...variablesForObserved,
      HARBOR_HF_WRITE_MODE: observedWriteMode,
    };
  }
  if (observed.space && isLegacySpace(observed.space)) {
    assertLegacyInstalledSafe(observed, {
      spaceId: ids.spaceId,
      bucketId: ids.bucketId,
      namespace: ids.namespace,
      subject: principal.subject,
    });
  } else {
    assertRemoteSafe(
      observed,
      {
        spaceId: ids.spaceId,
        bucketId: ids.bucketId,
        variables: variablesForObserved,
      },
      { requireRunning: false, requireAllSecrets: false },
    );
    if (
      observed.space &&
      observedPhase(observed.space) === "installed" &&
      !observed.bucket
    ) {
      throw new Error(
        "installed Space is missing its Bucket; manual recovery is required",
      );
    }
    if (
      observed.space &&
      observedPhase(observed.space) === "source_staged" &&
      !observed.bucket
    ) {
      throw new Error(
        "source-staged bootstrap is missing its proven Bucket; manual recovery is required",
      );
    }
  }
  const plan: InstallPlan = {
    schema_version: "harbor-hf.install-plan.v2",
    install_id: installId,
    production_ready: false,
    source: {
      revision: sourceBefore.revision,
      repository_root: sourceBefore.repositoryRoot,
    },
    bundle: {
      directory: resolve(input.bundleDirectory),
      manifest,
      manifest_digest: bundleManifestDigest,
    },
    hf_cli_version: hfCliVersion,
    targets: {
      namespace: ids.namespace,
      space_id: ids.spaceId,
      bucket_id: ids.bucketId,
    },
    principal,
    expected_variables: variables,
    expected_secret_names: [...SECRET_NAMES],
    observed_preconditions: observed,
  };
  if (
    phase &&
    phase !== "installed" &&
    (observed.space?.variables.HARBOR_HF_SOURCE_REVISION !== sourceBefore.revision ||
      observed.space.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST !==
        bundleManifestDigest)
  ) {
    if (phase === "credentials_required" && !observed.bucket) {
      assertCredentialRebindSafe(plan, observed);
    } else {
      throw new Error("existing bootstrap does not match the current source");
    }
  }
  await mkdir(dirname(resolve(input.planPath)), { recursive: true, mode: 0o700 });
  return { ...(await writePrivatePlan(input.planPath, plan)), plan };
}

async function writePrivateEnvironmentFile(
  directory: string,
  name: string,
  values: Record<string, string>,
): Promise<string> {
  for (const [key, value] of Object.entries(values)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      value.includes("\n") ||
      value.includes("\r")
    ) {
      throw new Error("environment file value is unsafe");
    }
  }
  const path = resolve(directory, name);
  await writeFile(
    path,
    `${Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return path;
}

function concreteVariableRecord(
  values: Record<string, string | null>,
  origin: string,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === "HARBOR_HF_PUBLIC_ORIGIN") {
      output[key] = validateOrigin(origin);
    } else if (value === null) {
      throw new Error("install plan contains an unresolved variable");
    } else {
      output[key] = value;
    }
  }
  return output;
}

function concreteVariables(plan: InstallPlan, origin: string): Record<string, string> {
  return concreteVariableRecord(plan.expected_variables, origin);
}

type WriteMode = "disabled" | "enabled";

function variablesForWriteMode(
  plan: InstallPlan,
  origin: string,
  writeMode: WriteMode,
): Record<string, string> {
  return {
    ...concreteVariables(plan, origin),
    HARBOR_HF_WRITE_MODE: writeMode,
  };
}

function nonNullVariables(
  values: Record<string, string | null>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) output[key] = value;
  }
  return output;
}

async function secretValues(
  environment: NodeJS.ProcessEnv,
  missingNames: readonly string[],
  input?: InstallerSecretInput,
): Promise<Record<string, string>> {
  const sourceNames = {
    HF_TOKEN: "HARBOR_HF_INSTALL_CONTROL_SECRET",
    HF_INFERENCE_TOKEN: "HARBOR_HF_INSTALL_INFERENCE_SECRET",
  } as const;
  const values: Record<string, string> = {};
  for (const name of missingNames) {
    if (name !== "HF_TOKEN" && name !== "HF_INFERENCE_TOKEN") {
      throw new Error("unexpected secret name");
    }
    const value = environment[sourceNames[name]] ?? (await input?.read(name));
    if (!value || value.length < 8 || value.includes("\n") || value.includes("\r")) {
      throw new InstallerInputError("required installer secret is missing or invalid");
    }
    values[name] = value;
  }
  if (
    values.HF_TOKEN &&
    values.HF_INFERENCE_TOKEN &&
    values.HF_TOKEN === values.HF_INFERENCE_TOKEN
  ) {
    throw new InstallerInputError("installer secrets must be distinct");
  }
  return values;
}

async function assertControlCredentialCanUseBucket(
  plan: InstallPlan,
  secrets: Record<string, string>,
  dependencies: InstallerDependencies,
): Promise<{ warnings: string[]; reported: boolean }> {
  const controlCredential = secrets.HF_TOKEN;
  if (!controlCredential) {
    throw new InstallerInputError("control credential is missing");
  }
  let warnings: string[];
  try {
    if (!dependencies.controlTokenScope) throw new Error();
    const attestation = await dependencies.controlTokenScope.attest({
      namespace: plan.targets.namespace,
      bucketId: plan.targets.bucket_id,
      accessToken: controlCredential,
    });
    warnings = attestation.warnings;
  } catch (error) {
    const detail = error instanceof ControlTokenScopeError ? `: ${error.message}` : "";
    throw new InstallerInputError(
      `control credential scope inspection failed${detail}`,
    );
  }
  try {
    if (!dependencies.bucketWriteProbe) throw new Error();
    await dependencies.bucketWriteProbe.createAndVerify({
      bucketId: plan.targets.bucket_id,
      accessToken: controlCredential,
      path: `installer/write-probes/schema=v1/${plan.install_id}/${randomBytes(16).toString("hex")}`,
      bytes: new TextEncoder().encode("harbor-hf installer bucket write probe v1\n"),
    });
  } catch {
    throw new InstallerInputError(
      "control credential scope was accepted, but the fresh artifact Bucket write/read-back proof failed",
    );
  }
  let reported = false;
  if (warnings.length > 0 && dependencies.reportControlCredentialWarnings) {
    try {
      dependencies.reportControlCredentialWarnings(warnings);
      reported = true;
    } catch {
      // Reporting must never turn an accepted over-scoped credential into a blocker.
    }
  }
  return { warnings, reported };
}

async function assertInferenceCredentialScope(
  secrets: Record<string, string>,
  dependencies: InstallerDependencies,
): Promise<void> {
  const inferenceCredential = secrets.HF_INFERENCE_TOKEN;
  if (!inferenceCredential) {
    throw new InstallerInputError("inference credential is missing");
  }
  try {
    if (!dependencies.inferenceTokenScope) throw new Error();
    await dependencies.inferenceTokenScope.attest({
      accessToken: inferenceCredential,
    });
  } catch {
    throw new InstallerInputError(
      "inference credential does not have the exact approved inference-only scope",
    );
  }
}

export interface VerificationResult {
  production_ready: false;
  space_url: string;
  anonymous_live: "passed";
  anonymous_ready: "passed";
  authenticated_system: "passed" | "skipped";
  source_upload_revision: "passed" | "platform_observed";
}

export interface CredentialsRequiredResult {
  status: "credentials_required";
  production_ready: false;
  space_id: string;
  bucket_id: string;
  space_paused: true;
  secrets_configured: false;
  source_uploaded: false;
  receipt: BootstrapReceipt;
}

export interface InstalledResult {
  status: "installed";
  verification: VerificationResult;
  control_credential_warnings: string[];
  control_credential_warnings_reported: boolean;
}

export type ApplyInstallResult = CredentialsRequiredResult | InstalledResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactStatus(body: unknown, expected: string): boolean {
  return isRecord(body) && body.status === expected && Object.keys(body).length === 1;
}

function assertSystem(
  body: unknown,
  sourceRevision: string,
  expectedWriteMode: WriteMode,
): void {
  if (!isRecord(body)) throw new Error("system response is invalid");
  const projection = body.projection;
  const contract = body.resource_contract;
  if (
    body.source_revision !== sourceRevision ||
    body.write_mode !== expectedWriteMode ||
    !isRecord(projection) ||
    projection.ready !== true ||
    projection.integrity_error !== null ||
    !isRecord(contract) ||
    contract.spaces !== 1 ||
    contract.buckets !== 1 ||
    contract.operator_secrets !== 2
  ) {
    throw new Error("authenticated system verification failed");
  }
}

async function verifyPlan(
  plan: InstallPlan,
  dependencies: InstallerDependencies,
  expectedUploadSha?: string,
  options: {
    expectedWriteMode?: WriteMode;
    requireAuthenticated?: boolean;
    requireEmptyRuns?: boolean;
    pollConfigureReadiness?: boolean;
  } = {},
): Promise<VerificationResult> {
  const expectedWriteMode = options.expectedWriteMode ?? "disabled";
  const observed = await dependencies.hf.observe(
    plan.targets.namespace,
    plan.targets.space_id,
    plan.targets.bucket_id,
  );
  if (
    observed.space?.variables.HARBOR_HF_INSTALL_ID === plan.install_id &&
    observedPhase(observed.space) !== "installed"
  ) {
    throw new Error(
      "installation is awaiting credential completion; run install:configure",
    );
  }
  const expectedForRemote = observed.space
    ? variablesForWriteMode(plan, observed.space.origin, expectedWriteMode)
    : plan.expected_variables;
  assertRemoteSafe(
    observed,
    {
      spaceId: plan.targets.space_id,
      bucketId: plan.targets.bucket_id,
      variables: expectedForRemote,
    },
    { requireRunning: true, requireAllSecrets: true },
  );
  if (!observed.space || !observed.bucket) {
    throw new Error("installed resources are missing");
  }
  const variables = variablesForWriteMode(
    plan,
    observed.space.origin,
    expectedWriteMode,
  );
  for (const [key, value] of Object.entries(variables)) {
    if (observed.space.variables[key] !== value) {
      throw new Error("managed Space variable verification failed");
    }
  }
  let sourceUploadRevision: VerificationResult["source_upload_revision"] =
    "platform_observed";
  if (expectedUploadSha) {
    if (observed.space.sha !== expectedUploadSha) {
      throw new Error("Space upload revision does not match");
    }
    sourceUploadRevision = "passed";
  } else if (
    observed.space.sha !== null &&
    !/^[a-f0-9]{40}$/.test(observed.space.sha)
  ) {
    throw new Error("Space upload revision is invalid");
  }

  const origin = validateOrigin(observed.space.origin);
  const live = await dependencies.http.getJson(new URL("/health/live", origin), {
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
  });
  if (live.status !== 200 || !exactStatus(live.body, "live")) {
    throw new Error("anonymous liveness verification failed");
  }
  if (options.pollConfigureReadiness) {
    const clock = configureClock(dependencies);
    const policy = configureStartupPolicy(dependencies);
    const startedAt = clock.monotonicMilliseconds();
    const deadline = startedAt + policy.readinessTimeoutMilliseconds;
    let nextHeartbeat = startedAt + policy.readinessHeartbeatMilliseconds;
    reportConfigureProgress(dependencies, { kind: "readiness_wait_started" });
    while (true) {
      const beforeRequest = clock.monotonicMilliseconds();
      if (beforeRequest >= deadline) {
        const elapsedMilliseconds = Math.max(0, beforeRequest - startedAt);
        reportConfigureProgress(dependencies, {
          kind: "readiness_timed_out",
          elapsedMilliseconds,
        });
        throw new InstallerReadinessTimeoutError(
          "anonymous readiness verification timed out",
        );
      }
      const ready = await dependencies.http.getJson(new URL("/health/ready", origin), {
        timeoutMs: Math.max(
          1,
          Math.min(
            policy.readinessRequestTimeoutMilliseconds,
            deadline - beforeRequest,
          ),
        ),
        maxBytes: 64 * 1024,
      });
      const afterRequest = clock.monotonicMilliseconds();
      if (afterRequest >= deadline) {
        const elapsedMilliseconds = Math.max(0, afterRequest - startedAt);
        reportConfigureProgress(dependencies, {
          kind: "readiness_timed_out",
          elapsedMilliseconds,
        });
        throw new InstallerReadinessTimeoutError(
          "anonymous readiness verification timed out",
        );
      }
      if (ready.status === 200 && exactStatus(ready.body, "ready")) {
        reportConfigureProgress(dependencies, {
          kind: "readiness_ready",
          elapsedMilliseconds: Math.max(0, afterRequest - startedAt),
        });
        break;
      }
      if (ready.status !== 200 || !exactStatus(ready.body, "initializing")) {
        throw new Error("anonymous readiness verification failed");
      }
      if (afterRequest >= nextHeartbeat) {
        reportConfigureProgress(dependencies, {
          kind: "readiness_initializing",
          elapsedMilliseconds: Math.max(0, afterRequest - startedAt),
        });
        nextHeartbeat = afterRequest + policy.readinessHeartbeatMilliseconds;
      }
      await clock.sleep(
        Math.min(policy.readinessPollMilliseconds, deadline - afterRequest),
      );
    }
  } else {
    const ready = await dependencies.http.getJson(new URL("/health/ready", origin), {
      timeoutMs: 10_000,
      maxBytes: 64 * 1024,
    });
    if (ready.status !== 200 || !exactStatus(ready.body, "ready")) {
      throw new Error("anonymous readiness verification failed");
    }
  }

  const bearer = (dependencies.environment ?? process.env)
    .HARBOR_HF_CONTROL_BEARER_TOKEN;
  if (options.requireAuthenticated && !bearer && !dependencies.applicationAuth) {
    throw new InstallerInputError(
      "Browser authentication or an explicitly supplied HARBOR_HF_CONTROL_BEARER_TOKEN is required for activation",
    );
  }
  let authenticatedSystem: VerificationResult["authenticated_system"] = "skipped";
  if (bearer || (options.requireAuthenticated && dependencies.applicationAuth)) {
    const authenticatedHttp = bearer
      ? dependencies.http
      : dependencies.applicationAuth?.(origin, plan.principal.username);
    if (!authenticatedHttp)
      throw new InstallerInputError("Application authentication is required");
    const system = await authenticatedHttp.getJson(new URL("/api/v1/system", origin), {
      ...(bearer ? { bearer } : {}),
      timeoutMs: 10_000,
      maxBytes: 256 * 1024,
    });
    if (system.status !== 200) {
      throw new Error("authenticated system verification failed");
    }
    assertSystem(system.body, plan.source.revision, expectedWriteMode);
    authenticatedSystem = "passed";
    if (options.requireEmptyRuns) {
      const runs = await authenticatedHttp.getJson(
        new URL("/api/v1/runs?limit=1", origin),
        {
          ...(bearer ? { bearer } : {}),
          timeoutMs: 10_000,
          maxBytes: 256 * 1024,
        },
      );
      if (
        runs.status !== 200 ||
        !isRecord(runs.body) ||
        !Array.isArray(runs.body.items) ||
        runs.body.items.length !== 0 ||
        runs.body.next_cursor !== null
      ) {
        throw new Error("activation requires an empty run projection");
      }
    }
  }
  return {
    production_ready: false,
    space_url: origin,
    anonymous_live: "passed",
    anonymous_ready: "passed",
    authenticated_system: authenticatedSystem,
    source_upload_revision: sourceUploadRevision,
  };
}

export async function verifyInstall(
  planPath: string,
  dependencies: InstallerDependencies,
): Promise<VerificationResult> {
  const { plan } = await readPrivatePlan(planPath);
  const version = await dependencies.hf.version();
  if (version !== plan.hf_cli_version) throw new Error("hf CLI version changed");
  return await verifyPlan(plan, dependencies, undefined, {
    requireAuthenticated: Boolean(dependencies.applicationAuth),
  });
}

export interface ActivationResult {
  production_ready: false;
  space_url: string;
  write_mode: "disabled" | "enabled";
  runtime: "paused" | "running";
  authenticated_system: "not_required" | "passed";
}

function writeModeOf(space: SpaceState): WriteMode {
  const writeMode = space.variables.HARBOR_HF_WRITE_MODE;
  if (writeMode !== "disabled" && writeMode !== "enabled") {
    throw new Error("managed Space write mode is invalid");
  }
  return writeMode;
}

function assertInstalledActivationState(
  plan: InstallPlan,
  state: RemoteState,
  writeMode: WriteMode,
): SpaceState {
  if (!state.space) throw new Error("activation Space is missing");
  assertRemoteSafe(
    state,
    {
      spaceId: plan.targets.space_id,
      bucketId: plan.targets.bucket_id,
      variables: variablesForWriteMode(plan, state.space.origin, writeMode),
    },
    { requireRunning: false, requireAllSecrets: true },
  );
  const expected = variablesForWriteMode(plan, state.space.origin, writeMode);
  for (const [key, value] of Object.entries(expected)) {
    if (state.space.variables[key] !== value) {
      throw new Error("activation Space variables do not match the install plan");
    }
  }
  return state.space;
}

function assertRecordedInstalledDisableState(
  plan: InstallPlan,
  state: RemoteState,
  writeMode: WriteMode,
): SpaceState {
  assertPreconditionsEqual(plan.observed_preconditions, state);
  const space = state.space;
  if (!space || !state.bucket || observedPhase(space) !== "installed") {
    throw new Error("disable preconditions are not an installed target");
  }
  const sourceRevision = space.variables.HARBOR_HF_SOURCE_REVISION;
  const manifestDigest = space.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST;
  if (!sourceRevision || !manifestDigest) {
    throw new Error("disable preconditions have an invalid install binding");
  }
  const variables = expectedVariables(
    plan.targets.namespace,
    plan.targets.bucket_id,
    space.origin,
    plan.principal.subject,
    sourceRevision,
    {
      installId: plan.install_id,
      manifestDigest,
      phase: "installed",
    },
    workbenchVariables(plan.expected_variables),
  );
  assertRemoteSafe(
    state,
    {
      spaceId: plan.targets.space_id,
      bucketId: plan.targets.bucket_id,
      variables: {
        ...variables,
        HARBOR_HF_WRITE_MODE: writeMode,
      },
    },
    { requireRunning: false, requireAllSecrets: true },
  );
  return space;
}

async function forceDisabledAndPaused(
  plan: InstallPlan,
  dependencies: InstallerDependencies,
  variablesFile: string,
): Promise<SpaceState> {
  try {
    await dependencies.hf.pause(plan.targets.space_id);
  } catch {
    // Continue to the authoritative disabled variable write.
  }
  try {
    await dependencies.hf.setVariables(plan.targets.space_id, variablesFile);
  } catch {
    // The exact final observation below resolves an ambiguous provider response.
  }
  try {
    await dependencies.hf.pause(plan.targets.space_id);
  } catch {
    // The final observation below remains authoritative.
  }
  const observed = await dependencies.hf.observe(
    plan.targets.namespace,
    plan.targets.space_id,
    plan.targets.bucket_id,
  );
  const space = assertInstalledActivationState(plan, observed, "disabled");
  if (space.runtimeStage !== "PAUSED") {
    throw new Error("disabled rollback did not leave the Space paused");
  }
  return space;
}

export async function activateInstall(
  input: {
    planPath: string;
    bootstrapReceipt?: BootstrapReceipt;
  },
  dependencies: InstallerDependencies,
): Promise<ActivationResult> {
  const active = () => dependencies.assertNotCancelled?.();
  active();
  const loaded = await readPrivatePlan(input.planPath);
  const { plan } = loaded;
  const version = await dependencies.hf.version();
  if (version !== plan.hf_cli_version) throw new Error("hf CLI version changed");
  const principal = await dependencies.identity.resolve();
  if (canonicalJson(principal) !== canonicalJson(plan.principal)) {
    throw new Error("authenticated principal changed");
  }
  let observed = await dependencies.hf.observe(
    plan.targets.namespace,
    plan.targets.space_id,
    plan.targets.bucket_id,
  );
  if (!observed.space) throw new Error("activation Space is missing");
  const currentMode = writeModeOf(observed.space);
  const currentSpace = assertInstalledActivationState(plan, observed, currentMode);
  const tempDirectory = await mkdtemp(resolve(tmpdir(), "harbor-hf-activation-"));
  try {
    const disabledFile = await writePrivateEnvironmentFile(
      tempDirectory,
      "variables-disabled.env",
      variablesForWriteMode(plan, currentSpace.origin, "disabled"),
    );
    if (
      !(dependencies.environment ?? process.env).HARBOR_HF_CONTROL_BEARER_TOKEN &&
      !dependencies.applicationAuth
    ) {
      throw new InstallerInputError(
        "Browser authentication or an explicitly supplied HARBOR_HF_CONTROL_BEARER_TOKEN is required for activation",
      );
    }
    if (!input.bootstrapReceipt?.uploaded_sha) {
      throw new InstallerInputError(
        "activation requires an exact upload receipt; rerun install:configure",
      );
    }
    assertReceipt(plan, loaded.digest, input.bootstrapReceipt);
    const expectedUploadSha = input.bootstrapReceipt.uploaded_sha;
    const enabledFile = await writePrivateEnvironmentFile(
      tempDirectory,
      "variables-enabled.env",
      variablesForWriteMode(plan, currentSpace.origin, "enabled"),
    );
    let mutationStarted = currentMode === "enabled";
    try {
      active();
      if (currentSpace.runtimeStage !== "RUNNING") {
        mutationStarted = true;
        await dependencies.hf.restart(plan.targets.space_id);
        active();
        await dependencies.hf.wait(plan.targets.space_id);
        active();
      }
      const preflight = await verifyPlan(plan, dependencies, expectedUploadSha, {
        expectedWriteMode: currentMode,
        requireAuthenticated: true,
        requireEmptyRuns: currentMode === "disabled",
      });
      active();
      if (currentMode === "enabled") {
        return {
          production_ready: false,
          space_url: preflight.space_url,
          write_mode: "enabled",
          runtime: "running",
          authenticated_system: "passed",
        };
      }
      mutationStarted = true;
      await dependencies.hf.pause(plan.targets.space_id);
      active();
      await dependencies.hf.setVariables(plan.targets.space_id, enabledFile);
      active();
      observed = await dependencies.hf.observe(
        plan.targets.namespace,
        plan.targets.space_id,
        plan.targets.bucket_id,
      );
      active();
      assertInstalledActivationState(plan, observed, "enabled");
      await dependencies.hf.restart(plan.targets.space_id);
      active();
      await dependencies.hf.wait(plan.targets.space_id);
      active();
      const verification = await verifyPlan(plan, dependencies, expectedUploadSha, {
        expectedWriteMode: "enabled",
        requireAuthenticated: true,
      });
      active();
      return {
        production_ready: false,
        space_url: verification.space_url,
        write_mode: "enabled",
        runtime: "running",
        authenticated_system: "passed",
      };
    } catch (error) {
      if (!mutationStarted) throw error;
      try {
        await forceDisabledAndPaused(plan, dependencies, disabledFile);
      } catch {
        throw new Error(
          `activation failed and disabled rollback could not be verified${providerFailureSuffix(error)}`,
        );
      }
      throw new Error(
        `activation failed; disabled rollback verified${providerFailureSuffix(error)}`,
      );
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function disableInstall(
  input: { planPath: string },
  dependencies: InstallerDependencies,
): Promise<ActivationResult> {
  const { plan } = await readPrivatePlan(input.planPath);
  const version = await dependencies.hf.version();
  if (version !== plan.hf_cli_version) throw new Error("hf CLI version changed");
  const principal = await dependencies.identity.resolve();
  if (canonicalJson(principal) !== canonicalJson(plan.principal)) {
    throw new Error("authenticated principal changed");
  }
  const observed = await dependencies.hf.observe(
    plan.targets.namespace,
    plan.targets.space_id,
    plan.targets.bucket_id,
  );
  if (!observed.space) throw new Error("disable Space is missing");
  const currentMode = writeModeOf(observed.space);
  let currentSpace: SpaceState;
  try {
    currentSpace = assertInstalledActivationState(plan, observed, currentMode);
  } catch {
    currentSpace = assertRecordedInstalledDisableState(plan, observed, currentMode);
  }
  const tempDirectory = await mkdtemp(resolve(tmpdir(), "harbor-hf-disable-"));
  try {
    const disabledFile = await writePrivateEnvironmentFile(
      tempDirectory,
      "variables-disabled.env",
      variablesForWriteMode(plan, currentSpace.origin, "disabled"),
    );
    const space = await forceDisabledAndPaused(plan, dependencies, disabledFile);
    return {
      production_ready: false,
      space_url: validateOrigin(space.origin),
      write_mode: "disabled",
      runtime: "paused",
      authenticated_system: "not_required",
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function observePlan(
  plan: InstallPlan,
  dependencies: InstallerDependencies,
): Promise<RemoteState> {
  return await dependencies.hf.observe(
    plan.targets.namespace,
    plan.targets.space_id,
    plan.targets.bucket_id,
  );
}

function bootstrapReceipt(plan: InstallPlan, planDigest: string): BootstrapReceipt {
  return {
    schema_version: "harbor-hf.install-bootstrap-receipt.v1",
    install_id: plan.install_id,
    plan_digest: planDigest,
    space_id: plan.targets.space_id,
    bucket_id: plan.targets.bucket_id,
    source_revision: plan.source.revision,
    manifest_digest: plan.bundle.manifest_digest,
  };
}

function assertBootstrapPhase(
  plan: InstallPlan,
  state: RemoteState,
  phase: InstallPhase,
  options: {
    requireBucket: boolean;
    requirePaused: boolean;
    requireAllSecrets: boolean;
    allowExpectedSecretSubset?: boolean;
    uploadSha?: string;
  },
): void {
  if (assertFreshContinuationSafe(plan, state) !== phase || !state.space) {
    throw new Error("remote bootstrap phase does not match");
  }
  if (options.requireBucket && !state.bucket) {
    throw new Error("bootstrap Bucket is missing");
  }
  if (!options.requireBucket && state.bucket) {
    throw new Error("an unproven Bucket appeared during bootstrap");
  }
  if (
    options.requirePaused &&
    (phase === "credentials_required"
      ? !isCredentialBootstrapStopped(state.space.runtimeStage)
      : state.space.runtimeStage !== "PAUSED")
  ) {
    throw new Error("bootstrap Space is not safely stopped");
  }
  if (
    options.requireAllSecrets &&
    !sameStrings(state.space.secretNames, SECRET_NAMES)
  ) {
    throw new Error("bootstrap secret names do not match");
  }
  if (
    !options.requireAllSecrets &&
    !options.allowExpectedSecretSubset &&
    state.space.secretNames.length > 0
  ) {
    throw new Error("bootstrap unexpectedly contains secrets");
  }
  if (options.uploadSha !== undefined && state.space.sha !== options.uploadSha) {
    throw new Error("bootstrap upload revision does not match");
  }
}

function assertCredentialRebindSafe(plan: InstallPlan, state: RemoteState): void {
  const space = state.space;
  const installId = space?.variables.HARBOR_HF_INSTALL_ID;
  const sourceRevision = space?.variables.HARBOR_HF_SOURCE_REVISION;
  const manifest = space?.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST;
  if (
    !space ||
    observedPhase(space) !== "credentials_required" ||
    state.bucket ||
    space.secretNames.length > 0 ||
    !isCredentialBootstrapStopped(space.runtimeStage) ||
    !installId ||
    !isInstallId(installId) ||
    installId !== plan.install_id ||
    !sourceRevision ||
    !/^[a-f0-9]{40}$/.test(sourceRevision) ||
    !manifest ||
    !/^sha256:[a-f0-9]{64}$/.test(manifest)
  ) {
    throw new Error("credential bootstrap cannot be rebound");
  }
  assertRemoteSafe(
    state,
    {
      spaceId: plan.targets.space_id,
      bucketId: plan.targets.bucket_id,
      variables: expectedVariables(
        plan.targets.namespace,
        plan.targets.bucket_id,
        space.origin,
        plan.principal.subject,
        sourceRevision,
        {
          installId,
          manifestDigest: manifest,
          phase: "credentials_required",
        },
        workbenchVariables(plan.expected_variables),
      ),
    },
    { requireRunning: false, requireAllSecrets: false },
  );
}

async function bootstrapFreshInstall(
  plan: InstallPlan,
  planDigest: string,
  observed: RemoteState,
  dependencies: InstallerDependencies,
  persistReceipt?: (receipt: BootstrapReceipt) => Promise<void>,
): Promise<CredentialsRequiredResult> {
  const tempDirectory = await mkdtemp(resolve(tmpdir(), "harbor-hf-bootstrap-"));
  let remoteMutationStarted = false;
  try {
    let current = observed;
    const initial = variablesForPhase(plan, null, "credentials_required");
    let variablesFile = await writePrivateEnvironmentFile(
      tempDirectory,
      "variables.env",
      nonNullVariables(initial),
    );
    if (!current.space) {
      if (current.bucket) {
        throw new Error("an existing Bucket cannot be adopted");
      }
      remoteMutationStarted = true;
      await dependencies.hf.createSpace(plan.targets.space_id, variablesFile);
      current = await observePlan(plan, dependencies);
    }
    if (!current.space) throw new Error("bootstrap Space metadata is unavailable");
    if (
      current.space.variables.HARBOR_HF_SOURCE_REVISION === plan.source.revision &&
      current.space.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST ===
        plan.bundle.manifest_digest
    ) {
      assertBootstrapPhase(plan, current, "credentials_required", {
        requireBucket: false,
        requirePaused: false,
        requireAllSecrets: false,
      });
    } else {
      assertPreconditionsEqual(plan.observed_preconditions, current);
      assertCredentialRebindSafe(plan, current);
    }

    const resolved = concreteVariableRecord(
      variablesForPhase(plan, current.space.origin, "credentials_required"),
      current.space.origin,
    );
    await rm(variablesFile, { force: true });
    variablesFile = await writePrivateEnvironmentFile(
      tempDirectory,
      "variables-resolved.env",
      resolved,
    );
    remoteMutationStarted = true;
    await dependencies.hf.setVariables(plan.targets.space_id, variablesFile);
    await dependencies.hf.setProtected(plan.targets.space_id);
    current = await observePlan(plan, dependencies);
    assertBootstrapPhase(plan, current, "credentials_required", {
      requireBucket: false,
      requirePaused: false,
      requireAllSecrets: false,
    });
    if (current.space?.runtimeStage !== "NO_APP_FILE") {
      await dependencies.hf.pause(plan.targets.space_id);
      current = await observePlan(plan, dependencies);
    }
    assertBootstrapPhase(plan, current, "credentials_required", {
      requireBucket: false,
      requirePaused: true,
      requireAllSecrets: false,
    });

    remoteMutationStarted = true;
    await dependencies.hf.createBucket(plan.targets.bucket_id, plan.principal.username);
    current = await observePlan(plan, dependencies);
    assertBootstrapPhase(plan, current, "credentials_required", {
      requireBucket: true,
      requirePaused: true,
      requireAllSecrets: false,
    });
    const receipt = bootstrapReceipt(plan, planDigest);
    await persistReceipt?.(receipt);
    return {
      status: "credentials_required",
      production_ready: false,
      space_id: plan.targets.space_id,
      bucket_id: plan.targets.bucket_id,
      space_paused: true,
      secrets_configured: false,
      source_uploaded: false,
      receipt,
    };
  } catch (error) {
    if (remoteMutationStarted) {
      try {
        await pauseManagedTarget(plan, dependencies);
      } catch {
        // Best effort only. Never replace the fixed redacted failure.
      }
      if (error instanceof InstallerInputError) throw error;
      throw new Error(
        `bootstrap failed after remote mutation began; the Space was paused when possible; inspect remote diagnostics${providerFailureSuffix(error)}`,
      );
    }
    throw new Error("bootstrap failed before remote mutation began");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function assertCompletionState(
  plan: InstallPlan,
  state: RemoteState,
  freshContinuation: boolean,
  allowVariableTransition = false,
): InstallPhase {
  if (freshContinuation) return assertFreshContinuationSafe(plan, state);
  if (allowVariableTransition) {
    assertPlanVariableTransitionSafe(plan, state);
    return state.space ? (observedPhase(state.space) ?? "installed") : "installed";
  }
  if (isLegacyMigrationPlan(plan)) {
    assertLegacyInstalledSafe(state, {
      spaceId: plan.targets.space_id,
      bucketId: plan.targets.bucket_id,
      namespace: plan.targets.namespace,
      subject: plan.principal.subject,
    });
    return "installed";
  }
  assertRemoteSafe(
    state,
    {
      spaceId: plan.targets.space_id,
      bucketId: plan.targets.bucket_id,
      variables: plan.expected_variables,
    },
    { requireRunning: false, requireAllSecrets: false },
  );
  return "installed";
}

function isOnlineDisabledUpgradeEligible(
  plan: InstallPlan,
  state: RemoteState,
  options: {
    freshContinuation: boolean;
    replaceCredentials: boolean;
  },
): boolean {
  const plannedSpace = plan.observed_preconditions.space;
  const space = state.space;
  return (
    !options.freshContinuation &&
    !options.replaceCredentials &&
    !isLegacyMigrationPlan(plan) &&
    plan.expected_variables.HARBOR_HF_WRITE_MODE === "disabled" &&
    plannedSpace !== null &&
    observedPhase(plannedSpace) === "installed" &&
    state.bucket !== null &&
    space !== null &&
    observedPhase(space) === "installed" &&
    space.runtimeStage === "RUNNING" &&
    space.variables.HARBOR_HF_WRITE_MODE === "disabled" &&
    sameStrings(space.secretNames, SECRET_NAMES)
  );
}

function assertOnlineDisabledUpgradeEligible(
  plan: InstallPlan,
  state: RemoteState,
  variableTransition: boolean,
): void {
  assertCompletionState(plan, state, false, variableTransition);
  if (
    !isOnlineDisabledUpgradeEligible(plan, state, {
      freshContinuation: false,
      replaceCredentials: false,
    })
  ) {
    throw new Error("online upgrade eligibility changed");
  }
}

function assertExactOnlineState(
  expected: RemoteState,
  observed: RemoteState,
  message: string,
): void {
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    throw new Error(message);
  }
}

function assertOnlineUploadTransition(
  accepted: RemoteState,
  observed: RemoteState,
  uploadSha: string,
  uploadedNow: boolean,
): void {
  if (!accepted.space || !accepted.bucket || !observed.space || !observed.bucket) {
    throw new Error("online upgrade resources are incomplete");
  }
  if (!uploadedNow) {
    assertExactOnlineState(
      accepted,
      observed,
      "online upgrade state drifted before variable update",
    );
  } else {
    const normalized = structuredClone(observed);
    if (!normalized.space) throw new Error("online upgrade Space is missing");
    normalized.space.sha = accepted.space.sha;
    normalized.space.runtimeStage = accepted.space.runtimeStage;
    assertExactOnlineState(
      accepted,
      normalized,
      "online upgrade state changed outside the exact upload",
    );
  }
  if (observed.space.sha !== uploadSha) {
    throw new Error("Space upload revision does not match");
  }
}

function assertOnlineConfiguredState(
  plan: InstallPlan,
  state: RemoteState,
  variables: Record<string, string>,
  uploadSha: string,
): void {
  assertRemoteSafe(
    state,
    {
      spaceId: plan.targets.space_id,
      bucketId: plan.targets.bucket_id,
      variables,
    },
    { requireRunning: false, requireAllSecrets: true },
  );
  if (
    !state.space ||
    canonicalJson(state.space.variables) !== canonicalJson(variables)
  ) {
    throw new Error("configured Space variables do not exactly match");
  }
  if (state.space.sha !== uploadSha) {
    throw new Error("configured Space upload revision does not match");
  }
}

async function completeOnlineDisabledUpgrade(
  plan: InstallPlan,
  observed: RemoteState,
  stagedBundle: string,
  variableTransition: boolean,
  dependencies: InstallerDependencies,
  diagnostics: ConfigureDiagnostics,
  receipt?: BootstrapReceipt,
  persistReceipt?: (receipt: BootstrapReceipt) => Promise<void>,
): Promise<InstalledResult> {
  if (!observed.space || !observed.bucket) {
    throw new Error("online upgrade resources are incomplete");
  }
  const acceptedOrigin = observed.space.origin;
  const accepted = structuredClone(observed);
  let current = observed;

  diagnostics.operation = "set_protected";
  await dependencies.hf.setProtected(plan.targets.space_id);
  diagnostics.operation = "wait_runtime";
  await dependencies.hf.wait(plan.targets.space_id);
  diagnostics.operation = "observe_protected";
  current = await observePlan(plan, dependencies);
  diagnostics.operation = "assert_protected";
  assertExactOnlineState(
    accepted,
    current,
    "online upgrade state drifted after protection reassertion",
  );
  diagnostics.operation = "assert_protected";
  assertOnlineDisabledUpgradeEligible(plan, current, variableTransition);

  let uploadSha = receipt?.uploaded_sha;
  let uploadedNow = false;
  if (!uploadSha) {
    uploadedNow = true;
    diagnostics.operation = "upload";
    uploadSha = await dependencies.hf.uploadMirror(
      plan.targets.space_id,
      stagedBundle,
      plan.source.revision,
    );
    diagnostics.operation = "observe_upload";
    current = await observePlan(plan, dependencies);
  }
  diagnostics.operation = "assert_upload";
  assertOnlineUploadTransition(accepted, current, uploadSha, uploadedNow);
  if (uploadedNow && receipt) {
    diagnostics.operation = "persist_receipt";
    await persistReceipt?.({ ...receipt, uploaded_sha: uploadSha });
  }

  const targetVariables = concreteVariables(plan, acceptedOrigin);
  diagnostics.operation = "write_variables";
  const variablesFile = await writePrivateEnvironmentFile(
    dirname(stagedBundle),
    "variables-installed-online.env",
    targetVariables,
  );
  diagnostics.operation = "observe_upload";
  current = await observePlan(plan, dependencies);
  diagnostics.operation = "assert_upload";
  assertOnlineUploadTransition(accepted, current, uploadSha, uploadedNow);
  diagnostics.operation = "set_variables";
  await dependencies.hf.setVariables(plan.targets.space_id, variablesFile);
  diagnostics.operation = "observe_configured";
  current = await observePlan(plan, dependencies);
  diagnostics.operation = "assert_configured";
  assertOnlineConfiguredState(plan, current, targetVariables, uploadSha);

  diagnostics.operation = "wait_runtime";
  await waitForConfigureRuntime(plan.targets.space_id, dependencies);
  diagnostics.operation = "verify";
  return {
    status: "installed",
    verification: await verifyPlan(plan, dependencies, uploadSha, {
      pollConfigureReadiness: true,
    }),
    control_credential_warnings: [],
    control_credential_warnings_reported: false,
  };
}

async function completeInstall(
  plan: InstallPlan,
  observed: RemoteState,
  freshContinuation: boolean,
  variableTransition: boolean,
  replaceCredentials: boolean,
  dependencies: InstallerDependencies,
  receipt?: BootstrapReceipt,
  persistReceipt?: (receipt: BootstrapReceipt) => Promise<void>,
): Promise<InstalledResult> {
  if (!observed.space) throw new Error("completion Space is missing");
  if (receipt?.uploaded_sha && observed.space.sha !== receipt.uploaded_sha) {
    throw new Error(
      "Space source differs from the recorded upload; manual recovery is required",
    );
  }
  const environment = dependencies.environment ?? process.env;
  const tempDirectory = await mkdtemp(resolve(tmpdir(), "harbor-hf-install-"));
  const diagnostics = new ConfigureDiagnostics();
  let remoteMutationStarted = false;
  let sourceUploadAttempted = false;
  let controlCredentialWarnings: string[] = [];
  let controlCredentialWarningsReported = false;
  try {
    const stagedBundle = resolve(tempDirectory, "bundle");
    await cp(plan.bundle.directory, stagedBundle, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    assertManifestEqual(plan.bundle.manifest, await buildBundleManifest(stagedBundle));
    let current = observed;
    diagnostics.operation = "assert_entry";
    let phase = freshContinuation
      ? assertFreshCompletionEntrySafe(plan, current)
      : assertCompletionState(plan, current, false, variableTransition);
    if (
      isOnlineDisabledUpgradeEligible(plan, current, {
        freshContinuation,
        replaceCredentials,
      })
    ) {
      remoteMutationStarted = true;
      sourceUploadAttempted = !receipt?.uploaded_sha;
      return await completeOnlineDisabledUpgrade(
        plan,
        current,
        stagedBundle,
        variableTransition,
        dependencies,
        diagnostics,
        receipt,
        persistReceipt,
      );
    }
    remoteMutationStarted = true;
    if (
      !(
        freshContinuation &&
        phase === "credentials_required" &&
        current.space?.runtimeStage === "NO_APP_FILE"
      )
    ) {
      diagnostics.operation = "pause";
      await dependencies.hf.pause(plan.targets.space_id);
    }
    diagnostics.operation = "set_protected";
    await dependencies.hf.setProtected(plan.targets.space_id);
    diagnostics.operation = "observe_protected";
    current = await observePlan(plan, dependencies);
    diagnostics.operation = "assert_protected";
    phase = assertCompletionState(plan, current, freshContinuation, variableTransition);
    const releaseUploadIsSafelyStopped =
      freshContinuation && phase === "credentials_required"
        ? isCredentialBootstrapStopped(current.space?.runtimeStage ?? null)
        : current.space?.runtimeStage === "PAUSED";
    if (!releaseUploadIsSafelyStopped) {
      throw new Error("Space is not PAUSED before release upload");
    }
    if (!current.bucket) {
      throw new Error(
        "installed Space is missing its Bucket; manual recovery is required",
      );
    }

    let uploadSha = receipt?.uploaded_sha;
    if (!uploadSha) {
      sourceUploadAttempted = true;
      diagnostics.operation = "upload";
      uploadSha = await dependencies.hf.uploadMirror(
        plan.targets.space_id,
        stagedBundle,
        plan.source.revision,
      );
      diagnostics.operation = "observe_upload";
      current = await observePlan(plan, dependencies);
      diagnostics.operation = "assert_upload";
      phase = assertCompletionState(
        plan,
        current,
        freshContinuation,
        variableTransition,
      );
      if (!current.space || current.space.sha !== uploadSha) {
        throw new Error("Space upload revision does not match");
      }
      diagnostics.operation = "pause";
      await dependencies.hf.pause(plan.targets.space_id);
      diagnostics.operation = "observe_paused";
      current = await observePlan(plan, dependencies);
      diagnostics.operation = "assert_paused";
      phase = assertCompletionState(
        plan,
        current,
        freshContinuation,
        variableTransition,
      );
      if (current.space?.runtimeStage !== "PAUSED" || current.space.sha !== uploadSha) {
        throw new Error("Space is not safely paused after release upload");
      }
      if (receipt) {
        diagnostics.operation = "persist_receipt";
        await persistReceipt?.({ ...receipt, uploaded_sha: uploadSha });
      }
    }
    if (!current.space) throw new Error("configured Space metadata is unavailable");

    let variablesFile: string;
    if (freshContinuation && phase !== "installed") {
      const sourceStaged = concreteVariableRecord(
        variablesForPhase(plan, current.space.origin, "source_staged"),
        current.space.origin,
      );
      diagnostics.operation = "write_variables";
      variablesFile = await writePrivateEnvironmentFile(
        tempDirectory,
        "variables-source-staged.env",
        sourceStaged,
      );
      diagnostics.operation = "set_variables";
      await dependencies.hf.setVariables(plan.targets.space_id, variablesFile);
      diagnostics.operation = "pause";
      await dependencies.hf.pause(plan.targets.space_id);
      diagnostics.operation = "observe_paused";
      current = await observePlan(plan, dependencies);
      diagnostics.operation = "assert_paused";
      assertBootstrapPhase(plan, current, "source_staged", {
        requireBucket: true,
        requirePaused: true,
        requireAllSecrets: false,
        allowExpectedSecretSubset: true,
        uploadSha,
      });

      diagnostics.operation = "observe_paused";
      const reattested = await observePlan(plan, dependencies);
      diagnostics.operation = "assert_paused";
      assertBootstrapPhase(plan, reattested, "source_staged", {
        requireBucket: true,
        requirePaused: true,
        requireAllSecrets: false,
        allowExpectedSecretSubset: true,
        uploadSha,
      });
      const missingSecrets = SECRET_NAMES.filter(
        (name) => !reattested.space?.secretNames.includes(name),
      );
      if (missingSecrets.length > 0 || replaceCredentials) {
        diagnostics.operation = "stage_credentials";
        const secrets = await secretValues(
          environment,
          SECRET_NAMES,
          dependencies.secretInput,
        );
        await assertInferenceCredentialScope(secrets, dependencies);
        const controlAttestation = await assertControlCredentialCanUseBucket(
          plan,
          secrets,
          dependencies,
        );
        controlCredentialWarnings = controlAttestation.warnings;
        controlCredentialWarningsReported = controlAttestation.reported;
        const secretsFile = await writePrivateEnvironmentFile(
          tempDirectory,
          "secrets.env",
          secrets,
        );
        await dependencies.hf.setSecrets(plan.targets.space_id, secretsFile);
        diagnostics.operation = "pause";
        await dependencies.hf.pause(plan.targets.space_id);
        diagnostics.operation = "observe_paused";
        current = await observePlan(plan, dependencies);
        diagnostics.operation = "assert_paused";
        assertBootstrapPhase(plan, current, "source_staged", {
          requireBucket: true,
          requirePaused: true,
          requireAllSecrets: true,
          uploadSha,
        });
      } else {
        diagnostics.operation = "assert_paused";
        assertBootstrapPhase(plan, reattested, "source_staged", {
          requireBucket: true,
          requirePaused: true,
          requireAllSecrets: true,
          uploadSha,
        });
        current = reattested;
      }
    } else {
      const missingSecrets = SECRET_NAMES.filter(
        (name) => !current.space?.secretNames.includes(name),
      );
      const planWasMissingSecrets =
        !freshContinuation &&
        SECRET_NAMES.some(
          (name) => !plan.observed_preconditions.space?.secretNames.includes(name),
        );
      if (freshContinuation && missingSecrets.length > 0) {
        throw new Error("installed bootstrap is missing credential names");
      }
      if (missingSecrets.length > 0 || planWasMissingSecrets || replaceCredentials) {
        diagnostics.operation = "stage_credentials";
        const secrets = await secretValues(
          environment,
          SECRET_NAMES,
          dependencies.secretInput,
        );
        await assertInferenceCredentialScope(secrets, dependencies);
        const controlAttestation = await assertControlCredentialCanUseBucket(
          plan,
          secrets,
          dependencies,
        );
        controlCredentialWarnings = controlAttestation.warnings;
        controlCredentialWarningsReported = controlAttestation.reported;
        const secretsFile = await writePrivateEnvironmentFile(
          tempDirectory,
          "secrets.env",
          secrets,
        );
        await dependencies.hf.setSecrets(plan.targets.space_id, secretsFile);
        diagnostics.operation = "pause";
        await dependencies.hf.pause(plan.targets.space_id);
        diagnostics.operation = "observe_paused";
        current = await observePlan(plan, dependencies);
        diagnostics.operation = "assert_paused";
        assertRemoteSafe(
          current,
          {
            spaceId: plan.targets.space_id,
            bucketId: plan.targets.bucket_id,
            variables: plan.expected_variables,
          },
          { requireRunning: false, requireAllSecrets: true },
        );
      }
    }

    if (!current.space) throw new Error("configured Space metadata is unavailable");
    diagnostics.operation = "write_variables";
    variablesFile = await writePrivateEnvironmentFile(
      tempDirectory,
      "variables-installed.env",
      concreteVariables(plan, current.space.origin),
    );
    diagnostics.operation = "set_variables";
    await dependencies.hf.setVariables(plan.targets.space_id, variablesFile);
    diagnostics.operation = "observe_configured";
    current = await observePlan(plan, dependencies);
    if (!current.space) throw new Error("configured Space metadata is unavailable");
    diagnostics.operation = "assert_configured";
    assertRemoteSafe(
      current,
      {
        spaceId: plan.targets.space_id,
        bucketId: plan.targets.bucket_id,
        variables: concreteVariables(plan, current.space.origin),
      },
      { requireRunning: false, requireAllSecrets: true },
    );
    if (current.space.sha !== uploadSha) {
      throw new Error("configured Space upload revision does not match");
    }
    diagnostics.operation = "restart";
    await dependencies.hf.restart(plan.targets.space_id);
    diagnostics.operation = "wait_runtime";
    await waitForConfigureRuntime(plan.targets.space_id, dependencies);
    diagnostics.operation = "verify";
    return {
      status: "installed",
      verification: await verifyPlan(plan, dependencies, uploadSha, {
        pollConfigureReadiness: true,
      }),
      control_credential_warnings: controlCredentialWarnings,
      control_credential_warnings_reported: controlCredentialWarningsReported,
    };
  } catch (error) {
    if (remoteMutationStarted) {
      if (freshContinuation && !(error instanceof InstallerInputError)) {
        try {
          const retryState = await observePlan(plan, dependencies);
          if (retryState.space && observedPhase(retryState.space) === "installed") {
            assertFreshContinuationSafe(plan, retryState);
            await dependencies.hf.pause(plan.targets.space_id);
            const retryVariables = concreteVariableRecord(
              variablesForPhase(plan, retryState.space.origin, "source_staged"),
              retryState.space.origin,
            );
            const retryVariablesFile = await writePrivateEnvironmentFile(
              tempDirectory,
              "variables-retry.env",
              retryVariables,
            );
            await dependencies.hf.setVariables(
              plan.targets.space_id,
              retryVariablesFile,
            );
            await dependencies.hf.pause(plan.targets.space_id);
          }
        } catch {
          // Best effort only. The exact pause guard still runs below.
        }
      }
      try {
        await pauseManagedTarget(plan, dependencies, {
          pauseNoAppFile: sourceUploadAttempted,
        });
      } catch {
        // Best effort only. Never replace the fixed redacted failure.
      }
      if (error instanceof InstallerInputError) throw error;
      throw new Error(
        `installation failed after remote mutation began; the Space was paused when possible; inspect remote diagnostics${diagnostics.suffix(error)}${error instanceof InstallerReadinessTimeoutError ? "; verification category: readiness-timeout" : ""}`,
      );
    }
    throw new Error(
      `installation failed before remote mutation began${diagnostics.suffix(error)}`,
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function applyInstall(
  input: {
    planPath: string;
    bootstrapReceipt?: BootstrapReceipt;
    replaceCredentials?: boolean;
    persistBootstrapReceipt?: (receipt: BootstrapReceipt) => Promise<void>;
    target?: "resources" | "installed";
  },
  dependencies: InstallerDependencies,
): Promise<ApplyInstallResult> {
  const loaded = await readPrivatePlan(input.planPath);
  const plan = loaded.plan;
  if (input.bootstrapReceipt) {
    assertReceipt(plan, loaded.digest, input.bootstrapReceipt);
  }
  const version = await dependencies.hf.version();
  if (version !== plan.hf_cli_version) throw new Error("hf CLI version changed");
  const source = await dependencies.source.inspect();
  if (
    source.repositoryRoot !== plan.source.repository_root ||
    source.revision !== plan.source.revision
  ) {
    throw new Error("source does not match the install plan");
  }
  assertManifestEqual(
    plan.bundle.manifest,
    await buildBundleManifest(plan.bundle.directory),
  );
  const principal = await dependencies.identity.resolve();
  if (canonicalJson(principal) !== canonicalJson(plan.principal)) {
    throw new Error("authenticated principal changed");
  }
  const observed = await dependencies.hf.observe(
    plan.targets.namespace,
    plan.targets.space_id,
    plan.targets.bucket_id,
  );
  if (input.bootstrapReceipt && (!observed.space || !observed.bucket)) {
    throw new Error(
      "bootstrap receipt exists but a proven resource is missing; manual recovery is required",
    );
  }
  if (input.target === "installed" && (!observed.space || !observed.bucket)) {
    throw new InstallerInputError(
      "configuration requires provisioned resources; run install:provision",
    );
  }
  const allowsBootstrapContinuation = isFreshPlan(plan) || isBootstrapPlan(plan);
  const credentialRebind = isCredentialRebindPlan(plan);
  let freshContinuation = false;
  let variableTransition = false;
  if (credentialRebind) {
    assertPreconditionsEqual(plan.observed_preconditions, observed);
    assertCredentialRebindSafe(plan, observed);
  } else if (canonicalJson(plan.observed_preconditions) !== canonicalJson(observed)) {
    if (allowsBootstrapContinuation && observed.space) {
      assertFreshContinuationSafe(plan, observed);
      freshContinuation = true;
    } else {
      try {
        assertPlanVariableTransitionSafe(plan, observed);
      } catch {
        assertPreconditionsEqual(plan.observed_preconditions, observed);
      }
      variableTransition = true;
    }
  }

  if (allowsBootstrapContinuation && !observed.space) {
    return await bootstrapFreshInstall(
      plan,
      loaded.digest,
      observed,
      dependencies,
      input.persistBootstrapReceipt,
    );
  }
  if (allowsBootstrapContinuation && observed.space && !observed.bucket) {
    if (input.bootstrapReceipt) {
      throw new Error("bootstrap receipt exists but the Bucket is missing");
    }
    return await bootstrapFreshInstall(
      plan,
      loaded.digest,
      observed,
      dependencies,
      input.persistBootstrapReceipt,
    );
  }
  if (input.target === "resources") {
    if (
      !input.bootstrapReceipt ||
      !observed.space ||
      !observed.bucket ||
      observedPhase(observed.space) !== "credentials_required"
    ) {
      throw new InstallerInputError(
        "provisioning is already complete or configuration has started",
      );
    }
    assertFreshContinuationSafe(plan, observed);
    if (
      !isCredentialBootstrapStopped(observed.space.runtimeStage) ||
      observed.space.secretNames.length > 0 ||
      input.bootstrapReceipt.uploaded_sha !== undefined ||
      (observed.space.runtimeStage !== "NO_APP_FILE" && observed.space.sha !== null)
    ) {
      throw new InstallerInputError(
        "provisioning is already complete or configuration has started",
      );
    }
    return {
      status: "credentials_required",
      production_ready: false,
      space_id: plan.targets.space_id,
      bucket_id: plan.targets.bucket_id,
      space_paused: true,
      secrets_configured: false,
      source_uploaded: false,
      receipt: input.bootstrapReceipt,
    };
  }
  if (freshContinuation || allowsBootstrapContinuation) {
    if (!input.bootstrapReceipt) {
      throw new Error(
        "bootstrap Bucket ownership is unproven; use the original private installer state",
      );
    }
    freshContinuation = true;
  } else {
    if (!variableTransition) {
      assertPreconditionsEqual(plan.observed_preconditions, observed);
      if (isLegacyMigrationPlan(plan)) {
        assertLegacyInstalledSafe(observed, {
          spaceId: plan.targets.space_id,
          bucketId: plan.targets.bucket_id,
          namespace: plan.targets.namespace,
          subject: plan.principal.subject,
        });
      } else {
        assertRemoteSafe(
          observed,
          {
            spaceId: plan.targets.space_id,
            bucketId: plan.targets.bucket_id,
            variables: plan.expected_variables,
          },
          { requireRunning: false, requireAllSecrets: false },
        );
      }
    }
  }
  return await completeInstall(
    plan,
    observed,
    freshContinuation,
    variableTransition,
    input.replaceCredentials ?? false,
    dependencies,
    input.bootstrapReceipt,
    input.persistBootstrapReceipt,
  );
}

export async function provisionInstall(
  input: {
    planPath: string;
    bootstrapReceipt?: BootstrapReceipt;
    persistBootstrapReceipt?: (receipt: BootstrapReceipt) => Promise<void>;
  },
  dependencies: InstallerDependencies,
): Promise<CredentialsRequiredResult> {
  const result = await applyInstall({ ...input, target: "resources" }, dependencies);
  if (result.status !== "credentials_required") {
    throw new Error("provisioning unexpectedly configured the installation");
  }
  return result;
}

export async function configureInstall(
  input: {
    planPath: string;
    bootstrapReceipt?: BootstrapReceipt;
    replaceCredentials?: boolean;
    persistBootstrapReceipt?: (receipt: BootstrapReceipt) => Promise<void>;
  },
  dependencies: InstallerDependencies,
): Promise<InstalledResult> {
  const result = await applyInstall({ ...input, target: "installed" }, dependencies);
  if (result.status !== "installed") {
    throw new Error("configuration did not reach the installed state");
  }
  return result;
}

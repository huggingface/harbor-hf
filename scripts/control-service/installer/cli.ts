import { HuggingFaceBucketWriteProbe } from "./bucket-write-probe.js";
import { HuggingFaceControlTokenScope } from "./control-token-scope.js";
import { HfCli } from "./hf.js";
import { BoundedHttpAdapter } from "./http.js";
import { StableIdentityAdapter } from "./identity.js";
import { HuggingFaceInferenceTokenScope } from "./inference-token-scope.js";
import type { InstallPlan } from "./model.js";
import { BoundedJsonProcess } from "./process.js";
import { TtyInstallerSecretInput } from "./secret-input.js";
import { GitSourceAdapter } from "./source.js";
import type {
  ActivationResult,
  ApplyInstallResult,
  InstallerDependencies,
} from "./workflow.js";

export function defaultDependencies(): InstallerDependencies {
  const hf = new HfCli(new BoundedJsonProcess());
  const http = new BoundedHttpAdapter();
  return {
    hf,
    bucketWriteProbe: new HuggingFaceBucketWriteProbe(),
    controlTokenScope: new HuggingFaceControlTokenScope(http),
    inferenceTokenScope: new HuggingFaceInferenceTokenScope(http),
    http,
    identity: new StableIdentityAdapter(hf, http),
    secretInput: new TtyInstallerSecretInput(),
    source: new GitSourceAdapter(),
  };
}

export function parseOptions(
  args: readonly string[],
  specification: Record<string, { required: boolean }>,
): Record<string, string> | "help" {
  if (args.includes("--help")) return "help";
  const output: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("invalid command arguments");
    }
    const name = key.slice(2);
    if (!(name in specification) || name in output) {
      throw new Error("invalid command arguments");
    }
    output[name] = value;
  }
  for (const [name, option] of Object.entries(specification)) {
    if (option.required && !output[name]) {
      throw new Error(`missing --${name}`);
    }
  }
  return output;
}

export function parseSavedPlanOptions(
  args: readonly string[],
): { space: string; stateDirectory?: string } | "help" {
  const options = parseOptions(args, {
    space: { required: true },
    "state-dir": { required: false },
  });
  if (options === "help") return options;
  return {
    space: options.space as string,
    ...(options["state-dir"] ? { stateDirectory: options["state-dir"] as string } : {}),
  };
}

export function parseConfigureOptions(
  args: readonly string[],
): { space: string; stateDirectory?: string; replaceCredentials: boolean } | "help" {
  if (args.includes("--help")) return "help";
  const replacementFlags = args.filter((arg) => arg === "--replace-credentials");
  if (replacementFlags.length > 1) throw new Error("invalid command arguments");
  const saved = parseSavedPlanOptions(
    args.filter((arg) => arg !== "--replace-credentials"),
  );
  if (saved === "help") return saved;
  return {
    ...saved,
    replaceCredentials: replacementFlags.length === 1,
  };
}

export function formatPlanOutput(
  plan: InstallPlan,
  customStateDirectory = false,
): string {
  const observed = plan.observed_preconditions;
  const phase = observed.space?.variables.HARBOR_HF_INSTALL_PHASE;
  const action =
    phase === "credentials_required" || phase === "source_staged"
      ? "continue paused credential bootstrap"
      : !observed.space
        ? "create paused bootstrap Space and Bucket"
        : observed.bucket
          ? "update installer-managed Space"
          : "update Space and create Bucket";
  const nextCommand =
    !observed.space || !observed.bucket ? "install:provision" : "install:configure";
  return [
    `Space:      ${plan.targets.space_id}`,
    `Bucket:     ${plan.targets.bucket_id}`,
    "Access:     protected",
    "Hardware:   cpu-basic",
    "Write mode: disabled",
    `Action:     ${action}`,
    "",
    "Plan saved privately.",
    ...(!observed.space ? ["No service credentials are required for bootstrap."] : []),
    customStateDirectory
      ? `Next: rerun ${nextCommand} with this Space and the same --state-dir.`
      : `Next: npm run ${nextCommand} -- --space ${plan.targets.space_id}`,
    "",
  ].join("\n");
}

export function formatProvisionOutput(
  result: Extract<ApplyInstallResult, { status: "credentials_required" }>,
  customStateDirectory = false,
): string {
  return [
    "Provisioning verified.",
    "",
    `Space: ${result.space_id}`,
    `Bucket: ${result.bucket_id}`,
    "Runtime: paused",
    "Write mode: disabled",
    "Secrets stored: no",
    "Source uploaded: no",
    "",
    customStateDirectory
      ? "Next: rerun install:configure with this Space and the same --state-dir."
      : `Next: npm run install:configure -- --space ${result.space_id}`,
    "",
  ].join("\n");
}

export function formatConfigureOutput(
  spaceId: string,
  result: Extract<ApplyInstallResult, { status: "installed" }>,
): string {
  const verification = result.verification;
  return [
    "Installation verified.",
    `Space: ${spaceId}`,
    `URL: ${verification.space_url}`,
    `Anonymous health: ${verification.anonymous_live}`,
    `Authenticated system: ${verification.authenticated_system}`,
    `Source upload: ${verification.source_upload_revision}`,
    "Write mode: disabled",
    "Production ready: no",
    "",
    "Review access and credential scopes before activation.",
    "",
  ].join("\n");
}

export function formatActivationOutput(
  spaceId: string,
  result: ActivationResult,
): string {
  return [
    result.write_mode === "enabled"
      ? "Installation activated."
      : "Writes disabled and Space paused.",
    `Space: ${spaceId}`,
    `URL: ${result.space_url}`,
    "Hardware: cpu-basic",
    `Runtime: ${result.runtime}`,
    `Write mode: ${result.write_mode}`,
    `Authenticated system: ${result.authenticated_system}`,
    "Production ready: no",
    ...(result.write_mode === "enabled"
      ? ["", "Campaign submissions and reconciliation are enabled."]
      : []),
    "",
  ].join("\n");
}

export async function cliMain(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "installer failed";
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}

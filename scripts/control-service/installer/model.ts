import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";

export const PLAN_SCHEMA = "harbor-hf.install-plan.v2";
export const INSTALLER_MARKER = "harbor-hf.install-plan.v2";
export const INSTALLER_VERSION = "2";
export const SECRET_NAMES = ["HF_INFERENCE_TOKEN", "HF_TOKEN"] as const;
export const INSTALL_PHASES = [
  "credentials_required",
  "source_staged",
  "installed",
] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];

export interface BundleFile {
  path: string;
  mode: string;
  size: number;
  sha256: string;
}

export interface Principal {
  subject: string;
  username: string;
  organizations: string[];
}

export interface SpaceState {
  id: string;
  private: boolean;
  sdk: string;
  origin: string;
  sha: string | null;
  runtimeStage: string | null;
  hardware: string | null;
  requestedHardware: string | null;
  variables: Record<string, string>;
  secretNames: string[];
}

export interface BucketState {
  id: string;
  private: boolean;
}

export interface RemoteState {
  namespaceListingsComplete: true;
  space: SpaceState | null;
  bucket: BucketState | null;
}

export interface InstallPlan {
  schema_version: typeof PLAN_SCHEMA;
  install_id: string;
  production_ready: false;
  source: {
    revision: string;
    repository_root: string;
  };
  bundle: {
    directory: string;
    manifest: BundleFile[];
    manifest_digest: string;
  };
  hf_cli_version: string;
  targets: {
    namespace: string;
    space_id: string;
    bucket_id: string;
  };
  principal: Principal;
  expected_variables: Record<string, string | null>;
  expected_secret_names: string[];
  observed_preconditions: RemoteState;
}

const ID_PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HF_CLI_VERSION = /^1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const INSTALL_ID = /^[a-f0-9]{64}$/;

export class UnsupportedInstallPlanError extends Error {}

export function isSupportedHfCliVersion(value: string): boolean {
  const match = value.match(HF_CLI_VERSION);
  return match !== null && BigInt(match[1] as string) >= 23n;
}

export function createInstallId(): string {
  return randomBytes(32).toString("hex");
}

export function isInstallId(value: string): boolean {
  return INSTALL_ID.test(value);
}

export function parseTargetIds(
  spaceInput: string,
  bucketInput?: string,
): { namespace: string; spaceId: string; bucketId: string } {
  if (spaceInput.includes("://")) throw new Error("Space must be an explicit ID");
  const parts = spaceInput.split("/");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !ID_PART.test(parts[0]) ||
    !ID_PART.test(parts[1])
  ) {
    throw new Error("Space must be <namespace>/<space>");
  }
  const namespace = parts[0];
  const bucketId = bucketInput ?? `${namespace}/${parts[1]}-artifacts`;
  if (bucketId.includes("://")) throw new Error("Bucket must be an explicit ID");
  const bucketParts = bucketId.split("/");
  if (
    bucketParts.length !== 2 ||
    bucketParts[0] !== namespace ||
    !bucketParts[1] ||
    !ID_PART.test(bucketParts[1])
  ) {
    throw new Error("Bucket must be in the Space namespace");
  }
  return { namespace, spaceId: spaceInput, bucketId };
}

export function validateOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.hf\.space$/.test(url.hostname)
  ) {
    throw new Error("Space origin must be a canonical Hugging Face Space origin");
  }
  return url.origin;
}

export function expectedVariables(
  namespace: string,
  bucketId: string,
  origin: string | null,
  subject: string,
  revision: string,
  binding: {
    installId: string;
    manifestDigest: string;
    phase: InstallPhase;
  },
): Record<string, string | null> {
  if (!isInstallId(binding.installId) || !DIGEST.test(binding.manifestDigest)) {
    throw new Error("installer binding is invalid");
  }
  return {
    HARBOR_HF_AUTH_MODE: "oauth",
    HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS: subject,
    HARBOR_HF_BUCKET_ID: bucketId,
    HARBOR_HF_BUNDLE_MANIFEST_DIGEST: binding.manifestDigest,
    HARBOR_HF_INSTALL_ID: binding.installId,
    HARBOR_HF_INSTALL_PHASE: binding.phase,
    HARBOR_HF_INSTALLER_MARKER: INSTALLER_MARKER,
    HARBOR_HF_INSTALLER_VERSION: INSTALLER_VERSION,
    HARBOR_HF_NAMESPACE: namespace,
    HARBOR_HF_PUBLIC_ORIGIN: origin === null ? null : validateOrigin(origin),
    HARBOR_HF_SOURCE_REVISION: revision,
    HARBOR_HF_STORE_MODE: "bucket",
    HARBOR_HF_WRITE_MODE: "disabled",
  };
}

function safeRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (
    !value ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("bundle contains an unsafe path");
  }
  return value;
}

export async function buildBundleManifest(directory: string): Promise<BundleFile[]> {
  const root = resolve(directory);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("bundle must be a non-symlink directory");
  }
  const rootReal = await realpath(root);
  const files: BundleFile[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("bundle symlinks are not allowed");
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) throw new Error("bundle contains a non-regular file");
      const pathReal = await realpath(path);
      if (!pathReal.startsWith(`${rootReal}${sep}`)) {
        throw new Error("bundle file escapes its directory");
      }
      const hash = createHash("sha256");
      const handle = await open(path, O_RDONLY | O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.size !== info.size ||
          opened.mode !== info.mode
        ) {
          throw new Error("bundle file changed while opening");
        }
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          hash.update(chunk);
        }
        const finished = await handle.stat();
        if (
          finished.size !== opened.size ||
          finished.mode !== opened.mode ||
          finished.mtimeMs !== opened.mtimeMs
        ) {
          throw new Error("bundle file changed while hashing");
        }
      } finally {
        await handle.close();
      }
      files.push({
        path: safeRelativePath(root, path),
        mode: (info.mode & 0o777).toString(8).padStart(4, "0"),
        size: info.size,
        sha256: `sha256:${hash.digest("hex")}`,
      });
    }
  };
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export function manifestDigest(manifest: BundleFile[]): string {
  return sha256(canonicalJson(manifest));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...expected].sort())
  ) {
    throw new Error(`${label} fields are invalid`);
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`invalid plan field: ${key}`);
  return value;
}

function nullableStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`invalid plan field: ${key}`);
  }
  return value;
}

function parseRemoteState(value: Record<string, unknown>): RemoteState {
  requireExactKeys(
    value,
    ["namespaceListingsComplete", "space", "bucket"],
    "remote precondition",
  );
  if (value.namespaceListingsComplete !== true) {
    throw new Error("remote precondition listing is incomplete");
  }
  let space: SpaceState | null = null;
  if (value.space !== null) {
    if (!isRecord(value.space)) throw new Error("Space precondition is invalid");
    requireExactKeys(
      value.space,
      [
        "id",
        "private",
        "sdk",
        "origin",
        "sha",
        "runtimeStage",
        "hardware",
        "requestedHardware",
        "variables",
        "secretNames",
      ],
      "Space precondition",
    );
    const variables = value.space.variables;
    const secretNames = value.space.secretNames;
    if (value.space.private !== true && value.space.private !== false) {
      throw new Error("Space privacy precondition is invalid");
    }
    if (
      !isRecord(variables) ||
      Object.values(variables).some((item) => typeof item !== "string") ||
      !Array.isArray(secretNames) ||
      secretNames.some((item) => typeof item !== "string") ||
      new Set(secretNames).size !== secretNames.length
    ) {
      throw new Error("Space settings precondition is invalid");
    }
    const sortedSecrets = [...secretNames].sort();
    if (JSON.stringify(secretNames) !== JSON.stringify(sortedSecrets)) {
      throw new Error("Space secret precondition is not sorted");
    }
    space = {
      id: stringField(value.space, "id"),
      private: value.space.private,
      sdk: stringField(value.space, "sdk"),
      origin: validateOrigin(stringField(value.space, "origin")),
      sha: nullableStringField(value.space, "sha"),
      runtimeStage: nullableStringField(value.space, "runtimeStage"),
      hardware: nullableStringField(value.space, "hardware"),
      requestedHardware: nullableStringField(value.space, "requestedHardware"),
      variables: variables as Record<string, string>,
      secretNames: sortedSecrets,
    };
    if (space.sha !== null && !REVISION.test(space.sha)) {
      throw new Error("Space revision precondition is invalid");
    }
  }
  let bucket: BucketState | null = null;
  if (value.bucket !== null) {
    if (!isRecord(value.bucket)) throw new Error("Bucket precondition is invalid");
    requireExactKeys(value.bucket, ["id", "private"], "Bucket precondition");
    if (value.bucket.private !== true && value.bucket.private !== false) {
      throw new Error("Bucket privacy precondition is invalid");
    }
    bucket = {
      id: stringField(value.bucket, "id"),
      private: value.bucket.private,
    };
  }
  return { namespaceListingsComplete: true, space, bucket };
}

export function validatePlan(value: unknown): InstallPlan {
  if (!isRecord(value) || value.schema_version !== PLAN_SCHEMA) {
    throw new UnsupportedInstallPlanError("unsupported install plan");
  }
  requireExactKeys(
    value,
    [
      "schema_version",
      "install_id",
      "production_ready",
      "source",
      "bundle",
      "hf_cli_version",
      "targets",
      "principal",
      "expected_variables",
      "expected_secret_names",
      "observed_preconditions",
    ],
    "install plan",
  );
  if (value.production_ready !== false) throw new Error("invalid production flag");
  const installId = stringField(value, "install_id");
  if (!isInstallId(installId)) throw new Error("install ID is invalid");
  const source = value.source;
  const bundle = value.bundle;
  const targets = value.targets;
  const principal = value.principal;
  const variables = value.expected_variables;
  const secrets = value.expected_secret_names;
  const observed = value.observed_preconditions;
  if (
    !isRecord(source) ||
    !isRecord(bundle) ||
    !isRecord(targets) ||
    !isRecord(principal) ||
    !isRecord(variables) ||
    !Array.isArray(secrets) ||
    !isRecord(observed)
  ) {
    throw new Error("install plan shape is invalid");
  }
  requireExactKeys(source, ["revision", "repository_root"], "source");
  requireExactKeys(bundle, ["directory", "manifest", "manifest_digest"], "bundle");
  requireExactKeys(targets, ["namespace", "space_id", "bucket_id"], "targets");
  requireExactKeys(principal, ["subject", "username", "organizations"], "principal");
  const revision = stringField(source, "revision");
  if (!REVISION.test(revision)) throw new Error("source revision is invalid");
  const manifestValue = bundle.manifest;
  if (!Array.isArray(manifestValue)) throw new Error("bundle manifest is invalid");
  const manifest: BundleFile[] = manifestValue.map((item) => {
    if (!isRecord(item)) throw new Error("bundle manifest entry is invalid");
    requireExactKeys(item, ["path", "mode", "size", "sha256"], "manifest entry");
    const path = stringField(item, "path");
    const mode = stringField(item, "mode");
    const digest = stringField(item, "sha256");
    const size = item.size;
    if (
      path.startsWith("/") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^0[0-7]{3}$/.test(mode) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !DIGEST.test(digest)
    ) {
      throw new Error("bundle manifest entry is invalid");
    }
    return { path, mode, size, sha256: digest };
  });
  if (
    new Set(manifest.map((item) => item.path)).size !== manifest.length ||
    JSON.stringify(manifest) !==
      JSON.stringify(
        [...manifest].sort((left, right) => left.path.localeCompare(right.path, "en")),
      ) ||
    stringField(bundle, "manifest_digest") !== manifestDigest(manifest)
  ) {
    throw new Error("bundle manifest digest is invalid");
  }
  const ids = parseTargetIds(
    stringField(targets, "space_id"),
    stringField(targets, "bucket_id"),
  );
  if (ids.namespace !== stringField(targets, "namespace")) {
    throw new Error("target namespace is invalid");
  }
  const expectedSecrets = [...SECRET_NAMES];
  if (
    secrets.some((item) => typeof item !== "string") ||
    JSON.stringify(secrets) !== JSON.stringify(expectedSecrets)
  ) {
    throw new Error("secret names are invalid");
  }
  const variableRecord: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(variables)) {
    if (typeof item !== "string" && item !== null) {
      throw new Error("expected variables are invalid");
    }
    variableRecord[key] = item;
  }
  if (
    typeof variableRecord.HARBOR_HF_PUBLIC_ORIGIN !== "string" &&
    !(
      variableRecord.HARBOR_HF_PUBLIC_ORIGIN === null &&
      (observed as Record<string, unknown>).space === null
    )
  ) {
    throw new Error("planned Space origin is invalid");
  }
  const organizationValue = principal.organizations;
  if (
    !Array.isArray(organizationValue) ||
    organizationValue.some((item) => typeof item !== "string")
  ) {
    throw new Error("principal organizations are invalid");
  }
  const organizations = organizationValue as string[];
  if (
    new Set(organizations).size !== organizations.length ||
    JSON.stringify(organizations) !== JSON.stringify([...organizations].sort())
  ) {
    throw new Error("principal organizations are invalid");
  }
  const subject = stringField(principal, "subject");
  const username = stringField(principal, "username");
  if (!subject || !username) throw new Error("principal identity is invalid");
  const repositoryRoot = stringField(source, "repository_root");
  const bundleDirectory = stringField(bundle, "directory");
  if (
    !isAbsolute(repositoryRoot) ||
    resolve(repositoryRoot) !== repositoryRoot ||
    !isAbsolute(bundleDirectory) ||
    resolve(bundleDirectory) !== bundleDirectory
  ) {
    throw new Error("plan paths must be absolute and normalized");
  }
  const hfCliVersion = stringField(value, "hf_cli_version");
  if (!isSupportedHfCliVersion(hfCliVersion)) {
    throw new Error("plan hf CLI version is invalid");
  }
  const remoteState = parseRemoteState(observed);
  const origin = remoteState.space?.origin ?? null;
  const requiredVariables = expectedVariables(
    ids.namespace,
    ids.bucketId,
    origin,
    subject,
    revision,
    {
      installId,
      manifestDigest: stringField(bundle, "manifest_digest"),
      phase: "installed",
    },
  );
  if (canonicalJson(variableRecord) !== canonicalJson(requiredVariables)) {
    throw new Error("expected variables do not match the installer contract");
  }
  const plan = value as unknown as InstallPlan;
  if (
    plan.bundle.directory !== bundleDirectory ||
    plan.source.repository_root !== repositoryRoot ||
    plan.hf_cli_version !== hfCliVersion ||
    plan.principal.subject !== subject ||
    plan.principal.username !== username
  ) {
    throw new Error("install plan string field is invalid");
  }
  return {
    ...plan,
    bundle: { ...plan.bundle, manifest },
    principal: { subject, username, organizations },
    expected_variables: variableRecord,
    expected_secret_names: expectedSecrets,
    observed_preconditions: remoteState,
  };
}

export async function writePrivatePlan(pathInput: string, plan: InstallPlan) {
  const path = resolve(pathInput);
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("plan path must not be a symlink");
    }
    throw new Error("plan path already exists");
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
    ) {
      throw error;
    }
  }
  const bytes = `${canonicalJson(plan)}\n`;
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  return { path, digest: sha256(bytes) };
}

export async function readPrivatePlan(pathInput: string): Promise<{
  path: string;
  bytes: string;
  digest: string;
  plan: InstallPlan;
}> {
  const path = resolve(pathInput);
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o777) !== 0o600 ||
    info.uid !== process.getuid?.()
  ) {
    throw new Error("plan must be an owner-only non-symlink regular file");
  }
  const parent = await stat(dirname(path));
  if (!parent.isDirectory()) throw new Error("plan parent is invalid");
  if (info.size > 32 * 1024 * 1024) throw new Error("plan exceeds size limit");
  const handle = await open(path, O_RDONLY | O_NOFOLLOW);
  let bytes: string;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== info.uid ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size !== info.size ||
      (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error("plan changed while opening");
    }
    bytes = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("plan is not valid JSON");
  }
  return { path, bytes, digest: sha256(bytes), plan: validatePlan(value) };
}

export function assertManifestEqual(
  expected: BundleFile[],
  observed: BundleFile[],
): void {
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    throw new Error("bundle does not match the install plan");
  }
}

export function assertRevision(value: string): void {
  if (!REVISION.test(value)) throw new Error("Git revision is invalid");
}

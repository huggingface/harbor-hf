import { spawn } from "node:child_process";
import { O_CREAT, O_NOFOLLOW, O_RDONLY, O_RDWR } from "node:constants";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "./canonical.js";
import { sanitizedChildEnvironment } from "./environment.js";
import {
  type InstallPhase,
  type InstallPlan,
  isInstallId,
  parseTargetIds,
  readPrivatePlan,
  UnsupportedInstallPlanError,
} from "./model.js";

const STATE_SCHEMA = "harbor-hf.install-state.v1";
const BOOTSTRAP_RECEIPT_SCHEMA = "harbor-hf.install-bootstrap-receipt.v1";
const POINTER_BYTES_LIMIT = 16 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;

interface StatePointer {
  schema_version: typeof STATE_SCHEMA;
  space_id: string;
  generation: string;
}

export interface BootstrapReceipt {
  schema_version: typeof BOOTSTRAP_RECEIPT_SCHEMA;
  install_id: string;
  plan_digest: string;
  space_id: string;
  bucket_id: string;
  source_revision: string;
  manifest_digest: string;
  uploaded_sha?: string;
}

export interface PreparedInstallState {
  stateRoot: string;
  targetDirectory: string;
  generationDirectory: string;
  bundleDirectory: string;
  planPath: string;
}

async function acquireInstallerLock(path: string): Promise<FileHandle> {
  const handle = await open(path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
      throw new Error("installer operation lock must be owner-only");
    }
    assertOwned(info, "installer operation lock");
    await acquireAdvisoryLock(handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function acquireAdvisoryLock(handle: FileHandle): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // The parent retains the same Linux open file description after flock exits.
    const locker = spawn("flock", ["--exclusive", "--nonblock", "3"], {
      env: sanitizedChildEnvironment(),
      stdio: ["ignore", "ignore", "ignore", handle.fd],
    });
    const timeout = setTimeout(() => {
      locker.kill();
      rejectPromise(new Error("installer operation lock timed out"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      locker.off("error", onError);
      locker.off("exit", onExit);
    };
    const onError = () => {
      cleanup();
      rejectPromise(new Error("OS advisory locking is unavailable"));
    };
    const onExit = (code: number | null) => {
      cleanup();
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(
            code === 1
              ? "another installer operation is active"
              : "installer operation lock failed",
          ),
        );
      }
    };
    locker.once("error", onError);
    locker.once("exit", onExit);
    if (locker.exitCode !== null) onExit(locker.exitCode);
  });
}

export async function withInstallerStateLock<T>(
  spaceId: string,
  stateRootInput: string,
  operation: () => Promise<T>,
): Promise<T> {
  parseTargetIds(spaceId);
  const stateRoot = resolve(stateRootInput);
  await ensurePrivateDirectory(stateRoot);
  const target = targetDirectory(stateRoot, spaceId);
  await ensurePrivateDirectory(target);
  const lockPath = resolve(target, ".operation.lock");
  const lock = await acquireInstallerLock(lockPath);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let releaseError: unknown;
  try {
    await lock.close();
  } catch (error) {
    releaseError = error;
  }
  if (!outcome.ok) throw outcome.error;
  if (releaseError) throw releaseError;
  return outcome.value;
}

function targetKey(spaceId: string): string {
  return createHash("sha256").update(spaceId).digest("hex");
}

function currentUid(): number | undefined {
  return process.getuid?.();
}

function assertOwned(info: { uid: number }, label: string): void {
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`${label} is not owned by the current user`);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("installer state path must be a non-symlink directory");
  }
  assertOwned(info, "installer state directory");
  await chmod(path, 0o700);
  const finished = await stat(path);
  if (!finished.isDirectory() || (finished.mode & 0o777) !== 0o700) {
    throw new Error("installer state directory must be owner-only");
  }
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error("installer state directory must be owner-only");
  }
  assertOwned(info, "installer state directory");
}

export function installerStateRoot(
  override: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error("installer state override must be an absolute path");
    }
    return resolve(override);
  }
  const xdgStateHome = environment.XDG_STATE_HOME;
  if (xdgStateHome) {
    if (!isAbsolute(xdgStateHome)) {
      throw new Error("XDG_STATE_HOME must be an absolute path");
    }
    return resolve(xdgStateHome, "harbor-hf", "install");
  }
  if (!isAbsolute(home)) throw new Error("user home directory must be absolute");
  return resolve(home, ".local", "state", "harbor-hf", "install");
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

interface PhysicalLocation {
  existingAncestor: string;
  location: string;
}

async function physicalLocationWithoutCreating(
  path: string,
): Promise<PhysicalLocation> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
      continue;
    }
    const existingAncestor = await realpath(current);
    return {
      existingAncestor,
      location: resolve(existingAncestor, ...missing),
    };
  }
}

async function assertTrustedStateAncestor(existingAncestor: string): Promise<void> {
  const uid = currentUid();
  if (uid === undefined) {
    throw new Error("installer state validation requires a Unix user identity");
  }
  const pathComponents: string[] = [];
  let root = existingAncestor;
  while (true) {
    const parent = dirname(root);
    if (parent === root) break;
    pathComponents.unshift(basename(root));
    root = parent;
  }

  let current = root;
  let currentInfo = await lstat(current);
  for (const component of pathComponents) {
    if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) {
      throw new Error("installer state ancestor changed during validation");
    }
    const parentInfo = currentInfo;
    if (parentInfo.uid !== uid && parentInfo.uid !== 0) {
      throw new Error(
        "installer state ancestor is beneath a directory with an untrusted owner",
      );
    }
    const child = resolve(current, component);
    const childInfo = await lstat(child);
    if (!childInfo.isDirectory() || childInfo.isSymbolicLink()) {
      throw new Error("installer state ancestor changed during validation");
    }
    if ((parentInfo.mode & 0o022) !== 0) {
      const sticky = (parentInfo.mode & 0o1000) !== 0;
      if (!sticky || childInfo.uid !== uid) {
        throw new Error(
          "installer state ancestor is beneath an unsafe shared-writable directory",
        );
      }
    }
    current = child;
    currentInfo = childInfo;
  }
  if (currentInfo.uid !== uid || (currentInfo.mode & 0o022) !== 0) {
    throw new Error(
      "installer state ancestor must be current-user-owned and not shared-writable",
    );
  }
}

export async function assertInstallerStateOutsideRepository(
  stateRoot: string,
  repositoryRoot: string,
): Promise<string> {
  const [state, repositoryLocation] = await Promise.all([
    physicalLocationWithoutCreating(stateRoot),
    realpath(repositoryRoot),
  ]);
  if (isInside(repositoryLocation, state.location)) {
    throw new Error("installer state must be outside the source checkout");
  }
  await assertTrustedStateAncestor(state.existingAncestor);
  return state.location;
}

function targetDirectory(stateRoot: string, spaceId: string): string {
  return resolve(stateRoot, targetKey(spaceId));
}

export async function prepareInstallState(
  spaceId: string,
  stateRootInput: string,
): Promise<PreparedInstallState> {
  parseTargetIds(spaceId);
  const stateRoot = resolve(stateRootInput);
  await ensurePrivateDirectory(stateRoot);
  const target = targetDirectory(stateRoot, spaceId);
  await ensurePrivateDirectory(target);
  const generation = await mkdtemp(resolve(target, "plan-"));
  await chmod(generation, 0o700);
  return {
    stateRoot,
    targetDirectory: target,
    generationDirectory: generation,
    bundleDirectory: resolve(generation, "bundle"),
    planPath: resolve(generation, "plan.json"),
  };
}

async function writePointer(path: string, pointer: StatePointer): Promise<void> {
  const temporaryPath = resolve(
    dirname(path),
    `.current-${randomUUID().replaceAll("-", "")}.json`,
  );
  const bytes = `${canonicalJson(pointer)}\n`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function activateInstallState(
  prepared: PreparedInstallState,
  spaceId: string,
): Promise<void> {
  const expectedTarget = targetDirectory(resolve(prepared.stateRoot), spaceId);
  if (
    prepared.targetDirectory !== expectedTarget ||
    dirname(prepared.generationDirectory) !== expectedTarget ||
    prepared.bundleDirectory !== resolve(prepared.generationDirectory, "bundle") ||
    prepared.planPath !== resolve(prepared.generationDirectory, "plan.json")
  ) {
    throw new Error("prepared installer state does not match its target");
  }
  const loaded = await readPrivatePlan(prepared.planPath);
  if (loaded.plan.targets.space_id !== spaceId) {
    throw new Error("saved plan target does not match installer state");
  }
  const generation = basename(prepared.generationDirectory);
  if (!/^plan-[A-Za-z0-9]{6}$/.test(generation)) {
    throw new Error("installer plan generation is invalid");
  }
  await writePointer(resolve(prepared.targetDirectory, "current.json"), {
    schema_version: STATE_SCHEMA,
    space_id: spaceId,
    generation,
  });
}

export async function discardInstallState(
  prepared: PreparedInstallState,
): Promise<void> {
  await rm(prepared.generationDirectory, { recursive: true, force: true });
}

function parsePointer(value: unknown): StatePointer {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "generation,schema_version,space_id"
  ) {
    throw new Error("installer state pointer is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema_version !== STATE_SCHEMA ||
    typeof record.space_id !== "string" ||
    typeof record.generation !== "string" ||
    !/^plan-[A-Za-z0-9]{6}$/.test(record.generation)
  ) {
    throw new Error("installer state pointer is invalid");
  }
  parseTargetIds(record.space_id);
  return {
    schema_version: STATE_SCHEMA,
    space_id: record.space_id,
    generation: record.generation,
  };
}

async function readPointer(path: string): Promise<StatePointer> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > POINTER_BYTES_LIMIT
  ) {
    throw new Error("installer state pointer must be owner-only");
  }
  assertOwned(info, "installer state pointer");
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
      throw new Error("installer state pointer changed while opening");
    }
    bytes = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("installer state pointer is not valid JSON");
  }
  return parsePointer(value);
}

function parseBootstrapReceipt(value: unknown): BootstrapReceipt {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![
      "bucket_id,install_id,manifest_digest,plan_digest,schema_version,source_revision,space_id",
      "bucket_id,install_id,manifest_digest,plan_digest,schema_version,source_revision,space_id,uploaded_sha",
    ].includes(Object.keys(value).sort().join(","))
  ) {
    throw new Error("installer bootstrap receipt is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema_version !== BOOTSTRAP_RECEIPT_SCHEMA ||
    typeof record.install_id !== "string" ||
    !isInstallId(record.install_id) ||
    typeof record.plan_digest !== "string" ||
    !DIGEST.test(record.plan_digest) ||
    typeof record.space_id !== "string" ||
    typeof record.bucket_id !== "string" ||
    typeof record.source_revision !== "string" ||
    !REVISION.test(record.source_revision) ||
    typeof record.manifest_digest !== "string" ||
    !DIGEST.test(record.manifest_digest) ||
    (record.uploaded_sha !== undefined &&
      (typeof record.uploaded_sha !== "string" || !REVISION.test(record.uploaded_sha)))
  ) {
    throw new Error("installer bootstrap receipt is invalid");
  }
  const ids = parseTargetIds(record.space_id, record.bucket_id);
  return {
    schema_version: BOOTSTRAP_RECEIPT_SCHEMA,
    install_id: record.install_id,
    plan_digest: record.plan_digest,
    space_id: ids.spaceId,
    bucket_id: ids.bucketId,
    source_revision: record.source_revision,
    manifest_digest: record.manifest_digest,
    ...(record.uploaded_sha === undefined
      ? {}
      : { uploaded_sha: record.uploaded_sha as string }),
  };
}

function bootstrapReceiptPath(planPath: string): string {
  return resolve(dirname(resolve(planPath)), "bootstrap-receipt.json");
}

export async function readBootstrapReceipt(
  planPath: string,
): Promise<BootstrapReceipt | undefined> {
  const path = bootstrapReceiptPath(planPath);
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > POINTER_BYTES_LIMIT
  ) {
    throw new Error("installer bootstrap receipt must be owner-only");
  }
  assertOwned(info, "installer bootstrap receipt");
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
      throw new Error("installer bootstrap receipt changed while opening");
    }
    bytes = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("installer bootstrap receipt is not valid JSON");
  }
  return parseBootstrapReceipt(value);
}

export async function writeBootstrapReceipt(
  planPath: string,
  receipt: BootstrapReceipt,
): Promise<void> {
  const validated = parseBootstrapReceipt(receipt);
  const existing = await readBootstrapReceipt(planPath);
  if (existing) {
    if (canonicalJson(existing) === canonicalJson(validated)) return;
    const { uploaded_sha: existingUpload, ...existingBase } = existing;
    const { uploaded_sha: validatedUpload, ...validatedBase } = validated;
    if (
      existingUpload !== undefined ||
      validatedUpload === undefined ||
      canonicalJson(existingBase) !== canonicalJson(validatedBase)
    ) {
      throw new Error("installer bootstrap receipt already exists");
    }
  }
  const path = bootstrapReceiptPath(planPath);
  const temporaryPath = resolve(
    dirname(path),
    `.bootstrap-receipt-${randomUUID().replaceAll("-", "")}.json`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(validated)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (existing) await rename(temporaryPath, path);
      else await link(temporaryPath, path);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
        )
      ) {
        throw error;
      }
      const concurrent = await readBootstrapReceipt(planPath);
      if (!concurrent || canonicalJson(concurrent) !== canonicalJson(validated)) {
        throw new Error("installer bootstrap receipt already exists");
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
  await chmod(path, 0o600);
}

async function currentInstallPlanFilePath(
  spaceId: string,
  stateRootInput: string,
): Promise<string> {
  parseTargetIds(spaceId);
  const stateRoot = resolve(stateRootInput);
  await requirePrivateDirectory(stateRoot);
  const target = targetDirectory(stateRoot, spaceId);
  await requirePrivateDirectory(target);
  const pointer = await readPointer(resolve(target, "current.json"));
  if (pointer.space_id !== spaceId) {
    throw new Error("installer state target does not match the requested Space");
  }
  const generation = resolve(target, pointer.generation);
  const pathFromTarget = relative(target, generation);
  if (pathFromTarget !== pointer.generation) {
    throw new Error("installer state generation escapes its target");
  }
  await requirePrivateDirectory(generation);
  return resolve(generation, "plan.json");
}

async function bootstrapReceiptPaths(
  spaceId: string,
  stateRootInput: string,
): Promise<string[]> {
  const stateRoot = resolve(stateRootInput);
  const target = targetDirectory(stateRoot, spaceId);
  let entries: Dirent[];
  try {
    await requirePrivateDirectory(stateRoot);
    await requirePrivateDirectory(target);
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^plan-[A-Za-z0-9]{6}$/.test(entry.name)) {
      continue;
    }
    const generation = resolve(target, entry.name);
    await requirePrivateDirectory(generation);
    const planPath = resolve(generation, "plan.json");
    if (await readBootstrapReceipt(planPath)) {
      paths.push(planPath);
    }
  }
  return paths;
}

export async function currentInstallPlanPath(
  spaceId: string,
  stateRootInput: string,
): Promise<string> {
  const planPath = await currentInstallPlanFilePath(spaceId, stateRootInput);
  const loaded = await readPrivatePlan(planPath);
  if (loaded.plan.targets.space_id !== spaceId) {
    throw new Error("saved plan target does not match the requested Space");
  }
  return planPath;
}

export async function findCurrentInstallPlanPath(
  spaceId: string,
  stateRootInput: string,
): Promise<string | undefined> {
  const receiptPaths = await bootstrapReceiptPaths(spaceId, stateRootInput);
  let planPath: string;
  try {
    planPath = await currentInstallPlanFilePath(spaceId, stateRootInput);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      if (receiptPaths.length > 0) {
        throw new Error(
          "installer state pointer is missing while bootstrap proof exists; manual recovery is required",
        );
      }
      return undefined;
    }
    throw error;
  }
  try {
    const loaded = await readPrivatePlan(planPath);
    if (loaded.plan.targets.space_id !== spaceId) {
      throw new Error("saved plan target does not match the requested Space");
    }
    if (receiptPaths.length > 0 && !receiptPaths.includes(planPath)) {
      throw new Error(
        "bootstrap proof exists outside the current installer generation; manual recovery is required",
      );
    }
    return planPath;
  } catch (error) {
    if (error instanceof UnsupportedInstallPlanError) {
      if (receiptPaths.length > 0) {
        throw new Error(
          "unsupported installer state contains a bootstrap receipt; manual recovery is required",
        );
      }
      return undefined;
    }
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      if (receiptPaths.length > 0) {
        throw new Error(
          "installer plan is missing beside a bootstrap receipt; manual recovery is required",
        );
      }
      throw new Error("current installer plan is missing");
    }
    throw error;
  }
}

export async function carryBootstrapReceipt(
  previousPlanPath: string,
  nextPlanPath: string,
  nextPlan: InstallPlan,
  nextPlanDigest: string,
): Promise<boolean> {
  const receipt = await readBootstrapReceipt(previousPlanPath);
  if (!receipt) return false;
  const previous = await readPrivatePlan(previousPlanPath);
  if (
    receipt.plan_digest !== previous.digest ||
    receipt.install_id !== previous.plan.install_id ||
    receipt.space_id !== previous.plan.targets.space_id ||
    receipt.bucket_id !== previous.plan.targets.bucket_id ||
    receipt.source_revision !== previous.plan.source.revision ||
    receipt.manifest_digest !== previous.plan.bundle.manifest_digest ||
    receipt.install_id !== nextPlan.install_id ||
    receipt.space_id !== nextPlan.targets.space_id ||
    receipt.bucket_id !== nextPlan.targets.bucket_id ||
    receipt.source_revision !== nextPlan.source.revision ||
    receipt.manifest_digest !== nextPlan.bundle.manifest_digest
  ) {
    throw new Error("bootstrap receipt cannot be carried to the new plan");
  }
  await writeBootstrapReceipt(nextPlanPath, {
    ...receipt,
    plan_digest: nextPlanDigest,
  });
  return true;
}

function receiptForPlan(plan: InstallPlan, planDigest: string): BootstrapReceipt {
  return {
    schema_version: BOOTSTRAP_RECEIPT_SCHEMA,
    install_id: plan.install_id,
    plan_digest: planDigest,
    space_id: plan.targets.space_id,
    bucket_id: plan.targets.bucket_id,
    source_revision: plan.source.revision,
    manifest_digest: plan.bundle.manifest_digest,
  };
}

async function assertReceiptMatchesPreviousPlan(
  previousPlanPath: string,
  receipt: BootstrapReceipt,
): Promise<void> {
  const previous = await readPrivatePlan(previousPlanPath);
  if (
    receipt.plan_digest !== previous.digest ||
    receipt.install_id !== previous.plan.install_id ||
    receipt.space_id !== previous.plan.targets.space_id ||
    receipt.bucket_id !== previous.plan.targets.bucket_id ||
    receipt.source_revision !== previous.plan.source.revision ||
    receipt.manifest_digest !== previous.plan.bundle.manifest_digest
  ) {
    throw new Error("bootstrap receipt does not match the previous plan");
  }
}

function assertInstalledReceiptAttestation(plan: InstallPlan): void {
  const observed = plan.observed_preconditions;
  if (
    !observed.space ||
    !observed.bucket ||
    observed.space.id !== plan.targets.space_id ||
    observed.bucket.id !== plan.targets.bucket_id ||
    !observed.bucket.private ||
    observed.space.variables.HARBOR_HF_INSTALL_PHASE !== "installed" ||
    observed.space.variables.HARBOR_HF_INSTALL_ID !== plan.install_id
  ) {
    throw new Error("installed resources cannot establish bootstrap proof");
  }
}

export async function preserveBootstrapReceipt(
  previousPlanPath: string | undefined,
  nextPlanPath: string,
  nextPlan: InstallPlan,
  nextPlanDigest: string,
  remote: {
    spacePresent: boolean;
    bucketPresent: boolean;
    phase: InstallPhase | null;
  },
): Promise<void> {
  const receipt = previousPlanPath
    ? await readBootstrapReceipt(previousPlanPath)
    : undefined;
  if (!receipt) {
    if (remote.spacePresent && remote.bucketPresent && remote.phase === "installed") {
      assertInstalledReceiptAttestation(nextPlan);
      await writeBootstrapReceipt(
        nextPlanPath,
        receiptForPlan(nextPlan, nextPlanDigest),
      );
      return;
    }
    if (
      remote.bucketPresent &&
      (remote.phase === "credentials_required" || remote.phase === "source_staged")
    ) {
      throw new Error(
        "bootstrap receipt is unavailable; the original private installer state is required",
      );
    }
    return;
  }
  if (!remote.spacePresent || !remote.bucketPresent) {
    throw new Error(
      "bootstrap receipt exists but a proven resource is missing; manual recovery is required",
    );
  }
  if (remote.phase === "installed") {
    if (!previousPlanPath) {
      throw new Error("bootstrap receipt has no previous installer plan");
    }
    await assertReceiptMatchesPreviousPlan(previousPlanPath, receipt);
    assertInstalledReceiptAttestation(nextPlan);
    const uploadStillMatchesPlan =
      receipt.source_revision === nextPlan.source.revision &&
      receipt.manifest_digest === nextPlan.bundle.manifest_digest;
    await writeBootstrapReceipt(nextPlanPath, {
      ...receiptForPlan(nextPlan, nextPlanDigest),
      ...(receipt.uploaded_sha && uploadStillMatchesPlan
        ? { uploaded_sha: receipt.uploaded_sha }
        : {}),
    });
    return;
  }
  if (remote.phase !== "credentials_required" && remote.phase !== "source_staged") {
    return;
  }
  if (
    !previousPlanPath ||
    !(await carryBootstrapReceipt(
      previousPlanPath,
      nextPlanPath,
      nextPlan,
      nextPlanDigest,
    ))
  ) {
    throw new Error(
      "bootstrap receipt is unavailable; the original private installer state is required",
    );
  }
}

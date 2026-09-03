import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectedVariables,
  type InstallPlan,
  manifestDigest,
  readPrivatePlan,
  writePrivatePlan,
} from "../model.js";
import {
  activateInstallState,
  assertInstallerStateOutsideRepository,
  carryBootstrapReceipt,
  currentInstallPlanPath,
  discardInstallState,
  findCurrentInstallPlanPath,
  installerStateRoot,
  prepareInstallState,
  preserveBootstrapReceipt,
  readBootstrapReceipt,
  withInstallerStateLock,
  writeBootstrapReceipt,
} from "../state.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "installer-state-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function initializeGitRepository(repository: string): Promise<void> {
  await writeFile(resolve(repository, "placeholder.txt"), "placeholder\n");
  for (const args of [
    ["init"],
    ["add", "placeholder.txt"],
    ["commit", "-m", "test: initialize placeholder repository"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "author-placeholder.invalid",
        GIT_AUTHOR_NAME: "Placeholder Author",
        GIT_COMMITTER_EMAIL: "committer-placeholder.invalid",
        GIT_COMMITTER_NAME: "Placeholder Committer",
      },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function plan(repository: string, bundle: string): InstallPlan {
  const revision = "a".repeat(40);
  const installId = "f".repeat(64);
  const bundleDigest = manifestDigest([]);
  return {
    schema_version: "harbor-hf.install-plan.v2",
    install_id: installId,
    production_ready: false,
    source: { revision, repository_root: repository },
    bundle: {
      directory: bundle,
      manifest: [],
      manifest_digest: bundleDigest,
    },
    hf_cli_version: "1.23.0",
    targets: {
      namespace: "example",
      space_id: "example/control",
      bucket_id: "example/control-artifacts",
    },
    principal: {
      subject: "stable-subject",
      username: "example-user",
      organizations: [],
    },
    expected_variables: expectedVariables(
      "example",
      "example/control-artifacts",
      null,
      "stable-subject",
      revision,
      {
        installId,
        manifestDigest: bundleDigest,
        phase: "installed",
      },
    ),
    expected_secret_names: ["HF_INFERENCE_TOKEN", "HF_TOKEN"],
    observed_preconditions: {
      namespaceListingsComplete: true,
      space: null,
      bucket: null,
    },
  };
}

async function savedState() {
  const directory = await temporaryDirectory();
  const root = resolve(directory, "state");
  const prepared = await prepareInstallState("example/control", root);
  await mkdir(prepared.bundleDirectory);
  await writePrivatePlan(
    prepared.planPath,
    plan(resolve(directory, "repository"), prepared.bundleDirectory),
  );
  await activateInstallState(prepared, "example/control");
  return { directory, root, prepared };
}

describe("private installer state", () => {
  it("uses XDG state with a private home fallback", () => {
    expect(
      installerStateRoot(undefined, { XDG_STATE_HOME: "/state-placeholder" }, "/home"),
    ).toBe("/state-placeholder/harbor-hf/install");
    expect(installerStateRoot(undefined, {}, "/home-placeholder")).toBe(
      "/home-placeholder/.local/state/harbor-hf/install",
    );
    expect(installerStateRoot("/override-placeholder", {}, "/home")).toBe(
      "/override-placeholder",
    );
    expect(() => installerStateRoot("relative-override", {}, "/home")).toThrow(
      "absolute",
    );
    expect(() =>
      installerStateRoot(undefined, { XDG_STATE_HOME: "relative" }, "/home"),
    ).toThrow("absolute");
  });

  it("validates physical state locations without creating them", async () => {
    const directory = await temporaryDirectory();
    const repository = resolve(directory, "repository");
    const external = resolve(directory, "external");
    await Promise.all([
      mkdir(repository, { mode: 0o700 }),
      mkdir(external, { mode: 0o700 }),
    ]);

    const internalState = resolve(repository, "missing", "state");
    await expect(
      assertInstallerStateOutsideRepository(internalState, repository),
    ).rejects.toThrow("outside the source checkout");
    await expect(access(internalState)).rejects.toThrow();

    const linkedAncestor = resolve(directory, "linked-repository");
    await symlink(repository, linkedAncestor);
    const linkedState = resolve(linkedAncestor, "missing", "state");
    await expect(
      assertInstallerStateOutsideRepository(linkedState, repository),
    ).rejects.toThrow("outside the source checkout");
    await expect(access(resolve(repository, "missing"))).rejects.toThrow();

    const missingExternalState = resolve(external, "missing", "state");
    await expect(
      assertInstallerStateOutsideRepository(missingExternalState, repository),
    ).resolves.toBe(missingExternalState);
    await expect(access(missingExternalState)).rejects.toThrow();
    await expect(
      assertInstallerStateOutsideRepository(external, repository),
    ).resolves.toBe(external);
    const safeStateLink = resolve(directory, "safe-state-link");
    await symlink(external, safeStateLink);
    await expect(
      assertInstallerStateOutsideRepository(safeStateLink, repository),
    ).resolves.toBe(external);

    const danglingAncestor = resolve(directory, "dangling");
    await symlink(resolve(repository, "not-created"), danglingAncestor);
    await expect(
      assertInstallerStateOutsideRepository(
        resolve(danglingAncestor, "state"),
        repository,
      ),
    ).rejects.toThrow();
    await expect(access(resolve(repository, "not-created"))).rejects.toThrow();

    const unsafeShared = resolve(directory, "unsafe-shared");
    const replaceableAncestor = resolve(unsafeShared, "replaceable");
    await mkdir(unsafeShared, { mode: 0o777 });
    await chmod(unsafeShared, 0o777);
    await mkdir(replaceableAncestor);
    await expect(
      assertInstallerStateOutsideRepository(
        resolve(replaceableAncestor, "state"),
        repository,
      ),
    ).rejects.toThrow("unsafe shared-writable");
  });

  it("rejects checkout-contained CLI state before creating it", async () => {
    const repository = await temporaryDirectory();
    await initializeGitRepository(repository);

    for (const [command, additionalArguments] of [
      ["cli-plan.ts", []],
      ["cli-provision.ts", []],
      ["cli-configure.ts", []],
      ["cli-verify.ts", []],
      ["cli-activate.ts", []],
      ["cli-disable.ts", []],
    ] as const) {
      const state = resolve(repository, `installer-state-${command}`);
      const result = spawnSync(
        resolve(process.cwd(), "node_modules/.bin/tsx"),
        [
          resolve(process.cwd(), "scripts/control-service/installer", command),
          "--space",
          "example/control",
          "--state-dir",
          state,
          ...additionalArguments,
        ],
        { cwd: repository, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "installer state must be outside the source checkout",
      );
      await expect(access(state)).rejects.toThrow();
    }
  });

  it("stores and resolves a target-bound owner-only current plan", async () => {
    const { root, prepared } = await savedState();
    await expect(currentInstallPlanPath("example/control", root)).resolves.toBe(
      prepared.planPath,
    );
    expect(basename(prepared.targetDirectory)).toMatch(/^[a-f0-9]{64}$/);
    for (const directory of [
      root,
      prepared.targetDirectory,
      prepared.generationDirectory,
    ]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect(
      (await stat(resolve(prepared.targetDirectory, "current.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      await readFile(resolve(prepared.targetDirectory, "current.json"), "utf8"),
    ).toContain('"space_id":"example/control"');
  });

  it("allows planning to replace an unsupported legacy local plan", async () => {
    const { root, prepared } = await savedState();
    const legacy = JSON.parse(await readFile(prepared.planPath, "utf8")) as Record<
      string,
      unknown
    >;
    legacy.schema_version = "harbor-hf.install-plan.v1";
    await writeFile(prepared.planPath, `${JSON.stringify(legacy)}\n`);

    await expect(
      findCurrentInstallPlanPath("example/control", root),
    ).resolves.toBeUndefined();
    await expect(currentInstallPlanPath("example/control", root)).rejects.toThrow(
      "unsupported install plan",
    );

    await writeBootstrapReceipt(prepared.planPath, {
      schema_version: "harbor-hf.install-bootstrap-receipt.v1",
      install_id: "f".repeat(64),
      plan_digest: `sha256:${"d".repeat(64)}`,
      space_id: "example/control",
      bucket_id: "example/control-artifacts",
      source_revision: "a".repeat(40),
      manifest_digest: `sha256:${"b".repeat(64)}`,
    });
    await expect(findCurrentInstallPlanPath("example/control", root)).rejects.toThrow(
      "manual recovery",
    );
  });

  it("rejects target confusion and insecure pointer state", async () => {
    const { root, prepared } = await savedState();
    await expect(currentInstallPlanPath("example/other", root)).rejects.toThrow();

    const pointer = resolve(prepared.targetDirectory, "current.json");
    await chmod(pointer, 0o644);
    await expect(currentInstallPlanPath("example/control", root)).rejects.toThrow(
      "owner-only",
    );

    await rm(pointer);
    const target = resolve(prepared.targetDirectory, "pointer-target");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, pointer);
    await expect(currentInstallPlanPath("example/control", root)).rejects.toThrow(
      "owner-only",
    );
  });

  it("does not hide a receipt when the selected plan file is missing", async () => {
    const { root, prepared } = await savedState();
    await writeBootstrapReceipt(prepared.planPath, {
      schema_version: "harbor-hf.install-bootstrap-receipt.v1",
      install_id: "f".repeat(64),
      plan_digest: `sha256:${"d".repeat(64)}`,
      space_id: "example/control",
      bucket_id: "example/control-artifacts",
      source_revision: "a".repeat(40),
      manifest_digest: `sha256:${"b".repeat(64)}`,
    });
    await rm(prepared.planPath);

    await expect(findCurrentInstallPlanPath("example/control", root)).rejects.toThrow(
      "manual recovery",
    );
  });

  it("does not hide proof in an older plan generation", async () => {
    const { directory, root, prepared } = await savedState();
    await writeBootstrapReceipt(prepared.planPath, {
      schema_version: "harbor-hf.install-bootstrap-receipt.v1",
      install_id: "f".repeat(64),
      plan_digest: `sha256:${"d".repeat(64)}`,
      space_id: "example/control",
      bucket_id: "example/control-artifacts",
      source_revision: "a".repeat(40),
      manifest_digest: `sha256:${"b".repeat(64)}`,
    });
    const next = await prepareInstallState("example/control", root);
    await mkdir(next.bundleDirectory);
    await writePrivatePlan(
      next.planPath,
      plan(resolve(directory, "repository"), next.bundleDirectory),
    );
    await activateInstallState(next, "example/control");

    await expect(findCurrentInstallPlanPath("example/control", root)).rejects.toThrow(
      "outside the current installer generation",
    );
  });

  it("removes an uncommitted plan generation", async () => {
    const directory = await temporaryDirectory();
    const prepared = await prepareInstallState(
      "example/control",
      resolve(directory, "state"),
    );
    await discardInstallState(prepared);
    await expect(lstat(prepared.generationDirectory)).rejects.toThrow();
  });

  it("serializes plan and apply operations for one target", async () => {
    const directory = await temporaryDirectory();
    const root = resolve(directory, "state");
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolvePromise) => {
      entered = resolvePromise;
    });
    const releasePromise = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const first = withInstallerStateLock("example/control", root, async () => {
      entered?.();
      await releasePromise;
    });
    await enteredPromise;

    await expect(
      withInstallerStateLock("example/control", root, async () => undefined),
    ).rejects.toThrow("another installer");
    release?.();
    await first;
    await expect(
      withInstallerStateLock("example/control", root, async () => "released"),
    ).resolves.toBe("released");
  });

  it("holds the advisory lock on the validated target file", async () => {
    const directory = await temporaryDirectory();
    const root = resolve(directory, "state");
    let lockPath = "";

    await withInstallerStateLock("example/control", root, async () => {
      const targets = await readdir(root);
      const target = targets[0];
      if (!target) throw new Error("installer target directory is missing");
      lockPath = resolve(root, target, ".operation.lock");

      const competingLock = spawnSync("flock", [
        "--exclusive",
        "--nonblock",
        lockPath,
        "/bin/true",
      ]);
      expect(competingLock.status).toBe(1);
    });

    const lockAfterRelease = spawnSync("flock", [
      "--exclusive",
      "--nonblock",
      lockPath,
      "/bin/true",
    ]);
    expect(lockAfterRelease.status).toBe(0);
  });

  it("does not pass installer credentials to the flock subprocess", async () => {
    const directory = await temporaryDirectory();
    const root = resolve(directory, "state");
    const toolDirectory = resolve(directory, "tools");
    const capturePath = resolve(directory, "flock-environment.txt");
    const flockPath = resolve(toolDirectory, "flock");
    await mkdir(toolDirectory);
    await writeFile(
      flockPath,
      `#!/bin/sh\n/usr/bin/env > '${capturePath}'\nexec /usr/bin/flock "$@"\n`,
      { mode: 0o700 },
    );
    const previous = {
      path: process.env.PATH,
      control: process.env.HARBOR_HF_INSTALL_CONTROL_SECRET,
      inference: process.env.HARBOR_HF_INSTALL_INFERENCE_SECRET,
      bearer: process.env.HARBOR_HF_CONTROL_BEARER_TOKEN,
    };
    process.env.PATH = `${toolDirectory}:/usr/bin:/bin`;
    process.env.HARBOR_HF_INSTALL_CONTROL_SECRET = "control-secret-placeholder";
    process.env.HARBOR_HF_INSTALL_INFERENCE_SECRET = "inference-secret-placeholder";
    process.env.HARBOR_HF_CONTROL_BEARER_TOKEN = "control-bearer-placeholder";
    try {
      await withInstallerStateLock("example/control", root, async () => undefined);
    } finally {
      for (const [name, value] of [
        ["PATH", previous.path],
        ["HARBOR_HF_INSTALL_CONTROL_SECRET", previous.control],
        ["HARBOR_HF_INSTALL_INFERENCE_SECRET", previous.inference],
        ["HARBOR_HF_CONTROL_BEARER_TOKEN", previous.bearer],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const captured = await readFile(capturePath, "utf8");
    expect(captured).not.toContain("HARBOR_HF_INSTALL_CONTROL_SECRET");
    expect(captured).not.toContain("HARBOR_HF_INSTALL_INFERENCE_SECRET");
    expect(captured).not.toContain("HARBOR_HF_CONTROL_BEARER_TOKEN");
    expect(captured).not.toContain("control-secret-placeholder");
    expect(captured).not.toContain("inference-secret-placeholder");
    expect(captured).not.toContain("control-bearer-placeholder");
  });

  it("prevents verify from observing a concurrent installer operation", async () => {
    const { root } = await savedState();
    const repository = await temporaryDirectory();
    await initializeGitRepository(repository);
    await withInstallerStateLock("example/control", root, async () => {
      const result = spawnSync(
        resolve(process.cwd(), "node_modules/.bin/tsx"),
        [
          resolve(process.cwd(), "scripts/control-service/installer/cli-verify.ts"),
          "--space",
          "example/control",
          "--state-dir",
          root,
        ],
        {
          cwd: repository,
          encoding: "utf8",
          env: {
            ...process.env,
            HARBOR_HF_CONTROL_BEARER_TOKEN: "control-bearer-placeholder",
          },
        },
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "another installer operation is active",
      );
    });
  });

  it("reclaims an owner-only lock after its process is gone", async () => {
    const directory = await temporaryDirectory();
    const root = resolve(directory, "state");
    await withInstallerStateLock("example/control", root, async () => undefined);
    const targets = await readdir(root);
    const target = targets[0];
    if (!target) throw new Error("installer target directory is missing");
    const lockPath = resolve(root, target, ".operation.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schema_version: "harbor-hf.installer-lock.v1",
        pid: 2_147_483_647,
        owner_nonce: "a".repeat(32),
        boot_id: null,
        process_start: null,
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      withInstallerStateLock("example/control", root, async () => "recovered"),
    ).resolves.toBe("recovered");
    expect((await lstat(lockPath)).mode & 0o777).toBe(0o600);
  });

  it("ignores stale lock contents left by a prior host boot", async () => {
    const directory = await temporaryDirectory();
    const root = resolve(directory, "state");
    await withInstallerStateLock("example/control", root, async () => undefined);
    const targets = await readdir(root);
    const target = targets[0];
    if (!target) throw new Error("installer target directory is missing");
    const lockPath = resolve(root, target, ".operation.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schema_version: "harbor-hf.installer-lock.v1",
        pid: process.pid,
        owner_nonce: "b".repeat(32),
        boot_id: "00000000-0000-0000-0000-000000000000",
        process_start: null,
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      withInstallerStateLock("example/control", root, async () => "recovered"),
    ).resolves.toBe("recovered");
  });

  it("refuses an insecure operation lock file", async () => {
    const directory = await temporaryDirectory();
    const root = resolve(directory, "state");
    await withInstallerStateLock("example/control", root, async () => undefined);
    const targets = await readdir(root);
    const target = targets[0];
    if (!target) throw new Error("installer target directory is missing");
    const lockPath = resolve(root, target, ".operation.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schema_version: "harbor-hf.installer-lock.v1",
        pid: process.pid,
        owner_nonce: "c".repeat(32),
        boot_id: "-".repeat(36),
        process_start: null,
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(lockPath, 0o644);

    await expect(
      withInstallerStateLock("example/control", root, async () => undefined),
    ).rejects.toThrow("operation lock must be owner-only");
  });

  it("serializes simultaneous reclaimers of one stale lock", async () => {
    const directory = await temporaryDirectory();
    const root = resolve(directory, "state");
    await withInstallerStateLock("example/control", root, async () => undefined);
    const targets = await readdir(root);
    const target = targets[0];
    if (!target) throw new Error("installer target directory is missing");
    const lockPath = resolve(root, target, ".operation.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schema_version: "harbor-hf.installer-lock.v1",
        pid: 2_147_483_647,
        owner_nonce: "d".repeat(32),
        boot_id: null,
        process_start: null,
      })}\n`,
      { mode: 0o600 },
    );
    let active = 0;
    let maximumActive = 0;
    const outcomes = await Promise.allSettled(
      Array.from(
        { length: 32 },
        async () =>
          await withInstallerStateLock("example/control", root, async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
            active -= 1;
          }),
      ),
    );

    expect(maximumActive).toBe(1);
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
    const rejectionMessages = outcomes
      .filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      )
      .map((outcome) =>
        outcome.reason instanceof Error ? outcome.reason.message : "non-error",
      );
    expect(new Set(rejectionMessages)).toEqual(
      new Set(["another installer operation is active"]),
    );
  });

  it("refuses to activate a prepared state object under another target", async () => {
    const directory = await temporaryDirectory();
    const prepared = await prepareInstallState(
      "example/control",
      resolve(directory, "state"),
    );
    await mkdir(prepared.bundleDirectory);
    await writePrivatePlan(
      prepared.planPath,
      plan(resolve(directory, "repository"), prepared.bundleDirectory),
    );
    await expect(
      activateInstallState(
        {
          ...prepared,
          targetDirectory: resolve(directory, "different-target"),
        },
        "example/control",
      ),
    ).rejects.toThrow("does not match");
  });

  it("stores an idempotent owner-only bootstrap receipt beside the plan", async () => {
    const { prepared } = await savedState();
    const receipt = {
      schema_version: "harbor-hf.install-bootstrap-receipt.v1" as const,
      install_id: "f".repeat(64),
      plan_digest: `sha256:${"d".repeat(64)}`,
      space_id: "example/control",
      bucket_id: "example/control-artifacts",
      source_revision: "a".repeat(40),
      manifest_digest: `sha256:${"b".repeat(64)}`,
    };
    await writeBootstrapReceipt(prepared.planPath, receipt);
    await writeBootstrapReceipt(prepared.planPath, receipt);
    await expect(readBootstrapReceipt(prepared.planPath)).resolves.toEqual(receipt);
    const path = resolve(prepared.generationDirectory, "bootstrap-receipt.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o644);
    await expect(readBootstrapReceipt(prepared.planPath)).rejects.toThrow("owner-only");
  });

  it("atomically accepts concurrent writes of the same bootstrap receipt", async () => {
    const { prepared } = await savedState();
    const receipt = {
      schema_version: "harbor-hf.install-bootstrap-receipt.v1" as const,
      install_id: "f".repeat(64),
      plan_digest: `sha256:${"d".repeat(64)}`,
      space_id: "example/control",
      bucket_id: "example/control-artifacts",
      source_revision: "a".repeat(40),
      manifest_digest: `sha256:${"b".repeat(64)}`,
    };
    await expect(
      Promise.all([
        writeBootstrapReceipt(prepared.planPath, receipt),
        writeBootstrapReceipt(prepared.planPath, receipt),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(readBootstrapReceipt(prepared.planPath)).resolves.toEqual(receipt);
  });

  it("carries exact Bucket proof into a replacement plan generation", async () => {
    const { directory, root, prepared } = await savedState();
    const previous = await readPrivatePlan(prepared.planPath);
    await writeBootstrapReceipt(prepared.planPath, {
      schema_version: "harbor-hf.install-bootstrap-receipt.v1",
      install_id: previous.plan.install_id,
      plan_digest: previous.digest,
      space_id: previous.plan.targets.space_id,
      bucket_id: previous.plan.targets.bucket_id,
      source_revision: previous.plan.source.revision,
      manifest_digest: previous.plan.bundle.manifest_digest,
    });

    const next = await prepareInstallState("example/control", root);
    await mkdir(next.bundleDirectory);
    const nextWritten = await writePrivatePlan(
      next.planPath,
      plan(resolve(directory, "repository"), next.bundleDirectory),
    );
    await expect(
      carryBootstrapReceipt(
        prepared.planPath,
        next.planPath,
        (await readPrivatePlan(next.planPath)).plan,
        nextWritten.digest,
      ),
    ).resolves.toBe(true);
    await expect(readBootstrapReceipt(next.planPath)).resolves.toMatchObject({
      plan_digest: nextWritten.digest,
      install_id: previous.plan.install_id,
    });
  });

  it("does not discard Bucket proof when the remote Bucket disappears", async () => {
    const { directory, root, prepared } = await savedState();
    const previous = await readPrivatePlan(prepared.planPath);
    await writeBootstrapReceipt(prepared.planPath, {
      schema_version: "harbor-hf.install-bootstrap-receipt.v1",
      install_id: previous.plan.install_id,
      plan_digest: previous.digest,
      space_id: previous.plan.targets.space_id,
      bucket_id: previous.plan.targets.bucket_id,
      source_revision: previous.plan.source.revision,
      manifest_digest: previous.plan.bundle.manifest_digest,
    });
    const next = await prepareInstallState("example/control", root);
    await mkdir(next.bundleDirectory);
    const nextWritten = await writePrivatePlan(
      next.planPath,
      plan(resolve(directory, "repository"), next.bundleDirectory),
    );

    await expect(
      preserveBootstrapReceipt(
        prepared.planPath,
        next.planPath,
        (await readPrivatePlan(next.planPath)).plan,
        nextWritten.digest,
        {
          spacePresent: true,
          bucketPresent: false,
          phase: "credentials_required",
        },
      ),
    ).rejects.toThrow("proven resource is missing");
    await expect(readBootstrapReceipt(next.planPath)).resolves.toBeUndefined();
  });

  it("establishes proof in every exact installed plan generation", async () => {
    const { directory, root, prepared } = await savedState();
    const next = await prepareInstallState("example/control", root);
    await mkdir(next.bundleDirectory);
    const nextPlan = plan(resolve(directory, "repository"), next.bundleDirectory);
    nextPlan.expected_variables.HARBOR_HF_PUBLIC_ORIGIN =
      "https://example-control.hf.space";
    nextPlan.observed_preconditions = {
      namespaceListingsComplete: true,
      space: {
        id: "example/control",
        private: true,
        sdk: "docker",
        origin: "https://example-control.hf.space",
        sha: "a".repeat(40),
        runtimeStage: "RUNNING",
        hardware: "cpu-basic",
        requestedHardware: "cpu-basic",
        variables: Object.fromEntries(
          Object.entries(nextPlan.expected_variables).filter(
            (entry): entry is [string, string] => entry[1] !== null,
          ),
        ),
        secretNames: ["HF_INFERENCE_TOKEN", "HF_TOKEN"],
      },
      bucket: {
        id: "example/control-artifacts",
        private: true,
      },
    };
    const nextWritten = await writePrivatePlan(next.planPath, nextPlan);

    await preserveBootstrapReceipt(
      prepared.planPath,
      next.planPath,
      (await readPrivatePlan(next.planPath)).plan,
      nextWritten.digest,
      {
        spacePresent: true,
        bucketPresent: true,
        phase: "installed",
      },
    );
    await expect(readBootstrapReceipt(next.planPath)).resolves.toMatchObject({
      plan_digest: nextWritten.digest,
      install_id: nextPlan.install_id,
      source_revision: nextPlan.source.revision,
      manifest_digest: nextPlan.bundle.manifest_digest,
    });
  });
});

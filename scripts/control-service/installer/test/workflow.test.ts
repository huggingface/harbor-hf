import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BucketWriteProbeAdapter,
  BucketWriteProbeInput,
} from "../bucket-write-probe.js";
import type { InstallerClock } from "../clock.js";
import type {
  ControlTokenScopeAdapter,
  ControlTokenScopeInput,
} from "../control-token-scope.js";
import { type HfAdapter, HfCommandFailure } from "../hf.js";
import type { HttpAdapter } from "../http.js";
import type { IdentityAdapter } from "../identity.js";
import type {
  InferenceTokenScopeAdapter,
  InferenceTokenScopeInput,
} from "../inference-token-scope.js";
import {
  expectedVariables,
  type Principal,
  type RemoteState,
  type SpaceState,
} from "../model.js";
import type { SourceAdapter } from "../source.js";
import type { BootstrapReceipt } from "../state.js";
import {
  activateInstall,
  applyInstall,
  configureInstall,
  disableInstall,
  type InstallerDependencies,
  planInstall,
  provisionInstall,
  verifyInstall,
} from "../workflow.js";

const REVISION = "a".repeat(40);
const OLD_REVISION = "c".repeat(40);
const UPLOAD_SHA = "b".repeat(40);
const PARENT_IMAGE = `ghcr.io/example/parent@sha256:${"d".repeat(64)}`;
const ORIGIN = "https://placeholder-control.hf.space";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "installer-workflow-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function parseEnvironmentFile(content: string): Record<string, string> {
  return Object.fromEntries(
    content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

class FakeSource implements SourceAdapter {
  constructor(
    readonly repositoryRoot: string,
    readonly revision = REVISION,
  ) {}

  async inspect() {
    return { repositoryRoot: this.repositoryRoot, revision: this.revision };
  }

  async bundle(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
    await mkdir(resolve(directory, "nested"), { recursive: true });
    await writeFile(resolve(directory, "Dockerfile"), "FROM scratch\n");
    await writeFile(resolve(directory, "nested", "release.txt"), this.revision);
  }
}

class FakeIdentity implements IdentityAdapter {
  readonly principal: Principal = {
    subject: "stable-subject",
    username: "example-user",
    organizations: ["example-org"],
  };

  async resolve(): Promise<Principal> {
    return structuredClone(this.principal);
  }
}

class FakeHttp implements HttpAdapter {
  readonly requests: { path: string; bearer?: string }[] = [];
  readonly readyResponses: Array<{ status: number; body: unknown }> = [];
  readyStatus = "ready";
  systemIntegrityError: string | null = null;
  readyRequestCount = 0;
  failReadyOnRequest: number | null = null;
  readyResponseGate: Promise<void> | undefined;
  runItems: unknown[] = [];

  constructor(
    private readonly currentWriteMode: () => "disabled" | "enabled" | "enabled" = () =>
      "disabled",
  ) {}

  async getJson(
    url: URL,
    options: { bearer?: string; timeoutMs: number; maxBytes: number },
  ) {
    this.requests.push({
      path: url.pathname,
      ...(options.bearer ? { bearer: options.bearer } : {}),
    });
    if (url.pathname === "/health/live") {
      return { status: 200, body: { status: "live" } };
    }
    if (url.pathname === "/health/ready") {
      this.readyRequestCount += 1;
      await this.readyResponseGate;
      const queued = this.readyResponses.shift();
      if (queued) return queued;
      const ready =
        this.readyStatus === "ready" &&
        this.readyRequestCount !== this.failReadyOnRequest;
      return {
        status: ready ? 200 : 503,
        body: { status: ready ? "ready" : "initializing" },
      };
    }
    if (url.pathname === "/api/v1/system") {
      return {
        status: 200,
        body: {
          source_revision: REVISION,
          write_mode: this.currentWriteMode(),
          ready: this.systemIntegrityError === null,
          projection: { runs: this.runItems.length, trials: 0, parent_jobs: 0 },
          resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
        },
      };
    }
    if (url.pathname === "/api/v1/runs") {
      return {
        status: 200,
        body: { runs: this.runItems },
      };
    }
    return { status: 404, body: { status: "missing" } };
  }
}

class FakeHf implements HfAdapter {
  state: RemoteState = {
    namespaceListingsComplete: true,
    space: null,
    bucket: null,
  };
  readonly calls: string[] = [];
  readonly temporaryPaths: string[] = [];
  readonly uploadedBundleDirectories: string[] = [];
  readonly secretWriteNames: string[][] = [];
  failCreateBucket = false;
  createBucketFailureCategory: "forbidden" | null = null;
  failCreateBucketResponse = false;
  failCreateSpaceResponse = false;
  failCreateWithUnmarkedRace = false;
  failSetSecretsResponse = false;
  failSetSecretsPartially = false;
  failSetVariablesPartially = false;
  failSetVariablesAfterUpload = false;
  failUpload = false;
  mutateBindingOnUploadFailure = false;
  preserveNoAppFileOnVariables = false;
  failObserve = false;
  versionValue = "1.23.0";
  waitGate: Promise<void> | undefined;
  waitFailure: Error | undefined;

  async version(): Promise<string> {
    return this.versionValue;
  }

  async whoamiUsername(): Promise<string> {
    throw new Error("not used");
  }

  async authToken(): Promise<string> {
    throw new Error("not used");
  }

  async observe(
    _namespace: string,
    _spaceId: string,
    _bucketId: string,
  ): Promise<RemoteState> {
    if (this.failObserve) throw new Error("listing failed");
    this.calls.push("observe");
    return structuredClone(this.state);
  }

  async createSpace(
    spaceId: string,
    variablesFile: string,
    secretsFile?: string,
  ): Promise<void> {
    this.calls.push("createSpace");
    this.temporaryPaths.push(variablesFile, ...(secretsFile ? [secretsFile] : []));
    expect((await stat(variablesFile)).mode & 0o777).toBe(0o600);
    const variables = parseEnvironmentFile(await readFile(variablesFile, "utf8"));
    const secrets = secretsFile
      ? parseEnvironmentFile(await readFile(secretsFile, "utf8"))
      : {};
    if (secretsFile) {
      expect((await stat(secretsFile)).mode & 0o777).toBe(0o600);
      expect(Object.keys(secrets).sort()).toEqual(["HF_INFERENCE_TOKEN", "HF_TOKEN"]);
    }
    if (this.failCreateWithUnmarkedRace) {
      this.state.space = {
        id: spaceId,
        private: true,
        sdk: "docker",
        origin: ORIGIN,
        sha: UPLOAD_SHA,
        runtimeStage: "RUNNING",
        hardware: "cpu-basic",
        requestedHardware: "cpu-basic",
        variables: {},
        secretNames: [],
      };
      throw new Error("target appeared concurrently");
    }
    this.state.space = {
      id: spaceId,
      private: true,
      sdk: "docker",
      origin: ORIGIN,
      sha: null,
      runtimeStage: "BUILDING",
      hardware: null,
      requestedHardware: "cpu-basic",
      variables,
      secretNames: Object.keys(secrets).sort(),
    };
    if (this.failCreateSpaceResponse) throw new Error("lost create response");
  }

  async createBucket(bucketId: string, _authenticatedUsername: string): Promise<void> {
    this.calls.push("createBucket");
    if (this.createBucketFailureCategory) {
      throw new HfCommandFailure(this.createBucketFailureCategory);
    }
    if (this.failCreateBucket) throw new Error("provider detail");
    this.state.bucket = { id: bucketId, private: true };
    if (this.failCreateBucketResponse) {
      throw new Error("lost Bucket create response");
    }
  }

  async setVariables(_spaceId: string, variablesFile: string): Promise<void> {
    this.calls.push("setVariables");
    this.temporaryPaths.push(variablesFile);
    if (!this.state.space) throw new Error("missing Space");
    if (this.failSetVariablesAfterUpload && this.calls.includes("uploadMirror")) {
      throw new Error("provider detail");
    }
    const variables = parseEnvironmentFile(await readFile(variablesFile, "utf8"));
    if (this.failSetVariablesPartially && this.calls.includes("uploadMirror")) {
      this.state.space.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST =
        variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST as string;
      this.state.space.runtimeStage = "BUILDING";
      throw new Error("partial variable write");
    }
    this.state.space.variables = variables;
    if (
      !this.preserveNoAppFileOnVariables ||
      this.state.space.runtimeStage !== "NO_APP_FILE"
    ) {
      this.state.space.runtimeStage = "BUILDING";
    }
  }

  async setSecrets(_spaceId: string, secretsFile: string): Promise<void> {
    this.calls.push("setSecrets");
    this.temporaryPaths.push(secretsFile);
    if (!this.state.space) throw new Error("missing Space");
    const values = parseEnvironmentFile(await readFile(secretsFile, "utf8"));
    this.secretWriteNames.push(Object.keys(values).sort());
    if (this.failSetSecretsPartially) {
      this.state.space.secretNames = [
        ...new Set([
          ...this.state.space.secretNames,
          Object.keys(values).sort()[0] as string,
        ]),
      ].sort();
      this.state.space.runtimeStage = "BUILDING";
      throw new Error("partial secret write");
    }
    this.state.space.secretNames = [
      ...new Set([...this.state.space.secretNames, ...Object.keys(values)]),
    ].sort();
    this.state.space.runtimeStage = "BUILDING";
    if (this.failSetSecretsResponse) throw new Error("lost secret write response");
  }

  async setProtected(): Promise<void> {
    this.calls.push("setProtected");
    if (!this.state.space) throw new Error("missing Space");
    this.state.space.private = true;
  }

  async uploadMirror(
    _spaceId: string,
    _bundleDirectory: string,
    _revision: string,
  ): Promise<string> {
    this.calls.push("uploadMirror");
    this.uploadedBundleDirectories.push(_bundleDirectory);
    if (this.failUpload) {
      if (this.mutateBindingOnUploadFailure && this.state.space) {
        this.state.space.variables.HARBOR_HF_SOURCE_REVISION = "d".repeat(40);
        this.state.space.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST = `sha256:${"d".repeat(64)}`;
      }
      throw new Error("upload failed");
    }
    if (!this.state.space) throw new Error("missing Space");
    this.state.space.sha = UPLOAD_SHA;
    this.state.space.runtimeStage = "BUILDING";
    return UPLOAD_SHA;
  }

  async wait(): Promise<void> {
    this.calls.push("wait");
    await this.waitGate;
    if (this.waitFailure) throw this.waitFailure;
    if (!this.state.space) throw new Error("missing Space");
    this.state.space.runtimeStage = "RUNNING";
    this.state.space.hardware = "cpu-basic";
  }

  async pause(): Promise<void> {
    this.calls.push("pause");
    if (this.state.space) this.state.space.runtimeStage = "PAUSED";
  }

  async restart(): Promise<void> {
    this.calls.push("restart");
    if (!this.state.space) throw new Error("missing Space");
    this.state.space.runtimeStage = "BUILDING";
  }
}

interface PendingClockWait {
  deadline: number;
  finish(): void;
}

class FakeClock implements InstallerClock {
  private currentMilliseconds = 0;
  private readonly waits = new Set<PendingClockWait>();

  monotonicMilliseconds(): number {
    return this.currentMilliseconds;
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolvePromise) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", finish);
        this.waits.delete(wait);
        resolvePromise();
      };
      const wait: PendingClockWait = {
        deadline: this.currentMilliseconds + milliseconds,
        finish,
      };
      this.waits.add(wait);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  advanceBy(milliseconds: number): void {
    this.currentMilliseconds += milliseconds;
    for (const wait of [...this.waits]) {
      if (wait.deadline <= this.currentMilliseconds) wait.finish();
    }
  }

  get pendingWaitCount(): number {
    return this.waits.size;
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

async function waitForTest(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 1);
    });
  }
  throw new Error("test condition did not settle");
}

class FakeBucketWriteProbe implements BucketWriteProbeAdapter {
  fail = false;
  calls: Array<{ bucketId: string; path: string; bytes: Uint8Array }> = [];

  async createAndVerify(input: BucketWriteProbeInput): Promise<void> {
    this.calls.push({
      bucketId: input.bucketId,
      path: input.path,
      bytes: Uint8Array.from(input.bytes),
    });
    if (this.fail) throw new Error("write forbidden");
  }
}

class FakeControlTokenScope implements ControlTokenScopeAdapter {
  fail = false;
  warnings: string[] = [];
  calls: ControlTokenScopeInput[] = [];

  async attest(input: ControlTokenScopeInput): Promise<{ warnings: string[] }> {
    this.calls.push({ ...input });
    if (this.fail) throw new Error("forbidden scope");
    return { warnings: [...this.warnings] };
  }
}

class FakeInferenceTokenScope implements InferenceTokenScopeAdapter {
  fail = false;
  calls: InferenceTokenScopeInput[] = [];

  async attest(input: InferenceTokenScopeInput): Promise<void> {
    this.calls.push({ ...input });
    if (this.fail) throw new Error("forbidden inference scope");
  }
}

async function setup(existingRevision?: string) {
  const directory = await temporaryDirectory();
  const repository = resolve(directory, "repository");
  const bundle = resolve(directory, "private", "bundle");
  const planPath = resolve(directory, "private", "plan.json");
  const hf = new FakeHf();
  const source = new FakeSource(repository);
  const identity = new FakeIdentity();
  const bucketWriteProbe = new FakeBucketWriteProbe();
  const controlTokenScope = new FakeControlTokenScope();
  const inferenceTokenScope = new FakeInferenceTokenScope();
  const clock = new FakeClock();
  const http = new FakeHttp(() => {
    const writeMode = hf.state.space?.variables.HARBOR_HF_WRITE_MODE;
    return writeMode === "enabled" || writeMode === "enabled" ? writeMode : "disabled";
  });
  if (existingRevision) {
    hf.state = installedState(existingRevision, identity.principal);
  }
  const dependencies: InstallerDependencies = {
    hf,
    source,
    identity,
    http,
    clock,
    bucketWriteProbe,
    controlTokenScope,
    inferenceTokenScope,
    environment: {
      HARBOR_HF_INSTALL_CONTROL_SECRET: "control-placeholder",
      HARBOR_HF_INSTALL_INFERENCE_SECRET: "inference-placeholder",
      HARBOR_HF_PARENT_IMAGE: PARENT_IMAGE,
    },
  };
  const planned = await planInstall(
    {
      space: "example/control",
      bundleDirectory: bundle,
      planPath,
    },
    dependencies,
  );
  return {
    directory,
    bundle,
    planPath,
    hf,
    source,
    identity,
    http,
    bucketWriteProbe,
    controlTokenScope,
    inferenceTokenScope,
    clock,
    dependencies,
    planned,
  };
}

function alignInstalledStateWithPlan(
  setupResult: Awaited<ReturnType<typeof setup>>,
): void {
  if (!setupResult.hf.state.space) throw new Error("test Space is missing");
  setupResult.hf.state.space.variables = Object.fromEntries(
    Object.entries(setupResult.planned.plan.expected_variables).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
}

function installedState(revision: string, principal: Principal): RemoteState {
  const installId = "f".repeat(64);
  const bundleDigest = `sha256:${"c".repeat(64)}`;
  const variables = expectedVariables(
    "example",
    "example/control-artifacts",
    ORIGIN,
    principal.subject,
    revision,
    {
      installId,
      manifestDigest: bundleDigest,
      phase: "installed",
    },
  ) as Record<string, string>;
  return {
    namespaceListingsComplete: true,
    space: {
      id: "example/control",
      private: true,
      sdk: "docker",
      origin: ORIGIN,
      sha: UPLOAD_SHA,
      runtimeStage: "RUNNING",
      hardware: "cpu-basic",
      requestedHardware: "cpu-basic",
      variables,
      secretNames: ["HF_INFERENCE_TOKEN", "HF_TOKEN"],
    },
    bucket: { id: "example/control-artifacts", private: true },
  };
}

function legacyInstalledState(revision: string, principal: Principal): RemoteState {
  return {
    namespaceListingsComplete: true,
    space: {
      id: "example/control",
      private: true,
      sdk: "docker",
      origin: ORIGIN,
      sha: UPLOAD_SHA,
      runtimeStage: "RUNNING",
      hardware: "cpu-basic",
      requestedHardware: "cpu-basic",
      variables: {
        HARBOR_HF_AUTH_MODE: "oauth",
        HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS: principal.subject,
        HARBOR_HF_BUCKET_ID: "example/control-artifacts",
        HARBOR_HF_INSTALLER_MARKER: "harbor-hf.install-plan.v1",
        HARBOR_HF_INSTALLER_VERSION: "1",
        HARBOR_HF_NAMESPACE: "example",
        HARBOR_HF_PUBLIC_ORIGIN: ORIGIN,
        HARBOR_HF_SOURCE_REVISION: revision,
        HARBOR_HF_STORE_MODE: "bucket",
        HARBOR_HF_WRITE_MODE: "disabled",
      },
      secretNames: ["HF_INFERENCE_TOKEN", "HF_TOKEN"],
    },
    bucket: { id: "example/control-artifacts", private: true },
  };
}

async function bootstrap(setupResult: Awaited<ReturnType<typeof setup>>) {
  const result = await provisionInstall(
    { planPath: setupResult.planPath },
    setupResult.dependencies,
  );
  if (result.status !== "credentials_required") {
    throw new Error("expected credentials-required bootstrap result");
  }
  return result;
}

async function complete(
  setupResult: Awaited<ReturnType<typeof setup>>,
  receipt: Awaited<ReturnType<typeof bootstrap>>["receipt"],
) {
  return await configureInstall(
    {
      planPath: setupResult.planPath,
      bootstrapReceipt: receipt,
      persistBootstrapReceipt: async (persisted) => {
        Object.assign(receipt, persisted);
      },
    },
    setupResult.dependencies,
  );
}

describe("installer workflows", () => {
  it("gives every fresh plan an unpredictable installation identity", async () => {
    const first = await setup();
    const second = await setup();
    expect(first.planned.plan.install_id).toMatch(/^[a-f0-9]{64}$/);
    expect(second.planned.plan.install_id).toMatch(/^[a-f0-9]{64}$/);
    expect(first.planned.plan.install_id).not.toBe(second.planned.plan.install_id);
  });

  it("keeps provisioning and credential configuration as explicit boundaries", async () => {
    const setupResult = await setup();
    await expect(
      configureInstall({ planPath: setupResult.planPath }, setupResult.dependencies),
    ).rejects.toThrow("run install:provision");
    expect(setupResult.hf.calls).not.toContain("createSpace");
    expect(setupResult.hf.calls).not.toContain("createBucket");

    const provisioned = await bootstrap(setupResult);
    setupResult.hf.calls.length = 0;
    await expect(
      provisionInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: provisioned.receipt,
        },
        setupResult.dependencies,
      ),
    ).resolves.toMatchObject({ status: "credentials_required" });
    expect(setupResult.hf.calls).not.toContain("uploadMirror");
    expect(setupResult.hf.calls).not.toContain("setSecrets");
  });

  it("reports runtime heartbeats and polls exact initializing readiness", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    const waitGate = deferred();
    const progress: string[] = [];
    setupResult.hf.waitGate = waitGate.promise;
    setupResult.http.readyResponses.push(
      { status: 503, body: { status: "initializing" } },
      { status: 503, body: { status: "initializing" } },
    );
    setupResult.dependencies.configureStartupPolicy = {
      runtimeHeartbeatMilliseconds: 30,
      readinessPollMilliseconds: 15,
      readinessHeartbeatMilliseconds: 15,
      readinessTimeoutMilliseconds: 100,
      readinessRequestTimeoutMilliseconds: 10,
    };
    setupResult.dependencies.reportConfigureProgress = (event) => {
      progress.push(
        "elapsedMilliseconds" in event
          ? `${event.kind}:${event.elapsedMilliseconds}`
          : event.kind,
      );
    };

    const completion = complete(setupResult, bootstrapResult.receipt);
    let completionError: unknown;
    void completion.catch((error: unknown) => {
      completionError = error;
    });
    await waitForTest(
      () => setupResult.hf.calls.includes("wait") || completionError !== undefined,
    );
    if (completionError) throw completionError;
    expect(progress).toEqual(["runtime_wait_started"]);
    expect(setupResult.clock.pendingWaitCount).toBe(1);

    setupResult.clock.advanceBy(30);
    await waitForTest(() => progress.includes("runtime_waiting:30"));
    waitGate.resolve();
    await waitForTest(
      () =>
        setupResult.http.readyRequestCount === 1 &&
        setupResult.clock.pendingWaitCount === 1,
    );

    setupResult.clock.advanceBy(15);
    await waitForTest(
      () =>
        setupResult.http.readyRequestCount === 2 &&
        setupResult.clock.pendingWaitCount === 1,
    );
    setupResult.clock.advanceBy(15);

    await expect(completion).resolves.toMatchObject({ status: "installed" });
    expect(progress).toEqual([
      "runtime_wait_started",
      "runtime_waiting:30",
      "runtime_wait_complete:30",
      "readiness_wait_started",
      "readiness_initializing:15",
      "readiness_ready:30",
    ]);
    expect(setupResult.http.readyRequestCount).toBe(3);
    expect(setupResult.clock.pendingWaitCount).toBe(0);
  });

  it("cancels runtime heartbeats when the provider wait fails", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    const waitGate = deferred();
    const progress: string[] = [];
    setupResult.hf.waitGate = waitGate.promise;
    setupResult.hf.waitFailure = new Error("provider wait failed");
    setupResult.dependencies.configureStartupPolicy = {
      runtimeHeartbeatMilliseconds: 30,
      readinessPollMilliseconds: 15,
      readinessHeartbeatMilliseconds: 15,
      readinessTimeoutMilliseconds: 100,
      readinessRequestTimeoutMilliseconds: 10,
    };
    setupResult.dependencies.reportConfigureProgress = (event) => {
      progress.push(event.kind);
    };

    const completion = complete(setupResult, bootstrapResult.receipt);
    void completion.catch(() => undefined);
    await waitForTest(() => setupResult.hf.calls.includes("wait"));
    expect(setupResult.clock.pendingWaitCount).toBe(1);
    setupResult.clock.advanceBy(30);
    await waitForTest(() => progress.includes("runtime_waiting"));
    waitGate.resolve();

    await expect(completion).rejects.toThrow(
      "installation failed after remote mutation began",
    );
    expect(progress).not.toContain("runtime_wait_complete");
    expect(setupResult.clock.pendingWaitCount).toBe(0);
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
  });

  it("times out initializing readiness and restores a safe paused bootstrap", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    const progress: string[] = [];
    setupResult.http.readyStatus = "initializing";
    setupResult.dependencies.configureStartupPolicy = {
      runtimeHeartbeatMilliseconds: 30,
      readinessPollMilliseconds: 10,
      readinessHeartbeatMilliseconds: 10,
      readinessTimeoutMilliseconds: 25,
      readinessRequestTimeoutMilliseconds: 10,
    };
    setupResult.dependencies.reportConfigureProgress = (event) => {
      progress.push(event.kind);
    };

    const completion = complete(setupResult, bootstrapResult.receipt);
    let completionError: unknown;
    void completion.catch((error: unknown) => {
      completionError = error;
    });
    await waitForTest(
      () =>
        (setupResult.http.readyRequestCount === 1 &&
          setupResult.clock.pendingWaitCount === 1) ||
        completionError !== undefined,
    );
    if (completionError) throw completionError;
    setupResult.clock.advanceBy(10);
    await waitForTest(() => setupResult.http.readyRequestCount === 2);
    setupResult.clock.advanceBy(10);
    await waitForTest(() => setupResult.http.readyRequestCount === 3);
    setupResult.clock.advanceBy(5);

    await expect(completion).rejects.toThrow(
      "verification category: readiness-timeout",
    );
    expect(progress.filter((kind) => kind === "readiness_timed_out")).toHaveLength(1);
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_INSTALL_PHASE).toBe(
      "source_staged",
    );
    expect(setupResult.clock.pendingWaitCount).toBe(0);
  });

  it("does not accept an exact ready response that completes at the deadline", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    const responseGate = deferred();
    const progress: string[] = [];
    setupResult.http.readyResponseGate = responseGate.promise;
    setupResult.http.readyResponses.push({
      status: 200,
      body: { status: "ready" },
    });
    setupResult.dependencies.configureStartupPolicy = {
      runtimeHeartbeatMilliseconds: 30,
      readinessPollMilliseconds: 10,
      readinessHeartbeatMilliseconds: 10,
      readinessTimeoutMilliseconds: 25,
      readinessRequestTimeoutMilliseconds: 25,
    };
    setupResult.dependencies.reportConfigureProgress = (event) => {
      progress.push(event.kind);
    };

    const completion = complete(setupResult, bootstrapResult.receipt);
    void completion.catch(() => undefined);
    await waitForTest(() => setupResult.http.readyRequestCount === 1);
    setupResult.clock.advanceBy(25);
    responseGate.resolve();

    await expect(completion).rejects.toThrow(
      "verification category: readiness-timeout",
    );
    expect(progress.filter((kind) => kind === "readiness_timed_out")).toHaveLength(1);
    expect(progress).not.toContain("readiness_ready");
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
  });

  it.each([
    ["extra initializing field", 503, { status: "initializing", detail: "unexpected" }],
    ["ready body on 503", 503, { status: "ready" }],
    ["initializing body on 200", 200, { status: "initializing" }],
    ["extra ready field", 200, { status: "ready", detail: "unexpected" }],
    ["initializing body on 500", 500, { status: "initializing" }],
    ["non-object body", 503, "initializing"],
  ])(
    "does not retry an inexact readiness response: %s",
    async (_name, status, body) => {
      const setupResult = await setup();
      const bootstrapResult = await bootstrap(setupResult);
      setupResult.http.readyResponses.push({
        status,
        body,
      });
      setupResult.dependencies.configureStartupPolicy = {
        runtimeHeartbeatMilliseconds: 30,
        readinessPollMilliseconds: 10,
        readinessHeartbeatMilliseconds: 10,
        readinessTimeoutMilliseconds: 25,
        readinessRequestTimeoutMilliseconds: 10,
      };

      await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
        "installation failed after remote mutation began",
      );
      expect(setupResult.http.readyRequestCount).toBe(1);
      expect(setupResult.clock.pendingWaitCount).toBe(0);
      expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
      expect(setupResult.hf.state.space?.variables.HARBOR_HF_INSTALL_PHASE).toBe(
        "source_staged",
      );
    },
  );

  it("ignores synchronous and asynchronous progress reporter failures", async () => {
    const synchronous = await setup();
    const synchronousBootstrap = await bootstrap(synchronous);
    synchronous.dependencies.reportConfigureProgress = () => {
      throw new Error("progress output failed");
    };
    await expect(
      complete(synchronous, synchronousBootstrap.receipt),
    ).resolves.toMatchObject({ status: "installed" });

    const asynchronous = await setup();
    const asynchronousBootstrap = await bootstrap(asynchronous);
    asynchronous.dependencies.reportConfigureProgress = async () => {
      throw new Error("async progress output failed");
    };
    await expect(
      complete(asynchronous, asynchronousBootstrap.receipt),
    ).resolves.toMatchObject({ status: "installed" });
    await Promise.resolve();
  });

  it("plans and applies a fresh protected disabled-write installation", async () => {
    const setupResult = await setup();
    setupResult.dependencies.secretInput = {
      async read() {
        throw new Error("bootstrap must not prompt");
      },
    };
    const bootstrapResult = await bootstrap(setupResult);
    expect(bootstrapResult).toMatchObject({
      status: "credentials_required",
      production_ready: false,
      space_paused: true,
      secrets_configured: false,
      source_uploaded: false,
    });
    expect(setupResult.hf.calls).toContain("createSpace");
    expect(setupResult.hf.calls).toContain("createBucket");
    expect(setupResult.hf.calls).not.toContain("uploadMirror");
    expect(setupResult.hf.calls).not.toContain("setSecrets");
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
    expect(setupResult.hf.state.space?.secretNames).toEqual([]);
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_INSTALL_PHASE).toBe(
      "credentials_required",
    );

    delete setupResult.dependencies.secretInput;
    const result = await complete(setupResult, bootstrapResult.receipt);
    expect(result).toEqual({
      status: "installed",
      control_credential_warnings: [],
      control_credential_warnings_reported: false,
      verification: {
        production_ready: false,
        space_url: ORIGIN,
        anonymous_live: "passed",
        anonymous_ready: "passed",
        authenticated_system: "skipped",
        source_upload_revision: "passed",
      },
    });
    expect(setupResult.hf.calls).toContain("uploadMirror");
    expect(bootstrapResult.receipt.uploaded_sha).toBe(UPLOAD_SHA);
    expect(setupResult.hf.calls.indexOf("uploadMirror")).toBeLessThan(
      setupResult.hf.calls.indexOf("setSecrets"),
    );
    expect(setupResult.hf.uploadedBundleDirectories[0]).not.toBe(setupResult.bundle);
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_WRITE_MODE).toBe("disabled");
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_PUBLIC_ORIGIN).toBe(ORIGIN);
    const planBytes = await readFile(setupResult.planPath, "utf8");
    expect(planBytes).not.toContain("control-placeholder");
    expect(planBytes).not.toContain("inference-placeholder");
    for (const path of setupResult.hf.temporaryPaths) {
      await expect(access(path)).rejects.toThrow();
    }
  });

  it("activates only a healthy authenticated installed Space into enabled mode", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    await complete(setupResult, bootstrapResult.receipt);
    setupResult.hf.calls.length = 0;
    setupResult.http.requests.length = 0;
    setupResult.http.readyRequestCount = 0;
    const progress: string[] = [];
    setupResult.dependencies.reportConfigureProgress = (event) => {
      progress.push(event.kind);
    };
    setupResult.dependencies.environment = {
      ...setupResult.dependencies.environment,
      HARBOR_HF_CONTROL_BEARER_TOKEN: "operator-bearer-placeholder",
    };

    await expect(
      activateInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: bootstrapResult.receipt,
        },
        setupResult.dependencies,
      ),
    ).resolves.toEqual({
      production_ready: false,
      space_url: ORIGIN,
      write_mode: "enabled",
      runtime: "running",
      authenticated_system: "passed",
    });
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_WRITE_MODE).toBe("enabled");
    expect(setupResult.hf.calls).toContain("restart");
    expect(setupResult.hf.calls).toContain("wait");
    expect(setupResult.hf.calls).not.toContain("setSecrets");
    expect(
      setupResult.hf.calls.filter((call) =>
        ["pause", "setVariables", "restart", "wait"].includes(call),
      ),
    ).toEqual(["pause", "setVariables", "restart", "wait"]);
    expect(
      setupResult.http.requests.filter((request) => request.path === "/api/v1/system"),
    ).toHaveLength(2);
    expect(progress).toEqual([]);
  });

  it("does not activate without authenticated system verification", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    await complete(setupResult, bootstrapResult.receipt);
    setupResult.hf.calls.length = 0;
    setupResult.http.readyRequestCount = 0;

    await expect(
      activateInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: bootstrapResult.receipt,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("HARBOR_HF_CONTROL_BEARER_TOKEN is required");
    expect(setupResult.hf.calls).not.toContain("setVariables");
    expect(setupResult.hf.calls).not.toContain("pause");
  });

  it("does not activate enabled with an existing run projection", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    await complete(setupResult, bootstrapResult.receipt);
    setupResult.hf.calls.length = 0;
    setupResult.http.readyRequestCount = 0;
    setupResult.http.runItems = [{ run_id: "existing-run" }];
    setupResult.dependencies.environment = {
      HARBOR_HF_CONTROL_BEARER_TOKEN: "operator-bearer-placeholder",
      HARBOR_HF_PARENT_IMAGE: PARENT_IMAGE,
    };

    await expect(
      activateInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: bootstrapResult.receipt,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("empty run projection");
    expect(setupResult.hf.calls).not.toContain("setVariables");
    expect(setupResult.hf.calls).not.toContain("pause");
  });

  it("disables an unhealthy already-running enabled", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    await complete(setupResult, bootstrapResult.receipt);
    if (!setupResult.hf.state.space) throw new Error("test Space is missing");
    setupResult.hf.state.space.variables.HARBOR_HF_WRITE_MODE = "enabled";
    setupResult.hf.state.space.variables.HARBOR_HF_PARENT_IMAGE = PARENT_IMAGE;
    setupResult.http.systemIntegrityError = "projection mismatch";
    setupResult.http.readyRequestCount = 0;
    setupResult.dependencies.environment = {
      HARBOR_HF_CONTROL_BEARER_TOKEN: "operator-bearer-placeholder",
    };

    await expect(
      activateInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: bootstrapResult.receipt,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("disabled rollback verified");
    expect(setupResult.hf.state.space.variables.HARBOR_HF_WRITE_MODE).toBe("disabled");
    expect(setupResult.hf.state.space.runtimeStage).toBe("PAUSED");
  });

  it("verifies disabled rollback after a failed enabled restart", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    await complete(setupResult, bootstrapResult.receipt);
    setupResult.hf.calls.length = 0;
    setupResult.http.readyRequestCount = 0;
    setupResult.http.failReadyOnRequest = 2;
    setupResult.dependencies.environment = {
      ...setupResult.dependencies.environment,
      HARBOR_HF_CONTROL_BEARER_TOKEN: "operator-bearer-placeholder",
    };

    await expect(
      activateInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: bootstrapResult.receipt,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("disabled rollback verified");
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_WRITE_MODE).toBe("disabled");
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
    expect(setupResult.hf.calls.filter((call) => call === "setVariables")).toHaveLength(
      2,
    );
  });

  it("disables and pauses enabled mode without control API health", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    await complete(setupResult, bootstrapResult.receipt);
    if (!setupResult.hf.state.space) throw new Error("test Space is missing");
    setupResult.hf.state.space.variables.HARBOR_HF_WRITE_MODE = "enabled";
    setupResult.hf.state.space.variables.HARBOR_HF_PARENT_IMAGE = PARENT_IMAGE;
    setupResult.hf.calls.length = 0;
    setupResult.http.requests.length = 0;
    setupResult.dependencies.environment = {};

    await expect(
      disableInstall(
        {
          planPath: setupResult.planPath,
        },
        setupResult.dependencies,
      ),
    ).resolves.toMatchObject({
      write_mode: "disabled",
      runtime: "paused",
      authenticated_system: "not_required",
    });
    expect(setupResult.http.requests).toEqual([]);
    expect(setupResult.hf.state.space.variables.HARBOR_HF_WRITE_MODE).toBe("disabled");
    expect(setupResult.hf.state.space.runtimeStage).toBe("PAUSED");

    setupResult.http.readyRequestCount = 0;
    setupResult.dependencies.environment = {
      HARBOR_HF_CONTROL_BEARER_TOKEN: "operator-bearer-placeholder",
      HARBOR_HF_PARENT_IMAGE: PARENT_IMAGE,
    };
    await expect(
      activateInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: bootstrapResult.receipt,
        },
        setupResult.dependencies,
      ),
    ).resolves.toMatchObject({
      write_mode: "enabled",
      runtime: "running",
    });
  });

  it("persists Bucket proof before returning the bootstrap result", async () => {
    const setupResult = await setup();
    let persisted: Awaited<ReturnType<typeof bootstrap>>["receipt"] | undefined;
    const result = await applyInstall(
      {
        planPath: setupResult.planPath,
        persistBootstrapReceipt: async (receipt) => {
          persisted = structuredClone(receipt);
        },
      },
      setupResult.dependencies,
    );
    expect(result.status).toBe("credentials_required");
    if (result.status !== "credentials_required") {
      throw new Error("expected bootstrap result");
    }
    expect(persisted).toEqual(result.receipt);
  });

  it("resumes provider-initialized empty Space creation without a local receipt", async () => {
    const setupResult = await setup();
    const variables = Object.fromEntries(
      Object.entries(setupResult.planned.plan.expected_variables).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    );
    variables.HARBOR_HF_INSTALL_PHASE = "credentials_required";
    setupResult.hf.state.space = {
      id: "example/control",
      private: true,
      sdk: "docker",
      origin: ORIGIN,
      sha: OLD_REVISION,
      runtimeStage: "NO_APP_FILE",
      hardware: null,
      requestedHardware: "cpu-basic",
      variables,
      secretNames: [],
    };
    setupResult.hf.preserveNoAppFileOnVariables = true;

    const result = await applyInstall(
      { planPath: setupResult.planPath },
      setupResult.dependencies,
    );
    expect(result).toMatchObject({
      status: "credentials_required",
      source_uploaded: false,
      secrets_configured: false,
    });
    if (result.status !== "credentials_required") {
      throw new Error("expected credentials-required result");
    }
    expect(setupResult.hf.calls).toContain("createBucket");
    expect(setupResult.hf.calls).not.toContain("pause");
    expect(setupResult.hf.calls).not.toContain("uploadMirror");
    expect(setupResult.hf.calls).not.toContain("setSecrets");
    await expect(
      provisionInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: result.receipt,
        },
        setupResult.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "credentials_required",
      source_uploaded: false,
    });
  });

  it("rejects resources-only success after configuration has started", async () => {
    const cases: Array<{
      name: string;
      mutate: (space: SpaceState, receipt: BootstrapReceipt) => void;
    }> = [
      {
        name: "running runtime",
        mutate: (space) => {
          space.runtimeStage = "RUNNING";
        },
      },
      {
        name: "uploaded source",
        mutate: (space) => {
          space.runtimeStage = "PAUSED";
          space.sha = UPLOAD_SHA;
        },
      },
      {
        name: "configured secret",
        mutate: (space) => {
          space.secretNames = ["HF_TOKEN"];
        },
      },
      {
        name: "upload receipt",
        mutate: (space, receipt) => {
          space.runtimeStage = "NO_APP_FILE";
          space.sha = OLD_REVISION;
          receipt.uploaded_sha = UPLOAD_SHA;
        },
      },
    ];

    for (const scenario of cases) {
      const setupResult = await setup();
      const bootstrapResult = await bootstrap(setupResult);
      if (!setupResult.hf.state.space) throw new Error("test Space is missing");
      scenario.mutate(setupResult.hf.state.space, bootstrapResult.receipt);
      setupResult.hf.calls.length = 0;

      await expect(
        provisionInstall(
          {
            planPath: setupResult.planPath,
            bootstrapReceipt: bootstrapResult.receipt,
          },
          setupResult.dependencies,
        ),
        scenario.name,
      ).rejects.toThrow("configuration has started");
      expect(setupResult.hf.calls, scenario.name).not.toContain("pause");
      expect(setupResult.hf.calls, scenario.name).not.toContain("uploadMirror");
      expect(setupResult.hf.calls, scenario.name).not.toContain("setSecrets");
    }
  });

  it("rebinds changed source only before bootstrap Bucket proof exists", async () => {
    const directory = await temporaryDirectory();
    const repository = resolve(directory, "repository");
    const hf = new FakeHf();
    const identity = new FakeIdentity();
    const dependencies: InstallerDependencies = {
      hf,
      source: new FakeSource(repository, OLD_REVISION),
      identity,
      http: new FakeHttp(),
      clock: new FakeClock(),
      environment: {},
    };
    const oldPlan = await planInstall(
      {
        space: "example/control",
        bundleDirectory: resolve(directory, "old", "bundle"),
        planPath: resolve(directory, "old", "plan.json"),
      },
      dependencies,
    );
    const variables = Object.fromEntries(
      Object.entries(oldPlan.plan.expected_variables).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    );
    variables.HARBOR_HF_INSTALL_PHASE = "credentials_required";
    hf.state = {
      namespaceListingsComplete: true,
      space: {
        id: "example/control",
        private: true,
        sdk: "docker",
        origin: ORIGIN,
        sha: OLD_REVISION,
        runtimeStage: "NO_APP_FILE",
        hardware: null,
        requestedHardware: "cpu-basic",
        variables,
        secretNames: [],
      },
      bucket: { id: "example/control-artifacts", private: true },
    };
    dependencies.source = new FakeSource(repository);

    await expect(
      planInstall(
        {
          space: "example/control",
          bundleDirectory: resolve(directory, "blocked", "bundle"),
          planPath: resolve(directory, "blocked", "plan.json"),
        },
        dependencies,
      ),
    ).rejects.toThrow("does not match the current source");

    hf.state.bucket = null;
    if (!hf.state.space) throw new Error("test Space is missing");
    hf.state.space.runtimeStage = "RUNNING";
    await expect(
      planInstall(
        {
          space: "example/control",
          bundleDirectory: resolve(directory, "running", "bundle"),
          planPath: resolve(directory, "running", "plan.json"),
        },
        dependencies,
      ),
    ).rejects.toThrow("cannot be rebound");

    hf.state.space.runtimeStage = "NO_APP_FILE";
    hf.state.space.secretNames = ["HF_TOKEN"];
    await expect(
      planInstall(
        {
          space: "example/control",
          bundleDirectory: resolve(directory, "secret", "bundle"),
          planPath: resolve(directory, "secret", "plan.json"),
        },
        dependencies,
      ),
    ).rejects.toThrow("cannot be rebound");

    hf.state.space.secretNames = [];
    const replacement = await planInstall(
      {
        space: "example/control",
        bundleDirectory: resolve(directory, "replacement", "bundle"),
        planPath: resolve(directory, "replacement", "plan.json"),
      },
      dependencies,
    );
    expect(replacement.plan.source.revision).toBe(REVISION);
    const oldState = structuredClone(hf.state);
    if (!hf.state.space) throw new Error("test Space is missing");
    hf.state.space.variables = Object.fromEntries(
      Object.entries(replacement.plan.expected_variables).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    );
    hf.state.space.variables.HARBOR_HF_INSTALL_PHASE = "credentials_required";
    hf.state.space.runtimeStage = "RUNNING";
    hf.calls.length = 0;
    await expect(
      applyInstall({ planPath: replacement.path }, dependencies),
    ).rejects.toThrow("drifted");
    expect(hf.calls).not.toContain("setVariables");
    expect(hf.calls).not.toContain("pause");
    expect(hf.calls).not.toContain("createBucket");

    hf.state.space.runtimeStage = "NO_APP_FILE";
    await expect(
      applyInstall({ planPath: replacement.path }, dependencies),
    ).rejects.toThrow("drifted");
    expect(hf.calls).not.toContain("setVariables");
    expect(hf.calls).not.toContain("pause");
    expect(hf.calls).not.toContain("createBucket");

    hf.state = oldState;
    hf.calls.length = 0;
    await expect(
      applyInstall({ planPath: replacement.path }, dependencies),
    ).resolves.toMatchObject({
      status: "credentials_required",
      source_uploaded: false,
      secrets_configured: false,
    });
    expect(hf.state.space?.variables.HARBOR_HF_SOURCE_REVISION).toBe(REVISION);
    expect(hf.state.bucket).toEqual({
      id: "example/control-artifacts",
      private: true,
    });
  });

  it("pauses and fails closed when Bucket proof cannot be persisted", async () => {
    const setupResult = await setup();
    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
          persistBootstrapReceipt: async () => {
            throw new Error("local receipt write failed");
          },
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("after remote mutation began");
    expect(setupResult.hf.state.bucket).not.toBeNull();
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
    expect(setupResult.hf.calls).not.toContain("uploadMirror");
    expect(setupResult.hf.calls).not.toContain("setSecrets");
  });

  it("reports only a sanitized Bucket provider failure category", async () => {
    const setupResult = await setup();
    setupResult.hf.createBucketFailureCategory = "forbidden";
    await expect(
      applyInstall({ planPath: setupResult.planPath }, setupResult.dependencies),
    ).rejects.toThrow("provider category: forbidden");
    expect(setupResult.hf.state.bucket).toBeNull();
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
  });

  it("requires the exact local Bucket proof receipt before completion", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.hf.calls.length = 0;
    await expect(
      applyInstall({ planPath: setupResult.planPath }, setupResult.dependencies),
    ).rejects.toThrow("Bucket ownership is unproven");
    expect(setupResult.hf.calls).not.toContain("pause");
    expect(setupResult.hf.calls).not.toContain("uploadMirror");

    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: {
            ...bootstrapResult.receipt,
            install_id: "e".repeat(64),
          },
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("receipt does not match");
    expect(setupResult.hf.calls).not.toContain("pause");
    expect(setupResult.hf.calls).not.toContain("uploadMirror");
  });

  it("does not recreate proven resources when both disappear", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.hf.state.space = null;
    setupResult.hf.state.bucket = null;
    setupResult.hf.calls.length = 0;

    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "proven resource is missing",
    );
    expect(setupResult.hf.calls).not.toContain("createSpace");
    expect(setupResult.hf.calls).not.toContain("createBucket");
  });

  it("reports that bootstrap verification is awaiting credential completion", async () => {
    const setupResult = await setup();
    await bootstrap(setupResult);
    await expect(
      verifyInstall(setupResult.planPath, setupResult.dependencies),
    ).rejects.toThrow("awaiting credential completion");
    expect(setupResult.http.requests).toEqual([]);
  });

  it("does not adopt an ambiguously created Bucket without a receipt", async () => {
    const setupResult = await setup();
    setupResult.hf.failCreateBucketResponse = true;
    await expect(
      applyInstall({ planPath: setupResult.planPath }, setupResult.dependencies),
    ).rejects.toThrow("after remote mutation began");
    expect(setupResult.hf.state.bucket).toEqual({
      id: "example/control-artifacts",
      private: true,
    });

    setupResult.hf.failCreateBucketResponse = false;
    setupResult.hf.calls.length = 0;
    setupResult.dependencies.secretInput = {
      async read() {
        throw new Error("ambiguous Bucket must not prompt");
      },
    };
    await expect(
      applyInstall({ planPath: setupResult.planPath }, setupResult.dependencies),
    ).rejects.toThrow("Bucket ownership is unproven");
    expect(setupResult.hf.calls).not.toContain("pause");
    expect(setupResult.hf.calls).not.toContain("uploadMirror");
  });

  it("rejects every changed bootstrap binding before prompting or mutation", async () => {
    const mutations: Array<(variables: Record<string, string>) => void> = [
      (variables) => {
        variables.HARBOR_HF_INSTALL_ID = "e".repeat(64);
      },
      (variables) => {
        variables.HARBOR_HF_SOURCE_REVISION = "e".repeat(40);
      },
      (variables) => {
        variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST = `sha256:${"e".repeat(64)}`;
      },
      (variables) => {
        variables.HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS = "other-subject";
      },
      (variables) => {
        variables.HARBOR_HF_WRITE_MODE = "enabled";
      },
      (variables) => {
        variables.UNEXPECTED_VARIABLE = "unexpected";
      },
    ];
    for (const mutate of mutations) {
      const setupResult = await setup();
      const bootstrapResult = await bootstrap(setupResult);
      if (!setupResult.hf.state.space) throw new Error("test Space is missing");
      mutate(setupResult.hf.state.space.variables);
      setupResult.hf.calls.length = 0;
      setupResult.dependencies.secretInput = {
        async read() {
          throw new Error("changed binding must not prompt");
        },
      };
      await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow();
      expect(setupResult.hf.calls).not.toContain("pause");
      expect(setupResult.hf.calls).not.toContain("uploadMirror");
      expect(setupResult.hf.calls).not.toContain("setSecrets");
    }
  });

  it("does not pause or continue a bootstrap with an unknown secret name", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    if (!setupResult.hf.state.space) throw new Error("test Space is missing");
    setupResult.hf.state.space.secretNames = ["UNEXPECTED_SECRET"];
    setupResult.hf.calls.length = 0;
    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow();
    expect(setupResult.hf.calls).not.toContain("pause");
    expect(setupResult.hf.calls).not.toContain("uploadMirror");
    expect(setupResult.hf.calls).not.toContain("setSecrets");
  });

  it("rejects invalid bootstrap phase entry states before mutation", async () => {
    const expectedSecret = await setup();
    const expectedSecretBootstrap = await bootstrap(expectedSecret);
    if (!expectedSecret.hf.state.space) throw new Error("test Space is missing");
    expectedSecret.hf.state.space.secretNames = ["HF_TOKEN"];
    expectedSecret.hf.calls.length = 0;
    await expect(
      complete(expectedSecret, expectedSecretBootstrap.receipt),
    ).rejects.toThrow("before remote mutation began");
    expect(expectedSecret.hf.calls).not.toContain("pause");
    expect(expectedSecret.hf.calls).not.toContain("uploadMirror");

    const running = await setup();
    const runningBootstrap = await bootstrap(running);
    if (!running.hf.state.space) throw new Error("test Space is missing");
    running.hf.state.space.runtimeStage = "RUNNING";
    running.hf.calls.length = 0;
    await expect(complete(running, runningBootstrap.receipt)).rejects.toThrow(
      "before remote mutation began",
    );
    expect(running.hf.calls).not.toContain("pause");
    expect(running.hf.calls).not.toContain("uploadMirror");

    const sourceStaged = await setup();
    const sourceStagedBootstrap = await bootstrap(sourceStaged);
    sourceStaged.hf.failSetSecretsPartially = true;
    await expect(complete(sourceStaged, sourceStagedBootstrap.receipt)).rejects.toThrow(
      "after remote mutation began",
    );
    if (!sourceStaged.hf.state.space) throw new Error("test Space is missing");
    sourceStaged.hf.state.space.runtimeStage = "RUNNING";
    sourceStaged.hf.failSetSecretsPartially = false;
    sourceStaged.hf.calls.length = 0;
    await expect(complete(sourceStaged, sourceStagedBootstrap.receipt)).rejects.toThrow(
      "before remote mutation began",
    );
    expect(sourceStaged.hf.calls).not.toContain("pause");
    expect(sourceStaged.hf.calls).not.toContain("uploadMirror");
  });

  it("accepts provider-initialized metadata for a stopped empty bootstrap", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    if (!setupResult.hf.state.space) throw new Error("test Space is missing");
    setupResult.hf.state.space.sha = OLD_REVISION;
    setupResult.hf.state.space.runtimeStage = "NO_APP_FILE";
    setupResult.hf.calls.length = 0;

    await expect(complete(setupResult, bootstrapResult.receipt)).resolves.toMatchObject(
      { status: "installed" },
    );
    expect(setupResult.hf.calls).toContain("uploadMirror");
    expect(setupResult.hf.calls.indexOf("uploadMirror")).toBeLessThan(
      setupResult.hf.calls.indexOf("setSecrets"),
    );
    expect(setupResult.hf.calls.indexOf("uploadMirror")).toBeLessThan(
      setupResult.hf.calls.indexOf("pause"),
    );
  });

  it("pauses after a failed upload attempt from an empty stopped bootstrap", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    if (!setupResult.hf.state.space) throw new Error("test Space is missing");
    setupResult.hf.state.space.runtimeStage = "NO_APP_FILE";
    setupResult.hf.failUpload = true;
    setupResult.hf.calls.length = 0;

    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "after remote mutation began",
    );
    expect(setupResult.hf.calls.indexOf("uploadMirror")).toBeLessThan(
      setupResult.hf.calls.indexOf("pause"),
    );
    expect(setupResult.hf.state.space.runtimeStage).toBe("PAUSED");
  });

  it("rejects incomplete installed bootstrap credentials before mutation", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    await complete(setupResult, bootstrapResult.receipt);
    if (!setupResult.hf.state.space) throw new Error("test Space is missing");
    setupResult.hf.state.space.secretNames = ["HF_TOKEN"];
    setupResult.hf.calls.length = 0;
    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "before remote mutation began",
    );
    expect(setupResult.hf.calls).not.toContain("pause");
    expect(setupResult.hf.calls).not.toContain("uploadMirror");
  });

  it("rewrites both credentials after a partial secret write", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.hf.failSetSecretsPartially = true;
    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "after remote mutation began",
    );
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_INSTALL_PHASE).toBe(
      "source_staged",
    );
    expect(setupResult.hf.state.space?.secretNames).toHaveLength(1);
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");

    setupResult.hf.failSetSecretsPartially = false;
    await expect(complete(setupResult, bootstrapResult.receipt)).resolves.toMatchObject(
      { status: "installed" },
    );
    expect(setupResult.hf.calls.filter((call) => call === "setSecrets")).toHaveLength(
      2,
    );
    expect(setupResult.hf.secretWriteNames).toEqual([
      ["HF_INFERENCE_TOKEN", "HF_TOKEN"],
      ["HF_INFERENCE_TOKEN", "HF_TOKEN"],
    ]);
    expect(setupResult.hf.state.space?.secretNames).toEqual([
      "HF_INFERENCE_TOKEN",
      "HF_TOKEN",
    ]);
  });

  it("adopts complete credentials after a lost secret write response", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    const reportedWarnings: string[][] = [];
    setupResult.controlTokenScope.warnings = [
      "The control credential has global permissions: repo.write.",
    ];
    setupResult.dependencies.reportControlCredentialWarnings = (warnings) => {
      reportedWarnings.push([...warnings]);
    };
    setupResult.hf.failSetSecretsResponse = true;
    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "after remote mutation began",
    );
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_INSTALL_PHASE).toBe(
      "source_staged",
    );
    expect(setupResult.hf.state.space?.secretNames).toEqual([
      "HF_INFERENCE_TOKEN",
      "HF_TOKEN",
    ]);
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
    expect(reportedWarnings).toEqual([
      ["The control credential has global permissions: repo.write."],
    ]);

    setupResult.hf.failSetSecretsResponse = false;
    setupResult.dependencies.environment = {};
    setupResult.dependencies.secretInput = {
      async read() {
        throw new Error("complete credentials must not prompt");
      },
    };
    await expect(complete(setupResult, bootstrapResult.receipt)).resolves.toMatchObject(
      { status: "installed" },
    );
    expect(reportedWarnings).toHaveLength(1);
    expect(setupResult.hf.calls.filter((call) => call === "setSecrets")).toHaveLength(
      1,
    );
  });

  it("rejects a control credential without the exact approved scope", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.controlTokenScope.fail = true;

    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "control credential scope inspection failed",
    );
    expect(setupResult.bucketWriteProbe.calls).toHaveLength(0);
    expect(setupResult.hf.calls).not.toContain("setSecrets");
    expect(setupResult.hf.state.space?.secretNames).toEqual([]);
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
  });

  it("rejects an inference credential before any secret is persisted", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.inferenceTokenScope.fail = true;

    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "inference credential does not have the exact approved inference-only scope",
    );
    expect(setupResult.inferenceTokenScope.calls).toEqual([
      { accessToken: "inference-placeholder" },
    ]);
    expect(setupResult.controlTokenScope.calls).toHaveLength(0);
    expect(setupResult.bucketWriteProbe.calls).toHaveLength(0);
    expect(setupResult.hf.calls).not.toContain("setSecrets");
    expect(setupResult.hf.state.space?.secretNames).toEqual([]);
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
  });

  it("rejects a control credential that cannot create a fresh Bucket object", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.bucketWriteProbe.fail = true;

    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "control credential scope was accepted, but the fresh artifact Bucket write/read-back proof failed",
    );
    expect(setupResult.controlTokenScope.calls).toHaveLength(1);
    expect(setupResult.bucketWriteProbe.calls).toHaveLength(1);
    expect(setupResult.hf.calls).not.toContain("setSecrets");
    expect(setupResult.hf.state.space?.secretNames).toEqual([]);
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
  });

  it("continues with prominent control credential warnings", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.controlTokenScope.warnings = [
      "The control credential has global permissions: repo.write.",
    ];

    await expect(complete(setupResult, bootstrapResult.receipt)).resolves.toMatchObject(
      {
        status: "installed",
        control_credential_warnings: [
          "The control credential has global permissions: repo.write.",
        ],
        control_credential_warnings_reported: false,
      },
    );
    expect(setupResult.bucketWriteProbe.calls).toHaveLength(1);
    expect(setupResult.hf.calls).toContain("setSecrets");
  });

  it("explicitly replaces complete credentials after preflight", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.http.readyResponses.push({
      status: 503,
      body: { status: "unavailable" },
    });
    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "after remote mutation began",
    );
    setupResult.dependencies.environment = {
      HARBOR_HF_INSTALL_CONTROL_SECRET: "replacement-control",
      HARBOR_HF_INSTALL_INFERENCE_SECRET: "replacement-inference",
    };

    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: bootstrapResult.receipt,
          replaceCredentials: true,
        },
        setupResult.dependencies,
      ),
    ).resolves.toMatchObject({ status: "installed" });
    expect(setupResult.hf.calls.filter((call) => call === "setSecrets")).toHaveLength(
      2,
    );
    expect(setupResult.controlTokenScope.calls).toHaveLength(2);
    expect(setupResult.controlTokenScope.calls[1]).toEqual({
      namespace: "example",
      bucketId: "example/control-artifacts",
      accessToken: "replacement-control",
    });
    expect(setupResult.inferenceTokenScope.calls).toHaveLength(2);
    expect(setupResult.inferenceTokenScope.calls[1]).toEqual({
      accessToken: "replacement-inference",
    });
    expect(setupResult.bucketWriteProbe.calls).toHaveLength(2);
    expect(setupResult.bucketWriteProbe.calls[0]?.path).not.toBe(
      setupResult.bucketWriteProbe.calls[1]?.path,
    );
    expect(setupResult.bucketWriteProbe.calls[1]).toMatchObject({
      bucketId: "example/control-artifacts",
      path: expect.stringMatching(
        /^installer\/write-probes\/schema=v1\/[a-f0-9]{64}\/[a-f0-9]{32}$/,
      ),
    });
  });

  it("rejects replacement inference scope before rewriting installed secrets", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    await expect(complete(setupResult, bootstrapResult.receipt)).resolves.toMatchObject(
      { status: "installed" },
    );
    setupResult.dependencies.environment = {
      HARBOR_HF_INSTALL_CONTROL_SECRET: "replacement-control",
      HARBOR_HF_INSTALL_INFERENCE_SECRET: "replacement-inference",
    };
    setupResult.inferenceTokenScope.fail = true;
    setupResult.inferenceTokenScope.calls.length = 0;
    setupResult.controlTokenScope.calls.length = 0;
    setupResult.bucketWriteProbe.calls.length = 0;
    setupResult.hf.calls.length = 0;

    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: bootstrapResult.receipt,
          replaceCredentials: true,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow(
      "inference credential does not have the exact approved inference-only scope",
    );
    expect(setupResult.inferenceTokenScope.calls).toEqual([
      { accessToken: "replacement-inference" },
    ]);
    expect(setupResult.controlTokenScope.calls).toHaveLength(0);
    expect(setupResult.bucketWriteProbe.calls).toHaveLength(0);
    expect(setupResult.hf.calls).not.toContain("setSecrets");
    expect(setupResult.hf.state.space?.secretNames).toEqual([
      "HF_INFERENCE_TOKEN",
      "HF_TOKEN",
    ]);
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
  });

  it("returns failed verification to source-staged credential recovery", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.http.readyResponses.push({
      status: 503,
      body: { status: "unavailable" },
    });
    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "after remote mutation began",
    );
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_INSTALL_PHASE).toBe(
      "source_staged",
    );
    const uploadsBeforeRetry = setupResult.hf.calls.filter(
      (call) => call === "uploadMirror",
    ).length;

    await expect(complete(setupResult, bootstrapResult.receipt)).resolves.toMatchObject(
      { status: "installed" },
    );
    expect(setupResult.hf.calls.filter((call) => call === "uploadMirror")).toHaveLength(
      uploadsBeforeRetry,
    );
    expect(setupResult.hf.calls.filter((call) => call === "setSecrets")).toHaveLength(
      1,
    );
  });

  it("stops before mutation when resumed source differs from its receipt", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.http.readyResponses.push({
      status: 503,
      body: { status: "unavailable" },
    });
    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "after remote mutation began",
    );
    expect(bootstrapResult.receipt.uploaded_sha).toBe(UPLOAD_SHA);
    if (!setupResult.hf.state.space) throw new Error("test Space is missing");
    setupResult.hf.state.space.sha = "d".repeat(40);
    setupResult.hf.calls.length = 0;

    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "Space source differs from the recorded upload",
    );
    expect(setupResult.hf.calls).not.toContain("uploadMirror");
    expect(setupResult.hf.calls).not.toContain("pause");
    expect(bootstrapResult.receipt.uploaded_sha).toBe(UPLOAD_SHA);
  });

  it("reasserts an existing installation without replacing secrets", async () => {
    const setupResult = await setup(REVISION);
    setupResult.hf.calls.length = 0;
    await applyInstall(
      {
        planPath: setupResult.planPath,
      },
      setupResult.dependencies,
    );
    expect(setupResult.hf.calls).toContain("pause");
    expect(setupResult.hf.calls).toContain("setProtected");
    expect(setupResult.hf.calls).toContain("setVariables");
    expect(setupResult.hf.calls).not.toContain("setSecrets");
    expect(setupResult.hf.calls).toContain("uploadMirror");
    expect(setupResult.hf.calls).toContain("restart");
    expect(setupResult.hf.calls).toContain("wait");
  });

  it("updates only the release variable and exact mirror for a marked target", async () => {
    const setupResult = await setup(OLD_REVISION);
    setupResult.hf.calls.length = 0;
    await applyInstall(
      {
        planPath: setupResult.planPath,
      },
      setupResult.dependencies,
    );
    expect(setupResult.hf.calls).toContain("setVariables");
    expect(setupResult.hf.calls).toContain("uploadMirror");
    expect(setupResult.hf.calls).not.toContain("setSecrets");
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_SOURCE_REVISION).toBe(
      REVISION,
    );
  });

  it("migrates an exact legacy installed Space through the normal update path", async () => {
    const directory = await temporaryDirectory();
    const repository = resolve(directory, "repository");
    const bundle = resolve(directory, "private", "bundle");
    const planPath = resolve(directory, "private", "plan.json");
    const hf = new FakeHf();
    const identity = new FakeIdentity();
    hf.state = legacyInstalledState(OLD_REVISION, identity.principal);
    const dependencies: InstallerDependencies = {
      hf,
      source: new FakeSource(repository),
      identity,
      http: new FakeHttp(),
      clock: new FakeClock(),
      environment: {},
      secretInput: {
        async read() {
          throw new Error("legacy credentials must not be replaced");
        },
      },
    };
    const planned = await planInstall(
      {
        space: "example/control",
        bundleDirectory: bundle,
        planPath,
      },
      dependencies,
    );
    await expect(
      applyInstall({ planPath: planned.path }, dependencies),
    ).resolves.toMatchObject({ status: "installed" });
    expect(hf.calls).not.toContain("setSecrets");
    expect(hf.state.space?.variables.HARBOR_HF_INSTALLER_MARKER).toBe(
      "harbor-hf.install-plan.v2",
    );
    expect(hf.state.space?.variables.HARBOR_HF_INSTALL_PHASE).toBe("installed");
  });

  it("recovers a partially applied legacy variable migration", async () => {
    const directory = await temporaryDirectory();
    const repository = resolve(directory, "repository");
    const hf = new FakeHf();
    const identity = new FakeIdentity();
    hf.state = legacyInstalledState(OLD_REVISION, identity.principal);
    hf.failSetVariablesPartially = true;
    const dependencies: InstallerDependencies = {
      hf,
      source: new FakeSource(repository),
      identity,
      http: new FakeHttp(),
      clock: new FakeClock(),
      environment: {},
    };
    const planned = await planInstall(
      {
        space: "example/control",
        bundleDirectory: resolve(directory, "private", "bundle"),
        planPath: resolve(directory, "private", "plan.json"),
      },
      dependencies,
    );
    await expect(
      applyInstall({ planPath: planned.path }, dependencies),
    ).rejects.toThrow("after remote mutation began");
    expect(hf.state.space?.variables.HARBOR_HF_INSTALLER_MARKER).toBe(
      "harbor-hf.install-plan.v1",
    );
    expect(hf.state.space?.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST).toBe(
      planned.plan.bundle.manifest_digest,
    );
    expect(hf.state.space?.runtimeStage).toBe("PAUSED");

    hf.failSetVariablesPartially = false;
    await expect(
      applyInstall({ planPath: planned.path }, dependencies),
    ).resolves.toMatchObject({ status: "installed" });
  });

  it("uploads before changing the revision so an interrupted update stays retryable", async () => {
    const setupResult = await setup(OLD_REVISION);
    setupResult.hf.failUpload = true;
    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("after remote mutation began");
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_SOURCE_REVISION).toBe(
      OLD_REVISION,
    );
    expect(setupResult.hf.calls).toContain("uploadMirror");
    expect(setupResult.hf.calls).not.toContain("setVariables");
    expect(setupResult.hf.calls).toContain("pause");
  });

  it("pauses and retries a partially applied v2 variable update", async () => {
    const setupResult = await setup(OLD_REVISION);
    setupResult.hf.failSetVariablesPartially = true;
    await expect(
      applyInstall({ planPath: setupResult.planPath }, setupResult.dependencies),
    ).rejects.toThrow("after remote mutation began");
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_BUNDLE_MANIFEST_DIGEST).toBe(
      setupResult.planned.plan.bundle.manifest_digest,
    );
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_SOURCE_REVISION).toBe(
      OLD_REVISION,
    );
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");

    setupResult.hf.failSetVariablesPartially = false;
    await expect(
      applyInstall({ planPath: setupResult.planPath }, setupResult.dependencies),
    ).resolves.toMatchObject({ status: "installed" });
  });

  it("does not let stale cleanup pause a newer source binding", async () => {
    const setupResult = await setup(OLD_REVISION);
    setupResult.hf.failUpload = true;
    setupResult.hf.mutateBindingOnUploadFailure = true;
    await expect(
      applyInstall({ planPath: setupResult.planPath }, setupResult.dependencies),
    ).rejects.toThrow("after remote mutation began");
    expect(setupResult.hf.calls.filter((call) => call === "pause")).toHaveLength(1);
  });

  it("replans and resumes after a lost fresh Space create response", async () => {
    const setupResult = await setup();
    setupResult.hf.failCreateSpaceResponse = true;
    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("after remote mutation began");
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");

    setupResult.hf.failCreateSpaceResponse = false;
    setupResult.dependencies.environment = {};
    const recovery = await planInstall(
      {
        space: "example/control",
        bundleDirectory: resolve(setupResult.directory, "recovery", "bundle"),
        planPath: resolve(setupResult.directory, "recovery", "plan.json"),
      },
      setupResult.dependencies,
    );
    await expect(
      applyInstall(
        {
          planPath: recovery.path,
        },
        setupResult.dependencies,
      ),
    ).resolves.toMatchObject({ status: "credentials_required" });
  });

  it("does not pause an unmarked Space that appears during create", async () => {
    const setupResult = await setup();
    setupResult.hf.failCreateWithUnmarkedRace = true;
    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("after remote mutation began");
    expect(setupResult.hf.calls).not.toContain("pause");
    expect(setupResult.hf.state.space?.variables).toEqual({});
  });

  it("replans and resumes after upload succeeds but variable update fails", async () => {
    const setupResult = await setup(OLD_REVISION);
    setupResult.hf.failSetVariablesAfterUpload = true;
    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("after remote mutation began");
    expect(setupResult.hf.state.space?.sha).toBe(UPLOAD_SHA);
    expect(setupResult.hf.state.space?.variables.HARBOR_HF_SOURCE_REVISION).toBe(
      OLD_REVISION,
    );
    expect(setupResult.hf.state.space?.runtimeStage).toBe("PAUSED");

    setupResult.hf.failSetVariablesAfterUpload = false;
    const recovery = await planInstall(
      {
        space: "example/control",
        bundleDirectory: resolve(setupResult.directory, "recovery", "bundle"),
        planPath: resolve(setupResult.directory, "recovery", "plan.json"),
      },
      setupResult.dependencies,
    );
    await expect(
      applyInstall(
        {
          planPath: recovery.path,
        },
        setupResult.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "installed",
      verification: { source_upload_revision: "passed" },
    });
  });

  it("rejects unmarked targets, list failures, and post-plan drift", async () => {
    const directory = await temporaryDirectory();
    const repository = resolve(directory, "repository");
    const privateDirectory = resolve(directory, "private");
    const dependencies: InstallerDependencies = {
      hf: new FakeHf(),
      source: new FakeSource(repository),
      identity: new FakeIdentity(),
      http: new FakeHttp(),
      clock: new FakeClock(),
    };
    const hf = dependencies.hf as FakeHf;
    hf.state = installedState(
      REVISION,
      (dependencies.identity as FakeIdentity).principal,
    );
    if (!hf.state.space) throw new Error("test state is missing");
    hf.state.space.variables.HARBOR_HF_INSTALLER_MARKER = "different";
    await expect(
      planInstall(
        {
          space: "example/control",
          bundleDirectory: resolve(privateDirectory, "mismatch-bundle"),
          planPath: resolve(privateDirectory, "mismatch-plan.json"),
        },
        dependencies,
      ),
    ).rejects.toThrow("installer-marked");

    hf.failObserve = true;
    await expect(
      planInstall(
        {
          space: "example/control",
          bundleDirectory: resolve(privateDirectory, "failure-bundle"),
          planPath: resolve(privateDirectory, "failure-plan.json"),
        },
        dependencies,
      ),
    ).rejects.toThrow("listing failed");

    const drift = await setup();
    drift.hf.state.bucket = {
      id: "example/control-artifacts",
      private: true,
    };
    await expect(
      applyInstall({ planPath: drift.planPath }, drift.dependencies),
    ).rejects.toThrow("drifted");
  });

  it("requires manual recovery when an installed Space has no Bucket", async () => {
    const directory = await temporaryDirectory();
    const dependencies: InstallerDependencies = {
      hf: new FakeHf(),
      source: new FakeSource(resolve(directory, "repository")),
      identity: new FakeIdentity(),
      http: new FakeHttp(),
      clock: new FakeClock(),
    };
    const hf = dependencies.hf as FakeHf;
    hf.state = installedState(
      REVISION,
      (dependencies.identity as FakeIdentity).principal,
    );
    hf.state.bucket = null;
    await expect(
      planInstall(
        {
          space: "example/control",
          bundleDirectory: resolve(directory, "private", "bundle"),
          planPath: resolve(directory, "private", "plan.json"),
        },
        dependencies,
      ),
    ).rejects.toThrow("manual recovery");
    expect(hf.calls).not.toContain("createBucket");
  });

  it("requires manual recovery when a source-staged bootstrap loses its Bucket", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.hf.failSetSecretsPartially = true;
    await expect(complete(setupResult, bootstrapResult.receipt)).rejects.toThrow(
      "after remote mutation began",
    );
    setupResult.hf.state.bucket = null;
    await expect(
      planInstall(
        {
          space: "example/control",
          bundleDirectory: resolve(setupResult.directory, "replacement", "bundle"),
          planPath: resolve(setupResult.directory, "replacement", "plan.json"),
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("manual recovery");
  });

  it("requires private plan and bundle paths outside the checkout", async () => {
    const directory = await temporaryDirectory();
    const repository = resolve(directory, "repository");
    await expect(
      planInstall(
        {
          space: "example/control",
          bundleDirectory: resolve(repository, "bundle"),
          planPath: resolve(repository, "plan.json"),
        },
        {
          hf: new FakeHf(),
          source: new FakeSource(repository),
          identity: new FakeIdentity(),
          http: new FakeHttp(),
          clock: new FakeClock(),
        },
      ),
    ).rejects.toThrow("outside the checkout");
  });

  it("redacts post-mutation failure, pauses, and removes temp files", async () => {
    const setupResult = await setup();
    setupResult.hf.failCreateBucket = true;
    const controlSecret = setupResult.dependencies.environment
      ?.HARBOR_HF_INSTALL_CONTROL_SECRET as string;
    let message = "";
    try {
      await applyInstall(
        {
          planPath: setupResult.planPath,
        },
        setupResult.dependencies,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("after remote mutation began");
    expect(message).not.toContain(controlSecret);
    expect(message).not.toContain("provider detail");
    expect(setupResult.hf.calls).toContain("pause");
    for (const path of setupResult.hf.temporaryPaths) {
      await expect(access(path)).rejects.toThrow();
    }
  });

  it("requires valid distinct secret sources only when names are missing", async () => {
    const setupResult = await setup();
    const bootstrapResult = await bootstrap(setupResult);
    setupResult.dependencies.environment = {
      HARBOR_HF_INSTALL_CONTROL_SECRET: "same-placeholder",
      HARBOR_HF_INSTALL_INFERENCE_SECRET: "same-placeholder",
    };
    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
          bootstrapReceipt: bootstrapResult.receipt,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("distinct");

    const existing = await setup(REVISION);
    existing.dependencies.environment = {};
    await expect(
      applyInstall(
        {
          planPath: existing.planPath,
        },
        existing.dependencies,
      ),
    ).resolves.toMatchObject({ status: "installed" });

    if (!existing.hf.state.space) throw new Error("test Space is missing");
    existing.hf.state.space.secretNames = ["HF_TOKEN"];
    const recovery = await planInstall(
      {
        space: "example/control",
        bundleDirectory: resolve(existing.directory, "recovery", "bundle"),
        planPath: resolve(existing.directory, "recovery", "plan.json"),
      },
      existing.dependencies,
    );
    existing.dependencies.environment = {
      HARBOR_HF_INSTALL_CONTROL_SECRET: "same-placeholder",
      HARBOR_HF_INSTALL_INFERENCE_SECRET: "same-placeholder",
    };
    await expect(
      applyInstall({ planPath: recovery.path }, existing.dependencies),
    ).rejects.toThrow("distinct");
    expect(existing.hf.calls).not.toContain("setSecrets");

    existing.dependencies.environment = {
      HARBOR_HF_INSTALL_CONTROL_SECRET: "control-placeholder",
      HARBOR_HF_INSTALL_INFERENCE_SECRET: "inference-placeholder",
    };
    existing.hf.failSetSecretsPartially = true;
    await expect(
      applyInstall({ planPath: recovery.path }, existing.dependencies),
    ).rejects.toThrow("after remote mutation began");
    expect(existing.hf.state.space?.secretNames).toEqual([
      "HF_INFERENCE_TOKEN",
      "HF_TOKEN",
    ]);

    existing.hf.failSetSecretsPartially = false;
    await expect(
      applyInstall({ planPath: recovery.path }, existing.dependencies),
    ).resolves.toMatchObject({ status: "installed" });
    expect(existing.hf.calls.filter((call) => call === "setSecrets")).toHaveLength(2);
  });

  it("prompts only for missing fresh-install credentials", async () => {
    const setupResult = await setup();
    setupResult.dependencies.environment = {};
    const prompts: string[] = [];
    setupResult.dependencies.secretInput = {
      async read(name) {
        prompts.push(name);
        return name === "HF_TOKEN"
          ? "prompted-control-placeholder"
          : "prompted-inference-placeholder";
      },
    };
    const bootstrapResult = await bootstrap(setupResult);
    expect(prompts).toEqual([]);
    await expect(complete(setupResult, bootstrapResult.receipt)).resolves.toMatchObject(
      { status: "installed" },
    );
    expect(prompts.sort()).toEqual(["HF_INFERENCE_TOKEN", "HF_TOKEN"]);

    const existing = await setup(REVISION);
    existing.dependencies.environment = {};
    existing.dependencies.secretInput = {
      async read() {
        throw new Error("existing secrets must not prompt");
      },
    };
    await expect(
      applyInstall({ planPath: existing.planPath }, existing.dependencies),
    ).resolves.toMatchObject({ status: "installed" });
  });

  it("verifies authenticated system state only with an explicit bearer", async () => {
    const setupResult = await setup(REVISION);
    alignInstalledStateWithPlan(setupResult);
    setupResult.dependencies.environment = {
      HARBOR_HF_CONTROL_BEARER_TOKEN: "verify-placeholder",
    };
    const result = await verifyInstall(setupResult.planPath, setupResult.dependencies);
    expect(result.authenticated_system).toBe("passed");
    expect(setupResult.http.requests).toContainEqual({
      path: "/api/v1/system",
      bearer: "verify-placeholder",
    });
  });

  it("fails closed on unhealthy anonymous or authenticated projections", async () => {
    const anonymous = await setup(REVISION);
    alignInstalledStateWithPlan(anonymous);
    anonymous.http.readyStatus = "initializing";
    const progress: string[] = [];
    anonymous.dependencies.reportConfigureProgress = (event) => {
      progress.push(event.kind);
    };
    await expect(
      verifyInstall(anonymous.planPath, anonymous.dependencies),
    ).rejects.toThrow("readiness");
    expect(anonymous.http.readyRequestCount).toBe(1);
    expect(progress).toEqual([]);

    const authenticated = await setup(REVISION);
    alignInstalledStateWithPlan(authenticated);
    authenticated.dependencies.environment = {
      HARBOR_HF_CONTROL_BEARER_TOKEN: "verify-placeholder",
    };
    authenticated.http.systemIntegrityError = "integrity-placeholder";
    await expect(
      verifyInstall(authenticated.planPath, authenticated.dependencies),
    ).rejects.toThrow("system verification");
  });

  it("rejects changed bundle content", async () => {
    const setupResult = await setup();
    await writeFile(resolve(setupResult.bundle, "Dockerfile"), "changed\n");
    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("bundle");
  });

  it("requires apply to use the exact compatible CLI version from planning", async () => {
    const setupResult = await setup();
    setupResult.hf.versionValue = "1.25.1";
    await expect(
      applyInstall(
        {
          planPath: setupResult.planPath,
        },
        setupResult.dependencies,
      ),
    ).rejects.toThrow("hf CLI version changed");
  });
});

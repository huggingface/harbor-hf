import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBundleManifest,
  expectedVariables,
  type InstallPlan,
  isSupportedHfCliVersion,
  manifestDigest,
  parseTargetIds,
  readPrivatePlan,
  validateOrigin,
  validatePlan,
  writePrivatePlan,
} from "../model.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "installer-model-test-"));
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

function plan(directory: string): InstallPlan {
  const installId = "f".repeat(64);
  const bundleDigest = manifestDigest([]);
  const variables = expectedVariables(
    "example",
    "example/control-artifacts",
    null,
    "stable-subject",
    "a".repeat(40),
    {
      installId,
      manifestDigest: bundleDigest,
      phase: "installed",
    },
  );
  return {
    schema_version: "harbor-hf.install-plan.v2",
    install_id: installId,
    production_ready: false,
    source: {
      revision: "a".repeat(40),
      repository_root: directory,
    },
    bundle: {
      directory,
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
      organizations: ["example"],
    },
    expected_variables: variables,
    expected_secret_names: ["HF_INFERENCE_TOKEN", "HF_TOKEN"],
    observed_preconditions: {
      namespaceListingsComplete: true,
      space: null,
      bucket: null,
    },
  };
}

describe("installer model", () => {
  it("accepts stable compatible HF CLI versions only", () => {
    for (const version of ["1.23.0", "1.25.1", "1.999.0"]) {
      expect(isSupportedHfCliVersion(version)).toBe(true);
    }
    for (const version of ["1.22.9", "2.0.0", "1.25.1rc1", "1.025.1", "invalid"]) {
      expect(isSupportedHfCliVersion(version)).toBe(false);
    }
  });

  it("validates explicit IDs and defaults the Bucket", () => {
    expect(parseTargetIds("example/control")).toEqual({
      namespace: "example",
      spaceId: "example/control",
      bucketId: "example/control-artifacts",
    });
    expect(
      parseTargetIds("example/control", "example/durable-artifacts").bucketId,
    ).toBe("example/durable-artifacts");
    for (const invalid of [
      "https://huggingface.co/spaces/example-org/control",
      "control",
      "../control",
      "example/control/extra",
    ]) {
      expect(() => parseTargetIds(invalid)).toThrow();
    }
    expect(() =>
      parseTargetIds("example/control", "different/control-artifacts"),
    ).toThrow();
  });

  it("accepts only path-free credential-free HTTPS origins", () => {
    expect(validateOrigin("https://placeholder-control.hf.space")).toBe(
      "https://placeholder-control.hf.space",
    );
    for (const invalid of [
      "http://placeholder-control.hf.space",
      "https://user@placeholder-control.hf.space",
      "https://placeholder-control.hf.space:8443",
      "https://placeholder-control.hf.space/path",
      "https://placeholder-control.hf.space?query=1",
      "https://placeholder-control.hf.space/#fragment",
      "https://placeholder-control.hf.space.example",
      "https://control.example",
    ]) {
      expect(() => validateOrigin(invalid)).toThrow();
    }
  });

  it("writes and reads an owner-only plan with a stable byte digest", async () => {
    const directory = await temporaryDirectory();
    const path = resolve(directory, "install-plan.json");
    const written = await writePrivatePlan(path, plan(directory));
    const loaded = await readPrivatePlan(path);
    expect(loaded.digest).toBe(written.digest);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    await chmod(path, 0o644);
    await expect(readPrivatePlan(path)).rejects.toThrow("owner-only");
  });

  it("rejects legacy plans and invalid install identities", () => {
    const directory = "/state-placeholder";
    const legacy = structuredClone(plan(directory)) as unknown as Record<
      string,
      unknown
    >;
    legacy.schema_version = "harbor-hf.install-plan.v1";
    expect(() => validatePlan(legacy)).toThrow("unsupported install plan");

    const invalidIdentity = plan(directory);
    invalidIdentity.install_id = "not-an-install-id";
    expect(() => validatePlan(invalidIdentity)).toThrow("install ID");
  });

  it("rejects a plan that changes the exact disabled-write contract", async () => {
    const directory = await temporaryDirectory();
    const value = plan(directory);
    value.expected_variables.HARBOR_HF_WRITE_MODE = "enabled";
    expect(() => validatePlan(value)).toThrow("installer contract");
  });

  it("rejects plan symlinks and existing plan paths", async () => {
    const directory = await temporaryDirectory();
    const target = resolve(directory, "target.json");
    const link = resolve(directory, "link.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, link);
    await expect(readPrivatePlan(link)).rejects.toThrow("owner-only");
    await expect(writePrivatePlan(link, plan(directory))).rejects.toThrow("symlink");
    await expect(writePrivatePlan(target, plan(directory))).rejects.toThrow(
      "already exists",
    );
  });

  it("builds a sorted stable complete manifest and detects changes", async () => {
    const directory = await temporaryDirectory();
    await mkdir(resolve(directory, "nested"));
    await writeFile(resolve(directory, "z.txt"), "last\n");
    await writeFile(resolve(directory, "nested", "a.txt"), "first\n");
    const first = await buildBundleManifest(directory);
    const second = await buildBundleManifest(directory);
    expect(first.map((item) => item.path)).toEqual(["nested/a.txt", "z.txt"]);
    expect(second).toEqual(first);
    await writeFile(resolve(directory, "z.txt"), "changed\n");
    expect(manifestDigest(await buildBundleManifest(directory))).not.toBe(
      manifestDigest(first),
    );
  });

  it("rejects bundle symlinks", async () => {
    const directory = await temporaryDirectory();
    await writeFile(resolve(directory, "file"), "content");
    await symlink(resolve(directory, "file"), resolve(directory, "link"));
    await expect(buildBundleManifest(directory)).rejects.toThrow("symlinks");
  });
});

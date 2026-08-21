import { describe, expect, it } from "vitest";
import {
  formatActivationOutput,
  formatConfigureOutput,
  formatPlanOutput,
  formatProvisionOutput,
  parseConfigureOptions,
  parseSavedPlanOptions,
} from "../cli.js";
import { expectedVariables, type InstallPlan, manifestDigest } from "../model.js";

function plan(): InstallPlan {
  const revision = "a".repeat(40);
  const installId = "f".repeat(64);
  const bundleDigest = manifestDigest([]);
  return {
    schema_version: "harbor-hf.install-plan.v2",
    install_id: installId,
    production_ready: false,
    source: {
      revision,
      repository_root: "/repository-placeholder",
    },
    bundle: {
      directory: "/state-placeholder/bundle",
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

describe("installer CLI contract", () => {
  it("locates a saved plan by Space ID with an optional state override", () => {
    expect(parseSavedPlanOptions(["--space", "example/control"])).toEqual({
      space: "example/control",
    });
    expect(
      parseSavedPlanOptions([
        "--space",
        "example/control",
        "--state-dir",
        "/state-placeholder",
      ]),
    ).toEqual({
      space: "example/control",
      stateDirectory: "/state-placeholder",
    });
    for (const obsolete of ["--plan", "--confirm", "--confirm-space"]) {
      expect(() => parseSavedPlanOptions([obsolete, "<obsolete-value>"])).toThrow(
        "invalid command arguments",
      );
    }
  });

  it("requires an explicit flag to replace stored credentials", () => {
    expect(
      parseConfigureOptions(["--space", "example/control", "--replace-credentials"]),
    ).toEqual({
      space: "example/control",
      replaceCredentials: true,
    });
    expect(parseConfigureOptions(["--space", "example/control"])).toEqual({
      space: "example/control",
      replaceCredentials: false,
    });
    expect(() =>
      parseConfigureOptions([
        "--space",
        "example/control",
        "--replace-credentials",
        "--replace-credentials",
      ]),
    ).toThrow("invalid command arguments");
    expect(() =>
      parseSavedPlanOptions(["--space", "example/control", "--replace-credentials"]),
    ).toThrow("invalid command arguments");
  });

  it("prints activation and emergency-disable results", () => {
    expect(
      formatActivationOutput("example/control", {
        production_ready: false,
        space_url: "https://placeholder-control.hf.space",
        write_mode: "enabled",
        runtime: "running",
        authenticated_system: "passed",
      }),
    ).toContain("Campaign submissions and reconciliation are enabled");
    expect(
      formatActivationOutput("example/control", {
        production_ready: false,
        space_url: "https://placeholder-control.hf.space",
        write_mode: "disabled",
        runtime: "paused",
        authenticated_system: "not_required",
      }),
    ).toContain("Writes disabled and Space paused.");
  });

  it("prints a path-free digest-free plan summary and next command", () => {
    const output = formatPlanOutput(plan());
    expect(output).toContain("Space:      example/control");
    expect(output).toContain("Bucket:     example/control-artifacts");
    expect(output).toContain("Write mode: disabled");
    expect(output).toContain("No service credentials are required for bootstrap.");
    expect(output).toContain(
      "Next: npm run install:provision -- --space example/control",
    );
    expect(output).not.toContain("sha256:");
    expect(output).not.toContain("/state-placeholder");
    expect(output).not.toContain("/repository-placeholder");
    expect(formatPlanOutput(plan(), true)).toContain("same --state-dir");
  });

  it("keeps activation separate after a verified installation", () => {
    const output = formatConfigureOutput("example/control", {
      status: "installed",
      verification: {
        production_ready: false,
        space_url: "https://placeholder-control.hf.space",
        anonymous_live: "passed",
        anonymous_ready: "passed",
        authenticated_system: "skipped",
        source_upload_revision: "passed",
      },
    });
    expect(output).toContain("Installation verified.");
    expect(output).toContain("URL: https://placeholder-control.hf.space");
    expect(output).toContain("Write mode: disabled");
    expect(output).toContain("Production ready: no");
    expect(output).toContain("before activation");
  });

  it("explains the successful credential-scoping bootstrap stop", () => {
    const output = formatProvisionOutput({
      status: "credentials_required",
      production_ready: false,
      space_id: "example/control",
      bucket_id: "example/control-artifacts",
      space_paused: true,
      secrets_configured: false,
      source_uploaded: false,
      receipt: {
        schema_version: "harbor-hf.install-bootstrap-receipt.v1",
        install_id: "f".repeat(64),
        plan_digest: `sha256:${"d".repeat(64)}`,
        space_id: "example/control",
        bucket_id: "example/control-artifacts",
        source_revision: "a".repeat(40),
        manifest_digest: `sha256:${"b".repeat(64)}`,
      },
    });
    expect(output).toContain("Provisioning verified.");
    expect(output).toContain("Secrets stored: no");
    expect(output).toContain("Source uploaded: no");
    expect(output).not.toContain("Installation verified.");
    expect(
      formatProvisionOutput(
        {
          status: "credentials_required",
          production_ready: false,
          space_id: "example/control",
          bucket_id: "example/control-artifacts",
          space_paused: true,
          secrets_configured: false,
          source_uploaded: false,
          receipt: {
            schema_version: "harbor-hf.install-bootstrap-receipt.v1",
            install_id: "f".repeat(64),
            plan_digest: `sha256:${"d".repeat(64)}`,
            space_id: "example/control",
            bucket_id: "example/control-artifacts",
            source_revision: "a".repeat(40),
            manifest_digest: `sha256:${"b".repeat(64)}`,
          },
        },
        true,
      ),
    ).toContain("same --state-dir");
  });
});

import { cliMain, defaultDependencies, formatPlanOutput, parseOptions } from "./cli.js";
import {
  activateInstallState,
  assertInstallerStateOutsideRepository,
  discardInstallState,
  findCurrentInstallPlanPath,
  installerStateRoot,
  prepareInstallState,
  preserveBootstrapReceipt,
  withInstallerStateLock,
} from "./state.js";
import { planInstall } from "./workflow.js";

const usage =
  "Usage: npm run install:plan -- --space <namespace>/<space> [--bucket <namespace>/<bucket>] [--state-dir <dir>]\n";

await cliMain(async () => {
  const options = parseOptions(process.argv.slice(2), {
    space: { required: true },
    bucket: { required: false },
    "state-dir": { required: false },
  });
  if (options === "help") {
    process.stdout.write(usage);
    return;
  }
  const space = options.space as string;
  const requestedStateRoot = installerStateRoot(options["state-dir"]);
  const dependencies = defaultDependencies();
  const source = await dependencies.source.inspect();
  const stateRoot = await assertInstallerStateOutsideRepository(
    requestedStateRoot,
    source.repositoryRoot,
  );
  await withInstallerStateLock(space, stateRoot, async () => {
    const previousPlanPath = await findCurrentInstallPlanPath(space, stateRoot);
    const prepared = await prepareInstallState(space, stateRoot);
    let activated = false;
    try {
      const result = await planInstall(
        {
          space,
          ...(options.bucket ? { bucket: options.bucket } : {}),
          bundleDirectory: prepared.bundleDirectory,
          planPath: prepared.planPath,
        },
        dependencies,
      );
      const observedPhase =
        result.plan.observed_preconditions.space?.variables.HARBOR_HF_INSTALL_PHASE;
      await preserveBootstrapReceipt(
        previousPlanPath,
        result.path,
        result.plan,
        result.digest,
        {
          spacePresent: Boolean(result.plan.observed_preconditions.space),
          bucketPresent: Boolean(result.plan.observed_preconditions.bucket),
          phase:
            observedPhase === "credentials_required" ||
            observedPhase === "source_staged" ||
            observedPhase === "installed"
              ? observedPhase
              : null,
        },
      );
      await activateInstallState(prepared, space);
      activated = true;
      process.stdout.write(
        formatPlanOutput(result.plan, Boolean(options["state-dir"])),
      );
    } finally {
      if (!activated) await discardInstallState(prepared);
    }
  });
});

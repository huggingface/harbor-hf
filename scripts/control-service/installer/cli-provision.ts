import {
  cliMain,
  defaultDependencies,
  formatProvisionOutput,
  parseSavedPlanOptions,
} from "./cli.js";
import { locateGitRepositoryRoot } from "./source.js";
import {
  assertInstallerStateOutsideRepository,
  findCurrentInstallPlanPath,
  installerStateRoot,
  readBootstrapReceipt,
  withInstallerStateLock,
  writeBootstrapReceipt,
} from "./state.js";
import { provisionInstall } from "./workflow.js";

const usage =
  "Usage: npm run install:provision -- --space <namespace>/<space> [--state-dir <dir>]\n";

await cliMain(async () => {
  const options = parseSavedPlanOptions(process.argv.slice(2));
  if (options === "help") {
    process.stdout.write(usage);
    return;
  }
  const stateRoot = await assertInstallerStateOutsideRepository(
    installerStateRoot(options.stateDirectory),
    await locateGitRepositoryRoot(),
  );
  const dependencies = defaultDependencies();
  await withInstallerStateLock(options.space, stateRoot, async () => {
    const planPath = await findCurrentInstallPlanPath(options.space, stateRoot);
    if (!planPath) {
      throw new Error("no supported current install plan is available");
    }
    const bootstrapReceipt = await readBootstrapReceipt(planPath);
    const result = await provisionInstall(
      {
        planPath,
        ...(bootstrapReceipt ? { bootstrapReceipt } : {}),
        persistBootstrapReceipt: async (receipt) =>
          await writeBootstrapReceipt(planPath, receipt),
      },
      dependencies,
    );
    if (result.status === "credentials_required") {
      await writeBootstrapReceipt(planPath, result.receipt);
    }
    process.stdout.write(
      formatProvisionOutput(result, Boolean(options.stateDirectory)),
    );
  });
});

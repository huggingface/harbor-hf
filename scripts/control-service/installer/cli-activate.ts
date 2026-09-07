import { withBrowserAuthentication } from "./cli-browser.js";
import {
  cliMain,
  defaultDependencies,
  formatActivationOutput,
  parseSavedPlanOptions,
} from "./cli.js";
import { locateGitRepositoryRoot } from "./source.js";
import {
  assertInstallerStateOutsideRepository,
  currentInstallPlanPath,
  installerStateRoot,
  readBootstrapReceipt,
  withInstallerStateLock,
} from "./state.js";
import { activateInstall } from "./workflow.js";

const usage =
  "Usage: npm run install:activate -- --space <namespace>/<space> [--state-dir <dir>]\n";

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
  await withBrowserAuthentication(dependencies, () =>
    withInstallerStateLock(options.space, stateRoot, async () => {
      const planPath = await currentInstallPlanPath(options.space, stateRoot);
      const receipt = await readBootstrapReceipt(planPath);
      const result = await activateInstall(
        {
          planPath,
          ...(receipt ? { bootstrapReceipt: receipt } : {}),
        },
        dependencies,
      );
      process.stdout.write(formatActivationOutput(options.space, result));
    }),
  );
});

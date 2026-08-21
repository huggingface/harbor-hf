import { cliMain, defaultDependencies, parseSavedPlanOptions } from "./cli.js";
import { locateGitRepositoryRoot } from "./source.js";
import {
  assertInstallerStateOutsideRepository,
  currentInstallPlanPath,
  installerStateRoot,
  withInstallerStateLock,
} from "./state.js";
import { verifyInstall } from "./workflow.js";

const usage =
  "Usage: npm run install:verify -- --space <namespace>/<space> [--state-dir <dir>]\n";

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
    const planPath = await currentInstallPlanPath(options.space, stateRoot);
    const result = await verifyInstall(planPath, dependencies);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });
});

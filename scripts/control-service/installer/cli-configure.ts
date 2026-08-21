import {
  cliMain,
  defaultDependencies,
  formatConfigureOutput,
  parseConfigureOptions,
} from "./cli.js";
import { locateGitRepositoryRoot } from "./source.js";
import {
  assertInstallerStateOutsideRepository,
  currentInstallPlanPath,
  installerStateRoot,
  readBootstrapReceipt,
  withInstallerStateLock,
  writeBootstrapReceipt,
} from "./state.js";
import { configureInstall } from "./workflow.js";

const usage =
  "Usage: npm run install:configure -- --space <namespace>/<space> [--state-dir <dir>] [--replace-credentials]\n";

await cliMain(async () => {
  const options = parseConfigureOptions(process.argv.slice(2));
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
    const bootstrapReceipt = await readBootstrapReceipt(planPath);
    const result = await configureInstall(
      {
        planPath,
        ...(bootstrapReceipt ? { bootstrapReceipt } : {}),
        replaceCredentials: options.replaceCredentials,
        persistBootstrapReceipt: async (receipt) =>
          await writeBootstrapReceipt(planPath, receipt),
      },
      dependencies,
    );
    process.stdout.write(formatConfigureOutput(options.space, result));
  });
});

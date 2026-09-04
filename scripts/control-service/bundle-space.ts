import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const outputArgument = process.argv[2];
if (!outputArgument)
  throw new Error("usage: npm run bundle:space -- <output-directory>");
const output = resolve(outputArgument);
const repository = resolve(import.meta.dirname, "../..");
const status = run("git", [
  "-C",
  repository,
  "status",
  "--porcelain",
  "--untracked-files=no",
]);
if (status)
  throw new Error(
    "tracked worktree changes must be committed before creating a release",
  );
const revision = run("git", ["-C", repository, "rev-parse", "HEAD"]);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const archive = spawnSync(
  "bash",
  ["-c", 'git archive --format=tar HEAD | tar -xf - -C "$1"', "bundle", output],
  { cwd: repository, encoding: "utf8" },
);
if (archive.status !== 0)
  throw new Error(`git archive failed: ${archive.stderr.trim()}`);
await cp(`${output}/deploy/control-space/Dockerfile`, `${output}/Dockerfile`);
await cp(`${output}/deploy/control-space/README.md`, `${output}/README.md`);
const dockerfilePath = `${output}/Dockerfile`;
const dockerfileSource = await readFile(dockerfilePath, "utf8");
const revisionArgument = "ARG HARBOR_HF_SOURCE_REVISION=development";
if (!dockerfileSource.includes(revisionArgument))
  throw new Error("control Space Dockerfile has no source revision argument");
await writeFile(
  dockerfilePath,
  dockerfileSource.replace(
    revisionArgument,
    `ARG HARBOR_HF_SOURCE_REVISION=${revision}`,
  ),
  "utf8",
);
const lock = await readFile(`${output}/package-lock.json`);
const dockerfile = await readFile(dockerfilePath);
await writeFile(
  `${output}/RELEASE.json`,
  `${JSON.stringify({ schema_version: "v1", source_revision: revision, package_lock_digest: digest(lock), dockerfile_digest: digest(dockerfile) }, null, 2)}\n`,
  "utf8",
);
await rm(`${output}/.github`, { recursive: true, force: true });
console.log(JSON.stringify({ output, source_revision: revision }));

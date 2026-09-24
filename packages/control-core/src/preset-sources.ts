import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateAgentPreset, validateBenchmarkPreset } from "@harbor-hf/contracts";

/** A reviewed, immutable location of preset files in one Hugging Face repository. */
export type PresetSourceKindV1 = "dataset" | "model";

export interface PresetSourceV1 {
  /** Canonical `namespace/name` Hub repository. */
  repository: string;
  kind: PresetSourceKindV1;
  /** Exact 40-character Git commit. A branch, tag or short form is refused. */
  revision: string;
  /** Directory inside the repository that holds `agents/` and `benchmarks/`. */
  path: string;
}

/** One preset file as it was read from a pinned source. */
export interface PresetSourceFile {
  path: string;
  content: string;
}

export interface PresetSourceSnapshot {
  source: PresetSourceV1;
  files: readonly PresetSourceFile[];
  /** Stable identity of the exact file set the source provided. */
  digest: string;
}

export interface AgentIdentity {
  agent: string;
  version: string;
}

export interface BenchmarkIdentity {
  benchmark: string;
  preset: string;
}

/** Where external presets came from, for display and audit. */
export interface PresetSourceProvenance {
  repository: string;
  kind: PresetSourceKindV1;
  revision: string;
  path: string;
  digest: string;
  agents: readonly AgentIdentity[];
  benchmarks: readonly BenchmarkIdentity[];
}

export interface PresetRoot {
  /** The root the catalog and the native launch inspection both read. */
  root: string;
  /** The disposable directory holding the merge, or null with no external source. */
  directory: string | null;
  sources: readonly PresetSourceProvenance[];
}

/** Bounded operator configuration; the same repository and directory twice is a mistake. */
export const PRESET_SOURCE_LIMIT = 8;

const repositoryPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const revisionPattern = /^[0-9a-f]{40}$/;
const segmentPattern = "[A-Za-z0-9][A-Za-z0-9._-]*";
const sourcePathPattern = new RegExp(`^${segmentPattern}(/${segmentPattern})*$`);
const presetFilePattern = new RegExp(`^(agents|benchmarks)/${segmentPattern}\\.json$`);
const presetDirectories = ["agents", "benchmarks"] as const;
type PresetDirectory = (typeof presetDirectories)[number];

const bakedOwner = "the repository preset catalog";

/** Parse the operator's preset-source list. Unknown fields and loose pins are refused. */
export function parsePresetSources(value: unknown): PresetSourceV1[] {
  if (!Array.isArray(value))
    throw new Error("Preset sources must be a JSON list of source objects");
  if (value.length > PRESET_SOURCE_LIMIT)
    throw new Error(`Preset sources allow at most ${PRESET_SOURCE_LIMIT} entries`);
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("A preset source must be an object");
    const source = item as Record<string, unknown>;
    for (const key of Object.keys(source))
      if (!["repository", "kind", "revision", "path"].includes(key))
        throw new Error("A preset source has an unknown field");
    const { repository, kind, revision } = source;
    const path = source.path ?? "";
    if (typeof repository !== "string" || !repositoryPattern.test(repository))
      throw new Error("A preset source needs a namespace/name repository");
    if (kind !== "dataset" && kind !== "model")
      throw new Error("A preset source kind must be dataset or model");
    if (typeof revision !== "string" || !revisionPattern.test(revision))
      throw new Error("A preset source needs an exact 40-character commit");
    if (
      typeof path !== "string" ||
      (path !== "" && (path.length > 160 || !sourcePathPattern.test(path)))
    )
      throw new Error("A preset source path must be a relative directory");
    const identity = `${kind}\u0000${repository}\u0000${path}`;
    if (seen.has(identity)) throw new Error("A preset source is configured twice");
    seen.add(identity);
    return { repository, kind, revision, path };
  });
}

interface CandidateFile {
  /** Human-readable owner, used only in error messages. */
  owner: string;
  directory: PresetDirectory;
  name: string;
  content: string;
}

function ownerOf(snapshot: PresetSourceSnapshot): string {
  const { repository, revision, path } = snapshot.source;
  return `${repository}@${revision}${path ? `/${path}` : ""}`;
}

function place(
  owner: string,
  path: string,
): { directory: PresetDirectory; name: string } {
  if (!presetFilePattern.test(path))
    throw new Error(`${owner} returned a preset file outside agents/ and benchmarks/`);
  const separator = path.indexOf("/");
  return {
    directory: path.slice(0, separator) as PresetDirectory,
    name: path.slice(separator + 1),
  };
}

/** Native identity of one preset file, as the preset schemas define it. */
function identify(file: CandidateFile): string {
  let value: unknown;
  try {
    value = JSON.parse(file.content) as unknown;
  } catch {
    throw new Error(`${file.owner} returned invalid JSON in ${file.name}`);
  }
  try {
    if (file.directory === "agents") {
      const preset = validateAgentPreset(value);
      return `agents\u0000${preset.agent}\u0000${preset.version}`;
    }
    const preset = validateBenchmarkPreset(value);
    return `benchmarks\u0000${preset.benchmark}\u0000${preset.preset}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid preset";
    throw new Error(
      `${file.owner} returned an invalid preset in ${file.name}: ${reason}`,
    );
  }
}

async function bakedFiles(root: string): Promise<CandidateFile[]> {
  const files: CandidateFile[] = [];
  for (const directory of presetDirectories) {
    const names = (await readdir(join(root, directory)))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      files.push({
        owner: bakedOwner,
        directory,
        name,
        content: await readFile(join(root, directory, name), "utf8"),
      });
    }
  }
  return files;
}

function entries(identities: readonly string[], prefix: string): string[][] {
  return [...new Set(identities.filter((identity) => identity.startsWith(prefix)))]
    .sort()
    .map((identity) => identity.split("\u0000").slice(1));
}

/**
 * Build the root that the control service and its native launch inspection read. The
 * baked catalog holds the repository presets for popular benchmarks; each snapshot adds
 * the files of one pinned external source. Two owners of one preset identity stop the
 * service instead of silently choosing a winner.
 */
export async function materializePresetRoot(options: {
  bakedRoot: string;
  snapshots: readonly PresetSourceSnapshot[];
  directory: string;
}): Promise<PresetRoot> {
  const { bakedRoot, snapshots, directory } = options;
  const files = await bakedFiles(bakedRoot);
  for (const snapshot of snapshots) {
    const owner = ownerOf(snapshot);
    for (const file of snapshot.files) {
      const { directory: target, name } = place(owner, file.path);
      files.push({ owner, directory: target, name, content: file.content });
    }
  }

  const names = new Map<string, string>();
  for (const file of files) {
    const key = `${file.directory}\u0000${file.name}`;
    const previous = names.get(key);
    if (previous !== undefined && previous !== file.owner)
      throw new Error(`${file.owner} and ${previous} both provide ${file.name}`);
    names.set(key, file.owner);
  }
  const identities = new Map<string, string>();
  for (const file of files) {
    const identity = identify(file);
    const previous = identities.get(identity);
    if (previous !== undefined && previous !== file.owner)
      throw new Error(`${file.owner} and ${previous} both provide the same preset`);
    identities.set(identity, file.owner);
  }

  const sources: PresetSourceProvenance[] = snapshots.map((snapshot) => {
    const owner = ownerOf(snapshot);
    const owned = files.filter((file) => file.owner === owner).map(identify);
    return {
      repository: snapshot.source.repository,
      kind: snapshot.source.kind,
      revision: snapshot.source.revision,
      path: snapshot.source.path,
      digest: snapshot.digest,
      agents: entries(owned, "agents\u0000").map(([agent, version]) => ({
        agent: agent ?? "",
        version: version ?? "",
      })),
      benchmarks: entries(owned, "benchmarks\u0000").map(([benchmark, preset]) => ({
        benchmark: benchmark ?? "",
        preset: preset ?? "",
      })),
    };
  });

  for (const target of presetDirectories) {
    await mkdir(join(directory, target), { recursive: true });
    for (const file of files) {
      if (file.directory !== target) continue;
      await writeFile(join(directory, target, file.name), file.content, "utf8");
    }
  }
  return { root: directory, directory, sources };
}

import { createHash } from "node:crypto";
import type {
  PresetSourceFile,
  PresetSourceSnapshot,
  PresetSourceV1,
} from "@harbor-hf/control-core";

export interface PresetSourceReadOptions {
  accessToken?: string | undefined;
  fetch?: typeof fetch;
  signal?: AbortSignal | undefined;
}

/** A configured preset source could not be read, verified or trusted. */
export class PresetSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetSourceError";
  }
}

const hubOrigin = "https://huggingface.co";
const requestTimeoutMs = 15_000;
/** Bounds on one source, so a wrong repository cannot exhaust the control service. */
const fileLimit = 200;
const fileByteLimit = 262_144;
const totalByteLimit = 2_097_152;
const presetPathPattern = /^(agents|benchmarks)\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

function segments(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function apiUrl(source: PresetSourceV1, suffix: string): URL {
  return new URL(
    `/api/${source.kind}s/${segments(source.repository)}${suffix}`,
    hubOrigin,
  );
}

function treeUrl(source: PresetSourceV1): URL {
  const url = apiUrl(
    source,
    `/tree/${source.revision}${source.path ? `/${segments(source.path)}` : ""}`,
  );
  url.searchParams.set("recursive", "true");
  url.searchParams.set("expand", "false");
  return url;
}

function fileUrl(source: PresetSourceV1, path: string): URL {
  const prefix = source.kind === "dataset" ? "/datasets/" : "/";
  return new URL(
    `${prefix}${segments(source.repository)}/resolve/${source.revision}/${segments(path)}`,
    hubOrigin,
  );
}

async function request(
  url: URL,
  options: PresetSourceReadOptions,
  redirect: RequestRedirect,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "harbor-hf-control/0.1",
  };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  try {
    return await (options.fetch ?? fetch)(url.href, {
      headers,
      redirect,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    throw new PresetSourceError("a preset source could not be reached");
  }
}

async function body(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PresetSourceError(`${label} returned invalid JSON`);
  }
}

/** Read one file as bounded bytes; never trust the declared content length. */
async function readBytes(
  response: Response,
  label: string,
  limit: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit)
    throw new PresetSourceError(`${label} is larger than its size limit`);
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PresetSourceError(`${label} is larger than its size limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Git object identity of the bytes, so resolved content is provably the pinned file. */
function gitBlobId(content: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${content.byteLength}\u0000`)
    .update(content)
    .digest("hex");
}

function filePath(source: PresetSourceV1, path: string, label: string): string {
  const prefix = source.path ? `${source.path}/` : "";
  if (!path.startsWith(prefix))
    throw new PresetSourceError(
      `${label} returned a path outside the source directory`,
    );
  const relative = path.slice(prefix.length);
  if (!presetPathPattern.test(relative))
    throw new PresetSourceError(
      `${label} returned ${relative}, which is not a preset file`,
    );
  return relative;
}

function digestOf(files: readonly PresetSourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path < right.path ? -1 : 1,
  )) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.content);
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Read the preset files of one pinned source. The revision must resolve to itself, every
 * file must match the git object in that revision, and the tree must contain preset files
 * only. A missing, moved or changed source fails here, before any run can use it.
 */
export async function readPresetSource(
  source: PresetSourceV1,
  options: PresetSourceReadOptions = {},
): Promise<PresetSourceSnapshot> {
  const label = `${source.repository}@${source.revision}`;
  const resolved = await request(
    apiUrl(source, `/revision/${source.revision}`),
    options,
    "error",
  );
  if (!resolved.ok)
    throw new PresetSourceError(
      `${label} could not be resolved (HTTP ${resolved.status})`,
    );
  const revision = await body(resolved, label);
  if (
    !revision ||
    typeof revision !== "object" ||
    (revision as { sha?: unknown }).sha !== source.revision
  )
    throw new PresetSourceError(`${label} did not resolve to the requested commit`);

  const listing = await request(treeUrl(source), options, "error");
  if (!listing.ok)
    throw new PresetSourceError(
      `${label} could not be listed (HTTP ${listing.status})`,
    );
  const entries = await body(listing, label);
  if (!Array.isArray(entries))
    throw new PresetSourceError(`${label} returned an invalid file listing`);
  if (entries.length > fileLimit)
    throw new PresetSourceError(`${label} holds more presets than the limit`);

  const files: PresetSourceFile[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object")
      throw new PresetSourceError(`${label} returned an invalid file entry`);
    const value = entry as Record<string, unknown>;
    if (typeof value.path !== "string")
      throw new PresetSourceError(`${label} returned an entry without a path`);
    if (value.type === "directory") {
      const prefix = source.path ? `${source.path}/` : "";
      const relative = value.path.startsWith(prefix)
        ? value.path.slice(prefix.length)
        : value.path;
      if (relative === "agents" || relative === "benchmarks") continue;
      throw new PresetSourceError(`${label} returned an unexpected directory`);
    }
    if (value.type !== "file")
      throw new PresetSourceError(`${label} returned an unsupported entry`);
    if (typeof value.size !== "number" || value.size > fileByteLimit)
      throw new PresetSourceError(
        `${label} returned a preset larger than its size limit`,
      );
    if (typeof value.oid !== "string" || !/^[0-9a-f]{40}$/.test(value.oid))
      throw new PresetSourceError(`${label} returned a preset without a git identity`);
    const path = filePath(source, value.path, label);
    const response = await request(fileUrl(source, value.path), options, "follow");
    if (!response.ok || new URL(response.url).origin !== hubOrigin)
      throw new PresetSourceError(`${label} could not return ${path}`);
    const pinned = await readBytes(response, `${label}/${path}`, fileByteLimit);
    if (gitBlobId(pinned) !== value.oid)
      throw new PresetSourceError(`${label}/${path} does not match its pinned commit`);
    total += pinned.byteLength;
    if (total > totalByteLimit)
      throw new PresetSourceError(`${label} holds more preset data than the limit`);
    files.push({ path, content: pinned.toString("utf8") });
  }
  if (files.length === 0) throw new PresetSourceError(`${label} holds no preset files`);
  return { source, files, digest: digestOf(files) };
}

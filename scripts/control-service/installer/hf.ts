import type { BucketState, RemoteState, SpaceState } from "./model.js";
import { isSupportedHfCliVersion, validateOrigin } from "./model.js";
import {
  type ProcessAdapter,
  ProcessFailure,
  type ProviderFailureCategory,
} from "./process.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;

export class HfCommandFailure extends Error {
  constructor(readonly category: ProviderFailureCategory) {
    super(`Hugging Face command failed: ${category}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("unexpected Hugging Face JSON object");
  for (const key of ["data", "item", "result"]) {
    const nested = value[key];
    if (isRecord(nested)) return nested;
  }
  return value;
}

function stringAt(
  record: Record<string, unknown>,
  paths: readonly (readonly string[])[],
): string | null {
  for (const path of paths) {
    let current: unknown = record;
    for (const part of path) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (typeof current === "string" && current.length > 0) return current;
  }
  return null;
}

function booleanAt(
  record: Record<string, unknown>,
  paths: readonly (readonly string[])[],
): boolean | null {
  for (const path of paths) {
    let current: unknown = record;
    for (const part of path) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (typeof current === "boolean") return current;
  }
  return null;
}

function listEnvelope(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown>[] {
  let items: unknown = value;
  if (isRecord(value)) {
    const next = value.next ?? value.next_cursor ?? value.cursor;
    if (next !== undefined && next !== null && next !== "") {
      throw new Error("namespace listing is paginated");
    }
    items = keys.map((key) => value[key]).find((item) => Array.isArray(item));
  }
  if (!Array.isArray(items) || items.some((item) => !isRecord(item))) {
    throw new Error("unexpected Hugging Face list JSON");
  }
  return items as Record<string, unknown>[];
}

function exactId(record: Record<string, unknown>): string {
  const id = stringAt(record, [["id"], ["repo_id"], ["repoId"], ["name"]]);
  if (!id) throw new Error("Hugging Face object has no ID");
  return id.replace(/^spaces\//, "").replace(/^hf:\/\/buckets\//, "");
}

function originFromMetadata(record: Record<string, unknown>): string {
  const explicit = stringAt(record, [
    ["origin"],
    ["runtime", "url"],
    ["runtime", "appUrl"],
    ["host"],
  ]);
  if (explicit) {
    try {
      return validateOrigin(explicit);
    } catch {
      // Continue to the authenticated Space subdomain.
    }
  }
  const subdomain = stringAt(record, [["subdomain"], ["runtime", "subdomain"]]);
  if (!subdomain) throw new Error("Space metadata has no public origin");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    throw new Error("Space metadata has an invalid subdomain");
  }
  return validateOrigin(`https://${subdomain}.hf.space`);
}

function parseVariables(value: unknown): Record<string, string> {
  if (isRecord(value)) {
    for (const key of ["variables", "items", "data"]) {
      if (Array.isArray(value[key])) return parseVariables(value[key]);
      if (isRecord(value[key])) return parseVariables(value[key]);
    }
    const entries = Object.entries(value);
    if (entries.every(([, item]) => typeof item === "string")) {
      return Object.fromEntries(entries as [string, string][]);
    }
  }
  if (!Array.isArray(value)) {
    throw new Error("unexpected Space variables JSON");
  }
  const output: Record<string, string> = {};
  for (const item of value) {
    if (!isRecord(item)) throw new Error("unexpected Space variable");
    const key = stringAt(item, [["key"], ["name"]]);
    const variableValue = stringAt(item, [["value"]]);
    if (!key || variableValue === null || key in output) {
      throw new Error("unexpected Space variable");
    }
    output[key] = variableValue;
  }
  return output;
}

function parseSecretNames(value: unknown): string[] {
  if (isRecord(value)) {
    for (const key of ["secrets", "items", "data"]) {
      if (Array.isArray(value[key]) || isRecord(value[key])) {
        return parseSecretNames(value[key]);
      }
    }
    return Object.keys(value).sort();
  }
  if (!Array.isArray(value)) throw new Error("unexpected Space secrets JSON");
  const names = value.map((item) => {
    if (typeof item === "string") return item;
    if (!isRecord(item)) throw new Error("unexpected Space secret");
    const name = stringAt(item, [["key"], ["name"]]);
    if (!name) throw new Error("unexpected Space secret");
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("duplicate Space secret name");
  }
  return names.sort();
}

function assertMutation(value: unknown, expectedId?: string): void {
  if (value === true) return;
  if (typeof value === "string" && value.length > 0) {
    if (expectedId && value.includes("/") && value !== expectedId) {
      throw new Error("Hugging Face mutation returned a different target");
    }
    return;
  }
  if (!isRecord(value)) throw new Error("unexpected Hugging Face mutation JSON");
  if (value.success === false || value.ok === false) {
    throw new Error("Hugging Face mutation was not successful");
  }
  const id = stringAt(value, [
    ["id"],
    ["repo_id"],
    ["repoId"],
    ["bucket_id"],
    ["space_id"],
  ]);
  if (
    id &&
    expectedId &&
    id.replace(/^spaces\//, "").replace(/^hf:\/\/buckets\//, "") !== expectedId
  ) {
    throw new Error("Hugging Face mutation returned a different target");
  }
  if (
    value.success !== true &&
    value.ok !== true &&
    !id &&
    !stringAt(value, [
      ["url"],
      ["sha"],
      ["commit_hash"],
      ["commitHash"],
      ["status"],
      ["message"],
    ])
  ) {
    throw new Error("unexpected Hugging Face mutation JSON");
  }
}

function assertBucketCreation(value: unknown, bucketId: string): void {
  const record = unwrapRecord(value);
  const uri = stringAt(record, [["uri"]]);
  const urlValue = stringAt(record, [["url"]]);
  if (uri !== `hf://buckets/${bucketId}` || !urlValue) {
    throw new Error("Bucket creation returned an unexpected target");
  }
  const url = new URL(urlValue);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "huggingface.co" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/buckets/${bucketId}`
  ) {
    throw new Error("Bucket creation returned an unexpected target");
  }
}

export interface HfAdapter {
  version(): Promise<string>;
  whoamiUsername(): Promise<string>;
  authToken(): Promise<string>;
  observe(namespace: string, spaceId: string, bucketId: string): Promise<RemoteState>;
  createSpace(
    spaceId: string,
    variablesFile: string,
    secretsFile?: string,
  ): Promise<void>;
  createBucket(bucketId: string, authenticatedUsername: string): Promise<void>;
  setVariables(spaceId: string, variablesFile: string): Promise<void>;
  setSecrets(spaceId: string, secretsFile: string): Promise<void>;
  setProtected(spaceId: string): Promise<void>;
  uploadMirror(
    spaceId: string,
    bundleDirectory: string,
    revision: string,
  ): Promise<string>;
  wait(spaceId: string): Promise<void>;
  pause(spaceId: string): Promise<void>;
  restart(spaceId: string): Promise<void>;
}

export class HfCli implements HfAdapter {
  constructor(private readonly processAdapter: ProcessAdapter) {}

  private async json(
    args: readonly string[],
    options: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<unknown> {
    try {
      return await this.processAdapter.runJson({
        command: "hf",
        args: [...args, "--format", "json"],
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxStdoutBytes: options.maxBytes ?? DEFAULT_OUTPUT_BYTES,
        maxStderrBytes: 256 * 1024,
      });
    } catch (error) {
      if (error instanceof ProcessFailure && error.providerCategory) {
        throw new HfCommandFailure(error.providerCategory);
      }
      throw error;
    }
  }

  async version(): Promise<string> {
    const value = unwrapRecord(await this.json(["version"]));
    const version = stringAt(value, [["version"]]);
    if (!version || !isSupportedHfCliVersion(version)) {
      throw new Error("hf CLI >=1.23.0 and <2.0.0 is required");
    }
    return version;
  }

  async whoamiUsername(): Promise<string> {
    const value = unwrapRecord(await this.json(["auth", "whoami"]));
    const username = stringAt(value, [
      ["name"],
      ["username"],
      ["user"],
      ["user", "name"],
    ]);
    if (!username) throw new Error("hf auth whoami has no username");
    return username;
  }

  async authToken(): Promise<string> {
    return await this.processAdapter.runSecretText({
      command: "hf",
      args: ["auth", "token"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
    });
  }

  async observe(namespace: string, spaceId: string, bucketId: string) {
    const spacesJson = await this.json([
      "spaces",
      "list",
      "--author",
      namespace,
      "--limit",
      "10001",
      "--expand",
      "private,sdk,sha,runtime,subdomain",
    ]);
    const spaceItems = listEnvelope(spacesJson, ["spaces", "items", "data"]);
    if (spaceItems.length >= 10001) {
      throw new Error("Space namespace listing exceeds completeness bound");
    }
    const matchingSpaces = spaceItems.filter((item) => exactId(item) === spaceId);
    if (matchingSpaces.length > 1) throw new Error("duplicate Space target");

    const bucketsJson = await this.json(["buckets", "list", namespace]);
    const bucketItems = listEnvelope(bucketsJson, ["buckets", "items", "data"]);
    const matchingBuckets = bucketItems.filter((item) => exactId(item) === bucketId);
    if (matchingBuckets.length > 1) throw new Error("duplicate Bucket target");

    let space: SpaceState | null = null;
    if (matchingSpaces.length === 1) {
      const info = unwrapRecord(
        await this.json([
          "spaces",
          "info",
          spaceId,
          "--expand",
          "private,sdk,sha,runtime,subdomain",
        ]),
      );
      if (exactId(info) !== spaceId) throw new Error("Space info ID mismatch");
      const isPrivate = booleanAt(info, [["private"], ["source", "private"]]);
      const sdk = stringAt(info, [["sdk"], ["space_sdk"], ["cardData", "sdk"]]);
      if (isPrivate === null || !sdk) {
        throw new Error("Space metadata is incomplete");
      }
      space = {
        id: spaceId,
        private: isPrivate,
        sdk: sdk.toLowerCase(),
        origin: originFromMetadata(info),
        sha: stringAt(info, [["sha"], ["revision"]]),
        runtimeStage: stringAt(info, [
          ["runtime", "stage"],
          ["runtime", "status"],
          ["stage"],
        ]),
        hardware: stringAt(info, [
          ["runtime", "hardware", "current"],
          ["runtime", "hardware"],
          ["hardware"],
          ["flavor"],
        ]),
        requestedHardware: stringAt(info, [
          ["runtime", "requested_hardware"],
          ["runtime", "requestedHardware"],
          ["runtime", "hardware", "requested"],
          ["requested_hardware"],
          ["requestedHardware"],
        ]),
        variables: parseVariables(
          await this.json(["spaces", "variables", "list", spaceId]),
        ),
        secretNames: parseSecretNames(
          await this.json(["spaces", "secrets", "list", spaceId]),
        ),
      };
    }

    let bucket: BucketState | null = null;
    if (matchingBuckets.length === 1) {
      const info = unwrapRecord(await this.json(["buckets", "info", bucketId]));
      if (exactId(info) !== bucketId) throw new Error("Bucket info ID mismatch");
      const isPrivate = booleanAt(info, [["private"], ["is_private"]]);
      if (isPrivate === null) throw new Error("Bucket metadata is incomplete");
      bucket = { id: bucketId, private: isPrivate };
    }
    return {
      namespaceListingsComplete: true,
      space,
      bucket,
    } satisfies RemoteState;
  }

  async createSpace(
    spaceId: string,
    variablesFile: string,
    secretsFile?: string,
  ): Promise<void> {
    const args = [
      "repos",
      "create",
      spaceId,
      "--type",
      "space",
      "--sdk",
      "docker",
      "--protected",
      "--flavor",
      "cpu-basic",
      "--no-exist-ok",
      "--env-file",
      variablesFile,
      ...(secretsFile ? ["--secrets-file", secretsFile] : []),
    ];
    const value = await this.json(args);
    assertMutation(value, spaceId);
  }

  async createBucket(bucketId: string, authenticatedUsername: string): Promise<void> {
    const separator = bucketId.indexOf("/");
    const namespace = bucketId.slice(0, separator);
    const name = bucketId.slice(separator + 1);
    const createId = namespace === authenticatedUsername ? name : bucketId;
    assertBucketCreation(
      await this.json(["buckets", "create", createId, "--private"]),
      bucketId,
    );
  }

  async setVariables(spaceId: string, variablesFile: string): Promise<void> {
    assertMutation(
      await this.json([
        "spaces",
        "variables",
        "add",
        spaceId,
        "--env-file",
        variablesFile,
      ]),
      spaceId,
    );
  }

  async setSecrets(spaceId: string, secretsFile: string): Promise<void> {
    assertMutation(
      await this.json([
        "spaces",
        "secrets",
        "add",
        spaceId,
        "--secrets-file",
        secretsFile,
      ]),
      spaceId,
    );
  }

  async setProtected(spaceId: string): Promise<void> {
    assertMutation(
      await this.json([
        "repos",
        "settings",
        spaceId,
        "--repo-type",
        "space",
        "--protected",
      ]),
      spaceId,
    );
  }

  async uploadMirror(
    spaceId: string,
    bundleDirectory: string,
    revision: string,
  ): Promise<string> {
    const value = await this.json(
      [
        "upload",
        spaceId,
        bundleDirectory,
        ".",
        "--repo-type",
        "space",
        "--delete",
        "*",
        "--commit-message",
        `Install source ${revision}`,
      ],
      { timeoutMs: 10 * 60_000 },
    );
    assertMutation(value, spaceId);
    if (typeof value === "string" && /^[a-f0-9]{40}$/.test(value)) return value;
    const record = unwrapRecord(value);
    let sha = stringAt(record, [["sha"], ["commit_hash"], ["commitHash"], ["oid"]]);
    if (!sha) {
      const uploadUrl = stringAt(record, [["url"]]);
      if (uploadUrl) {
        const url = new URL(uploadUrl);
        const escapedSpaceId = spaceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = url.pathname.match(
          new RegExp(`^/spaces/${escapedSpaceId}/commit/([a-f0-9]{40})$`),
        );
        if (
          url.protocol === "https:" &&
          url.hostname === "huggingface.co" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          match
        ) {
          sha = match[1] ?? null;
        }
      }
    }
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error("Space upload returned no commit SHA");
    }
    return sha;
  }

  async wait(spaceId: string): Promise<void> {
    const value = await this.json(["spaces", "wait", spaceId, "--timeout", "10m"], {
      timeoutMs: 11 * 60_000,
    });
    assertMutation(value, spaceId);
  }

  async pause(spaceId: string): Promise<void> {
    assertMutation(await this.json(["spaces", "pause", spaceId]), spaceId);
  }

  async restart(spaceId: string): Promise<void> {
    assertMutation(await this.json(["spaces", "restart", spaceId]), spaceId);
  }
}

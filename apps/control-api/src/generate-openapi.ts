import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = await mkdtemp(join(tmpdir(), "harbor-hf-openapi-"));
const bucket = join(scratch, "bucket");
await mkdir(bucket, { recursive: true });
const config: AppConfig = {
  node_env: "test",
  port: 7860,
  namespace: "example",
  bucket_id: "example/artifacts",
  bucket_root: bucket,
  store_mode: "filesystem",
  projection_path: join(scratch, "projection.sqlite"),
  auth_path: join(scratch, "auth.sqlite"),
  profiles_root: join(repository, "profiles"),
  web_root: join(scratch, "web"),
  auth_mode: "development",
  write_mode: "disabled",
  public_origin: "http://127.0.0.1:7860",
  oauth: null,
  hf_token: null,
  reconcile_interval_ms: 1000,
  observe_interval_ms: 1000,
  worker_receipt_grace_ms: 0,
  source_revision: "development",
  bootstrap_operator_subjects: [],
};
const runtime = await createRuntime(config);
const app = await buildApp(runtime);
try {
  await runtime.initialize();
  await app.ready();
  const document = app.swagger();
  const documentPath = join(repository, "docs", "control-api-v1.openapi.json");
  await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const generated = astToString(await openapiTS(document as unknown as OpenAPI3));
  const outputPath = join(
    repository,
    "apps",
    "control-web",
    "src",
    "generated",
    "api.ts",
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
} finally {
  await app.close();
  await runtime.close();
  await rm(scratch, { recursive: true, force: true });
}

import {
  type BenchmarkCatalogV1,
  canonicalJson,
  type ReviewedBenchmarkConfig,
  sha256,
  validateBenchmarkCatalog,
} from "@harbor-hf/contracts";
import { createJson, type ImmutableObjectStore } from "./store.js";

export type { ReviewedBenchmarkConfig } from "@harbor-hf/contracts";
export const benchmarkCatalogPrefix = "control/schema=v1/workbench/benchmarks/";

export interface ResolvedBenchmarkConfig extends ReviewedBenchmarkConfig {
  revision: string;
}

const reviewedBenchmarkConfigs: readonly ReviewedBenchmarkConfig[] = [
  {
    size: "small",
    name: "tb21-gpt-oss-20b-canary",
    label: "Terminal-Bench 2.1 canary · GPT-OSS 20B",
    description:
      "Two reviewed Terminal-Bench 2.1 canary tasks with direct chat-completions inference and diagnostic publication.",
    benchmark: "terminal-bench-2-1-canary",
    model: "gpt-oss-20b-together",
    harness_template: "fast-agent-0-10-16-command",
    deployment: "tb21-gpt-oss-20b-fast-agent-command-providers",
    launch_policy: "diagnostic-single-attempt",
    default_ceiling_microusd: 1_000_000,
    max_ceiling_microusd: 1_000_000,
    harness_policy: {
      type: "workbench",
      inference_apis: ["chat-completions"],
      require_trajectory: false,
    },
  },
];

function withRevision(config: ReviewedBenchmarkConfig): ResolvedBenchmarkConfig {
  return {
    ...structuredClone(config),
    revision: sha256(canonicalJson(config)),
  };
}

export async function initializeBenchmarkCatalog(
  store: ImmutableObjectStore,
): Promise<void> {
  if ((await store.list(benchmarkCatalogPrefix)).length) return;
  await createJson(store, `${benchmarkCatalogPrefix}0000000000.json`, {
    schema_version: "v1",
    version: 0,
    items: reviewedBenchmarkConfigs,
  });
}

export async function listReviewedBenchmarkConfigs(
  store: ImmutableObjectStore,
): Promise<ResolvedBenchmarkConfig[]> {
  const entries = await store.list(benchmarkCatalogPrefix);
  const keys = entries.map((entry) => entry.key).sort();
  if (!keys.length) throw new Error("benchmark catalog is not initialized");
  for (const key of keys) {
    if (!/^control\/schema=v1\/workbench\/benchmarks\/[0-9]{10}\.json$/.test(key))
      throw new Error("unexpected benchmark catalog object");
  }
  const key = keys[keys.length - 1];
  if (!key) throw new Error("benchmark catalog is missing");
  const catalog = validateBenchmarkCatalog<BenchmarkCatalogV1>(
    JSON.parse(new TextDecoder().decode(await store.read(key))),
  );
  if (
    key !== `${benchmarkCatalogPrefix}${String(catalog.version).padStart(10, "0")}.json`
  )
    throw new Error("benchmark catalog version does not match its key");
  if (new Set(catalog.items.map((item) => item.name)).size !== catalog.items.length)
    throw new Error("benchmark catalog names must be unique");
  for (const item of catalog.items) {
    if (item.default_ceiling_microusd > item.max_ceiling_microusd)
      throw new Error("benchmark default ceiling exceeds maximum");
  }
  return catalog.items.map(withRevision);
}

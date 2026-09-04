/* Generated from JSON Schema. Do not edit. */

export type ResultCatalogId = string
export type ResultCatalogDigest = string
export type NullableString = (string | null)

export interface HarborHFResultCatalogV1 {
schema_version: "v1"
kind: "result.catalog"
record_id: ResultCatalogId
created_at: string
source_digest: ResultCatalogDigest
/**
 * @maxItems 10000
 */
entries: Entry[]
}
export interface Entry {
publication_id: ResultCatalogId
run_id: ResultCatalogId
published_at: string
observed_microusd?: number
benchmark: NullableString
model: NullableString
harness: NullableString
inference_provider: NullableString
run_outcome: string
quality: ("clean" | "degraded")
publication_role: ("final" | "component" | "diagnostic")
task_count: number
scored_task_count: number
strict_pass_count: (number | null)
primary_metric: (PrimaryMetric | null)
result_path: string
}
export interface PrimaryMetric {
name: string
value: number
unit: string
}

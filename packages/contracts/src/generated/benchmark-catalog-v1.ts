/* Generated from JSON Schema. Do not edit. */

export interface BenchmarkCatalogV1 {
schema_version: "v1"
version: number
/**
 * @maxItems 1000
 */
items: ReviewedBenchmarkConfig[]
}
export interface ReviewedBenchmarkConfig {
name: string
benchmark: string
model: string
harness_template: string
deployment: string
launch_policy: string
label: string
description: string
default_ceiling_microusd: number
max_ceiling_microusd: number
size: ("small" | "medium" | "large")
harness_policy: {
type: "workbench"
/**
 * @minItems 1
 */
inference_apis: [("chat-completions" | "responses"), ...(("chat-completions" | "responses"))[]]
require_trajectory: boolean
}
}

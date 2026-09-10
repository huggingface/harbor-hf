/* Generated from JSON Schema. Do not edit. */

export interface InferenceBindingsV1 {
schema_version: "v1"
/**
 * @maxItems 64
 */
bindings: {
ref: string
label: string
status: ("configured" | "missing" | "disabled")
source_env: string
enabled: boolean
/**
 * @maxItems 64
 */
grants: {
/**
 * @maxItems 64
 */
operator_subjects: string[]
worker_image: string
agent_import_path: string
recipe_digest: string
/**
 * @maxItems 64
 */
destination_env: string[]
route_api: ("chat-completions" | "responses" | "native")
base_url: (string | null)
/**
 * @maxItems 64
 */
allowed_hosts: string[]
/**
 * @minItems 1
 * @maxItems 64
 */
allowed_models: [string, ...(string)[]]
}[]
}[]
revision: number
}

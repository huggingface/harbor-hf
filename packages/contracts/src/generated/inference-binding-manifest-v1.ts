/* Generated from JSON Schema. Do not edit. */

export interface InferenceBindingManifestV1 {
schema_version: "v1"
/**
 * @maxItems 64
 */
bindings: {
ref: string
source_env: string
label: string
enabled: boolean
/**
 * @maxItems 64
 */
uses: {
/**
 * @maxItems 64
 */
operator_subjects: string[]
worker_image: string
agent_import_path: string
/**
 * Reviewed Workbench recipe identity
 */
recipe_digest?: string
/**
 * Reviewed native agent preset version
 */
agent_version?: string
/**
 * @maxItems 64
 */
destination_env: string[]
route_api?: ("chat-completions" | "responses" | "native")
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
/**
 * Native Harbor agent argument value that selects the wire API style
 */
model_api?: string
}[]
}[]
}

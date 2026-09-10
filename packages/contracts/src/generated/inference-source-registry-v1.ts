/* Generated from JSON Schema. Do not edit. */

export interface InferenceSourceRegistryV1 {
schema_version: "v1"
revision: number
/**
 * @maxItems 64
 */
entries: {
ref: string
source_env: string
label: string
registration: {
revision: number
actor: string
at: string
reason: string
}
/**
 * @maxItems 256
 */
history: ({
revision: number
actor: string
at: string
reason: string
kind: "status"
enabled: boolean
} | {
revision: number
actor: string
at: string
reason: string
kind: "approve"
grant: {
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
}
})[]
}[]
}

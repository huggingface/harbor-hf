/* Generated from JSON Schema. Do not edit. */

export type EnvironmentBinding = ({
[k: string]: unknown
} & {
name: string
source: ("literal" | "instruction_path" | "workspace_path" | "logs_path" | "agent_home" | "model_name" | "model_base_url" | "model_api_key")
value?: string
credential_ref?: string
})

export interface InferenceReviewV1 {
schema_version: "v1"
revision: number
review_id: string
expires_at: string
ref: string
source_env: string
label: string
presence: ("configured" | "missing")
recipe: AgentWorkbenchRecipeV1
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
}
export interface AgentWorkbenchRecipeV1 {
schema_version: "v1"
name: string
setup_command: string
run_command: string
route_api: ("chat-completions" | "responses" | "native")
setup_timeout_seconds: number
/**
 * @maxItems 64
 */
environment: EnvironmentBinding[]
outputs: OutputDeclaration
}
export interface OutputDeclaration {
results_path: string
trajectory_path: (string | null)
}

/* Generated from JSON Schema. Do not edit. */

export type EnvironmentBinding = ({
[k: string]: unknown
} & {
name: string
source: ("literal" | "instruction_path" | "workspace_path" | "logs_path" | "agent_home" | "model_name" | "model_base_url" | "model_api_key")
value?: string
credential_ref?: string
})

export interface InferenceReviewRequestV1 {
expected_revision: number
recipe: AgentWorkbenchRecipeV1
model_name: string
base_url: (string | null)
/**
 * @maxItems 64
 */
allowed_hosts: string[]
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

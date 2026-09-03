/* Generated from JSON Schema. Do not edit. */

export interface AgentWorkbenchRecipeV1 {
schema_version: "v1"
name: string
setup_command: string
run_command: string
route_api: ("chat-completions" | "responses")
setup_timeout_seconds: number
/**
 * @maxItems 64
 */
environment: EnvironmentBinding[]
outputs: OutputDeclaration
}
export interface EnvironmentBinding {
name: string
source: ("literal" | "instruction_path" | "workspace_path" | "logs_path" | "agent_home" | "model_name" | "model_base_url" | "model_api_key")
value?: string
}
export interface OutputDeclaration {
results_path: string
trajectory_path: (string | null)
}

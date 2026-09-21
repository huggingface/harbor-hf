/* Generated from JSON Schema. Do not edit. */

export type AgentPresetSlug = string

export interface AgentPresetV1 {
schema_version: "v1"
agent: AgentPresetSlug
version: string
harbor_agent: {
[k: string]: unknown
}
reasoning_option: (string | null)
/**
 * @minItems 1
 */
reasoning_values: [string, ...(string)[]]
}

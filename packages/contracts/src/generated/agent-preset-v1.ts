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
 * How this preset consumes a reviewed endpoint connection
 */
endpoint_api?: {
/**
 * Adapter option that selects the wire API style
 */
option: string
/**
 * Reviewed wire API to adapter option value
 */
api: {
"chat-completions"?: string
responses?: string
native?: string
}
}
/**
 * @minItems 1
 */
reasoning_values: [string, ...(string)[]]
}

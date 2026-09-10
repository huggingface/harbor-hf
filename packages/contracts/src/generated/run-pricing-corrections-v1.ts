/* Generated from JSON Schema. Do not edit. */

export interface RunPricingCorrectionsV1 {
schema_version: "v1"
run_id: string
/**
 * @minItems 1
 * @maxItems 1000
 */
revisions: [{
revision: number
actor: string
updated_at: string
reason: string
pricing: LaunchPricingV1
}, ...({
revision: number
actor: string
updated_at: string
reason: string
pricing: LaunchPricingV1
})[]]
}
export interface LaunchPricingV1 {
currency: "USD"
input_usd_per_million: number
output_usd_per_million: number
cached_usd_per_million: number
}

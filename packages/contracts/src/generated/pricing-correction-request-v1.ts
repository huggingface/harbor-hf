/* Generated from JSON Schema. Do not edit. */

export interface PricingCorrectionRequestV1 {
expected_revision: number
reason: string
pricing: LaunchPricingV1
}
export interface LaunchPricingV1 {
currency: "USD"
input_usd_per_million: number
output_usd_per_million: number
cached_usd_per_million: number
}

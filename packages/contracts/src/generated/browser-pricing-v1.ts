/* Generated from JSON Schema. Do not edit. */

/**
 * Origin-local display preferences only. Never a server or Bucket record.
 */
export interface BrowserPricingV1 {
schema_version: "v1"
selected_id: (string | null)
tier: ("standard" | "longContext")
/**
 * @maxItems 50
 */
scenarios: {
id: string
name: string
standard: Rates
longContext: Rates
threshold: number
}[]
}
export interface Rates {
input: (number | null)
output: (number | null)
cached: (number | null)
}

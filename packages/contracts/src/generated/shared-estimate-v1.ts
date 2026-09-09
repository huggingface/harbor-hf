/* Generated from JSON Schema. Do not edit. */

export type Basis = ("launch_rates_reported_usage" | "corrected_rates_reported_usage" | "effective_rates_reported_usage")
export type Cost = (number | null)

export interface SharedEstimateV1 {
basis: Basis
cost_usd: Cost
unavailable_reason: ("correction_history_unavailable" | "pricing_unset" | "usage_unavailable" | null)
}

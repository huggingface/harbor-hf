/* Generated from JSON Schema. Do not edit. */

export interface LeaderboardRowV1 {
benchmark: string
preset: string
agent: string
agent_version: string
model: string
provider: string
reasoning_effort: string
n_attempts: number
n_trials: number
pass_rate: number
cost_usd: (number | null)
shared_estimate?: LaunchEstimateGroupV1
}
export interface LaunchEstimateGroupV1 {
basis: ("launch_rates_reported_usage" | "corrected_rates_reported_usage" | "effective_rates_reported_usage")
cost_usd: (number | null)
estimated_runs: number
total_runs: number
}

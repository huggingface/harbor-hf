/* Generated from JSON Schema. Do not edit. */

export type RunSubmissionV1 = ({
benchmark?: Alias
model?: Alias
harness: (Alias | WorkbenchHarness)
deployment?: (Alias | null)
launch_policy?: Alias
benchmark_config?: Alias
benchmark_config_revision?: RunSubmissionDigest
ceiling_microusd: number
confirmed: boolean
start_paused?: boolean
} & ({
benchmark: Alias
model: Alias
harness?: Alias
launch_policy: Alias
benchmark_config?: never
benchmark_config_revision?: never
[k: string]: unknown
} | {
benchmark_config: Alias
benchmark_config_revision: RunSubmissionDigest
harness?: WorkbenchHarness
benchmark?: never
model?: never
deployment?: never
launch_policy?: never
[k: string]: unknown
}))
export type Alias = string
export type RunSubmissionDigest = string

export interface WorkbenchHarness {
type: "workbench"
recipe: {
[k: string]: unknown
}
setup_test_id: string
}

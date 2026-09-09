/* Generated from JSON Schema. Do not edit. */

export interface TrialProgressV1 {
observed_at: string
jobs_observed_at: (string | null)
lock: ({
trials: {
task: {
name: string
digest: string
}
}[]
} | null)
trials: {
trial_name: string
config: ({
trial_name?: string
} | null)
lock: ({
task: {
name: string
digest: string
}
} | null)
result: ({
trial_name?: string
task_name?: string
task_checksum?: string
started_at?: (string | null)
finished_at?: (string | null)
exception_info?: ({
exception_type: string
} | null)
agent_execution?: ({
started_at?: (string | null)
finished_at?: (string | null)
} | null)
step_results?: ({
agent_execution?: ({
started_at?: (string | null)
finished_at?: (string | null)
} | null)
}[] | null)
} | null)
reward: (number | null)
cost_usd: (number | null)
}[]
jobs: {
id: string
run_id: string
role: ("parent" | "trial")
stage: ("queued" | "running" | "stopped" | "error")
created_at: string
started_at: (string | null)
finished_at: (string | null)
}[]
}

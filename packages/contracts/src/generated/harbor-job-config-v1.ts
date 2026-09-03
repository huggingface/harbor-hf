/* Generated from JSON Schema. Do not edit. */

export type AgentSetupTimeoutMultiplier = (number | null)
export type AgentTimeoutMultiplier = (number | null)
/**
 * Optional shared concurrency pool name for agent configs that should use the same n_concurrent limit.
 */
export type ConcurrencyGroup = (string | null)
/**
 * Glob patterns of agent log files to skip when downloading. Applied after include_logs, so exclude wins on overlap.
 */
export type ExcludeLogs = string[]
/**
 * Run-specific hostnames or IP addresses merged into the effective agent phase allowlist during agent.run() only.
 */
export type ExtraAllowedHosts = string[]
export type ImportPath = (string | null)
/**
 * Glob patterns of agent log files to download, relative to the agent logs directory. When set, only matching files are kept.
 */
export type IncludeLogs = string[]
/**
 * Path to a trajectory to load as the agent's session before the first step, which then resumes it instead of starting fresh. A .jsonl file is the agent's native session format (lossless, same agent only; capabilities.load_native_trajectory); a .json file is an ATIF trajectory converted to the agent's native format (portable across supported agents; capabilities.load_atif_trajectory). The trial fails fast if the agent lacks the needed support. Composes with resume_trajectory.
 */
export type LoadTrajectory = (string | null)
export type MaxTimeoutSec = (number | null)
export type Args = string[]
export type Command = (string | null)
export type Name = string
export type Transport = ("stdio" | "sse" | "streamable-http")
export type Url = (string | null)
export type McpServers = MCPServerConfig[]
export type ModelName = (string | null)
/**
 * Per-agent cap on concurrent agent.run() phases. Must not exceed the job's n_concurrent_trials and is usually useful only when lower. When omitted, agent execution is only limited by n_concurrent_trials.
 */
export type NConcurrent = (number | null)
export type Name1 = (string | null)
export type OverrideSetupTimeoutSec = (number | null)
export type OverrideTimeoutSec = (number | null)
/**
 * For multi-step tasks, resume the agent's native session from the previous step instead of starting a fresh conversation on each step. Requires an agent with native resume support (capabilities.resume); the trial fails fast otherwise. No effect on single-step tasks.
 */
export type ResumeTrajectory = boolean
/**
 * Skill directories or source strings (git URLs, org/name[@ref] shorthand, or local paths). Job.create() / Trial.create() resolve any non-local entries to cached directories in-place.
 */
export type Skills = string[]
export type Agents = AgentConfig[]
export type Destination = (string | null)
/**
 * Patterns to exclude when downloading a directory artifact (passed as tar --exclude flags).
 */
export type Exclude = string[]
/**
 * Docker Compose service to collect this artifact from. None or 'main' targets the agent's container. Any other value requires a compose-capable environment provider and an absolute source path.
 */
export type Service = (string | null)
export type Source = string
export type Artifacts = (string | ArtifactConfig)[]
/**
 * The directory to cache remote tasks to.
 */
export type DownloadDir = (string | null)
/**
 * Tasks to exclude from the dataset. Name can be a glob pattern.
 */
export type ExcludeTaskNames = (string[] | null)
/**
 * Maximum number of tasks to include from this dataset. Applied after task_names/exclude_task_names filtering.
 */
export type NTasks = (number | null)
export type Name2 = (string | null)
/**
 * Whether to overwrite cached remote tasks.
 */
export type Overwrite = boolean
export type Path = (string | null)
export type Ref = (string | null)
export type RegistryPath = (string | null)
export type RegistryUrl = (string | null)
export type Repo = (string | null)
/**
 * Tasks to include from the dataset. Name can be a glob pattern.
 */
export type TaskNames = (string[] | null)
export type Version = (string | null)
export type Datasets = DatasetConfig[]
/**
 * Enable debug logging
 */
export type Debug = boolean
export type ResourceMode = ("auto" | "limit" | "request" | "guarantee" | "ignore")
export type Delete = boolean
/**
 * Run-specific hostnames or IP addresses merged into the [environment] network baseline at agent env start.
 */
export type ExtraAllowedHosts1 = string[]
export type ExtraDockerCompose = string[]
export type ForceBuild = boolean
export type ImportPath1 = (string | null)
export type ResourceMode1 = ("auto" | "limit" | "request" | "guarantee" | "ignore")
export type Mounts = (ServiceVolumeConfig[] | null)
export type CreateHostPath = false
export type Selinux = ("z" | "Z")
export type Subpath = string
export type ReadOnly = true
export type Source1 = string
export type Target = string
export type Type = ("bind" | "volume" | "image")
export type Subpath1 = string
export type OverrideCpus = (number | null)
export type OverrideGpus = (number | null)
export type OverrideMemoryMb = (number | null)
export type OverrideStorageMb = (number | null)
/**
 * TPU topology as 'NxM' or 'NxMxK' (e.g., '2x4', '2x2x1').
 */
export type Topology = string
/**
 * TPU accelerator type. Accepts either a user-friendly alias (e.g., 'v6e', 'trillium', 'v4') or a canonical GKE label (e.g., 'tpu-v6e-slice', 'tpu7x').
 */
export type Type1 = string
/**
 * Deprecated; has no effect.
 */
export type SuppressOverrideWarnings = boolean
export type EnvironmentType = ("docker" | "podman" | "daytona" | "e2b" | "modal" | "runloop" | "langsmith" | "ec2" | "gke" | "ack" | "openshift" | "novita" | "apple-container" | "singularity" | "islo" | "tensorlake" | "cwsandbox" | "wandb" | "use-computer" | "cua-cloud" | "blaxel" | "opensandbox" | "beam" | "skypilot" | "hf-sandbox" | "hyperbrowser" | "vercel" | "kata")
export type EnvironmentBuildTimeoutMultiplier = (number | null)
/**
 * Paths to extra instruction files appended to each task instruction. File contents are appended before ``extra_instructions``.
 */
export type ExtraInstructionPaths = string[]
/**
 * Inline extra instructions appended to each task instruction. Appended after any ``extra_instruction_paths`` contents.
 */
export type ExtraInstructions = string[]
/**
 * Only run agent setup/install, then exit (skips agent run + verification).
 */
export type InstallOnly = boolean
export type JobName = string
export type JobsDir = string
export type MetricType = ("sum" | "min" | "max" | "mean" | "uv-script")
export type Metrics = MetricConfig[]
export type NAttempts = number
/**
 * Maximum concurrent trials to run. Agent n_concurrent is a per-agent sub-limit under this value.
 */
export type NConcurrentTrials = number
/**
 * Suppress trial progress displays
 */
export type Quiet = boolean
/**
 * Exception types to NOT retry on. Takes precedence over include_exceptions.
 */
export type ExcludeExceptions = (string[] | null)
/**
 * Exception types to retry on. If None, retries all exceptions.
 */
export type IncludeExceptions = (string[] | null)
/**
 * Maximum number of retry attempts
 */
export type MaxRetries = number
/**
 * Maximum wait time in seconds between retries
 */
export type MaxWaitSec = number
/**
 * Minimum wait time in seconds between retries
 */
export type MinWaitSec = number
/**
 * Multiplier for exponential backoff wait time
 */
export type WaitMultiplier = number
export type Action = "regrade"
export type JobId = (string | null)
export type Path1 = (string | null)
export type Type2 = ("local" | "hub")
/**
 * Source jobs this job derives from. When non-empty with action='regrade', trials are derived from the source jobs' recorded trials (one regrade trial per source trial, matched by task name against 'tasks') instead of the tasks x agents x attempts expansion. The CLI passes a single source; multiple sources are supported programmatically.
 */
export type SourceJobs = SourceJobConfig[]
export type DownloadDir1 = (string | null)
export type GitCommitId = (string | null)
export type GitUrl = (string | null)
export type Name3 = (string | null)
export type Overwrite1 = boolean
export type Path2 = (string | null)
export type Ref1 = (string | null)
export type Source2 = (string | null)
export type Tasks = TaskConfig[]
export type TimeoutMultiplier = number
export type BridgeKind = "acp"
export type PromptPath = (string | null)
/**
 * Optional shared concurrency pool name for agent configs that should use the same n_concurrent limit.
 */
export type ConcurrencyGroup1 = (string | null)
/**
 * Glob patterns of agent log files to skip when downloading. Applied after include_logs, so exclude wins on overlap.
 */
export type ExcludeLogs1 = string[]
/**
 * Run-specific hostnames or IP addresses merged into the effective agent phase allowlist during agent.run() only.
 */
export type ExtraAllowedHosts2 = string[]
export type ImportPath2 = (string | null)
/**
 * Glob patterns of agent log files to download, relative to the agent logs directory. When set, only matching files are kept.
 */
export type IncludeLogs1 = string[]
/**
 * Path to a trajectory to load as the agent's session before the first step, which then resumes it instead of starting fresh. A .jsonl file is the agent's native session format (lossless, same agent only; capabilities.load_native_trajectory); a .json file is an ATIF trajectory converted to the agent's native format (portable across supported agents; capabilities.load_atif_trajectory). The trial fails fast if the agent lacks the needed support. Composes with resume_trajectory.
 */
export type LoadTrajectory1 = (string | null)
export type MaxTimeoutSec1 = (number | null)
export type McpServers1 = MCPServerConfig[]
export type ModelName1 = (string | null)
/**
 * Per-agent cap on concurrent agent.run() phases. Must not exceed the job's n_concurrent_trials and is usually useful only when lower. When omitted, agent execution is only limited by n_concurrent_trials.
 */
export type NConcurrent1 = (number | null)
export type Name4 = (string | null)
export type OverrideSetupTimeoutSec1 = (number | null)
export type OverrideTimeoutSec1 = (number | null)
/**
 * For multi-step tasks, resume the agent's native session from the previous step instead of starting a fresh conversation on each step. Requires an agent with native resume support (capabilities.resume); the trial fails fast otherwise. No effect on single-step tasks.
 */
export type ResumeTrajectory1 = boolean
/**
 * Skill directories or source strings (git URLs, org/name[@ref] shorthand, or local paths). Job.create() / Trial.create() resolve any non-local entries to cached directories in-place.
 */
export type Skills1 = string[]
export type UserPersonaPath = (string | null)
export type UserPromptTemplatePath = (string | null)
export type Disable = boolean
/**
 * Glob patterns of verifier log files to skip when downloading. Applied after include_logs, so exclude wins on overlap.
 */
export type ExcludeLogs2 = string[]
export type ImportPath3 = (string | null)
/**
 * Glob patterns of verifier log files to download, relative to the verifier logs directory. When set, only matching files are kept; the reward file is always downloaded.
 */
export type IncludeLogs2 = string[]
export type MaxTimeoutSec2 = (number | null)
export type OverrideTimeoutSec2 = (number | null)
export type VerifierTimeoutMultiplier = (number | null)

export interface HarborJobConfigV1 {
agent_setup_timeout_multiplier?: AgentSetupTimeoutMultiplier
agent_timeout_multiplier?: AgentTimeoutMultiplier
agents?: Agents
artifacts?: Artifacts
datasets?: Datasets
debug?: Debug
environment?: EnvironmentConfig
environment_build_timeout_multiplier?: EnvironmentBuildTimeoutMultiplier
extra_instruction_paths?: ExtraInstructionPaths
extra_instructions?: ExtraInstructions
install_only?: InstallOnly
job_name?: JobName
jobs_dir?: JobsDir
metrics?: Metrics
n_attempts?: NAttempts
n_concurrent_trials?: NConcurrentTrials
quiet?: Quiet
retry?: RetryConfig
source_jobs?: SourceJobs
tasks?: Tasks
timeout_multiplier?: TimeoutMultiplier
/**
 * Optional simulated-user agent and bridge applied to every trial.
 */
user_agent?: (UserAgentConfig | null)
verifier?: VerifierConfig
verifier_timeout_multiplier?: VerifierTimeoutMultiplier
[k: string]: unknown
}
export interface AgentConfig {
concurrency_group?: ConcurrencyGroup
env?: Env
exclude_logs?: ExcludeLogs
extra_allowed_hosts?: ExtraAllowedHosts
import_path?: ImportPath
include_logs?: IncludeLogs
kwargs?: Kwargs
load_trajectory?: LoadTrajectory
max_timeout_sec?: MaxTimeoutSec
mcp_servers?: McpServers
model_name?: ModelName
n_concurrent?: NConcurrent
name?: Name1
override_setup_timeout_sec?: OverrideSetupTimeoutSec
override_timeout_sec?: OverrideTimeoutSec
resume_trajectory?: ResumeTrajectory
skills?: Skills
[k: string]: unknown
}
export interface Env {
[k: string]: string
}
export interface Kwargs {
[k: string]: unknown
}
/**
 * Configuration for an MCP server available to the agent.
 */
export interface MCPServerConfig {
args?: Args
command?: Command
name: Name
transport?: Transport
url?: Url
[k: string]: unknown
}
export interface ArtifactConfig {
destination?: Destination
exclude?: Exclude
service?: Service
source: Source
[k: string]: unknown
}
export interface DatasetConfig {
download_dir?: DownloadDir
exclude_task_names?: ExcludeTaskNames
n_tasks?: NTasks
name?: Name2
overwrite?: Overwrite
path?: Path
ref?: Ref
registry_path?: RegistryPath
registry_url?: RegistryUrl
repo?: Repo
task_names?: TaskNames
version?: Version
[k: string]: unknown
}
export interface EnvironmentConfig {
cpu_enforcement_policy?: ResourceMode
delete?: Delete
env?: Env1
extra_allowed_hosts?: ExtraAllowedHosts1
extra_docker_compose?: ExtraDockerCompose
force_build?: ForceBuild
import_path?: ImportPath1
kwargs?: Kwargs1
memory_enforcement_policy?: ResourceMode1
mounts?: Mounts
override_cpus?: OverrideCpus
override_gpus?: OverrideGpus
override_memory_mb?: OverrideMemoryMb
override_storage_mb?: OverrideStorageMb
override_tpu?: (TpuSpec | null)
suppress_override_warnings?: SuppressOverrideWarnings
type?: (EnvironmentType | null)
[k: string]: unknown
}
export interface Env1 {
[k: string]: string
}
export interface Kwargs1 {
[k: string]: unknown
}
export interface ServiceVolumeConfig {
bind?: ServiceVolumeBind
image?: ServiceVolumeImage
read_only?: ReadOnly
source: Source1
target: Target
type: Type
volume?: ServiceVolumeVolume
[k: string]: unknown
}
export interface ServiceVolumeBind {
create_host_path?: CreateHostPath
selinux?: Selinux
[k: string]: unknown
}
export interface ServiceVolumeImage {
subpath?: Subpath
[k: string]: unknown
}
export interface ServiceVolumeVolume {
subpath?: Subpath1
[k: string]: unknown
}
/**
 * Specification for a TPU slice attached to an environment.
 *
 * The (type, topology) pair fully determines the GKE node pool the pod
 * lands on *and* the per-pod TPU chip count, so there is no separate
 * user-facing chip-count field — it is derived via chip_count.
 */
export interface TpuSpec {
topology: Topology
type: Type1
[k: string]: unknown
}
export interface MetricConfig {
kwargs?: Kwargs2
type?: MetricType
[k: string]: unknown
}
export interface Kwargs2 {
[k: string]: unknown
}
export interface RetryConfig {
exclude_exceptions?: ExcludeExceptions
include_exceptions?: IncludeExceptions
max_retries?: MaxRetries
max_wait_sec?: MaxWaitSec
min_wait_sec?: MinWaitSec
wait_multiplier?: WaitMultiplier
[k: string]: unknown
}
/**
 * A source job this job derives from.
 *
 * ``action`` names the derivation and must be stated explicitly; only
 * ``regrade`` exists today. A ``hub`` source records only the hub job
 * UUID; a ``local`` source records the job directory path plus its UUID
 * when known.
 */
export interface SourceJobConfig {
action: Action
job_id?: JobId
path?: Path1
type: Type2
[k: string]: unknown
}
export interface TaskConfig {
download_dir?: DownloadDir1
git_commit_id?: GitCommitId
git_url?: GitUrl
name?: Name3
overwrite?: Overwrite1
path?: Path2
ref?: Ref1
source?: Source2
[k: string]: unknown
}
export interface UserAgentConfig {
bridge: BridgeConfig
concurrency_group?: ConcurrencyGroup1
env?: Env2
exclude_logs?: ExcludeLogs1
extra_allowed_hosts?: ExtraAllowedHosts2
import_path?: ImportPath2
include_logs?: IncludeLogs1
kwargs?: Kwargs4
load_trajectory?: LoadTrajectory1
max_timeout_sec?: MaxTimeoutSec1
mcp_servers?: McpServers1
model_name?: ModelName1
n_concurrent?: NConcurrent1
name?: Name4
override_setup_timeout_sec?: OverrideSetupTimeoutSec1
override_timeout_sec?: OverrideTimeoutSec1
resume_trajectory?: ResumeTrajectory1
skills?: Skills1
user_persona_path?: UserPersonaPath
user_prompt_template_path?: UserPromptTemplatePath
[k: string]: unknown
}
export interface BridgeConfig {
kind: BridgeKind
kwargs?: Kwargs3
prompt_path?: PromptPath
[k: string]: unknown
}
export interface Kwargs3 {
[k: string]: unknown
}
export interface Env2 {
[k: string]: string
}
export interface Kwargs4 {
[k: string]: unknown
}
export interface VerifierConfig {
disable?: Disable
env?: Env3
exclude_logs?: ExcludeLogs2
import_path?: ImportPath3
include_logs?: IncludeLogs2
kwargs?: Kwargs5
max_timeout_sec?: MaxTimeoutSec2
override_timeout_sec?: OverrideTimeoutSec2
[k: string]: unknown
}
export interface Env3 {
[k: string]: string
}
export interface Kwargs5 {
[k: string]: unknown
}

# Experiment Manifest

This specification defines the current portable experiment format consumed by
`harbor-hf`. An experiment is one YAML file with a required `Experiment`
resource. The format is pre-release and identified as `harbor-hf/v1alpha1`.

**Status.** Current production contract, planned for in-place replacement. The
approved [control service specification](CONTROL_SERVICE.md) moves namespace
resources, artifact destinations, publication destinations, and shared control
policy into private service configuration and immutable profiles. The contracts
stage will update this document with the exact request shape before the
TypeScript service accepts production submissions. There will be no parallel
legacy manifest mode.

The `hf-sandbox` extra and `remote.harbor.sandbox_*` fields below are names from
the pinned external Harbor API used by the legacy local worker. They do not
describe a control-service lifecycle resource or compatibility path.

## Minimal Shape

```yaml
api_version: harbor-hf/v1alpha1
kind: Experiment
metadata:
  name: example
benchmark:
  dataset: harbor/terminal-bench@2.0
  dataset_digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
  task_names: [example-task]
  task_digests:
    example-task: sha256:0000000000000000000000000000000000000000000000000000000000000000
  judge:
    protocol: openai-compatible
    api_url: https://api.openai.com/v1/chat/completions
    model: gpt-5.6-luna
    api_key_secret_name: OPENAI_API_KEY
    reasoning_effort: xhigh
    strip_temperature: true
matrix:
  models:
    - id: model
      repo: organization/model
      revision: 0000000000000000000000000000000000000000
      weights:
        format: safetensors
        quantization:
          method: compressed-tensors
          scheme: fp8
  deployments:
    - id: h200
      hardware: h200
      region: aws-us-east-1
      engine:
        name: vllm
        image: registry/image@sha256:0000000000000000000000000000000000000000000000000000000000000000
  agents:
    - id: agent
      name: terminus-2
      revision: bd9e606dcb99eb49de70bd741fd846cae5c7ebd1
      revision_kind: harbor-source
      reported_version: 2.0.0
artifacts:
  bucket: organization/benchmark-runs
publishing:
  dataset: organization/terminal-bench-results
  dataset_visibility: private
  index_dataset: organization/benchmark-run-index
  index_dataset_visibility: private
  evaluation_id: example-evaluation
  role: final
remote:
  job:
    namespace: organization
    image: registry/controller@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  worker:
    repository: organization/harbor-hf
    revision: 0123456789abcdef0123456789abcdef01234567
  harbor:
    source:
      repository: example-org/harbor
      revision: bd9e606dcb99eb49de70bd741fd846cae5c7ebd1
```

Unknown fields are rejected. Use `harbor-hf validate PATH` before submission.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `api_version` | Yes | Manifest schema version. |
| `kind` | Yes | Must be `Experiment`. |
| `metadata` | Yes | Human identity and labels. |
| `benchmark` | Yes | Harbor dataset and task selection. |
| `matrix` | Yes | Models, deployments, and agents to combine. |
| `execution` | No | Attempt, concurrency, and timeout policy. |
| `artifacts` | Yes | Private raw bucket destination. |
| `publishing` | Yes | Result Dataset destinations. |
| `remote` | For submission | HF Job and pinned worker runtime configuration. |

### Metadata

`metadata.name` is a lowercase identifier containing letters, digits, and
hyphens. `metadata.labels` is optional non-executing metadata.

### Benchmark

`benchmark.dataset` is a qualified Harbor package reference in `org/name` or
`org/name@ref` form. Remote runs require `dataset_digest`; the worker replaces a
mutable ref with `@sha256:<64 hex>` before invoking Harbor. An already
content-addressed reference remains valid and may omit `dataset_digest`, which
is inferred from the reference. If both forms contain a digest, they must match.
Legacy unqualified dataset names cannot be resolved by Harbor's package digest
lookup and are rejected for remote runs. `task_names` defaults to `["*"]` and
remains the selection passed to Harbor. `task_digests` enumerates the complete
resolved selection as task name to content digest. Every selection must match
at least one pinned task, and every pinned task must match a selection. A task
content digest covers its instructions, environment, verifier, and other task
files.

A benchmark may instead use one of the source forms in the
[benchmark source specification](benchmark-sources.md). The resolved source is
one of:

- an anonymously readable GitHub repository at a full commit and safe
  repository-relative path;
- an immutable bundle built from an operator-local directory;
- an existing verified bundle; or
- the content-addressed Harbor package named by `benchmark.dataset`.

A public Git request keeps the current concise shape:

```yaml
benchmark:
  dataset: shellbench/public-115
  source:
    type: git
    repository: ShellBench/public-tasks
    revision: 0000000000000000000000000000000000000000
    path: tasks/115-tasks
  task_names: ["*"]
  task_digests:
    example-task: sha256:0000000000000000000000000000000000000000000000000000000000000000
```

Git sources are public and anonymous. They cannot declare credentials, require
private submodules, or rely on authenticated Git LFS. Planning and execution
disable credential helpers, SSH agents, askpass programs, interactive prompts,
and ambient Git authentication. The worker verifies the locked commit before
Harbor reads a task.

Private or local files use a directory request:

```yaml
benchmark:
  dataset: shellbench/public-115
  source:
    type: directory
    path: ../../../../public-tasks/tasks/115-tasks
```

Planning resolves the directory into a content-addressed private bundle.
Submission uploads or adopts that bundle in the managed `jobs-artifacts`
Bucket, and the remote Job mounts it read-only. The local path and local Git
credentials never enter the remote source lock or Job. The plan digest covers
the resolved source lock rather than the operator path.

Directory and bundle sources are accepted by the current CLI. The
[implementation record](benchmark-source-implementation-plan.md) describes the
bundle format, private staging, remote validation, and credential boundary.
Authenticated remote Git is prohibited, even when an older pinned worker still
accepts its manifest shape. Do not forward a Git credential as a workaround.

`benchmark.judge` optionally pins an OpenAI-compatible verifier judge. The
allowed upstreams are the Hugging Face router, the direct OpenAI API, and the
Gemini OpenAI-compatible API. Each upstream requires its matching secret name:
`HF_TOKEN`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`. The API URL, model, protocol,
secret name, optional reasoning effort, and temperature policy are preserved in
the run lock.

A trusted recorder holds the upstream credential. The verifier receives the HF
Job ingress credential through `AGENT_JUDGE_API_KEY`, plus an execution-scoped
capability URL and the locked model in `AGENT_JUDGE_API_URL` and
`AGENT_JUDGE_MODEL`. The recorder can enforce `reasoning_effort` and remove a
verifier-supplied `temperature` before forwarding a request. Run workers
and deployment profiling workers both construct the recorder from this locked
judge configuration; profiling does not substitute the HF router for a direct
OpenAI or Gemini judge. The recorder retains exact bounded request and response
bodies while excluding credentials. Upstream and ingress credentials must not
enter the manifest, lock, workspace, command, or evidence. Arbitrary judge
hosts and mismatched provider secret names are rejected.

### Matrix

The initial candidate set is the Cartesian product of `models`, `deployments`,
and `agents`. IDs must be unique within each dimension. Optional `include` rules
keep cells that match at least one rule, then `exclude` rules remove matching
cells. Omitted dimensions in a rule are wildcards. Rules use exact profile IDs,
reject unknown IDs, and may not remove every cell.

The [control service plan](2026-08-16-harbor-hf-control-service-plan.md) will
make these profiles reusable. Built-in profiles will live in the existing
Harbor-HF source repo, namespace-specific profile objects will use the existing
private evidence Bucket, and the resolved run lock will continue to inline
every behavior-affecting field. No profile-specific Hub repository or Bucket is
allowed.

Remote model revisions must be full 40-character commit IDs, and serving images
must use `@sha256:<64 hex>` content digests. `weights.format` describes the
weight container, such as Safetensors or GGUF. Optional `weights.quantization`
records the quantization method and scheme; unquantized weights omit it.
Activation and KV-cache precision belong to the deployment profile because they
are runtime choices.

Deployment `engine.environment` contains non-secret values. `secret_names`
contains environment-variable names that the remote Job or Endpoint must inject.
Secret-like keys and keys declared in `secret_names` are rejected from
`engine.environment`; credentials must be injected by the remote platform.

Provider-specific values belong in `parameters`. They must be representable as
JSON and are preserved in the resolved lock. Secret-like keys are rejected
recursively from deployment and agent parameter mappings. Top-level agent
parameter keys cannot be empty, contain `=`, or have surrounding whitespace,
because Harbor parses them as command-line `KEY=VALUE` pairs.

An endpoint-backed deployment used for submission also has an `endpoint`
binding with `namespace`, `name`, and the OpenAI-compatible
`served_model_name`. The binding identifies an existing endpoint; planning does
not inspect or resume it.

Engine identity is more than `engine.name`. Resolution and submission preserve
the engine version and build or commit, immutable image digest, container
command, full arguments, non-secret environment, secret names, runtime and
driver versions, parser and chat-template identity, cache precision, batching
limits, and feature controls
such as prefix caching, speculation or MTP, CUDA graphs, attention backend, and
MoE backend. Values observed after startup are stored separately from requested
values so a provider default cannot silently change the run definition.

Inference Provider targets lock one native API with `api`:
`chat-completions` or `responses`. Every provider-backed agent is an external
Harbor agent from `packages/harbor-hf-agents` in the pinned worker checkout and
is loaded through Harbor's public `AgentConfig.import_path` field. One
declarative registry validates the logical agent, import path, API, parameters,
trajectory schema, session requirement, and retry taxonomy without placing
agent-specific branches in the generic worker.

The resolved `AgentConfig.env` supplies the locked Hugging Face upstream,
`${HF_INFERENCE_TOKEN}`, timeout, and output limit. Its
`extra_allowed_hosts` includes the upstream hostname. The agent calls that
upstream directly with its native API. The model profile is authoritative for
model identity, and the model provider suffix, deployment provider, model API,
and harness API must match. An incompatible combination is rejected before
launch rather than translated.

Inference Provider requests identify a model repository, but the provider API
does not expose or accept a Hub commit for the weights it serves. The locked
model profile still preserves the selected repository revision for source
metadata. Published provider rows set `model_revision` to `not_observed` rather
than claiming that revision was served. Endpoint-backed rows use the revision
verified in the endpoint configuration. Do not treat provider runs as
revision-equivalent when the published value is `not_observed`.

Provider `limits.max_spend_usd` and `limits.estimated_wave_cost_usd` must be
configured together. The estimate is a conservative admission reservation for
one deployment wave, must not exceed the cap, and is preserved in the Run and
wave locks. Missing observed usage cannot reopen reserved spend. It is not
presented as observed provider billing. Physical replacement attempts remain
an explicit Harbor-HF policy and Harbor internal retries remain disabled.

The endpoint deployment shape supports independent engines such as vLLM and
llama.cpp. The discriminated Inference Provider profile covers models that are
too large or expensive to host on a dedicated endpoint without requiring or
implying a particular serving engine.

### Execution

`attempts` counts independent logical attempts. Infrastructure retries do not
consume attempt ordinals. `concurrent_trials` limits Harbor trial concurrency;
for a new deployment, choose it through the
[deployment profiling contract](deployment-profiling.md), not from GPU name or
weight size. `server_context_tokens`, `max_output_tokens`, and
`reasoning_required` declare the behavior that profiling must verify.

`serving_profile` binds the selected profile ID, Bucket URI, profile digest,
selection concurrency, model/deployment/agent/benchmark identity, Harbor client
runtime, reasoning mode, sampled workload, and token limits. When present,
validation fails unless the manifest has one resolved matrix cell and every
identity, workload, and concurrency value matches. The binding is copied into
run locks and participates in run and experiment digests.
`max_trials_per_shard` deterministically bounds the number of task-attempt pairs
in one run shard and defaults to 64. `max_shards_per_wave` bounds compatible
shards assigned under one endpoint startup and defaults to 8. Provider request
concurrency is part of the deployment profile. Timeout values are in seconds.
`agent_setup_timeout_multiplier` is an optional positive multiplier forwarded to
Harbor for agent installation and setup. Set it only when measured setup time
exceeds Harbor's default; it does not extend the run wall-clock limit.
`timeout_seconds` is a wall-clock limit for Harbor execution. On expiry, an
endpoint worker terminates the Harbor process group and starts verified cleanup.
A provider controller drains the internal wave and records its durable state.

Inference Provider runs require `execution.controller` with every field
written explicitly:

```yaml
execution:
  attempts: 6
  concurrent_trials: 24
  timeout_seconds: 16200
  agent_setup_timeout_multiplier: 3
  max_trials_per_shard: 24
  max_shards_per_wave: 4
  controller:
    planning_trial_seconds: 900
    headroom_factor: "1.25"
    wave_reserve_seconds: 900
    controller_reserve_seconds: 1800
    heartbeat_seconds: 60
    stale_after_seconds: 600
    max_attempts: 3
```

`planning_trial_seconds` comes from a representative end-to-end pilot.
`headroom_factor` is an exact decimal string. The wave reserve covers setup,
drain, evidence publication, and route closure. The controller reserve covers
source setup, final reconciliation, publication, and exit. Heartbeats run every
30 to 300 seconds, and `stale_after_seconds` must cover at least three heartbeat
periods. `max_attempts` limits sequential physical controller Jobs to 10 or
fewer.

The planner computes effective concurrency as the minimum of trial concurrency,
provider request concurrency, and selected serving-profile concurrency. It
then computes each initial wave duration from the number of concurrency batches,
the planning trial duration, headroom, and wave reserve. Every wave must fit
`execution.timeout_seconds`. The sum of the initial waves and controller reserve
must fit `remote.job.timeout_seconds`. A provider wave lock enforces the planned
trial-work duration. Recorder setup draws from `wave_reserve_seconds`, and any
unused setup allowance remains for drain and evidence publication. The plan and
run lock store these values and include them in their digests.

Every task selected by `benchmark.task_names` is passed to Harbor. The resolved
`task_digests` map gives exact and glob selections a deterministic trial count.
The controller requires every pinned task and attempt, rejects unpinned task
names, and compares each trial's Harbor `lock.json` task digest with the run
lock. It then validates every resulting trial for exceptions and finite numeric
verifier rewards.

Agent profiles contain a stable logical `name` and may contain `import_path` for
a Harbor custom-agent class. Provider-backed agents require `import_path` and
must match the corresponding registry definition. Their implementation is
pinned by the existing `remote.worker.revision`, because the complete
`harbor-hf-agents` package lives in this repository.

Agent revisions declare how the underlying runtime is enforced. `package`
passes the revision to the custom agent and requires an exact numeric package
version rather than a tag or version range; Harbor must report that same
version. `git` requires a full 40-character commit and Harbor must report that
commit. `harbor-source` remains valid only for endpoint-backed agents whose
implementation is part of Harbor: its revision must equal
`remote.harbor.source.revision`, no package version is passed, and
`reported_version` records the semantic version Harbor must report.

Example provider-agent profiles:

```yaml
matrix:
  agents:
    - id: hermes
      name: hermes
      import_path: harbor_hf_agents.hermes.agent:HermesAgent
      revision: cb06017b1d6e1b9ae0cb35f99a48ffa6bcbaa828
      revision_kind: git
    - id: pi
      name: pi
      import_path: harbor_hf_agents.pi.agent:PiAgent
      revision: 0.82.1
      revision_kind: package
      parameters:
        models_json: {}
```

Agent parameters remain part of the existing run lock and digest. Each custom
agent validates its parameters through its own strict configuration model and
renders its own runtime files. `harbor-hf` does not render Hermes, OpenClaw,
OpenClaw Codex, or Pi configuration in generic modules.

### Artifacts

`artifacts.bucket` identifies private raw storage for complete run evidence.

### Publishing

The current contract uses separate benchmark and index destinations. The
[control service plan](2026-08-16-harbor-hf-control-service-plan.md) replaces
that new-write shape in place with immutable normalized rows and catalog objects
under `results/schema=v1/` in the namespace's existing private
`<artifact-bucket>` Bucket. New runs will not create result repositories
or Datasets. This section remains authoritative until that switch is
implemented.

`publishing.dataset` identifies the versioned, benchmark-specific publication.
`dataset_visibility` is required and is `private` or `public`.
`index_dataset` identifies the run catalog. Single-run planning can omit it, but
run submission requires it because completed runs publish their
normalized result and index atomically. `index_dataset_visibility` is required
exactly when `index_dataset` is present. Harbor HF creates missing repositories
with the requested visibility and checks existing repositories before it reads
evidence or writes results. A mismatch stops publication; Harbor HF never
changes repository visibility automatically. Private benchmark programs should
use a dedicated private index instead of a shared public index. `evaluation_id`
groups every physical publication that belongs to one logical benchmark
evaluation. `role` is required and is one of `final`, `component`, or
`diagnostic`. A component also requires `component_kind: base` or
`component_kind: correction`; other roles must omit it. Only final publications
enter the primary results catalog.

### Remote Execution

`remote.job` pins the HF Job namespace, digest-pinned controller image, hardware
flavor, timeout, and the name of an explicitly approved, purpose-scoped HF
workload token. Submission must not copy the operator's ambient HF login into a
remote secret. The remote Job token value comes from the explicit `HARBOR_HF_JOB_TOKEN`
environment variable or from a fine-grained token added with
`harbor-hf auth add-job-token`. That command records approval to store the value
in Harbor HF's owner-only local token file and use it as the `HF_TOKEN` secret
on future Harbor HF Jobs. Harbor HF config stores only the selected name.
Submission never reads the Hugging Face CLI token store or silently selects the
active HF login.
`remote.worker.revision` also pins the complete
`packages/harbor-hf-agents` implementation used by every provider-backed run.
The worker layers that dependency-free package into the separately pinned
Harbor environment with `uv run --with`; it does not modify Harbor source or its
lock file. `remote.worker` pins this package to an exact GitHub commit.
`remote.harbor.source` likewise pins Harbor to an exact GitHub commit and
configures the HF Sandbox flavor and idle timeout.
Source revisions must be full lowercase 40-character Git commit IDs. The
current source transport accepts GitHub `owner/name` references or HTTPS GitHub
URLs. The controller checks out both revisions directly and runs them with
`uv --locked`;
missing or stale lock files fail before endpoint-backed benchmark execution
begins. The pinned Harbor revision must expose the `hf-sandbox` optional
dependency; the worker verifies that capability before it resumes the endpoint.

For endpoint-backed runs, `remote.job.namespace` must equal the selected
endpoint namespace. Submission creates or verifies a private
`<namespace>/harbor-hf-coordination` Dataset repository. The watchdog uses an
initialization commit as the first parent in a new repository, then uses an
endpoint-specific file committed against an expected parent revision as an
atomic lease and removes it with the same compare-and-swap protocol only after
verified cleanup.

Provider controllers use one run claim in the same coordination Dataset.
The Job wrapper records its start time before cloning the pinned worker source,
so remaining-time admission includes checkout and `uv` startup.
The claim records run, plan, physical Job, attempt, heartbeat, and expiry.
The controller also writes immutable attempt reservations, launch receipts,
and start and end receipts plus a latest status record whose Dataset history
preserves every revision. A parent-checked launch claim serializes the
exact-label lookup and launch for one attempt. An uncertain launch keeps that
claim for 30 minutes, preventing another process from launching a duplicate
while still allowing exact-label adoption. A second controller owner exits
before source preparation. An expired controller claim is insufficient for
recovery until the previous physical Job is terminal or absent.

Every billable provider action also uses one parent-checked capacity claim keyed
by provider service. The namespace runs at most one internal wave per provider
service until an immutable capacity profile proves a larger safe value. A busy
controller waits and reruns remaining-time admission without reserving the
action. Capacity claims do not expire across Runs. The exact owner releases
the claim after synchronous execution. If that Job crashes, the owning Run's
watchdog releases the abandoned claim after proving the Job terminal or absent,
even when policy blocks a replacement. Other Runs can then acquire the
provider normally.

One shared scheduled watchdog inspects only run IDs listed in its command.
It never executes trials or reconciliation actions. For a retryable controller
failure, it verifies the latest checkpoint, records an immutable recovery
decision, reserves the next sequential attempt, and launches from the original
input and worker revision. It does nothing for healthy or terminal runs.
`paused-capacity`, `paused-policy`, deterministic failure, spend changes, and
attempt exhaustion require an operator decision.

The controller Job timeout is limited to 85,800 seconds. The remaining 600
seconds within HF Jobs' 86,400-second maximum are reserved for watchdog startup
and verified Endpoint cleanup. It must also exceed `execution.timeout_seconds`
by at least 4,800 seconds, reserving time for source setup, watchdog readiness,
Endpoint startup, and controller cleanup. The Endpoint is not resumed until the
watchdog has completed source setup and published a readiness handshake.
Endpoint readiness has its own 3,600-second allowance and does not consume or
inherit the Harbor execution timeout.
Readiness requires every positive `targetReplica` to be represented by a ready
replica. The controller then probes the endpoint's reported `healthRoute`
instead of assuming a custom image uses `/health`.
Before starting the watchdog, the controller requires a paused endpoint with
zero ready replicas. Before resuming and again before benchmarking, it compares
the observable endpoint model, custom image, container command, complete
ordered serving arguments, complete non-secret environment, secret key names,
provider region, hardware, accelerator count, and declared replica limits with
the resolved deployment. A mismatch is a run failure, not a warning.

The HF Sandbox idle timeout must exceed the longest uninterrupted agent or
verifier command. A command can keep one streaming SDK request open without
resetting the Sandbox idle timer; if the timer expires first, the remote job is
terminated mid-command. The default is 3,600 seconds. Set it above the
benchmark's agent timeout, but never above the controller Job timeout. Manifest
validation enforces that upper bound so an abandoned Sandbox cannot outlive the
controller's configured lifecycle.

A Sandbox job that terminates during startup before agent or verifier work is a
transient infrastructure failure. It receives a bounded physical retry under
the same logical trial identity. Deterministic image and command errors remain
benchmark failures and do not consume infrastructure retries.

Only secret names are serialized. The configured token is forwarded through the
HF Jobs secret mechanism to the controller and its cleanup watchdog, then
inherited by Harbor through process environment. Its value is absent from
commands, locks, and evidence. Before archiving, secret values are redacted from
both file contents and path components using bounded-memory streaming. Symbolic
links are rejected before evidence is read, modified, hashed, or archived.
Prefixed API, access, private key, and personal access token (`PAT`) names are
treated as secrets, including camel-case and uppercase environment forms.

Harbor's raw job tree is created on Job-local storage rather than the bucket
mount. Before remote work, the worker creates a permanent run reservation with
a parent-commit compare-and-swap in the private coordination repository. Bucket
references are canonicalized before deriving the reservation, so equivalent
URI spellings cannot reserve the same destination independently. Only
the finalized, scrubbed tree is copied to its reserved Bucket prefix, and the
root terminal marker is copied last. Nested task markers are preserved. If a
successful physical execution reaches the Bucket but logical trial finalization
is interrupted, run finalization adopts it only when it is the unique
checksum-valid success. It records the recovery and recreates the locked,
checksum-complete trial envelope before writing the trial marker last, without
rerunning the agent. If the envelope was already complete, it validates the
immutable checksums and writes only the missing marker. Ambiguous or invalid
execution evidence stops publication. If the controller is killed
before finalization, raw sessions and logs disappear with the Job instead of
remaining in the bucket. Submission queries both the configured artifact Bucket and the managed
`jobs-artifacts` input Bucket and refuses to start a Job unless both are private.
The resolved benchmark-source contract changes a provider run input to
exactly `manifest.yaml`, `source.lock.json`, `run.lock.json`, and
`input-manifest.json`. The input manifest records the byte count and SHA-256 of
the other three files. Submission uploads that folder under a content-addressed
prefix and mounts it read-only. A benchmark bundle is stored once under its own
content address and mounted separately; it is not duplicated in each run
input package. This package change takes effect with the benchmark-source
implementation and has no fallback to the old authenticated-Git path.

## Loading And Resolution

Validation checks the requested document. Source resolution then writes one
immutable `source.lock.json`: public Git remains an anonymous commit-pinned
source, a directory becomes a bundle reference, an existing bundle is verified,
and a package remains content-addressed. Planning expands the matrix and
computes a digest from canonical JSON that includes this source lock. Remote
validation and submission reject mutable dataset, task, model, serving-image,
source, and agent references. The run lock preserves the exact selected
matrix cell without rewriting the requested document.

Run planning additionally sorts resolved cells and tasks, creates one
logical trial per task and requested attempt, splits those trials into bounded
shards, and content-addresses every cell and shard. The run plan digest is
derived from resolved execution semantics; the separate manifest digest still
identifies the exact requested document. Reordering equivalent profile lists or
task-digest mappings therefore does not change the run plan digest.

Every submitted run writes `manifest.yaml`, `execution.lock.json`,
`endpoint.snapshot.json`, and `runtime-environment.json`. Provider-backed runs
must mark hidden details as `not_reported`; failed collection is `unknown`, and
irrelevant fields are `not_applicable`. These statuses accompany null values
rather than being stored as fake version or hardware strings.

Before remote work, the worker reconstructs the selected matrix cell from the
manifest and compares every field with the submitted run lock. A matching
manifest digest alone is not sufficient.

## Not Covered

The manifest does not define Harbor tasks, verifier behavior, agent internals,
leaderboard presentation, secret storage, or provider credentials. Those remain
owned by Harbor, the selected agent, Hugging Face, or the presentation layer.

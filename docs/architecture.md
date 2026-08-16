# Architecture

## Purpose

`harbor-hf` is the control plane around Harbor. Harbor owns tasks, agents,
environments, verification, trajectories, and trial results. `harbor-hf` owns
experiment expansion, Hugging Face resource lifecycle, reproducibility
metadata, raw artifact retention, and result publication.

The package must remain useful as an independent Harbor plugin and be shaped so
that it could later move into a Harbor monorepo package without architectural
changes.

## Planned control service

The current release stores live campaign events and claims in a private Hub
Dataset. The [control service
plan](2026-08-16-harbor-hf-control-service-plan.md) replaces that new-write path
with one private control Space and immutable objects in the existing evidence
Bucket. It also moves detailed rows and the global result catalog into one
existing normalized results Dataset.

This is a hard new-write switch with no dual-write mode. Historical Dataset
commits and Bucket evidence remain immutable. Until implementation and remote
recovery canaries pass, the rest of this document describes current production
behavior.

Hub resources are shared namespace infrastructure. A campaign, repair, profile,
lease, status record, or result subset must not create its own repository,
Bucket, Space, or schedule. New persistent resources require an explicit
privacy, access, retention, or failure-domain reason that the canonical stores
cannot meet.

## Components

```text
experiment.yaml
      |
      v
planner -> campaign lock -> provider controller Job
              |                       |            |
              |                 HF Providers   HF Sandboxes
              |                       |            |
              +-> endpoint wave Job -> Harbor trials
                          |
                    HF Endpoints
                                              |
                                    private HF bucket
                                              |
                                       publisher job
                                              |
                                   versioned HF Datasets
                                              |
                                      leaderboard Space
```

### Deployment Strategy

Inference Endpoints are the primary serving path. Engine choice is independent
of resource type: normal experiments may deploy vLLM, llama.cpp, or another
supported engine on separate endpoints. A Red Hat vLLM recipe and our llama.cpp
recipe are therefore endpoint engine profiles, not different Hugging Face
resource types. Using the Red Hat recipe does not mean routing requests through
Hugging Face Inference Providers.

Inference Providers are a secondary path for models that are too large or too
expensive to host on a dedicated endpoint. Provider-backed runs use external
custom agents through Harbor's public `AgentConfig.import_path` surface; Harbor
core remains unchanged. Hermes, OpenClaw, OpenClaw Codex, and Pi follow the
same [provider-agent architecture](provider-agent-architecture.md), with
separate runtime modules and one generic orchestration registry. Provider runs
do not pretend that unreported runtime, hardware, or quantization details are
known. Endpoint and provider profiles remain distinct in manifests, locks,
metrics, and result tables.

### Planner

The planner validates an experiment, resolves its benchmark source, expands its
matrix, and produces one homogeneous run per model, deployment, and agent cell.
A public Git request resolves to an anonymous commit-pinned source. A local
directory resolves to an immutable bundle identity. An existing bundle or
Harbor package remains content-addressed. Planning may read and snapshot local
files but must not create remote resources. Every resolved run receives a
content digest before it is submitted.

The [benchmark source specification](benchmark-sources.md) defines the source
union, `source.lock.json`, bundle format, anonymous Git boundary, and private
Bucket layout. Filesystem, Git, archive, and Bucket adapters stay outside domain
planning.

### Controller

A provider campaign runs inside one detached HF Job. Submission stages a
content-addressed folder containing the requested manifest, resolved source
lock, campaign lock, and input manifest. A local benchmark bundle has its own
shared content address and read-only mount. A parent-checked launch claim
serializes the exact-label Job lookup and launch, and an immutable receipt binds
the attempt to its physical Job. The controller verifies the input files and
source, acquires the campaign claim, prepares pinned runtime sources, and runs
one internal wave at a time. Trial concurrency stays inside each wave.

The controller records a heartbeat while a long trial runs. Its container
wrapper records the physical start before pinned source checkout, so admission
includes bootstrap time. Before billable work, it acquires a parent-checked
namespace claim keyed by provider service, so two campaign Jobs cannot run
internal waves against the same shared provider at once. Provider recorder setup
draws from the locked wave reserve rather than the trial-work duration. The
controller stops admitting work if ownership becomes uncertain, shared capacity
is occupied, the remaining Job time cannot fit the next wave, observed
throughput breaks the locked duration bound, or policy blocks continuation.
Completed trial evidence is committed before the next action.

Endpoint-backed campaigns keep the existing wave Job and independent endpoint
watchdog. A killed endpoint worker needs an outside process that can pause the
endpoint, so endpoint execution does not use the provider controller.

### Campaign reconciler

Campaigns are durable submissions of an immutable resolved plan. A campaign
lock content-addresses its run cells, bounded shards, logical trials, controller
policy, and initial wave durations. The same plan may be submitted more than
once under distinct campaign IDs without overwriting an earlier measurement.

The domain reconciler reads the campaign lock and append-only events, rebuilds
the projection, and selects one deterministic action. It reserves that action
before applying a side effect and records the outcome before selecting another.
Cleanup and publication actions run before billable work.

For provider campaigns, `submit-wave` means that the owning controller admits
and executes the wave in process. It no longer submits an HF Job. The endpoint
adapter keeps the older remote wave meaning because endpoint ownership and
cleanup require separate resources. Read-only reconciliation remains useful for
diagnosis. An applied pass is available only for endpoint campaigns. Historical
provider campaigns remain bound to their pinned Harbor HF revision.

Endpoint-backed controller and watchdog Jobs carry a deterministic label
derived from the endpoint namespace and name. They coordinate through one
private, namespace-level `harbor-hf-coordination` Dataset repository. A
submission seeds an initialization commit when that repository has no `main`
commit yet. A watchdog adds the endpoint's lease file with the repository head
as the expected parent commit before publishing its readiness handshake. Concurrent
commits cannot both use the same parent; a loser rereads the new head, observes
the lease, and exits before its controller changes endpoint state.

The lease file records both controller and watchdog Job IDs. It remains present
while the watchdog observes the controller and is removed only after the
endpoint reports `paused` with zero ready replicas. Ownership is revalidated
at the latest repository head before a parent-checked removal commit. If
cleanup cannot be verified, the lease remains fail-closed and blocks another
run from inheriting an endpoint whose state is unknown.
If publishing the readiness label returns an ambiguous provider error, the
watchdog also retains the lease, waits for the controller to exit or time out,
verifies endpoint pause, and only then releases ownership.

If a controller Job terminates after publishing successful trial evidence but
before its wave marker, recovery closes the abandoned wave and may submit a
replacement. The replacement accepts checksum-valid successful trial evidence
from an earlier wave only when campaign, run, shard, trial, task, and logical
attempt identities all match. This avoids rerunning completed work without
allowing evidence from another campaign or task to cross the boundary.

Every endpoint wave Job acquires a second expiring lease keyed by campaign and
wave before endpoint work begins. The provider controller instead holds one
campaign claim and renews it throughout the physical Job. A duplicate
controller exits before source preparation or provider requests. Claim expiry
allows investigation but does not authorize recovery until the prior Job is
also terminal or absent. A separate provider-capacity claim serializes billable
waves by provider service. It is released by exact ownership and has no
cross-campaign expiry takeover. The owning campaign's watchdog releases an
abandoned capacity claim after proving its physical Job terminal or absent,
even when policy blocks a replacement. Other campaigns can then acquire the
provider normally.

### Endpoint Provisioner

The [endpoint provisioning boundary](endpoint-provisioning.md) converts locked
model and deployment profiles into deterministic campaign-scoped managed
identities and exact effective Hugging Face Endpoint configuration. Its typed
port supports create, inspect/adopt, pause, and explicit delete without
depending on SDK response models. Adoption requires managed identity, complete
configuration equality, and paused-zero-ready state. Ambiguous create outcomes
are resolved by inspecting the deterministic name rather than issuing another
create.

This boundary remains independent of the wave controller. A wave acquires the
endpoint lease and starts the watchdog before resume or shard execution.

### Harbor Adapter

Harbor remains the only benchmark execution engine. The adapter translates a
resolved run into Harbor job configuration and registers public lifecycle hooks
for incremental artifact publication. It must not patch Harbor internals.

Provider-backed agents are supplied by one installable package under
`packages/harbor-hf-agents` in this repository. The existing pinned worker
revision fixes that package. The worker layers the dependency-free package into
the pinned Harbor environment and selects the agent with
`AgentConfig.import_path`. Agent-specific
installation, configuration, invocation, session export, and trajectory
conversion live in separate external modules. Generic `harbor-hf` code performs
a declarative registry lookup and never renders one agent's configuration for
another. New provider campaigns have no built-in-agent fallback.

### Artifact Store

A private HF Storage Bucket is the complete evidence archive. Requested and
resolved configuration, endpoint snapshots, Harbor output, trajectories,
sessions, verifier records, logs, and checksums are written under an immutable
run prefix. The separate managed `jobs-artifacts` Bucket stores campaign inputs
and immutable benchmark bundles. Bundle payloads are published first and their
validated manifests are written last as completion markers. Sanitized run
evidence is published after validation and resource cleanup, and `_SUCCESS` is
written only for a complete run. Each Harbor trial's task digest is read from
its own `lock.json` and must match the pre-resolved task map in `run.lock.json`.
The worker first adds a permanent run reservation to the private coordination
repository with the same parent-commit compare-and-swap protocol. Duplicate run
IDs therefore fail before source preparation, endpoint work, or failure
publication. Equivalent Bucket URI spellings are normalized before deriving the
reservation identity. Terminal markers are delayed only at the run root;
marker-shaped files within Harbor task artifacts are preserved and included in
the root checksum manifest. Submission verifies the
artifact Bucket and managed Job input Bucket are private before launch. Job
inputs use content-addressed Bucket prefixes mounted read-only by `hf://` URI.

Raw Harbor output is staged on the controller Job's local filesystem, outside
the bucket mount. After endpoint cleanup, the controller redacts secret values,
rejects symbolic links, creates the archive and checksums, then copies the
sanitized tree to a new bucket prefix. The terminal marker is copied last. A
killed controller can therefore leave no unsanitized bucket artifacts.

### Results Publisher

One serialized publisher converts completed runs into normalized Parquet tables.
Benchmark-specific Dataset repositories contain run, trial, execution, metric,
and artifact tables. A small global index contains one row per completed run.
The bucket is canonical evidence; Datasets are the query and presentation layer.

## Identity

The stable hierarchy is:

1. An experiment groups a requested matrix.
2. A run represents one homogeneous matrix cell.
3. A trial represents one task and logical attempt.
4. An execution represents one physical invocation, including infrastructure
   retries.

Retries never replace previous executions. Composite or manually selected
results must be labeled explicitly and must not appear as single-run results.

## Reproducibility Boundary

A resolved run lock records:

- the benchmark source lock: anonymous Git commit, bundle content address, or
  Harbor package digest, plus the task-set digest and verifier digest;
- Harbor and worker source revisions, custom-agent import path, underlying
  agent, tool, prompt, and skill revisions;
- model, tokenizer, chat-template, and generation-config revisions;
- weight format and quantization separately from activation and KV precision;
- resource type and, when known, provider, region, hardware, accelerator count,
  replica policy, and driver information;
- serving engine name, version, build or commit, immutable container image
  digest, complete arguments, non-secret environment, and secret names;
- CUDA, framework, attention, reasoning-parser, and other serving-library
  versions reported by the runtime;
- chat template source and digest, context and output limits, batching and
  sequence capacity, and activation and KV-cache precision;
- prefix caching, speculative decoding or MTP, CUDA graph mode, attention
  backend, MoE backend, and other behavior-affecting engine controls;
- context, output, batching, concurrency, retry, timeout, and sampling settings;
- requested provider configuration and the effective configuration returned by
  the provider.

Secret values are never recorded. Manifests store only the names of secrets
that must be injected by the remote platform. Artifact finalization redacts
secret values from both file contents and path components before checksums or
archives are created. File content is scanned and rewritten in bounded chunks,
and symbolic links are rejected before evidence traversal.

### Canonical Configuration Artifacts

Each run preserves four separate configuration records:

| Artifact | Authority |
| --- | --- |
| `manifest.yaml` | Immutable copy of what the user requested, including an operator-local path when a directory was selected. |
| `source.lock.json` | Remote-safe anonymous Git, bundle, or package identity resolved before semantic planning. |
| `run.lock.json` | Resolved revisions, matrix cell, policy, and reproducibility contract fixed before execution. |
| `endpoint.snapshot.json` | Effective endpoint or provider configuration observed after readiness. |
| `runtime-environment.json` | Versions and feature controls reported from inside the serving runtime. |

The endpoint snapshot never overwrites the requested manifest or resolved lock.
Differences between requested and effective values remain explicit and are
published as comparison fields.

Before any remote work, the controller reconstructs the selected matrix cell
from `manifest.yaml` and the verified `source.lock.json`, then compares the
complete result with `run.lock.json`. Matching only the manifest digest is
insufficient because source and run lock fields can be modified independently.

Runtime evidence uses a status alongside nullable values. `reported` means the
value came from a named probe or provider response, `not_reported` means the
remote service did not expose it, `not_applicable` means the field does not
apply to that serving path, and `unknown` means collection was expected but
failed. The system never infers a hidden vLLM version, quantization, hardware,
or other provider detail from model behavior.

## Failure And Cleanup

Runs progress through `planned`, `submitted`, `provisioning`, `running`,
`verifying`, `publishing`, and a terminal state. Every transition is an
append-only event.

For endpoint-backed runs, the controller first requires a paused endpoint with
zero ready replicas, then starts a separate companion HF Job watchdog before it
resumes the endpoint. The controller requires a readiness label written from
inside the watchdog's monitoring process; a submitted or merely running Job is
not sufficient. If readiness polling fails, the controller exits without
canceling the watchdog, allowing it to observe that exit, pause the endpoint,
and release its lease. The watchdog also pauses the endpoint after the
controller terminates or its own deadline expires. The controller pauses the
endpoint after its last active shard in a `finally` path, but only after its
watchdog has acquired the endpoint lease. A controller whose watchdog cannot
acquire the lease records skipped cleanup and never changes endpoint state.
Cleanup success is part of endpoint run completion, not an optional maintenance
action. Provider-backed runs have no endpoint lease but still close worker
resources and record final usage and request state.

The worker verifies `status.state = paused` and `readyReplica = 0` before it
writes `_SUCCESS`. The final snapshot also records `targetReplica`, which may
remain nonzero on a paused endpoint. HF Sandbox environments are killed by
Harbor, and their idle timeout limits abandoned resources if the controller is
terminated. The idle timeout must exceed the longest uninterrupted agent or
verifier command because an active streaming command does not necessarily
refresh the Sandbox idle timer. It must also remain at or below the controller
Job timeout, which is the outer lifecycle bound.

Endpoint pause requests and status reads retry transient provider failures until
the bounded cleanup deadline. Each endpoint CLI call is limited to 60 seconds or
the remaining lifecycle deadline, whichever is shorter. Unexpected local errors
still fail immediately, and an exhausted retry budget is recorded as cleanup
failure. When execution and cleanup both fail, evidence preserves them as
separate failures.

Before benchmark execution, the worker requires `readyReplica` to reach the
positive `targetReplica` count and probes the `healthRoute` reported in the
endpoint snapshot. This prevents startup timing and custom image routing from
changing benchmark validity.

## Boundaries

- No local model loading or inference.
- No benchmark-specific behavior in the `harbor_hf` orchestration package;
  custom-agent behavior belongs to the isolated `harbor-hf-agents` package in
  this repository.
- No raw sessions in public Dataset repositories.
- No secret values in manifests, logs, locks, or artifacts.
- No state that exists only on the submitting machine.
- No direct writes from trial workers to shared Dataset Git repositories.
- No per-campaign, per-profile, per-repair, per-lease, per-status, or
  per-result-subset Hub repository, Bucket, Space, or schedule.
- No new persistent Hub resource without an inventory, an unmet privacy or
  failure-domain requirement, a lifecycle and cost record, and explicit
  approval.

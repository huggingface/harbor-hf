# Harbor Compatibility Contract

This document freezes the Harbor assumptions used by `harbor-hf` while the
generic Harbor-owned execution protocol is developed upstream. New worker and
run attempts use this adapter. Historical evidence can still be read by
the isolated legacy reader.

## Ownership Boundary

Harbor owns the job config, task resolution, custom-agent loading, environment
config, trial execution, locks, results, verifier rewards, exceptions, timing,
token usage, and trial artifact inventory. Workers install Harbor from a pinned
`harbor-framework/harbor` git commit. Upstream Harbor remains unchanged;
Harbor-HF uses only its public APIs and does not monkeypatch Harbor internals.
When a Harbor CLI process exits after writing a trial result, Harbor-HF accepts
success only if that durable result has no trial exception and its emitted lock
exactly matches the prepared lock.

`harbor-hf` owns run, execution, and physical attempt identity, Hugging Face
infrastructure, immutable request storage, endpoint cleanup, infrastructure
retries, policy checks, evidence publication, and normalized result rows. The
planned TypeScript service owns shared run decisions. Pinned Python workers
continue to call Harbor and write attempt evidence, but they do not become a
second control authority. See the [control service
specification](CONTROL_SERVICE.md).

The hosted control path calls Harbor through two generic workers. The
preparation worker resolves the job. The execution worker runs its prepared
trials. Neither worker branches on a benchmark, model, or harness name.
`FilesystemHarborExecutionAdapter` remains outside the hosted new-write path for
historical evidence tools.

## Execution Input

A new run first locks its approved profiles, expected logical tasks, and one
complete resolved execution contract. The TypeScript control service builds the
contract before reservation or admission. It contains the exact Harbor
`AgentConfig`, selected model route, derived root bridge route, provider API,
limits, worker provenance, Harbor version, and source profile IDs.

The model profile supplies the canonical Harbor route. The harness profile
supplies a model-independent custom-agent template and capabilities. The
deployment profile supplies provider and execution policy without another model
route. The resolver checks the combination and derives the final values. A
secret-free preparation Job consumes those locked values, runs the pinned Harbor
git commit, and builds one normal `JobConfig`. It does not bind the model again.
Harbor resolves the dataset and task sources through its public `JobPlan` API.
The preparation worker then writes:

- one immutable `prepared.trial` record per logical task;
- one final `prepared.job` record that binds the ordered trials;
- one SHA-256 digest for the reconstructed Harbor `JobLock`.

Each prepared trial contains the exact Harbor `TrialLock`, source task digest,
container image digest, resource request, and phase time limits. The control
service checks the task against the run lock and selects compatible Hugging
Face Job hardware from the locked execution contract. Prepared and executed
agent, route, API, limit, and worker values must match that contract exactly.

Historical locks without the resolved execution contract remain readable and
immutable. After the profile cutover, they cannot create, resume, or retry
work. The [reusable harness profile plan](2026-08-28-reusable-harness-profiles-plan.md)
defines the cutover and rollback gates. The deployment profile sets
limits and prices but contains no benchmark task catalog.

An execution worker receives the one task assigned to its physical Job. It
fetches that prepared record, reconstructs a one-attempt Harbor `JobConfig`,
and lets Harbor fetch the exact Git or package task. It does not read a dataset
manifest or select tasks again. Harbor's internal retry count remains zero.
After a trial, the worker compares Harbor's emitted `TrialLock` with the
prepared lock before it can submit evidence or an outcome.

A physical Job runs the prepared task from the beginning. If it ends with a
replacement-eligible infrastructure failure, a later Job reconstructs the same
one-attempt Harbor `JobConfig` and starts that task again. A
non-infrastructure terminal outcome is not retried automatically. Harbor's
internal retry count stays zero, and the infrastructure retry does not create
another benchmark trial. The worker does not save or restore conversation,
workspace, process or container state between Jobs.

Both workers install the reviewed Harbor-HF agent package at its immutable
revision and use the pinned Harbor git commit. The preparation worker has no
persistent secret, inference access, or Bucket mount. The execution worker has
no broad control credential or Bucket mount. Its short-lived capability is
scoped to the assigned lock, evidence upload, and attempt receipt. When
inference is required, the Job receives only the inference credential for the
root-owned bridge. The benchmark agent receives only its loopback route and
placeholder key.

A reviewed worker repair may retry an unresolved task with a new worker. A
normal resume is not a repair. Historical retries bind the exact immutable
continuation repair, and unsupported repair paths remain paused. Final evidence
records every physical Job, worker and repair generation, usage and cost for the
logical trial. Valid completed-task receipts stay selected, and recovery runs
only unresolved tasks. A repeated deterministic shared failure pauses the
affected fleet.

## Custom Provider Agents

Every provider-backed agent is loaded through Harbor's public
`AgentConfig.import_path` field. Each custom adapter lives in a separate module
under the `harbor-hf-agents` package. New provider attempts have no fallback to
another harness or wire API.

One internal registry validates the logical agent name, import path, required
wire API, permitted non-secret parameters, trajectory schema, session
requirement, and retry taxonomy. This registry is Python data, not another
serialized protocol. Generic Harbor request, worker, and evidence code perform
a registry lookup and contain no agent-name branches.

Each agent module selects a runtime driver that matches its registered wire API.
For an OpenCode Chat Completions route, the adapter-generated provider entry
declares `npm: "@ai-sdk/openai-compatible"`. The same entry registers the exact
locked model and the loopback bridge base URL. The adapter applies these
route-owned fields after it copies caller `opencode_config`, so unrelated caller
settings remain while conflicting driver, model, and base URL values are
replaced. The bridge continues to reject Responses requests on a Chat
Completions route.

The standalone Codex adapter uses Harbor's pinned Codex implementation and its
native Responses API. It preserves the complete namespaced model ID after
removing only Harbor's provider prefix. It runs under the isolated agent account
and remains distinct from OpenClaw with the Codex runtime.

A deployment is eligible only when its inference API appears in both the model
provider route's native API list and the harness capability list. The control
service rejects an incompatible explicit selection before launch, including a
stale promoted deployment, and automatic selection finds no deployment for an
unsupported model-provider-harness combination. Matrix plans record that cell
as unsupported and skip it without creating a run or treating it as a benchmark
failure. Do not add request translation, response translation, fallback, or
payload rewriting to force compatibility between different inference APIs.

The Terminus profile keeps the public profile name `terminus` and Harbor's
`terminus-2` result identity. Terminus is trusted in-process Harbor code. It
validates the root-owned Job route before execution, uses the locked Chat
Completions loopback route, and always stops the bridge before verifier
execution. Its LiteLLM model information comes from the immutable model and
deployment profiles.

mini-swe-agent receives a finite task cost limit and an exact LiteLLM model
registry derived from the immutable inference contract. The registry preserves
model identity, token limits, and input, output, cache-read, and cache-write
prices. The adapter does not use an unpriced fallback or disable the tool's
cost limit.

The existing pinned worker revision identifies the package implementation. The
agent profile identifies the custom import path and exact underlying agent
revision. Package-backed agents use exact numeric versions; Git-backed agents
use full commits. Harbor's result must report the same logical agent name,
revision, model provider, and model name that the independent verification
policy expects.

## Compatibility Export

After Harbor exits, the adapter runs `harbor_adapter/exporter.py` with the same
pinned Harbor project environment. The exporter imports and validates Harbor's
own `JobLock`, `JobResult`, `TrialLock`, and `TrialResult` models. It emits
`harbor-compatibility.json` with schema
`harbor-hf/harbor-compatibility/v1alpha3`. Readers remain compatible with
`v1alpha2` bundles, which did not include exception messages.

The bundle contains:

- Harbor source revision and package version;
- the immutable request digest;
- checksums and progress counts for each Harbor job lock and result;
- checksums, task and agent identity, model identity, exceptions, verifier
  rewards, timing, usage, and a typed private artifact inventory for each trial;
- no exception tracebacks, environment variables, agent config, task content,
  or secret values.

The exporter retries a transient failure up to three times within the shared
execution deadline. Each attempt is retained in `harbor-export.log`; stale
partial bundles are removed before a retry. Persistent export failures remain
terminal. The normal evidence redaction, secret scan, checksums, and
terminal-marker rules apply to the input, bundle, log, and raw Harbor artifacts
together.

The controller writes `private-artifacts.json` for every direct Harbor trial and
for each complete run physical execution. Entries are sorted,
private-only, size-bounded, and checksummed. A successful provider-agent trial
whose registry definition requires a native session must include a non-empty
session JSONL. Failed and timed-out trials
retain the same requirement record without turning incomplete evidence into a
score. Raw files and this private manifest cannot cross the normalized result
publication boundary.

## Additional Policy

The typed bundle is accepted only when all of these checks pass:

- Harbor revision and request digest match the immutable request;
- the number and names of trials match the fully resolved task set and attempt
  count, including wildcard selectors;
- every trial lock has the expected task content digest;
- custom-agent import path, logical agent name, agent version, model provider,
  and model name match the request;
- trial and multi-step exception fields are empty;
- every trial has at least one finite numeric verifier reward.

A nonzero Harbor exit with a typed trial exception preserves that exception for
run retry classification. Other malformed output from a failed process is
reported as the Harbor process failure. A zero exit without a valid typed
bundle cannot publish success or a score.

## Historical Reader

`harbor_hf.harbor_adapter.legacy` preserves the old `lock.json` and
`result.json` reader for existing evidence and audit tools. New execution paths
do not call it. It can be removed from new-write support only after the
Harbor-owned protocol satisfies the migration conditions in the
[refactor plan](harbor-integration-refactor.md).

## Behavioral Baseline

The remote baseline is run
`20260714T072108Z-7a2b167238-2bbc0a89fe`, produced with Harbor commit
`bd9e606dcb99eb49de70bd741fd846cae5c7ebd1` and OpenClaw `2026.6.11`.
Its evidence is stored under:

```text
hf://buckets/example-org/benchmark-runs/runs/
20260714T072108Z-7a2b167238-2bbc0a89fe
```

Exporter parity was checked against a preserved successful physical execution
from that run using the same Harbor commit. Harbor `0.17.1` validated one
job and one trial, including task digest, agent/model identity, rewards, usage,
and 12 artifact inventory entries.

The canonical job config was also accepted by the pinned Harbor `JobConfig`
parser through `harbor run --config ... --print-config`. No inference, model
weights, endpoint mutation, or remote benchmark was used for either check.

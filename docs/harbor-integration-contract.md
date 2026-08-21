# Harbor Compatibility Contract

This document freezes the Harbor assumptions used by `harbor-hf` while the
generic Harbor-owned execution protocol is developed upstream. New worker and
campaign executions use this adapter. Historical evidence can still be read by
the isolated legacy reader.

## Ownership Boundary

Harbor owns the job config, task resolution, custom-agent loading, environment
config, trial execution, locks, results, verifier rewards, exceptions, timing,
token usage, and trial artifact inventory. Upstream Harbor remains unchanged;
Harbor-HF uses only its public APIs and does not monkeypatch Harbor internals.
When a Harbor CLI process exits after writing a trial result, Harbor-HF accepts
success only if that durable result has no trial exception and its emitted lock
exactly matches the prepared lock.

`harbor-hf` owns campaign and physical execution identity, Hugging Face
infrastructure, immutable request storage, endpoint cleanup, infrastructure
retries, policy checks, evidence publication, and normalized result rows. The
planned TypeScript service owns shared campaign decisions. Pinned Python workers
continue to call Harbor and write attempt evidence, but they do not become a
second control authority. See the [control service
specification](CONTROL_SERVICE.md).

The hosted control path calls Harbor through two generic workers. The
preparation worker resolves the job. The execution worker runs its prepared
trials. Neither worker branches on a benchmark, model, or harness name.
`FilesystemHarborExecutionAdapter` remains outside the hosted new-write path for
historical evidence tools.

## Execution Input

A campaign first locks its approved profiles and expected logical tasks. A
secret-free preparation Job runs the pinned Harbor release and builds one
normal `JobConfig`. Harbor resolves the dataset and task sources through its
public `JobPlan` API. The preparation worker then writes:

- one immutable `prepared.trial` record per logical task;
- one final `prepared.job` record that binds the ordered trials;
- one SHA-256 digest for the reconstructed Harbor `JobLock`.

Each prepared trial contains the exact Harbor `TrialLock`, source task digest,
container image digest, resource request, and phase time limits. The control
service checks the task against the campaign lock and selects compatible Hugging
Face Sandbox hardware from the deployment profile. The deployment profile sets
limits and prices but contains no benchmark task catalog.

An execution worker receives only the tasks assigned to its physical Job. It
fetches their prepared records, reconstructs a one-attempt Harbor `JobConfig`,
and lets Harbor fetch each exact Git or package task. It does not read a dataset
manifest or select tasks again. Harbor's internal retry count remains zero.
After a trial, the worker compares Harbor's emitted `TrialLock` with the
prepared lock before it can submit evidence or an outcome.

Both workers install the reviewed Harbor-HF agent package at its immutable
revision and use the official pinned Harbor release. The preparation worker has
no persistent secret, inference access, Sandbox authority, or Bucket mount. The
execution worker has no persistent secret or Bucket mount and reaches Sandboxes
only through its short-lived capability. The root-owned bridge receives the
inference credential directly from the control service. The benchmark agent
receives only its loopback route and placeholder key.

## Custom Provider Agents

Every provider-backed agent is loaded through Harbor's public
`AgentConfig.import_path` field. Hermes, OpenClaw, OpenClaw Codex, Pi, DeepSeek
Harness, and OpenCode live in separate modules under the `harbor-hf-agents`
package. New provider executions do not select Harbor built-ins and have no
fallback to them.

One internal registry validates the logical agent name, import path, required
wire API, permitted non-secret parameters, trajectory schema, session
requirement, and retry taxonomy. This registry is Python data, not another
serialized protocol. Generic Harbor request, worker, and evidence code perform
a registry lookup and contain no agent-name branches.

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
for each complete campaign physical execution. Entries are sorted,
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
campaign retry classification. Other malformed output from a failed process is
reported as the Harbor process failure. A zero exit without a valid typed
bundle cannot publish success or a score.

## Historical Reader

`harbor_hf.harbor_adapter.legacy` preserves the old `lock.json` and
`result.json` reader for existing evidence and audit tools. New execution paths
do not call it. It can be removed from new-write support only after the
Harbor-owned protocol satisfies the migration conditions in the
[refactor plan](harbor-integration-refactor.md).

## Behavioral Baseline

The remote baseline is campaign
`20260714T072108Z-7a2b167238-2bbc0a89fe`, produced with Harbor commit
`bd9e606dcb99eb49de70bd741fd846cae5c7ebd1` and OpenClaw `2026.6.11`.
Its evidence is stored under:

```text
hf://buckets/example-org/benchmark-runs/campaigns/
20260714T072108Z-7a2b167238-2bbc0a89fe
```

Exporter parity was checked against a preserved successful physical execution
from that campaign using the same Harbor commit. Harbor `0.17.1` validated one
job and one trial, including task digest, agent/model identity, rewards, usage,
and 12 artifact inventory entries.

The canonical job config was also accepted by the pinned Harbor `JobConfig`
parser through `harbor run --config ... --print-config`. No inference, model
weights, endpoint mutation, or remote benchmark was used for either check.

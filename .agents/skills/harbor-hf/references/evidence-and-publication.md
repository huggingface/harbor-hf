# Evidence and publication

Harbor-HF publishes only from canonical private evidence in the artifact
Bucket. The control service verifies immutable objects and rebuilds its
disposable projection from them. Browsers never read the Bucket directly.

## Evidence hierarchy

```text
Run lock
prepared Harbor job
logical trial
physical attempt
content-addressed evidence manifest
selected attempt receipt
terminal logical record
normalized result
publication receipt
```

A replacement physical attempt creates a new identity and never overwrites a
prior attempt. Terminal markers are written last and bind the complete child
manifest.

## Complete physical attempt

A scored attempt normally needs:

- immutable Run, execution, and Harbor locks;
- Harbor compatibility bundle and native result;
- frozen post-agent workspace archive and file index;
- native session and ATIF trajectory when required;
- verifier reward, scorecard, stdout, and stderr;
- source, model, agent, worker, and image provenance;
- infrastructure observations;
- exact credential scan;
- complete checksums; and
- terminal receipt after validation.

A zero reward may be complete. Missing required evidence may not.

Use Harbor's accepted result and locked prices for available cost data. Leave
unavailable usage unknown.

## Workspace boundary

Capture `/app` only after the agent and descendants stop and before
verification. The frozen copy is the verifier input. Verifier-created files
belong to verifier evidence and do not alter the authoritative post-agent
workspace.

The archive and index must agree on paths, node types, modes, sizes, digests,
and safe symlink targets. Reject unsupported nodes, unsafe paths, changing
files, limit overflow, or known credentials.

## Session, trajectory, and verifier evidence

Retain the exact native session selected by the harness contract and valid ATIF
when required. Preserve tool calls, timing, role order, and termination
semantics without inventing missing content.

Verifier evidence binds the locked task, frozen workspace, native reward,
scorecard, logs, and optional judge exchange. Judge evidence must omit
credentials, cookies, authorization headers, and signed capabilities.

## Validation

Structural validation checks schemas, strict fields, paths, identities,
references, ordering, media types, timestamps, and completion rules.

Digest validation reads every referenced object and checks exact size and
SHA-256. Deep validation streams workspace archives, parses sessions and
trajectories, verifies verifier references, and compares restored content with
the file index.

```bash
uv run harbor-hf artifacts verify-trial <trial-root> --deep
uv run harbor-hf artifacts restore-trial <trial-root> <empty-destination>
uv run harbor-hf artifacts verify <run-id> \
  --namespace <namespace> \
  --format json > artifacts-verify.json
```

Restore only into a new empty destination. Download private evidence through an
approved credential path before local validation.

## Credential scanning

Load known injected values from the approved secret store without printing
them. Scan path components and regular-file bytes in:

- workspaces and indexes;
- sessions and trajectories;
- verifier and judge evidence;
- Harbor, worker, and tool logs;
- manifests, locks, failures, compatibility bundles, and checksums; and
- normalized public candidates and publication receipts.

Also scan for high-confidence API keys, bearer tokens, private keys, cookies,
signed URLs, capabilities, and secret query parameters.

Report only the file, detector category, and count needed for remediation.
Never print matching bytes. A known credential in canonical attempt evidence
invalidates that attempt; do not rewrite the evidence to disguise the leak.

## Result review

Independently compute:

- expected logical task denominator;
- selected task and attempt distribution;
- reward count and finite-value checks;
- strict pass count and mean reward;
- per-task pass count for repeated protocols;
- semantic outcome counts;
- infrastructure-exhausted, cancelled, and invalid counts; and
- physical replacement count and reasons.

Do not present infrastructure exhaustion as a model answer. Partial,
diagnostic, corrected, manually selected, or composite outputs require explicit
labels and separate cohorts.

For hosted inference, publish only observable facts. If the served model commit
or runtime configuration is not proven, report it as `not_observed` or unknown.

## Publication

Publication is a deterministic control action after:

- every logical task is sealed;
- every physical action has a receipt;
- required evidence validates;
- managed Endpoint cleanup is verified; and
- result-class policy is satisfied.

The action writes immutable normalized tables, catalogs, and a publication
receipt. A publication failure does not reopen benchmark execution.

Record the publication ID, Run ID, object paths and digests, schema version,
row counts, score summary, result class, source evidence roots, Endpoint cleanup
state, and public destinations.

Public output may include approved normalized fields and traces. It must omit
raw workspaces, private sessions, credentials, capabilities, private object
keys, and private deployment topology.

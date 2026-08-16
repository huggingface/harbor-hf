---
title: Harbor-HF Control Service Plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-16
tags: [harbor, hugging-face, campaigns, control, storage]
---

# Harbor-HF control service plan

Launching a supported benchmark should require a benchmark, a model, a harness,
and a budget. It should not require a new manifest generator, a new Hub
repository, a new Bucket, or manual recovery after completed model work.

This plan replaces Harbor-HF's Git-backed live coordination with one private
control Space and the existing private evidence Bucket. It also consolidates
new result publication into one existing Dataset per namespace. Historical
campaigns and publications remain immutable and readable.

**Status.** Proposed. The current coordination Dataset and detached controller
Job remain authoritative until this plan is implemented and the new-write
cutover is complete.

## Decision

Build one private, always-on Docker Space per Harbor-HF namespace. The Space is
the only normal writer of shared campaign decisions. It exposes the control API,
runs reconciliation, launches and adopts HF Jobs, manages endpoints, and
finalizes publication.

Use the existing private `benchmark-runs` Bucket as the permanent record for
control objects, profiles, evidence, actions, and receipts. Use local SQLite in
the Space only as a fast projection that can be deleted and rebuilt from the
Bucket. Do not place a SQLite database file on a Bucket mount.

Reuse the existing `benchmark-run-index` Dataset as the one normalized result
store for new publications. It will contain detailed publication tables and the
global catalog in one commit. The existing Harbor Results Space will read that
Dataset.

Keep the separate backup Bucket. A backup in the primary Bucket would share the
same failure domain and would not be a useful backup.

## Decision evidence

The August 2026 four-model ShellBench campaign produced ten incident records.
Two of four final results needed a one-task replacement linked to 88 preserved
parent outcomes. Several controller Jobs completed model work and then failed
while updating control or publication state.

The minimum worthwhile result is:

- a supported campaign takes less than one minute of human work to submit;
- the submitting terminal may disconnect immediately after receiving a run ID;
- completed logical tasks never run again;
- retryable infrastructure failures are repaired without an operator-authored
  manifest;
- publication failure cannot change benchmark completion;
- endpoints are paused after terminal work even when the control Space restarts;
- routine campaigns create no Hub repositories, Buckets, Spaces, or schedules;
- an operator is needed only for budget approval, provider substitution,
  credential exposure, deterministic shared defects, or unresolved provenance.

The benchmark's actual runtime, endpoint startup, and HF queue time are outside
this target.

## Ownership boundary

Harbor keeps its current responsibilities:

- task resolution;
- agent and environment execution;
- verifier behavior;
- trajectories and trial results;
- typed trial failures and timing.

Harbor-HF owns:

- reusable model, deployment, harness, benchmark, and launch-policy profiles;
- campaign expansion and logical identity;
- HF Job, Provider, Endpoint, Sandbox, Space, and Bucket integration;
- infrastructure retry and repair decisions;
- budget admission and endpoint cleanup;
- private evidence retention;
- normalized result publication.

The control Space is a deployment of Harbor-HF. It does not belong in Harbor
core. Harbor-HF must continue to use Harbor's public interfaces without patches
or benchmark-specific branches.

## Canonical Hub resources

A namespace should have this fixed Harbor-HF resource set:

| Resource | Purpose | New-write status |
|---|---|---|
| `huggingface/harbor-hf` | Source, schemas, built-in profiles, and Space code | Keep |
| `<namespace>/harbor-hf-control` private Space | Control API and reconciler | Create once |
| `<namespace>/benchmark-runs` private Bucket | Control objects, profiles, evidence, and receipts | Reuse |
| `<namespace>/benchmark-run-index` private Dataset | Normalized result tables and catalog | Reuse and expand |
| `<namespace>/harbor-results` Space | Sanitized result presentation | Keep |
| `<namespace>/benchmark-run-backups` private Bucket | Independent evidence backups | Keep separate |
| `<namespace>/jobs-artifacts` Bucket | HF-managed Job input staging | Leave platform-managed |

The private control Space is the only planned persistent Hub resource that does
not already exist in the current `osolmaz` deployment. It cannot be combined
with the public Harbor Results Space because the control API holds private
campaign state and can spend compute.

Runtime code must not create a repository, Bucket, Space, or scheduled Job for
a campaign, repair, profile, lease, status record, result subset, or temporary
workflow. Namespace bootstrap is a separate, idempotent operator action that may
create only missing resources from the approved canonical inventory. Any other
persistent resource requires a documented privacy, access, retention, or
failure-domain reason and explicit operator approval.

## Existing resource disposition

The cutover changes new writes only. Existing objects remain available at their
recorded revisions and paths.

| Existing resource | Disposition |
|---|---|
| `<namespace>/harbor-hf-coordination` Dataset | Freeze after active campaigns finish; retain for historical audit |
| `<namespace>/shellbench-results` Dataset | Freeze after the unified catalog references every retained publication at its exact historical revision |
| `<namespace>/harbor-hf-smoke-results` Dataset | Freeze as historical smoke evidence |
| `<namespace>/shellbench-job-status` Dataset | Freeze as historical detached-Job control evidence |
| `<namespace>/harbor-hf-leases` Bucket | Keep unused during migration; remove only after an explicit empty-resource audit and approval |
| `<namespace>/benchmark-run-reassessments` Bucket | Freeze; write new reassessments under `benchmark-runs` |
| `<namespace>/benchmark-run-backups` Bucket | Keep as the separate backup destination |

Independent datasets such as `almanbench-results`, `qrlow-evals-results`, and
`aacr-bench-harbor` are outside this change. They need their own ownership,
visibility, and reader audit before any consolidation decision.

Do not copy historical evidence merely to make the new layout look uniform.
Preserve old locations and record them in the unified result catalog.

## Control Space

The control Space runs a single Harbor-HF application process on an always-on
CPU tier. Its responsibilities are:

- authenticate operators and accept campaign requests;
- resolve approved profiles into a complete immutable campaign lock;
- write the lock before remote work;
- maintain the campaign and task state machines;
- write action intents before external side effects;
- launch or adopt HF Jobs by deterministic labels;
- admit retries and repairs;
- reserve and reconcile spend;
- manage endpoint actions and the independent cleanup watchdog;
- verify evidence and select terminal logical outcomes;
- publish normalized results;
- serve campaign status and audit views.

The Space exposes at least these API operations under the existing `v1`
contract:

```text
POST /v1/campaigns
GET  /v1/campaigns/{campaign_id}
POST /v1/campaigns/{campaign_id}/cancel
POST /v1/campaigns/{campaign_id}/retry
POST /v1/campaigns/{campaign_id}/resume
GET  /v1/profiles
GET  /v1/profiles/{kind}/{id}
```

The CLI becomes a client of this API. `campaign submit` returns the campaign ID
as soon as the lock and initial action intent are durable. The Space continues
after the local process exits.

The Space stores no irreplaceable state on its local filesystem. Local SQLite
contains a query and scheduling projection. Startup recreates that projection
from Bucket objects before accepting writes. A periodic projection snapshot may
speed startup, but every snapshot must be disposable and bound to the exact set
of source object digests.

A future move to multiple active control replicas would require a transactional
shared database or another single-writer mechanism. Multi-replica control is
outside this plan because current campaign volume does not justify that cost.

## Bucket layout

The existing private Bucket gains a control prefix while keeping canonical run
evidence under campaign and run prefixes.

```text
control/schema=v1/
  profiles/
    objects/<kind>/sha256-<digest>.json
    promotions/<kind>/<alias>/<event-id>.json
  campaigns/<campaign-id>/
    request.json
    campaign.lock.json
    actions/<action-id>/intent.json
    actions/<action-id>/receipt.json
    tasks/<task-id>/attempts/<attempt-id>/receipt.json
    tasks/<task-id>/terminal/<receipt-digest>.json
    resources/endpoints/<action-id>.json
    budgets/<event-id>.json
    publications/<publication-id>.json
    snapshots/<snapshot-digest>.json
campaigns/<campaign-id>/
  runs/<run-id>/
    ... canonical evidence ...
reassessments/<reassessment-id>/
  ... canonical evidence ...
```

Every shared control object is immutable. Mutable views are derived from those
objects. Object keys include a stable identity or content digest. Rewriting an
existing key with different bytes is an integrity failure.

The control Space writes campaign locks, shared actions, terminal selections,
budget decisions, and publication receipts. Workers write only to their own
physical attempt and evidence paths. Workers never edit a campaign summary,
logical task terminal record, profile alias, or result Dataset.

The Space may cache Bucket listings, but it must confirm source digests before a
cached view can authorize paid work.

## Profiles

Harbor-HF already models models, deployments, and agents as profiles inside an
experiment manifest. The new profile system makes those records reusable.

Built-in profiles live under `profiles/` in the existing Harbor-HF source repo.
They cover public, portable configuration. Namespace-specific records, such as
an approved private endpoint binding, live as immutable objects in the existing
private Bucket.

The profile kinds are:

- model;
- deployment;
- harness;
- benchmark;
- launch policy.

A harness profile binds the Harbor agent identity, custom-agent import path,
package or source revision, worker revision, context requirements, tool
capabilities, and required trajectory or session evidence. Pi, Hermes,
OpenClaw, and other agents use the same profile contract.

Profiles combine complete records and have no inheritance. A launch selects one
profile of each required kind. The resolver validates capability compatibility
and writes every resolved field into `campaign.lock.json`. The lock never depends
on a later catalog lookup.

Friendly aliases may move only through a promotion receipt that identifies the
immutable profile digest, actor, reason, and canary evidence. Candidate,
recommended, and approved states remain distinct. A metric lead alone cannot
promote a model or deployment profile.

Profiles contain secret names and access requirements, never secret values.

## Campaign submission

A normal operator request supplies:

```text
benchmark profile + model profile + harness profile + budget
```

An explicit deployment profile is optional when one approved compatible route
exists. Ambiguous or unapproved choices stop before paid work.

Submission follows this order:

1. Authenticate the operator.
2. Resolve aliases to immutable profile objects.
3. Validate model, deployment, harness, benchmark, and policy compatibility.
4. Resolve the complete task set and exact task digests.
5. Calculate the plan, duration range, and cost ceiling.
6. Require approval when the paid-compute policy requires it.
7. Write the request and complete campaign lock to the Bucket.
8. Write the first deterministic action intent.
9. Return the campaign ID.
10. Continue reconciliation in the Space.

No Hub resource is created during submission.

## Safe external actions

Every HF Job or Endpoint mutation uses a deterministic action ID derived from
the locked campaign, action kind, target, and generation.

The Space writes `intent.json` before calling the external API. The HF Job or
Endpoint action carries the same ID in labels or managed metadata. The Space
writes `receipt.json` after it observes the remote identity and state.

Recovery handles each crash window:

- An intent with no visible remote action remains pending until the API's
  visibility delay has passed, then may be issued once.
- An intent with a matching Job or endpoint is adopted without another create
  or launch.
- A receipt with a mismatched remote identity stops the campaign.
- A terminal logical task prevents every later execution action for that task.
- A matching existing receipt is success; different bytes are an integrity
  conflict.

This is the transactional outbox pattern expressed with immutable Bucket
objects and deterministic HF labels. The single control writer removes the need
for a Git parent-commit claim.

## Trial completion and repair

A worker receives a fixed set of logical task IDs and new physical attempt IDs.
It runs Harbor without internal benchmark retries.

For each physical attempt, the worker:

1. verifies the exact input bundle;
2. runs Harbor;
3. freezes and validates the workspace;
4. uploads evidence and checksums;
5. verifies that the uploaded evidence is complete;
6. writes the physical attempt receipt last;
7. reports the receipt identity to the control Space when it is reachable.

The Space verifies the receipt before selecting a logical terminal outcome. A
missing callback is harmless because reconciliation discovers the Bucket
receipt.

Completed, invalid, semantic, refusal, verifier, agent, and benchmark-timeout
outcomes are terminal according to the locked policy. Only a proven retryable
infrastructure outcome may receive a new physical attempt. A replacement never
creates a new logical benchmark attempt.

When 88 of 89 outcomes are terminal and one has a retryable infrastructure
failure, the Space launches only that task. The final campaign result records
all physical attempts and selects one terminal outcome for each logical task.
Manual replacement manifests and hand-built linked aggregates disappear from
the normal workflow.

A shared deterministic defect stops admission for every affected campaign until
a reviewed worker or data correction creates a new approved action contract.

## Endpoint safety

The control Space keeps the current independent endpoint safety boundary.
Before it resumes or creates an endpoint, it launches the cleanup watchdog and
verifies that the watchdog owns the managed endpoint identity.

The watchdog may pause the endpoint and verify zero ready replicas. It then
writes a cleanup receipt. It cannot launch trial work, select results, or
publish scores.

The Space also configures scale-to-zero when supported. Scale-to-zero is a
fallback and does not replace explicit verified pause.

A campaign cannot complete until endpoint cleanup is verified. A Space restart
must not cancel the watchdog.

## Budget control

The campaign lock records the approved cumulative ceiling and the pricing or
manifest-ceiling basis for every route.

The Space writes a reservation before launching paid work. It reconciles the
reservation with observed usage and billing evidence when available. Unknown
pricing retains the approved reservation instead of reporting an invented
actual cost.

Infrastructure replacements, failed Jobs, endpoint active time, repairs, and
reassessments count against the same campaign budget. A changed provider,
hardware type, method, or reuse assumption stops automatic continuation.

## Result publication

New publications use one normalized results Dataset per namespace. The existing
`benchmark-run-index` Dataset becomes that store and stops pointing at a second
benchmark-specific Dataset.

One parent-checked publication commit contains:

- normalized run rows;
- trial rows;
- execution rows;
- metric rows;
- artifact metadata rows;
- the immutable publication receipt;
- primary and audit catalog projections.

The private evidence Bucket remains canonical. The Dataset remains a sanitized,
queryable projection. The Harbor Results Space serves public views without
exposing private sessions or task data.

Publication runs after campaign completion and may retry independently. A
publication conflict cannot reopen a task, launch a model request, or change the
campaign's terminal state. Existing matching bytes are adopted.

Historical result Datasets remain immutable. Their exact revisions and source
checksums stay in catalog records even after new publication moves to the
unified Dataset.

## State model

The Space projects immutable records into the existing campaign vocabulary:

```text
queued -> active -> verifying -> publishing -> completed
   |         |          |             |
   +------> manual_intervention <------+
   +------> partial
   +------> failed
   +------> cancelled
```

Logical tasks retain separate terminal outcomes for complete, invalid,
infrastructure failure, cancellation, and policy failure. Physical attempts
remain append-only children of one logical task.

Observed state, recommended action, and approved action remain separate. The
Space cannot turn a recommendation into approval.

## New-write switch

The change replaces new-write behavior in place. It does not add a second
production mode.

Cutover prerequisites are:

- no active campaign controller or wave Jobs;
- no active Harbor-HF scheduled recovery Jobs;
- all managed endpoints paused with zero ready replicas;
- the control Space deployed at an exact source revision;
- the Bucket object schema and result Dataset schema verified;
- every active publication inventoried;
- a complete backup and restore test;
- launch, crash, repair, publication, and cleanup canaries passed;
- the operator has approved the paid always-on Space and any remote canary cost.

At the boundary:

1. Reject new submissions through the coordination Dataset path.
2. Freeze its exact head in the migration record.
3. Start the control Space write API.
4. Route all new `v1` campaign requests through the Space.
5. Stop creating benchmark-specific result Datasets.
6. Publish new normalized results to the unified Dataset.
7. Suspend obsolete recovery schedules.
8. Mark historical resources read-only in the resource inventory.

There is no dual-write period. New campaign code does not read the old
coordination Dataset. Historical audit tools may continue to read it.

## Implementation stages

### Contracts

- Define Bucket object schemas for profiles, actions, attempts, terminal
  selections, budgets, resources, and publications.
- Define deterministic IDs and canonical JSON encoding.
- Add a namespace resource registry that permits only the canonical resources.
- Replace manifest-owned artifact and publication destinations with canonical
  namespace configuration.
- Add profile references and full lock expansion to the existing `v1` format.

### Storage and projection

- Implement `BucketControlStore` with immutable create, list, and digest checks.
- Implement a local SQLite projection that rebuilds from Bucket objects.
- Add property tests for replay order, duplicate objects, conflicting bytes,
  partial uploads, and stale snapshots.
- Keep workers on disjoint attempt paths.

### Control Space

- Add the private Docker Space entrypoint and authenticated API.
- Add one background reconciler with bounded work cycles.
- Implement action intents, remote adoption, and receipts.
- Add health, readiness, and projection-rebuild status.
- Keep the Space wrapper small and pin Harbor-HF by exact revision.

### Profiles and submission

- Extract repeated built-in profiles from current manifests.
- Add namespace profile objects and promotion receipts in the Bucket.
- Add compatibility checks and automatic selection of one approved deployment.
- Make the CLI submit profile references to the Space and return the campaign ID
  immediately.

### Workers and recovery

- Change controller and wave workers to report physical attempt receipts rather
  than shared Git events.
- Add Bucket discovery when callbacks are missed.
- Add automatic one-task and multi-task infrastructure repair.
- Preserve the independent endpoint watchdog.
- Remove coordination Dataset claims and heartbeat commits.

### Results

- Extend the existing index Dataset schema to hold detailed normalized tables.
- Make one commit publish detail rows, receipts, and catalog projections.
- Update the Harbor Results Space to read the unified layout.
- Inventory and freeze historical result Datasets after verification.

### New-write switch

- Run all cutover prerequisites.
- Switch submission to the Space API.
- Remove old production writers and compatibility branches.
- Freeze historical resources without deleting evidence.
- Update architecture, format, operation, recovery, and publication docs to
  describe shipped behavior.

## Acceptance criteria

The implementation is ready only when all of these pass:

- A known built-in profile launches from benchmark, model, harness, and budget
  inputs without an operator-authored manifest.
- Submission returns a campaign ID after durable lock creation in under one
  minute of operator time.
- Closing the submitting terminal does not affect progress.
- Killing the Space before a Job launch, after a launch response, after evidence
  upload, and during publication causes no duplicate logical task execution.
- A controller restart adopts Jobs and endpoints by deterministic action ID.
- A representative 89-task campaign preserves every complete task after one
  injected sandbox infrastructure failure and reruns only the missing task.
- A semantic zero, refusal, benchmark timeout, and verifier failure remain
  terminal.
- Publication failure retries without changing campaign or task state.
- Endpoint-backed success and failure both end paused with zero ready replicas.
- Provider, endpoint, Job, repair, and reassessment costs remain under one
  approved cumulative ceiling.
- Secret scans find no token values, authorization headers, private capability
  URLs, or operator paths.
- A clean namespace launch creates no repository, Bucket, Space, or schedule
  beyond the approved canonical inventory.
- Historical campaign and publication checksums remain unchanged.
- The local quality, mutation, schema, documentation, dependency, and Space
  build gates pass.

## Verification

Local checks:

```bash
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov=src/harbor_hf --cov-fail-under=85
uv run python scripts/check_mutation.py --min-kill-rate 90
uv run slophammer-py dry .
uv run pip-audit
npx -y @simpledoc/simpledoc check
```

State-machine tests must inject process termination at every external action
boundary and replay the resulting Bucket objects in different listing orders.
The selected terminal outcomes and next actions must remain identical.

Remote checks must use purpose-scoped credentials and the existing canonical
resources. Start with a no-inference CPU canary, then a bounded provider canary
below the autonomous spend threshold. Paid work beyond that boundary requires a
new measured estimate and explicit approval.

Before and after each remote canary, record:

```bash
hf repos list --type dataset --format json
hf repos list --type bucket --format json
hf repos list --type space --format json
hf jobs list --format json
hf endpoints list --format json
```

The resource inventory must show no unapproved persistent resource. Every
endpoint must be paused after terminal work.

## Non-goals

This plan does not:

- move HF-specific control into Harbor core;
- change benchmark tasks, verifier semantics, or scoring;
- run inference locally;
- rewrite historical Bucket objects or Dataset commits;
- combine the primary evidence Bucket with its backup;
- create a general multi-cloud scheduler;
- provide active-active control Space replicas;
- consolidate independent non-Harbor-HF datasets without a separate audit.

## Assumptions and open questions

The design assumes one active control writer per namespace. The Bucket is the
permanent record, and temporary Space downtime is acceptable because Jobs keep
running and endpoint watchdogs remain independent.

Before implementation, confirm:

- the paid CPU tier and monthly ceiling for the always-on private Space;
- the exact private Space authentication and workload-token scopes;
- the Bucket listing and startup-rebuild target at the current object count;
- whether to keep the `benchmark-run-index` name after it becomes the unified
  results Dataset;
- the retention period for obsolete claims, status records, and reassessment
  objects;
- the review and approval policy for namespace-specific profile promotion.

These questions may change deployment details. They do not change the one-Space,
one-primary-Bucket, one-results-Dataset design.

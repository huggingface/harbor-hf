---
title: Harbor-HF Control Service Plan
author: Harbor-HF maintainers
date: 2026-08-16
tags: [harbor, hugging-face, campaigns, control, storage]
---

# Harbor-HF control service plan

Launching a supported benchmark should require a benchmark, a model, a harness,
and a budget. It should not require a new manifest generator, a new Hub
repository, a new Bucket, or manual recovery after completed model work.

This plan replaces Harbor-HF's Git-backed live coordination with one publicly
reachable, application-protected control Space, one private Bucket, and one
operator-managed persistent Space secret. The Bucket holds control state, evidence, profiles, normalized results,
and the catalog.
Historical campaigns and publications remain immutable and readable.

**Status.** Approved for implementation. The current coordination Dataset and
detached controller Job remain authoritative until the implementation passes
its production gates and the new-write cutover is complete.

## Web reliability and production usability

The production web application must use SSE as its main update path. While SSE
is connected, active queries do not poll. When the connection is down, visible
pages may refresh active non-session queries once per minute. Typed control
events refresh only the affected campaign, task, resource, profile, result, or
audit queries. They never refresh the browser session.

A valid browser session remains usable through transient rate limits, server
errors, and network loss. Only a `401` response signs the user out. The browser
keeps the last valid shell and query data, respects `Retry-After`, uses bounded
delayed retries, and labels stale data. Error states distinguish offline,
rate-limited, forbidden, missing, and server-failure responses and may show a
safe request ID.

OAuth subjects remain the access-control and audit identity. The browser
session returns the Hugging Face username, role, transport, and expiry without
returning the OAuth subject. Login returns only to a validated same-origin
route. Users can sign out from the application. Sessions remain in the local,
disposable service database and are lost when the Space restarts. This is an
explicit availability tradeoff: signing in again is safe and infrequent, so a
new persistent session store is not justified.

Write role and write mode are separate checks. An operator can have permission
to write while the deployment has writes disabled. Every browser mutation is
disabled unless both checks pass, with a clear explanation. Server-side role,
CSRF, write-mode, policy, and budget checks remain authoritative.

Campaign launch uses approved profile aliases rather than free text. Before
submission, the browser shows each immutable profile ID and safe resolved spec,
task count, model revision, hardware, attempt limit, estimated reservation, and
the exact dollar ceiling. The request keeps exact `ceiling_microusd` units.

The integrated results browser replaces the archived viewer for normal result
inspection. It provides bounded server-side model, benchmark, agent, status,
and date filters, text search, useful sorting, and stable result detail routes.
The detail view shows scores, task counts, revisions, the campaign link, and
allowlisted provenance. Existing evidence redaction and cursor limits still
apply.

The system view shows the complete copyable source revision, whether writes are
disabled, the projection state, and the last successful projection update.
Live status means one of connected, reconnecting, offline, or stale and includes
the last successful update. It does not imply that a benchmark is running.

Acceptance for this slice requires focused unit and browser tests for rate
limits, server and network failures, SSE reconnect, no polling while connected,
typed invalidation, session preservation, username display, hidden OAuth
subjects, disabled writes, safe return paths, stale data, and result and campaign
errors. Run the generated-contract check, formatting, lint, type checks, unit
tests, browser tests, build, dependency checks, SimpleDoc, and public privacy
check before publication.

This slice does not deploy or change the live Space, add a persistent store,
change ACL keys, expose private evidence, or weaken server-side enforcement.

## Decision

Build one publicly reachable, application-protected, always-on Docker Space per
Harbor-HF namespace. The Space is the only normal writer of shared campaign
decisions. It exposes the control API,
runs reconciliation, launches and adopts HF Jobs, manages endpoints, and
finalizes publication.

Use the existing private `<artifact-bucket>` Bucket as the permanent record for
control objects, profiles, evidence, actions, receipts, normalized results, and
the global catalog. Resolve its deployed name only in private configuration.
Use local SQLite in the Space only as a fast projection that can be deleted and
rebuilt from the Bucket. Do not place a SQLite database file on a Bucket mount.

The same control Space serves the protected control API and results UI. Do
not keep a second results Space, a result Dataset, or a backup Bucket in the
steady-state Harbor-HF architecture.

Implement the shared control authority in TypeScript. One Node.js process runs
the Fastify API, background reconciler, local projection, Server-Sent Events,
and compiled React application. Existing Python benchmark workers may remain as
pinned remote Job artifacts, but Python must not retain a second shared control
or reconciliation path. The [control service specification](CONTROL_SERVICE.md)
defines the runtime and web application contract.

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
- one authenticated web application shows logical progress, physical retries,
  cost, publication, cleanup, and endpoint safety without direct Bucket access;
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
| `huggingface/harbor-hf` | Source, schemas, built-in profiles, and Space code | Keep outside the runtime resource count |
| `<namespace>/<control-space>` protected public Space | Control API, reconciler, and authenticated results UI | Create once |
| `<namespace>/<artifact-bucket>` private Bucket | Control objects, profiles, evidence, receipts, normalized results, and catalog | Reuse |

Resolve both deployed names in private configuration. Do not record a real
namespace or private resource name in this public repository. These two
resources are the complete Harbor-HF runtime inventory. HF-managed Job staging
is shared platform infrastructure and is not a Harbor-HF runtime resource.

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
| `<namespace>/<legacy-coordination-dataset>` | Freeze after active campaigns finish; retain for historical audit |
| `<namespace>/<legacy-results-dataset>` | Freeze after every retained publication is represented in the Bucket catalog |
| `<namespace>/<legacy-smoke-dataset>` | Freeze as historical smoke evidence |
| `<namespace>/<legacy-status-dataset>` | Freeze as historical detached-Job control evidence |
| `<namespace>/<legacy-index-dataset>` | Copy verified normalized rows and catalog records into the Bucket, then freeze |
| `<namespace>/<legacy-results-space>` | Retire after the control Space serves the verified results UI |
| `<namespace>/<legacy-lease-bucket>` | Remove only after an explicit empty-resource audit and approval |
| `<namespace>/<legacy-reassessment-bucket>` | Freeze; write new reassessments under `<artifact-bucket>` |
| `<namespace>/<legacy-backup-bucket>` | Verify unique objects, copy any required records into `<artifact-bucket>`, then retire |

Independent project datasets are outside this change. They need their own
ownership, visibility, and reader audit before any consolidation decision.

Do not copy historical evidence merely to make the new layout look uniform.
Preserve old locations and record them in the unified result catalog.

## Control Space

The control Space runs one Node.js process and one Fastify server on an
always-on CPU tier. The process serves `/api/v1`, the Server-Sent Events stream,
and the compiled React application. It also runs one bounded background
reconciler and maintains one disposable local SQLite projection.

The process authenticates operators, resolves approved profiles, writes
campaign locks, advances campaign and task state, launches or adopts remote
resources, admits repairs, reserves spend, verifies cleanup, publishes results,
and serves status and audit views. Every remote action follows the same
intent-observe-receipt protocol.

The API provides campaign, task, Job, Endpoint, profile, result, audit, and
system resources. Mutations require idempotency keys and return `202 Accepted`
after their immutable intent is durable. The CLI becomes a thin client of this
API and returns the campaign ID without retaining local control authority.

The web application uses React, Vite, strict TypeScript, Tailwind CSS,
shadcn/ui, React Router, TanStack Query, and TanStack Table. It presents logical
progress separately from physical retries, including budget, publication, and
cleanup state. Browser types come from the API's OpenAPI document.

The Space stores no irreplaceable state on its local filesystem. Kysely and
`better-sqlite3` maintain a query and scheduling projection. Startup may use a
verified snapshot, then replays immutable Bucket objects before it accepts
mutations. Liveness stays available during replay; readiness reports rebuilding.

Free `cpu-basic` hardware may sleep after 48 hours without visitors. Production
therefore uses a paid CPU tier with sleep disabled. The lowest documented price
at the time of this plan is about `$0.03` per hour, or `$21.90` for a 30-day
month. The exact tier, current price, and monthly ceiling require approval before
deployment. Development may remain on free CPU. An external keep-awake schedule
is not allowed.

A future move to multiple active control replicas would require a transactional
shared database or another single-writer mechanism. Multi-replica control is
outside this plan because current campaign volume does not justify that cost.

## Credential model

The control Space has exactly two operator-managed persistent secrets.
`HF_TOKEN` is the approved fine-grained control credential for the control
Space, `<artifact-bucket>`, HF Jobs, and managed Endpoints.
`HF_INFERENCE_TOKEN` is a distinct inference-only credential for serverless and
Endpoint inference calls. Credential display names and local aliases remain
private.

The control Space also enables Hugging Face OAuth for verified user identity.
Hugging Face injects the OAuth client configuration; those platform-managed
values are not additional operator-managed service credentials. An immutable
private Bucket record holds the operator and reader access lists. Verified
users outside both lists have no control access. Browser sessions and CSRF state remain disposable local
state.

The Space never injects `HF_TOKEN` into a Job and never gives a Job a writable
mount of the canonical control Bucket. It derives a short-lived, signed worker
capability for the exact campaign, launch action, and task set. The API accepts
that capability only on the campaign-lock and attempt-receipt routes, and it
records the worker as a service actor. A locked deployment marks inference as
`required` or `forbidden`. Only a required, reviewed worker receives
`HF_INFERENCE_TOKEN`; a forbidden deployment receives no operator-managed
secret. Campaign-specific provider credentials are not persistent control-Space
secrets.

Do not mint another Harbor-HF credential for a migration, campaign, repair, or
worker. Before revoking a control credential, audit every consumer and run a
canary with only the retained credential configured. Never record a credential
value, display name, or local alias in the repository, Bucket, Dataset, logs, or
chat.

Inference-credential rotation may use a short, explicitly approved overlap.
Create the replacement for new Jobs, wait until Jobs using the prior value are
terminal, and then revoke the prior value. The overlap must not become a
permanent active and standby pair.

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
results/schema=v1/
  publications/<publication-id>/receipt.json
  rows/runs/<digest>.parquet
  rows/trials/<digest>.parquet
  rows/executions/<digest>.parquet
  rows/metrics/<digest>.parquet
  rows/artifacts/<digest>.parquet
  catalog/<window>/<digest>.parquet
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
logical task terminal record, profile alias, result projection, or catalog
record.

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

The Space writes `intent.json` before calling the external API. Before the first
Job create request, it also writes an immutable action-dispatch fence. The HF
Job or Endpoint action carries the same action ID in labels or managed metadata.
The Space writes `receipt.json` after it observes the remote identity and state.

Recovery handles each crash window:

- A Job launch first performs an adoption-only lookup. When no match exists, the
  control service writes the dispatch fence before issuing the one allowed
  create request.
- Once the fence exists, the action waits through the visibility delay and stays
  adoption-only. A lost response or process exit can never issue a second Job
  create for the same action.
- An intent with a matching Job or endpoint is adopted without another create
  or launch.
- A receipt with a mismatched remote identity stops the campaign.
- A terminal logical task prevents every later execution action for that task.
- A matching existing receipt is success; different bytes are an integrity
  conflict.

This is the transactional outbox pattern expressed with immutable Bucket
objects and deterministic HF labels. The single control writer removes the need
for a Git parent-commit claim.

### Sandbox command ambiguity

`sandbox.exec` is not replay-safe. A lost response can mean that the command ran,
did not run, or ran without returning a result. The service must keep that
uncertainty visible and must not leave the action pending forever.

When the Sandbox adapter throws after dispatch, `executeSandboxAction` writes no
result. It appends an action receipt with `outcome=failed`,
`observed_state=AMBIGUOUS`, and
`error_code=sandbox_external_outcome_unknown`, appends `action.advanced`, and
returns a safe `503 sandbox_action_ambiguous` response. The raw adapter error,
remote body, command, URL, resource identity, credential, and private topology
do not cross the API boundary. A repeated idempotency key returns a conflict and
does not call the adapter.

A process exit between dispatch and receipt still leaves an older ambiguous
action. Before infrastructure retry or cancellation, the service performs a
bounded query for dispatched `sandbox.exec` actions in the selected campaign
and task that have no result or receipt. It can settle one only when all of the
following facts are durable:

- the action belongs to the selected campaign and task;
- its `sandbox_create_action_id` and resource identity match the owning create
  action;
- the canonical result path is absent;
- no receipt exists;
- a matching Sandbox close receipt completed in a terminal observed state; and
- the close action is advanced.

Settlement appends the same failed ambiguous receipt and advancement. It never
replays the command or writes a result. Command execution and settlement use the
same action-specific finalization fence. The fence covers the external call,
result persistence, receipt, and advancement. Settlement waits for an in-flight
command, then checks the result and receipt again while it holds the fence. A
mismatch, an open Sandbox, an existing result, a conflicting receipt, or an
unsupported action stops recovery. The infrastructure-retry path settles only
its selected task and then verifies that no unresolved non-replay-safe Sandbox
action remains before it reserves or launches a replacement. Cancellation
settles only close-fenced actions and leaves open resources on the existing
cleanup path. There is no global sweep, new route, fallback reader, or second
durable format.

The durable result key must have one shared implementation so execution and
recovery check the same bytes. The current action receipt schema already accepts
`failed`, `AMBIGUOUS`, and the stable error code, so the expected change needs no
schema or generated-file update. Historical records keep their meaning.
`action.advanced` states that the control lifecycle ended; it does not state that
the external effect was absent.

Operator-specific incident identities, action counts, spend, and attempt state
stay in a private hash-checked snapshot. Public documentation records only the
general recovery contract. Recovery preserves the failed attempt, its evidence,
observed spend, campaign lock, task digest, profiles, ceiling, and consumed
attempt count.

Implementation and rollout use this order:

1. preserve the private hash-checked incident snapshot;
2. add the shared result path, typed safe error, ambiguous receipt writer,
   bounded projection query, action-specific finalization fence, and close-gated
   settlement;
3. test live exceptions, hard-crash leftovers, same-key replay, restart,
   projection rebuild, command-completion races, concurrent settlement, retry,
   cancellation, and every fail-closed ownership check;
4. confirm the worker revision and all profile files remain unchanged;
5. pass local, generated, image, privacy, review, and CI gates;
6. deploy the exact repair merge to the existing control Space and verify the
   unchanged resource contract; and
7. invoke the existing infrastructure-retry operation only after private checks
   prove that the locked retry remains eligible.

The retry can use only the remaining attempt allowed by the immutable launch
policy. It cannot reset spend, change the lock, or include a sealed valid task.
A repeated control failure or a policy, provenance, credential, budget, or
cleanup failure stops paid work. The diagnostic campaign stays blocked until
the replacement is a valid published sample and the private measured launch
review passes.

## Trial completion and repair

A worker receives a fixed set of logical task IDs and new physical attempt IDs.
It runs Harbor without internal benchmark retries.

For each physical attempt, the worker:

1. verifies the exact input bundle;
2. runs Harbor;
3. freezes and validates the workspace;
4. uses an upload operation on the scoped attempt-receipt route for
   content-addressed evidence chunks;
5. uploads a canonical manifest with each chunk path, digest, and size through
   the same route;
6. posts the physical attempt receipt last through that route.

The Space verifies the manifest and every immutable chunk before it stores the
receipt or selects a logical terminal outcome. A lost response is harmless: the
worker retries the deterministic request, and reconciliation discovers a
receipt that the API committed before a response was interrupted. The worker
never receives `HF_TOKEN` or a writable canonical Bucket mount.

An agent plugin in this repository must prove its own terminal state before it
returns success to Harbor. The Pi plugin reads the captured `message_end`
events, requires a final assistant event, and rejects a final
`stopReason=error`. Earlier token use and an otherwise complete Harbor result do
not make that trial successful.

The plugin carries a safe, stable failure class through Harbor's existing
`exception_info` field. The classes distinguish a transient provider failure,
a provider policy failure, and another terminal provider failure. The plugin
uses the trailing assistant error events so that a generic final error after an
explicit `429` or `model_rate_limit` remains transient. Authentication, quota,
and unavailable-model signals take policy precedence. A missing, malformed, or
unknown final state fails closed as a non-retryable terminal failure. Public
records and error messages do not include raw provider bodies, credentials, or
private request data.

The worker maps only the transient provider class to a retryable infrastructure
outcome. Policy failures remain policy outcomes. Other terminal provider
failures remain non-retryable agent outcomes. The existing physical-attempt
receipt and `replacement_eligible` fields carry this decision, so no new public
API or durable record version is needed. The locked launch policy remains the
only authority for retry count, cost admission, and logical task selection.

The provider repair is merged at worker revision
`422cf445ce04cfc8f331ddeebfd88f6bc2c5eae9`. Its profile rollout adds new
immutable records and leaves the historical canary and official five-trial
profiles unchanged. The replacement profile family contains one trial-1 task.
The diagnostic profile family contains the stable trial-1 projection of all 89
source tasks in the official profile. Both deployment profiles pin the merged
revision in the preparation command, execution command, `worker_revision`, and
root bootstrap. Tests verify the bootstrap file hashes and canonical profile
IDs. The replacement deployment accepts one task. The diagnostic deployment
accepts 89 tasks at the approved concurrency of eight.

The replacement and diagnostic launch policies require worker receipts, allow
at most two preparation attempts and two infrastructure attempts, and publish
as diagnostic evidence. Their reservations follow the existing per-action
budget rules. Each policy also sets `max_campaign_ceiling_microusd`: 180,000,000
for replacement and 300,000,000 for the diagnostic campaign.

The service resolves the launch policy before it writes a campaign request or
lock. It rejects a requested ceiling above the policy maximum before any durable
campaign state or paid action exists. A requested ceiling at or below the
maximum is stored unchanged in the request and lock and remains the runtime
cumulative budget for reservations, observed spend, retries, and cleanup. The
maximum is optional only so historical profile objects remain readable. The two
new paid policies always include it, and no other field can override it.

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

New publications use immutable objects under `results/schema=v1/` in
`<artifact-bucket>`. The Space builds its local query projection from those
objects and serves authenticated result views itself.

One publication object set contains:

- normalized run rows;
- trial rows;
- execution rows;
- metric rows;
- artifact metadata rows;
- the immutable publication receipt;
- primary and audit catalog projections.

The Bucket remains canonical for both evidence and sanitized result rows. The
Space keeps a disposable local query projection and never treats SQLite as
permanent state.

Publication runs after campaign completion and may retry independently. A
publication conflict cannot reopen a task, launch a model request, or change the
campaign's terminal state. Existing matching bytes are adopted.

Historical result Datasets remain immutable. Their exact revisions and source
checksums stay in Bucket catalog records after new publication moves to the
Bucket-only path.

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
- the Bucket control and result object schemas verified;
- every active publication inventoried;
- a full projection rebuild from Bucket objects;
- launch, crash, repair, publication, and cleanup canaries passed;
- the operator has approved the paid always-on Space and any remote canary cost.

At the boundary:

1. Reject new submissions through the coordination Dataset path.
2. Freeze its exact head in the migration record.
3. Start the control Space write API.
4. Route all new `v1` campaign requests through the Space.
5. Stop creating or writing result Datasets.
6. Publish new normalized results and catalog records to `<artifact-bucket>`.
7. Route result views through the control Space.
8. Suspend obsolete recovery schedules.
9. Mark historical resources read-only in the resource inventory.

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

- Implement the immutable Bucket store behind a TypeScript adapter.
- Validate durable records with versioned JSON Schema and Ajv.
- Generate TypeScript record types from the schemas.
- Implement the local projection with Kysely and `better-sqlite3`.
- Rebuild the projection from Bucket objects when its schema or source digest
  set changes.
- Add property tests for replay order, duplicate objects, conflicting bytes,
  partial uploads, and stale snapshots.
- Keep workers on disjoint attempt paths.

### Control Space

- Create npm workspaces for `control-api`, `control-web`, contracts, control
  logic, Hugging Face adapters, and test fixtures.
- Add one Fastify process with an authenticated `/api/v1` REST API.
- Add one background reconciler with bounded work cycles.
- Implement action intents, remote adoption, and receipts.
- Add liveness, readiness, dependency, and projection-rebuild status.
- Add Hugging Face OAuth, Bucket-backed operator authorization, opaque sessions,
  and CSRF protection.
- Use official Hugging Face JavaScript packages where they cover the required
  operation and bounded typed adapters elsewhere.
- Build and run one pinned multi-stage Node.js container as a non-root user.

### Web application

- Replace the current results application with `control-web` instead of adding
  another frontend.
- Add Tailwind CSS, shadcn/ui, React Router, TanStack Query, TanStack Table,
  React Hook Form, Zod, and bounded charts.
- Add overview, campaign, task, Job, Endpoint, result, profile, and audit routes.
- Add logical progress, physical attempts, spend, publication, cleanup, and
  endpoint safety views.
- Generate the browser client from OpenAPI and reject stale generated output.
- Add Server-Sent Events with durable cursors and a polling fallback.
- Meet keyboard, focus, contrast, reduced-motion, and narrow-viewport gates.

### Profiles and submission

- Extract repeated built-in profiles from current manifests.
- Add namespace profile objects and promotion receipts in the Bucket.
- Add compatibility checks and automatic selection of one approved deployment.
- Make the CLI submit profile references to the Space and return the campaign ID
  immediately.

### Workers and recovery

- Change controller and wave workers to report physical attempt receipts rather
  than shared Git events.
- Require each in-repository agent plugin to prove its final event before a
  worker can report a complete attempt.
- Carry stable provider failure classes through Harbor's existing
  `exception_info` field and map only explicit transient failures to bounded
  replacement.
- Add Bucket discovery when callbacks are missed.
- Add automatic one-task and multi-task infrastructure repair.
- Preserve the independent endpoint watchdog.
- Remove coordination Dataset claims and heartbeat commits.

### Results

- Define immutable Bucket schemas for normalized rows and catalog projections.
- Publish detail rows, receipts, and catalog objects as one idempotent action.
- Add result queries and authenticated views to the control Space.
- Inventory and freeze historical result Datasets and the old results Space
  after verification.

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
- A final Pi provider error cannot become a complete attempt because earlier
  turns used tokens or Harbor wrote an exception-free result.
- A trailing zero-token `429` followed by a generic provider error is a bounded
  retryable infrastructure failure; policy and unknown terminal provider
  failures are not automatically retried.
- A semantic zero, refusal, benchmark timeout, and verifier failure remain
  terminal.
- Publication failure retries without changing campaign or task state.
- Endpoint-backed success and failure both end paused with zero ready replicas.
- Provider, endpoint, Job, repair, and reassessment costs remain under one
  approved cumulative ceiling.
- Secret scans find no token values, authorization headers, private capability
  URLs, or operator paths.
- The namespace contains exactly one Harbor-HF Space and one Harbor-HF Bucket.
- The control Space contains exactly two operator-managed persistent secrets:
  `HF_TOKEN` and `HF_INFERENCE_TOKEN`; their scopes and values are distinct.
- OAuth identity, read-only access, operator authorization, and CSRF rejection
  pass hosted tests.
- SSE reconnect resumes from a durable cursor, and polling works when streaming
  is unavailable.
- A clean local filesystem rebuilds the full projection and selects the same
  next actions.
- A clean launch creates no repository, Bucket, Space, Dataset, or schedule.
- Historical campaign and publication checksums remain unchanged.
- The local quality, mutation, schema, documentation, dependency, browser, and
  Space build gates pass.

## Verification

Keep the current Python checks while the CLI and remote workers remain. Once
the TypeScript workspace exists, local checks include both stacks:

```bash
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov=src/harbor_hf --cov-fail-under=85
uv run python scripts/check_mutation.py --min-kill-rate 90
uv run slophammer-py dry .
uv run pip-audit
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
npm audit
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
- provide a second results service or a second Harbor-HF Bucket;
- keep Python as a parallel shared control authority;
- use PostgreSQL, Redis, Next.js, Gradio, WebSockets, or a second Node process;
- create a general multi-cloud scheduler;
- provide active-active control Space replicas;
- consolidate independent non-Harbor-HF datasets without a separate audit.

## Assumptions and open questions

The design assumes one active control writer per namespace. The Bucket is the
permanent record, and temporary Space downtime is acceptable because Jobs keep
running and endpoint watchdogs remain independent.

Before production deployment, confirm:

- the exact paid CPU tier, current hourly price, and approved monthly ceiling;
- the exact scopes of the retained service token after deprecated resources are
  removed;
- the Bucket listing and startup-rebuild target at the current object count;
- the retention period for obsolete claims, status records, and reassessment
  objects;
- the review and approval policy for namespace-specific profile promotion.

These questions may change deployment details. They do not change the one-Space,
one-Bucket, one-`HF_TOKEN` design.

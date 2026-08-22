# Harbor-HF Control Service

This specification defines the private Harbor-HF control service and its web
application. The service runs in one Docker Space, stores durable records in one
private Bucket, and uses two persistent Space secrets: `HF_TOKEN` for control
operations and `HF_INFERENCE_TOKEN` for reviewed benchmark workers.

The service is approved for implementation. It is not approved for production
traffic until the recovery, security, reliability, cost and migration gates in the
[control service plan](2026-08-16-harbor-hf-control-service-plan.md) pass.

## Runtime inventory

A deployed namespace has two Harbor-HF runtime resources:

| Resource | Purpose |
| --- | --- |
| `<namespace>/<control-space>` | Private Docker Space that runs the API, reconciler, local projection, and web application. |
| `<namespace>/<artifact-bucket>` | Private Bucket that stores immutable control records, profiles, evidence, normalized results, and catalog objects. |

`HF_TOKEN` and `HF_INFERENCE_TOKEN` are the only persistent secrets configured
by the operator in the Space. The credentials must be distinct. The control
service uses `HF_TOKEN` for Bucket and lifecycle operations and passes only
`HF_INFERENCE_TOKEN` to deployment profiles that explicitly require inference.
Hugging Face may inject OAuth client configuration when built-in OAuth is
enabled. Those platform-managed values are not additional operator-managed
service credentials.

The service must not create another repository, Space, Bucket, Dataset,
schedule, lease store, status store, backup store, or result service for normal
operation.

## Process model

The Space runs one Node.js process and one Fastify server. The process owns:

- the REST API and Server-Sent Events endpoint;
- the background reconciler;
- the disposable SQLite projection;
- the compiled React application;
- adapters for Hugging Face Jobs, Sandboxes, Endpoints, Providers, Spaces and Buckets.

The service does not use Node cluster mode or multiple server workers. More
than one process would create competing reconcilers and violate the single
writer rule.

The Bucket is the permanent record. SQLite contains only indexes and derived
views. Deleting the local database and replaying Bucket records must restore the
same campaign states and next actions.

## Source layout

The implementation uses npm workspaces and one root npm lockfile. Python
workers keep their existing uv lock separately.

```text
apps/
  control-api/
    src/
  control-web/
    src/
packages/
  contracts/
  control-core/
  hf-adapters/
  test-fixtures/
deploy/
  control-space/
    Dockerfile
```

`apps/control-api` contains Fastify route registration, authentication,
process lifecycle handling, and service wiring. `apps/control-web` contains the React
application. `packages/control-core` contains pure state transition and policy
code. `packages/hf-adapters` owns remote API calls. `packages/contracts` owns
portable schemas and generated types.

The current results application is replaced in place by `control-web`. Do not
keep a second production frontend or a compatibility reader for the old result
service.

## Campaign preparation

Harbor-HF uses one path for every campaign. A campaign starts with a normal
Harbor job configuration and approved Harbor-HF profiles. The control service
starts an isolated preparation Job that runs the pinned Harbor version without
persistent secrets or inference access. Harbor resolves the job. The worker
submits one `prepared.trial` record per logical task and then one `prepared.job`
record through a short-lived capability.

Execution workers pin Harbor 0.21.0. That release crashes in
`Job._update_metric_display` with `IndexError` after a direct task writes
`result.json` when the progress metric list is empty. The worker applies a
sitecustomize patch that seeds task sources and skips empty progress display.
Delete `packages/harbor-hf-agents/src/harbor_hf_agents/support/harbor_0210_empty_metrics.py`
when the pinned Harbor version includes
[PR 2681](https://github.com/harbor-framework/harbor/pull/2681).

The prepared records contain the exact Harbor trial locks and the data needed
for admission, including source and task digests, resolved image digests,
resources, phase time limits, agent settings, and Harbor version. The final
record binds their order and the reconstructed Harbor job-lock digest. Model
and harness names remain configuration values. The control service and its
workers do not branch on benchmark, model, model family, or harness names.

Before it admits execution, the control service checks that the lock is
portable, complete, digest-pinned, compatible with the selected deployment,
and within the campaign cost and resource limits. It rejects local paths,
mutable source references, unpinned images, unsupported environment features,
and settings that disagree with approved profiles. It stores each prepared
record immutably. Execution and all later recovery work use those records.
Harbor fetches the exact locked Git or package task without resolving the
benchmark dataset again.

Deployment profiles contain Hugging Face infrastructure and safety limits. They
do not contain copies of benchmark task catalogs. A new Harbor-supported
benchmark or compatible model requires configuration and immutable data only.
The same rule applies to a supported harness. A new harness implementation
belongs in a Harbor agent plugin behind the common agent interface. Missing
behavior is added as a general capability at the correct Harbor, agent,
provider, or Hugging Face adapter boundary. Harbor-HF does not add name-based
special cases.

One-time migration programs do not define campaign behavior and do not become
the path for adding campaign support.

## Technology choices

TypeScript is the control-service language. Hugging Face maintains JavaScript
packages for Hub, Jobs, repository access, and inference operations, and the React application
already uses TypeScript. This avoids a custom Go integration layer and keeps
browser and API tooling in one workspace. The control service is low-volume,
I/O-bound orchestration, so Go's smaller binary and lower idle memory do not
justify another language or handwritten provider clients.

### Control API

The control API uses:

- the current Node.js long-term support release, pinned in the container;
- TypeScript with strict checking;
- Fastify for HTTP routing and lifecycle management;
- JSON Schema and Ajv for durable record validation;
- Zod for browser forms and application request validation where JSON Schema is
  not the source contract;
- Kysely with `better-sqlite3` for the local projection;
- Pino for structured logs;
- the standard OpenID Connect flow through `openid-client`;
- official Hugging Face JavaScript packages where they expose the required
  operation.

Uncovered Hugging Face operations use small typed adapters against published
HTTP or OpenAPI contracts. Provider SDK types do not enter control-domain
models.

The control service replaces Python as the shared control authority. Existing
Python benchmark workers may remain as pinned remote Job artifacts. They write
only to their assigned attempt and evidence paths. The Python CLI becomes a
thin API client or is retired. It must not retain a second reconciliation path.

### Web application

The web application uses:

- React and strict TypeScript;
- Vite;
- Tailwind CSS;
- shadcn/ui and Lucide icons;
- React Router;
- TanStack Query and TanStack Table;
- React Hook Form with Zod;
- shadcn chart components for bounded operational charts.

Server state belongs in TanStack Query. Filters, sorting, pagination, view
mode, and the selected catalog scope belong in the URL. Local React state is reserved for
short-lived interface state. Redux and direct browser access to the Bucket are
out of scope.

The frontend consumes a generated OpenAPI client. Handwritten copies of API
request or response types are invalid.

## Contract authority

Versioned JSON Schema files are authoritative for immutable Bucket records.
TypeScript types are generated from those schemas. Unknown fields are rejected
unless a schema declares a bounded extension object.

Fastify route schemas produce the OpenAPI document. CI regenerates the
TypeScript browser client and fails when committed generated output is stale.
The public API remains under `/api/v1` during this replacement. Schema changes
replace the pre-release contract in place unless a later compatibility policy
is explicitly approved.

Canonical JSON encoding, identifier derivation, digest rules, and immutable
write behavior follow the [control service plan](2026-08-16-harbor-hf-control-service-plan.md).
The TypeScript service and Python migration tool invoke the same dependency-free
canonical JSON encoder, including ECMAScript number formatting.

Startup replays durable profile objects and promotions before writes are
allowed. The resolver overlays checked-in profiles with the latest approved
promotion for each kind and alias. A promotion of a checked-in name does not
hide a newer deployed digest of that same profile. Candidate and recommended
records remain visible but cannot authorize a campaign. A campaign lock retains
the selected alias, immutable profile digest, and complete spec even when that
alias later moves. Canonical migration preserves profile objects and promotion
records.

### Capacity contracts

Each concurrency field has one meaning:

- `worker_concurrency` is the maximum number of trial futures submitted by one
  execution worker at a time;
- `sandbox_template.max_sandboxes` is the maximum number of active or reserved
  Sandboxes for one campaign;
- `worker_max_tasks_per_job` bounds the task assignment and recovery impact of
  one execution Job and does not set concurrency;
- `inference_max_concurrency` limits concurrent provider requests from one
  Sandbox;
- `inference_max_total_concurrency` limits the provider request units reserved
  across all active Sandboxes in one campaign;
- the namespace capacity profile limits active or reserved Sandboxes across
  campaigns and by hardware name, and sets the Sandbox start rate; and
- budget admission limits work through the campaign's immutable reservations
  and ceiling.

A Job reservation is active only while that Job can still spend money. A
terminal Job observation or a launch suppressed before dispatch appends a
release for the full Job reservation. Observed cost remains recorded
independently. Before a paused campaign reserves resumed work, the service also
reconciles missing releases for historical terminal and suppressed Job actions.
The release records are deterministic and append-only. Sandbox reservations
remain separate and close through the Sandbox capacity path.

The namespace capacity profile is service policy. It uses the existing profile
object and promotion records, but it is not a campaign profile reference and is
not part of a campaign lock. Every admission grant records the exact capacity
profile digest that authorized it. A later promotion applies only to later
grants. Lower limits stop new admissions and let active work drain.

Write-enabled startup resolves the promoted alias named by
`HARBOR_HF_CAPACITY_PROFILE_ALIAS` and fails when it is absent or invalid.
Read-only startup may replay and display historical records without one, but it
cannot admit new Sandbox work. No production capacity value is implied by this specification.
Operators select values from verified quota and profiling evidence.

## HTTP API

The service exposes these route groups:

```text
GET  /health/live
GET  /health/ready
GET  /api/v1/system
GET  /api/v1/campaigns
POST /api/v1/campaigns
GET  /api/v1/campaigns/{campaign_id}
GET  /api/v1/campaigns/{campaign_id}/tasks
GET  /api/v1/campaigns/{campaign_id}/tasks/{task_id}
POST /api/v1/campaigns/{campaign_id}/tasks/{task_id}/attempts
POST /api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes
POST /api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes/{sandbox_id}/observe
POST /api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes/{sandbox_id}/exec
PUT  /api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes/{sandbox_id}/files
POST /api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes/{sandbox_id}/files/read
DELETE /api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes/{sandbox_id}
POST /api/v1/campaigns/{campaign_id}/actions
GET  /api/v1/jobs
GET  /api/v1/endpoints
GET  /api/v1/profiles
GET  /api/v1/results
GET  /api/v1/leaderboard
GET  /api/v1/audit
GET  /api/v1/events
```

Collection routes use opaque cursor pagination and bounded page sizes. All
timestamps use UTC RFC 3339 strings. Responses distinguish observed state,
recommended action, and approved action.

Mutating requests require an `Idempotency-Key`. A mutation that can cause a
remote side effect writes its immutable intent to the Bucket before the API
returns `202 Accepted`. The response contains the deterministic action ID and a
link to its current state. The historical disposition route causes no remote
side effect. It validates the complete batch, appends disposition records, and
returns created or adopted status. A local SQLite write cannot authorize or
acknowledge a remote side effect.

Errors use one JSON envelope with a stable code, human-readable message,
request ID, and optional field errors. Raw provider bodies and dependency error
strings never cross the API boundary.

Workers receive a short-lived signed control capability and never receive
`HF_TOKEN` or a writable Bucket mount. Deployment profiles declare the worker
inference credential `required` or `forbidden`. A required profile receives only
`HF_INFERENCE_TOKEN` as an encrypted Job secret; a forbidden profile receives no
operator-managed secret. The capability is scoped to one namespace, campaign,
immutable campaign-lock digest, launch action, task set, operation set and
expiration. Every capability authorizes campaign-lock reads, evidence upload and
attempt submission. A deployment with an immutable Sandbox policy may also
authorize create, observe, command, file write, file read and close operations.

An inference-required deployment also locks maximum requests, concurrency,
upstream timeout, and output tokens. The service supplies those non-secret
limits to the worker. The root-owned bridge accepts only the selected Chat
Completions or Responses path, the locked model, approved Hugging Face hosts,
and requests within those limits.

Sandbox policies lock the digest-pinned image, hardware, lifetime, idle timeout,
reservation, hourly cost, command count, command timeout, transfer size and
filesystem roots. The control service writes a dispatch fence before every
Sandbox side effect. Create and close are remotely adoptable. File writes repeat
only with identical content-addressed bytes. Results are stored immutably outside
the projection prefix before the action receipt, so restart recovery cannot
duplicate a completed operation.

`sandbox.exec` is not replay-safe. If its external call fails after dispatch, the
service writes no result. It writes an action receipt with `outcome=failed`,
`observed_state=AMBIGUOUS`, and
`error_code=sandbox_external_outcome_unknown`, then writes `action.advanced`.
The API returns a safe `sandbox_action_ambiguous` error without the external
error body, command, resource identity, credential, or private route. A repeated
idempotency key returns a conflict and never calls the Sandbox API again.

A process exit can still leave a dispatch with no result or receipt. The existing
infrastructure-retry and cancellation paths may settle that action only within
the selected campaign and task, and only after a matching Sandbox close receipt
proves a terminal observed state. Command execution and settlement use the same
action-specific finalization fence. The fence covers the external call, result,
receipt, and advancement. Settlement waits for an in-flight command, then checks
the result and receipt again while it holds the fence. It also verifies the
create action, task, resource identity, dispatch, close receipt, and close
advancement. Cancellation schedules and verifies close before it settles a
dispatched command; it never suppresses that command as completed. Operator and
automatic infrastructure retries use the same settlement and pending-command
gate before they reserve or launch replacement work. Settlement then appends
the same failed ambiguous receipt and advancement. It does not replay the
command, create a result, change an attempt, or scan another campaign.
`action.advanced` ends the control action; it does not prove that the external
command did not run.

### Historical action dispositions

A release can record the wrong terminal meaning before the current ambiguity
rules are deployed. The service corrects that history with a separate
`action.disposition` record. It never changes or replaces the original intent,
dispatch, receipt, advancement, result, attempt, selection, budget, cleanup, or
publication record.

The first v1 disposition class is deliberately narrow. It applies only to a
dispatched `sandbox.exec` whose original receipt has all of these values:

- `outcome=completed`;
- `observed_state=suppressed-sandbox-cleanup-ambiguous`; and
- a null error code.

For this fixed legacy class, the source receipt can have a null `resource_id`.
The old suppression writer used null when it did not record the resource
observation. A null value does not identify another Sandbox and does not prove
that the command did not run. If the source receipt has a non-null resource, it
must exactly match the `sandbox.exec` intent resource. A conflicting non-null
value fails closed. One control-core predicate applies this rule during both
correction admission and projection replay.

The effective disposition is fixed to `outcome=failed`,
`observed_state=AMBIGUOUS`, and
`error_code=sandbox_external_outcome_unknown`. The record also has the fixed
reason code `historical_non_replay_safe_command_ambiguity`. The schema does not
accept another action kind, original state, effective state, or reason code.

Each disposition identifies one campaign, task, and target action. It binds the
original receipt and one matching terminal Sandbox close receipt by record ID
and canonical SHA-256 digest. The intent must contain a resource identity. The
Sandbox create receipt and terminal close intent and receipt must match that
identity in the same campaign and task. Both the target action and close action
must be advanced. The durable Sandbox result path must be absent. Close proves
that the Sandbox cannot create a later effect. It does not prove whether the
command ran before close.

A disposition has one deterministic record ID derived from the target action
and one path under the existing action prefix:
`zzz-disposition.json`. A target action can have at most one disposition.
Correction requests are bounded to one campaign and task. The service sorts and
locks all target action IDs, validates the complete batch, then appends each
disposition. Every record carries a batch ID derived from the campaign, task,
and hashed idempotency key, plus a batch digest derived from the sorted action
IDs, fixed reason code, and bounded operator reason. The raw idempotency key is
never stored.

A process exit can leave a prefix of a batch. Repeating the exact request adopts
that prefix and writes only the missing dispositions. Reusing a batch identity
with a different action set, reason, receipt digest, close digest, or effective
state is an integrity conflict. Concurrent matching requests produce one record
per action and preserve the first actor and creation time.

The local projection stores dispositions in a separate table. Action rows keep
the recorded receipt outcome and state and add explicit effective outcome,
state, error code, correction flag, and disposition record ID. Authenticated
audit views show recorded and effective values together. Safe list responses do
not expose command bodies, resource identities, proof action IDs or digests,
result paths, credentials, or topology.

Projection replay accepts dispositions in any Bucket listing order. After all
records are loaded, an integrity pass checks the source receipt digest, shared
source-resource predicate, intent, dispatch, advancement, create and resource
ownership, terminal close receipt digest, close advancement, fixed fields, and
result-object absence. A missing or conflicting fact keeps projection readiness
false. A later result object for a corrected action is also an integrity error.

Operators submit an explicit, confirmed batch through
`POST /api/v1/campaigns/:campaignId/tasks/:taskId/action-dispositions` or the
`harbor-hf campaign correct-action-dispositions` CLI wrapper. The route requires
an idempotency key and returns only the batch ID, disposition record IDs, and
created or adopted status. The matching authenticated `GET` route lists safe
recorded and effective fields with bounded pagination. There is no automatic
scan or backfill.

A disposition has no lifecycle authority. It does not change pending-action or
command counts, retry eligibility, reservations, observed spend, attempts,
task selection, cleanup, publication, profile promotion, or resource state. It
cannot start a Job, Sandbox, Endpoint, inference request, or publication. Sample
acceptance and any later paid launch remain separate reviewed decisions.

Stores without disposition records keep their current v1 meaning. This is an
in-place schema addition, not a fallback reader, second format, or dual-write
path.

The control service launches the Sandbox server from its read-only public server
Bucket mount. It derives a per-Sandbox HMAC token and sends only that token plus,
when required, `HF_INFERENCE_TOKEN` as Job secrets. It never sends `HF_TOKEN` or
`SBX_DL_TOKEN` to the Sandbox. A reviewed root bootstrap consumes the inference
credential, starts the root-owned bridge, then removes inference route values and
the credential from the Sandbox server environment before unprivileged benchmark
commands are accepted. Worker responses contain an opaque Sandbox action ID, not
the remote Job ID or proxy URL.

Evidence upload is resumable and content addressed. A worker uses an upload
operation on the attempt-receipt route for bounded base64 chunks, then uploads
a canonical `worker.evidence.manifest` object that lists every chunk path,
digest, and size.
The attempt receipt points to that manifest. The control service checks the
manifest scope and verifies every listed immutable object before accepting the
receipt. Replay performs the same check for a worker receipt discovered directly
in the Bucket, so a caller-supplied path or digest is never evidence by itself.

## Live progress

`GET /api/v1/events` is a Server-Sent Events stream. Each event has a durable
cursor derived from immutable control records. A reconnect may send
`Last-Event-ID`; the service replays later events from its local projection.

The React application falls back to bounded polling when the stream is
unavailable. SSE is a delivery optimization. Campaign state always comes from
replaying durable Bucket records.

The API does not use WebSockets. Control progress is server-to-browser traffic,
and HTTP mutations already provide the reverse direction.

## Progress semantics

The interface reports logical work separately from physical execution. A task
retry does not increase the campaign denominator.

Campaign pages show:

- total logical tasks and sealed outcomes;
- active tasks and infrastructure replacements;
- terminal invalid, provider-rejected, agent, cancellation, verifier and benchmark failures;
- physical attempt counts;
- reserved, observed and reconciled cost plus the approved ceiling;
- requested and observed endpoint state;
- publication and cleanup state;
- the immutable action and event timeline.

Observed campaign spend is the sum of recorded attempt receipts and the latest
hardware cost on each Job or Sandbox, taking the later of that sum and any
budget reconcile events. Job observe actions accrue locked hardware hours.
Sandbox close actions do the same. Worker receipts add their own cost, typically
inference spend. The total is not a Hugging Face invoice.

A campaign is not complete while publication or required endpoint cleanup is
unresolved. Publication failure does not reopen completed benchmark work.

## Leaderboard snapshot

The private result catalog remains candidate material. The rows shown on the
leaderboard are a derived SQLite object under
`results/schema=v1/leaderboard/` in the canonical Bucket.

The configuration digest hashes benchmark identity, model identity, harness
identity, trial count, reasoning effort, inference provider, and Harbor version
from the campaign lock. Worker revision, Job IDs, and cost are excluded.

Only catalogs with `publication_role=final`, quality `clean`, run outcome
`complete`, and `scored_task_count` equal to `task_count` enter that snapshot.
Diagnostic, cancelled, mixed, and policy-failed catalogs stay private.

Each SQLite file is content-addressed. The snapshot receipt is written after
the database bytes. Rank is computed at read time. The latest published
eligible row wins for a configuration digest.

`GET /api/v1/leaderboard` is a public, rate-limited read. It returns the latest
snapshot metadata (without `sqlite_key`) and the ranked rows, each marked as on
or off the cost-versus-score Pareto frontier. The browser never reads the
Bucket. Campaigns, result details, system, events, and mutations stay
authenticated.

This object lives in the existing Bucket and does not add a second store.

## Web routes

The React application provides:

| Route | Content |
| --- | --- |
| `/` | Public official leaderboard: snapshot table and cost-versus-score Pareto plot. |
| `/overview` | Queue, active campaigns, failures, spend and endpoint safety. Authenticated. |
| `/campaigns` | Searchable and filterable campaign list. |
| `/campaigns/:campaignId` | Campaign progress, task states, HF Jobs, cost, publication, cleanup, endpoint safety, and timeline. |
| `/campaigns/:campaignId/tasks/:taskId` | Logical outcome, every physical attempt, and the HF Jobs that ran for the campaign. |
| `/jobs` | Current HF Job identity, Hub inspect links, latest observed state, recorded hardware cost, ownership, timing and infrastructure failures. |
| `/endpoints` | Endpoint ownership, requested state, observed state, active cost, and cleanup. |
| `/results` | Published catalog: pass rate, 95% CIs, token cost, Bucket output links, and provenance. |
| `/leaderboard` | Redirects to `/`. |
| `/profiles` | Immutable profiles, aliases, promotions, approval state, and resolved locks. |
| `/audit` | Recorded receipts, effective dispositions, actors, integrity failures, and policy stops. |

The interface supports keyboard navigation, narrow viewports, light and dark
color schemes, visible focus, and reduced motion. Labels use hover explanations
for campaign launch fields, spend, Jobs, Endpoints, results, and other operator
controls. Tables virtualize only when a measured row count requires it. Every
status also has text and an icon; color is never the only signal. Scored-success
outcomes are green, sealed timeouts and cancellations are yellow, and failures
are red. Outcome badges spell out the sealed result: scored success, provider
rejected the request, agent ended without a score, and the other catalogued
outcomes. Raw tokens such as `policy` and `agent` are not shown. Hover the
badge for the sealed-versus-retryable distinction. A finished campaign with
sealed non-success tasks is labeled Completed with failures, not Completed.

## Authentication and authorization

The Space is publicly reachable so Jobs can present short-lived worker
capabilities without receiving a Hugging Face credential. Anonymous callers can
reach static application assets, login and callback routes, minimal health
checks, and `GET /api/v1/leaderboard`. Campaigns, result details, system,
events, and mutations remain protected by the application.

Hugging Face OAuth provides verified user identities. The service stores
operators and readers in an immutable private Bucket access-list record. A
verified identity that is absent from both lists receives no control access.
The bearer transport verifies identity with Hugging Face and applies the same
access list. Failed checks are cached briefly, and new identity lookups have
per-client and global limits before any external request.

OAuth uses authorization code flow with PKCE and state validation. Browser
sessions are opaque random identifiers stored in the disposable local database.
The session cookie is `Secure`, `HttpOnly`, and same-site. A restart may end
browser sessions because they are not durable control state. Expired and excess
login flows and sessions are removed so anonymous login traffic cannot grow the
database without a bound.

Mutations require a session-bound CSRF token. Paid launches and destructive
actions require an explicit confirmation screen that shows the resolved target,
logical task count, cost ceiling, and effect. The verified OAuth actor is stored
in the action intent.

The service does not enable cross-origin API access. It sets a strict Content
Security Policy, request body limits, response security headers, and request
limits. Forwarded client IP headers are not trusted because the hosting proxy
may pass caller-supplied values. Unverified credentials stay in shared
anonymous route limits. After authentication, limits use hashes of verified
worker actions, actors, or sessions. Anonymous limits are separate for health,
authentication, the public leaderboard, API, and static routes, so exhausting
one does not block an authorized worker or operator. Authentication runs before request-body parsing,
so an anonymous caller cannot force the service to parse a large worker
submission. Public health responses contain only `live`, `ready`, or
`rebuilding` state.

`HF_TOKEN`, `HF_INFERENCE_TOKEN`, OAuth tokens, provider credentials, private
evidence, and unsanitized task data never enter browser responses or frontend
assets. Audit
and SSE envelopes contain only event type, cursor, immutable key, digest, and
record ID. They never embed the raw durable record.

Jobs never receive `HF_TOKEN` or a writable mount of the canonical control
Bucket. An inference-required deployment receives `HF_INFERENCE_TOKEN` as its
only operator-managed Job secret. The service signs a short-lived capability
for the exact campaign, launch action, and task set. That capability is accepted
only by the worker campaign-lock, attempt-receipt and explicitly locked Sandbox
routes, is redacted from logs, and cannot invoke operator or collection APIs.
Browser lock and profile views redact Sandbox inference topology.

The built-in control smoke Job runs a reviewed inline script in a digest-pinned
official Node.js image. Its deployment forbids inference, so it refuses both
operator-managed credentials, reads its
campaign lock, uploads canonical evidence, and submits one task receipt through
its scoped capability. Control smoke success requires that worker receipt, so a
completed Job cannot hide a broken callback path.

The separate Sandbox control smoke remains inference-free. Its reviewed worker
creates one digest-pinned CPU Sandbox, adopts readiness by opaque action ID,
executes one bounded command, round-trips one content-addressed file, closes the
remote Job, verifies budget reconciliation, then submits its attempt receipt. It
fails if either the broad control credential or inference credential appears in
the worker.

## Local projection

SQLite runs on the Space's local ephemeral filesystem. It is never opened on a
Bucket mount. The database enables foreign keys and write-ahead logging.

Startup follows this sequence:

1. Initialize OAuth and local disposable state without listening for traffic.
2. Load the newest valid projection snapshot when one exists.
3. Verify the snapshot's source object digests.
4. Replay later immutable records in deterministic order.
5. Compare the projection with control invariants.
6. Listen only after readiness succeeds, then start reconciliation.

An initialization failure closes local resources and exits nonzero so the
platform can restart the process. It cannot leave a live but permanently
unready server behind. A projection schema mismatch discards the database and
triggers a full rebuild. In-place projection migrations are unnecessary because
the database is disposable.

Snapshots may improve startup time. They cannot authorize paid work until their
source digest set is verified.

## Sandbox capacity admission

A Sandbox create action is the durable queue entry. The control service is the
only admission writer and applies these states in order:

```text
pending admission
admitted
remote dispatch authorized
remote Sandbox created
capacity released
```

The service writes the create intent and campaign budget reservation before it
considers capacity. A pure admission decision then returns `admitted`,
`deferred`, or `rejected`. It checks cancellation and policy validity first,
then campaign Sandbox capacity, namespace capacity, hardware capacity, campaign
provider capacity, Sandbox start pacing, and budget. Each result has a stable
reason code. A deferral includes a next eligible time only when token refill
provides one. The service does not invent an estimate for an unknown capacity
release.

An admitted action receives one immutable `sandbox.admission` grant before the
action-dispatch fence and before any Hugging Face adapter call. The grant binds
the action, campaign, namespace, hardware, provider request units, capacity
profile digest, admission time, and token-bucket state. Repeating an idempotent
request adopts the same intent, reservation, grant, dispatch, and remote
resource.

The namespace start limit is a durable integer token bucket. Its profile sets
the token capacity, refill amount, and refill period. Each grant names its
causal predecessor, so replay reconstructs the same order and token state even
when timestamps are equal. Time moving backward cannot add tokens, and a profile
promotion cannot reset a partly used bucket to a fresh burst. A token is not
refunded after a remote start was authorized.

Capacity remains reserved from grant until one of two proofs exists:

- the create failed definitively and no remote resource exists; or
- a close receipt verifies an accepted terminal Sandbox state.

An ambiguous create, failed close, or uncertain cleanup retains the slot. The
projection reports that slot as cleanup-held. Historical dispatched creates
without admission records count as legacy reservations until the same terminal
proof exists. Historical records are never rewritten.

Pending creates keep FIFO order inside each campaign. The reconciler rotates
among eligible campaigns so one campaign cannot take every released namespace
slot. Cleanup keeps priority over new work. Temporary deferral causes no remote
call and no retry storm.

The worker-facing create route submits or adopts the durable action. It returns
the completed resource when one exists, or `202 Accepted` with the action ID,
queue state, limiting reason, and a factual retry time when available. Workers
observe that action with bounded backoff. Observation cannot create another
intent, reservation, token charge, grant, dispatch, or Sandbox.

PR #100 established the execution worker's bounded rolling scheduler. It keeps
at most `worker_concurrency` futures, waits for `FIRST_COMPLETED`, and fills a
free slot while tasks remain. This design stays in place. Campaign cancellation
closes the refill gate through the existing control API. The worker starts no
new task after cancellation becomes visible. Tasks already running continue to
their evidence and cleanup boundary. Harbor internals are not patched.

## Valid attempts and campaign completion

An attempt receipt is durable evidence. It is not automatically a valid result.
Each campaign lock includes an evidence policy that names the metrics required for
selection. A provider-backed Pi workload requires finite positive integer values
for both `input_tokens` and `output_tokens`. Other workloads must state their own
requirements in the lock. Control code must not branch on a benchmark, model, or
harness name.

The control service evaluates the policy before every terminal selection. Worker
outcome names and worker-supplied replacement flags cannot make an invalid receipt
selectable. A zero, missing, negative, fractional, or non-finite required metric
makes the attempt invalid for selection.

An invalid attempt remains in the Bucket with its evidence and cost. If the lock
permits another attempt, the reconciler waits for cleanup and schedules the bounded
replacement. If the attempt limit, reservation, or campaign ceiling prevents
another attempt, the service writes an exhausted-task record. It does not select
the last invalid receipt.

A campaign is complete only when every locked logical task has exactly one selected
attempt and every selection passes the locked evidence policy. A task with exhausted
attempts makes the campaign failed. It cannot become a valid completed campaign and
cannot publish. Historical records remain byte-for-byte unchanged. Projection
replay may label an old campaign `completed-invalid` when its historical selection
does not pass the current read-only audit.

## Cooperative pause and resume

Pause and resume use the existing control API, reconciler, Job, Sandbox, and Bucket.
A pause request is durable. Once the request exists, the service and workers stop
admitting new task slots. Active tasks may finish, write their evidence and attempt
receipt, and close their Sandboxes. The execution Job then ends at that durable task
boundary.

Resume creates one idempotent execution action for unresolved tasks. It does not
rerun a task that already has a valid selected attempt. Repeated pause or resume
requests adopt the existing action. A restart of the Space or worker must produce
the same unresolved task set and next action.

A sliding-window worker checks campaign lifecycle and Sandbox admission inside the
same slot-fill boundary. While a campaign is running, a free worker slot is refilled
when pending work and capacity remain. Once pause or cancellation is visible, no new
slot is admitted.

## Safe publication and supersession

Publication repeats the selection checks independently of campaign completion. It
requires one selected receipt for every logical task, valid required metrics,
matching task and campaign identities, matching provenance, complete normalized
coverage, and no pending action or cleanup.

The publisher writes immutable row objects and receipt evidence first. It reads them
back and verifies their digests before it writes the catalog object that makes the
publication visible. A partial write is not a published result. Every step uses
deterministic keys so a retry adopts matching objects and rejects conflicting bytes.

A replacement publication does not edit or delete an older publication. After the
new publication commits, the service may append one supersession record that binds
the old and new publication digests. Result views derive `current` and `superseded`
state from that record. Direct historical reads remain available for audit.

## Reconciler

The reconciler runs in the Fastify process and executes bounded work cycles. It
selects the next action from durable records, writes intent before the side
effect, observes the remote system, writes a receipt, applies the domain
transition, and writes an action-advanced marker. Only documented terminal Job
states can end an attempt. Scheduling, pending, running, updating, and unknown
future states remain under observation. A receipt without that marker
is replayed after restart. The transition is deterministic and idempotent, so a
process exit between the receipt and its derived action cannot strand work.

Before the first remote Job create call, the reconciler writes an immutable
action-dispatch fence. If the create response is lost or the process exits, the
same action becomes adoption-only after a bounded delay. It can discover the
matching deterministic Job label but cannot issue a second create request.
Worker attempts remain bound to the exact launch action, and one physical
action can produce no more than one attempt for the same logical task.

Each action selects one trial from the stored Harbor lock. The trial supplies
its task identity, source digest, image digest, resource request, time limits,
and verifier settings. The deployment profile supplies generic Hugging Face
limits for inference, hardware, paths and transfers. It also sets command and
cost limits. Admission requires the locked trial to fit those limits. Each
Sandbox action stores the fully resolved task policy, so replay does not depend
on a mutable profile or a
second reading of benchmark source files.

The trusted outer worker receives only its signed campaign capability. A custom
Harbor environment uses that capability to create, observe, execute in, transfer
files to and from, and close each Sandbox through this service. `HF_TOKEN`
never enters the worker. When inference is required, the control service passes
`HF_INFERENCE_TOKEN` directly to the Sandbox root bootstrap. The benchmark
agent receives only a loopback route and placeholder key. Trial directories and
complete workspaces return to the trusted worker in bounded chunks, then enter
the private evidence store through content-addressed worker uploads. A locked
worker task limit supports recovery canaries: the first Job can stop after a
durable subset, and normal missing-receipt recovery must launch only the
remaining logical tasks.

The reconciler uses `AbortController` for graceful shutdown. Shutdown stops new
admissions, lets an in-flight Bucket write reach a safe boundary, closes SSE
connections, and exits within the Space termination window. Remote Jobs keep
running. After restart, the reconciler continues Job observation and repeats
endpoint pause observations until zero ready replicas are explicitly recorded.
A failed or incomplete Job observation stays pending and cannot synthesize a
terminal task outcome or authorize replacement work. When a terminal Job still
has no required worker receipt, the reconciler performs a fresh Bucket sync and
writes a delayed observation with a durable worker-receipt deadline. It selects
a fallback only after the configured bounded grace period. Replacement
admission is serialized across operator and reconciler paths, and a new
reservation is checked against the greater of durable reservations and observed
spend. Any observed overage is durably caught up before the replacement intent
is written. A pause response that omits replica state is not treated as zero.

The next action must be independent of Bucket listing order. Property tests
shuffle records and inject process termination around each external call.

## Container build

The Space image uses a pinned multi-stage Docker build:

1. A build stage installs the locked npm workspaces and generates contracts.
2. The build runs type checks, compiles the API, and produces Vite assets.
3. A runtime stage installs production dependencies only.
4. The runtime copies compiled JavaScript, frontend assets, and required schema
   files.
5. The container runs as a non-root user and listens on port `7860`.

Build output is not committed to Git. The runtime image contains no development
server and does not run a second Node process. Vite assets use content hashes
and immutable cache headers. The HTML entry point uses a short or no-cache
policy.

`HF_TOKEN` and `HF_INFERENCE_TOKEN` are available only at runtime. Docker build
steps never mount or copy them. Deployment records the source commit, lockfile
digest, base image digests, and resulting Space revision.

## Availability and hardware

Free `cpu-basic` hardware may sleep after 48 hours without visitors. A sleeping
control service cannot reconcile Jobs or verify endpoint cleanup. The
production Space therefore uses paid CPU hardware with sleep disabled.

At the time of this decision, the lowest documented paid CPU price is about
`$0.03` per hour, or about `$21.90` for a 30-day month. The exact price and
monthly ceiling must be reviewed before deployment. Development and local UI
checks may use free CPU. Production cannot depend on a keep-awake request,
external schedule, or user visit.

The minimum worthwhile effect is preventing one unattended control-plane sleep
while paid work or endpoint cleanup is active. The always-on tier meets that
threshold without adding another runtime resource.

## Observability

Every API request receives a request ID. Every remote side effect has a
deterministic action ID. Logs are structured JSON and redact configured headers,
query values, cookies, credentials, route capabilities, and provider bodies.

The system page reports service revision, projection status, replay cursor,
reconciler heartbeat, last successful Bucket write, and dependency health. It
must not report secret values or private deployment identifiers to users who
lack operator access.

Capacity views report the configured limit, reserved and active use, available
slots, queued creates, cleanup-held slots, provider request units, start tokens,
effective capacity, and the current limiting reason. Namespace and campaign
views keep worker, Sandbox, provider, start-rate, assignment, and budget limits
separate. Server-Sent Events target only the queries affected by an admission,
release, profile promotion, or limiting-state change.

The overview and audit pages expose durable operational evidence. External
telemetry is disabled unless a separate privacy and credential review approves
it.

## Testing

The TypeScript workspace uses:

- Biome for formatting and linting;
- `tsc --noEmit` for strict type checks;
- Vitest for domain, adapter, API and contract tests;
- fast-check for replay and state-machine properties;
- Testing Library and MSW for React behavior;
- Playwright for browser and hosted Space tests.

CI also verifies generated schemas and OpenAPI clients, checks the production
container, scans dependencies, and runs the public-repository privacy check.
Remote tests use the canonical private resources and purpose-scoped credentials.
They never create a per-test Space, Bucket, Dataset, or schedule.

Acceptance requires these failure tests:

- restart during every remote action boundary;
- shuffled and duplicated Bucket listings;
- conflicting immutable bytes;
- stale and corrupt projection snapshots;
- SSE disconnect and polling fallback;
- expired OAuth and CSRF rejection;
- read-only user mutation rejection;
- endpoint cleanup after control-process termination;
- publication retry without trial execution;
- full projection rebuild on an empty local filesystem;
- valid historical action disposition with recorded and effective state;
- disposition rejection for wrong action, receipt, result, ownership, or close;
- partial and concurrent disposition batch adoption;
- disposition proof failure during shuffled projection replay;
- disposition correction with no retry, budget, attempt, publication, or resource side effect;
- rolling refill while another trial remains a straggler;
- cancellation and pre-receipt failure stopping later task admission;
- concurrent campaign admissions at campaign, namespace, hardware, provider,
  start-rate, and budget boundaries;
- fair deferred admission before and after full projection rebuild;
- process exit after intent, reservation, grant, dispatch, create, receipt, and
  release;
- ambiguous create and failed cleanup retaining capacity;
- historical Sandbox actions rebuilding as conservative reservations; and
- API, event, and browser status showing the correct limiting reason without
  private topology or credentials.

Behavior changes also run the repository Ruff, format, type, coverage,
Slophammer, dry-run, and mutation gates together with generated-contract,
OpenAPI, TypeScript, build, and browser checks. Pi Reviewer runs against the
current base until no P0 or P1 finding remains. Relevant pull-request CI must be
green before the change is ready to merge.

## Deployment and replacement

The public Harbor-HF repository remains the source of truth. A release command
publishes an exact reviewed source revision to the application-protected Space. Operators do
not edit the Space repository by hand. Deployment must not require another
long-lived credential in CI.

The replacement is a hard new-write switch. Before it begins, all active legacy
controllers must finish, every managed endpoint must be paused, the new Space
must pass recovery tests, and normalized result catalog data must exist in the
Bucket.

Capacity admission rolls out in four stages. First, additive schemas, legacy
replay, capacity status, and tests ship while writes stay disabled. Second, an
operator promotes a reviewed namespace capacity profile and configures its
alias. Write-enabled startup fails closed until that profile is available and
no ambiguous legacy create can escape conservative accounting. Third, every new
Sandbox create requires a durable admission grant. Fourth, new deployment
profiles pin the worker revision that includes cancellation awareness. Existing
campaign locks keep their recorded worker revision and are not changed.

At the boundary, the TypeScript service becomes the only campaign writer. New
campaigns and publications stop using the coordination and result Datasets.
Historical readers may retain exact old revisions for audit, but no runtime
fallback reads or writes those stores.

Keep exact retirement candidates and approvals alongside consumer findings and
unique-object checks in a private operator inventory. Do not copy that inventory
into public Git or GitHub metadata.

## Boundaries

The control service does not:

- move Hugging Face integration into Harbor core;
- execute benchmark agents inside the Space;
- load or serve models;
- keep durable state only in SQLite;
- expose the Bucket to browsers;
- provide active-active control replicas;
- use PostgreSQL, Redis, a Node cluster, Next.js, Gradio, or a second web
  service;
- create an external keep-awake schedule;
- rewrite historical campaign evidence.

## References

- [Hugging Face Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker)
- [Hugging Face Spaces OAuth](https://huggingface.co/docs/hub/spaces-oauth)
- [Hugging Face Spaces hardware and sleep behavior](https://huggingface.co/docs/hub/spaces-overview)
- [Hugging Face JavaScript Hub client](https://huggingface.co/docs/huggingface.js/hub/README)

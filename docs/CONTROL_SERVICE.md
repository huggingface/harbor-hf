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
- adapters for Hugging Face Jobs, Endpoints, Providers, Spaces and Buckets.

The service does not use Node cluster mode or multiple server workers. More
than one process would create competing reconcilers and violate the single
writer rule.

The Bucket is the permanent record. SQLite contains only indexes and derived
views. Deleting the local database and replaying current Run-native control
records must restore the same run states and next actions. The projection lists
only the `migrations`, `operators`, `profiles`, and `runs` record trees. Retired
control trees remain immutable evidence in the Bucket, but normal startup and
sync do not read or reinterpret them.

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

## Run preparation

Harbor-HF uses one path for every run. A run starts with a normal
Harbor job configuration and approved Harbor-HF profiles. The control service
starts an isolated preparation Job that runs the pinned Harbor version without
persistent secrets or inference access. Harbor resolves the job. The worker
submits one `prepared.trial` record per logical task and then one `prepared.job`
record through a short-lived capability.

Preparation and execution workers install Harbor from a pinned
`harbor-framework/harbor` git commit, not a PyPI release. The current pin is
`b37833221e27435a18d7acdd41d875cdc2831893`, which reports Harbor `0.22.0` and
includes [PR 2681](https://github.com/harbor-framework/harbor/pull/2681). The
former Harbor 0.21.0 empty-metrics sitecustomize patch is not applied.

The prepared records contain the exact Harbor trial locks and the data needed
for admission, including source and task digests, resolved image digests,
resources, phase time limits, agent settings, and Harbor version. The final
record binds their order and the reconstructed Harbor job-lock digest. Model
and harness names remain configuration values. The control service and its
workers do not branch on benchmark, model, model family, or harness names.

Before it admits execution, the control service checks that the lock is
portable, complete, digest-pinned, compatible with the selected deployment,
and within the run cost and resource limits. It rejects local paths,
mutable source references, unpinned images, unsupported environment features,
and settings that disagree with approved profiles. It stores each prepared
record immutably. Execution and all later recovery work use those records.
Harbor fetches the exact locked Git or package task without resolving the
benchmark dataset again.

The prepared benchmark image is immutable task data, not the physical Job
image. Every execution Job starts from the reviewed, digest-pinned deployment
Job image. That trusted worker verifies and unpacks the task OCI image, replaces
its entrypoint, command, and environment, and maps the rootfs to one dedicated
high host UID/GID. Every task, agent, and verifier command has that real UID,
empty supplementary groups, an empty Linux capability set, and
`no_new_privs`. PRoot presents the unpacked filesystem and emulates the image's
user, including container UID 0, but it is not the security boundary. The task
UID never becomes host root. Host Unix permissions protect the worker,
capability, token, and bridge state.

Execution preflight requires `git`, `proot`, `skopeo`, and `umoci`, a root
worker without effective `CAP_SYS_PTRACE`, and an unused dedicated UID/GID. A
probe running with the final task identity must have empty capability fields,
`no_new_privs`, and no access to the worker's `/proc/<pid>/environ` or a
root-owned mode-0600 file. A missing runtime feature or failed denial probe is
a replacement-eligible infrastructure failure. A Harbor process that exits
without its required trial result is also replacement-eligible because the
worker has no truthful benchmark outcome to seal. Other evidence-integrity
failures remain non-retryable. There is no namespace or same-UID fallback.

Deployment profiles contain Hugging Face infrastructure and safety limits. They
do not contain copies of benchmark task catalogs. A new Harbor-supported
benchmark or compatible model requires configuration and immutable data only.
The same rule applies to a supported harness. A new harness implementation
belongs in a Harbor agent plugin behind the common agent interface. Missing
behavior is added as a general capability at the correct Harbor, agent,
provider, or Hugging Face adapter boundary. Harbor-HF does not add name-based
special cases.

One-time migration programs do not define run behavior and do not become
the path for adding run support.

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

Runtime readiness remains false through authentication initialization,
projection rebuild, checked-in profile installation and resolver refresh,
capacity profile validation or creation, and operator ACL bootstrap. API and
authentication routes use this runtime state, not projection readiness alone.
The resolver overlays checked-in profiles with the latest approved promotion
for each kind and alias. A promotion of a checked-in name does not hide a newer
deployed digest of that same profile. Candidate and recommended records remain
visible but cannot authorize a run. A run lock retains the selected alias,
immutable profile digest, and complete spec even when that alias later moves.
Canonical migration preserves profile objects and promotion records.

### Capacity contracts

Each capacity field has one meaning:

- `trial_job_template.max_jobs` limits active trial Jobs for one run;
- `inference_max_concurrency` limits concurrent provider requests from one
  trial Job;
- `inference_max_total_concurrency` limits the provider request units reserved
  across all active trial Jobs in one run;
- the namespace capacity profile limits active or reserved Jobs across
  runs and by hardware name, and sets the Job start rate; and
- budget admission limits work through the run's immutable reservations
  and ceiling.

A Job reservation is active only while that Job can still spend money. A
terminal Job observation or a launch suppressed before dispatch appends a
release for the full Job reservation. Observed cost remains recorded
independently. Before a paused run reserves resumed work, the service also
reconciles missing releases for historical terminal and suppressed Job actions.
The release records are deterministic and append-only.

The namespace capacity profile is service policy. It uses the existing profile
object and promotion records, but it is not a run profile reference and is
not part of a run lock. Every admission grant records the exact capacity
profile digest that authorized it. A later promotion applies only to later
grants. Lower limits stop new admissions and let active work drain.

Write-enabled startup resolves the promoted alias named by
`HARBOR_HF_CAPACITY_PROFILE_ALIAS`. When that promotion is absent, the service
writes and promotes a namespace cap from `HARBOR_HF_MAX_ACTIVE_JOBS` (default
16, maximum 1024) and matches start burst and refill tokens to the same value.
An existing approved promotion is the source of truth. Restarting the Space does
not reset it. Operators change the live cap through `GET` and `POST
/api/v1/capacity`. The POST body requires `confirmed: true` and an
`Idempotency-Key`. The response never includes the namespace. Read-only startup
may replay and display historical records without a capacity profile, but it
cannot admit new Job work. No production quota is implied by the default.
Operators select values from verified quota and profiling evidence. Existing
run locks keep their per-run `max_jobs` and worker concurrency.

## HTTP API

The service exposes these route groups:

```text
GET  /health/live
GET  /health/ready
GET  /api/v1/system
GET  /api/v1/capacity
POST /api/v1/capacity
GET  /api/v1/runs
POST /api/v1/runs
GET  /api/v1/runs/{run_id}
GET  /api/v1/runs/{run_id}/lock
GET  /api/v1/runs/{run_id}/prepared-job
GET  /api/v1/runs/{run_id}/prepared-job/trials/{task_id}
GET  /api/v1/runs/{run_id}/tasks
GET  /api/v1/runs/{run_id}/tasks/{task_id}
POST /api/v1/runs/{run_id}/tasks/{task_id}/attempts
POST /api/v1/runs/{run_id}/actions
GET  /api/v1/jobs
GET  /api/v1/endpoints
GET  /api/v1/profiles
GET  /api/v1/results
GET  /api/v1/leaderboard
GET  /api/v1/audit
GET  /api/v1/events
```

Collection routes use opaque cursor pagination and bounded page sizes, except a
Job request with `run_id`. That request returns every latest Job for the Run in
one response with `next_cursor: null`, so new Job observations cannot shift
offsets between pages. All timestamps use UTC RFC 3339 strings. Responses
distinguish observed state, recommended action, and approved action.

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
inference credential `required` or `forbidden`. A required profile passes only
`HF_INFERENCE_TOKEN` as an encrypted physical Job secret. Root bootstrap moves
it to a root-owned bridge file before the nested task runtime starts. Task,
agent, and verifier processes receive only the bridge URL. A forbidden profile
receives no operator-managed secret. The capability is scoped to one run,
immutable lock digest, launch action, task, operation set, and expiration. It
authorizes only the assigned lock read, evidence upload, and attempt submission,
and it is never copied into the task rootfs or task environment.

Each execution Job runs one physical Harbor trial. The deployment profile locks
the digest-pinned trusted worker image, hardware, timeout, resource limits,
inference limits, and root bootstrap. The prepared trial separately locks the
benchmark task image digest. A dispatch fence is durable before Job creation. A
lost create response becomes adoption-only and cannot issue a second create
request.

Worker-to-task file transfers enforce total-byte, per-file-byte, file-count, and
path-depth limits before and during copy, and reject links and special files.
Evidence upload is resumable and content addressed. A worker uploads bounded
chunks and then a canonical `worker.evidence.manifest` that lists every chunk
path, digest, and size. The attempt receipt points to that manifest. The control
service verifies its scope and every immutable object before accepting the
receipt, including during replay.

Pre-reset nested execution records have no active reader, writer, route, schema,
or disposition API. Old run-derived data is deleted instead of migrated.

## Live progress

`GET /api/v1/events` is a Server-Sent Events stream. Each event has a durable
cursor derived from immutable control records. A reconnect may send
`Last-Event-ID`; the service replays at most `SSE_REPLAY_LIMIT` events, which is
1,000 in the control API. The JSON data envelope for a durable event contains
`id`, `type`, `occurred_at`, `data`, `replay`, and `cursor_reset`. `data`
contains the immutable object key, digest, record ID, and available scope
fields such as Run, task, attempt, action, publication, profile kind, and
alias. It never contains the raw durable record.

An invalid cursor, a changed cursor epoch, or history beyond the replay cap
produces one non-durable `cursor.reset` envelope without an `id`. It has
`replay: true`, `cursor_reset: true`, and `data` containing `reason`,
`latest_cursor`, and `replay_limit`. The service does not replay the full
history after a reset. While a bounded replay is in progress, at most
`SSE_LIVE_BUFFER_LIMIT` live events are queued, which is 256 in the control
API. Exceeding that queue produces the same reset behavior.

Replay writes wait for stream drain. A live write that exceeds stream
backpressure closes and unsubscribes the connection so the browser can
reconnect. Close and error cleanup is registered before replay reads begin.
The browser uses reset metadata as its next cursor and invalidates active
resource and system queries. A current-epoch replay event also refetches system
state. Replayed events never increment the browser's cached projected object
count. Live events set both delivery flags to `false`.

The React application falls back to bounded polling when the stream is
unavailable. SSE is a delivery optimization. Run state always comes from
replaying durable Bucket records.

The API does not use WebSockets. Control progress is server-to-browser traffic,
and HTTP mutations already provide the reverse direction.

## Progress semantics

The interface reports logical work separately from physical execution. A task
retry does not increase the run denominator.

Run pages show:

- total logical tasks and sealed outcomes;
- active tasks and infrastructure replacements, including a run-page control that retries every eligible infrastructure failure;
- terminal invalid, provider-rejected, agent, cancellation, verifier and benchmark failures;
- physical attempt counts;
- reserved, observed and reconciled cost plus the approved ceiling;
- requested and observed endpoint state;
- publication and cleanup state;
- the immutable action and event timeline.

Observed run spend is the sum of recorded attempt receipts and the latest
hardware cost on each Job, taking the later of that sum and any budget reconcile
events. Job observations accrue locked hardware hours. Worker receipts add
their own cost, typically inference spend. The total is not a Hugging Face
invoice.

A run is not complete while publication or required endpoint cleanup is
unresolved. Publication failure does not reopen completed benchmark work.

## Leaderboard snapshot

The private result catalog remains candidate material. The rows shown on the
leaderboard are a derived SQLite object under
`results/schema=v1/leaderboard/` in the canonical Bucket.

The configuration digest hashes benchmark identity, model identity, harness
identity, trial count, reasoning effort, inference provider, and Harbor version
from the run lock. Worker revision, Job IDs, and cost are excluded.

Only catalogs with `publication_role=final`, quality `clean`, run outcome
`complete`, and `scored_task_count` equal to `task_count` enter that snapshot.
Diagnostic, cancelled, mixed, and policy-failed catalogs stay private.

Each SQLite file is content-addressed. The snapshot receipt is written after
the database bytes. Rank is computed at read time. The latest published
eligible row wins for a configuration digest.

`GET /api/v1/leaderboard` is a public, rate-limited read. It returns the latest
snapshot metadata (without `sqlite_key`) and the ranked rows, each marked as on
or off the cost-versus-score Pareto frontier. The browser never reads the
Bucket. Runs, result details, system, events, and mutations stay
authenticated.

This object lives in the existing Bucket and does not add a second store.

## Web routes

The React application provides one left navigation. Leaderboard is public.
Admin lists Overview, Runs, Jobs, Endpoints, Results, Profiles, and Audit.
Those Admin routes require Hugging Face login.

| Route | Content |
| --- | --- |
| `/` | Public official leaderboard: snapshot table and cost-versus-score Pareto plot. |
| `/overview` | Queue, active runs, failures, spend and endpoint safety. Authenticated. |
| `/runs` | Searchable and filterable run list. |
| `/runs/:runId` | Run progress, task states, HF Jobs, cost, publication, cleanup, endpoint safety, and timeline. |
| `/runs/:runId/tasks/:taskId` | Logical outcome, every physical attempt, and the HF Jobs that ran for the run. |
| `/jobs` | Current HF Job identity, Hub inspect links, latest observed state, recorded hardware cost, ownership, timing and infrastructure failures. |
| `/endpoints` | Endpoint ownership, requested state, observed state, active cost, and cleanup. |
| `/results` | Published catalog: pass rate, 95% CIs, token cost, Bucket output links, and provenance. |
| `/leaderboard` | Redirects to `/`. |
| `/profiles` | Immutable profiles, aliases, promotions, approval state, and resolved locks. |
| `/audit` | Recorded receipts, effective dispositions, actors, integrity failures, and policy stops. |

The interface supports keyboard navigation, narrow viewports, light and dark
color schemes, visible focus, and reduced motion. Labels use hover explanations
for run launch fields, spend, Jobs, Endpoints, results, and other operator
controls. Tables virtualize only when a measured row count requires it. Every
status also has text and an icon; color is never the only signal. Scored-success
outcomes are green, sealed timeouts and cancellations are yellow, and failures
are red. Outcome badges spell out the sealed result: scored success, provider
rejected the request, agent ended without a score, and the other catalogued
outcomes. Raw tokens such as `policy` and `agent` are not shown. Hover the
badge for the sealed-versus-retryable distinction. A finished run with
sealed non-success tasks is labeled Completed with failures, not Completed.

## Authentication and authorization

The Space is publicly reachable so Jobs can present short-lived worker
capabilities without receiving a Hugging Face credential. Anonymous callers can
reach static application assets, login and callback routes, minimal health
checks, and `GET /api/v1/leaderboard`. Runs, result details, system,
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
one does not block an authorized worker or operator. Authentication runs before
request-body parsing, so an anonymous caller cannot force the service to parse
a large worker submission. Public health responses contain only `live`,
`initializing`, or `ready` state.

`HF_TOKEN`, `HF_INFERENCE_TOKEN`, OAuth tokens, provider credentials, private
evidence, and unsanitized task data never enter browser responses or frontend
assets. Audit and SSE envelopes contain only event type, cursor, time,
immutable key, digest, record ID, delivery metadata, and bounded scope fields.
They never embed the raw durable record.

Jobs never receive `HF_TOKEN` or a writable mount of the canonical control
Bucket. An inference-required deployment receives `HF_INFERENCE_TOKEN` as its
only operator-managed Job secret. The service signs a short-lived capability
for the exact run, launch action, and task. That capability is accepted only by
the assigned lock, evidence, and attempt-receipt routes, is redacted from logs,
and cannot invoke operator or collection APIs. Browser lock and profile views
redact inference topology.

The built-in control smoke Job runs a reviewed inline script in a digest-pinned
official Node.js image. Its deployment forbids inference, so it refuses both
operator-managed credentials, reads its run lock, uploads canonical evidence,
and submits one task receipt through its scoped capability. Control smoke
success requires that worker receipt, so a completed Job cannot hide a broken
callback path.

## Local projection

SQLite runs on the Space's local ephemeral filesystem. It is never opened on a
Bucket mount. The database enables foreign keys and write-ahead logging.

Startup follows this sequence:

1. Open the HTTP listener so the Space platform can observe liveness during a
   long rebuild.
2. Initialize authentication and local disposable state.
3. Rebuild the projection from immutable records and verify control invariants.
4. Install checked-in profiles and refresh the promoted-profile resolver.
5. Validate or create the configured namespace capacity profile.
6. Bootstrap the operator ACL when the immutable store does not contain one.
7. Mark the runtime ready and start reconciliation.

`GET /health/ready` returns HTTP 200 for Space platform compatibility and
reports `status=initializing` until step 7 completes. During initialization,
`GET /api/v1/system` remains a read-only status route and includes both the
runtime initialization state and the independent projection state. Other API
and authentication routes return `control_not_ready`, even if projection
rebuild has already completed.

An initialization failure closes local resources and exits nonzero so the
platform can restart the process. It cannot leave a live but permanently
unready server behind. A projection schema mismatch discards the database and
triggers a full rebuild. In-place projection migrations are unnecessary because
the database is disposable.

Snapshots may improve startup time. They cannot authorize paid work until their
source digest set is verified.

## Job capacity admission

A trial Job launch intent is the durable queue entry. The control service is the
only admission writer. It checks run, namespace, and hardware Job capacity,
provider request capacity, start-rate tokens, cancellation, and budget before
dispatch. A deferral records the specific limiting factor and includes a next
eligible time only when token refill provides one.

The namespace start limit is a durable integer token bucket. Its profile sets
the burst, refill amount, and refill period. Replay reconstructs the same token
state, time moving backward cannot add tokens, and profile promotion cannot
reset a partly used bucket. A token is not refunded after a remote start was
authorized.

Capacity remains reserved until the Job reaches a documented terminal state or
launch is suppressed before dispatch. Ambiguous creation or uncertain
observation retains the slot. Pending launches preserve FIFO order within each
run, while the reconciler rotates among eligible runs. Cleanup and observation
take priority over new work.

Each execution Job receives exactly one task ID and runs exactly one physical
Harbor trial. `trial_job_template.max_jobs` limits active Jobs for one run. Run
cancellation prevents new launches. Jobs already running continue to their
evidence boundary. Harbor internals are not patched.

## Valid attempts and run completion

An attempt receipt is durable evidence. It is not automatically a valid result.
Each run lock includes an evidence policy that names the metrics required for
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
replacement. If the attempt limit, reservation, or run ceiling prevents
another attempt, the service writes an exhausted-task record. It does not select
the last invalid receipt.

A run is complete only when every locked logical task has exactly one selected
attempt and every selection passes the locked evidence policy. Exhausted tasks stay
on the run while other tasks can still run. The run is failed only after
every logical task is terminal and at least one task is exhausted. That run
cannot become a valid completed run and cannot publish. An infrastructure
exhaustion remains replaceable. Historical records remain byte-for-byte unchanged.
Projection replay may label an old run `completed-invalid` when its historical
selection does not pass the current read-only audit.

## Cooperative pause and resume

Pause and resume use the control API, reconciler, Jobs, and Bucket. A pause
request is durable and prevents new Job admission. An active Job may finish its
one assigned trial and submit evidence. Resume creates one idempotent action for
unresolved tasks and never reruns a task that already has a valid selected
attempt. Repeated requests adopt the existing action, and replay derives the
same unresolved task set.

## Safe publication and supersession

Publication repeats the selection checks independently of run completion. It
requires one selected receipt for every logical task, valid required metrics,
matching task and run identities, matching provenance, complete normalized
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

Each action selects one trial from the stored Harbor lock. The trial
supplies its task identity, source digest, image digest, resource request, time
limits, and verifier settings. The deployment profile supplies generic Job,
inference, hardware, path, transfer, and cost limits. Admission requires the
locked trial to fit those limits. The launch intent stores the fully resolved
policy, so replay does not depend on a mutable profile or a second reading of
benchmark source files.

The trusted trial worker receives its signed capability and, only when required,
the inference-only credential. Root bootstrap starts the loopback inference
bridge and removes the raw credential from the worker environment. The worker
then runs the locked task rootfs as the dedicated unprivileged host UID. It does
not bind host `/run`, `/tmp`, the root workspace, capability material, or token
files. A host `/proc` view may expose metadata, but the different real UID and
absent capabilities prevent task reads of root process environments and file
descriptors. The bridge
authoritatively enforces the locked request-body, model, output-token, and
concurrency limits. Its accepted connections and handler threads are bounded,
and socket, header, body, and upstream operations have timeouts. Trusted host
Python removes the route, kills the exact root bridge PID through a pidfd, and
awaits its exit before verifier execution.

Runtime stop enumerates the dedicated real UID, sends `SIGSTOP` until the
process set is stable, sends `SIGKILL`, and verifies that no process remains.
This covers `setsid` descendants and processes that fork during cleanup. Trial
evidence returns through content-addressed worker uploads. A locked
infrastructure-attempt limit bounds replacement Jobs, and valid selected
attempts are never rerun.

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

Capacity views report the configured limit, reserved and active use,
available slots, queued launches, observation-held slots, provider request
units, start tokens, effective capacity, and the current limiting reason.
Namespace and run views keep Job, provider, start-rate, assignment, and budget
limits separate. Server-Sent Events target only the queries affected by an
admission, release, profile promotion, or limiting-state change.

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

Acceptance requires restart tests around every remote action boundary,
shuffled and duplicated Bucket listings, conflicting immutable bytes, projection
rebuild, OAuth and CSRF rejection, endpoint cleanup, evidence verification,
concurrent Job admission limits, fair deferred admission, ambiguous Job
creation, terminal observation without a receipt, and status views that do not
expose private topology or credentials.

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

Job capacity admission is part of the Run-native reset. New launch intents
require a durable capacity decision before dispatch. Old run-derived control
records are deleted rather than replayed through compatibility logic.

### One-time Run-data reset

The cutover uses `scripts/reset_run_data.py` to remove current and retired
Run-derived Bucket trees. The reviewed preserve list keeps
`control/schema=v1/profiles/`, `control/schema=v1/operators/`,
`control/schema=v1/auth/`, `control/schema=v1/migrations/`,
`benchmark-bundles/sha256/`, and `serving-profiles/`. Every other Bucket path
must match an explicit delete prefix or the tool aborts. Capacity policy and
its promotion remain under the preserved profile prefix.

The control Space must report `write_mode=disabled`, and no HF Job may be
active. First create and review a fresh local manifest:

```bash
uv run python scripts/reset_run_data.py \
  --bucket "<namespace>/<artifact-bucket>" \
  --manifest run-data-reset-dry-run.json

uv run python -m json.tool run-data-reset-dry-run.json
```

Apply requires explicit confirmation and the reviewed key digest. Supplying
the dry-run manifest also binds the preserved key and size inventory:

```bash
uv run python scripts/reset_run_data.py \
  --bucket "<namespace>/<artifact-bucket>" \
  --apply \
  --yes \
  --expected-delete-digest "sha256:<delete-key-digest>" \
  --dry-run-manifest run-data-reset-dry-run.json \
  --verification-manifest run-data-reset-verification.json

uv run python -m json.tool run-data-reset-verification.json
```

The tool re-lists immediately before mutation and after all bounded delete
batches. It writes the post-delete verification manifest only to the local
filesystem. It never writes an audit object to the Bucket and never deletes
the Bucket itself.

At the boundary, the TypeScript service becomes the only run writer. New
runs and publications stop using the coordination and result Datasets.
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
- rewrite historical run evidence.

## References

- [Hugging Face Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker)
- [Hugging Face Spaces OAuth](https://huggingface.co/docs/hub/spaces-oauth)
- [Hugging Face Spaces hardware and sleep behavior](https://huggingface.co/docs/hub/spaces-overview)
- [Hugging Face JavaScript Hub client](https://huggingface.co/docs/huggingface.js/hub/README)

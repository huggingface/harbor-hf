# Harbor-HF Control Service

The Harbor-HF control service is the single shared authority for hosted Harbor
Runs on Hugging Face infrastructure. It runs in one application-protected
Docker Space, stores immutable records in one private Bucket, and uses two
persistent Space secrets: `HF_TOKEN` for control operations and
`HF_INFERENCE_TOKEN` for inference-backed execution Jobs.

This specification describes the current Harbor-first direct-inference design.
A conditional compatibility path remains for approved immutable profiles whose
pinned historical workers require a root-owned inference bridge. New Workbench
profiles use direct inference.

## Runtime inventory

The steady-state service has exactly two persistent resources:

1. one protected control Space; and
2. one private `<artifact-bucket>` Bucket.

The Space contains one Node.js process running:

- Fastify API routes;
- the background reconciler;
- a disposable SQLite projection;
- Server-Sent Events;
- the compiled React application; and
- health, readiness, and operational views.

The Bucket contains immutable control records, profiles, prepared Harbor locks,
evidence chunks and manifests, attempt receipts, normalized results,
publication receipts, and catalogs. SQLite is never authoritative. Rebuilding
it from Bucket objects must produce the same state and next action.

Do not create a per-Run repository, Bucket, Space, Dataset, schedule, lease
store, result service, or backup service. A new persistent resource requires an
explicit access or failure-domain reason and operator approval.

## Process and trust model

The control process is the only shared writer of Run decisions. API mutations
record immutable intent before returning. The reconciler reserves one
deterministic action, performs the external side effect, and records an
immutable receipt before advancing.

Python remains in pinned preparation and execution Jobs. Those workers call
Harbor and return scoped evidence, but they do not become another control
service.

Credential boundaries are:

- `HF_TOKEN` remains in the control Space and is used for Bucket and HF
  lifecycle operations.
- `HF_INFERENCE_TOKEN` may be attached only to an execution Job whose resolved
  deployment contains `inference_upstream`.
- Preparation Jobs receive neither persistent credential.
- Every worker receives a short-lived signed capability scoped to its Run,
  action, task set, operations, and expiration.
- No Job receives a writable mount of the canonical Bucket.

For direct inference, the execution contract places
`${HF_INFERENCE_TOKEN}` in Harbor `AgentConfig.env` alongside the locked
upstream URL. Harbor expands that value for the selected agent. This means the
agent is an intended secret consumer; arbitrary user-supplied agent code and
unreviewed recipes cannot use this path.

## Source layout

The control-service implementation is split by responsibility:

```text
apps/
  control-api/       Fastify process and composition root
  control-web/       React application
packages/
  contracts/         JSON Schema, generated TypeScript, API contracts
  control-core/      domain records, projection, reconciler, policy
  bucket-store/      immutable Bucket adapter
  hf-adapters/       Hugging Face lifecycle adapter
  harbor-hf-agents/  pinned Harbor workers and agent plugins
deploy/
  control-space/     Docker Space image
  trial-worker/      reviewed HF Job image
profiles/            checked-in immutable profile sources
```

Domain code does not import Fastify, React, the filesystem, Hugging Face
clients, or wall-clock implementations. Untrusted HF responses are validated
at adapter boundaries.

## Run preparation

A Run submission names promoted profile aliases for:

- benchmark;
- model;
- harness;
- deployment; and
- launch policy.

The service resolves each alias to an immutable profile record and composes one
execution contract before cost reservation or Job admission. It rejects:

- unknown or non-promoted profiles;
- imported historical profiles;
- incompatible model, harness, deployment, or API combinations;
- malformed Harbor model routes;
- mutable image or source references;
- unsupported worker commands or hardware;
- missing prices or runtime limits; and
- any combination outside the caller's authorization.

A preparation Job receives the resolved contract without persistent secrets.
It installs the pinned Harbor and agent-package revisions, creates a normal
Harbor `JobConfig`, and asks Harbor's public `JobPlan` API to resolve the
benchmark. It writes:

- one `prepared.trial` record per logical task;
- one `prepared.job` record binding the ordered trials; and
- the SHA-256 digest of the reconstructed Harbor `JobLock`.

Each prepared trial binds the exact Harbor `TrialLock`, task source digest,
task-image digest, resource request, phase limits, agent configuration, and
worker provenance. Execution and recovery never resolve the benchmark source
again.

## Profile composition

### Benchmark profile

The benchmark profile identifies the source, revision, task selection, and
source-integrity policy. Harbor remains the only component that interprets the
benchmark format.

### Model profile

The model profile supplies:

- the canonical Harbor model route;
- the exact model revision;
- supported inference APIs and reasoning behavior; and
- stable aliases for operator-facing selection.

### Historical continuation and worker repair

New run locks use only this composed form. A paused, nonterminal historical run
may receive one append-only `run.continuation` record when its original prepared
Job remains available. The service resolves the same model, harness, deployment,
benchmark, and launch-policy aliases against reviewed current profiles, then
rejects changes to the locked model revision, harness revision, provider,
inference limits, hardware, Harbor version, context limit, or prices. It also
revalidates every prepared-trial reference and preserves each derived launch's
hardware, timeout, cost rate, concurrency, and image limits. The attachment
binds a current worker and execution contract to the original lock digest. It
does not rewrite the lock, reset cost, change the ceiling, reopen selected
tasks, or retry a selected infrastructure outcome.

If that continuation worker is defective, the Run may receive one append-only
`run.continuation.repair` record. The repair is bound to the original lock and
continuation digests and may change only the digest-pinned worker image and
worker source revision. Every later Job launch carries the repair record ID.
Jobs created before the repair remain observable for reservation and evidence
settlement. Run identity, prepared inputs, model and harness settings, provider
settings, selected outcomes, evidence, spend, and ceiling remain unchanged.

If the repaired worker is defective, the Run may receive one append-only
`run.continuation.repair.successor` record. It binds to the lock, continuation,
and first repair digests and may again change only the worker image and source
revision. Later Job launches carry both repair IDs. No further successor is
allowed.

### Harness profile

The harness profile supplies:

- Harbor agent `import_path`;
- exact agent revision;
- model-independent agent keyword arguments;
- supported inference APIs;
- required evidence types; and
- session or trajectory policy.

Adding a harness must require only a Harbor agent plugin and profile. Control,
API, schema, and infrastructure code must not branch on the harness name.

### Deployment profile

The deployment profile supplies:

- `route`;
- digest-pinned worker image and reviewed commands;
- hardware and phase timeouts;
- supported model and harness profile names;
- prices and admission settings;
- direct `inference_upstream`;
- `inference_api`;
- `inference_timeout_seconds`;
- `inference_max_output_tokens`; and
- endpoint configuration when the route uses a managed Endpoint.

The deployment profile does not provide a second model identity. The resolver
derives the provider-facing model from the canonical Harbor model route and
verifies that its suffix matches `inference_provider`.

### Resolved inference contract

When `inference_upstream` is present, composition produces:

- Harbor provider `openai`;
- the selected HF inference provider;
- the exact upstream URL;
- the canonical Harbor agent model;
- the provider-facing model;
- either `chat-completions` or `responses`;
- timeout, context, and output-token limits;
- immutable token prices; and
- the upstream hostname in `extra_allowed_hosts`.

The final `AgentConfig` includes:

```json
{
  "model_name": "openai/<model-id>:<inference-provider>",
  "env": {
    "OPENAI_API_KEY": "${HF_INFERENCE_TOKEN}",
    "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
    "HARBOR_HF_OUTPUT_LIMIT": "<locked-positive-integer>",
    "HARBOR_HF_PROVIDER_TIMEOUT_SECONDS": "<locked-positive-integer>"
  },
  "extra_allowed_hosts": ["router.huggingface.co"]
}
```

Agent plugins may derive runtime-specific environment names or configuration
files from these values. They may not select another model, upstream, API, or
credential. The service does not translate one inference API into another.

## Agent Workbench

The authenticated Agent Workbench compiles and tests generic command-agent
recipes through the versioned recipe schema and server-authoritative preview
compiler. Its setup state is actor-scoped and ephemeral.

Local development defaults to a disposable Docker runner. Hosted setups use a
reviewed setup-only Job. An edited recipe cannot launch benchmark work. It may
be saved as an owner-scoped immutable version without launching. New Run
selects that exact version and a reviewed benchmark configuration; the existing
Workbench admission path requires matching recipe/compiler setup attestation
and a compatible reviewed deployment, then creates only a Run-scoped harness
binding. Saving and setup testing do not promote a global execution profile.
Built-in selections continue through normal five-profile admission.

The detailed Workbench document is maintained separately in
[`agent-workbench.md`](agent-workbench.md).

## Durable contract authority

Versioned JSON Schema under `packages/contracts/schemas/` is authoritative for
Bucket records. TypeScript types and browser clients are generated from the
schema. Portable contracts must not have handwritten duplicate definitions.

Immutable records include:

- actor and request identity;
- Run specification and lock;
- profile records and promotions;
- preparation and prepared-trial records;
- admission, action intent, dispatch, observation, and receipt records;
- evidence manifests and selected attempt receipts;
- endpoint ownership and cleanup observations;
- retry, cancellation, and seal decisions;
- normalized results and publication receipts; and
- audit and migration records.

Records use canonical JSON, stable IDs, explicit schema versions, UTC
timestamps, and SHA-256 digests. Writing different bytes to an existing key is
an integrity failure.

## HTTP API

The API uses `/api/v1`. Exact request and response shapes come from generated
OpenAPI contracts. The major route groups are:

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
GET  /api/v1/runs/{run_id}/continuation
POST /api/v1/runs/{run_id}/continuation
GET  /api/v1/runs/{run_id}/continuation-repair
POST /api/v1/runs/{run_id}/continuation-repair
GET  /api/v1/runs/{run_id}/continuation-repair-successor
POST /api/v1/runs/{run_id}/continuation-repair-successor
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

Mutations require:

- an authenticated actor;
- authorization for the operation;
- CSRF protection for browser sessions;
- a request confirmation where the action can spend or mutate remote state;
- an idempotency key for execution actions (leaderboard submission/review instead
  use deterministic immutable record identities); and
- immutable intent before any external call.

Errors use one JSON envelope with a stable code, human-readable message,
request ID, and optional field errors. Raw provider bodies and dependency error
strings never cross the API boundary.

Workers receive a short-lived signed control capability and never receive
`HF_TOKEN` or a writable Bucket mount. An inference-backed deployment passes
only `HF_INFERENCE_TOKEN` as an encrypted physical Job secret. Direct profiles
reference it from `AgentConfig.env`, and Harbor expands it for the selected
reviewed agent. An approved compatibility profile instead declares
`inference_token: required` and a pinned root bootstrap; only that path receives
the bounded bridge settings. A deployment without an inference upstream
receives no operator-managed secret. The capability is scoped to one run,
immutable lock digest, launch action, task, operation set, and expiration. It
authorizes only the assigned lock read, evidence upload, and attempt submission,
and it is never copied into the task rootfs or task environment.

### Inference model route binding

Current profiles use one canonical Harbor route in `AgentConfig.model_name`,
such as `openai/<Hub-model>:<inference-provider>`. The resolver derives the
provider-facing identity from that route and verifies that its provider suffix
matches the deployment. It also validates the model, harness, API, upstream,
timeout, and output limit before creating a Run.

An immutable bridge-compatibility profile uses that same derived
provider-facing identity as its one allowed bridge model. The launch wrapper and
bridge environment are emitted only when the profile explicitly requires them.

A built-in profile change produces a new content-derived profile record ID. New
runs resolve the new ID. Existing run locks keep their original profile IDs and
digests. An explicitly authorized historical continuation is a separate
immutable record at a fixed per-Run path, not a historical rewrite. The
capability-scoped worker route returns that attachment only when its original
lock digest matches the worker capability.

Each execution Job runs one physical Harbor trial. The deployment profile locks
the digest-pinned trusted worker image, hardware, timeout, resource limits,
and direct-inference settings. The prepared trial separately locks the
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
Eligibility alone never grants public visibility: a hosted submission and an
operator decision must bind the exact catalog, lock, and public-row digests.
See [hosted leaderboard submissions](leaderboard-submissions.md) for the
submission/review API and mandatory privacy-and-consent confirmation.

Each SQLite file is content-addressed. The snapshot receipt is written after
the database bytes. Rank is computed at read time. The latest published
approved eligible row wins for a configuration digest.

`GET /api/v1/leaderboard` is a public, rate-limited read. It returns matching
snapshot metadata (without `sqlite_key`, or null during a racing refresh) and the
approved ranked rows, each marked as on
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
verified identity absent from both lists receives the limited `submitter` role
only when an ACL exists. Without an ACL, access fails closed. Submitters have an
exact method/path allowlist for session/logout, public leaderboard, their own
submission list/create, and owned hosted candidates. They do not inherit reader
access to global control state. Review remains operator-only.
The bearer transport verifies identity with Hugging Face and applies the same
access list. Failed checks are cached briefly, and new identity lookups have
per-client and global limits before any external request.

OAuth uses authorization code flow with PKCE and state validation. Browser
sessions are opaque random identifiers stored in the disposable local database.
The session cookie is `Secure`, `HttpOnly`, and same-site. A restart may end
browser sessions because they are not durable control state. Expired and excess
login flows and sessions are removed so anonymous login traffic cannot grow the
database without a bound.

The local installer uses this existing browser login for `install:verify` and
`install:activate` unless an approved application bearer is explicitly supplied
in `HARBOR_HF_CONTROL_BEARER_TOKEN`. This does not add a credential, OAuth
application, endpoint, or store. A headed ephemeral Chromium context owns the
session; the installer never exports cookies, saves storage state, or injects
management tokens. A local graphical display and installed Playwright Chromium
(`npx playwright install chromium`) are required. Headless interactive login is
unsupported. Startup/sign-in is bounded to five minutes; response reads are
bounded to ten seconds and 256 KiB. Errors never include callback URLs.

Before each authenticated installer read, the server session must report
`transport=session`, `role=operator`, and the saved plan's operator username.
Programmatic queries use only the exact planned HTTPS origin and session,
system, and empty-run-check routes, with redirects rejected. OAuth navigation
through Hugging Face remains normal browser login. A restart-expired session
requires signing in again in the same ephemeral context; command completion,
failure, or cancellation closes the browser. Existing source revision,
upload receipt, readiness, expected write mode, empty-run activation, and
rollback checks remain mandatory. Configure's internal readiness check remains
anonymous and does not prompt for browser login.

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
3. Load the newest valid projection snapshot when one exists.
4. Verify the snapshot's source-object digests.
5. Replay later immutable records in deterministic order.
6. Validate projection and control invariants.
7. Install checked-in profiles and refresh the promoted-profile resolver.
8. Validate or create the configured namespace capacity profile.
9. Bootstrap the operator ACL when the immutable store does not contain one.
10. Mark the runtime ready and start reconciliation.

`GET /health/ready` returns HTTP 200 for Space platform compatibility and
reports `status=initializing` until step 10 completes. During initialization,
`GET /api/v1/system` remains a read-only status route and includes both the
runtime initialization state and the independent projection state. Other API
and authentication routes return `control_not_ready`, even if projection
rebuild has already completed.

An initialization failure closes the listener and local resources and exits
nonzero so the platform can restart the process. It cannot leave a live but
permanently unready server behind. A projection schema mismatch discards the
database and triggers a full rebuild. In-place projection migrations are
unnecessary because the database is disposable.

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
selection. When that policy requires token metrics, `input_tokens` and
`output_tokens` must satisfy its declared integer and range constraints. Control
code evaluates the policy without branching on a benchmark, model, or harness
name.

The control service evaluates the policy before every terminal selection. Worker
outcome names and worker-supplied replacement flags cannot make an invalid receipt
selectable. A zero, missing, negative, fractional, or non-finite required metric
makes the attempt invalid for selection.

An invalid physical execution remains in the Bucket with its evidence and cost.
A replacement-eligible infrastructure failure leaves the logical task
unresolved. After cleanup, the reconciler starts that task again from its
original prepared input. A non-infrastructure terminal outcome that fails the
locked evidence policy is exhausted and is not retried automatically.
Infrastructure retries have no policy attempt-count limit and do not consume
another benchmark trial. Cancellation, pause, an admission failure, the finite
action-key space or the run cost ceiling can stop new Jobs. A repeated
deterministic failure pauses the affected work for repair.

A run is complete only when every locked logical task has exactly one selected
attempt and every selection passes the locked evidence policy. Exhausted tasks
stay on the run while other tasks can still run. The run is failed only after
every logical task is sealed and at least one task has a non-replaceable
exhausted outcome. Replacement-eligible infrastructure outcomes remain
unresolved or paused until retried, repaired, or cancelled. Historical records
remain byte-for-byte unchanged. Projection replay may label an old run
`completed-invalid` when its historical selection does not pass the current
read-only audit.

## Task result persistence and retry

The unit of durable progress is a finished benchmark task. A worker uploads the
complete task result, receipt, logs, trajectory, usage, cost and provenance to
the existing private Bucket before the control service selects it. The service
reads the objects back and verifies their digests. Once selected, that task is
complete and later Jobs do not run it again.

A physical Job that ends with a replacement-eligible infrastructure failure
leaves the task unresolved. After cleanup, the reconciler starts the same
prepared task from the beginning in a new Job. It keeps every failed execution
and its observed cost. The new Job does not restore conversation state,
workspace state, a partial model response or a live process.

Retry actions use deterministic identities. A repeated request adopts the same
matching action and rejects conflicting bytes. Infrastructure retries have no
policy count. They continue while the run is active and admission remains
within its approved cost and resource limits. Cancellation or pause stops new
Jobs. Exhausting the finite action-key space pauses the run before reservation.
A repeated deterministic shared failure also pauses the affected fleet until a
reviewed repair is available.

A reviewed worker repair may run an unresolved task with a new worker. A normal
resume is not a repair. Historical retries use the immutable continuation-repair
attachment, and a run without a compatible attachment stays paused rather than
retrying the unchanged broken worker. Control records retain every physical
Job, worker and repair generation, usage and cost. Valid completed-task receipts
remain selected, so recovery schedules only the unresolved task IDs.

Final publication selects one valid receipt for every logical task and retains
the complete physical Job, worker, usage, cost and repair history. The
[task result persistence and retry plan](2026-09-01-task-result-retry-plan.md)
defines implementation and verification.

## Safe publication and supersession

Internal result publication is private and is not public leaderboard approval.
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
the inference-only credential. A direct profile reconstructs the exact resolved
`AgentConfig`; Harbor expands the credential reference for the selected reviewed
agent, which calls the locked upstream directly. An approved compatibility
profile first executes its pinned root bootstrap and removes the raw credential
before starting its pinned worker. The worker then runs the locked task rootfs
as the dedicated unprivileged host UID. It does not bind host `/run`, `/tmp`,
the root workspace, capability material, or token files. A host `/proc` view may
expose metadata, but the different real UID and absent capabilities prevent task
reads of root process environments and file descriptors.

Runtime stop enumerates the dedicated real UID, sends `SIGSTOP` until the
process set is stable, sends `SIGKILL`, and verifies that no process remains.
This covers `setsid` descendants and processes that fork during cleanup. Trial
evidence returns through content-addressed worker uploads. An unresolved task
can receive another infrastructure execution while admission remains authorized.
Valid selected tasks are never rerun.

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

- modify or monkeypatch Harbor;
- resolve benchmark formats outside Harbor;
- run benchmark agents in the Space;
- load or serve models;
- translate between inference APIs;
- infer unobserved provider hardware or model revision;
- keep durable state only in SQLite;
- expose the Bucket to browsers;
- create active-active control replicas;
- add benchmark-, model-, or harness-name branches to core code; or
- rewrite historical evidence.

## References

- [Architecture](architecture.md)
- [Harbor compatibility contract](harbor-integration-contract.md)
- [Harbor agent architecture](provider-agent-architecture.md)
- [Hosted operations cookbook](harbor-cookbook.md)
- [Trial evidence bundle](trial-evidence-bundle.md)
- [Hugging Face Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker)
- [Hugging Face Spaces OAuth](https://huggingface.co/docs/hub/spaces-oauth)

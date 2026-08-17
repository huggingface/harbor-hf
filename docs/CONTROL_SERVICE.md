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
promotion for each kind and alias. Candidate and recommended records remain
visible but cannot authorize a campaign. A campaign lock retains the selected
alias, immutable profile digest, and complete spec even when that alias later
moves. Canonical migration preserves profile objects and promotion records.

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
POST /api/v1/campaigns/{campaign_id}/actions
GET  /api/v1/jobs
GET  /api/v1/endpoints
GET  /api/v1/profiles
GET  /api/v1/results
GET  /api/v1/audit
GET  /api/v1/events
```

Collection routes use opaque cursor pagination and bounded page sizes. All
timestamps use UTC RFC 3339 strings. Responses distinguish observed state,
recommended action, and approved action.

Mutating requests require an `Idempotency-Key`. A successful mutation writes
its immutable intent to the Bucket before the API returns `202 Accepted`. The
response contains the deterministic action ID and a link to its current state.
A local SQLite write cannot authorize or acknowledge a remote side effect.

Errors use one JSON envelope with a stable code, human-readable message,
request ID, and optional field errors. Raw provider bodies and dependency error
strings never cross the API boundary.

Workers receive a short-lived signed control capability and never receive
`HF_TOKEN` or a writable Bucket mount. Deployment profiles declare the worker
inference credential `required` or `forbidden`. A required profile receives only
`HF_INFERENCE_TOKEN` as an encrypted Job secret; a forbidden profile receives no
operator-managed secret. The capability is scoped to one namespace, campaign,
launch action, task set, and expiration. It authorizes only the campaign-lock
and attempt-receipt routes.

An inference-required deployment also locks maximum requests, concurrency,
upstream timeout, and output tokens. The service supplies those non-secret
limits to the worker. The root-owned bridge accepts only the selected Chat
Completions or Responses path, the locked model, approved Hugging Face hosts,
and requests within those limits.

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
- terminal invalid, policy, cancellation, verifier and benchmark failures;
- physical attempt counts;
- reserved, observed and reconciled cost plus the approved ceiling;
- requested and observed endpoint state;
- publication and cleanup state;
- the immutable action and event timeline.

A campaign is not complete while publication or required endpoint cleanup is
unresolved. Publication failure does not reopen completed benchmark work.

## Web routes

The React application provides:

| Route | Content |
| --- | --- |
| `/` | Queue, active campaigns, failures, spend and endpoint safety. |
| `/campaigns` | Searchable and filterable campaign list. |
| `/campaigns/:campaignId` | Campaign progress, task states, cost, publication, cleanup, endpoint safety, and timeline. |
| `/campaigns/:campaignId/tasks/:taskId` | Logical outcome and every physical attempt. |
| `/jobs` | HF Job identity, state, ownership, timing and infrastructure failures. |
| `/endpoints` | Endpoint ownership, requested state, observed state, active cost, and cleanup. |
| `/results` | Normalized results, comparisons, publication evidence, and provenance. |
| `/profiles` | Immutable profiles, aliases, promotions, approval state, and resolved locks. |
| `/audit` | Action intents, receipts, actors, integrity failures, and policy stops. |

The interface supports keyboard navigation, narrow viewports, light and dark
color schemes, visible focus, and reduced motion. Tables virtualize only when a
measured row count requires it. Every status also has text and an icon; color is
never the only signal.

## Authentication and authorization

The Space is publicly reachable so Jobs can present short-lived worker
capabilities without receiving a Hugging Face credential. Anonymous callers can
reach static application assets, login and callback routes, and minimal health
checks. Control data and mutations remain protected by the application.

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
authentication, API, and static routes, so exhausting one does not block an
authorized worker or operator. Authentication runs before request-body parsing,
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
only by the worker campaign-lock and attempt-receipt routes, is redacted from
logs, and cannot invoke operator or collection APIs.

The built-in control smoke Job runs a reviewed inline script in a digest-pinned
official Node.js image. Its deployment forbids inference, so it refuses both
operator-managed credentials, reads its
campaign lock, uploads canonical evidence, and submits one task receipt through
its scoped capability. Control smoke success requires that worker receipt, so a
completed Job cannot hide a broken callback path.

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
- full projection rebuild on an empty local filesystem.

## Deployment and replacement

The public Harbor-HF repository remains the source of truth. A release command
publishes an exact reviewed source revision to the application-protected Space. Operators do
not edit the Space repository by hand. Deployment must not require another
long-lived credential in CI.

The replacement is a hard new-write switch. Before it begins, all active legacy
controllers must finish, every managed endpoint must be paused, the new Space
must pass recovery tests, and normalized result catalog data must exist in the
Bucket.

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

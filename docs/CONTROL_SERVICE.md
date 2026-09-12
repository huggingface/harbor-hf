---
title: Control service
author: Harbor-HF maintainers
date: 2026-09-04
tags: [operations, api, space, jobs]
---

# Control service

## Purpose

The control service is one Node.js process in a private Docker Space. It serves
the Fastify API and React application, rebuilds SQLite from the private Bucket,
and reconciles parent and child HF Jobs.

The service is the only run control authority. Parent Jobs call Harbor on local
`/data` disk without a Bucket mount and copy native files through the Hub SDK to
the existing private Bucket. They preserve immutable attempt-cost receipts with
those acknowledged snapshots so saved retry costs survive a parent restart.
Reviewed benchmark presets select either CPU Basic or CPU Upgrade for temporary
task Jobs; they cannot select accelerator hardware.

## Parent storage and snapshots

The approved local parent implementation restores `runs/<run-id>/` into a fresh
local directory via the SDK and delegates resume to native `Job.create()`. It
reads `state.json` afresh through the Bucket API before START and END callbacks;
the parent never uploads controller-owned run or state records. Control Space
storage, Bucket identity, and the three-table projection remain unchanged.

The parent launch supplies `HARBOR_HF_LOCAL_ROOT` (default `/data`) and
`HARBOR_HF_BUCKET_ID` instead of `HARBOR_HF_MOUNT_ROOT`, with no Bucket volume.
These are runtime environment values, not new durable schema fields or Space
storage settings. Native `jobs_dir` must still match the immutable run path.

Lifecycle uploads supply native job config, lock, and result metadata. Per-trial
uploads copy current bytes, publish the subtree root result last, then publish
job metadata and cost receipts. The dashboard needs these native snapshots and
HF Job observations; it does not invent progress or operate a second scheduler.
This is snapshot observability, not streaming live logs or a full POSIX promise
for Bucket storage. Polling cannot expose local output not yet uploaded.

A separately approved private adapter invokes the actual trial
`Trial._scrub_jobs_dir()` before END callbacks, retaining native `finally`
scrubbing. Its revision check and failure veto are explicit. Native scrubbing is
best-effort UTF-8 text handling, not arbitrary secret safety; job-level logs,
aggregation, and skipped files have no stronger guarantee.

Only successful execution or a handled expected cost/control stop proceeds to a
final whole-tree copy, with receipts first and aggregate result last, subject to
the scrub failure veto. Unexpected failures rely on the last acknowledged
per-trial copies. Upload failures propagate. A hard kill can lose unsaved output
and cost evidence; forced cancellation cannot guarantee cleanup or final copy.
Size local disk for restored and working artifacts.

See [Local parent storage](2026-09-11-local-parent-storage.md) for implementation
evidence, unchanged-schema comparison, and removal of the private workaround at
the first supported native post-scrub hook/pin. This documents local approval,
not deployment or remote validation.

## Run diagnostics

Runs, run detail, and trial lists refresh through existing ten-second browser polling
and the control projection. The Runs diagnostics column groups native Harbor
exceptions with links to trial evidence; missing or inconsistent evidence remains
unknown/partial. Finished execution does not imply passing or valid scoring.
Infrastructure and verifier-bootstrap classifications require upstream typed
Harbor evidence; this view does not infer them from logs or rewards and never
changes scores or retries.

Freshness uses the server's `observed_at` against the actual render-time clock,
not the last browser timer tick or fetch completion time. The shared display
clock advances during pending requests and on focus/visibility return. A failed
refresh with recent cached evidence shows a quiet Retry/Retrying control, not
Stale; artifact cells still describe that evidence, never live execution.
Observations older than 60 seconds, missing/malformed timestamps, or timestamps
more than five seconds ahead are stale/unavailable. Without cached data a failed
request is Unavailable. Successful fetches of an old snapshot do not renew its age.

Ten seconds is the visible-tab polling interval, not a delivery guarantee:
requests may take longer and polling restarts after completion without catch-up.
Background tabs may pause or throttle polling. Artifact reads are on demand with
a 10-second backend cache, regardless of run status. The separate reconciler
defaults to 15 seconds, is configurable via `HARBOR_HF_RECONCILE_INTERVAL_MS`, and
skips ticks while a pass is running. Neither interval guarantees update latency.
New responses render immediately, independently of the age timer.

Run detail also keeps each agent's stored model/route, version, and reasoning
kwargs together. These are configured values, not verified provider-effective
settings. See [Run diagnostics and configuration provenance](run-diagnostics.md)
for the source boundary, completion investigation, and proposed upstream evidence.

Workbench additionally records verbatim free-text reasoning intent as submission
metadata only; the recipe remains execution authority. Benchmark agent execution
budgets use restricted native AgentConfig fragments, not duplicate timeout fields.
See [Agent Workbench](agent-workbench.md#recorded-reasoning-intent).

## Shared archive visibility

Operators can Archive/Restore a run for all users through the existing write-mode
and CSRF protections. Default Runs visibility is **Not archived**, with Archived
and All filters combined with role and search. Direct detail URLs remain readable
in every state; running jobs continue. List/detail GETs return all runs from SQL.
The optional versioned `presentation.json` record is separate from `run.json`,
`state.json`, and Harbor output. Malformed presentation data cannot block
execution reconciliation; responses expose ephemeral availability and preserve
last-known archives, while unknown archives remain discoverable with warnings.
Archive writes require validated metadata; conflicts synchronize the SQL cache
before returning 409. See [Shared run archive](run-archive.md) for the
single-authority revision protocol, rebuild race protection, and review table.

## Shared pricing corrections

Operators can append audited shared estimate rates without altering immutable launch
pricing, native reported cost or execution. See [Audited pricing corrections](run-pricing-corrections.md)
for the bounded history document, fresh revision checks, SQL rebuild fencing and
fail-closed estimate availability. Runs/detail and leaderboard remain SQL-backed.

## Persistent resources

A hosted installation uses:

- one private Docker Space for the control service
- one private Bucket for run records and Harbor output

Do not create a resource per run. SQLite files and HF Jobs are temporary. The
three-table projection rebuilds from run records, Harbor results, attempt cost
receipts, and current Job observations.

The Space has two secrets:

- `HF_TOKEN` is a purpose-scoped control credential with access to the Bucket,
  HF Jobs, and approved private Hugging Face Dataset Git repositories when they
  are configured.
- `HF_INFERENCE_TOKEN` is a separate inference credential for the Hugging Face
  router.

The values must differ. Keep both out of Space variables, source files, build
arguments, request bodies, Job labels, and logs. The control and parent images
must include Git LFS so Harbor can materialize LFS objects from admitted private
Dataset repositories. The clean Git process environment supplies the standard
`filter.lfs.*` settings for each temporary clone because global and system Git
configuration is disabled. Private Dataset admission fails if Git LFS is not
available.

## Configuration

The service reads these Space variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `HARBOR_HF_NAMESPACE` | yes | none | HF Job namespace |
| `HARBOR_HF_BUCKET_ID` | yes | none | private Bucket ID |
| `HARBOR_HF_STORE_MODE` | no | `bucket` | use `filesystem` in tests |
| `HARBOR_HF_BUCKET_ROOT` | no | `/data` | local filesystem store root |
| `HARBOR_HF_PRESETS_ROOT` | no | `./presets` | reviewed presets |
| `HARBOR_HF_LAUNCH_PYTHON` | no | worker package `.venv/bin/python`; `/opt/harbor-launch/bin/python` in the control image | pinned native launch inspector |
| `HARBOR_HF_APPROVED_AGENT_SOURCES` | no | `[]` | reviewed native ACP source objects as JSON; never credentials |
| `HARBOR_HF_WRITE_MODE` | no | `disabled` | permit Job lifecycle changes |
| `HARBOR_HF_PARENT_IMAGE` | in write mode | none | immutable parent image digest |
| `HARBOR_HF_PARENT_HARDWARE` | no | `cpu-basic` | parent Job hardware |
| `HARBOR_HF_PARENT_TIMEOUT_SECONDS` | no | `86400` | parent Job timeout |
| `HARBOR_HF_MAX_ACTIVE_JOBS` | no | `16` | live parent Job limit |
| `HARBOR_HF_RECONCILE_INTERVAL_MS` | no | `15000` | reconcile interval |
| `HARBOR_HF_PARENT_RESTART_DELAY_MS` | no | `60000` | failed parent restart delay |
| `HARBOR_HF_PROJECTION_PATH` | no | `/tmp/harbor-hf/control.sqlite` | SQLite projection |
| `HARBOR_HF_AUTH_PATH` | no | `/tmp/harbor-hf/auth.sqlite` | OAuth session store |
| `HARBOR_HF_WEB_ROOT` | no | `./apps/control-web/dist` | built web application |
| `HARBOR_HF_SOURCE_REVISION` | no | `development` | deployed source revision |
| `HARBOR_HF_WORKBENCH_RUNNER` | no | `disabled` | `disabled`, local `docker`, or hosted `hf-jobs` setup tests |
| `HARBOR_HF_WORKBENCH_IMAGE` | for hosted setup | parent image | immutable setup Job image |
| `HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS` | no | empty | comma-separated explicit operator subjects |
| `HARBOR_HF_OPERATOR_ORG_SUBJECT` | no | empty | stable HF organization subject whose members are operators |

Write mode fails startup unless both secrets and an image reference ending in
`@sha256:<64 lowercase hex characters>` are present.

Hugging Face supplies the OAuth client values to the Space. OAuth mode requires
`OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, and `OPENID_PROVIDER_URL`. The service
uses a 30-day browser session and `openid profile` scopes by default. When
`HARBOR_HF_OPERATOR_ORG_SUBJECT` is set, it also requests `read-memberships` and
requires that stable organization subject during sign-in. It never authorizes an
organization by name. Explicit user subjects remain available for administrators
and exceptions. Logging out, losing explicit authorization, changing the
configured organization, or clearing browser cookies ends the session sooner.

### Private dataset credentials

A reviewed benchmark can use a private Hugging Face Dataset Git repository
through Harbor's native dataset `repo` and `path` fields. The repository URL must
use HTTPS, the exact `huggingface.co` host, the
`/datasets/<namespace>/<dataset>.git` path, and an exact 40-character commit. It
must not include credentials, a port, query, or fragment. Public GitHub source
admission remains unchanged.

No additional secret is required. Grant the existing purpose-scoped `HF_TOKEN`
read access only to each approved private Dataset repository that the deployment
must run. Control-side launch inspection and the trusted parent Job configure a
non-persistent Git credential helper. The helper returns credentials only for
`huggingface.co` and reads the token from the current process environment.

The control token must not appear in the repository URL, process arguments, Git
credential files, run configuration, Bucket objects, projections, browser
responses, or logs. It must not enter trial agent environments or agent source
installation. The separate inference credential path remains unchanged.

Admission and repository inspection occur before model inference. A missing
token, denied repository, missing commit, malformed source, or native Harbor
resolution failure stops the launch. The service does not fall back to another
source or revision.

### Sign-in diagnostics

Open the app directly and start a fresh login at `/auth/login`; do not reload
an old callback URL. A completed OAuth exchange does not itself grant operator
access. At every service startup, `apps/control-api/src/runtime.ts` constructs
an in-memory ACL from `HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS`; there is no
separate ACL file in the Bucket. The configured user subjects become explicit
operators, and the reader list is empty. An optional
`HARBOR_HF_OPERATOR_ORG_SUBJECT` also grants operator access to members returned
by OAuth user info.

To grant explicit operator access, append the account's stable Hugging Face user
ID, not its username, to the comma-separated Space variable while preserving
existing operators. To grant organization access, set the stable organization
subject, not its name. Restart the Space to reload either value, then start a
fresh login. Despite its bootstrap name, the explicit-user variable is read on
every startup, not only during initial installation. Keep user and organization
IDs in private Space configuration, not repository files.
`HARBOR_HF_WRITE_MODE` controls operations, not sign-in authorization.

Callback failures emit `OAuth callback failed` with the request ID, a fixed
`oauth_stage`, and `code`. No callback query strings, request headers, cookies,
provider error messages, or token responses belong in these diagnostics.

| Stage | Check |
| --- | --- |
| `configuration` | Space-supplied OAuth configuration and initialization |
| `flow` | Start a fresh login; check cookies and whether the Space restarted |
| `token_exchange` | Callback origin, provider configuration, and a fresh authorization flow |
| `user_info` | Provider user-info availability and identity response |
| `authorization` | `access_denied` (403) means the identity is neither explicit nor in the configured organization; `oauth_failed` means the authorization check failed |
| `session` | Local session-store availability |

These stages identify where sign-in failed, not necessarily its root cause.
Do not copy callback URLs, cookies, tokens, or raw runtime logs into public issues.
The anonymous session endpoint returns one 401 response; it does not create a
session or grant access. Existing deployments may retain older sensitive logs;
handle those privately under the deployment's log-retention policy.

Overview and Workbench share the input and native `n_concurrent_trials`
submission behavior. The all-task presets default to 8, the one-task preset to
1, and both forms accept explicit values from 1 through 128. This change affects
new submissions only, not stored runs or explicitly saved draft values.

The shared selector also offers **terminal-bench-2-1 · three-tasks-3-trials**:
`code-from-image`, `log-summary-date-ranges`, and `openssl-selfsigned-cert`,
with native `n_attempts: 3` (nine trials for one agent). This diagnostic preset
is not leaderboard eligible. It copies the one-task preset's pinned dataset,
CPU environment, and timeout multipliers, but defaults concurrency to 3 to bound
simultaneous canary work; both forms retain the normal explicit override.

Preset review checked Harbor `src/harbor/job.py` and
`src/harbor/models/job/config.py` at
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`: Harbor expands repetitions and
filters task names natively. Public upstream history through `1f84b4c0` requires
no pin update for this configuration-only addition. All three task directories,
including `task.toml` and `instruction.md`, were verified through the public
source tree at dataset revision `d49e28f1e4ddd13d289e85a5f312a66750951932`.
No local Harbor execution or inference is needed to load or test the preset.

The **terminal-bench-2-1 · two-tasks-1-trial-workdir-smoke** diagnostic
preset selects `prove-plus-comm` and `openssl-selfsigned-cert`: one attempt per
task (two logical trials for one agent), concurrency 2, and zero retries. It
retains the 3×3 smoke's canonical dataset revision, CPU environment, unlimited
parent Job timeout, and agent/setup timeout multipliers of 4/2, without a
six-hour override. Existing presets and the selector default are unchanged.

At that pinned dataset revision, the task Dockerfiles declare `/workspace` and
`/app`, respectively; neither `task.toml` sets `environment.workdir`. This checks
two image defaults, not explicit overrides (covered by CommandAgent unit tests).
Use the same CommandAgent recipe as the affected run **after the PR #208 agent
fix is deployed in the worker**. A preset alone cannot repair an old worker.
No task revision, image change, source fork, or launch accompanies this addition;
execution order is Harbor-owned. Native task filtering and attempts were checked
in Harbor `src/harbor/models/job/config.py` and `src/harbor/job.py` at the pin
above, with upstream history reviewed through `191d1b98`; no resolver or pin
change is needed for this configuration.

The separate [New Job page](CONFIGURABLE_LAUNCH.md) edits native configuration
through the existing direct submission route. It uses native Harbor concurrency
validation and an aggregate inspection budget, not a separate concurrency cap.
Its hardware choices come from the HF Jobs catalog. Native JSON draft links can
restore editable input but never authorize a launch. Preset and Workbench
submission remain available.

## HTTP API

Health routes are public:

- `GET /health/live`
- `GET /health/ready`

The public data route is:

- `GET /api/v1/leaderboard`

Session and OAuth routes are:

- `GET /api/v1/session`
- `GET /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`

Authenticated read routes are:

- `GET /api/v1/system`
- `GET /api/v1/presets`
- `GET /api/v1/agents`
- `GET /api/v1/hardware`
- `GET /api/v1/model-providers?model=...`
- `GET /api/v1/workbench/setup-tests`
- `GET /api/v1/workbench/setup-tests/{setup_test_id}`
- `GET /api/v1/workbench/setup-tests/{setup_test_id}/logs`
- `GET /api/v1/workbench/setup-tests/{setup_test_id}/files/{file_id}`
- `GET /api/v1/runs`
- `GET /api/v1/runs/{run_id}`
- `GET /api/v1/runs/{run_id}/progress` (allowlisted native artifact observations)
- `GET /api/v1/runs/{run_id}/trials`
- `GET /api/v1/runs/{run_id}/trials/{trial_name}`
- `GET /api/v1/jobs`

Operator write routes are:

- `POST /api/v1/workbench/preview`
- `POST /api/v1/workbench/setup-tests`
- `POST /api/v1/workbench/setup-tests/{setup_test_id}/cancel`
- `POST /api/v1/runs`
- `POST /api/v1/runs/config`
- `POST /api/v1/runs/validate` (inspection only; creates no run)
- `POST /api/v1/runs/{run_id}/pause`
- `POST /api/v1/runs/{run_id}/resume`
- `POST /api/v1/runs/{run_id}/cancel`
- `PATCH /api/v1/runs/{run_id}/presentation` (shared archive/restore; no execution change)

Preset, Workbench, setup-test, and direct submissions require
`Idempotency-Key`. Direct submissions also require
`X-Harbor-HF-Cost-Ceiling-USD` for the complete campaign. The configurable page
also sends the Validate fingerprint in `X-Harbor-HF-Validation`; a changed
request or admission
policy returns 409. Native validation and Workbench preview remain available
when writes are disabled. Local Docker setup tests also remain available in
explicit development mode, and setup cancellation remains available for safe
cleanup.

Browser writes use the session cookie and CSRF token. CLI requests use an
approved bearer token. Readers can use authenticated GET routes but cannot
change runs.

Pause and cancel first stop live parent Jobs. A later reconciliation stops any
remaining labeled child after the parent is terminal. If Harbor still reports
an in-flight trial as terminal during this stop, the parent preserves any
reported provider cost and removes the interrupted result when a handled stop
allows cleanup. After acknowledged copies, the saved Harbor folder stays
resumable with those cost receipts. A forced stop can prevent these copies and
lose unsaved paid-use evidence.

The parent keeps the cost that Harbor reports for each attempt. A failure before
agent execution records zero cost. Any null cost remains null in its immutable
receipt and contributes zero to the ceiling calculation. This control policy
does not change the receipt or claim that the provider observed zero cost. The
parent checks existing receipts before `Job.run()` and writes each new receipt
before it makes a stop decision.

The parent compares the sum of all attempt receipts with the campaign ceiling.
It never divides that ceiling into per-trial limits. Existing immutable runs
with the legacy per-trial field keep per-trial enforcement and use the same
null-as-zero calculation. When the known campaign total crosses its ceiling, the
parent reads Harbor's current
`JobResult`. It raises the cost-stop exception while more work can spend money or
while completion is uncertain. It
suppresses the exception only when the native total matches the configured job
size, completed equals total, running and pending are zero, and retries are
disabled. Missing, malformed, inconsistent, incomplete, running, pending,
mismatched-total, or retry-enabled state fails closed.

A proven complete run stays in the same `Job.run()` call so Harbor can perform
normal final aggregation and write `finished_at`. During this short interval,
the reconciler leaves the already-live parent running when Harbor's native
counters show completed equal to total, zero running and pending trials, and
zero retries. It never starts a replacement parent for a cost-stopped run. A
missing, inconsistent, incomplete, or retry-enabled state still stops the live
parent. Pause and cancel also still stop it.

The control projection still reports `cost_stopped`. The timestamp means
execution is complete and does not mean that the run complied with its cost
limit. Harbor-HF does not count trial folders, copy retry logic, or store
another completion value.

## Observational trial waffle

The Runs overview remains a list with compact progress counts and native diagnostics;
it makes no trial-progress requests. The individual run detail page shows a waffle
beneath the summary cards, before identity and submission. Each task/input digest
has one labelled column and one compact square per job-lock entry (or per observed
trial when no job lock is available). The existing trials table remains available
for reported agent/model metadata, status, reward, cost, and full trial navigation.
The waffle’s
read-only progress endpoint lists native `job/lock.json` trials without deduplicating
repetitions, and observes each trial's `config.json`, `lock.json`, and `result.json`.
Trial locks supply the durable input digest, including for finalized trials;
Harbor's legacy result checksum is a different hash and is never equated with a
lock digest. Task names and lock input digests group display columns. Native
`trial_name` keys remain distinct. When a job lock is available, only its entries
create planned squares: nine entries always produce nine squares. Current native
trial locks map by exact task name and input digest, up to that group's capacity.
Mount-local assignments preserve current names' positions where possible; removed
names release capacity immediately. Replacements are not asserted to be equivalent
logical repetitions. Native identity keys prevent a different trial filling a slot
from inheriting its focus. Config-only, unmatched and excess observations appear
in a separate explicit list/count, never adding planned capacity. Removed observations
remain in that mount-local list, labelled absent from the current snapshot, not
terminal. Remounting discards removal history, not planned capacity. The same native
name moves globally without leaving a reservation in an old group. Without a job
lock, squares show observations only and the planned total is explicitly unknown.
Nothing is persisted or sent to execution. Slots are neither Harbor attempt ordinals
nor equivalent repetitions across runs.

A planned square without a mapped observation is labelled **No mapped observation**,
not proven queued. A fresh unfinished config/lock is **Unfinished
artifact observed (live state unknown)**. Neither a live parent nor Harbor's
aggregate heartbeat establishes per-trial execution. Unfinished observations
become uncertain when their timestamp is stale/unavailable, not merely because a
refresh failed. The freshness window is 60 seconds, as described above. Finalized
native results supply outcome, reward, and reported cost;
missing reward is never scored as zero. Missing cells are **Unknown / not observed**
unless an available prepared lock excludes that task/input group. A repeated
trial's absence cannot be inferred from its display slot or a repetition count.
Native `n_pending_trials`, `n_running_trials`, and `n_completed_trials` remain the
aggregate authority. No controller or completion behavior reads waffle state.

Parent and child HF Jobs are displayed separately with their provider-observed
queued/running/stopped/error states and snapshot time. Queued means waiting at HF,
not a named trial waiting for a particular dependency. Failed reads retain cached
evidence with a Retry/Retrying control; Stale depends on observation age and
timestamp validity. Without cached evidence, failed reads show Unavailable. HF Job
freshness uses its separate observation timestamp. The display clock also expires
observations during a hung refresh. Missing or malformed artifacts do not become
invented successful or zero-reward results.

The API shares artifact snapshots across callers for 10 seconds, coalesces in-flight
reads per run, and retains at most 64 snapshots (including pending requests). At
capacity it evicts a settled snapshot or rejects new work until capacity is
available; it never evicts pending work to launch duplicate listings. The decoded
artifact cache remains bounded at 8192 entries and follows provider content
identities. Expired snapshots are re-listed so additions and removals are observed;
a failed refresh invalidates the snapshot and decoded run entries and propagates
the error, never falling back to stale success. The original artifact observation
time is retained on cache hits; provider observations are attached independently
on every response. This cache is populated on demand, not by a status-dependent
background scan. Explicit retry still surfaces read failures.

Boundary review: also inspected `src/harbor/job.py` (resume removes unfinished
folders and regenerates remaining configs/names) and `src/harbor/trial/trial.py`
(native lock precedes config, although partial API observations are supported).
Inspected Harbor `src/harbor/models/trial/config.py`,
`src/harbor/models/trial/result.py`, and `src/harbor/models/job/lock.py` at the pinned
revision `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`, and upstream history through
`1f84b4c0`. These artifacts do not supply a per-trial live-running assertion or a
cross-run repeated-trial ordinal. The intervening changes do not add one. This UI
therefore preserves unknown states rather than patching Harbor or changing the pin.


The waffle requests only the open run, polls every 10 seconds while visible
regardless of run status, and renders 100 task columns per page without splitting
repeat rows. Search matches task, input, trial, state, or native exception and
retains whole matching columns; totals and separate observations remain unfiltered.
Navigation to another run resets filters, focus/tooltips, and mount-local
observation history.
The reader bounds concurrent artifact reads
and caches unchanged content identities in memory. It exposes only allowlisted
identity, timing, outcome and cost fields, never raw agent config, credentials,
logs or trajectories. Observations can span writes; they are not atomic execution
snapshots. No Bucket records, additional SQLite tables, Harbor patches, or second
scheduler are introduced.

The portable response contract is authoritative JSON Schema in
`packages/contracts/schemas/trial-progress-v1.schema.json`, with generated server
and browser types. Validation strips non-allowlisted native fields and rejects
malformed timestamps or identities inconsistent with the trial folder. Receipts
are not results: neither receipt presence nor cost proves trial success. Completed
means a native finish without a reported exception, not a positive reward.

Harbor boundary checked: pinned `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`
and public upstream history through `1f84b4c0`, including
`src/harbor/job.py`, `src/harbor/trial/trial.py`, `src/harbor/models/job/lock.py`,
`src/harbor/models/job/result.py`, `src/harbor/models/trial/config.py`, and
`src/harbor/models/trial/result.py`. None of the intervening changes adds stable
pending identities or a per-trial live artifact API, so no pin update implements
this hosted view. Those are upstream gaps, not authority to synthesize execution
state here. The
adapter only reads native config/lock/result artifacts; it does not import Harbor.

## Startup

The Space opens port 7860 before the Bucket scan. This lets the platform observe
liveness during a long projection rebuild. Readiness returns HTTP 503 until
OAuth initialization, preset validation, Bucket reads, and the first Job list
complete.

The reconciler starts only in write mode. Turning write mode off keeps the API
and projection available without starting or stopping Jobs. The read-only Jobs
port still lists owned Jobs, so live state does not disappear from the
projection during deployment.

## Parent image

The parent image is built from `deploy/parent-worker/Dockerfile`. It pins Harbor
to the revision recorded in `packages/harbor-hf-agents/pyproject.toml` and
contains the Harbor parent runner, the reviewed agents, the generic Workbench
command agent, the labeled HF Sandbox adapter, and the host-restricted Git
credential helper used for admitted private Hugging Face Dataset sources. Remove
the local helper when the pinned Harbor release provides an equivalent
documented credential mechanism.

Publish an `linux/amd64` image with the `Publish parent worker` workflow. Record
the registry digest from the workflow output. Configure the control Space with
the full immutable reference. A tag alone is rejected.

The package path retains the existing container repository name to avoid a
second persistent registry resource. The image role is now the parent worker.

Control/API/browser-only changes can reuse the existing verified immutable parent
and Workbench image digests when `packages/harbor-hf-agents`, its dependency lock,
and `deploy/parent-worker/Dockerfile` are unchanged. The parent Dockerfile copies
only that Python package; Space bundling and deployment do not rebuild the parent
or modify the image settings. The observational waffle changes require no Python
change, parent-image publication, or credential movement. Keep the existing image
references; rebuilding the control Space is a separate, explicitly approved step.


## Deployment

A release bundle comes from a clean commit:

```bash
npm run bundle:space -- /tmp/harbor-hf-space
npm run deploy:space -- '<namespace>/<control-space>'
```

The bundle records the exact source revision and lockfile digest. Deployment
uses the authenticated `hf` CLI in place and does not copy a credential.

Before enabling writes:

1. publish and test the parent image;
2. set `HARBOR_HF_PARENT_IMAGE` to its immutable digest;
3. set `HARBOR_HF_WORKBENCH_RUNNER=hf-jobs` and use the same immutable image for
   `HARBOR_HF_WORKBENCH_IMAGE` when hosted setup tests are required;
4. verify that the two Space secrets are present and distinct;
5. when private Dataset sources are configured, verify that `HF_TOKEN` has read
   access to the approved repositories and that pinned source inspection passes;
6. keep `HARBOR_HF_WRITE_MODE=disabled` for the first startup;
7. verify liveness, readiness, OAuth, presets, Bucket projection, Workbench
   runner state, and the source revision; and
8. set write mode to `enabled` and restart once.

After deployment, verify the intended repository revision, runtime revision,
Space stage, build logs, runtime logs, and authenticated `/api/v1/system`
response. A private Space can return an unsigned 404, so use an authenticated or
signed application probe.

## Validation

Run the local gates from the repository root:

```bash
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov=src/harbor_hf --cov-fail-under=85
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run check:generated
npm audit --audit-level=low
npm run test:e2e
```

Also build both Dockerfiles for `linux/amd64` and run the agent package checks in
`packages/harbor-hf-agents`.

### Waffle native exception evidence

The run-detail waffle reads historical and future native trial `result.exception_info`
from the existing progress API; it needs no migration or remote execution. Each
square's keyboard/hover tooltip reports the exact recorded `exception_type`.
Per-run disclosures show trial exception badges and links to the existing native
trial detail and traceback. The existing run exception projection also links to
`JobResult.stats.evals[*].exception_stats` groups from the overview diagnostics
column and the summary above the detail waffle.

An explicitly null `exception_info` means no recorded exception, not proof of
valid scoring. Absent evidence remains unknown / unavailable. Types are not
infrastructure or verifier-bootstrap classifications. Exception presentation does
not change waffle state colors, reward semantics, run status, or configuration
provenance. Removed observations remain labeled as removed, not terminal outcomes.
No additional schema, persisted field, API, or worker behavior is introduced.

Harbor boundary rechecked at `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:
`src/harbor/models/trial/result.py` (`ExceptionInfo`, `TrialResult`) and
`src/harbor/models/job/result.py` (`exception_stats` aggregation). History through
`90e28af3` does not change these native fields; the viewer change `2da50a93`
concerns schema-driven launcher agent options, not exception evidence. Harbor-HF
only presents native output through its existing read APIs; no upstream gap or
pin update is needed for this display.

### Compact run status

The list and detail card keep execution state in a status-only badge. A separate
single-line agent-time label retains a visible partial or unavailable marker;
exact complete, partial and unavailable counts are available on hover or keyboard
focus through the native Hint. This avoids multi-line coverage captions without
presenting missing measurements as complete or as zero. Timing arithmetic,
Harbor result interpretation and pricing are unchanged.

Boundary review: checked `src/harbor/models/trial/result.py` at Harbor pin
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` and the available upstream history
through `7d5285b4`. This is console layout only; existing projected native result
measurements remain authoritative. No schema, persisted field or API changed.


## Local provider credential references

Workbench supports operator-managed Space secret references for
provider inference: the app selects reviewed references and shows presence only,
never accepts or stores key values. Explicit environment bindings deliver only the
selected credential to reviewed execution. See [Provider credential references](provider-credential-references.md)
for the operator-only register/select/review/approve flow after separately approved
deployment. Workbench Manage secrets edits name-only references in the canonical
Bucket registry; the server derives exact recipe/model/image grants. No manifest
path or offline hash workflow remains. Revision conflicts and uncertain saves
require refresh and review, never automatic retries. Standalone setup success is
not approval.

Deployment caveat: align the live two-secret inventory and control-only token
instructions under separate explicit deployment and credential-transfer approval.
This local implementation does not authorize activation.
Standalone setup tests remain secret-free; Harbor's authorized benchmark agent env
covers setup and run. Host review constraints are not firewall enforcement.

### Snapshot synchronization and retry publication

Native aggregate snapshots and local cost checks share Harbor's pinned
`Job._trial_completion_lock` with its writer; transport does not fabricate a
second progress record. START publishes native trial config/lock identity and
removes that name's previous terminal result. For errored trials in retry-enabled
runs, terminal trial results are withheld until final tree publication so a
snapshot taken during native retry backoff cannot falsely mark missing work
completed on restore. Receipts and scrubbed artifacts are still saved. See
[the local storage contract](2026-09-11-local-parent-storage.md) for the
conservative failure-reporting and abrupt-termination trade-offs.

The global native `job/job.log` is deliberately excluded from Bucket uploads:
it receives trial log messages but is outside Harbor's trial-directory scrubber.
Scrubbed per-trial logs remain available, and the existing dashboard reads native
JSON observations rather than this global log. Final reconciliation removes any
previous copy of that global log in the run's job subtree.

## Operator-reviewed infrastructure replacements

After native completion and confirmed absence of live owned Jobs, an operator
can select exact errored native trial IDs and review a separate execution budget.
The original remains immutable. Normal submission, authorization, credential
binding and idempotency protections apply to the related run.

`POST /api/v1/runs/:run_id/replacements/validate` reviews the selection;
`POST /api/v1/runs/:run_id/replacements` submits it with the review fingerprint
and an idempotency key. `GET /api/v1/runs/:run_id/replacements` provides related
runs, native combined results and reported cost coverage. The run-page panel
loads these views on demand. Exceptions identify candidates, not an automatic
infrastructure classification.

Only optional `RunRecord.operator_selection` is durable. The bounded assembly
cache is disposable and never feeds execution reconciliation. Source records and
native config/lock/result evidence are rechecked; changed or missing evidence
fails closed. Parent preflight independently validates the same provenance.
No source artifacts enter the new run's upload tree.

Harbor runs the exact selected task multiplicity and aggregates the chosen
native results. Related subset runs are not independently pooled on the
leaderboard. Pending or invalid assemblies are withheld, not replaced with a
more favorable original score. Reported spend across all constituent attempts
remains visible separately from the selected cohort's native cost.

See [the replacement contract](2026-09-11-replacement-backend.md) for recursive
selection, native ownership, scalar leaderboard limits and removal of the
revision-scoped integration. Actual replacement execution requires separate
operator review and budget approval; deployment is not launch authorization.

For a recorded Workbench run whose current worker image needs renewed inference
approval, use **Review inference access for this run**. It preserves native recorded
configuration and the exact existing owned scope, then saves explicit approval
through the existing registry API without launching anything. See
[Run-recorded inference access review](run-inference-access-review.md) for the
server-only input, review fencing and policy boundaries.

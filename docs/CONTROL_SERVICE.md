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

The service is the only run control authority. Parent Jobs call Harbor and write
Harbor's normal job folder to the mounted Bucket. They also keep one immutable
cost receipt for each Harbor attempt, so retry cost survives a parent restart.
Reviewed benchmark presets select either CPU Basic or CPU Upgrade for temporary
task Jobs; they cannot select accelerator hardware.

## Run diagnostics

Runs, run detail, and trial lists refresh through existing ten-second browser polling
and the control projection. The Runs diagnostics column groups native Harbor
exceptions with links to trial evidence; missing or inconsistent evidence remains
unknown/partial. Finished execution does not imply passing or valid scoring.
Infrastructure and verifier-bootstrap classifications require upstream typed
Harbor evidence; this view does not infer them from logs or rewards and never
changes scores or retries.

Run detail also keeps each agent's stored model/route, version, and reasoning
kwargs together. These are configured values, not verified provider-effective
settings. See [Run diagnostics and configuration provenance](run-diagnostics.md)
for the source boundary, completion investigation, and proposed upstream evidence.

## Persistent resources

A hosted installation uses:

- one private Docker Space for the control service
- one private Bucket for run records and Harbor output

Do not create a resource per run. SQLite files and HF Jobs are temporary. The
three-table projection rebuilds from run records, Harbor results, attempt cost
receipts, and current Job observations.

The Space has two secrets:

- `HF_TOKEN` is a purpose-scoped control credential with access to the Bucket
  and HF Jobs.
- `HF_INFERENCE_TOKEN` is a separate inference credential for the Hugging Face
  router.

The values must differ. Keep both out of Space variables, source files, build
arguments, request bodies, Job labels, and logs.

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
| `HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS` | no | empty | comma-separated operator subjects |

Write mode fails startup unless both secrets and an image reference ending in
`@sha256:<64 lowercase hex characters>` are present.

Hugging Face supplies the OAuth client values to the Space. OAuth mode requires
`OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, and `OPENID_PROVIDER_URL`. The service
uses a 30-day browser session and `openid profile` scopes by default. Logging
out, losing authorization, or clearing browser cookies ends the session sooner.

### Sign-in diagnostics

Open the app directly and start a fresh login at `/auth/login`; do not reload
an old callback URL. A completed OAuth exchange does not itself grant operator
access. At every service startup, `apps/control-api/src/runtime.ts` constructs
an in-memory ACL from `HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS`; there is no
separate ACL file in the Bucket. The configured subjects become operators,
and the reader list is empty.

To grant operator access, append the account's stable Hugging Face user ID
(not its username or organization name) to that Space variable's comma-separated
list, preserving existing operators. Restart the Space to reload the list,
then start a fresh login. Despite its bootstrap name, the variable is read on
every startup, not only during initial installation. Keep account IDs in private
Space configuration, not repository files. `HARBOR_HF_WRITE_MODE` controls
operations, not sign-in authorization.

Callback failures emit `OAuth callback failed` with the request ID, a fixed
`oauth_stage`, and `code`. No callback query strings, request headers, cookies,
provider error messages, or token responses belong in these diagnostics.

| Stage | Check |
| --- | --- |
| `configuration` | Space-supplied OAuth configuration and initialization |
| `flow` | Start a fresh login; check cookies and whether the Space restarted |
| `token_exchange` | Callback origin, provider configuration, and a fresh authorization flow |
| `user_info` | Provider user-info availability and identity response |
| `authorization` | `access_denied` (403) means the identity is not in the ACL; `oauth_failed` means the ACL lookup failed |
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

Preset, Workbench, setup-test, and direct submissions require
`Idempotency-Key`. Direct submissions also require
`X-Harbor-HF-Cost-Ceiling-USD-Per-Trial`. The configurable page also sends the
Validate fingerprint in `X-Harbor-HF-Validation`; a changed request or admission
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
reported provider cost and removes the interrupted result before it exits. A
paused Harbor folder therefore stays resumable without losing paid-use evidence.

The parent keeps the cost that Harbor reports for each attempt. A failure before
agent execution records zero cost. A null cost after agent execution remains
null in its immutable receipt and reserves that run's per-trial ceiling for
budget control. The parent checks existing receipts before `Job.run()` and
writes each new receipt before it makes a stop decision.

When a reported trial or total observed and reserved exposure crosses its
ceiling, the parent reads Harbor's current `JobResult`. It raises the cost-stop
exception while more work can spend money or while completion is uncertain. It
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
has one labelled row and one compact square per job-lock entry (or per observed
trial when no job lock is available). The existing trials table remains available
for reported agent/model metadata, status, reward, cost, and full trial navigation.
The waffle’s
read-only progress endpoint lists native `job/lock.json` trials without deduplicating
repetitions, and observes each trial's `config.json`, `lock.json`, and `result.json`.
Trial locks supply the durable input digest, including for finalized trials;
Harbor's legacy result checksum is a different hash and is never equated with a
lock digest. Task names and lock input digests group display rows. Native
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
aggregate heartbeat establishes per-trial execution. Stale or failed artifact
refreshes make unfinished observations uncertain. The freshness window is 60
seconds. Finalized native results supply outcome, reward, and reported cost;
missing reward is never scored as zero. Missing cells are **Unknown / not observed**
unless an available prepared lock excludes that task/input group. A repeated
trial's absence cannot be inferred from its display slot or a repetition count.
Native `n_pending_trials`, `n_running_trials`, and `n_completed_trials` remain the
aggregate authority. No controller or completion behavior reads waffle state.

Parent and child HF Jobs are displayed separately with their provider-observed
queued/running/stopped/error states and snapshot time. Queued means waiting at HF,
not a named trial waiting for a particular dependency. Failed reads retain a
visible stale warning and retry action; cached incomplete cells become uncertain.
A local freshness timer also expires observations during a hung refresh. Missing or malformed artifacts do not
become invented successful or zero-reward results.

The API shares artifact snapshots across callers for 10 seconds, coalesces in-flight
reads per run, and retains at most 64 snapshots (including pending requests). At
capacity it evicts a settled snapshot or rejects new work until capacity is
available; it never evicts pending work to launch duplicate listings. The decoded
artifact cache remains bounded at 8192 entries and follows provider content
identities. Expired snapshots are re-listed so additions and removals are observed;
a failed refresh invalidates the snapshot and decoded run entries and propagates
the error, never falling back to stale success. The original artifact observation
time is retained on cache hits; provider observations are attached independently
on every response. Visible active rows poll every 15 seconds; terminal rows every
two minutes. Explicit retry still surfaces fresh read failures.

Boundary review: also inspected `src/harbor/job.py` (resume removes unfinished
folders and regenerates remaining configs/names) and `src/harbor/trial/trial.py`
(native lock precedes config, although partial API observations are supported).
Inspected Harbor `src/harbor/models/trial/config.py`,
`src/harbor/models/trial/result.py`, and `src/harbor/models/job/lock.py` at the pinned
revision `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`, and upstream history through
`1f84b4c0`. These artifacts do not supply a per-trial live-running assertion or a
cross-run repeated-trial ordinal. The intervening changes do not add one. This UI
therefore preserves unknown states rather than patching Harbor or changing the pin.


The UI requests only the open run, polls active runs every 15 seconds and terminal
runs every two minutes, and renders 25 task rows per page without splitting repeats.
Search matches task, input, trial, state, or native exception and retains whole
matching rows; totals and separate observations remain unfiltered. Navigation to
another run resets filters, focus/tooltips, and mount-local observation history.
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
command agent, and the labeled HF Sandbox adapter.

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
5. keep `HARBOR_HF_WRITE_MODE=disabled` for the first startup;
6. verify liveness, readiness, OAuth, presets, Bucket projection, Workbench
   runner state, and the source revision; and
7. set write mode to `enabled` and restart once.

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

---
title: Harbor-centered cutover specification
author: Harbor-HF maintainers
date: 2026-09-04
tags: [architecture, harbor, runs, api, cutover]
---

# Harbor-centered cutover specification

## In short

This specification replaces the current profile and worker system with one
Harbor job per run. Harbor owns task resolution, trials, retries, resume and
locks. It also owns results and trajectories. Harbor-HF owns submission and
credentials plus the Bucket. It controls HF Job lifecycle, cost stops and the
leaderboard.

The cutover keeps schema version `v1`. It does not add a compatibility reader or
migrate historical objects. The approved 2026-09-11 local-parent implementation
changes transport, not durable schemas: parent `/data` is local disk with SDK
restore and snapshot uploads to the existing Bucket. Control Space storage is
unchanged. See [Local parent storage](2026-09-11-local-parent-storage.md) for the
current contract and private native scrub ordering approval.

## Files in the Bucket

A new run has this structure:

```text
runs/run-19ecb4608a42c1e9f4610f25/
├── run.json
├── state.json
├── attempt-costs/
│   └── <attempt-id>.json
└── job/
    ├── config.json
    ├── lock.json
    ├── result.json
    └── <trial-name>/
        ├── config.json
        ├── lock.json
        ├── result.json
        └── agent/
            └── trajectory.json
```

The control service creates `run.json` once and rewrites `state.json`. The
parent worker creates immutable receipts below `attempt-costs/`. Harbor alone
authors files below `job/` on local disk; the parent copies native bytes to the
Bucket without a competing result writer. Historical objects outside `runs/`
stay unchanged and are not loaded into the new projection.

### `run.json`

A preset submission creates this immutable record:

```json
{
  "schema_version": "v1",
  "run_id": "run-19ecb4608a42c1e9f4610f25",
  "created_at": "2026-09-04T02:00:00.000Z",
  "submitted_by": "<operator-subject>",
  "role": "final",
  "harbor_revision": "dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e",
  "submission": {
    "benchmark": {
      "name": "terminal-bench-2-1",
      "preset": "one-task-1-trial"
    },
    "model": {
      "id": "openai/gpt-oss-20b",
      "provider": "together",
      "reasoning_effort": "off"
    },
    "harness": {
      "agent": "pi",
      "version": "0.84.4"
    },
    "cost_ceiling_usd": 100
  },
  "harbor_job_config": {
    "job_name": "job",
    "jobs_dir": "/data/runs/run-19ecb4608a42c1e9f4610f25",
    "n_attempts": 1,
    "n_concurrent_trials": 1,
    "datasets": [
      {
        "repo": "https://github.com/harbor-framework/terminal-bench-2-1.git@d49e28f1e4ddd13d289e85a5f312a66750951932",
        "path": "tasks",
        "task_names": ["adaptive-rejection-sampler"]
      }
    ],
    "agents": [
      {
        "import_path": "harbor_hf_agents.pi.agent:PiAgent",
        "model_name": "huggingface/openai/gpt-oss-20b:together",
        "env": {
          "HF_TOKEN": "${HF_INFERENCE_TOKEN}"
        },
        "kwargs": {
          "version": "0.84.4",
          "thinking": "off"
        }
      }
    ],
    "environment": {
      "import_path": "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment",
      "kwargs": {
        "flavor": "cpu-basic",
        "job_timeout": "none",
        "run_label": "run-19ecb4608a42c1e9f4610f25"
      }
    }
  }
}
```

All fields shown above are required in a stored record. The submission API can
omit `role`; the service then stores `final`. Unknown fields are rejected.
`run_id` is `run-` plus the first 24 hexadecimal characters of the SHA-256
digest of the idempotency key. A repeated key returns the existing record. A
repeated key with different content is a conflict.

`submitted_by` records the authenticated subject. `role` is `final` or
`diagnostic`. `harbor_revision` identifies the exact Harbor source. A separate
Harbor version is not stored because the revision is the stronger identity.

`submission` records user intent. `harbor_job_config` records the exact,
secret-free configuration that the parent passes to Harbor. Credential values
must not occur in either block. The environment template resolves the inference
credential only in the parent process.

The service validates the Harbor configuration against a JSON Schema generated
from `JobConfig.model_json_schema()` at the pinned Harbor revision. The parent
also validates it with Harbor's Pydantic model before it creates a `Job`.

### `state.json`

The mutable control record starts as:

```json
{
  "schema_version": "v1",
  "run_id": "run-19ecb4608a42c1e9f4610f25",
  "revision": 0,
  "updated_at": "2026-09-04T02:00:00.000Z",
  "desired_state": "run",
  "actor": "<operator-subject>",
  "parent_jobs": []
}
```

When the reconciler starts or adopts a parent Job, it appends this item:

```json
{
  "id": "<job-id>",
  "started_at": "2026-09-04T02:00:05.000Z"
}
```

`desired_state` is `run`, `paused`, or `cancelled`. The service increments
`revision` for each rewrite. Parent status, end time, and cost are observations.
They stay in the three-table SQLite cache and do not become competing durable
state.

A pause cancels the active parent and its labeled children. Resume changes
`desired_state` to `run`; the next parent restores the saved `job/` folder into
fresh local disk and lets native `Job.create()` decide what to resume.
Cancellation is terminal.

### Attempt cost receipts

The parent writes one immutable `attempt-costs/<attempt-id>.json` receipt after
each Harbor trial attempt:

```json
{
  "schema_version": "v1",
  "attempt_id": "6d0c5ea0-e39c-4b54-8f97-3db258295b22",
  "trial_name": "adaptive-rejection-sampler__1",
  "cost_usd": 0.08
}
```

The attempt ID is Harbor's trial result ID. A failure before agent execution
records zero cost. The cost remains `null` when Harbor cannot report cost. A
null receipt contributes zero to the ceiling calculation and does not stop other
campaign work. This policy does not change the receipt or claim that the
provider observed zero cost. The parent loads all receipts before resume and
backfills a receipt for each current Harbor trial result. Thus, Harbor can
remove a failed retry folder without removing its cost evidence.

The projection validates these receipts and combines them with current Harbor
trial results by attempt ID. This keeps retry costs after a parent restart
without adding a fourth SQLite table or a second result format.

## Presets

Reviewed source files replace all five profile kinds.

```text
presets/
├── benchmarks/
│   ├── terminal-bench-2-1-one-task-1-trial.json
│   ├── terminal-bench-2-1-all-tasks-1-trial.json
│   └── terminal-bench-2-1-all-tasks-5-trials.json
└── agents/
    ├── pi-0.84.4.json
    ├── codex-0.118.0.json
    └── ...
```

A benchmark preset contains `schema_version`, `benchmark`, `preset`,
`leaderboard_eligible` and `job`. The `job` object is a reviewed Harbor
`JobConfig` fragment. It contains `datasets`, `n_attempts`,
`n_concurrent_trials` and the native `environment` object. The environment type
is `hf-sandbox`. Its native `kwargs.flavor` value is limited to `cpu-basic` or
`cpu-upgrade`, so a preset cannot select paid accelerator hardware. The
environment also keeps the reviewed native `kwargs.job_timeout` value. This
value is temporarily `none` because
[huggingface/sandbox-server#21](https://github.com/huggingface/sandbox-server/pull/21)
is not yet deployed. Remove this stopgap only after the correction is merged,
the fixed server is deployed, and a foreground command runs for more than 30
minutes in a canary. Follow the
[stopgap removal checklist](2026-09-09-sandbox-idle-timeout-stopgap-removal.md).
The job can contain timeout multipliers, `retry` and
`artifacts`. It cannot set paths, agents, credentials, user agents, custom
environments or source jobs.

Each dataset keeps Harbor's native `repo` and `path` fields. A reviewed private
Hugging Face Dataset uses this source form:

```text
repo: https://huggingface.co/datasets/example-org/<dataset>.git@<40-character-commit>
path: <task-tree-path>
```

Admission requires HTTPS, the exact `huggingface.co` host, the Dataset path
form, no embedded credentials, port, query, or fragment, and an exact immutable
40-character Git commit. Current public GitHub source admission remains
unchanged. The service passes `repo` and `path` to Harbor unchanged. It does not
add a source schema, downloader, resolver, scheduler, result format, or API.

An agent preset contains `schema_version`, `agent`, `version`, `harbor_agent`,
`reasoning_option` and `reasoning_values`. `harbor_agent` selects `name` or
`import_path`. It can also set fixed nonsecret `kwargs` and timeout multipliers.
`reasoning_option` is a Harbor agent option name or `null`. If it is `null`,
`reasoning_values` contains only `default` and the service does not add a
reasoning option.

The service loads and validates every preset at startup. Duplicate benchmark
and preset pairs or duplicate agent and version pairs stop startup. A request
cannot override a preset fragment.

The pinned Harbor revision already contains ATIF support for Hermes and
OpenClaw. Harbor-HF keeps custom ATIF agents only for pi and dsh. This avoids a
duplicate converter that the current Harbor source now owns.

## Direct Harbor configuration

`POST /api/v1/runs/config` accepts an operator-supplied Harbor `JobConfig`. The
CLI command `harbor-hf submit --config job.yaml` uses this route. The CLI also
requires `--cost-ceiling-usd` for the complete campaign.

The service validates the file with a closed form of the pinned Harbor schema.
It rejects unknown fields, multiple agents and any source job, user agent, local
task path, local dataset path, parent-local instruction or trajectory path,
caller-supplied skill or agent environment, credential literal, credential in a
URL, environment other than `hf-sandbox`, or jobs path. It keeps open extension
maps such as agent `kwargs` because Harbor defines them as open.
It sets `job_name`, `jobs_dir`, the labeled environment import path, and the
router credential template. Other accepted fields stay unchanged. Direct runs
are stored with role `diagnostic` and do not enter the leaderboard.

Private Hugging Face Dataset admission uses the same strict source form as a
reviewed preset. ACP and other executable source admission stays separate and
unchanged. Private Dataset access does not authorize private agent source
installation.

## Parent Job

The control service starts one CPU parent Job with:

- an immutable parent image reference
- local disk at `/data`, with no Bucket volume mount
- runtime `HARBOR_HF_LOCAL_ROOT` and `HARBOR_HF_BUCKET_ID` instead of
  `HARBOR_HF_MOUNT_ROOT`; no new durable schema fields
- the run id as an environment value and Job label
- the control and inference credentials as ephemeral Job secrets
- one attempt and no public port

The parent restores `runs/<run-id>/` via `HfApi.sync_bucket()` into a fresh local
run directory, fetches current `state.json` via the Bucket API, reads `run.json`,
and validates `harbor_job_config`. Native `jobs_dir` remains
`/data/runs/<run-id>` and `job_name` remains `job`; a configured local root must
match the immutable native path. It then calls `Job.create()` and `Job.run()`
from Harbor, which own resume from the restored config, locks, and results. It
does not implement a task loop, retry loop, resume rule, result writer, or lock
writer.

The pinned Harbor revision
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` already resolves Hugging Face
Dataset Git URLs through `DatasetConfig`, `resolve_repo_source`,
`GitRepoRegistryClient`, `RegistryClientFactory`, and `TaskClient`. The checked
files are `src/harbor/models/job/config.py`,
`src/harbor/registry/client/git_repo.py`,
`src/harbor/registry/client/factory.py`, and `src/harbor/tasks/client.py`.
Harbor owns checkout, task discovery, task loading, and execution. Harbor-HF
owns only admission and credential delivery.

Control-side launch inspection and the trusted parent configure a small Git
credential helper that reads the existing `HF_TOKEN`. It follows Git's
credential protocol, returns credentials only for the exact `huggingface.co`
host, and does not persist them. The token never enters the source URL, process
arguments, a Git credential file, run configuration, Bucket records,
projections, browser responses, or logs. The control token does not enter trial
agent environments. Delivery of the separate inference credential remains
unchanged.

`LabeledHFSandboxEnvironment` subclasses Harbor's `HFSandboxEnvironment`. It
adds ownership labels and the configured namespace to the same
`HfApi.run_job` call that creates the child. This prevents an unowned or
out-of-scope child if the parent stops during Sandbox startup. The small,
context-scoped integration exists because the pinned Hub Sandbox API has no
labels argument. It can be removed when that API exposes child labels.

The same adapter resolves the fixed `${HF_INFERENCE_TOKEN}` template only when
it assembles an agent command environment. The value comes from the parent's
ephemeral secret and does not replace the template in Harbor's persisted job
configuration. Before Pi starts, its adapter combines the base model behavior
from Pi's public Hugging Face catalog with the selected provider's live status,
tool support, context limit and prices from the public Hugging Face router. It
writes that provider-pinned entry to Pi's temporary configuration. The adapter
fails before inference if this metadata is missing or unsafe. Pi therefore uses
the requested provider and records its current prices so Harbor receives a
non-null inference cost. Agents that need an OpenAI-compatible endpoint use the
same inference secret through the fixed router URL.

The parent registers `on_trial_started` and `on_trial_ended` callbacks. Each
refreshes `state.json` from the Bucket API before checking control intent. START
stops paused/cancelled work or uploads native config/lock/job result metadata,
checking write access before inference. END reads the completed
trial's Harbor cost and writes its immutable attempt receipt before Harbor can
remove a failed retry folder. A failure before agent execution records zero
cost. Any null cost remains null in that receipt and contributes zero to the
ceiling calculation. It does not stop other campaign work. The same cost check
runs after the parent loads existing receipts and after the callback writes a
new receipt.

The cost guard compares the sum of all attempt receipts with the campaign
ceiling. It never divides that ceiling into per-trial limits. Existing immutable
runs with `cost_ceiling_usd_per_trial` keep their direct and aggregate checks and
use the same null-as-zero rule. When the known campaign total crosses its
ceiling, the parent reads Harbor's current `JobResult`. It raises
`CostCeilingExceeded` if more work can spend money or if completion cannot be
proved. It suppresses the exception only when the
native total matches the configured job size, completed equals total, running
and pending are zero, and `retry.max_retries` is zero. The same `Job.run()` call
then performs Harbor's final aggregation and writes `finished_at`.

A missing, malformed, inconsistent, incomplete, running, pending,
mismatched-total, or retry-enabled result fails closed. Harbor-HF does not count
trial folders, read private queue fields, reproduce Harbor retry rules, or store
a second completion value. The receipt is written locally before this decision;
the END callback uploads the trial subtree, native job metadata, then receipts
in its `finally`, including for handled cost/control exceptions. A successful
acknowledged Bucket copy is the remote durability boundary.

If `state.json` shows a requested pause or cancellation, the callback preserves
any non-null cost and raises a controlled-stop exception. After Harbor unwinds,
the parent removes the interrupted trial folder and the incomplete job result.
A stop before inference creates no cost receipt. On resume, Harbor therefore
sees the controlled interruption as a missing trial and starts it again while
keeping acknowledged cost receipts from earlier provider use. A hard kill can
prevent cleanup or copies and lose unsaved outputs and cost evidence.

This is a post-trial stop. It cannot prevent one trial from crossing its limit.
With concurrency greater than one, already-running trials can also finish or be
cancelled. The API and UI state this limitation.

## Reconciliation and status

The reconciler lists current Jobs, then handles each new run in creation order.
It does not launch more than `HARBOR_HF_MAX_ACTIVE_JOBS` live parent Jobs.
Benchmark presets fix trial concurrency.

For each run it applies these rules in order:

1. If the desired state is paused or cancelled and a parent is live, cancel
   every live parent and defer child cleanup to the next reconciliation.
2. If the desired state is paused or cancelled and no parent is live, cancel
   every live child with the run label.
3. If a reported attempt or total observed and reserved cost exposure crossed a
   limit, keep an already-live parent only when Harbor's native result shows
   completed equal to total, zero running and pending trials, zero retries, and
   no `finished_at` yet. This gives that parent time to finish the same Harbor
   job. In all other cases, stop parents before child cleanup. Never start a
   replacement parent for a cost-stopped run.
4. If Harbor's job result is finished, do not start a parent.
5. If one labeled parent is live, adopt it if needed and wait.
6. Cancel orphaned labeled child Jobs.
7. If capacity is available and the fixed restart delay has passed, start one
   parent and append it to `state.json`.

Stopping parents before children reduces the interval in which a child shutdown
can become an error while its parent still observes it. If Harbor still returns
an interrupted trial, the parent's controlled-stop callback removes that
terminal view after it preserves any provider cost. The later orphan pass stops
remaining children. This keeps the same Harbor folder resumable after a pause.

The run status is computed, not stored:

| Status | Rule |
| --- | --- |
| `cancelled` | Desired state is cancelled. |
| `paused` | Desired state is paused. |
| `cost_stopped` | An attempt or aggregate exposure crossed a cost limit, including when Harbor has written `finished_at`. |
| `finished` | Harbor `result.json` has `finished_at` and no cost limit was crossed. |
| `running` | A labeled parent Job is live. |
| `queued` | No rule above applies. |

A `cost_stopped` run can have `finished_at`. This means Harbor completed its
execution and does not mean that the run complied with the cost policy.

A parent that stops before Harbor finishes is not a new logical attempt. A later
parent restores the saved Harbor job folder into fresh local disk and uses
Harbor's resume behavior, not a local scheduler.

### Artifact ordering and failure boundary

Per-trial and final subtree uploads copy current bytes without mtime/size-based
skipping and publish the subtree root `result.json` after its other files and
deletions. Lifecycle metadata is a separate native snapshot, not a whole-run
atomic transaction. The final copy writes receipts before the settled job tree
and publishes aggregate `job/result.json` last. It runs only after success or a
handled expected cost/control stop with no scrub failure veto. Unexpected
failures propagate without a final whole-tree upload and rely on the last
acknowledged per-trial copies. Upload failures are explicit. Forced cancellation
or hard kill cannot guarantee a final copy; local disk must fit the working data.

The approved private `scrub_before_upload` adapter calls the actual trial
`Trial._scrub_jobs_dir()` before END; native `finally` remains a backstop. Harbor
pin `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` and inspected latest
`e1be9bd39c368f88a27fee4cbd26655e9994ee5a` still emit END before scrub. Remove
the workaround at the first reviewed supported post-scrub native hook/pin or
native pre-END scrub; no future SHA is invented. The adapter does not copy the
sanitizer or reconstruct trials. Native best-effort UTF-8 scrubbing can skip
files and does not guarantee arbitrary secret safety, sanitized in-memory
results, aggregation, or job-level logs. See the
[implementation note](2026-09-11-local-parent-storage.md) for checked source and
the exact approval/removal boundary.

## SQLite projection

SQLite is a disposable cache. Startup and periodic sync rebuild these tables
from `runs/` plus current HF Job observations:

- `runs`: immutable record and mutable state plus computed status and job summary
- `trials`: one row per Harbor trial result
- `parent_jobs`: one row per labeled parent Job observation

Dashboard snapshots require native job config/lock/result, per-trial results,
and cost receipts alongside HF Job observations. This is snapshot observability,
not streaming live logs, fabricated progress, or a full POSIX Bucket promise.
Existing schema values, API/UI projections, and cost semantics are unchanged;
no new durable field or second scheduler is introduced.

No API write depends on data that exists only in SQLite. Deleting the database
and restarting the Space must produce the same control state.

## API

The cutover exposes these routes:

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health/live` | Public | Process health. |
| `GET` | `/health/ready` | Public | Store and projection readiness. |
| `GET` | `/api/v1/session` | Signed in | Current actor. |
| `GET` | `/api/v1/system` | Signed in | Source and Harbor facts plus storage and capacity facts. |
| `GET` | `/api/v1/presets` | Signed in | Valid benchmark and agent presets. |
| `POST` | `/api/v1/runs` | Operator | Submit a preset run. |
| `POST` | `/api/v1/runs/config` | Operator | Submit a direct Harbor config. |
| `GET` | `/api/v1/runs` | Signed in | List runs. |
| `GET` | `/api/v1/runs/:run_id` | Signed in | Run detail and job summary. |
| `POST` | `/api/v1/runs/:run_id/pause` | Operator | Pause a run. |
| `POST` | `/api/v1/runs/:run_id/resume` | Operator | Resume a run. |
| `POST` | `/api/v1/runs/:run_id/cancel` | Operator | Cancel a run. |
| `GET` | `/api/v1/runs/:run_id/trials` | Signed in | List trial summaries. |
| `GET` | `/api/v1/runs/:run_id/trials/:trial_name` | Signed in | Read one trial result. |
| `GET` | `/api/v1/jobs` | Signed in | List parent Job observations. |
| `GET` | `/api/v1/leaderboard` | Public | List eligible finished results. |

OAuth and bearer access remain. CSRF checks and the existing installer also
remain. All other control API routes are removed in place.

## Leaderboard

A run is eligible only when all these conditions are true:

- its stored role is `final`
- its benchmark preset has `leaderboard_eligible: true`
- Harbor finished the job
- the job has at least one scored trial

Rows group by benchmark, preset, agent and agent version. They also group by
model id and provider plus reasoning effort. The score is the mean of all
available trial rewards. Each row shows the number of attempts and trials. No
Parquet file or result catalog is created. Publication receipts and supersession
records are also removed.

## Validation and errors

The service rejects unknown fields, invalid ids and non-finite or non-positive
cost ceilings. It also rejects missing presets, unsupported reasoning values
and credential literals. Unsafe direct JobConfig fields and immutable
idempotency conflicts are errors. The response is one JSON error object with a
stable code and a plain message.

A private Dataset source fails before model inference when `HF_TOKEN` is
missing, repository access fails, the exact commit is missing, source admission
fails, or Harbor cannot resolve the source. There is no fallback to another
repository, revision, source kind, or local copy.

Local validation runs:

```bash
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run check:generated
npm run test:e2e
```

The test suite covers submission, idempotency, status and reconciliation. It
also covers capacity, pause, resume, cancel, orphan cleanup, cost stops and
projection rebuild. Other tests cover leaderboard filtering and API
authorization plus the parent callback, child labeling and the thin CLI. Private
Dataset tests cover accepted and rejected URLs, immutable commits, unchanged
public GitHub behavior, the credential protocol and host restriction, missing
credentials, non-disclosure, control and parent helper configuration, trial
credential isolation, unchanged inference credential delivery, and unchanged
native `repo` and `path` values.

The local Git credential bridge is temporary. Replace it when a pinned Harbor
release provides an equivalent documented private Hugging Face Git credential
mechanism. That simplification removes the helper, its configuration, and its
bridge-specific tests while keeping Harbor's native dataset contract.

## Historical verified preconditions

The precondition run used Harbor
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` and Terminal-Bench 2.1
`d49e28f1e4ddd13d289e85a5f312a66750951932`.

Two `install_only` trials completed through `hf-sandbox`. Environment startup
took 10.8 and 13.0 seconds. Pi 0.84.2 installation took 15.5 and 9.8 seconds.
A separate parent Job mounted the Bucket and wrote and read a file. It started a
child Sandbox Job and saved its result on the mount. This was evidence for the
earlier mounted-parent topology, not validation of the current local-disk SDK
implementation. The approved local change does not claim a new remote canary.

The tests also confirmed that Harbor updates job-level `result.json` during a
run and resumes completed trials. They found that `hf-sandbox` does not copy a
parent run label and that the child initiator does not identify the parent.
This is why the labeled environment subclass is required.

## Removed code

The cutover removes the old Python control modules and tests, old schemas and
profiles, preparation and trial workers, proot runtime, inference bridge,
continuation and repair records, launch-policy enforcement, budget holds,
Parquet publication and result catalogs plus receipts and supersession logic. It also
retires `docs/run-spec.md` and rewrites the architecture and control service
documents for this contract.

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

## Infrastructure replacement extension

The approved operator-replacement extension adds only optional immutable
`RunRecord.operator_selection` (`original_run_id`, exact native `trial_ids`, and
`source_fingerprint`). It records an operator decision, not a renamed native
regrade relationship or mirrored progress state. Existing run lifecycle, native
output ownership, Bucket layout and the three-table projection remain unchanged.

A separate normal run executes the selected native task multiplicity. A
revision-scoped provenance/coverage bridge invokes Harbor's public planning and
aggregation APIs; source evidence is never rewritten. Assembly is a disposable
presentation and is never a completion input to the reconciler. Overlapping
selections and changed review evidence fail closed; exact idempotent replay
retains the normal immutable-write recovery semantics.

Related run selection must precede leaderboard contribution so original and
replacement evidence cannot both count. Preserve failed replacement outcomes
and all incurred attempt costs. No replacement launch is implicit in a project
release. Detailed endpoints, validation and limitations are specified in the
[replacement contract](2026-09-11-replacement-backend.md).

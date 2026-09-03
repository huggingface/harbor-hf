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
migrate historical objects.

## Files in the Bucket

A new run has this structure:

```text
runs/run-19ecb4608a42c1e9f4610f25/
├── run.json
├── state.json
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

The control service creates `run.json` once and rewrites `state.json`. Harbor
alone writes below `job/`. Historical objects outside `runs/` stay unchanged
and are not loaded into the new projection.

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
      "version": "0.84.2"
    },
    "cost_ceiling_usd_per_trial": 0.25
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
        "model_name": "openai/openai/gpt-oss-20b:together",
        "env": {
          "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
          "OPENAI_API_KEY": "${HF_INFERENCE_TOKEN}"
        },
        "kwargs": {
          "version": "0.84.2",
          "thinking": "off"
        }
      }
    ],
    "environment": {
      "import_path": "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment",
      "kwargs": {
        "flavor": "cpu-basic",
        "job_timeout": "30m",
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
`desired_state` to `run`; the next parent uses Harbor's existing `job/` folder
and completes only missing trials. Cancellation is terminal.

## Presets

Reviewed source files replace all five profile kinds.

```text
presets/
├── benchmarks/
│   ├── terminal-bench-2-1-one-task-1-trial.json
│   ├── terminal-bench-2-1-all-tasks-1-trial.json
│   └── terminal-bench-2-1-all-tasks-5-trials.json
└── agents/
    ├── pi-0.84.2.json
    ├── codex-0.118.0.json
    └── ...
```

A benchmark preset contains `schema_version`, `benchmark`, `preset`,
`leaderboard_eligible` and `job`. `job` can contain only `datasets`,
`n_attempts`, `n_concurrent_trials`, timeout multipliers, `retry` and
`artifacts`. It cannot set paths, agents, credentials, user agents, custom
environments or source jobs.

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
requires `--cost-ceiling-usd-per-trial`.

The service validates the file with the pinned Harbor schema. It rejects
multiple agents and any source job, user agent, local task path, local dataset
path, parent-local instruction or trajectory path, caller-supplied skill or
agent environment, credential literal, environment other than `hf-sandbox`, or
jobs path.
It sets `job_name`, `jobs_dir`, the labeled environment import path, and the
router credential template. Other accepted fields stay unchanged. Direct runs
are stored with role `diagnostic` and do not enter the leaderboard.

## Parent Job

The control service starts one CPU parent Job with:

- an immutable parent image reference
- one writable mount of the canonical Bucket at `/data`
- the run id as an environment value and Job label
- the control and inference credentials as ephemeral Job secrets
- one attempt and no public port

The parent reads `run.json` and validates `harbor_job_config`. It then calls
`Job.create()` and `Job.run()` from Harbor. It does not implement a task loop,
retry loop, resume rule, result writer, or lock writer.

`LabeledHFSandboxEnvironment` subclasses Harbor's `HFSandboxEnvironment`. It
adds ownership labels and the configured namespace to the same
`HfApi.run_job` call that creates the child. This prevents an unowned or
out-of-scope child if the parent stops during Sandbox startup. The small,
context-scoped integration exists because the pinned Hub Sandbox API has no
labels argument. It can be removed when that API exposes child labels.

The same adapter resolves the fixed `${HF_INFERENCE_TOKEN}` template only when
it assembles an agent command environment. The value comes from the parent's
ephemeral secret and does not replace the template in Harbor's persisted job
configuration.

The parent adds one `on_trial_ended` callback. The callback reads the completed
trial's Harbor cost. If that trial exceeds the per-trial ceiling, or the sum of
completed trial costs exceeds the ceiling times the planned trial count, the
callback stops the Harbor task group. Harbor has already written the trial and
job result before this callback runs.

This is a post-trial stop. It cannot prevent one trial from crossing its limit.
With concurrency greater than one, already-running trials can also finish or be
cancelled. The API and UI state this limitation.

## Reconciliation and status

The reconciler lists current Jobs, then handles each new run in creation order.
It does not launch more than `HARBOR_HF_MAX_ACTIVE_JOBS` live parent Jobs.
Benchmark presets fix trial concurrency.

For each run it applies these rules in order:

1. If the desired state is paused or cancelled, cancel every live Job with the
   run label.
2. If a completed trial crossed a cost limit, cancel labeled Jobs and do not
   start a parent.
3. If Harbor's job result is finished, do not start a parent.
4. If one labeled parent is live, adopt it if needed and wait.
5. Cancel orphaned labeled child Jobs.
6. If capacity is available and the fixed restart delay has passed, start one
   parent and append it to `state.json`.

The run status is computed, not stored:

| Status | Rule |
| --- | --- |
| `cancelled` | Desired state is cancelled. |
| `paused` | Desired state is paused. |
| `finished` | Harbor `result.json` has `finished_at`. |
| `cost_stopped` | A completed trial crossed a cost limit. |
| `running` | A labeled parent Job is live. |
| `queued` | No rule above applies. |

A parent that stops before Harbor finishes is not a new logical attempt. A later
parent opens the same Harbor job folder and uses Harbor's resume behavior.

## SQLite projection

SQLite is a disposable cache. Startup and periodic sync rebuild these tables
from `runs/` plus current HF Job observations:

- `runs`: immutable record and mutable state plus computed status and job summary
- `trials`: one row per Harbor trial result
- `parent_jobs`: one row per labeled parent Job observation

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
authorization plus the parent callback, child labeling and the thin CLI.

## Verified preconditions

The precondition run used Harbor
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` and Terminal-Bench 2.1
`d49e28f1e4ddd13d289e85a5f312a66750951932`.

Two `install_only` trials completed through `hf-sandbox`. Environment startup
took 10.8 and 13.0 seconds. Pi 0.84.2 installation took 15.5 and 9.8 seconds.
A separate parent Job mounted the Bucket and wrote and read a file. It started a
child Sandbox Job and saved its result on the mount.

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

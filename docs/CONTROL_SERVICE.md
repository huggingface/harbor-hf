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
uses a 12-hour session and `openid profile` scopes by default.

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
- `GET /api/v1/workbench/setup-tests`
- `GET /api/v1/workbench/setup-tests/{setup_test_id}`
- `GET /api/v1/workbench/setup-tests/{setup_test_id}/logs`
- `GET /api/v1/workbench/setup-tests/{setup_test_id}/files/{file_id}`
- `GET /api/v1/runs`
- `GET /api/v1/runs/{run_id}`
- `GET /api/v1/runs/{run_id}/trials`
- `GET /api/v1/runs/{run_id}/trials/{trial_name}`
- `GET /api/v1/jobs`

Operator write routes are:

- `POST /api/v1/workbench/preview`
- `POST /api/v1/workbench/setup-tests`
- `POST /api/v1/workbench/setup-tests/{setup_test_id}/cancel`
- `POST /api/v1/runs`
- `POST /api/v1/runs/config`
- `POST /api/v1/runs/{run_id}/pause`
- `POST /api/v1/runs/{run_id}/resume`
- `POST /api/v1/runs/{run_id}/cancel`

Preset, Workbench, setup-test, and direct submissions require
`Idempotency-Key`. Direct submissions also require
`X-Harbor-HF-Cost-Ceiling-USD-Per-Trial`. Workbench preview remains available
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

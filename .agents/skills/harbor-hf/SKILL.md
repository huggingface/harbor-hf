---
name: harbor-hf
description: "Submit, monitor, pause, resume, cancel, and inspect Harbor benchmark runs through the hosted Harbor-HF control service and Hugging Face Jobs."
---

# Harbor-HF operations

Use this skill for Harbor benchmark runs on Hugging Face infrastructure.

Harbor-HF has two persistent resources:

- one private control Space
- one private Bucket for run records and Harbor output

Do not create a run-specific repository, Space, Bucket, Dataset, endpoint, or
coordination store. Use the existing control service and Bucket.

## Read the current contract

Before an operation, read these files from the Harbor-HF repository:

- `docs/2026-09-04-simplification-implementation-spec.md`
- `docs/CONTROL_SERVICE.md`
- `docs/architecture.md`

Use the `paid-compute-launch` skill before a paid Job launch, retry, or resume.
Use the Hugging Face CLI and Spaces skills for Hub and Space operations.

## Keep credentials separate

The control Space has two secrets:

- `HF_TOKEN` controls the Bucket and HF Jobs.
- `HF_INFERENCE_TOKEN` is for model inference through the Hugging Face router.

Do not print either value. Do not put a credential literal in a run request,
Bucket object, Job label, log, or result. The control service gives both secrets
to the reviewed parent Job as ephemeral Job secrets. The parent uses the control
token to start and label child Sandbox Jobs. The benchmark agent receives only
the inference token through the fixed `${HF_INFERENCE_TOKEN}` template. Pi uses
its built-in Hugging Face provider so model prices remain available for Harbor
cost accounting.

Do not copy a token to another store. Use a configured token in place.

## Submit a run

Prefer a reviewed preset in the web console or `POST /api/v1/runs`. A preset
submission selects:

- one benchmark preset
- one model ID and provider
- one agent preset and reasoning value
- one positive maximum cost in USD per trial
- a `final` or `diagnostic` role

Use a unique `Idempotency-Key`. A repeated key with the same request adopts the
existing run. A repeated key with different content is an error.

Use a direct Harbor `JobConfig` only when a preset cannot express the test:

```bash
uv run harbor-hf submit \
  --config job.yaml \
  --cost-ceiling-usd-per-trial 0.25
```

The service replaces caller-controlled paths, environment, and router
credentials. It rejects unknown fields, multiple agents, source jobs, local
paths, caller-supplied agent environments or skills, custom environments,
credential literals, and credentials in URLs. Direct runs are diagnostic and
cannot enter the leaderboard.

## Inspect and control runs

Set these environment variables without printing their values:

```text
HARBOR_HF_CONTROL_URL
HARBOR_HF_CONTROL_BEARER_TOKEN
```

Use the thin client:

```bash
uv run harbor-hf run list
uv run harbor-hf run status <run-id>
uv run harbor-hf jobs
uv run harbor-hf presets
uv run harbor-hf run pause <run-id>
uv run harbor-hf run resume <run-id>
uv run harbor-hf run cancel <run-id> --yes
```

A pause cancels the active parent and labeled child Jobs. Resume starts a new
parent against the same Harbor `job/` folder. Harbor skips completed trials.
Cancellation is permanent.

The Bucket is the durable source of truth. SQLite is a disposable three-table
projection. HF Job state is an observation, not the run record.

## Cost and completion rules

The cost ceiling is checked after each trial because Harbor writes the result
before it calls the end hook. The parent writes one immutable cost receipt for
each Harbor attempt before Harbor can remove a failed retry folder. It reloads
these receipts after restart. A missing cost stops the run.

One trial can cross its limit. With concurrent trials, work that is already
active can also finish before cancellation.

Treat a run as complete only when:

- Harbor wrote `job/result.json` with a finished status;
- no labeled parent or child Job is active;
- each expected trial has a durable Harbor result;
- observed trial cost is within the approved limit; and
- the projection rebuild gives the same run state.

Only completed `final` runs from a leaderboard-eligible preset, with at least
one score, enter the public leaderboard.

## Stop conditions

Stop automatic work and report evidence for:

- credential exposure or token reuse;
- a Harbor, benchmark, image, or backend revision mismatch;
- a deterministic shared parent or child defect;
- duplicate logical execution;
- cost outside the approved limit;
- an immutable run-record conflict;
- a Bucket integrity or Harbor resume failure; or
- a labeled Job that the reconciler cannot stop.

Do not bypass a stop by creating another resource, copying a credential, or
using an unreviewed runtime.

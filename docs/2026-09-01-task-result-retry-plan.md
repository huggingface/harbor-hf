---
title: Keep finished tasks and retry failed Jobs
author: Harbor-HF maintainers
date: 2026-09-01
tags: [control, recovery, retries, workers]
---

# Keep finished tasks and retry failed Jobs

## In short

Harbor-HF should save each task when that task finishes. If a physical Job
fails before it produces a valid task result, another Job should run only that
task again from the beginning.

Completed tasks stay complete. Infrastructure retries have no fixed attempt
count, but every new Job must still pass the run's cost, authorization and
resource checks. This design does not save agent state after each model request
or tool action.

**Status.** Implemented. This document records the corrected design and
replaces the earlier request-level checkpoint plan. The remote rollout check
still runs after the reviewed worker and control source are deployed.

The [control service specification](CONTROL_SERVICE.md#task-result-persistence-and-retry)
defines task selection and retry. [Architecture](architecture.md#task-result-persistence)
defines logical trials and physical executions. The [Harbor compatibility
contract](harbor-integration-contract.md#execution-input) defines how each Job
runs one prepared task.

## Problem

A benchmark run can contain many independent tasks. Some tasks may finish while
one physical Job fails because of infrastructure, worker code, provider
transport or process loss. Restarting the full run wastes finished work.
Preventing all retries after a small fixed number of failed Jobs can also strand
a task even when its benchmark work never produced a valid result.

The control service already has durable task receipts. The missing behavior is
to keep every valid finished task and continue scheduling only unresolved task
IDs without an arbitrary infrastructure retry counter.

## Goal

A run finishes when every locked task has one valid selected receipt. Each
selected receipt stays immutable and is never rerun. A task whose latest
execution is a replacement-eligible infrastructure failure stays unresolved
and can receive another physical Job. A non-infrastructure terminal outcome is
not retried automatically.

The retry starts from the task's original prepared input. It does not continue a
conversation, restore a workspace or resume a provider stream. The retry remains
part of the same logical benchmark trial and does not consume another benchmark
attempt.

## Finished task contract

A worker reports a finished task through the existing content-addressed evidence
path. The durable result includes:

- the task result and receipt
- verifier output and rewards
- logs and trajectory data
- token use and provider cost
- elapsed time and outcome
- exact benchmark, task, model, harness and worker provenance
- the physical Job and launch action

The control service reads the uploaded objects back, verifies their digests and
applies the locked evidence policy. A receipt becomes selected only after those
checks pass. Once selected, the task is complete. Pause, retry, worker repair and
service restart must preserve that selection.

A valid result can contain a zero verifier reward. A zero score is benchmark
output, so it remains a finished task when the receipt and required evidence are
valid. A missing or invalid result caused by a replacement-eligible
infrastructure failure leaves the task unresolved. A completed worker-reported
provider, agent, verifier or benchmark outcome that fails selection is terminal
and is not an infrastructure retry.

## Infrastructure retry contract

A physical Job that ends without a valid selected task receipt remains part of
the immutable run history. The reconciler waits for terminal observation and
cleanup, then creates a new action for the same prepared task. The new Job starts
the task from the beginning.

Infrastructure retries have no policy attempt-count limit. The reconciler keeps
retrying an unresolved task while all of these conditions hold:

- the run remains active
- the operator has not cancelled or paused it
- the next Job passes admission
- the run ceiling has enough remaining headroom
- no repeated deterministic defect requires a fleet pause

Each retry uses a new physical Job and launch action. It keeps the same logical
trial, prepared task lock and benchmark attempt identity. Every failed Job and
its observed cost remain visible. The finite action-key schema remains a safety
boundary. If all valid action generations for one task are used, the run pauses
instead of exhausting the benchmark task or stranding a cost reservation.

An infrastructure retry must not reset the run budget or erase earlier spend.
Admission counts observed cost and active unsettled exposure before it permits
the next Job. A reservation remains temporary exposure until it is reconciled.

## No request-level checkpointing

The worker does not save agent state after every model response or tool action.
It does not upload partial conversations, workspace snapshots, pending tool
calls, process memory or container state for later continuation.

This keeps the retry boundary simple. A physical Job either produces a complete
valid task result or leaves the task unresolved. A replacement Job starts that
one task again. The system never claims that partial agent work is resumable.

## Pause and restart

A pause request prevents new Job admission. Jobs already running may reach their
normal task-result boundary. Results that finish during the pause are verified
and selected as usual.

When the run restarts, projection replay derives the unresolved task IDs from
immutable receipts. The reconciler creates Jobs only for those tasks. Repeated
restart requests adopt the same action and cannot create duplicate Jobs.

## Worker repair

A reviewed worker repair can be used for the next execution of an unresolved
task. It does not alter valid completed receipts. A normal `run.resume` action
is not a worker repair. A historical run can continue only through its
immutable continuation-repair attachment, which changes only the reviewed
worker image and revision. A run without a compatible repair attachment stays
paused instead of retrying the unchanged broken worker. The control record
keeps:

- every physical Job
- every worker generation
- every repair generation
- each execution outcome
- token use, cost and elapsed time
- the final selected receipt

When one Job proves a deterministic shared defect, pause the affected fleet
before retrying sibling tasks with the same broken worker. Publish and pin a
reviewed worker before the next affected execution.

## Publication and audit

Final publication still requires one valid selected receipt for every logical
task. The publisher retains the physical Job, worker, repair, usage and cost
history behind each selected result. Failed executions remain immutable and are
never rewritten as successful benchmark attempts.

The published result must show that completed tasks were not rerun and that
infrastructure retries did not create extra benchmark trials. It must also
reconcile the full run cost, including failed Jobs.

## Implementation plan

### Portable contracts

Update `packages/contracts` so task and execution records clearly distinguish a
logical benchmark trial from a physical infrastructure execution. Keep one
selected receipt per task. Remove the fixed infrastructure-attempt exhaustion
rule from new run records while preserving old records for audit.

Generated JSON Schema, TypeScript types and OpenAPI output must stay current.
The contracts must reject conflicting task identities, launch actions, receipts
and immutable bytes.

### Control state transitions

Update `packages/control-core` so a valid selected task is final and an invalid
or missing receipt leaves the task unresolved. The reconciler should create a
new execution for an unresolved task after terminal observation and cleanup.
There is no fixed infrastructure retry count.

Every retry must pass the existing admission, cost and capacity checks. Pause or
cancellation prevents new Jobs. A repeated deterministic failure moves affected
work to a paused repair state instead of creating a tight retry loop.

Projection replay must produce the same selected tasks, unresolved tasks, cost
and next action from duplicated or shuffled Bucket records. A service restart
must not rerun a selected task or create two Jobs for one retry action.

### API and web state

Update `apps/control-api` and the web read model so operators can distinguish
finished tasks, unresolved tasks, failed physical Jobs and paused shared
defects. Retry controls operate on unresolved task IDs. They do not clear valid
receipts or reset cost.

Keep the TypeScript service as the only shared control authority. Do not add a
Python reconciler, browser Bucket access or another persistent store.

### Worker behavior

Update the reviewed trial worker in `packages/harbor-hf-agents` only where
needed to report complete task receipts and clear infrastructure failures. Each
physical Job reconstructs the same prepared one-attempt Harbor `JobConfig` and
runs the task from the beginning. Harbor's internal retry count stays zero.

The worker uploads complete evidence through its short-lived capability. It does
not implement conversation, workspace, process or container checkpoints.

### Evidence and publication

Keep all physical execution receipts and costs. Add any missing links between a
logical trial, its physical Jobs, worker generations and selected receipt.
Publication continues to select one valid receipt per task and retains failed
execution provenance.

Do not publish private logs, raw conversations, task workspaces, credentials or
operator-specific infrastructure. Public rows contain only approved normalized
fields.

## Verification

Add contract, state-machine, worker and publication tests for:

- several tasks finishing before one physical Job fails
- a failed task receiving a new Job while finished tasks stay untouched
- many consecutive infrastructure failures without attempt-count exhaustion
- admission stopping retries at the run cost ceiling
- pause and cancellation preventing new Jobs
- duplicate retry requests adopting one action
- restart replay preserving selected and unresolved task sets
- a repaired worker running only unresolved tasks
- a repeated deterministic defect pausing affected work
- a valid zero-reward task remaining selected
- final publication retaining all failed Job provenance and cost

Inject process exits before and after Job dispatch, terminal observation,
evidence upload, receipt selection and action advancement. Replay Bucket records
in different orders and with duplicates. The selected tasks, unresolved tasks,
next action and cost must remain the same.

Run one no-inference lifecycle check with several fake tasks. Finish some tasks,
fail one physical execution and prove that only the unresolved task receives a
new Job. Then run one bounded remote canary through the existing resources and
prove the same behavior with a real task result.

## Required checks

Run all checks required by the final changed-file set. At minimum, run:

```sh
uv run python scripts/check_public_privacy.py .
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
npx -y @simpledoc/simpledoc check
uv run slophammer-py dry .
uv run pip-audit
uv run slophammer-py check .
git diff --check
```

Run Pi Reviewer against the approved comparison base until no P0 or P1 finding
remains. Remote tests need their normal spending authorization and launch
checks.

## Rollout

Land the portable contracts and deterministic control changes before changing
retry admission. Run the no-inference lifecycle test first. Then use one bounded
remote run with several tasks and force one infrastructure execution to fail.

The rollout passes when finished tasks remain selected, only the unresolved task
runs again, no fixed attempt counter exhausts it, costs remain continuous and
publication retains every execution. Expand concurrency only after those facts
are durable.

Stop rollout if a selected task runs again, a retry creates another benchmark
trial, cost resets, duplicate Jobs appear or failed execution history is lost.

## Boundaries

This design uses the existing control Space and private artifact Bucket. It does
not add a repository, Space, Bucket, Dataset, Endpoint, service, credential,
model server or persistent resource.

It does not change benchmark tasks, models, providers, harnesses, prices,
context limits, output limits, verifier behavior, scoring, evidence selection or
publication meaning. It does not patch Harbor internals.

It does not save or resume partial task state. Each retry starts one unresolved
task from its original prepared input.

This documentation change does not implement code, launch Jobs, spend money,
publish a worker, deploy or release. Those actions require their normal review,
checks and authorization.

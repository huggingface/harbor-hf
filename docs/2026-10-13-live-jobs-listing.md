# List only live Jobs

## Problem

The Hub keeps every finished Job in a namespace. A hosted namespace that has run a few benchmark
campaigns holds tens of thousands of finished trial sandbox Jobs. The Jobs list API returns 100
Jobs per page, newest first.

The control service filtered its Jobs listing by the `harbor-hf-role` label but not by stage, so
each listing read every page of the role's history. The reconciler lists Jobs at least twice per
pass and once more for each runnable or live run, every 15 seconds. On such a namespace one
listing is hundreds of requests, and an idle service sends more than a thousand list requests per
minute. Submission, pause, resume and replacement checks list the same history.

The Workbench read only the first page of the whole namespace, without any filter. A setup test
was invisible when 100 newer Jobs existed, which is normal during a benchmark run, and its active
Job check counted only those 100 Jobs.

## Change

1. **The Jobs listing holds only live Jobs.** `JobsPort.list` now returns only queued or running
   owned Jobs. The adapter adds `stage=RUNNING&stage=SCHEDULING` to each role listing. These are
   the only live stages that the Hub accepts as a filter. A response with a Job in another stage
   fails the listing, so an ignored filter can never turn into a history scan.
2. **A finished parent is read by ID.** The reconciler already inspects a run's recorded parents
   when no live parent is listed. Resume, the parent error pause and the replacement source check
   use the same inspection. The adapter keeps an in-memory copy of each inspected Job in a final
   Hub stage (`COMPLETED`, `CANCELED`, `ERROR` or `DELETED`), so a finished parent is read once
   per process. Other stages are read again every time.
3. **The settling window uses the service's own observations.** A run is refreshed at the close
   of each pass for ten minutes after a listing last showed it with a live Job. The service keeps
   that time in memory. It no longer needs `finished_at` from a listing of finished Jobs.
4. **Each per-run listing replaces the earlier observations.** A Job missing from a fresh live
   listing is no longer live. Only a parent that the same pass started stays, because the listing
   can show a new Job late.
5. **The Workbench filters at the Hub.** A setup test is found by its `harbor_hf_kind` and
   `harbor_hf_setup_id` labels, and an owner's setups by `harbor_hf_kind` and
   `harbor_hf_owner_digest`. Each is one page. The active Job limit counts the namespace's
   `RUNNING` and `SCHEDULING` Jobs and stops reading at the limit.

## Unchanged

- Harbor owns trial execution. No field, record or store is added.
- Recorded parents remain the authority for parent liveness. Listing absence still never proves
  that a recorded parent stopped; the reconciler inspects it.
- A restart still rebuilds the whole projection from the Bucket.

## Behavior change

- `GET /api/v1/jobs` and the console's parent Job views show live parent Jobs only. The run state
  still records every parent Job ID.
- A parent Job that is not in the run state and that stops before any pass lists it is not seen.
  Before this change, its error stage could pause the run.

## Verification

- Adapter tests check the label and stage query of every listing, the rejection of an ignored
  stage or label filter, and that only final stages are cached.
- Service tests check the ten-minute settling window from the last live listing, and that a Job
  that leaves the live listing during a pass is inspected instead of kept as live.
- After deployment, an idle control service sends about two list requests per listing instead of
  hundreds.

## Later change

[The Hub request audit](2026-10-13-hub-request-audit.md) replaces the two role listings with one
stage-filtered request, removes the closing listing, and stops all requests when the service is
idle.

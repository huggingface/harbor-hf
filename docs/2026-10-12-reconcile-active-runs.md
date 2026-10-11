# Reconcile active runs without listing run artifacts

## Problem

A queued run waits about half an hour before the reconciler starts its parent Job, and longer
after a restart. On a hosted installation with about 190 runs and 17,000 trials, the Bucket holds
about 7 million objects under `runs/`, roughly 400 per trial: agent logs, verifier files and the
captured workspace. A recursive listing of that tree takes close to an hour.

Every projection rebuild starts with that recursive listing, although it reads only a few JSON
files per run. The reconciler runs one full rebuild when a pass starts and another when it ends,
and the service runs one more at startup before the reconciler starts. A run is admitted only when
a pass reaches it, so its wait is up to two full listings, or three after a restart.

## Change

1. **A rebuild lists only what it reads.** The projection discovers runs with a shallow listing of
   `runs/`. For each run, it lists the run folder, `job/` and `attempt-costs/` one level deep.
   These listings name the run records, the Harbor job metadata, the trial directories and the
   receipts. Each trial's `result.json` is read by key, without cache. A trial without that file
   has no result yet, as before. Harbor's artifact trees are never listed. A full rebuild then
   makes about three listing calls per run, plus the same JSON reads as before.
2. **A pass refreshes only runs that can change.** When a pass starts, it rebuilds only runs that
   the projection does not hold yet. The per-run loop keeps its scoped refresh of every run that
   can act: a runnable run, or a run with a live Job. When the pass ends, it refreshes the runs
   that the loop handled and the runs whose Job observations changed during the pass. Settled
   history is not read again: a cancelled, paused, finished or cost-stopped run with no live Job.
3. **Job observations publish on their own.** The projection records each complete Jobs listing,
   with its time, without a Bucket rebuild. The console's freshness and parent Job views stay
   current every pass.

## Unchanged

- Harbor owns the files under `job/`, and the projection reads Harbor's result files as written.
  No field, record or store is added.
- The safety rules of a pass stay the same: complete Jobs listings, re-reading state under the
  run lock, inspecting recorded parents, cancelling parents before children, and the fresh native
  result check before a restart.
- A restart still rebuilds the whole projection from the Bucket, now with shallow listings.

## Verification

- Tests show that a rebuild never lists recursively and never reads trial artifacts.
- Tests show that a second pass over settled history makes no rebuild, and that a queued run is
  started in the first pass.
- The existing reconciliation tests keep passing, with updated I/O counts.
- After deployment, a queued one-task run starts within a few reconcile intervals, and the startup
  rebuild finishes in minutes instead of an hour.

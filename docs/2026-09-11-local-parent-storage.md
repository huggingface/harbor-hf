---
title: Local parent storage and durable snapshots
author: Harbor-HF maintainers
date: 2026-09-11
tags: [architecture, harbor, storage]
---

# Local parent storage and durable snapshots

This is the approved local implementation, not a claim of deployment or remote
validation. The parent executes Harbor on local disk and copies native artifacts
to the existing private Bucket. The control Space's storage is unchanged. No
additional persistent resource, execution scheduler, or result format is added.

## Execution and restore

The parent Job has no Bucket volume mount. `HARBOR_HF_LOCAL_ROOT` defaults to
`/data`, which is disposable local execution storage. The launch environment
supplies `HARBOR_HF_BUCKET_ID` as `<namespace>/<artifact-bucket>`. These runtime
variables replace the parent's `HARBOR_HF_MOUNT_ROOT`; they are not new run
record or Harbor configuration fields.

`BucketArtifacts.restore()` requires a fresh, nonexistent local run directory.
It uses `HfApi.sync_bucket()` to download `runs/<run-id>/`, then fetches
`state.json` afresh with `download_bucket_files()`. Missing control state is an
error. The parent validates the run identity, pinned revision, sources, and
native `JobConfig`, including its existing `job_name: job` and
`jobs_dir: /data/runs/<run-id>` values. A configured local root must match the
immutable native path; it does not authorize rewriting that configuration.

`Job.create(config)` opens the restored native job directory and applies
Harbor's configuration, lock, completed-trial discovery, and resume rules.
`Job.run()` remains the only trial executor. Restore is a transport operation,
not a second resume algorithm. Local disk must fit the restored and working
artifacts; the Bucket is not the parent's execution filesystem.

## Lifecycle copies and control intent

The parent registers native `on_trial_started` and `on_trial_ended` callbacks.
Transfers are serialized by a process-local publication lock, not a durable run
lock or scheduler. The parent also holds the pinned job's existing
`_trial_completion_lock` while reading native aggregate metadata and checking
costs: this prevents snapshots racing Harbor's asynchronous truncate/write.
It does not create a second aggregate writer or completion state. At both callbacks it downloads `state.json` afresh through
the Bucket API before checking control intent; it never uploads that file or
`run.json` back to the Bucket.

At START, paused or cancelled intent raises a controlled stop before inference.
Otherwise the parent uploads available native job `config.json`, `lock.json`,
and `result.json`, plus the starting trial's native `config.json` and
`lock.json`. It removes any previous terminal result for that name before
publishing the new identity. No in-flight logs or trial result are copied.
This first real metadata write also checks Bucket write access before inference.

At END, after the native scrub ordering described below, the existing cost hook
writes the immutable attempt receipt and applies the unchanged cost policy.
Controlled interruptions preserve reported provider cost and remove the
interrupted trial folder and incomplete aggregate result so Harbor can resolve
missing work on resume. The callback's `finally` copies the trial subtree,
then native job metadata, then attempt-cost receipts, including when a handled
cost/control stop is raised. Publishing native terminal counters before the
receipt lets reconciliation observe completion evidence during aggregation.

Uploads copy current file bytes with `batch_bucket_files()` rather than skipping
files based on matching modification times or sizes. Trial subtree copies remove
remote files absent locally. Within each copied subtree its root `result.json`
is published after the other files and deletions. This ordering is not an atomic
whole-run transaction; lifecycle metadata is a separate native snapshot.
Attempt-cost receipts are retained when Harbor discards a retry folder.
For an errored attempt in any retry-enabled run, the per-trial copy withholds
its terminal `result.json` until the final settled-tree copy. Otherwise, a
parent lost after native trial-directory deletion during backoff could restore
the previous failed result as completed and suppress the missing work. This is
a conservative publication boundary, not an attempt counter or retry decision.
It also defers terminal diagnostics for exhausted failures until final copy;
interrupted runs may repeat that unsaved outcome. Successful trials and all
zero-retry trials retain live result publication.
Symbolic links are refused by the subtree uploader.

After successful `Job.run()` completion or a handled expected cost/control stop,
the parent checks the scrub failure veto and performs the final copy: receipts
first, then the settled native job tree with stale remote files removed and the
aggregate `job/result.json` published last. Unexpected execution, integration,
finalization, or upload failures propagate without a final whole-tree copy of
uncertain output. They rely on the last acknowledged per-trial copies. Upload
failures are explicit, not reported as durable success.

A hard kill or forced cancellation cannot guarantee callbacks, cleanup, or a
final copy. Outputs and cost evidence not yet acknowledged by the Bucket may be
lost, and resumed work may repeat provider use not present in saved evidence.
Preserved receipts retain their original attempt identity and costs; this is not
a guarantee of complete billing capture after abrupt termination.

## Approved private native scrub ordering

The recorded review checked Harbor `src/harbor/trial/trial.py`,
`src/harbor/trial/hooks.py`, `src/harbor/trial/queue.py`, and `src/harbor/job.py`
at pin `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`, including the scrubber
introduced in `046e2a6d`. History through
`e1be9bd39c368f88a27fee4cbd26655e9994ee5a` still emits END before native
scrubbing. Public `Job.on_trial_ended()` alone is therefore too early for a
post-scrub upload; updating to that inspected latest revision does not close
the gap.

The separately approved local private-API workaround in
`scrub_before_upload.py` scopes an interception of `Trial._emit` around job
creation, execution, and final upload in the exclusive parent process. It calls
the actual trial's existing `Trial._scrub_jobs_dir()` before dispatching END.
It neither copies the sanitizer nor reconstructs trials. Native `finally`
scrubbing remains unchanged as a backstop. Revision mismatch, overlapping
contexts, unexpected bindings, and integration failures fail explicitly; a
sticky runtime failure veto blocks final uploads. This is not persisted state.

Remove this adapter at the first reviewed, supported Harbor pin with a
post-sanitization upload hook or native sanitization before END. No qualifying
revision exists in the inspected history above; no future SHA is specified.
This local approval does not authorize upstream publication.

The adapter preserves native best-effort UTF-8 text scrubbing only. Harbor
collects sensitive environment values from its native sources and replaces
literal matches; binary/non-UTF-8, unreadable, or otherwise skipped files can
remain unchanged. It does not promise arbitrary secret safety. The adapter does
not sanitize in-memory hook results, native aggregation, or job-level logs.
Uploads use native files, not reserialized hook results, and the absence of a failure
veto is not proof that the whole tree is secret-free.

## Snapshot observability and unchanged contracts

The dashboard needs native job config, lock, and aggregate result, per-trial
results, and immutable attempt-cost receipts, together with current HF Job
observations. Lifecycle and per-trial copies provide saved snapshots for the
existing projection and artifact APIs. They do not provide streaming live logs,
continuous artifact replication, fabricated pending identities or progress, or
a full POSIX filesystem promise for Bucket storage. Browser polling and a live
parent do not prove that local output has reached the Bucket.

Compared with the current schemas in `packages/contracts/schemas/`:

- `run-record-v1.schema.json` retains `harbor_job_config` and `harbor_revision`;
  no local-storage or copy-status field is added.
- `harbor-job-config-v1.schema.json` retains native `job_name`, `jobs_dir`,
  `environment.kwargs`, concurrency, and retry values. Harbor's `JobConfig`,
  job/trial locks, and result models remain authoritative.
- `run-state-v1.schema.json` retains `desired_state` values `run`, `paused`, and
  `cancelled`, revision, actor, timestamps, and parent observations. Only the
  control service writes this record.
- `attempt-cost-v1.schema.json` retains `schema_version: v1`, `attempt_id`,
  `trial_name`, and nullable nonnegative `cost_usd`. Null remains null and counts
  as zero only for ceiling arithmetic; failure before agent execution records
  zero under the existing policy. Campaign and legacy per-trial checks are
  unchanged.
- `trial-progress-v1.schema.json` and existing API/UI values remain projections
  of native evidence. There are no new durable schema fields, API routes,
  scheduler state, or progress counters.

Implementation references:
`packages/harbor-hf-agents/src/harbor_hf_agents/parent_worker.py`,
`bucket_artifacts.py`, and `scrub_before_upload.py` in that directory, plus
`packages/hf-adapters/src/jobs.ts` for the parent launch environment and removal
of its Bucket volume. See [Architecture](architecture.md),
[Control service](CONTROL_SERVICE.md), and the
[cutover specification](2026-09-04-simplification-implementation-spec.md).

The global native `job/job.log` is deliberately excluded from Bucket uploads:
it receives trial log messages but is outside Harbor's trial-directory scrubber.
Scrubbed per-trial logs remain available, and the existing dashboard reads native
JSON observations rather than this global log. Final reconciliation removes any
previous copy of that global log in the run's job subtree.

## Release boundary

Release the reviewed parent image and matching control launch template together.
The new worker requires the Bucket identifier and local-root environment, while
the new launch template no longer supplies a volume. Mixing old workers with
new launch configuration (or the reverse) fails early; there is no compatibility
mount, dual writer, or run-record migration. Configure the matching immutable
image before enabling new submissions. This PR does not deploy either runtime
or alter an already-running parent.

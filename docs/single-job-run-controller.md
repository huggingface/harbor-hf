# Single-job run controller specification

> **Historical record — superseded 2026-09-02.** This document preserves the
> earlier controller design as factual history. Its imperative language is not
> current Run or inference guidance. New work follows
> [`CONTROL_SERVICE.md`](CONTROL_SERVICE.md).

Status: superseded historical design

This specification replaces the local reconciliation loop for Inference Provider runs with one detached Hugging Face controller Job per run. The Job runs the run from its immutable plan, executes bounded waves inside its own process, retries infrastructure failures, finalizes evidence, and publishes the run result.

The approved [control service
plan](2026-08-16-harbor-hf-control-service-plan.md) and [control service
specification](CONTROL_SERVICE.md) replace this Job's live Git-backed ownership
and finalization path with one TypeScript service and immutable Bucket records.
This specification remains a description of current behavior until the
new-write switch passes its launch, crash-recovery, repair, publication, and
cleanup gates.

A successful run normally uses one physical controller Job. An infrastructure recovery uses a new physical controller Job under the same logical run. Only one controller may own the run at a time.

## Decision

The current provider run design used 49 physical wave Jobs across seven Hermes runs. All seven remained active when the local monitor exited at its deadline. The failure was operationally meaningful because completed remote work could no longer advance without the submitting machine.

The minimum worthwhile change is:

- no run progress depends on a local process;
- one normal provider run uses one controller Job instead of 5 to 12 wave Jobs;
- a controller exit cannot rerun completed logical trials;
- reconciliation continues through finalization unless durable policy requires an operator decision;
- existing spend, retry, evidence, and secret-safety gates remain in force.

The single-job controller is recommended for implementation. It is not approved for production until the canary and recovery gates in this specification pass.

## Scope

The first implementation covers runs whose resolved deployment kind is `inference-provider`.

It covers:

- immutable run submission;
- one active controller Job;
- internal bounded waves;
- trial-level durable progress;
- infrastructure retries;
- spend admission;
- result finalization and publication;
- controller recovery after an infrastructure failure;
- a shared remote watchdog.

Endpoint-backed runs are outside this first implementation because endpoint cleanup requires an independent safety observer when the controller is killed. Their existing endpoint watchdog remains a separate resource-type requirement, not a provider-run fallback.

The implementation replaces the current provider wave-Job path in place. New provider runs must not choose between old and new execution modes. Existing immutable run evidence remains readable for audit, but old wave Jobs are not a new-write option after release.

## Normal resource count

One provider run has:

- one logical run;
- one active physical controller Job;
- zero child wave Jobs;
- one shared namespace watchdog schedule, not one watchdog schedule per run.

A successful run uses one physical controller Job. If the controller suffers a retryable infrastructure failure, each recovery adds one sequential controller Job. Two controller Jobs must never own run execution at the same time.

## Input package

The benchmark-source implementation stages one immutable input folder:

```text
run-input/
├── manifest.yaml
├── source.lock.json
├── run.lock.json
└── input-manifest.json
```

`manifest.yaml` is the exact requested experiment.

`source.lock.json` is the resolved benchmark source. A public Git request remains
an anonymous commit-pinned source. An operator directory becomes an immutable
bundle reference. The lock never contains a local path or source credential.

`run.lock.json` fixes the run, runs, shards, logical trials, recovery policy, controller policy, duration bounds, and resolved source identity.

`input-manifest.json` records the exact byte count and SHA-256 of the other three files. The input folder is stored under a content-addressed private Bucket path and mounted read-only. A benchmark bundle is stored once beneath its own content address and mounted separately.

Extra files are invalid. Symlinks are invalid. Every digest uses SHA-256 over exact file bytes. The source lock is required by the [benchmark source contract](benchmark-sources.md), and authenticated Git has no fallback path.

## Minimal manifest addition

The existing `execution` and `remote.job` fields remain authoritative. Provider runs add one required `execution.controller` object:

```yaml
execution:
  attempts: 6
  concurrent_trials: 24
  timeout_seconds: 16200
  max_trials_per_shard: 24
  max_shards_per_wave: 4
  controller:
    planning_trial_seconds: 900
    headroom_factor: "1.25"
    wave_reserve_seconds: 900
    controller_reserve_seconds: 1800
    heartbeat_seconds: 60
    stale_after_seconds: 600
    max_attempts: 3

remote:
  job:
    namespace: example-org
    image: ghcr.io/example/controller@sha256:0000000000000000000000000000000000000000000000000000000000000000
    flavor: cpu-upgrade
    timeout_seconds: 85800
```

The duration values come from the approved representative pilot. They are runtime admission rules, not comments.

## Controller fields

| Field | Required | Type | Rule |
| --- | --- | --- | --- |
| `planning_trial_seconds` | Yes | integer | At least 1. Conservative end-to-end trial duration from the matching pilot. |
| `headroom_factor` | Yes | decimal string | At least `1.0`. Applied to trial work before fixed reserve. |
| `wave_reserve_seconds` | Yes | integer | At least 1. Covers wave setup, drain, evidence publication, and route closure. |
| `controller_reserve_seconds` | Yes | integer | At least 600. Covers source setup, final reconciliation, summary publication, and clean exit. |
| `heartbeat_seconds` | Yes | integer | From 30 through 300. |
| `stale_after_seconds` | Yes | integer | At least three times `heartbeat_seconds`. |
| `max_attempts` | Yes | integer | From 1 through 10. Counts physical controller Jobs for one logical run. |

Unknown fields are validation errors. Defaults are not inserted for production submission. The approved manifest must show every controller field.

## Duration calculation

The planner computes the effective concurrency for each provider deployment:

```text
effective concurrency = min(
  execution.concurrent_trials,
  provider.limits.max_concurrent_requests,
  selected profile concurrency
)
```

For a wave with `T` initial logical trials and effective concurrency `C`:

```text
batches = ceil(T / C)
trial work = batches * planning_trial_seconds
planned wave seconds = ceil(trial work * headroom_factor) + wave_reserve_seconds
```

The planned initial run duration is:

```text
planned run seconds =
  sum(planned wave seconds for every initial wave)
  + controller_reserve_seconds
```

Submission must reject the run unless:

```text
planned run seconds <= remote.job.timeout_seconds
```

Each planned wave must also satisfy:

```text
planned wave seconds <= execution.timeout_seconds
```

The normal one-Job claim covers initial logical attempts. Infrastructure retries remain bounded by the recovery and spend policy and may require a sequential recovery Job.

The controller recalculates projected completion from observed trial durations after every wave. It must stop admitting new trial work when the remaining run no longer fits the physical Job deadline with the locked controller reserve. The physical deadline starts at container entry, before pinned worker source setup. Within a provider wave, recorder setup uses the locked wave reserve; trial work still receives its planned work duration while setup remains inside that reserve. It drains current work, publishes a capacity-blocked checkpoint, and exits without claiming run completion. The watchdog must not automatically resume a capacity-blocked run because the approved throughput assumption has changed.

## Job launch

`harbor-hf run submit` performs these steps:

1. Validate and plan the run.
2. Verify that the complete initial run fits one physical Job.
3. Upload or verify any benchmark bundle before creating run state.
4. Create the immutable run and input package.
5. Reserve controller attempt 1 with a parent-checked commit.
6. Adopt an immutable launch receipt when one already exists.
7. Acquire the parent-checked launch claim for this controller attempt.
8. Search for an existing Job with the exact run label.
9. Launch one detached controller Job if no matching Job exists.
10. Record the physical Job ID in an immutable launch receipt.
11. Release the launch claim.

The Job command is:

```text
harbor-hf run-controller \
  /input/manifest.yaml \
  /input/run.lock.json \
  --output-root /output
```

The controller requires `source.lock.json` beside the two positional input files and verifies it through `input-manifest.json` before planning any action.

The Job has these labels:

```text
harbor-hf-role=run-controller
harbor-hf-run=<run-id>
harbor-hf-plan=<short-plan-digest>
```

The platform `JOB_ID` identifies the physical controller attempt. It is recorded in controller receipts, execution locks, status, and the final run report. The container wrapper records `HARBOR_HF_JOB_STARTED_AT` before cloning the pinned worker source. Remaining-time admission uses that timestamp, so worker checkout and `uv` startup consume the physical Job timeout.

Launch claims use `claims/controller-launches/<run-id>/<attempt>.json`.
They serialize the check-and-launch sequence across CLI retries, watchdog schedule
runs, and webhook runs. A successful launch writes
`runs/<run-id>/controller-launches/<attempt>.json` before releasing
the claim. If launch outcome is uncertain and no exact-label Job is visible, the
claim remains for 30 minutes. A retry may adopt a matching Job immediately, but
it cannot issue another launch until the claim expires.

The launch exposes the provider and judge recorder ports required by any resolved run. It injects only explicitly approved, purpose-scoped runtime secrets through Hugging Face Job secrets. Benchmark sources never contribute a secret name. Commands, locks, events, and evidence contain approved runtime secret names only.

## Ownership

The coordination Dataset contains one controller claim:

```text
claims/run-controllers/<run-id>.json
```

The claim records:

```json
{
  "run_id": "20260730-example",
  "job_id": "6a0000000000000000000000",
  "plan_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "acquired_at": "2026-07-30T00:00:00Z",
  "heartbeat_at": "2026-07-30T00:01:00Z",
  "expires_at": "2026-07-30T00:11:00Z"
}
```

Claim creation and renewal use the current repository head as the expected parent. A second controller that cannot acquire the claim exits before source preparation, provider requests, or evidence writes.

The claim expires only after `stale_after_seconds`. Claim expiry permits investigation; it does not by itself authorize another Job. Recovery also requires proof that the prior physical Job is terminal or absent.

## Shared provider capacity

Before a `submit-wave` or `retry-shard` action, the controller acquires one
parent-checked capacity claim keyed by the locked provider service:

```text
claims/provider-capacity/<sha256-of-provider>.json
```

The claim records the provider, run, plan, physical Job, controller
attempt, action, and acquisition time. One namespace therefore runs at most one
internal wave against the same provider service at a time. This is the safe
baseline because separate run manifests do not establish a trusted shared
quota. Request concurrency remains inside the wave and follows each deployment's
locked `max_concurrent_requests`.

A controller that finds the capacity claim occupied waits without reserving or
running the action. Remaining-time admission continues while it waits. The
claim is released only by its exact owner after synchronous wave execution
returns. It has no time-based cross-run takeover. After a controller crash,
the owning run's watchdog removes the abandoned claim only after proving
the physical Job terminal or absent. This cleanup runs even when policy blocks a
replacement, so unrelated runs do not remain blocked. A sequential
replacement may then acquire capacity normally.

## Controller receipts and status

Immutable attempt receipts use:

```text
runs/<run-id>/controllers/<job-id>/started.json
runs/<run-id>/controllers/<job-id>/ended.json
```

The mutable latest controller status uses:

```text
runs/<run-id>/controller-status.json
```

Dataset history preserves every status update. The status contains:

- run and plan identity;
- physical Job ID;
- controller attempt number;
- state;
- current wave and action when present;
- run projection counts;
- spend reservation;
- last durable progress time;
- last heartbeat time;
- physical deadline and remaining seconds;
- latest block reason;
- latest evidence and event revisions.

Allowed controller states are:

```text
starting
running
waiting-retry
finalizing
completed
paused-capacity
paused-policy
failed-infrastructure
failed-deterministic
```

`completed` requires the run completion gates below. A physical Job ending with exit code zero is not enough.

## Runtime loop

After acquiring ownership, the controller performs this loop:

1. Validate the input package and reproduce the run lock from the manifest and source lock.
2. Load the resolved benchmark source, then prepare the pinned Harbor and worker sources once. Anonymous Git uses no credential; a bundle is verified and extracted on Job-local storage.
3. Refresh the Bucket listing, observe compact evidence, and append any missing idempotent run events.
4. Rebuild the recovery projection from the immutable lock and append-only events.
5. Derive one deterministic next action.
6. Apply non-billable cleanup and finalization actions first.
7. Check spend, retry, concurrency, and remaining-time admission before billable work.
8. Acquire the shared provider capacity claim for a billable action.
9. Build one deterministic wave lock.
10. Execute the wave inside the controller process.
11. Publish the wave and trial evidence with terminal markers last.
12. Release the provider capacity claim.
13. Refresh and commit the resulting run events.
14. Update the controller status and heartbeat.
15. Repeat until the run is terminal or durably blocked.

The controller executes at most one internal wave at a time. Trial concurrency remains inside that wave and follows the locked effective concurrency. This keeps provider pacing and spend accounting unchanged while removing child Job handoffs.

## Internal wave execution

The existing wave lock remains the execution unit. The controller builds the same deterministic wave identity and applies the same task, attempt, model, agent, judge, provider, timeout, retry, and evidence policy.

The wave runner changes in these ways:

- it runs in the controller process instead of a child HF Job;
- it reuses the verified anonymous Git checkout or extracted benchmark bundle;
- it uses the controller `JOB_ID` as `remote_job_id`;
- it starts and closes provider and judge recorders for the wave;
- it writes trial evidence incrementally;
- it returns a typed wave result to the controller;
- it never launches another HF Job.

A wave failure does not terminate the controller automatically. The controller first records every complete execution, classifies unfinished attempts, closes routes, and rebuilds the projection. A deterministic controller or configuration failure stops the run in `failed-deterministic`.

## Durable trial boundary

A logical trial becomes durable only after all required files, checksums, private artifact inventory, workspace archive, session, trajectory, provider evidence, judge evidence, verifier output, and terminal marker have been published.

Completed trial markers are immutable. A restarted controller must adopt a complete matching trial and must not run its agent again.

If the controller dies while trials are active:

- complete terminal trials remain complete;
- uniquely valid interrupted finalization may be repaired under the existing finalizer contract;
- incomplete physical attempts are classified as lost infrastructure;
- only retryable infrastructure outcomes may receive another physical execution;
- agent, benchmark, verifier, and valid zero-reward outcomes remain terminal.

The run lock, event head, selected terminal trial identities, execution checksums, spend reservation, and current retry generation form the recovery checkpoint. The authoritative output bytes remain in the private Bucket.

## Retry behavior

The controller applies the existing retry taxonomy and backoff.

Automatic retry requires all of these conditions:

- the latest physical outcome is classified as retryable infrastructure;
- the logical trial is not terminal;
- the physical execution limit is not exhausted;
- retry backoff has elapsed;
- the spend reservation fits;
- the retry wave fits the remaining physical Job time;
- run control remains active;
- no shared deterministic defect has been detected.

An automatic retry creates a new physical execution ID under the same logical trial. It does not create a new logical attempt or run.

When a deterministic defect affects shared worker code or data assumptions, the controller stops new trial admission and records `paused-policy`. It does not continue sibling work known to be vulnerable.

## Spend behavior

Provider admission keeps the existing conservative reservation rules.

The controller must:

- reserve estimated wave cost before provider requests;
- retain unattributed reservations as required by current policy;
- record observed provider usage without presenting it as billing when billing is unavailable;
- reject work that exceeds run or deployment caps;
- stop automatic continuation when the approved provider, hardware, method, or cost assumptions differ from observed state.

Controller attempt count is also bounded. The watchdog must not launch attempt `max_attempts + 1` without a new explicit approval record.

## Deadline behavior

A target completion time is reporting metadata. It must not stop reconciliation, cleanup, or finalization.

The controller has three separate time concepts:

- the physical HF Job timeout, which bounds one controller attempt;
- the wave execution timeout, which bounds one internal wave;
- an optional operator cancellation request, which stops new work and drains safely.

There is no hardcoded wall-clock date that ends the controller loop. Paid work stops only because of durable cancellation, spend admission, retry exhaustion, remaining-time admission, or a policy block. Non-billable reconciliation and finalization continue whenever the controller is healthy.

## Watchdog

One managed scheduled Job watches all approved runs in a namespace. It is a recovery mechanism, not the normal run driver.

The watchdog runs every five minutes with schedule concurrency disabled. It may launch a replacement controller only when all of these checks pass:

- run state is nonterminal;
- no controller Job for the run is active;
- the latest heartbeat is stale or the latest Job is terminal;
- the controller claim is absent or expired;
- the failure is retryable infrastructure;
- the latest durable trial and evidence checkpoint verifies;
- the next controller attempt is within `max_attempts`;
- provider spend and retry policy still permit continuation;
- the immutable input package and launch contract match attempt 1;
- no capacity or policy block requires operator approval.

The watchdog records an immutable recovery decision before launch. An ambiguous launch result is resolved by inspecting the exact run label before another launch attempt.

The watchdog never runs run reconciliation, executes trials, changes scores, seals partial runs, or modifies immutable evidence.

## Cancellation

A durable cancellation request is observed between trials and before each new wave. The controller stops admission, drains active trial processes according to the locked grace policy, closes provider and judge routes, publishes available evidence, finalizes cancellation state, and exits.

Direct Job cancellation remains an emergency action. It must identify one physical Job and preserve the latest status, logs, control revision, and checkpoint first.

## Completion gates

The controller may publish run `completed` only when every gate passes:

- expected and observed logical trial counts match;
- every logical trial has one selected terminal outcome;
- every task and logical attempt distribution matches the lock;
- no trial, shard, wave, execution, retry, or action remains active or ambiguous;
- all provider and judge routes are closed;
- every required evidence object and checksum verifies;
- no controller or action claim remains owned by another Job;
- spend and usage records are complete or explicitly marked unreported;
- the run summary is immutable and checksum-complete;
- normalized result publication succeeds;
- the final controller receipt and status identify the physical Job and control revision.

A run blocked by capacity, spend, exhausted recovery, ambiguous evidence, or deterministic failure is not `completed`.

## Security

The controller keeps the existing security boundary:

- public Git runs anonymously with credential helpers and ambient Git authentication disabled;
- local and private benchmark files arrive only through verified private bundles;
- Git credentials are never injected into a Job or remote secret store;
- independent runtime credentials are purpose-scoped, explicitly approved, and injected as Job secrets;
- unprivileged agents never receive provider, judge, route, or Hub credentials;
- evidence excludes credentials, authorization headers, cookies, route capabilities, secret query parameters, and environment secrets;
- secret values are redacted before logs or evidence leave Job-local staging;
- provider evidence remains content-free;
- private sessions and workspaces remain in the private evidence Bucket;
- symlinks are rejected before evidence traversal;
- input and output paths are relative and traversal-safe;
- every source, image, task, model, agent, judge, and worker identity remains pinned.

A secret finding fails the affected evidence. The controller must not publish or repair it by copying the unsafe bytes.

## CLI contract

New provider runs use:

```text
harbor-hf run submit MANIFEST
harbor-hf run status RUN_ID --namespace NAMESPACE
harbor-hf run cancel RUN_ID --namespace NAMESPACE --reason REASON
harbor-hf run watchdog RUN_ID --namespace NAMESPACE --dry-run
```

`run submit` launches the controller after storing the immutable run. Its response includes run ID, controller Job ID, input digest, plan digest, and launch receipt.

`run reconcile --dry-run` remains available as a read-only diagnostic. `run reconcile --apply` must reject an active provider run owned by a controller. Normal provider progression has no local mutating command.

Managed automation installs the shared watchdog command. It no longer installs `reconcile-all --apply` for provider runs.

## Validation failures

Submission fails before remote work when:

- the manifest or lock is not reproducible;
- a behavior-affecting identity is mutable;
- the full initial run does not fit one physical Job;
- a wave does not fit its wave timeout;
- controller staleness is less than three heartbeat periods;
- spend or provider admission is incomplete;
- a Git source is not anonymously readable, a directory cannot produce the approved bundle, or an existing bundle does not verify;
- a required approved runtime secret is unavailable;
- the control Dataset or Buckets are not private;
- another run or controller already owns the identity;
- the launch dry run does not match the approved contract.

Runtime stops without new billable work when:

- observed throughput invalidates the locked duration bound;
- provider identity, route, API, or parameters differ;
- spend admission fails;
- controller ownership is lost;
- evidence is ambiguous or checksum-invalid;
- control or status commits cannot be made safely;
- a shared deterministic defect is detected;
- cancellation or manual intervention is active.

## Acceptance criteria

The implementation is eligible for production only after all of these checks pass:

- one representative 115-task by six-attempt provider run completes with exactly one controller Job;
- a local-directory canary succeeds from a private bundle without any Git credential in Job configuration;
- a public-Git no-inference check clones its full commit anonymously with credential helpers disabled;
- no child wave Jobs exist for that run;
- the result contains exactly 690 logical trials;
- killing the controller after at least two complete trials preserves those trials and retries only incomplete infrastructure work;
- the watchdog launches exactly one replacement and records the recovery decision;
- a duplicate controller cannot acquire ownership or issue a provider request;
- an ambiguous controller launch is adopted without duplication;
- a stale local terminal, closed SSH session, or absent submitting machine has no effect;
- a reporting deadline does not stop reconciliation or finalization;
- a capacity regression produces `paused-capacity` and no automatic paid continuation;
- a spend-cap block launches no provider request;
- cancellation drains and reaches a terminal run state;
- all trial evidence, sessions, ATIF trajectories, judge exchanges, workspaces, checksums, and secret scans pass;
- final publication and catalog authority remain separate;
- local quality, regression, dependency, schema, and documentation gates pass.

## Boundaries

This specification does not change Harbor task execution, agent semantics, verifier semantics, scoring, model selection, provider billing attribution, endpoint safety, or public result review.

It does not promise recovery from a deterministic worker defect under the same immutable launch contract. Such a defect requires a new reviewed run or a documented recovery worker revision under the existing provenance rules.

It does not claim that one physical Job can survive a platform kill. It makes the logical run recoverable and keeps normal progress inside one Job.

# Single-job run controller implementation plan

**Status.** Current implementation record, planned for replacement.

This plan implements the provider-run contract in [the single-job run controller specification](single-job-run-controller.md) inside `huggingface/harbor-hf`, then adopts it in `shellbench-local`. It does not launch remote work or change the current runs.

The approved [control service
plan](2026-08-16-harbor-hf-control-service-plan.md) is the canonical plan for
replacing detached controller ownership, live Git-backed claims, duplicated
profiles, and split result publication. The [control service
specification](CONTROL_SERVICE.md) defines the TypeScript API, reconciler,
projection, authentication, and web application that replace this path.

## Outcome

A new Inference Provider run launches one detached controller Job. That Job executes every initial wave in process, records trial evidence incrementally, handles allowed infrastructure retries, finalizes the run, and publishes results without a local control loop.

The release is accepted when a representative 690-trial run completes with one controller Job and zero child wave Jobs, and when a forced controller failure resumes in exactly one sequential replacement without rerunning completed trials.

## Constraints

- Keep Harbor core unchanged.
- Use public Harbor APIs only.
- Preserve the existing run, run, shard, trial, execution, and wave identities.
- Preserve strict infrastructure-only retry classification.
- Preserve provider concurrency, pacing, spend, judge, evidence, and secret-isolation rules.
- Keep provider model revisions `not_observed` where the provider cannot prove them.
- Keep current immutable run history unchanged.
- Do not migrate an active run into the new controller.
- Do not add a provider fallback to the old wave-Job path.
- Keep existing `v1alpha1` schema identifiers and replace their provider execution contract in place.
- Do not launch paid work until the matching cost and canary decision is approved.

## Current baseline

Record the baseline before editing:

- provider runs launch one HF Job per wave or retry;
- local or scheduled reconciliation launches the next Job;
- provider actions use `HuggingFaceWaveJobAdapter` and `submit_wave()`;
- `run_wave_worker()` owns one wave and requires a wave Job claim;
- managed automation runs `run reconcile-all --apply`;
- the seven current Hermes runs have used 49 physical wave Jobs;
- all seven remained active after the local monitor deadline stopped the control loop.

Save the exact Harbor HF commit, test results, generated schemas, CLI help, and current run projections before the first behavior change.

## Contract and schema work

Update the manifest and lock models first.

Target files:

- `src/harbor_hf/models.py`
- `src/harbor_hf/runs.py`
- `docs/run-spec.md`
- generated run schemas
- manifest and run model tests

Changes:

1. Add the required provider `execution.controller` object.
2. Validate heartbeat, staleness, reserve, headroom, and attempt limits.
3. Compute effective concurrency from the existing execution, provider, and selected-profile limits.
4. Compute a planned duration for every initial wave.
5. Store each planned wave duration in the run plan and lock.
6. Store the total planned run duration and controller policy in the plan and lock.
7. Reject a provider run that cannot fit one physical controller Job.
8. Reject a wave that cannot fit `execution.timeout_seconds`.
9. Include the controller policy and duration values in run and plan digests.
10. Keep unknown-field rejection.

Add unit tests for boundary values, exact decimal handling, deterministic planning, list reordering, task-name edge cases, multiple deployments, missing provider limits, and duration overflow.

Run Schemator against the proposed field model. Keep the raw initial and final graphs, applied and skipped decisions, and graph diff. Apply only changes that preserve the runtime meaning in the specification.

## Controller identity and storage

Add controller-attempt models and storage paths.

Suggested files:

- `src/harbor_hf/run_controller.py`
- `src/harbor_hf/controller_status.py`
- `src/harbor_hf/coordination.py`
- `src/harbor_hf/control.py`
- `tests/test_run_controller.py`
- `tests/test_controller_status.py`

Required records:

- parent-checked controller claim;
- immutable `started.json` and `ended.json` receipts per physical Job;
- mutable latest controller status with repository history;
- controller attempt count;
- run, plan, input, worker, and physical Job identity;
- heartbeat, lease expiry, physical deadline, and remaining time;
- projection counts, current action, current wave, spend reservation, and block reason.

The controller claim must reject a second owner before source preparation. Claim expiry must not alone authorize recovery; the prior physical Job must also be terminal or absent.

Use deterministic paths and canonical JSON. Reject unknown fields, non-UTC times, unsafe IDs, a plan mismatch, a Job mismatch, a decreasing attempt number, and a heartbeat that moves backwards.

## Pure run engine

Separate run decisions from remote Job submission.

Target files:

- `src/harbor_hf/reconciler.py`
- `src/harbor_hf/run_apply.py`
- `src/harbor_hf/recovery.py`
- existing run reconciliation tests

Refactor toward these ports:

```text
RunStateReader
RunEventWriter
WaveExecutor
RunFinalizer
RunPublisher
ControllerStatusWriter
Clock
```

The domain engine must:

- read one immutable lock and ordered event set;
- derive one projection;
- choose one deterministic next action;
- reserve the action before its side effect;
- apply one action through a typed port;
- record a durable outcome;
- rebuild state before the next action.

Keep action reservation and claim semantics. Keep cleanup and summary actions ahead of billable work. Keep global and run spend admission.

For provider runs, replace asynchronous `submit-wave` side effects with synchronous internal wave execution. The wire action name may remain `submit-wave` in the existing event schema, but its documented provider meaning becomes “admit and run this wave inside the owning controller.” Do not add an alias or second provider execution mode.

Keep endpoint action execution separate because endpoint ownership has different safety requirements.

## In-process wave runner

Extract the reusable wave application from `run_wave_worker()`.

Target files:

- `src/harbor_hf/wave_worker.py`
- a new `src/harbor_hf/wave_execution.py` if the extracted application is large
- provider recorder and judge recorder modules
- wave worker tests

The extracted runner accepts:

- validated experiment, run, and wave locks;
- controller physical Job ID;
- prepared Harbor and worker source paths;
- Job-local staging path;
- private output mount;
- provider and judge transports;
- clock, monotonic clock, and identifier ports.

It returns a typed wave result. It must not call the HF Jobs API.

Preserve these behaviors:

- deterministic wave and execution identity;
- root-owned provider and judge ingress;
- unprivileged agent isolation;
- trial-level physical attempt numbering;
- bounded trial concurrency and provider request concurrency;
- request pacing;
- infrastructure-only retries;
- frozen workspace capture;
- session and ATIF trajectory checks;
- finalization recovery;
- redaction, checksums, and terminal-marker ordering;
- route closure on every exit path.

Prepare pinned sources once per controller attempt and verify their revisions before each wave uses them. Do not reuse mutable package state between trials.

Retain `run_wave_worker()` only for endpoint-backed execution while that distinct resource path exists. Remove provider callers and reject provider wave locks passed to the standalone wave-worker command after the new controller ships.

## Controller loop

Implement `run_controller()`.

The loop must:

1. Validate the immutable input package.
2. Reproduce the run lock from the manifest.
3. Acquire controller ownership.
4. Write the started receipt and initial status.
5. Prepare pinned sources.
6. Import missing compact evidence events idempotently.
7. Rebuild the projection.
8. Apply cleanup and finalization work first.
9. Check remaining time before each billable wave.
10. Run one provider wave in process.
11. Publish and verify wave evidence.
12. Commit run events.
13. Update status and heartbeat.
14. Continue until completed or durably blocked.
15. Write the ended receipt and release ownership.

Use a dedicated heartbeat thread or async task that can renew ownership while one long trial is running. A heartbeat failure must stop new work and cause a safe drain. The worker must not keep issuing provider requests after ownership becomes uncertain.

The controller must handle process signals. On `SIGTERM`, it stops admission, allows bounded cleanup, publishes status when possible, and exits. `SIGKILL` recovery starts from durable evidence and the watchdog.

## Remaining-time admission

Add a pure admission function with exhaustive tests.

Inputs:

- physical Job start and timeout;
- current monotonic time;
- controller reserve;
- planned next-wave duration;
- active cleanup requirement;
- current projection and block state.

Outputs:

```text
admit
wait
finalize
pause-capacity
pause-policy
```

A target reporting date must not enter this function.

If observed throughput invalidates the locked duration assumptions, return `pause-capacity`. Publish the evidence used for that decision: completed trial count, elapsed time, observed effective concurrency, p50, p95, maximum duration, remaining trials, projected remaining seconds, and available seconds.

Do not automatically resume from `pause-capacity`.

## Submission replacement

Change provider run submission to launch the controller directly.

Target files:

- `src/harbor_hf/submission.py`
- `src/harbor_hf/cli.py`
- run submit tests
- command construction tests

Add:

```text
build_submit_run_controller_command()
submit_run_controller()
```

The submit command must:

- create the immutable run once;
- stage one content-addressed run input package containing the requested
  manifest, resolved benchmark source lock, run lock, and input manifest;
- stage or adopt a separate immutable benchmark bundle when the source request
  is an operator-local directory, as specified in
  `docs/benchmark-source-implementation-plan.md`;
- inspect exact labels before launch;
- reserve controller attempt 1;
- launch one detached Job;
- record ambiguous and successful launch outcomes;
- return run ID, physical Job ID, plan digest, input digest, and launch receipt.

For provider runs, remove calls to `build_submit_wave_command()` and `submit_wave()` from active execution. Keep direct wave submission only where the endpoint path still requires its distinct safety architecture.

A repeated submit must adopt the exact existing run and controller Job or fail on identity mismatch. It must never create a second run or controller because command output was lost.

## Watchdog replacement

Replace managed reconciliation automation with a shared controller watchdog.

Target files:

- `src/harbor_hf/automation.py`
- `src/harbor_hf/cli.py`
- watchdog application module
- automation and watchdog tests

The scheduled command becomes a watchdog command rather than `reconcile-all --apply`.

The watchdog must:

- list only explicitly approved run IDs;
- inspect controller status and exact Job labels;
- verify controller claim state;
- classify the prior controller outcome;
- verify the latest durable run checkpoint;
- check controller attempt count and provider policy;
- write an immutable recovery decision;
- launch one replacement from the exact original input and launch contract;
- adopt an ambiguously launched replacement by exact identity;
- do nothing when a controller is healthy, the run is terminal, or operator approval is required.

Schedule concurrency stays disabled. The webhook and schedule are shared by namespace. The watchdog never runs a trial or run reconciliation pass.

Add fault tests for stale status with a running Job, expired claim with an active Job, terminal Job with fresh status, duplicate scheduled invocations, launch timeout after remote creation, attempt exhaustion, capacity block, policy block, and malformed evidence.

## CLI and operator surface

Add or change these commands:

```text
harbor-hf run submit
harbor-hf run-controller
harbor-hf run status
harbor-hf run watchdog
harbor-hf automation install
```

Keep `run reconcile --dry-run` for diagnosis. Reject `run reconcile --apply` while an active provider controller owns the run.

Update help and JSON output so operators can see:

- controller Job and attempt IDs;
- ownership and heartbeat age;
- current internal wave;
- logical and physical execution counts;
- spend reservation;
- remaining-time admission;
- block reason;
- watchdog recovery eligibility;
- final completion gates.

Update the Harbor HF skill and references. Remove guidance that tells operators to keep a local reconciliation loop alive for provider runs.

## Historical and active runs

Do not change current run locks, events, Jobs, or evidence.

Before releasing the new provider runtime:

1. Let the existing provider runs finish or record their explicit terminal disposition under their pinned worker revision.
2. Disable the old managed reconciliation schedule after its approved run queue is terminal.
3. Release the new controller code and schemas together.
4. Use the new path only for newly created provider runs.
5. Keep old evidence auditable through its pinned source revision and retained files.
6. Remove the old provider wave-Job new-write path from current code.

Do not take over an in-flight old run with the new controller. Its immutable plan did not approve the new duration, controller, or recovery contract.

## Local test matrix

Add deterministic tests for:

- manifest and lock round trips;
- duration arithmetic and overflow;
- one-controller ownership;
- heartbeat renewal and loss;
- one internal wave and several sequential waves;
- 690 logical trials with six attempts per task;
- task names containing spaces, brackets, and literal deprecation labels;
- completed trial adoption after restart;
- lost active execution classification;
- infrastructure retry and backoff;
- no retry for agent, benchmark, verifier, timeout, refusal, or valid zero reward;
- spend reservation and exhaustion;
- provider concurrency and pacing;
- remaining-time admission;
- capacity and policy pause states;
- cancellation and drain;
- ambiguous action outcome;
- interrupted finalization with one valid execution;
- conflicting execution evidence;
- controller `SIGTERM` handling;
- duplicate watchdog invocations;
- immutable recovery attempt launch;
- final summary and result publication;
- secret redaction and generic secret scans.

Add a deterministic interrupted-and-resumed comparison. The resumed controller must select the same final logical outcomes as an uninterrupted reference and must not create another physical execution for completed trials.

## Repository quality gates

Run all repository requirements:

```text
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov=src/harbor_hf --cov-fail-under=85
uv run slophammer-py dry .
uv run slophammer-py check .
```

Also run:

- JSON Schema validation for every example;
- Schemator review and final graph diff;
- dependency audit;
- package build and metadata checks;
- documentation links and examples;
- a secret scan over staged Job input and retained evidence fixtures.

No suppression may hide a controller ownership, duplicate launch, retry classification, spend, remaining-time, evidence, or secret-safety failure.

## Remote canaries

Remote work needs a separate launch decision and cost record.

Run the canaries in this order:

1. **Construction canary:** controller validates input, acquires ownership, writes receipts and status, and exits before provider work.
2. **Transport canary:** one real trial verifies provider routing, judge routing, custom-agent identity, session, ATIF trajectory, workspace, checksums, and secret isolation.
3. **Multi-wave canary:** at least two internal waves finish inside one physical Job with no child Jobs.
4. **Kill and recovery canary:** kill the controller after at least two terminal trials and one active trial. Verify completed trials are adopted, the active execution is classified as lost, and exactly one replacement Job resumes.
5. **Duplicate canary:** start a second controller attempt deliberately and verify it exits before provider requests.
6. **Ambiguous launch canary:** simulate lost launch output and verify exact Job adoption.
7. **Capacity canary:** force observed throughput outside the lock and verify `paused-capacity` with no automatic continuation.
8. **Cancellation canary:** request cancellation during work and verify drain, route closure, evidence preservation, and terminal state.

Every canary must leave no active controller Job, route, or unowned resource. Retain Job inspections, logs, controller receipts, status revisions, run events, Bucket checksums, and secret scans.

## Production pilot

Repeat the incumbent evidence surfaces affected by the architecture change:

- provider-agent compatibility canaries;
- Alderbrook and BriarLane behavioral canaries;
- known-pass canary;
- representative production throughput pilot;
- session and ATIF validation;
- provider and judge ingress isolation;
- workspace freeze and screenshot manifest checks;
- finalization recovery;
- run artifact verification;
- known-secret and generic-pattern scans.

Use the exact target provider, model, agent, judge, concurrency, pacing, and task distribution. Recompute p50, p95, maximum trial duration, effective concurrency, finalization time, total duration bound, and low/high cost estimate.

The production candidate is eligible only when the full 690-trial initial workload fits one physical Job with the approved reserve. If the pilot cannot prove that bound, keep the current architecture for the affected workload while revising the proposal; do not claim that planned multi-attempt handoff is a one-Job design.

## Production acceptance

After explicit approval, run one representative 115-task by six-attempt provider run.

Verify:

- one controller Job in the normal path;
- zero child wave Jobs;
- exactly 690 logical trials;
- correct task and attempt distribution;
- bounded physical retries only for infrastructure;
- no duplicate completed trial execution;
- all provider and judge routes closed;
- complete private evidence and checksums;
- zero secret findings;
- final run status and summary;
- normalized publication receipt;
- no dependency on a local terminal or local monitor.

Treat any missing logical outcome, duplicate controller, child wave Job, unsafe retry, spend overrun, ambiguous evidence, secret finding, or local-liveness dependency as a release-blocking regression.

## Release sequence

1. Merge the Harbor HF implementation after local and schema review.
2. Publish the pinned worker revision and package artifacts.
3. Run the remote canary series.
4. Review measured duration, recovery, and cost evidence.
5. Obtain explicit production approval.
6. Run the representative full run.
7. Verify and publish its result.
8. Update `shellbench-local` generators and operating docs.
9. Stop creating provider wave Jobs and local monitor scripts.
10. Remove the superseded provider new-write code after the full run passes.

Use small coherent commits. Each commit must leave the current provider path internally consistent and tested.

## Stop conditions

Stop implementation or rollout when:

- the schema cannot express a reproducible duration bound;
- one full initial run cannot fit the physical Job timeout;
- provider concurrency or pacing changes from the approved profile;
- trial evidence cannot be committed before the recovery boundary;
- a completed trial is rerun after recovery;
- controller ownership permits two active writers;
- the watchdog cannot distinguish a stale controller from a live one;
- a replacement launch changes the immutable contract;
- observed cost or failure assumptions differ from approval;
- endpoint requirements are pulled into provider scope without a separate safety design;
- no defensible recovery path remains.

A blocked report must include the exact run and Job identities, immutable revisions, projection, latest durable trial checkpoint, attempted paths, failure evidence, spend state, and the next decision required.

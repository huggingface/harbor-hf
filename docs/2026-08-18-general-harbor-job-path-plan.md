---
title: General Harbor job path plan
author: Harbor-HF maintainers
date: 2026-08-18
tags: [harbor, jobs, campaigns]
---

# General Harbor job path plan

> **Historical record — superseded 2026-09-02.** This plan preserves the design
> and terminology reviewed at the time. Its imperative language is not current
> guidance for inference or harness support. New work follows
> [`CONTROL_SERVICE.md`](CONTROL_SERVICE.md) and Harbor-first direct inference.

**Status.** Superseded implementation record. Campaign and Sandbox references
below describe the pre-reset design and remain only as dated history. The
[control service specification](CONTROL_SERVICE.md) defines the current
Run-native, one-Job-per-attempt architecture.

Harbor-HF must not gain a new script or worker path for each benchmark, model,
or harness. Harbor already resolves those inputs. Harbor-HF must run the exact
resolved Harbor job on Hugging Face and apply the same security and budget
rules. Recovery, evidence and publication also use one shared path.

## Scope

This change replaces the task-specific work on the current branch with one
campaign path built around Harbor's `JobConfig` and `JobLock`.

The work includes:

- an isolated preparation Job that runs the pinned Harbor release without
  persistent secrets or inference access;
- an immutable prepared-job record linked to the exact Harbor lock;
- generic validation of tasks, images, resources and time limits, plus agent,
  model and verifier settings;
- execution workers that use the prepared lock instead of reading benchmark
  source files again;
- recovery that reuses the prepared lock;
- configuration-only support for Terminal-Bench 2.1, DeepSeek V4 Flash, and the
  selected Pi harness;
- removal or generalization of benchmark-specific executable code that remains
  in Harbor-HF.

## Non-goals

- Do not change Harbor core.
- Do not add a second control service or persistent resource.
- Do not add a compatibility campaign path.
- Do not run benchmark tasks or inference in the control Space.
- Do not make preparation output or private task evidence available to browsers.
- Do not delete historical campaign records or legacy remote resources.

## Campaign flow

1. The operator submits approved benchmark and model profiles together with
   the selected harness, deployment and launch-policy profiles.
2. The control service writes the campaign request, cost ceiling, profile
   identities, expected logical task locks, and a preparation action.
3. A secret-free preparation Job reads the campaign lock through a short-lived
   capability. It builds a normal Harbor `JobConfig` from the profiles and asks
   the pinned Harbor version to resolve a `JobLock` without running agents or
   verifiers.
4. The preparation Job uploads the exact Harbor lock as content-addressed
   private data. It submits a bounded prepared-job record with the lock digest
   and the task values needed for admission and Sandbox control.
5. The control service verifies the uploaded lock, prepared-job schema, expected
   task coverage, profile agreement, image digests, resource limits, and
   cumulative cost. It writes the prepared-job record immutably.
6. Only a verified prepared-job record can authorize execution. The reconciler
   launches the normal execution worker with a capability bound to the prepared
   lock digest and the still-missing logical tasks.
7. The execution worker loads the prepared lock, reconstructs each Harbor trial,
   and runs Harbor through the generic control-backed Sandbox environment.
   Harbor fetches the exact locked Git or package task without reading the
   benchmark dataset again.
8. Attempt receipts and evidence continue through the existing control path.
   The same path handles replacement admission, publication and cleanup.

A failed preparation Job can be adopted or retried within its small reserved
cost. Once a prepared-job record exists, no retry or replacement can prepare a
new lock for that campaign.

## Durable records

Add versioned JSON Schemas for these private records:

- `prepared.job`: exact Harbor version, resolved job config, job-lock header,
  ordered prepared-trial references, and the complete Harbor-lock digest;
- `prepared.trial`: logical task identity, source task identity and digest,
  trial number, exact Harbor trial lock, image digest, resources, and phase time
  limits.

The control service reconstructs the full Harbor lock from these private
content-addressed records. Browser collection responses omit them. Each
execution action records the prepared-job digest without changing the campaign
lock. Existing records are never rewritten.

Unknown fields are rejected. Local absolute paths, mutable Git references,
unpinned images, duplicate logical tasks, mismatched trial counts, and values
outside the selected deployment limits are rejected before execution.

## Profiles

Profiles remain reusable approval data:

- the benchmark profile selects a pinned Harbor dataset source and its tasks,
  including the trial count;
- the model profile selects the model ID, revision, provider behavior, and
  inference settings;
- the harness profile selects a versioned Harbor agent plugin with its settings;
- the deployment profile sets Hugging Face Job and Sandbox limits, credential
  policy, bridge limits, and generic worker commands;
- the launch policy sets preparation and execution reservations plus retry
  limits; and
- a promoted service capacity profile sets namespace and hardware Sandbox caps
  plus Sandbox start pacing.

The service capacity profile is not a campaign profile reference and does not
enter the campaign lock. Every Sandbox admission records the capacity profile
digest that authorized it. Deployment profiles do not contain task catalogs or
per-task image lists. Names are data and never select code branches.

The deployment fields have separate meanings. `worker_concurrency` bounds trial
futures in one worker. `sandbox_template.max_sandboxes` bounds active or
reserved Sandboxes for one campaign. `worker_max_tasks_per_job` bounds one Job's
assignment and recovery impact. `inference_max_concurrency` applies to one
Sandbox. `inference_max_total_concurrency` bounds provider request units across
one campaign. Budget admission remains under the launch policy and campaign
ceiling.

## Worker boundaries

The preparation worker:

- receives only a preparation capability;
- receives no `HF_TOKEN`, inference token, Bucket mount, or Sandbox authority;
- uses public APIs from the pinned Harbor release;
- uploads the exact lock and prepared-job records;
- exits without running an agent or verifier.

The execution worker:

- receives only an execution capability;
- receives no broad control credential or direct Bucket access;
- gets the prepared lock from the control service;
- sends the inference credential only to the root-owned Sandbox bridge through
  the control service;
- runs the selected Harbor agent plugin without name-based worker branches;
- accepts a complete attempt only after that plugin proves its final agent
  event;
- uploads content-addressed trial evidence before its attempt receipt.

PR #100 replaced fixed barrier batches with a bounded rolling scheduler. The
worker keeps at most `worker_concurrency` futures, waits for `FIRST_COMPLETED`,
and starts one queued task when a slot becomes free. This implementation and its
tests remain the scheduler baseline.

The remaining worker change is cooperative campaign cancellation through the
existing Harbor-HF control API. Once cancellation is visible, the worker stops
submitting tasks. Already running tasks continue through evidence upload and
Sandbox cleanup. A pre-receipt shared failure has the same stop-refill behavior.
The implementation does not patch Harbor internals or submit the whole task
assignment to an unbounded executor queue.

## Capacity admission

The control service owns Sandbox admission across workers and campaigns. It
uses the existing single-writer process, immutable Bucket, and disposable
projection. No queue service, database, Dataset, Bucket, or lease store is
added.

A create action is the durable queue entry. Admission follows this order:

1. Write or adopt the immutable create intent.
2. Write or adopt its campaign budget reservation.
3. Evaluate cancellation, campaign capacity, namespace capacity, hardware
   capacity, campaign provider units, start pacing, and budget.
4. Return `deferred` for a temporary limit or `rejected` for a permanent
   failure, with a stable reason code.
5. Write one immutable admission grant for an eligible action.
6. Write the existing dispatch fence before the Hugging Face adapter call.
7. Release capacity only after definitive no-resource failure or verified
   terminal Sandbox close.

The pure admission decision receives a projection snapshot and injected clock.
It does not call Hugging Face, Harbor, the filesystem, or process state. A
deferred action carries a factual next eligible time only when token refill can
supply one. Capacity with an unknown release time has no estimated wait.

The projection derives pending actions, active grants, hardware use, provider
units, token state, cleanup-held slots, and limiting reasons from immutable
records. A rebuild must produce the same state and fair order. Historical
Sandbox creates without grants count as active legacy reservations until a
verified terminal close or definitive no-resource failure releases them.

The start limiter is an integer token bucket stored through replayable grants.
A clock rollback adds no tokens. A capacity-profile promotion does not restore a
fresh burst. A lower profile blocks new grants and lets existing work drain.

Deferred creates remain FIFO within one campaign. The reconciler rotates among
campaigns when slots become available and keeps cleanup ahead of new work. Only
an admitted create reaches the Hugging Face adapter. Repeated submit, observe,
or recovery calls adopt the same intent, reservation, token charge, grant,
dispatch, and remote Sandbox.

The create API returns an existing resource or `202 Accepted` with an action
identifier, queue state, limiting reason, and factual retry time when known. The
worker observes the same action with bounded backoff. Polling creates no new
remote effect.

Operator API, events, and web pages show configured, used, available, queued,
cleanup-held, provider, pacing, and effective-capacity values. They also name
the active limiting reason. These views do not expose credentials, provider
bodies, private paths, or unnecessary remote topology.

## Agent terminal outcome

Each in-repository agent plugin owns validation of its agent's final event. The
Pi plugin reads the captured `message_end` events after the command finishes. It
requires a final assistant event and rejects `stopReason=error`, even when
previous turns used tokens or Harbor wrote an otherwise complete result.
Mounted and remote environments use the existing Harbor command result stream
for validation while `tee` retains the same `pi.txt` evidence.

The plugin passes a safe, stable failure class through Harbor's existing
`exception_info` field:

- an explicit `429` or `model_rate_limit` in the trailing assistant error events
  is a transient provider failure;
- authentication, quota, and unavailable-model signals are provider policy
  failures and take precedence;
- another provider error, or a missing or malformed final state, is a
  non-retryable terminal provider failure.

The campaign worker maps only the transient class to `infrastructure` with
replacement eligibility. It maps policy failures to `policy` and other terminal
provider failures to a non-retryable agent outcome. The launch policy remains
the only retry and cost authority. Raw provider bodies, credentials, request
identifiers, and private paths do not enter failure messages or public records.
The current `exception_info`, attempt outcome, and `replacement_eligible`
fields carry this contract without a second format or compatibility path.

## Existing specific code

The branch's `task_sandboxes` deployment field and benchmark source parsing are
removed. Their general Sandbox transport and evidence code can remain after it
is changed to consume prepared Harbor trials.

Remove the completed linked-aggregate staging script from the normal source
tree. Generalize the ShellBench repository type in the reassessment code so the
runtime does not require that benchmark name.

## Cost and recovery

Preparation has its own small CPU reservation. Execution reservation is checked
only after the exact prepared tasks and limits are known. Both reservations and
all replacements count against the same campaign ceiling. Sandbox use and
inference count too, as does cleanup.

A preparation failure cannot start benchmark execution. A deterministic shared
worker defect stops the affected campaign. A missing execution receipt can
launch only the tasks that remain unsealed, using the same prepared lock.

Sandbox capacity is reserved before remote create. Ambiguous create, failed
close, and uncertain cleanup keep that reservation. Cancellation closes active
Sandboxes before capacity release and stops the worker from filling more trial
slots. Budget admission remains fail-closed at every replay or recovery
boundary.

A post-dispatch `sandbox.exec` failure is different from a replayable transport
failure. The control operation becomes `failed` with observed state `AMBIGUOUS`
and error code `sandbox_external_outcome_unknown`. It has no result object and
the same action identity cannot execute again. `action.advanced` ends the
control action without claiming that the external command did not run.

A process exit can leave an older dispatch without a receipt. Infrastructure
retry settles it only after a matching create action and durable terminal
Sandbox close prove that the resource cannot produce another effect. Recovery
is limited to the selected campaign and task, checks that no result exists, and
appends the ambiguous receipt and advancement. Cancellation leaves a dispatched
command unresolved while it closes the Sandbox, then settles the command after
the close fence; it never suppresses the command as completed. Operator and
automatic infrastructure retries use the same recovery gate before reservation
or replacement launch. No command is replayed and no historical record is
changed.

An older release may already have written a completed/suppressed receipt for the
unknown command. That receipt remains immutable. A separate
`action.disposition` record binds the exact source receipt and one matching
advanced terminal close receipt by canonical digest. Its only allowed effective
state is `failed/AMBIGUOUS/sandbox_external_outcome_unknown`, with the fixed
historical ambiguity reason code.

The source receipt resource can be null in this fixed legacy class because the
old suppression writer omitted the observation. If it is non-null, it must
exactly equal the mandatory command intent resource. A conflicting non-null
value fails closed. One control-core predicate applies this rule during service
admission and projection replay. The intent, create receipt, and terminal close
intent and receipt must still identify the same resource in the same campaign
and task. The durable result must be absent, and the dispatch and advancements
must match.

Operators submit a bounded campaign and task batch through the authenticated
control service. The batch sorts and locks target actions, validates every item
before append, and carries a deterministic batch ID and digest. The same request
adopts a partial batch after a process exit. A changed action set, reason, or
proof conflicts. There is no automatic scan or backfill.

Projection keeps the recorded receipt and effective disposition separate. A
final integrity pass checks every proof after replay and keeps the service
unready on a mismatch or later result object. Correction changes no attempt,
selection, budget, publication, cleanup, or resource state and cannot authorize
execution. Sample acceptance remains a separate review.

## Verification

Local checks must prove:

- a synthetic second benchmark uses the same preparation and execution code;
- a second model and harness use the same code without new package scripts;
- preparation runs no agent, verifier, Sandbox, or inference request;
- the exact Harbor lock survives upload, restart replay, and execution fetch;
- changed source, task, image, profile, or Harbor version fails closed;
- duplicate preparation and ambiguous Job launch are adopted without a second
  remote create;
- the PR #100 scheduler refills one completed slot while other trials remain
  active and never exceeds `worker_concurrency`;
- visible campaign cancellation and pre-receipt shared failure stop later task
  submission while active evidence and cleanup finish;
- campaign, namespace, hardware, provider, start-rate, and budget limits remain
  independent and report the correct limiting reason;
- concurrent campaigns cannot exceed a limit or starve another eligible
  campaign;
- deferred create polling cannot duplicate intent, reservation, token charge,
  grant, dispatch, or remote Sandbox;
- interruption after every admission step adopts the same durable action after
  restart;
- projection rebuild reproduces grants, releases, token state, fair order,
  cleanup-held capacity, and conservative historical reservations;
- a post-dispatch Sandbox command exception writes no result, writes a safe
  failed and `AMBIGUOUS` receipt, advances the action, and returns a bounded
  `sandbox_action_ambiguous` error;
- the same Sandbox command key cannot call the adapter again after ambiguity,
  including after restart and projection rebuild;
- an older dispatched command can be settled only for the selected campaign and
  task after a matching terminal Sandbox close, and open or mismatched resources
  fail closed;
- retry and cancellation drain only close-fenced ambiguous commands and never
  scan another campaign;
- a historical disposition accepts a null source receipt resource only for the
  exact legacy state and only when the intent, create receipt, and advanced
  terminal close bind the same resource;
- a matching non-null source receipt resource remains valid, while a conflicting
  non-null value fails before append and during rebuild;
- service admission and projection replay use the same resource predicate;
- recorded and effective action states remain visible together after shuffled
  replay and an empty-filesystem rebuild;
- matching partial and concurrent correction batches adopt, while a changed
  action set, reason, or proof conflicts;
- a read-only preflight uses the exact deployed predicate on the private target
  set and rejects a synthetic conflicting non-null resource before any write;
- correction changes no lifecycle counter or record and cannot schedule a retry,
  publication, Job, Sandbox, or Endpoint action;
- retries cannot replace the prepared lock;
- task-specific resources come from Harbor and remain within deployment limits;
- capabilities separate preparation from execution and Sandbox operations;
- a normal final Pi stop succeeds, while a final zero-token provider error fails
  even after earlier nonzero token use;
- a trailing `429` followed by a generic provider error is retryable, while
  policy, unknown, missing, and malformed terminal states fail closed without
  automatic retry;
- mounted and remote Pi output paths retain evidence and run cleanup on every
  terminal class;
- the replacement benchmark profile contains only the invalid trial-1 task and
  excludes the sealed valid task;
- the diagnostic benchmark profile contains exactly the 89 trial-1 tuples from
  the official profile, in the same order;
- preparation, execution, `worker_revision`, and root bootstrap all pin the
  reviewed worker and exact file hashes;
- replacement and diagnostic launch policies require receipts, keep bounded
  attempts, publish as diagnostic evidence, and set the approved maximum
  campaign ceiling;
- a lower or exact requested ceiling is preserved, while an over-limit request
  fails before durable campaign state exists;
- historical profiles without a maximum remain readable;
- the six historical canary and official profile files remain unchanged;
- browser APIs omit lock contents and private paths together with topology and
  evidence references;
- budget reservation and partial-worker recovery remain correct, together with
  cancellation, publication and cleanup.

Run formatting, lint, type checks, unit and integration tests, generated-contract
checks, browser tests, audits and privacy checks. Run Slophammer and Pi Reviewer. Then
check PR comments and required CI before merge.

## Hosted checks

The worker repair is merged at
`422cf445ce04cfc8f331ddeebfd88f6bc2c5eae9`. Add a new profile family rather
than changing the historical canary or official five-trial profiles:

- `terminal-bench-2-1-replacement` contains only the invalid trial-1 task;
- `terminal-bench-2-1-diagnostic-1` contains the 89 trial-1 tuples from the
  official profile in the same order;
- `tb21-deepseek-v4-flash-replacement` runs one task;
- `tb21-deepseek-v4-flash-diagnostic-1` runs 89 tasks at concurrency eight;
- `tb21-replacement` and `tb21-diagnostic-1` require worker receipts, keep two
  preparation and infrastructure attempts, and publish as diagnostic evidence.

Both deployment profiles pin the merged worker in the package URLs,
`worker_revision`, and root bootstrap. Their bootstrap file hashes and canonical
profile IDs must reproduce. Profile reservations follow the existing per-action
budget rules.

The replacement launch policy sets `max_campaign_ceiling_microusd` to
180,000,000. The diagnostic launch policy sets it to 300,000,000. The service
resolves that policy before it writes campaign state and rejects a larger
requested ceiling. A lower or exact requested ceiling is stored unchanged and
remains the cumulative runtime budget. The maximum is optional only for reading
historical profiles. Both new policies require it.

Deploy the exact merged profile revision to the existing control Space without
changing its resources, credentials, hardware, storage, or visibility. Verify
the source revision, all new aliases and immutable profile IDs, worker pin,
write mode, projection integrity, and approved resource contract.

Run one secret-free preparation canary, then one bounded execution and recovery
canary. For the provider-error repair, the replacement canary contains only the
previously invalid logical task. Keep the earlier valid canary task sealed and
unchanged. The replacement must end with a successful final Pi event, nonzero
input and output tokens, exact model and provider evidence, credential
isolation, valid content-addressed evidence, publication, Sandbox close, budget
reconciliation, and no active Endpoint. Retry only an eligible transient
physical attempt within the locked attempt and cost limits.

If a post-dispatch Sandbox command response is lost, the related physical
attempt is invalid infrastructure evidence. Operator-specific incident
identities, counts, spend, and attempt state stay in the private launch record.
The failed attempt, evidence, spend, and consumed attempt count remain
immutable.

Paid work stops until both historical receipt states and the selected sample are
reviewed. Deploy the exact disposition release to the existing control Space
without changing resources. Verify source, readiness, writes, projection,
profiles, Bucket privacy, zero running Jobs, and zero active Endpoint replicas.
Then prepare one private batch from durable receipt and close evidence and submit
it once. Rebuild from the Bucket and prove that recorded receipts remain
completed/suppressed while effective states are failed/AMBIGUOUS. Campaign,
attempt, selection, reward, publication, spend, cleanup, Job, Sandbox, and
Endpoint state must remain unchanged.

No replacement attempt remains. Do not unseal or rerun the task and do not create
another replacement campaign. Run a separate read-only acceptance review for
the existing selected attempt. Check its final Pi event, tokens, provider and
worker provenance, credential isolation, evidence hashes, benchmark-timeout and
reward, diagnostic publication, cost, close, Jobs, Sandboxes, and Endpoints. The
correction itself does not make the sample valid.

Only after that review passes, use the preserved valid sample and the accepted
replacement sample for a private measured launch review. Record raw duration,
token, cost, and reward values, and label any p50 or p95 value with its sample
count. Include setup, bounded retries, and cleanup in the high estimate. Apply
the practical-significance and paid-compute gates. The hosted control plane must
admit the worst-case next action within the approved cumulative ceiling before
launch. If the sample review fails, stop because no third attempt or replacement
campaign is authorized.

The current Terminal-Bench 2.1 run has exactly 89 logical tasks and one trial
per task. Its benchmark profile is the exact trial-1 projection of the official
source-task set. Its launch policy labels the run as diagnostic. The historical
canary and official five-trial profiles remain unchanged. Submit the diagnostic
campaign once through the existing control API and use the existing Bucket for
control and evidence. The result is single-trial diagnostic evidence and does
not make an official five-trial or production-selection claim.

Monitor every attempt, evidence manifest, result, spend event, publication,
cleanup receipt, Sandbox, and Endpoint. Never rerun a sealed valid logical task.
A shared deterministic defect stops affected work. Policy, provenance,
credential, budget, or cleanup failures stop the campaign instead of changing
the protected contract.

## Fresh diagnostic rerun

The earlier single-trial diagnostic remains immutable evidence. Sealing a task is
not enough when its selected receipt has zero required tokens. The control service
must derive the old publication as invalid until an append-only supersession record
points to a later valid publication. It must not edit the old campaign, attempts,
result objects, receipt, or catalog.

The selected recovery is a new full 89-task campaign from the same prepared Harbor
workload, not a task repair inside the old campaign. This is an explicit exception
to the normal rule against rerunning a valid logical task. The exception applies
only to this separately approved fresh campaign because it must produce one
homogeneous result and test the corrected parallel scheduler. It does not authorize
retries in the old campaign.

Keep the benchmark and model revisions, Pi 0.84.2 with high reasoning, provider
route, hardware, task inputs, timeouts, one trial per task, and credentials unchanged.
Pin and record the new reviewed Harbor-HF implementation revision separately. The
new run remains diagnostic and cannot support a model-promotion or official
five-trial claim.

The worker uses concurrency eight and the rolling sliding window. Sandbox admission
must permit eight active tasks for the campaign. When one task becomes durable and a
pending task remains, the worker fills the free slot without waiting for the other
active tasks. Verify refill through normal control actions and Sandbox state. Do not
add a monitoring-only API or schema.

Use the first admitted task as the real paid pause-resume canary if the final control
contract can preserve the same logical campaign. The task must write a positive-token
receipt before pause. Pause stops new admission, lets active work reach durable
boundaries, closes Sandboxes, and ends the Job. Resume schedules only unresolved
tasks. If that proof is unavailable or fails, stop before the full ramp.

Every selected attempt must have finite positive input and output token counts.
Evidence validity, rather than the worker outcome name, controls bounded replacement.
If an invalid task exhausts its attempt, reservation, or campaign limit, record
exhaustion and fail the campaign without selection or publication. A deterministic
shared defect stops new admission for affected work.

Update the private launch review before paid work. Verify current prices, the locked
hardware, measured low and high costs, cheaper choices, the reservation envelope,
and the worst-case next action. The 300,000,000 microusd ceiling applies only when a
durable authorization covers this new campaign and the control service admits every
action within it. Keep private cost and campaign records out of public Git.

Publication requires exactly 89 selected valid receipts, complete normalized
coverage, matching provenance, no pending action or cleanup, and verified immutable
objects. Write and read back result and receipt evidence before the catalog becomes
visible. After the new publication commits, append one supersession record for the
old degraded publication. Keep both publications directly auditable.

## Completion criteria

The work is complete when:

- no benchmark-specific profile generator exists;
- production control and generic worker code has no benchmark, model, or
  harness name branch; individual Harbor agent plugins may name the harness
  they implement;
- a new Harbor-supported benchmark or compatible model needs configuration only;
- a supported harness needs configuration only, while a new harness needs only
  a Harbor agent plugin;
- every campaign execution is bound to one verified Harbor lock;
- the merged implementation is deployed and verified through hosted canaries;
- reviewed historical dispositions preserve original receipts, expose effective
  ambiguity, rebuild cleanly, and change no lifecycle state;
- the existing provider-error replacement sample passes the separate final Pi,
  token, provenance, evidence, isolation, publication, cost, and cleanup review;
- the fresh 89-task, one-trial Terminal-Bench 2.1 diagnostic campaign is
  complete and published without a five-trial claim;
- all 89 logical tasks have one selected receipt with finite positive input and
  output tokens;
- the first-task pause-resume canary preserves its durable receipt and resumes
  only unresolved tasks;
- worker concurrency eight refills free slots while pending tasks and admitted
  Sandbox capacity remain;
- normalized rows, provenance, publication receipts, and catalog objects verify
  before append-only supersession marks the old publication as superseded;
- no action or cleanup is pending, cumulative spend is within the enforced
  ceiling, all campaign Sandboxes and Jobs are closed, and every campaign-owned
  Endpoint is paused with zero ready replicas;
- every new Sandbox create has one durable admission grant before dispatch;
- write-enabled startup requires a reviewed promoted capacity profile, while
  read-only historical replay remains available without one;
- namespace and campaign status explain whether worker slots, Sandbox capacity,
  hardware capacity, provider capacity, start pacing, budget, cancellation, or
  cleanup limits work; and
- generated contracts, Python and TypeScript checks, coverage, Slophammer, dry
  checks, focused regression tests, Pi Reviewer, browser tests, and relevant
  pull-request CI pass before merge.

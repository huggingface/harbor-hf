---
title: General Harbor job path plan
author: Harbor-HF maintainers
date: 2026-08-18
tags: [harbor, jobs, campaigns]
---

# General Harbor job path plan

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
  limits.

Deployment profiles do not contain task catalogs or per-task image lists.
Names are data and never select code branches.

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

A post-dispatch `sandbox.exec` failure is different from a replayable transport
failure. The control operation becomes `failed` with observed state `AMBIGUOUS`
and error code `sandbox_external_outcome_unknown`. It has no result object and
the same action identity cannot execute again. `action.advanced` ends the
control action without claiming that the external command did not run.

A process exit can leave an older dispatch without a receipt. Infrastructure
retry settles it only after a matching create action and durable terminal
Sandbox close prove that the resource cannot produce another effect. Recovery
is limited to the selected campaign and task, checks that no result exists, and
appends the ambiguous receipt and advancement. Cancellation uses the same rule
for close-fenced actions and leaves open resources on the normal cleanup path.
No command is replayed and no historical record is changed.

## Verification

Local checks must prove:

- a synthetic second benchmark uses the same preparation and execution code;
- a second model and harness use the same code without new package scripts;
- preparation runs no agent, verifier, Sandbox, or inference request;
- the exact Harbor lock survives upload, restart replay, and execution fetch;
- changed source, task, image, profile, or Harbor version fails closed;
- duplicate preparation and ambiguous Job launch are adopted without a second
  remote create;
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

The first replacement physical attempt is invalid infrastructure evidence. A
safe Sandbox API error during inference-bridge shutdown left at least seven
dispatched command actions without receipts. The Sandbox later closed with a
terminal CANCELED state, but the campaign remains at zero of one terminal tasks
with nine pending actions, 10,167 microusd observed, and no publication. The
attempt and spend remain immutable and consume one of the two allowed
infrastructure attempts.

Paid work stops until a reviewed control-only repair makes new post-dispatch
errors terminally ambiguous and lets the existing retry operation settle the
close-fenced commands. The control release must pass source, readiness, write,
projection, resource, profile, and zero-Endpoint checks before recovery. The
existing retry operation may then create physical attempt 2 for the same
unsealed task. It cannot reset spend, change the lock, or run the sealed valid
canary task. A repeated control failure stops the campaign without a third
execution.

Use the preserved valid sample and the valid replacement sample for a private
measured launch review. Record raw duration, token, cost, and reward values, and
label any p50 or p95 value with its sample count. Include setup, bounded retries,
and cleanup in the high estimate. The hosted control plane must admit the
worst-case next action within the approved cumulative ceiling before launch.

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
- the provider-error replacement canary reruns only the invalid task and proves
  a successful final Pi event, evidence, isolation, publication, and cleanup;
- the 89-task, one-trial Terminal-Bench 2.1 diagnostic campaign is complete and
  published without a five-trial claim;
- all 89 logical tasks are sealed, no action or cleanup is pending, cumulative
  spend is within the enforced ceiling, all Sandboxes are closed, and every
  owned Endpoint is paused with zero ready replicas.

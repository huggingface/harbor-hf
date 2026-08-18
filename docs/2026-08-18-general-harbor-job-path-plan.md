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
   and runs Harbor through the generic control-backed Sandbox environment. It
   does not clone or parse the benchmark source again.
8. Attempt receipts and evidence continue through the existing control path.
   The same path handles replacement admission, publication and cleanup.

A failed preparation Job can be adopted or retried within its small reserved
cost. Once a prepared-job record exists, no retry or replacement can prepare a
new lock for that campaign.

## Durable records

Add versioned JSON Schemas for these private records:

- `prepared-job.manifest`: exact Harbor version, job-config digest, Harbor-lock
  digest, artifact manifest, expected profile identities, and preparation
  action binding;
- `prepared-job.trial`: logical task identity, source task identity and digest,
  trial number, Harbor trial-lock digest, image digest, resources, time limits,
  and verifier mode.

The full Harbor lock is stored as content-addressed private data. Browser
collection responses omit it. The campaign lock records the
prepared-job manifest digest after preparation through a separate immutable
record. Existing records are never rewritten.

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
- uploads content-addressed trial evidence before its attempt receipt.

## Existing specific code

The branch's `task_sandboxes` deployment field and benchmark source parsing are
removed. Their general Sandbox transport and evidence code can remain after it
is changed to consume prepared Harbor trials.

Remove the completed linked-aggregate staging script from the normal source
tree. Generalize the ShellBench repository type in the reassessment code so the
runtime does not require that benchmark name.

## Cost and recovery

Preparation has its own small CPU reservation. Execution reservation is checked
only after the exact prepared tasks and limits are known. Both reservations and all replacements count against the same campaign
ceiling. Sandbox use and inference count too, as does cleanup.

A preparation failure cannot start benchmark execution. A deterministic shared
worker defect stops the affected campaign. A missing execution receipt can
launch only the tasks that remain unsealed, using the same prepared lock.

## Verification

Local checks must prove:

- a synthetic second benchmark uses the same preparation and execution code;
- a second model and harness use the same code without new package scripts;
- preparation runs no agent, verifier, Sandbox, or inference request;
- the exact Harbor lock survives upload, restart replay, and execution fetch;
- changed source, task, image, profile, or Harbor version fails closed;
- duplicate preparation and ambiguous Job launch are adopted without a second
  remote create;
- retries cannot replace the prepared lock;
- task-specific resources come from Harbor and remain within deployment limits;
- capabilities separate preparation from execution and Sandbox operations;
- browser APIs omit lock contents and private paths together with topology and
  evidence references;
- budget reservation and partial-worker recovery remain correct, together with
  cancellation, publication and cleanup.

Run formatting, lint, type checks, unit and integration tests, generated-contract
checks, browser tests, audits and privacy checks. Run Slophammer and Pi Reviewer. Then
check PR comments and required CI before merge.

## Hosted checks

After merge, deploy the exact revision with production writes disabled. Run one
secret-free preparation canary, then one bounded execution and recovery canary.
Verify exact lock reuse, credential isolation, Sandbox close, durable evidence,
budget reconciliation, and endpoint cleanup.

Only after these checks pass can the approved Terminal-Bench 2.1 campaign be
submitted. The campaign uses configuration and immutable data only. Its full
five-trial run starts only when the measured canary and enforced control-plane
ceiling keep total project spending within the approved limit.

## Completion criteria

The work is complete when:

- no benchmark-specific profile generator exists;
- production control and worker code has no Terminal-Bench, ShellBench,
  DeepSeek, Qwen, Pi, Hermes, or OpenClaw name branch;
- a new Harbor-supported benchmark or compatible model needs configuration only;
- a supported harness needs configuration only, while a new harness needs only
  a Harbor agent plugin;
- every campaign execution is bound to one verified Harbor lock;
- the merged implementation is deployed and verified through hosted canaries;
- the requested Terminal-Bench 2.1 campaign is complete and published, with
  cleanup verified within its enforced ceiling.

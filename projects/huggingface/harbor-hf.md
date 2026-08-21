---
schema_version: v1
slug: huggingface/harbor-hf
repository: https://github.com/huggingface/harbor-hf
default_branch: main
---

# Harbor-HF

## Current authorization

Status: approved
Approved at: 2026-08-17T06:48:55Z
Amended at: 2026-08-17T09:13:49Z
Inference-token amendment approved at: 2026-08-17T15:37:46Z
Sandbox-lifecycle amendment approved at: 2026-08-17T18:39:15Z
Finalization amendment approved at: 2026-08-18T00:25:01Z
Terminal-Bench 2.1 amendment approved at: 2026-08-18T10:40:26Z
Terminal-Bench 2.1 USD 300 campaign-ceiling amendment approved at: 2026-08-18T17:20:36Z
Canonical-Bucket amendment approved at: 2026-08-20T13:53:14Z
Canonical-Space replacement amendment approved at: 2026-08-20T14:01:49Z
Terminal-Bench 2.1 single-trial diagnostic amendment approved at: 2026-08-20T19:21:55Z
Production-writes amendment approved at: 2026-08-21T10:31:00Z
README authentication amendment approved at: 2026-08-19T20:34:26Z
Installer amendment approved at: 2026-08-19T21:19:35Z
Installer diagnostic-apply amendment approved at: 2026-08-20T14:07:53Z
Installer autonomous-diagnostic amendment approved at: 2026-08-20T14:25:07Z
Installer phase-two recovery amendment approved at: 2026-08-20T15:26:21Z
Installer empty-bootstrap reset amendment approved at: 2026-08-20T15:37:03Z
Installer source-staged retry amendment approved at: 2026-08-20T17:29:22Z
Installer bounded-completion amendment approved at: 2026-08-20T17:38:24Z
Installer activation-command amendment approved at: 2026-08-20T19:07:58Z
Installer runbook amendment approved: 2026-08-19
Installer lifecycle simplification approved: 2026-08-19
Upstream merge amendment approved: 2026-08-19
Installer credential-and-lock hardening approved: 2026-08-19
Installer scope-and-source hardening approved: 2026-08-19
Installer subprocess-and-phase hardening approved: 2026-08-19
Installer inference-scope hardening approved: 2026-08-19
Installer probe-and-state-path hardening approved: 2026-08-19
Installer redundant-confirmation removal approved: 2026-08-19
Installer bearer-variable simplification approved: 2026-08-19
Upstream safe-integration amendment approved: 2026-08-19
Leaderboard-snapshot amendment approved at: 2026-08-21T20:06:00Z
Harness-integration amendment approved at: 2026-08-21T23:01:07Z

### Scope

- Add the project-authorization skill and this repository-indexed project file through the normal contribution workflow.
- Finish deployment and hard cutover of the hosted TypeScript control service described by the approved control-service plan.
- Install the retained purpose-scoped service credential as the control Space's `HF_TOKEN` control secret.
- Run the hosted no-inference recovery and cutover canaries, plus only bounded paid canaries required by the approved plan.
- Promote the verified historical migration and enable production writes only after every required gate passes.
- Audit legacy consumers and unique objects before proposing any resource retirement.
- Make the existing control Space publicly reachable only after adding and verifying application-layer protection for operator, browser, and worker routes.
- Admit workers with short-lived, signed, campaign-scoped control capabilities.
- Install a separate, regularly rotated, inference-only Hugging Face credential in the existing control Space and pass it only to reviewed benchmark workers as `HF_INFERENCE_TOKEN`.
- Extend signed worker capabilities to exact Hugging Face Sandbox lifecycle operations performed by the control Space for an immutable campaign task.
- Prepare and run the requested Terminal-Bench 3 campaign for the locked model in low adaptive-thinking mode after the bounded paid canary and launch-review gates pass.
- Prepare and run Terminal-Bench 2.1 at revision `d49e28f1e4ddd13d289e85a5f312a66750951932` with `deepseek-ai/DeepSeek-V4-Flash-0731` at revision `7872f01b1d1fe23eabc4c98b48bffcef5a386062`, the reviewed Pi 0.84.2 worker, and high reasoning. The current approved campaign is a single-trial diagnostic run with one trial for each of the 89 tasks. The official five-trial protocol is outside the current run and needs a separate later decision.
- Migrate the remaining active ShellBench result catalog, verify parity, replace the legacy results viewer, and perform the hard cutover without deleting legacy resources.
- Create one private canonical `<artifact-bucket>` in the selected namespace because no existing canonical Bucket is available, then deploy the exact reviewed control-service revision to the existing canonical `<control-space>`.
- Create one private canonical replacement `<control-space>` in the selected namespace because the previous Space no longer exists, then deploy the exact reviewed control-service revision with writes disabled.
- Enable production writes on the hosted control Space so operators can submit any promoted-profile campaign, not only the built-in control-smoke canary.
- Restart the failed no-inference control-smoke as an infrastructure replacement after protected public ingress.
- Research the minimum permissions required by the local CLI control bearer token and update the README to describe the explicit `HARBOR_HF_CONTROL_BEARER_TOKEN` authentication flow accurately.
- Add deterministic plan, apply, and verify npm commands for provisioning and adopting the canonical control Space and artifact Bucket, uploading an exact control release, configuring disabled-write deployment variables and required secrets safely, and verifying the hosted installation.
- Run one controlled phase-one installer apply against the operator-selected existing bootstrap to capture the sanitized provider failure category or complete creation of its canonical private Bucket and local ownership receipt.
- Diagnose and complete phase one for the operator-selected installer test bootstrap autonomously, using the active local write-capable Hugging Face credential for bounded plan/apply retries and direct Bucket probes.
- Complete one bounded phase-two recovery for the operator-selected installer test bootstrap using its exact prior private plan and existing remote credential names.
- Reset the operator-selected test bootstrap after confirming that its marked Space is absent and its remaining private Bucket is empty, then recreate phase one.
- Complete one bounded source-staged retry after the operator installed both expected credential names interactively.
- Diagnose and complete the operator-selected installer test bootstrap autonomously within its existing two-resource, free-hardware boundary.
- Add guarded installer commands for canary activation, production promotion, and emergency write disablement.
- Expand the README with an agent-oriented hosted-installation runbook and execution model that distinguishes the local npm installer, local Python operator CLI, hosted control service, reconciler, and remote workers.
- Replace the implicit two-pass apply and installer canary workflow with explicit provision, configure, verify, activate, and emergency-disable commands. Activation enables the inspected installation without changing hardware, transferring credentials, or embedding benchmark, model, or harness names in runtime policy.
- Fetch the canonical upstream default branch, preview and merge it into the current local topic branch, resolve any conflicts without discarding either side's intended behavior, and verify the integrated tree.
- Harden installer credential acceptance with a fresh exact-Bucket create/read-back probe before storing a proposed control credential, and make owner-only installer operation locks safely reclaimable after confirmed process death or host reboot.
- Require exact non-mutating fine-grained scope attestation before storing a proposed control credential, make source-staged recovery stop on receipt/Space SHA drift without overwriting attested source, and remove credential checks that enumerate durable control records.
- Remove installer credentials from advisory-lock subprocesses, make resources-only provisioning reject any bootstrap where configuration has started, and serialize verification with all per-target installer operations.
- Require the existing non-mutating inference-only scope attestation before the installer persists an initial or replacement inference credential.
- Bound installer Bucket probe HTTP exchanges by inactivity and streamed bytes, and reject state roots that resolve inside the source checkout before creating lock or state files.
- Remove the redundant `--confirm-space` argument from installer activation and disablement while preserving exact target-bound plans and all existing preflight, verification, and rollback protections.
- Use `HARBOR_HF_CONTROL_BEARER_TOKEN` directly for installer authenticated verification and activation instead of requiring the redundant `HARBOR_HF_INSTALL_VERIFY_BEARER` alias.
- Merge the canonical upstream default branch locally while preserving the hardened installer, replace benchmark-specific web launch-policy routing with promoted-profile selection, and bound and redact streamed Harbor output before provider logs and evidence.
- Add a leaderboard snapshot in the existing canonical `<artifact-bucket>`: a configuration digest, mechanical eligibility, and a derived SQLite file of the rows shown on the board. Keep one Space and one Bucket. Do not add an anonymous public leaderboard route until a later amendment.
- Integrate the requested dashboard harnesses as Harbor agent plugins behind the existing campaign path: OpenCode, Qwen Code, mini-swe-agent, Pi, Kimi Code, Hermes, Codex, OpenHands, OpenClaw, and Claude Code. Prove each with one Terminal-Bench 2.1 two-task canary. Reject a harness that needs a native API the locked Hugging Face router route cannot preserve.

### Limits

- Deploy an exact merged source revision with writes disabled first.
- Use `cpu-upgrade` at USD 0.03 per active hour for the always-on control service.
- Keep total project spend within USD 300. This includes campaign, recovery, provider and endpoint costs plus the control service.
- For the next Terminal-Bench 2.1 production campaign, use the later explicitly approved USD 300 hard campaign ceiling. This campaign-specific amendment supersedes the preceding cumulative limit for that campaign only. Preserve and report all earlier spend separately.
- Do not create another persistent Space, Bucket, repository, Dataset, schedule, credential beyond the approved inference credential, lease store, status store, backup store, or result store.
- The 2026-08-20 amendment permits exactly one new private canonical `<artifact-bucket>` in the selected namespace. It does not permit another Space, Bucket, repository, Dataset, schedule, credential, or result store.
- The later 2026-08-20 replacement amendment permits exactly one new private canonical `<control-space>` in the selected namespace. It does not permit an additional Space or any other persistent resource.
- Do not rerun valid logical tasks or use inference during migration and publication recovery.
- Keep credential values, private resource identifiers, operator paths, and private topology out of Git and browsers. Do not expose credentials in logs or evidence; the approved inference credential may appear only in the trusted worker or root-owned inference bridge environment.
- Do not delete or retire a legacy resource without its completed private audit and a separate explicit approval for that resource.
- Anonymous callers may reach only bounded public surfaces such as static application assets, login initiation, OAuth return handling, and health checks. Control data and operator mutations remain deny-by-default.
- Add bounded request-body and anonymous request-rate controls before changing Space visibility. If hosted denial, capability, or abuse-control verification fails, restore private visibility, disable writes, and stop.
- Keep exactly two operator-managed Space secrets: the control credential `HF_TOKEN` and the inference-only `HF_INFERENCE_TOKEN`.
- Workers must never receive `HF_TOKEN`. They may receive only `HF_INFERENCE_TOKEN`, whose permissions are limited to serverless and Endpoint inference calls.
- Pin each worker image and command, enforce the locked model, route, token, request, concurrency, timeout, and cost limits in the worker bridge, and rotate the inference credential regularly. Revoke the prior credential only after every Job using it is terminal.
- Bind every Sandbox operation to the immutable campaign lock, launch action, task, expiration, approved image, hardware, paths, transfer limits, timeouts, and budget. Record fenced lifecycle receipts and do not expose a general Hugging Face API proxy.
- Keep `HF_TOKEN` in the control Space. Never pass it to a worker or Sandbox. The control Space may derive and use a per-Sandbox credential only inside its trusted process while handling an authorized lifecycle operation.
- Keep the first Terminal-Bench canary below USD 5. Treat the full campaign as substantial paid compute: measure throughput and cost first, preserve durable partial evidence, prove pause and resume, and obtain explicit approval for the exact trial count, concurrency, hardware, and hard cost ceiling before launch.
- For the approved Terminal-Bench 2.1 campaign, use one bounded representative canary and then continue without another conversational prompt only when the hosted control plane admits the measured worst-case cost for 89 tasks and five trials under the existing USD 300 total project limit. Count setup, canaries, retries, recovery, and cleanup. Allow only infrastructure replacements; never rerun a terminal semantic outcome.
- Production writes admit any promoted-profile campaign through the existing control path. They do not raise the spend ceiling, add persistent resources, or authorize rerunning a terminal semantic outcome.
- Limit the README authentication amendment to documentation and its authorization metadata. Do not push, open a pull request, deploy, spend, transfer or expose credentials, or change runtime behavior.
- Limit the installer amendment to implementation, tests, and terse README pointers. Do not execute a remote apply, create or alter remote resources, move credentials, incur cost, push, or open a pull request. Preserve unrelated worktree and index changes.
- Limit installer scope-and-source hardening to local implementation, tests, documentation, and commits. Do not use real credentials, run hosted probes or installer remote commands, mutate resources, activate writes, incur cost, push, or open a pull request.
- Limit installer subprocess-and-phase hardening to local implementation, tests, documentation, and commits. Do not use real credentials, run installer remote commands, mutate hosted resources, activate writes, incur cost, push, or open a pull request.
- Limit installer inference-scope hardening to local implementation, tests, documentation, and commits. Do not use real credentials, call hosted APIs, run installer remote commands, mutate resources, activate writes, incur cost, push, or open a pull request.
- Limit installer probe-and-state-path hardening to local implementation, tests, documentation, and commits. Do not use real credentials, call hosted APIs, run installer remote commands, mutate resources, activate writes, incur cost, push, or open a pull request.
- Limit installer redundant-confirmation removal to local implementation, tests, documentation, and commits. Do not use real credentials, call hosted APIs, run installer remote commands, mutate resources, activate or disable writes, incur cost, push, or open a pull request.
- Limit installer bearer-variable simplification to local implementation, tests, documentation, and commits. Do not use real credentials, call hosted APIs, run installer remote commands, mutate resources, activate writes, incur cost, push, or open a pull request.
- Limit the upstream safe integration to local merge resolution, bounded implementation fixes, generated artifacts, tests, documentation, and commits. Preserve both sides' intended general behavior, use no real credentials, call no hosted APIs, run no installer remote commands, mutate no resources, incur no cost, and do not push or open a pull request.
- Limit the installer diagnostic apply to the existing protected, free-hardware bootstrap and its canonical private Bucket. Do not upload application source, prompt for or move service credentials, activate writes, create any other resource, incur paid compute, push, or open a pull request. Stop after the phase-one result or first failure.
- Limit autonomous installer diagnosis to the selected protected, free-hardware test Space and its one empty private test Bucket. Direct probes may create and, when required for deterministic recovery, delete only that empty test Bucket. Do not upload application source, read or move service credentials, activate writes, use paid hardware, mutate unrelated resources, push, or open a pull request. Stop after phase one succeeds or a concrete provider defect is isolated.
- Limit the phase-two recovery to re-uploading the exact previously planned source, adopting only the already-present expected secret names without reading or rewriting credential values, setting the installed phase, restarting on free hardware, and running verification with writes disabled. Create no resources, use no paid hardware, pause on failure, and do not push or open a pull request. This one recovery supersedes the earlier source-upload prohibition only for these exact actions.
- Limit the empty-bootstrap reset to deleting the one verified-empty private test Bucket after rechecking that the marked Space remains absent, quarantining rather than deleting its stale owner-only local installer state, and running fresh plan plus phase-one apply for the same protected `cpu-basic` Space and private Bucket. Do not upload source, prompt for or move credentials, use paid hardware, push, or open a pull request. Stop after phase one succeeds or the first failure.
- Limit the source-staged retry to adopting the already-present expected credential names without reading or rewriting values, re-uploading the exact saved source, setting the installed phase, restarting on free hardware, and running verification with writes disabled. Record only redacted command stages, pause on failure, create no resources, use no paid hardware, and do not push or open a pull request. Stop after success or the first failure.
- Limit autonomous completion to the selected test Space and its existing private Bucket on `cpu-basic`, using the active local write-capable credential and the two already-installed expected secret names. Allow bounded status and log probes, exact-source uploads, managed-variable transitions, restarts, pauses, verification, and implementation fixes required to reach a verified installed state with writes disabled. Do not read, copy, replace, or expose credential values; create no additional resources; use no paid hardware; mutate no unrelated resource; and do not push or open a pull request.
- Limit the activation-command amendment to implementation, tests, and documentation. Require exact installed bindings, authenticated system verification, explicit target confirmation, disabled-to-canary staging, evidence-gated canary-to-enabled promotion, explicit paid-hardware approval, fail-closed rollback, and emergency return to disabled writes. Do not activate or promote a hosted Space, change remote hardware, incur cost, move credentials, push, or open a pull request while implementing it.
- Limit the installer-runbook amendment to public documentation and documentation checks. Use only placeholders, include explicit agent stop conditions, and do not run installer or hosted commands, handle credentials, mutate resources, spend, push, or open a pull request.
- Limit the installer-lifecycle simplification to local implementation, tests, and documentation. Preserve fail-closed recovery and exact source/resource verification. Do not run installer commands against hosted resources, transfer credentials, change hardware, spend, push, or open a pull request.
- Limit the upstream-merge amendment to local Git integration and verification. Inspect the complete merge diff and public metadata, preserve public privacy, and do not push, open a pull request, merge into the upstream default branch, mutate hosted resources, handle credentials, or incur cost.
- Limit the installer credential-and-lock hardening to local implementation, tests, and documentation. Probe objects must contain no credential-derived or operator-specific data and use one stable installer prefix. Lock records remain owner-only and local. Do not run hosted probes, installer commands, credential operations, push, or a pull request.
- The configuration digest hashes benchmark identity, model identity, harness identity, trial count, reasoning effort, inference provider, and Harbor version from the campaign lock. It excludes worker revision, Job IDs, and cost.
- Only `publication_role=final`, quality `clean`, fully scored campaigns enter the leaderboard snapshot. Diagnostic, cancelled, mixed, and policy-failed catalogs stay private candidate material.
- Store each snapshot as an immutable SQLite object under the existing results prefix. Do not create another Bucket, Dataset, Space, or result service. Anonymous leaderboard HTTP access is outside this amendment.
- The harness-integration series uses `terminal-bench-2-1-canary`, `openai/gpt-oss-20b` on Together, reasoning off, and publication role diagnostic. Hard ceiling USD 80 for the whole series, including retries. This does not authorize the 89-task diagnostic or the official five-trial protocol.

### Remaining gates

No project-scope amendment remains pending. Operational gates still apply:

- Do not retire the legacy results viewer or stores until catalog parity is verified. No deletion is authorized.
- Keep each substantial paid campaign behind its measured launch review and exact enforced cost ceiling.
- Keep the harness-integration canary series inside the USD 80 hard ceiling. Reject a harness that needs a native API the locked router route cannot preserve.

## Approval history

### 2026-08-17

- Approved the current scope and limits before the remaining project work starts.
- Directed the project to keep one authorization file indexed by canonical repository slug and to record approvals here.
- At 2026-08-17T09:13:49Z, approved protected public ingress for the existing control Space so workers can use short-lived capabilities without receiving a persistent Hugging Face credential.
- At 2026-08-17T13:30:03Z, requested an additional decision on capability-scoped inference and sandbox lifecycle operations plus the remaining legacy result-catalog migration.
- At 2026-08-17T15:37:46Z, approved replacing the proposed inference gateway with a separate inference-only credential passed to reviewed workers and rotated regularly. The broader control credential remains confined to the control Space. Sandbox lifecycle operations and remaining result-catalog migration remained pending.
- At 2026-08-17T18:39:15Z, authorized finalizing the project, including capability-scoped Sandbox lifecycle operations and the requested Terminal-Bench 3 low-thinking campaign. The full paid campaign remains subject to the mandatory measured-cost launch approval. Remaining result-catalog migration was still pending.

### 2026-08-18

- At 2026-08-18T00:25:01Z, approved all remaining project work needed for autonomous finalization, including result-catalog migration and viewer replacement. This did not authorize deleting legacy resources or bypassing the measured substantial paid-compute gate.
- At 2026-08-18T10:40:26Z, directed the project to run DeepSeek V4 Flash on Terminal-Bench 2.1 autonomously while separate web UI work proceeds. The campaign uses the existing enforced total project limit and does not authorize a new credential, persistent store, or unreviewed runtime.
- At 2026-08-18T17:20:36Z, set a USD 300 hard ceiling for the next Terminal-Bench 2.1 production campaign. This later campaign-specific limit supersedes the earlier cumulative USD 300 limit for that campaign only; earlier spend remains part of the reported project cost.

### 2026-08-19

- At 2026-08-19T20:34:26Z, approved creating a local `<topic-branch>`, researching the permissions required by the local CLI control bearer token, correcting the README authentication instructions, and committing the authorization and documentation changes. No push, pull request, deployment, credential handling, paid resource, or runtime change is authorized.
- At 2026-08-19T21:19:35Z, approved implementing deterministic npm plan, apply, and verify commands for a canonical protected control Space and private artifact Bucket, with exact release upload, disabled initial writes, safe secret handling, fail-closed adoption, focused tests, and terse README pointers. Running remote apply, creating or changing remote resources, handling real credentials, spending, pushing, and opening a pull request remain unauthorized.
- Approved expanding the terse installer pointers into an agent-oriented high-level installation and execution-model runbook. This amendment is documentation-only and does not authorize running installer commands, hosted mutations, credentials, spending, push, or a pull request.
- Approved replacing implicit two-pass apply with explicit provision and configure phases, replacing installer canary activation with direct operator-confirmed activation of the inspected installation, adding a separate emergency disable command, and removing name-based canary policy. Activation must not change hardware or incur cost. No hosted mutation, credential handling, push, or pull request is authorized.
- Approved fetching and locally merging the canonical upstream default branch into the current topic branch, including bounded conflict resolution and verification. No push, pull request, hosted mutation, credential handling, or spend is authorized.
- Approved requiring a fresh Bucket create/read-back capability probe before accepting a proposed control credential and safely reclaiming valid owner-only installer locks after confirmed process death or reboot. This is local implementation and test authorization only; no real credential or hosted probe is authorized.
- Approved strict non-mutating fine-grained control-credential scope attestation, fail-closed receipt/Space source-SHA recovery, removal of recursive durable-record listing during credential checks, focused tests, documentation, and local commits. No real credential, hosted probe, installer remote command, resource mutation, activation, spend, push, or pull request is authorized.
- Approved sanitizing advisory-lock subprocess environments, exact resources-only phase-one revalidation, per-target verification locking, focused tests, documentation, and local commits. No real credential, installer remote command, hosted mutation, activation, spend, push, or pull request is authorized.
- Approved reusing the existing bounded inference-only token-scope attestation before initial or replacement installer secret persistence, with focused tests, documentation, and local commits. No real credential, hosted API call, installer remote command, resource mutation, activation, spend, push, or pull request is authorized.
- Approved progress-resetting inactivity and streamed-byte bounds for Bucket probe requests plus realpath-aware preflight rejection of checkout-contained state roots before file creation, with focused tests, documentation, and local commits. No real credential, hosted API call, installer remote command, resource mutation, activation, spend, push, or pull request is authorized.
- Approved removing the redundant `--confirm-space` argument from both activation and disablement, leaving the exact target-bound `--space` argument and all substantive safety checks intact. This is local implementation, tests, documentation, and commit authorization only; no hosted command, credential handling, resource mutation, activation, disablement, spend, push, or pull request is authorized.
- Approved replacing the installer-only `HARBOR_HF_INSTALL_VERIFY_BEARER` alias with direct use of `HARBOR_HF_CONTROL_BEARER_TOKEN` for authenticated verification and activation. Keep authenticated activation verification mandatory. This is local implementation, tests, documentation, and commit authorization only; no real credential, hosted command, resource mutation, activation, spend, push, or pull request is authorized.
- Approved locally merging the canonical upstream default branch with bounded fixes required for safe integration: keep the short web launcher but select launch policies from promoted profile data, preserve the hardened installer in the Space build, and redact and bound streamed Harbor output before logging or evidence capture. Resolve authorization history additively, regenerate contracts, run full validation, and commit locally only. No hosted mutation, credential handling, spend, push, or pull request is authorized.

### 2026-08-20

- At 2026-08-20T13:53:14Z, approved creating one private canonical `<artifact-bucket>` in the selected namespace and connecting the existing canonical `<control-space>` to it. No additional persistent resource or paid campaign was approved.
- At 2026-08-20T14:01:49Z, approved creating one private canonical replacement `<control-space>` in the selected namespace because the previous Space no longer exists, then deploying the reviewed control service with writes disabled. No additional persistent resource or paid campaign was approved.
- At 2026-08-20T14:07:53Z, explicitly directed the agent to run one controlled installer apply against the existing operator-selected phase-one bootstrap. This authorizes only reasserting its protected, stopped, free-hardware state and attempting creation of its canonical private Bucket and local proof receipt. Source upload, service-secret handling, activation, paid resources, additional resources, push, and pull request remain unauthorized.
- At 2026-08-20T14:25:07Z, directed the agent to run installer commands and iterate on diagnostics autonomously using the active local write-capable Hugging Face credential. This authorizes bounded plan/apply retries and direct probes against only the selected test bootstrap, including creation and cleanup of its empty private test Bucket when required. Source upload, service-secret handling, activation, paid resources, unrelated mutations, push, and pull request remain unauthorized.
- At 2026-08-20T15:26:21Z, authorized one bounded phase-two recovery against the operator-selected test bootstrap using the active local write-capable credential. The recovery may re-upload the exact prior source, adopt the existing expected secret names without reading or rewriting values, set the installed phase, restart on free hardware, and verify with writes disabled. It may not create resources, use paid hardware, push, or open a pull request, and must pause on failure.
- At 2026-08-20T15:37:03Z, authorized deleting the verified-empty private test Bucket, quarantining its stale local installer state, and running fresh plan plus phase-one apply to recreate the same protected free-hardware test Space and private Bucket. Source upload, credential prompting or movement, paid hardware, push, and pull request remain unauthorized.
- At 2026-08-20T17:29:22Z, directed the agent to continue after the operator's interactive phase-two apply left the bootstrap safely source-staged with both expected credential names. This authorizes one bounded retry that adopts those names without reading or rewriting values, re-uploads the exact saved source, sets the installed phase, restarts on free hardware, verifies with writes disabled, and pauses on failure. No resource creation, paid hardware, push, or pull request is authorized.
- At 2026-08-20T17:38:24Z, authorized the agent to take the bounded actions needed to get the selected test bootstrap running. This authorizes autonomous diagnosis, implementation fixes, and remote retries only for its existing protected `cpu-basic` Space and private Bucket, with exact source, disabled writes, and existing secret names. Credential values must not be read, copied, replaced, or exposed; no additional or paid resource, unrelated mutation, push, or pull request is authorized.
- At 2026-08-20T19:07:58Z, requested guarded activation support. This authorizes implementing and testing explicit disabled-to-canary activation, evidence-gated canary-to-enabled production promotion with separately approved paid hardware, and emergency write disablement. It does not authorize applying those transitions remotely, changing hosted hardware, spending, moving credentials, pushing, or opening a pull request.

- At 2026-08-20T19:21:55Z, replaced the current five-trial campaign request with a single-trial diagnostic run of all 89 Terminal-Bench 2.1 tasks. The exact benchmark, model, revisions, Pi version, high reasoning, provider route, hardware class, authorization boundaries, and USD 300 hard ceiling remain unchanged. The result must be labeled diagnostic and must not be used as an official five-trial result.

### 2026-08-21

- At 2026-08-21T10:31:00Z, approved enabling production writes on the hosted control Space and launching campaigns beyond the built-in control-smoke canary. This does not authorize a new persistent resource, credential, or bypass of the measured substantial paid-compute gate. Existing cost, inventory, credential, and semantic-outcome limits remain.
- At 2026-08-21T20:06:00Z, approved a derived leaderboard SQLite snapshot in the canonical `<artifact-bucket>`. The configuration digest includes trial count, reasoning, provider, and Harbor version. Only final, clean, fully scored campaigns appear. No second persistent resource and no anonymous leaderboard API in this amendment.

### 2026-08-22

- At 2026-08-21T23:01:07Z, approved integrating the requested dashboard harnesses as Harbor agent plugins and proving each with one Terminal-Bench 2.1 two-task canary. Requested harnesses: OpenCode, Qwen Code, mini-swe-agent, Pi, Kimi Code, Hermes, Codex, OpenHands, OpenClaw, Claude Code. Use the existing `terminal-bench-2-1-canary` task pair, `openai/gpt-oss-20b` on Together through Inference Providers, reasoning off, publication role diagnostic. Keep one Space and one Bucket. Do not add a credential. Reject a harness that needs a native API the locked HF router route cannot preserve. Hard ceiling USD 80 for the whole canary series, including retries. This does not authorize the 89-task diagnostic or the official five-trial protocol.

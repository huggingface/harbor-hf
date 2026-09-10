---
schema_version: v1
slug: huggingface/harbor-hf
repository: https://github.com/huggingface/harbor-hf
default_branch: main
---

# Harbor-HF

## Current authorization

Status: approved

### Current main redeployment (2026-09-09)

Approved at: 2026-09-09T07:49:21Z

- The user approved redeploying the current clean `main` revision to the
  existing control Space and rebuilding the parent worker image when worker
  source has advanced.
- Do not launch or retry a run, change write mode, move credentials, create
  resources, or change benchmark, model, or campaign limits.

### Combined Workbench execution and UX pull request

Approved at: 2026-09-08T23:35:00.428453+00:00

- The user explicitly approved updating the generic command-agent to use Harbor's default task user and raising a pull request together with the completed Workbench improvements.
- Include stable environment-row identity and deferred draft persistence, plus Fast-Agent 0.10.20 native routing, inference-key mapping, and verified CA-bundle defaults. Preserve saved recipes and existing runs.
- Audit the task/parent boundary before changing execution permissions; retain explicit environment bindings, scoped credential delivery, native Harbor execution and cleanup, and evidence handling. Do not introduce benchmark/model/harness-specific control branches.
- Approved operations: local implementation and tests, public privacy review, commit, branch push, and one pull request against main. No merge, deployment, new remote execution, credential movement, or upstream issue/pull request is authorized.
- Earlier local improvements were implemented in commits 7607316 and abf3f07; this combined authorization supersedes their local-only publication limits for the reviewed combined diff.

Implementation and validation recorded on 2026-09-08:

- Combined all three repairs without changing model routing restrictions, timeout settings, saved recipes, existing runs, or deployment configuration.
- Command-agent execution now uses Harbor's public task-user API and clean explicit bindings. Root staging follows ACP's ownership pattern; benchmark data ownership is no longer rewritten. A contract test verifies no parent credential forwarding or parent mounts in task Sandbox creation. The separate parent-worker credential/storage defect remains unchanged.
- Reviewed Harbor installed/base.py, installed/acp.py, installed/acp_runner.py, environments/base.py, and environments/hf_sandbox.py at dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e, plus upstream history through 90e28af3. No upstream change or pin update is required for this adapter correction.
- Passed 455 unit tests, 17 browser tests, 111 agent-package tests, and 46 root tests with 87.98% CLI coverage. Formatting, lint, type checks, generated contracts, both Docker builds, Slophammer check/DRY, Python dependency audit, and privacy checks passed.
- Draft PR is required until the existing js-yaml audit failure is resolved. Existing global TypeScript and supplementary agent-package coverage gaps are disclosed in the PR; no gate is weakened. The mutation script and optional Slophammer baseline file are absent; normal Slophammer checks pass.
- No merge, deployment, new remote run, credential transfer, or upstream publication has been performed.

Completed on 2026-09-08: opened draft PR #190 at https://github.com/huggingface/harbor-hf/pull/190 with the combined repairs and disclosed validation blockers. Merge, deployment, and further execution remain unapproved.

Workbench model-field PR approved at: 2026-09-08T20:55:35+00:00
Approved at: 2026-08-17T06:48:55Z
Amended at: 2026-09-01T18:11:42Z
Session-retention amendment approved at: 2026-09-08T07:27:00Z
Concurrency-control amendment approved at: 2026-09-08T07:31:00Z
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
Local upstream conflict-resolution amendment approved: 2026-08-19
Installer credential-and-lock hardening approved: 2026-08-19
Installer scope-and-source hardening approved: 2026-08-19
Installer subprocess-and-phase hardening approved: 2026-08-19
Installer inference-scope hardening approved: 2026-08-19
Installer probe-and-state-path hardening approved: 2026-08-19
Installer redundant-confirmation removal approved: 2026-08-19
Installer bearer-variable simplification approved: 2026-08-19
Upstream safe-integration amendment approved: 2026-08-19
Second local upstream integration amendment approved: 2026-08-19
Third local upstream integration amendment approved: 2026-08-19
CI cadence-test repair-and-push amendment approved: 2026-08-19
Leaderboard-snapshot amendment approved at: 2026-08-21T20:06:00Z
Harness-integration amendment approved at: 2026-08-21T23:01:07Z
Installer control-scope warning amendment approved at: 2026-08-21T23:56:40Z
Terminal-Bench 2.1 clean-rerun amendment approved at: 2026-08-22T07:33:41Z
Public-leaderboard amendment approved at: 2026-08-22T12:09:50Z
Infrastructure-retry amendment approved at: 2026-08-22T21:19:00Z
Harness 89-task diagnostic amendment approved at: 2026-08-22T23:31:00Z
Diagnostic-recovery amendment approved at: 2026-08-23T04:30:39+08:00
Harbor-from-source amendment approved at: 2026-08-23T07:20:00Z
FX harness amendment approved at: 2026-08-23T07:40:00Z
Harness full-run repair amendment approved at: 2026-08-23T08:21:00Z
Sandbox-parallelism amendment approved at: 2026-08-23T09:01:00Z
Run-native reset amendment approved at: 2026-08-24T09:08:00Z
Upstream integration-and-push amendment approved at: 2026-08-24T09:14:01Z
Installer clean-start inspection amendment approved at: 2026-08-24T14:05:13Z
Installer clean-reset amendment approved at: 2026-08-24T14:45:53Z
Installer exact configure-retry amendment approved at: 2026-08-24T15:14:43Z
Installer replacement configure-retry amendment approved at: 2026-08-24T15:23:28Z
Installer readiness-polling amendment approved at: 2026-08-24T15:31:07Z
Slophammer mutation-declaration amendment approved at: 2026-08-24T18:24:12Z
Failed-Run replacement amendment approved at: 2026-08-25T22:29:22Z
Admission-integrity repair amendment approved at: 2026-08-26T12:06:30Z
GLM-5.3-Flash full-run amendment approved at: 2026-09-01T11:12:25Z
GLM-5.3-Flash streaming-replacement amendment approved at: 2026-09-01T14:07:05Z
Historical-Run continuation amendment approved at: 2026-09-01T18:11:42Z
Historical-Run continuation worker-repair amendment approved at: 2026-09-01T22:13:57Z
Historical-Run continuation successor-repair amendment approved at: 2026-09-02T07:03:36Z

### OAuth callback repair and pull request (2026-09-08)

Approved at: 2026-09-08T10:15:32.647433+00:00

- The user approved repairing hosted OAuth callback diagnostics, removing sensitive
  callback data from request logs, and correcting duplicate session responses.
- Implement and test on a separate branch based on current upstream main; commit,
  push that branch, and open a pull request against main after privacy checks.
- Preserve the existing local checkout and its uncommitted changes. No merge,
  deployment, credential transfer, resource change, or paid execution is approved.

### Tactical fast-agent Workbench HF routing (2026-09-08)

Approved at: 2026-09-08T15:06:25.990859+00:00

- The user approved a tactical model-resolution repair and a separate pull request
  against current main so Workbench can use fast-agent's native HF adapter.
- Limit the change to reviewed recipe configuration, regression tests, and usage
  documentation. Preserve shared run contracts, other harnesses, and cost controls.
- The recipe may bind the already-injected inference credential to fast-agent's
  process-local HF credential environment; never use or transfer the control token.
- Local commits, branch publication, and a pull request are approved. No merge,
  deployment, live credential movement, paid run, or infrastructure change is approved.
- Arbitrary model-string inputs, aliases, and non-HF credential provisioning remain
  separate work; this patch retains the existing Model/Provider form.

### Fast-agent default pin update (2026-09-08)

Approved at: 2026-09-08T16:26:50+01:00

- The user approved updating the default Workbench fast-agent package to 0.10.20
  in the existing tactical routing pull request, including tests and documentation.
- Preserve the prior limits: no merge, deployment, credential transfer, or paid run.

### Scope

- Add the project-authorization skill and this repository-indexed project file through the normal contribution workflow.
- Finish deployment and hard cutover of the hosted TypeScript control service described by the approved control-service plan.
- Change hosted OAuth browser sessions to persist for 30 days, add regression coverage and documentation, and deploy the reviewed control-service revision.
- Expose Harbor's native `n_concurrent_trials` in the overview preset form, use 64 as the default for all-task benchmark presets, bound the form to Harbor's supported range, and deploy the tested revision.
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
- Fetch the latest canonical upstream default branch and merge it into local `tweaks`, preserving local commits, installer behavior, and reviewed security behavior. Resolve mechanical conflicts, run relevant and full validation plus the public-privacy check, and commit the verified merge locally.
- Fetch the latest canonical upstream default branch for a third local integration cycle and merge it into `tweaks`, preserving local commits, installer behavior, and reviewed security hardening. Resolve mechanical conflicts, run relevant and full validation plus the public-privacy check, and commit the verified merge locally.
- Repair the pull-request CI cadence test so it isolates scheduled Bucket synchronization from terminal worker-receipt safety synchronization. Run focused and full validation, commit the verified test repair locally, and push the resulting commits only to the tracked public `tweaks` branch.
- Harden installer credential acceptance with a fresh exact-Bucket create/read-back probe before storing a proposed control credential, and make owner-only installer operation locks safely reclaimable after confirmed process death or host reboot.
- Require exact non-mutating fine-grained scope attestation before storing a proposed control credential, make source-staged recovery stop on receipt/Space SHA drift without overwriting attested source, and remove credential checks that enumerate durable control records.
- Remove installer credentials from advisory-lock subprocesses, make resources-only provisioning reject any bootstrap where configuration has started, and serialize verification with all per-target installer operations.
- Require the existing non-mutating inference-only scope attestation before the installer persists an initial or replacement inference credential.
- Bound installer Bucket probe HTTP exchanges by inactivity and streamed bytes, and reject state roots that resolve inside the source checkout before creating lock or state files.
- Remove the redundant `--confirm-space` argument from installer activation and disablement while preserving exact target-bound plans and all existing preflight, verification, and rollback protections.
- Use `HARBOR_HF_CONTROL_BEARER_TOKEN` directly for installer authenticated verification and activation instead of requiring the redundant `HARBOR_HF_INSTALL_VERIFY_BEARER` alias.
- Merge the canonical upstream default branch locally while preserving the hardened installer, replace benchmark-specific web launch-policy routing with promoted-profile selection, and bound and redact streamed Harbor output before provider logs and evidence.
- Accept the Endpoint-inference permission that the provider necessarily couples to Endpoint management on the fine-grained control credential. Report additional fine-grained grants as prominent installer warnings instead of blocking installation, and make credential failures distinguish missing required permissions from the fresh Bucket write/read-back proof.
- Merge the latest canonical upstream default branch into the local `tweaks` branch, preserve the production installer and reviewed security boundaries while resolving conflicts, run the complete validation and public-privacy gates, and push the verified result only to the tracked public `origin/tweaks` branch.
- Inspect the privately supplied exact installer-test `<control-space>`, its default-derived `<artifact-bucket>`, and matching owner-only local installer state. If both remote resources are absent, quarantine stale matching local state and create a fresh non-mutating plan using only the Space ID.
- Delete the exact installer-test `<control-space>` only after revalidating that it is the private, paused, secret-free, `source_staged` Space bound to the matching owner-only receipt and that its default-derived Bucket is absent. Verify deletion, quarantine the matching local state, and create a fresh non-mutating default-Bucket plan using only the Space ID.
- Run one exact `install:configure` retry for the existing installer-test `<control-space>` and `<artifact-bucket>` using the unchanged private plan, receipt, uploaded source, and existing credential names.
- Run one replacement exact `install:configure` retry for the existing installer-test resources from the plan's sealed source revision, with the project uv environment selecting the sealed Hugging Face CLI version.
- Add visible bounded Space-start and application-readiness polling to installer configuration, with exact retry conditions, sanitized progress, and fail-closed timeout rollback.
- Disable Slophammer's Python mutation-declaration rule with a documented reason and remove its obsolete baseline finding while retaining optional manual mutation tooling.
- Add a leaderboard snapshot in the existing canonical `<artifact-bucket>`: a configuration digest, mechanical eligibility, and a derived SQLite file of the rows shown on the board. Keep one Space and one Bucket.
- Make the official leaderboard the Space default route and allow anonymous `GET /api/v1/leaderboard`. The current operator dashboard moves to `/overview` behind a "Run benchmark" button and Hugging Face login.
- Integrate the requested dashboard harnesses as Harbor agent plugins behind the existing campaign path: OpenCode, Qwen Code, mini-swe-agent, Pi, Kimi Code, Hermes, Codex, OpenHands, OpenClaw, and Claude Code. Prove each with one Terminal-Bench 2.1 two-task canary. Reject a harness that needs a native API the locked Hugging Face router route cannot preserve.
- Fix zero-token selection, fail-closed task exhaustion, campaign completion, publication commit safety, cooperative pause and resume, and append-only publication supersession. After the reviewed implementation is merged and deployed, run one fresh full 89-task Terminal-Bench 2.1 single-trial diagnostic campaign with worker concurrency eight to validate the rolling scheduler and produce a clean replacement publication.
- Finish the active diagnostic campaign. Fix and deploy terminal Job reservation settlement, recover only unresolved tasks through isolated one-task Jobs, publish the complete result, and append the required supersession record.
- Treat Harbor environment-setup failures as infrastructure, retry transient evidence-upload HTTP 500 responses, and keep an execution Job running after one task fails to upload evidence. Deploy that reviewed revision, then retry only eligible infrastructure failures on the existing gpt-oss OpenCode Terminal-Bench 2.1 single-trial campaign. Add a run-page control and CLI `--all-eligible` that call the existing per-task infrastructure retry path.
- After the gpt-oss OpenCode 89-task single-trial diagnostic exists, run the same Terminal-Bench 2.1 one-trial diagnostic for the other Chat Completions harnesses that already have a two-task canary: Qwen Code, mini-swe-agent, Pi, Kimi Code, Hermes, OpenHands, and OpenClaw. Use `openai/gpt-oss-20b` on Together, reasoning off, publication role diagnostic, and the existing promoted profiles. Do not add a campaign for OpenCode. Reject Codex and Claude Code on this route because they need a native API the locked Chat Completions router cannot preserve.
- Install Harbor from a pinned `harbor-framework/harbor` git commit instead of a PyPI release so new campaigns can evaluate harnesses as they land upstream. Remove the Harbor 0.21.0 empty-metrics sitecustomize workaround after that pin includes PR 2681. Deploy the reviewed revision. Existing campaign locks keep their Harbor pin.
- Add FX as a Harbor agent plugin and promoted harness plus gpt-oss Together deployment so it appears in the launch list. Deploy the reviewed revision. Do not launch a campaign.
- Finish one successful full Terminal-Bench 2.1 single-trial diagnostic for each existing gpt-oss Chat Completions 89-task run by inspecting that run and its Jobs, fixing the shared defects those Jobs expose, deploying the reviewed revision, and retrying only eligible infrastructure failures or unresolved tasks on those same campaigns. The existing FX 89-task row may be finished. Do not add a second 89-task campaign for a harness that already has one. Do not launch Codex or Claude Code.
- Make the namespace Sandbox cap an operator setting with default 16, then set the live service to 128 so the existing 89-task diagnostics can start more Sandboxes at once. Campaign ceilings stay unchanged. Existing campaign locks keep their per-run `max_sandboxes` and worker concurrency.
- Replace the Campaign concept with Run throughout source, contracts, durable records, API routes, CLI, web UI, tests, profiles, and documentation. Do not retain Campaign aliases or a compatibility API.
- Replace nested Sandboxes with one Hugging Face Job per physical trial attempt. A trial records the ordered list of Jobs that attempted it and selects a result only from a valid attempt receipt. A failed Job may create a replacement only for an eligible infrastructure failure within the locked attempt and budget limits.
- Remove logical-task pagination from the run detail and fix general control-Space responsiveness as part of the Run-native redesign.
- Delete every run-derived object from the canonical Bucket, including run locks, actions, tasks, attempts, evidence, publications, normalized results, catalogs, and leaderboard snapshots. Preserve ACLs, profiles, promotions, capacity policy, canonical resources, and credentials.
- After the redesigned service passes an unpaid control canary and a bounded paid task canary, launch fresh Terminal-Bench 2.1 single-trial runs for the Chat Completions harnesses with explicit launch authorization.
- Harden worker retries across control-service projection rebuilds, delete only the seven fresh Runs whose final preparation Jobs failed on `control_not_ready`, and launch one replacement Run for each same authorized harness after the hardened path passes its canaries.
- Repair the single detected Job admission-chain fork by deleting only its orphaned admission object, which has no dispatch, receipt, capacity release, advancement, or remote Job. Preserve its action intent and every other Run record. Add startup projection catch-up, deploy the reviewed revision, and restart the existing control Space.
- Run one final Terminal-Bench 2.1 full evaluation with all 89 tasks and one trial per task, using the existing promoted GLM-5.3-Flash Together deployment and Pi 0.84.2 with reasoning off.
- Cancel only the GLM-5.3-Flash plus Pi full Run invalidated by the pre-streaming inference bridge after its admitted Jobs reach evidence boundaries, then launch exactly one clean 89-task replacement using the fixed streaming worker.
- Add one append-only execution-continuation attachment to each of the seven approved historical gpt-oss 89-task Runs so the current TypeScript control service can finish only their unresolved tasks without changing Run IDs or rerunning selected outcomes.
- Add one immutable worker-repair attachment to each of those seven continuation records. Bind each repair to its original continuation and permit only the digest-pinned worker image and source revision to change. Preserve Run IDs, ceilings, prepared inputs, harness, model, provider and inference settings, evidence, and selected outcomes. Prove the repair with one unresolved OpenHands task before admitting the remaining work.
- Add one immutable successor worker-repair attachment to each of those seven existing repairs after the first repair-aware worker exposed a cross-language continuation-digest defect. Bind each successor to the original continuation and prior repair digests, and permit only the digest-pinned worker image and source revision to change. Preserve every existing record, Run ID, ceiling, prepared input, harness, model, provider and inference setting, evidence item, and selected outcome. Prove the successor with the same unresolved OpenHands task before admitting the remaining work.

### Limits

- Deploy an exact merged source revision with writes disabled first.
- Limit session retention to 30 days. Do not change OAuth providers, credentials, authorization roles, or persistent resources.
- Limit concurrency work to the existing Harbor control path and Space. Do not launch a run, change benchmark or model identities, add resources, move credentials, or increase the approved campaign ceilings.
- Use `cpu-upgrade` at USD 0.03 per active hour for the always-on control service.
- Keep total project spend within USD 300. This includes campaign, recovery, provider and endpoint costs plus the control service.
- For the next Terminal-Bench 2.1 production campaign, use the later explicitly approved USD 300 hard campaign ceiling. This campaign-specific amendment supersedes the preceding cumulative limit for that campaign only. Preserve and report all earlier spend separately.
- Do not create another persistent Space, Bucket, repository, Dataset, schedule, credential beyond the approved inference credential, lease store, status store, backup store, or result store.
- The 2026-08-20 amendment permits exactly one new private canonical `<artifact-bucket>` in the selected namespace. It does not permit another Space, Bucket, repository, Dataset, schedule, credential, or result store.
- The later 2026-08-20 replacement amendment permits exactly one new private canonical `<control-space>` in the selected namespace. It does not permit an additional Space or any other persistent resource.
- Do not rerun valid logical tasks or use inference during migration and publication recovery. The 2026-08-22 amendment permits one separate fresh 89-task diagnostic campaign after the validity fixes deploy; it does not reopen or retry the old campaign.
- Keep credential values, private resource identifiers, operator paths, and private topology out of Git and browsers. Do not expose credentials in logs or evidence; the approved inference credential may appear only in the trusted worker or root-owned inference bridge environment.
- Do not delete or retire a legacy resource without its completed private audit and a separate explicit approval for that resource.
- Anonymous callers may reach static application assets, login initiation, OAuth return handling, health checks, and `GET /api/v1/leaderboard`. That leaderboard response is the official snapshot only: ranked rows and Pareto flags, no `sqlite_key`, no diagnostic catalogs, and no campaign internals. Campaigns, results, system, events, Jobs, profiles, audit, and all mutations remain deny-by-default.
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
- Limit the second local upstream integration amendment to fetch, merge, mechanical conflict resolution, validation, privacy review, and local commits. Do not push, open a pull request, deploy, mutate hosted resources, move credentials, run inference, spend, force, reset, or rebase. Stop if integration requires a non-mechanical product or architecture decision.
- Limit the third local upstream integration amendment to fetch, merge, mechanical conflict resolution, validation, privacy review, and local commits. Do not push, open a pull request, deploy, mutate hosted resources, move credentials, run inference, spend, force, reset, or rebase. Stop if integration requires a non-mechanical product or architecture decision.
- Limit the CI cadence-test repair-and-push amendment to the diagnosed test isolation fix, validation, privacy review, local commits, and one normal push to the tracked public `tweaks` branch. Do not force-push, update the canonical upstream default branch, create or merge a pull request, rerun workflows through an API, deploy, mutate hosted resources, move credentials, run inference, or spend.
- Limit the installer credential-and-lock hardening to local implementation, tests, and documentation. Probe objects must contain no credential-derived or operator-specific data and use one stable installer prefix. Lock records remain owner-only and local. Do not run hosted probes, installer commands, credential operations, push, or a pull request.
- The configuration digest hashes benchmark identity, model identity, harness identity, trial count, reasoning effort, inference provider, and Harbor version from the campaign lock. It excludes worker revision, Job IDs, and cost.
- Only `publication_role=final`, quality `clean`, fully scored campaigns enter the leaderboard snapshot. Diagnostic, cancelled, mixed, and policy-failed catalogs stay private candidate material.
- Store each snapshot as an immutable SQLite object under the existing results prefix. Do not create another Bucket, Dataset, Space, or result service. Anonymous `GET /api/v1/leaderboard` is allowed and rate-limited separately from other anonymous API traffic. Result detail and publication click-through stay authenticated.
- Keep the control credential fine-grained, owned by the selected user or organization namespace, and capable of the exact Bucket, Job, Endpoint-management, and provider-implied Endpoint-inference operations. Missing required permissions, the wrong namespace, a non-fine-grained credential, or a failed fresh Bucket write/read-back proof remain hard failures. Gated access, global grants, unrelated scoped entities, and additional permissions produce conspicuous non-blocking warnings. Never pass the control credential to a worker or use it for inference.
- Limit the installer control-scope warning amendment to local implementation, tests, documentation, and commits. Do not inspect or transfer a real credential, run a hosted installer command or probe, mutate a hosted resource, activate writes, spend, push, or open a pull request.
- Limit the upstream integration-and-push amendment to the fetched canonical upstream tip and the tracked public `origin/tweaks` branch. Inspect the complete diff and public metadata, preserve placeholders, and run the public privacy checker before every commit and the push. Do not push to the canonical upstream default branch, open or merge a pull request, handle credentials, run hosted installer or campaign commands, mutate hosted resources, or incur cost.
- Limit the installer clean-start inspection to read-only metadata for the exact privately supplied target and its default-derived Bucket. Do not read credential values. If the Space exists or the Bucket is non-empty, stop without mutation. If only an empty Bucket remains, stop and request separate deletion approval. Quarantine matching local state only after both remote resources are proven absent, then run a fresh read-only plan. Do not provision, configure, transfer credentials, activate writes, spend, push, or open a pull request.
- Limit the installer clean reset to deleting only the revalidated receipt-bound test Space; do not touch another Space, Bucket, or hosted resource. Require the default-derived Bucket to remain absent before and after deletion. Quarantine rather than delete the matching owner-only local state, then stop after reporting the fresh read-only plan. Do not provision, configure, transfer credentials, activate writes, use paid hardware, push, or open a pull request.
- Limit the installer exact configure retry to one invocation against the existing receipt-bound test resources, using the unchanged private plan, source upload, and existing credential names. Do not replace or transfer credentials, create resources, change hardware, activate writes, spend, push, or open a pull request. Stop after sanitized success verification or the next sanitized failure.
- Limit the installer replacement configure retry to one invocation from the exact plan-bound source revision with the project uv environment's exact sealed Hugging Face CLI version. Restore the authorization branch afterward. Keep all preceding no-replacement, no-transfer, no-new-resource, free-hardware, no-activation, no-push, and stop-after-result limits.
- Limit the installer readiness-polling amendment to local implementation, tests, documentation, and commits. Do not inspect credentials, run hosted installer commands, mutate or deploy hosted resources, activate writes, spend, push, or open a pull request.
- Limit the Slophammer mutation-declaration amendment to local configuration, baseline cleanup, validation, and commits. Keep the manual mutation workflow, dependency, tool configuration, and check script available on demand. Do not push, open a pull request, mutate hosted resources, or spend.
- The harness-integration series uses `terminal-bench-2-1-canary`, `openai/gpt-oss-20b` on Together, reasoning off, and publication role diagnostic. Hard ceiling USD 80 for the whole series, including retries. This does not authorize the 89-task diagnostic or the official five-trial protocol.
- Keep real observed cost for the active diagnostic campaign at or below USD 100 during this recovery. Preserve its locked worker, model, benchmark, provider, hardware, task inputs, timeouts, concurrency, trial count, and attempt limit. Use no new persistent resource or credential.
- The 2026-08-22 infrastructure-retry amendment does not raise any campaign ceiling. Retries stay inside the locked ceiling of that existing campaign. Do not reopen `complete`, agent, verifier, policy, refusal, semantic, cancelled, or benchmark-timeout outcomes. Do not rerun a scored miss.
- The 2026-08-22 harness 89-task diagnostic amendment authorizes seven new campaigns. Each campaign uses the same hard ceiling as the existing gpt-oss OpenCode 89-task run: USD 10.60 (`10600000` micro-USD), which is twice the diagnostic reservation. Combined hard cap for those seven campaigns is USD 74.20, including infrastructure retries. This does not reopen the OpenCode 89-task campaign, does not authorize Codex or Claude Code, and does not authorize the official five-trial protocol.
- The 2026-08-23 Harbor-from-source amendment pins an exact Harbor git commit. It does not float on a branch, add a persistent resource or credential, relaunch a campaign, or raise any spend ceiling. `harbor_version` stays the version that commit reports so preparation admission still matches.
- The 2026-08-23 FX harness amendment does not authorize a canary, 89-task diagnostic, official five-trial run, new persistent resource, or credential. It only adds the harness to the existing campaign path and deploys the reviewed revision.
- The later 2026-08-23 harness full-run repair amendment does not raise any campaign ceiling and does not add a persistent resource or credential. Retries stay inside each existing campaign's locked ceiling. The seven-campaign combined cap remains USD 74.20. The existing FX 89-task row stays inside its locked ceiling. Do not reopen sealed semantic, agent, verifier, policy, refusal, cancelled, or benchmark-timeout outcomes. Do not launch a second 89-task campaign for a harness that already has one.
- The 2026-08-23 Sandbox-parallelism amendment raises only the shared namespace Sandbox cap from 16 to 128. It does not raise a campaign ceiling, add a persistent resource, or change a locked campaign. Sandbox hardware cost still counts against each campaign's existing ceiling.
- The 2026-08-24 Run-native reset amendment authorizes irreversible deletion only for run-derived objects under a reviewed exact-prefix allowlist. It does not authorize deleting ACLs, profiles, promotions, capacity policy, the canonical Space or Bucket, credentials, or unrelated objects.
- The Run-native path has no Sandbox lifecycle and no Campaign compatibility writer, reader, route, field, alias, or UI label. Existing run data is deleted instead of migrated.
- Replacement Jobs remain limited to explicit infrastructure failures, the locked physical-attempt count, the run ceiling, and the previously approved aggregate ceilings. Semantic, agent, verifier, policy, refusal, cancelled, benchmark-timeout, and scored outcomes remain terminal.
- Fresh runs start only after the exact deployed revision passes the unpaid control canary and bounded paid task canary. FX, Codex, and Claude Code remain excluded from fresh launch without a separate amendment.
- The 2026-08-25 failed-Run replacement amendment permits targeted deletion and replacement only for the seven fresh Runs invalidated by `control_not_ready` during the control deployment. Preserve every unrelated Run and retained control object. Keep the same profiles, USD 10.60 per-Run ceiling, USD 74.20 aggregate ceiling, and excluded harnesses. Do not rerun any scored or semantic outcome.
- The 2026-08-26 admission-integrity repair amendment permits deletion of exactly one orphaned Job admission object and no other object. It adds no compatibility path, persistent resource, credential, Run, retry, or ceiling increase.
- The 2026-09-01 GLM-5.3-Flash amendment permits exactly one new full Run with a USD 18 hard ceiling, at most 16 active trial Jobs, and at most two physical attempts per task. These bounds come from the checked-in `tb21-full-glm-standard` launch policy. The measured estimate is USD 2.052029 from its published two-task canary, as recorded in the full-matrix plan. Do not launch another matrix cell, create a persistent resource or credential, or rerun a valid logical task.
- The 2026-09-01 streaming-replacement amendment classifies every outcome from the first GLM-5.3-Flash plus Pi full Run as invalid because its immutable worker buffered streaming provider responses until completion. It permits cancelling only that paused Run and launching one clean full replacement with a new USD 18 hard ceiling, at most 16 active trial Jobs, and at most two physical attempts per task. It explicitly permits the replacement to rerun those invalidated tasks. Do not resume the invalidated Run, launch another matrix cell, create a persistent resource or credential, or alter any other Run.
- The 2026-09-01 historical-Run continuation amendment permits one immutable attachment per approved historical Run. The attachment must preserve the original lock, Run ID, task IDs, selected outcomes, attempt and evidence history, observed cost, ceiling, model, benchmark, harness, provider, and trial identity. It may bind only a reviewed current deployment and worker contract that matches those identities. It may admit only tasks without a valid selected receipt. It creates no replacement Run, persistent resource, credential, budget reset, selected-task retry, deletion, or compatibility writer outside the TypeScript control service. The seven USD 10.60 per-Run ceilings and USD 74.20 aggregate ceiling remain unchanged.
- The 2026-09-02 successor-repair amendment permits exactly one append-only successor for each of the seven existing continuation worker repairs. Each successor must bind to the original continuation and prior repair digests and may change only the digest-pinned worker image and worker source revision. It does not permit another successor, replacement Run, persistent resource, credential, ceiling increase, prepared-input change, configuration change, evidence mutation, selected-outcome retry, deletion, or overwrite.

### Remaining gates

No project-scope amendment remains pending. Operational gates still apply:

- Do not retire the legacy results viewer or stores until catalog parity is verified. No deletion is authorized.
- Keep each substantial paid campaign behind its measured launch review and exact enforced cost ceiling.
- Keep the harness-integration canary series inside the USD 80 hard ceiling. Reject a harness that needs a native API the locked router route cannot preserve.
- Keep the seven gpt-oss 89-task harness diagnostics inside USD 10.60 each and USD 74.20 combined.
- Finish those existing 89-task rows, plus the existing OpenCode and FX 89-task rows, without a second campaign for the same harness.
- Attach and resume a historical Run only after deterministic replay and selection-preservation tests pass and that harness's reviewed worker passes its bounded canary.
- Admit remaining historical work only after the successor repair passes the same unresolved OpenHands task with valid evidence and nonzero provider token usage.
- Keep the approved GLM-5.3-Flash Together plus Pi replacement inside its USD 18 immutable ceiling and the rollout plan's 16-Job physical concurrency limit. Do not resume the invalidated first Run.

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
- Approved fetching and locally merging the configured canonical upstream default branch into `tweaks`, resolving conflicts without discarding existing local commits or reviewed security behavior, running relevant validation and the public-privacy check, and committing the verified integration locally. No push, pull request, deployment, hosted mutation, credential movement, force operation, rebase, reset, inference, or spend is authorized; stop for a product or architecture decision that cannot be resolved mechanically.
- Approved a new fetch and local merge of the latest configured canonical upstream default branch into `tweaks`, preserving local commits, installer behavior, and reviewed security behavior. Run relevant and full validation and the public-privacy check, then commit locally. No push, pull request, deployment, hosted mutation, credential movement, inference, spend, force operation, reset, or rebase is authorized; stop for a non-mechanical product or architecture decision.
- Approved a third fetch and local merge of the latest configured canonical upstream default branch into `tweaks`, preserving local commits, installer behavior, and reviewed security hardening. Run relevant and full validation and the public-privacy check, then commit locally. No push, pull request, deployment, hosted mutation, credential movement, inference, spend, force operation, reset, or rebase is authorized; stop for a non-mechanical product or architecture decision.
- Approved repairing the diagnosed pull-request CI cadence test so it observes only scheduled Bucket synchronization, running focused and full validation plus the public-privacy check, committing the verified repair, and pushing the resulting commits only to the tracked public `tweaks` branch. No force-push, canonical-upstream update, pull-request mutation, workflow-rerun API call, deployment, hosted resource mutation, credential movement, inference, or spend is authorized.
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
- At 2026-08-21T23:56:40Z, approved allowing the provider-implied Endpoint-inference permission on the fine-grained control credential and changing additional fine-grained grants from blockers into prominent installer warnings. Missing required permissions, wrong ownership, non-fine-grained credentials, and failed Bucket write proof remain blockers. This amendment authorizes local implementation, tests, documentation, and commits only.

### 2026-08-22

- At 2026-08-21T23:01:07Z, approved integrating the requested dashboard harnesses as Harbor agent plugins and proving each with one Terminal-Bench 2.1 two-task canary. Requested harnesses: OpenCode, Qwen Code, mini-swe-agent, Pi, Kimi Code, Hermes, Codex, OpenHands, OpenClaw, Claude Code. Use the existing `terminal-bench-2-1-canary` task pair, `openai/gpt-oss-20b` on Together through Inference Providers, reasoning off, publication role diagnostic. Keep one Space and one Bucket. Do not add a credential. Reject a harness that needs a native API the locked HF router route cannot preserve. Hard ceiling USD 80 for the whole canary series, including retries. This does not authorize the 89-task diagnostic or the official five-trial protocol.
- At 2026-08-22T07:33:41Z, approved merging the Sandbox admission work, implementing and merging the valid-result and pause-resume fixes, deploying the reviewed control service, and running one new full 89-task Terminal-Bench 2.1 single-trial diagnostic campaign from scratch with worker concurrency eight. The existing USD 300 hard campaign ceiling applies only after the updated launch review and control admission gates pass. The old campaign and publication remain immutable; append-only supersession may occur only after the new publication validates. No new persistent resource, credential, model promotion, or official five-trial claim is authorized.
- At 2026-08-22T12:09:50Z, approved making the official leaderboard the Space default route and allowing anonymous `GET /api/v1/leaderboard`. The operator dashboard moves to `/overview` behind a "Run benchmark" button and login. Campaigns, results, system, events, and mutations stay authenticated. Result click-through requires login. No new Space, Bucket, Dataset, or credential.
- At 2026-08-22T21:19:00Z, approved classifying Harbor environment-setup failures as infrastructure, retrying evidence-upload HTTP 500 responses, keeping an execution Job running after one upload failure, adding a run-page and CLI batch of existing infrastructure retries, deploying the reviewed revision, and retrying only eligible infrastructure tasks on the existing gpt-oss OpenCode 89-task campaign. Spend stays inside that campaign's locked ceiling. Sealed semantic, agent, verifier, policy, refusal, cancelled, and timeout outcomes stay sealed.
- At 2026-08-22T23:31:00Z, approved one new 89-task Terminal-Bench 2.1 single-trial diagnostic for each remaining Chat Completions harness that already has a two-task canary: Qwen Code, mini-swe-agent, Pi, Kimi Code, Hermes, OpenHands, and OpenClaw. Same model, provider, reasoning, publication role, and USD 10.60 campaign ceiling as the existing gpt-oss OpenCode 89-task run. Combined cap USD 74.20. OpenCode is not relaunched. Codex and Claude Code stay rejected on this route.

### 2026-08-23

- At 2026-08-23T04:30:39+08:00, approved all work needed to finish the active diagnostic campaign without a workflow. This includes fixing, testing, reviewing, committing, pushing, merging, and deploying terminal Job reservation settlement; using the fixed control revision for the campaign; recovering unresolved tasks through isolated one-task Jobs; publishing the complete result; and appending its supersession record. Keep real observed recovery cost at or below USD 100 and preserve the locked execution contract.
- At 2026-08-23T07:20:00Z, approved installing Harbor from a pinned `harbor-framework/harbor` git commit instead of PyPI, removing the empty-metrics sitecustomize workaround when that pin includes PR 2681, and deploying the reviewed revision. Existing campaign locks stay on their locked Harbor pin. No new persistent resource, credential, or campaign launch.
- At 2026-08-23T07:40:00Z, approved adding FX to the available harness list as a Harbor agent plugin with a gpt-oss Together deployment, then committing and deploying the reviewed revision. No campaign launch, persistent resource, or credential.
- At 2026-08-23T08:21:00Z, approved inspecting each existing gpt-oss 89-task diagnostic, fixing the defects those Jobs expose, deploying the reviewed revision, and retrying eligible infrastructure failures or unresolved tasks on those same campaigns so each of those harnesses can finish one full run. The already-started FX 89-task row may be finished. No second campaign for a harness that already has an 89-task row. No Codex or Claude Code. No ceiling increase.
- At 2026-08-23T09:01:00Z, approved making the namespace Sandbox cap configurable with default 16 and setting the live service to 128 so the existing 89-task diagnostics can evaluate faster. Campaign ceilings, inventory, and locked per-run Sandbox and worker limits stay unchanged.

### 2026-08-24

- At 2026-08-24T09:08:00Z, approved replacing Campaign with Run everywhere without compatibility aliases, replacing nested Sandboxes with one Hugging Face Job per physical trial attempt, removing logical-task pagination, and improving control-Space responsiveness.
- Approved deleting all run-derived Bucket data and starting over while preserving ACLs, profiles, promotions, capacity policy, canonical resources, and credentials.
- Approved bounded infrastructure-only replacement Jobs. After the new path passes its unpaid and bounded paid canaries, approved fresh single-trial runs for explicitly authorized Chat Completions harnesses. FX, Codex, and Claude Code remain excluded.
- At 2026-08-24T09:14:01Z, approved merging the fetched canonical upstream default branch into `tweaks`, resolving conflicts without discarding the installer or reviewed security behavior, running full validation and privacy checks, and pushing only the verified result to the tracked public `origin/tweaks` branch. No pull request, upstream-default-branch update, hosted mutation, credential handling, inference, or spend is authorized.
- At 2026-08-24T14:05:13Z, approved a clean-start inspection for the exact installer-test Space supplied privately, its default-derived Bucket, and matching local installer state. If both remote resources are absent, stale local state may be quarantined before a fresh non-mutating plan. An existing Space, non-empty Bucket, or lone empty Bucket remains a stop condition pending review or separate deletion approval. No credential-value access, provisioning, configuration, activation, spend, push, or pull request is authorized.
- At 2026-08-24T14:45:53Z, approved deleting the exact private, paused, secret-free, `source_staged` installer-test Space after its receipt binding and absent default Bucket are revalidated, touching no other remote resource. After verified deletion, quarantine the matching owner-only local state and run a fresh non-mutating plan using only the Space ID. Stop after reporting the plan; do not provision, configure, transfer credentials, activate writes, spend, push, or open a pull request.
- At 2026-08-24T15:14:43Z, approved one exact `install:configure` retry against the existing installer-test `<control-space>` and `<artifact-bucket>` using the unchanged private plan, receipt, source upload, and existing credential names. Do not replace or transfer credentials, create resources, use paid hardware, activate writes, push, or open a pull request. Stop after sanitized success verification or the next sanitized failure.
- At 2026-08-24T15:23:28Z, approved one replacement exact `install:configure` retry against the same existing installer-test resources, using the unchanged private plan, receipt, source upload, and credential names, with the plan's sealed source revision and the project uv environment's exact sealed Hugging Face CLI version. Do not replace or transfer credentials, create resources, use paid hardware, activate writes, push, or open a pull request. Restore the authorization branch and stop after sanitized success verification or the next sanitized failure.
- At 2026-08-24T15:31:07Z, approved local implementation, tests, documentation, and commits for visible bounded Space-start and application-readiness polling during installer configuration. Retry only exact reviewed startup states, report sanitized progress, and preserve fail-closed rollback. Do not run hosted installer commands, deploy, activate, spend, push, or open a pull request.
- At 2026-08-24T18:24:12Z, approved disabling Slophammer's Python mutation-declaration rule with a documented reason and removing its obsolete baseline finding. Keep the manual mutation workflow and local mutation tooling available on demand. Limit work to local configuration, validation, and commits; do not push, deploy, mutate hosted resources, or spend.

### 2026-08-25

- At 2026-08-25T22:29:22Z, approved hardening worker retries across control-service rebuilds, deleting only the seven fresh Run-derived prefixes invalidated when their final preparation Jobs received `control_not_ready`, and launching one replacement Run for each same authorized harness. Existing profiles and ceilings remain unchanged. OpenCode, FX, Codex, and Claude Code remain excluded.

### 2026-08-26

- At 2026-08-26T12:06:30Z, approved removing the old orphaned admission behind the single detected integrity fork, fixing startup replay without backward compatibility, and restarting the existing control Space. The repair deletes only the admission object that never dispatched or created a remote Job and preserves every other durable record.

### 2026-09-01

- At 2026-09-01T11:12:25Z, approved one full 89-task, single-trial Terminal-Bench 2.1 Run with GLM-5.3-Flash through Together and Pi 0.84.2 reasoning off. The selected launch option fixes the hard ceiling at USD 18 and uses the existing profile limits of 16 active trial Jobs and two physical attempts per task.
- At 2026-09-01T14:07:05Z, approved cancelling only the paused GLM-5.3-Flash plus Pi Run invalidated by the pre-streaming inference bridge and launching one clean 89-task replacement on the fixed streaming worker. The replacement has a new USD 18 hard ceiling, at most 16 active trial Jobs, and at most two physical attempts per task. Outcomes from the invalidated Run may be rerun only in this replacement.
- At 2026-09-01T18:11:42Z, approved a narrow continuation mechanism for the seven historical gpt-oss full Runs that the current service cannot resume. Each Run may receive one append-only current execution attachment after local verification and its harness canary. The same Run then schedules only unresolved tasks, retains all selected outcomes and costs, and remains inside its existing ceiling. No replacement Run, selected-task retry, deletion, resource, credential, or budget increase is authorized.

### 2026-09-02

- At 2026-09-02T07:03:36Z, approved one immutable successor worker-repair attachment for each of the seven existing continuation repairs after the first repair-aware worker exposed a cross-language continuation-digest defect. Each successor binds to the original continuation and prior repair digests and may change only the worker image digest and source revision. Existing records, Run IDs, ceilings, prepared inputs, settings, evidence, and selected outcomes remain unchanged. The same unresolved OpenHands task must prove the corrected image before other historical work is admitted.

### 2026-09-08

- At 2026-09-08T07:27:00Z, approved changing hosted OAuth browser session persistence from 12 hours to 30 days, with focused tests, documentation, deployment, and no credential, authorization-role, resource, or paid-Job changes.
- At 2026-09-08T07:31:00Z, approved exposing Harbor's native `n_concurrent_trials` in the overview preset form, defaulting all-task benchmark presets to 64 within Harbor's supported range, adding tests and documentation, and deploying without launching a run or changing resources, credentials, benchmark identities, model identities, or campaign ceilings.

### 2026-09-08 — Workbench model fields and deployment instructions

Approved at: 2026-09-08T20:55:35+00:00

- The user requested a branch and pull request for separate **Recorded model**
  and **Harness model string** fields, with simple deployment instructions for
  the existing Space supplied in the conversation. Base this bounded change on
  current upstream main and preserve the guided Workbench architecture.
- Keep recorded identity separate from Harbor's native `AgentConfig.model_name`.
  Explain existing environment bindings and credential restrictions; do not add
  secret types, move credentials, or treat literal configuration as a secret store.
- Approved local implementation, tests, commits, topic-branch push, and one
  public pull request. Keep the deployment target and other operator-specific
  identifiers out of public repository content and metadata.
- Provide deployment instructions only. No merge, actual deployment, resource
  creation, image publication, credential handling, Job launch/cancellation,
  inference, or spending is approved by this amendment. Existing unrelated
  work and Jobs must remain untouched.

### 2026-09-08 — Shared Workbench concurrency follow-up

Approved at: 2026-09-08T21:29:10+00:00

- The user approved exposing Workbench concurrency through the same native
  setting as Overview, reusing code where practical, and rejected 64 as a
  normal default in favor of typical values such as 8, 10, 12, and 16.
- Implement the shared form control, existing native submission override,
  preset-default selection, browser draft persistence, confirmation reset,
  tests, and documentation. Use 8 for new multi-task preset submissions and
  retain 1 for the one-task preset; retain explicit higher values within the
  existing supported range. Do not rewrite existing runs or explicit drafts.
- Continue the approved topic-branch/PR #188 workflow for this bounded
  follow-up. No deployment, merge, credential change, resource mutation,
  benchmark or setup launch, unrelated Job action, or spend is authorized.
- Unrestricted model-string passthrough, provider credential delivery, and
  separately recorded reasoning remain distinct follow-up work; this amendment
  does not claim they are implemented.

### Run diagnostics and completion/profile investigation

Approved at: 2026-09-09T08:48:52Z

- The user explicitly requested further completion-handling investigation, verification of the recorded Fast-Agent profile/default reasoning, and deterministic diagnostic reporting on the Runs page for completed trials.
- Implement and test read-only presentation of native Harbor exception evidence and completion semantics, with links to trial details and clear unknown-classification coverage. Distinguish configured options from unverified provider-effective settings. Preserve native results, scores, status, retries, and immutable run configuration.
- Read pinned Harbor source and subsequent upstream history first. Do not infer infrastructure categories from task names, traceback patterns, or verifier-log heuristics. Harbor currently lacks typed verifier-bootstrap/scoring-validity evidence; report that gap and propose upstream structured evidence before implementing any classifier.
- Local authorization and implementation commits are approved. Preserve unrelated work and the existing Sandbox idle-timeout stopgap. No new benchmark/inference Jobs, historical-result edits, credential movement, resource changes, public push/pull request/merge, worker-image publication, deployment, or upstream source mutation is included in this bounded implementation.
- Investigate Fast-Agent completion and reasoning behavior read-only. Any required change in a separate repository must receive its own explicit approval and authorization record.

### Dependency repair, merge, and deployment

Approved at: 2026-09-08T23:50:36.203970+00:00

- The user explicitly approved resolving the dependency audit failure, merging PR #190 after validation, and deploying the combined improvements.
- Update only the affected dependency resolution as needed; preserve audit and test gates. Publish the parent image through the existing workflow and registry; deploy merged source to the previously selected shared control Space and update its parent/setup image references to verified immutable digests.
- Preserve execution mode, hardware, visibility, namespace, Bucket configuration, and persistent secrets. Do not create resources, copy credentials, or launch benchmark/inference Jobs. Existing control credential and writable-parent-storage defects are not repaired by this deployment.
- Verify release provenance, image contents, runtime health, and configured image references. Stop for unexpected active-run compatibility issues or any required credential movement.

### Waffle-view diagnostics integration and pull request

Status: completed

Approved at: 2026-09-09T09:35:47.579013+00:00

- The user explicitly approved integrating the local native run diagnostics with the waffle viewer merged into main, resolving compatibility issues, and raising a pull request.
- Approved scope: update against current main, implement read-only historical and future trial exception presentation in the existing viewer, add tests and documentation, review privacy, commit, push the topic branch, and open one pull request. Preserve native results and existing viewer behavior.
- Continue to distinguish recorded exception types from unknown root-cause and verifier-bootstrap classifications. Do not add a log classifier or rewrite historical evidence.
- No merge, deployment, worker image publication, new run, retry, credential transfer, upstream source mutation, or infrastructure change is authorized.

### Nine-trial canary preset and native waffle (2026-09-09)

Approved at: 2026-09-09T08:12:42.901890+00:00

- Direct approval: after verification of the deployed main revision and a proposal
  to add the nine-trial preset and port/test the native waffle, the user asked
  to perform that work.
- Add a non-leaderboard benchmark preset selecting code-from-image,
  log-summary-date-ranges, and openssl-selfsigned-cert with three Harbor
  repetitions per task. Expose it through the existing shared preset selector.
- Review and adapt a copy of the existing artifact-observed native waffle work
  on current main, preserving nine distinct trial identities and honest observed
  versus authoritative states. Preserve all original dirty worktrees.
- Implement and test locally, with local authorization and implementation commits.
  Prepare deployment to the existing user-selected control Space only; preserve
  resources, secrets, hardware, execution settings, and existing run records.
- Do not launch setup or benchmark Jobs, call inference, increase spending limits,
  move credentials, create resources, publish results, merge, or push main.
  Public branch/PR publication and any deployment mechanism requiring image
  publication require their own scope confirmation before proceeding.

### Nine-trial canary branch publication (2026-09-09)

Approved at: 2026-09-09T09:07:40.659178+00:00

- Direct approval: the user requested pushing the completed feature branch and
  stated that they will perform the merge, acknowledging the reported coverage
  shortfall.
- Publish the reviewed nine-trial preset and observational waffle commits on
  `feat/nine-trial-canary` to the canonical repository after privacy review.
- Preserve coverage thresholds and report validation honestly: 502 unit tests
  and 23 browser tests passed; global line coverage is 78.83%, below 85%.
  The mutation-check script and Slophammer baseline are missing. Publication
  does not claim these checks pass.
- No merge, default-branch push, deployment, benchmark launch, resource change,
  credential movement, or result publication is authorized by this amendment.

Completed on 2026-09-09: integrated native diagnostics with the current-main waffle viewer and opened draft PR #193 (https://github.com/huggingface/harbor-hf/pull/193). Unit and browser tests passed; existing global coverage and missing baseline/mutation-tooling blockers are disclosed. No merge, deployment, or remote execution was performed.

### Per-run detail waffle placement (2026-09-09)

Approved at: 2026-09-09T10:22:49.101525+00:00

- Direct approval: the user requested correcting the waffle placement in a new
  pull request after clarifying that it should show the contents of one run.
- Keep the Runs overview as its existing list with compact summary counts.
  Move the waffle to the individual run detail page beneath summary cards,
  grouped by task with a separate square per repetition. Preserve native
  identities, diagnostics, honest observed-state labels, and trial navigation.
- Implement on current main in an isolated worktree, test, document, commit,
  publish a feature branch, and open one pull request after privacy review.
- No merge, default-branch push, deployment, setup or benchmark launch, inference,
  credential movement, resource mutation, or result publication. Preserve
  unrelated work and existing validation thresholds; disclose check failures.

### Scannable results, repetition matrix, and pricing scenarios (2026-09-09)

Approved at: 2026-09-09T11:15:09.705718+00:00

- Direct approval: the user requested a new PR improving run overview/detail
  summaries, rounded reward and unavailable placeholders, million-scale token
  counts, affected-trial and infrastructure-failure summaries, editable token
  rates including long context, and tasks across columns with repeats as rows.
- Implement and test on current main in an isolated worktree. Keep the overview
  a list and the matrix inside individual run details. Preserve native outcomes
  and identities, and label display repetition slots honestly.
- Pricing controls are presentation-only USD-per-million input, output, cached,
  and long-context scenarios. Do not alter recorded spend, billing, JobConfig,
  cost guards, or run behavior. Where native request-tier usage is unavailable,
  report the limitation rather than derive it from cumulative usage.
- Categorize only exact reviewed native exception types for display, retaining
  unknown/partial evidence and distinguishing verifier outcomes from exceptions;
  do not infer root cause or retry eligibility. No trajectory/log parsing.
- Local commits, privacy-reviewed topic-branch push, and one new PR are approved.
  No deployment, merge, benchmark or setup launch, inference, credential movement,
  resource change, upstream publication, or lowering validation thresholds.

### Synthetic results demo and fast-agent starter refresh (2026-09-09)

Approved at: 2026-09-09T12:05:26.714588+00:00

- Direct approval: the user requested an interactive demo of the new results
  feature, the default fast-agent install version 0.10.21, their supplied exact
  execution script, and committing and pushing those changes.
- Serve the current feature frontend on loopback only with synthetic run, usage,
  exception, and repeat data. Keep preview helpers outside tracked source, reject
  mutations, and do not contact the hosted control service or load credentials.
- Update the reviewed fast-agent starter setup and execution templates consistently
  across browser/server copies; preserve existing saved recipes and immutable
  records. Test the requested script with local command stubs, not inference.
- Commit and push on the existing scannable-results PR branch after privacy
  review. Keep validation thresholds and known limitations explicit.
- No merge, deployment, live setup/benchmark launch, inference, credential transfer,
  public listener, resource creation, or unrelated configuration change.

### Concise results tooltips (2026-09-09)

Approved at: 2026-09-09T12:22:20.211230+00:00

- Direct approval: after reviewing the synthetic demo, the user requested
  radically simpler tooltip text with main details only, then commit/push
  and PR publication. Continue the existing open scannable-results PR.
- Shorten trial and summary tooltips without changing outcome semantics. Keep
  essential stale/unknown indicators; move explanatory caveats to existing
  legend/help rather than repeating them on each square.
- Test the presentation, rebuild the loopback-only synthetic demo, commit,
  and privacy-review the push and PR update. Preserve known validation limits.
- No merge, deployment, live runs, inference, credential movement, resource
  creation, public demo listener, or changes to stored evidence.

### Stable polling and measured agent timing (2026-09-09)

Approved at: 2026-09-09T13:13:00.258660+00:00

- Direct approval: the user requested removing disruptive refreshing text, agent
  wall-time in trial tooltips and run-list summaries/status, and red affected-trial
  counts after reviewing the deployed scannable-results interface.
- Implement and test locally on current main; preserve the existing presentation
  and native outcome semantics. Sum only recorded native agent execution intervals
  for a display rollup, with partial/missing measurement coverage. Do not infer
  active elapsed time or inflate sums using both top-level and step timings.
- Reuse existing artifact/projection reads and generated response contracts; no
  new durable native field, lifecycle authority, extra overview progress polling,
  infrastructure diagnosis from generic errors, or change to retry behavior.
- Local implementation, tests, documentation, and local commits are approved.
  No deployment, merge, new remote PR/branch publication, live setup/benchmark
  launch, inference, credential movement, or resource change is included.

### Compact matrix and saved pricing preferences (2026-09-09)

Approved at: 2026-09-09T13:54:52.918279+00:00

- Direct approval: the user approved the preceding local work and requested
  subtler stale feedback, better use of summary/grid space, cache-hit percentage,
  saved pricing scenarios usable in the Runs list, compact non-question-mark
  trial markers, and known task budgets in tooltips when available.
- Continue local implementation and tests on the stable-timing branch. Keep
  tasks as columns and repetition slots as rows, shrink visual markers and
  column headers while preserving keyboard/focus/hover access and hit targets.
- Persist explicitly saved named pricing preferences in browser-local storage,
  validate untrusted records, and distinguish selected scenario estimates from
  native reported cost. No server-side preference store, shared storage resource,
  billing change, inference parameter, or execution-cost policy is authorized.
- Display reported cached/input percentage only when meaningful. Preserve
  missing/partial data, error states, and current-result timing semantics.
- Native resolved time budgets are absent; do not reconstruct Harbor timeout
  rules or read benchmark formats. Keep unavailable budgets unknown/omitted,
  and unfinished observations distinct from proven running execution.
- No remote publication, PR creation, deployment, merge, live runs, inference,
  credential movement, public demo listener, or resource mutation.

### Publish stable timing and compact results follow-up (2026-09-09)

Approved at: 2026-09-09T15:18:35.910880+00:00

- Direct approval: the user asked to see the changes, push the branch and open
  the follow-up PR, noting that additional small tweaks would follow.
- Publish the reviewed stable-timing and compact-results branch and open a PR
  against the canonical repository. Include validation limitations and the
  inspected Harbor source files. Privacy-review all commits, diff and metadata.
- Prepare a loopback-only synthetic preview of this branch using the existing
  read-only fixture server; no real control API, credentials or inference.
- Additional unspecified tweaks await the user's concrete request.
- No merge, deployment, live run, paid resource, public demo listener, credential
  transfer, upstream Harbor publication or execution-policy change is authorized.

### Run navigation, recipe identity and reasoning refinements (2026-09-09)

Approved at: 2026-09-09T15:43:39.532868+00:00

- Direct request: distinguish native agent execution timeouts from replacement
  candidates, show Workbench recipe names in Runs, expose a working reasoning
  selector, and filter recorded diagnostic/final run roles.
- Implement and test these refinements locally for the existing follow-up.
  Preserve raw native exception types and distinguish execution timeout from
  environment/provider failures without claiming an unproven timeout origin.
- Capture minimal immutable Workbench recipe display provenance for new runs;
  retain historical fallbacks and native execution configuration in JobConfig.
- Investigate and expose reasoning only through an existing reviewed native
  agent/provider configuration path and declared recipe capability. Reject
  unsupported behavior rather than silently ignoring a dropdown selection.
  Preserve existing saved recipes and their execution semantics.
- Add role filters using the existing final/diagnostic field, with useful
  presentation-only search/navigation. Final role is not finished status.
- Replacement eligibility, rerun actions, upstream issues/patches, new storage
  resources, live execution, deployment, merge and credentials remain excluded.
- Additional publication of these refinements follows review of the concrete
  implementation; the existing PR remains open without merge or deployment.

### Shared run archive presentation metadata (2026-09-09)

Approved at: 2026-09-09T17:02:44.957655+00:00

- Direct approval: the user confirmed that archive status should be shared
  across users and browsers, following the proposed operator-only controls.
- Implement and test shared mutable run-presentation metadata in the existing
  canonical Bucket, separate from immutable run records and execution state.
- Provide authenticated operator Archive/Restore actions with write-mode and
  concurrency guards; default the Runs view to not archived and expose
  Not archived / Archived / All, combined with recorded role and search.
- Archive changes only Runs visibility. Execution, artifacts, costs, leaderboard
  eligibility and direct detail access remain unchanged. No deletion or rerun.
- Local implementation, tests, documentation and commits are approved. No live
  metadata mutation, deployment, merge, credentials or additional infrastructure.
- Browser-local pricing preferences and Workbench drafts are not migrated by
  this approval. Reasoning support still awaits route/capability clarification.

### Complete results follow-up CI, merge and deployment (2026-09-09)

Approved at: 2026-09-09T18:04:01.857234+00:00

- Direct approval: the user authorized pushing the remaining follow-up changes,
  getting CI green, merging and completing deployment to the user-selected
  existing control Space. The exact destination is retained privately.
- Resolve relevant CI failures without weakening tests, coverage, security or
  line-budget gates; review and publish changes to the existing PR. Merge only
  the reviewed passing revision, then deploy that exact merged source revision.
- Verify deployment provenance, readiness and unchanged canonical configuration.
  Preserve existing resources, credentials, visibility, hardware and artifacts.
- No benchmark/setup execution, inference, credential transfer, new resource,
  archive mutation on live data, or unrelated feature migration is authorized.
- Pricing sharing and the reasoning selector remain deferred. No operator
  identifiers may be included in public repository content or metadata.

### Sandbox SDK terminal-result integration

Status: completed

Approved at: 2026-09-09T17:44:31.882149+00:00

- The user explicitly approved preparing a Harbor-HF pull request consuming the reviewed Sandbox SDK terminal-result fix, alongside its upstream issue and PR.
- Implement a reproducible temporary dependency pin/build for the parent-worker SDK, with source/hash provenance, offline tests, documentation and explicit removal criteria. A local patched wheel build is approved. Preserve Harbor-owned execution, results, retry policy, task configuration and all unrelated work.
- Local commits, topic branch push and one Harbor-HF pull request are approved after checks and privacy review. No merge, deployment, image publication, package-index release, new Jobs/inference, credential movement, or remote resource/configuration changes in this step.


Implementation completed on 2026-09-09; branch/PR publication remains parent-owned:

- Backported exactly the production diff of SDK PR #4851, commit
  `f1c01f06919a5e57e57b6d78bc3d7e4de81534e0`, onto hash-verified 1.28.0.
  Chose a locally versioned reproducible wheel rather than the unrelated 1.31
  development upgrade. Source, patch, output hashes and removal criteria are in
  `packages/harbor-hf-agents/sdk-backport/README.md`; no binary is tracked.
- Both existing images build the wheel before frozen agents-lock installation.
  Local amd64 builds and 40 offline terminal regressions in each actual final
  image interpreter passed. Installed SDK source bytes and versions matched the
  wheel. Harbor's native Sandbox boundary, retries and results are unchanged;
  no task recipe or credential delivery changes were made.
- Root tests: 46 passed, 87.98% coverage. Agents tests: 155 passed. New builder:
  97.47% coverage. Ruff, formatting, ty, lock/source/dependency integrity, root
  dependency audit, and normal Slophammer check/DRY passed.
- Draft validation blockers: existing supplementary agent-runtime coverage is
  61.72%; the Slophammer baseline and mutation script are absent. No thresholds
  were relaxed. Separate npm/browser checks were not run for this Python/build
  change; the control image's normal typecheck and web build passed.
- No push, PR creation, deployment, image publication, remote Jobs, inference,
  credential movement or resource mutation was performed by this integration.

Completed on 2026-09-09: opened draft PR #198 (https://github.com/huggingface/harbor-hf/pull/198) after source, image and privacy review. It consumes the reviewed upstream SDK fix as a hash-locked release-wheel backport. Both local image environments passed 40 offline terminal regressions; existing coverage/tooling blockers are disclosed. No merge, deployment, image/package publication or remote workload was performed.


### PR #198 upstream-main conflict resolution (2026-09-09)

Status: completed

Approved at: 2026-09-09T18:23:27.991611+00:00

- Direct approval: the user asked to resolve the reported conflicts; the clarified scope is merging upstream main into the existing affected topic branch, not merging the PR into main.
- Merge latest upstream main into the existing PR #198 branch without rebase or force push, resolve conflicts preserving unrelated upstream changes and the reviewed SDK backport, run local checks, commit and push to the existing PR.
- Inspect SDK PR #4851 read-only; it is mergeable and no SDK branch modification is included.
- No PR merge, deployment, image/package publication, new issue or PR, remote Jobs, inference, credential movement, resource changes, or weakened validation gates. Stop if upstream dependency changes supersede or conflict with the backport.


Completed local integration on 2026-09-09; publishing this reviewed merge to the existing PR branch:

- Merged upstream main `c3558b6` (previous common base `b23acb9`) into the topic branch. Only `projects/huggingface/harbor-hf.md` conflicted; preserved both additive authorization histories. Upstream application files are byte-identical to main and the SDK backport, locks, Harbor pin and image build steps are unchanged from the topic branch.
- Root Ruff/format/ty, 46 tests with 87.98% coverage, dependency audit, normal Slophammer check/DRY and privacy checks passed. Agents Ruff/format/ty and all 155 tests passed; supplementary branch coverage remains 61.72%, below 85%. The baseline file and mutation script remain absent. No gate was weakened.
- Node checks passed: formatting, lint (existing shell-template warnings), types, build, generated files, 846 unit tests and dependency audit. Initial parallel browser run passed 52/53 with a navigation assertion failure; unchanged full serial rerun passed 53/53.
- Both local amd64 images rebuilt successfully; each actual final SDK interpreter passed 40 terminal regressions with networking disabled. The rebuilt wheel retained its recorded hash.
- SDK PR #4851 was mergeable and left untouched. PR #198 remains draft with existing validation limitations. No PR merge, deployment, image/package publication, remote workload, credential movement or resource change.

### PR #198 URL-filter race repair (2026-09-09)

Status: completed

Approved at: 2026-09-09T20:00:00Z

- Direct user approval: repair the real frontend URL-filter lost-update race on existing PR #198, with deterministic regression tests, local commits and push to that PR after privacy review and validation.
- Preserve query/history semantics, unrelated URL parameters, upstream frontend features and the SDK backport. Verify the original regression fails and the repair passes; run normal parallel browser checks and bounded read-only CI monitoring.
- No merge, deployment, new PR, image publication, remote Jobs, inference, credential movement, live API writes or gate weakening. Local synthetic browser servers are permitted. This scope does not activate any other authorization above.


Completed local repair and validation on 2026-09-09; publishing to existing PR #198:

- Filter events merge against the synchronous BrowserRouter URL, while React Router remains the sole navigation writer. No pending-state mirror or global routing changes; search replaces and selectors push. Preserve unknown parameters, history navigation, existing rows and archive behavior.
- Deterministic real-BrowserRouter/Suspense negative control: three regressions fail on the original handlers; all four tests pass with the fix, including deferred external navigation and POP edits. The existing browser sequence is unchanged except for an added final URL assertion.
- Formatting, lint (six existing warnings), both TypeScript checks, 850 unit tests, build, generated contracts and dependency audit passed. The complete synthetic browser suite passed 53/53 with two workers; six focused repetitions also passed with two workers and no retries. Local IPv4 startup stalled and was stopped; these browser passes used an isolated IPv6 harness without repository configuration changes. Normal CI remains authoritative for its standard IPv4 path.
- Supplementary global Node coverage remains below 85%: lines 80.92%, statements 78.87%, functions 80.41%, branches 73.15%. Normal Slophammer check and DRY passed; baseline and mutation commands remain blocked by their absent files. No gate was weakened.
- Reviewed Harbor JobConfig/viewer models at the existing pin and history through `7d5285b4`; console URL navigation belongs to Harbor-HF. Documentation records the BrowserRouter-specific boundary. SDK patch/build/locks, Harbor configuration and image definitions are unchanged; their full CI checks must still finish after publication.
- Main remains at `c3558b6`; no additional integration merge was needed. Self-review confirmed only filter navigation, tests and additive documentation/authorization changes. No merge, deployment, remote workload, credential movement or new publication destination. Remote CI monitoring is bounded to twenty minutes after push; no CI rerun is authorized to mask failure.

### Compact status display and pricing investigation (2026-09-09)

Approved at: 2026-09-09T18:28:46.784884+00:00

- Direct request: start a new branch, repair the oversized wrapping status
  bubble, and investigate recording a proper price for Workbench launches.
- Implement and test a compact status badge separate from measured agent time
  and coverage. Preserve visible partial/unavailable indicators and accessible
  exact coverage counts; no timing arithmetic or execution changes.
- Pricing is read-only investigation pending clarification of launch-time
  estimated rates versus actual provider-reported or billed costs.
- Local implementation, tests and commits only. No publication, merge,
  deployment, live run, inference, credentials, rate-card schema, billing
  integration or upstream issue/patch is authorized by this amendment.

### Immutable launch pricing and leaderboard estimates (2026-09-09)

Approved at: 2026-09-09T18:58:54.280302+00:00

- Direct approval: the user confirmed supplying input/output/cache USD-per-million
  rates at Workbench launch so estimated run cost can appear on the leaderboard.
- Implement optional immutable launch pricing in the existing run record,
  separate from native JobConfig, recipe/setup identity and provider-reported
  cost. Preserve old records and existing browser-local scenario preferences.
- Derive shared estimates from each run's own rates and reported native usage.
  Preserve missing data and explicitly label estimates and partial group subtotals.
  Do not claim billed cost or complete usage coverage, infer request tiers from
  aggregate tokens, or alter leaderboard grouping or reported-cost charts.
- Include rates in immutable submission conflict checks, not recipe compilation
  or setup attestation. Keep pricing disabled unless explicitly supplied.
- Local implementation, tests, documentation and commits are approved. No push,
  PR, merge, deployment, inference, live runs, new resources, billing integration,
  credential transfer, execution cost-policy change or upstream publication.

### Synchronize launch-pricing branch and validate CI (2026-09-09)

Approved at: 2026-09-09T19:31:11.563099+00:00

- Direct request: merge main and make sure CI passes, interpreted as merging
  current main into the compact-status/launch-pricing feature branch.
- Merge the latest main locally, preserve upstream fixes, resolve conflicts,
  and repair relevant CI failures without weakening validation gates.
- Privacy-review and push the feature branch. Open a PR to run the configured
  pull-request CI workflow; feature-branch pushes alone do not trigger it.
- No feature merge into main, deployment, live execution, inference, credential
  transfer, resource changes or unrelated feature work is included.

### Run inspection consistency and benchmark profile preparation (2026-09-09)

Approved at: 2026-09-09T21:06:42.168215+00:00

- Direct user confirmation approves local implementation and tests for aligned
  run-panel polling, clearly labelled running-Job elapsed time, Workbench
  reasoning selection and recorded intent, configured timeout hover details,
  launch-pricing visibility in the inference-cost KPI, and removing help cursors.
- Inspect the recent local benchmark configuration read-only and prepare a
  profile for the requested 50-task subset with three trials per task. Preserve
  exact task selection and provenance privately; do not copy operator-specific
  identifiers, credentials, logs or unrelated source artifacts into this repo.
- Local implementation, tests and commits only. No push, PR, merge, deployment,
  profile publication, live API writes, runs, inference, credential transfer,
  resource creation, upstream patch or upstream publication.
- Harbor retains timeout resolution and execution authority. Display configured
  settings accurately; do not invent resolved budgets or provider-effective
  reasoning. Preserve existing recipes and immutable run records.

Local implementation checkpoint (2026-09-09):

- Aligned run-panel polling at ten seconds; shared clock preserves waffle
  freshness and running-Job elapsed age during pending requests. Completed
  durations remain fixed. Removed help cursors while retaining tooltips.
- Inference-cost KPI now includes the existing immutable launch estimate when
  pricing was recorded, without replacing native reported cost or treating
  absent token usage as zero. Hover exposes only explicitly configured native
  timeout fields, never a locally resolved effective budget.
- Passed 905 unit tests and 60 synthetic browser tests, formatting, lint,
  types, build, generated checks, dependency audit and normal DRY checks.
  Existing supplemental global coverage remains below 85%; the baseline file
  and mutation script are absent. No gate was weakened.
- Checked Harbor models/job/config.py, models/trial/config.py,
  trial/trial.py and models/job/result.py at pinned revision
  dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e and cached subsequent history.
  No Harbor execution behavior is reimplemented. History freshness was not
  independently established through a new upstream fetch.
- Independent review found elapsed clocks froze during hanging queries; fixed
  with shared clock and negative-control browser tests on both affected pages.
- Reasoning remains blocked: native model-query parsing does not establish
  support when capability metadata is absent. No fake selector or changed
  starter recipe was introduced; upstream capability discovery is proposed.
- Exact recent 50-task union was identified privately, but its pinned registry
  source cannot be represented by the current Git-only benchmark preset.
  No substitute revision, public task artifact or live profile was created.
- No publication, deployment, live run, inference or credential movement.
  Authorization remains active for the unfinished local scope only.

### Native registry benchmark presets (2026-09-09)

Approved at: 2026-09-09T21:49:14.221952+00:00

- Direct user approval: extend benchmark preset schema and generic compilation
  to preserve native Harbor registry dataset references, allowing the exact
  previously identified 50-task subset with three trials per task. Generate
  contracts and add regression tests; prepare the exact profile privately.
- Preserve existing Git datasets and let Harbor resolve registry sources and
  task selection. No benchmark-specific parser or execution behavior.
- Investigate launch-rate correction options and the requested task read-only;
  no existing run metadata edits, task execution, repair or retry authorized.
- Local implementation, tests and commits only. No profile publication, push,
  PR, merge, deployment, upstream changes, live runs or credential transfer.

### Audited pricing corrections and combined pull request (2026-09-09)

Approved at: 2026-09-09T22:32:56.258274+00:00

- Direct user approval: implement an audited shared pricing correction that
  preserves immutable launch rates, without rerunning or changing execution.
- Include operator UI, validated durable correction history, concurrent-edit
  protection, shared estimate and leaderboard integration, and regression tests.
  Keep native reported cost, spend policy and browser scenarios independent.
- Commit, privacy-review, push the combined completed run-inspection and
  registry-preset changes with this feature, and open one pull request to main.
  Read-only CI monitoring is approved; disclose existing validation gaps.
- Supersedes local-only publication restrictions solely for this combined diff.
  No merge, deployment, live pricing correction, profile publication, run,
  inference, credential transfer, new infrastructure or upstream publication.
- Keep exact private task subset and provenance outside the public contribution.
  Reasoning selection remains blocked and is excluded from implemented scope.

Combined implementation ready for pull request (2026-09-09):

- Added separate bounded pricing audit history, operator-only revision-checked
  correction UI/API, fail-closed cached effective estimates and leaderboard
  integration. Original rates, native costs and execution remain unchanged.
- Independent review corrected failed-rebuild uncertainty and corrupt pricing
  cache isolation; regression negative controls fail against the original code.
- Completed registry-preset support preserves native pinned name/ref values;
  the exact requested private profile remains outside the public contribution.
- Passed 983 unit tests and 63 browser tests, formatting, lint, type checks,
  build, dependency audit, normal Slophammer and privacy review. Both Docker
  builds passed before the final projection-only review fixes. Prior Python
  verification passed 46 CLI tests with 87.98% coverage and 155 agent tests;
  no Python or worker source changes followed.
- Supplemental global TypeScript coverage remains below 85% (81.96% lines,
  74.50% branches). Baseline and mutation files remain absent. No gates or
  package line budgets were weakened. Generated outputs are deterministic;
  the normal generated-diff check is rerun after staging the candidate outputs.
- Full combined diff, all untracked contribution files and public metadata were
  independently privacy-reviewed. No private profile or operator data included.
- Harbor source evidence is documented in the pricing-correction and native
  registry preset documents. No upstream behavior or execution patch added.
- Publishing this combined branch and opening its PR only; no merge, deployment,
  profile publication, live pricing edit, run or credential transfer.

### Full benchmark preparation and metadata-only reasoning (2026-09-09)

Approved at: 2026-09-10T07:21:57.441003+00:00

- Direct user request approves local implementation and tests for full
  Terminal-Bench 2.1 preparation: all 89 tasks, five attempts each (445 trials),
  no task filter, with six hours of agent execution per trial replacing
  task-specific agent budgets. This is not a whole-run, setup or verifier limit.
- Use native JobConfig agent override_timeout_sec of 21600 and agent timeout
  multiplier 1; inspect native cap precedence and ensure no cap shortens it.
  Preserve minimal safe native agent settings through native and Workbench
  compilation; reviewed agent identity, environment and kwargs retain authority.
  No duplicate timeout fields or local timeout resolver. Stop for upstream gaps.
- Workbench reasoning is free text recorded verbatim in existing submission
  metadata, including numeric-looking and arbitrary model values. Define blank
  semantics, bound length and reject controls and credentials. Preserve old off
  submissions and recipes. No fixed dropdown, provider-effect claims, model
  query additions, environment binding or execution side effects. Recipe remains
  execution authority; show exact recorded intent in run detail.
- Prepare the full profile privately only after read-only native source evidence
  proves 89 tasks from the immutable registry source. Preserve resource defaults;
  CPU and concurrency approval are separate and no launch is authorized.
- Commit this authorization only before implementation. Leave implementation
  changes local and uncommitted. Run required validation without weakening gates.
  Preserve the original dirty checkout and private source artifacts.
- No push, pull-request update, merge, deployment, live profile publication,
  execution, inference, resource creation, credential movement, or upstream
  publication is approved. Earlier publication approval does not cover this scope.

### Publish reasoning metadata and six-hour budgets; update starter (2026-09-10)

Approved at: 2026-09-10T08:03:19.569001+00:00

- Direct user approval: add completed metadata-only reasoning and native six-hour
  agent-budget support to existing PR #200, commit and push the changes.
- Update the default Fast-Agent setup recipe to fast-agent-mcp==0.10.23.
  Preserve saved/custom recipes and existing run records; update matching
  default source, tests and documentation, and verify native compatibility.
- Run relevant validation, inspect the complete diff and public metadata, update
  PR description and monitor CI read-only. Exact private benchmark profiles
  and provenance remain outside public source; include only generic support.
- Supersedes prior local-only restriction for this reviewed combined scope. No
  merge, deployment, live profile publication, runs, inference, credential
  movement, new resources or upstream publication.

PR additions validation checkpoint (2026-09-10):

- Completed metadata-only reasoning and native per-trial six-hour agent-budget
  support. Safe reasoning text persists verbatim; credential-bearing draft text
  is removed at storage/load boundaries. Native override, multiplier and cap
  semantics are tested through both compilers, with other phase budgets intact.
- Updated matching default setup recipes to fast-agent-mcp==0.10.23; regression
  tests preserve previously saved versions and exact browser/server parity.
- Passed 1051 unit tests, 64 browser tests, 51 CLI tests with 88.35% coverage,
  155 agent tests, formatting, lint, types, builds, dependency audits and both
  Docker builds. Generated files are deterministic. Normal Slophammer DRY and
  privacy checks pass; baseline/mutation files and global coverage gaps remain.
- Independent review passed 254 targeted TypeScript and 22 CLI tests and cleared
  the complete addition diff and metadata for privacy and static correctness.
- Fast-Agent public v0.10.23 source tag exists and reviewed CLI/routing/output
  paths remain compatible. PyPI version endpoint returned 404 during review;
  default package installation is not verified and blocks deployment readiness.
- Updated main has a CLI conflict; no integration merge performed under this
  scope. Reconciliation must retain upstream cost validation without restoring
  the old Workbench reasoning-off restriction. Disclose both holds in PR #200.
- Publishing approved source additions only. No merge, deployment, live profile
  publication, rate correction, run, inference or credential movement.

### Integrate current main into PR #200 (2026-09-10)

Approved at: 2026-09-10T08:33:41.114483+00:00

- Direct request: merge main into the existing feature branch and walk through
  conflicts. Integrate current main, resolve textual and semantic conflicts,
  retain upstream campaign spend validation and organization authentication
  fixes together with metadata-only reasoning and existing feature behavior.
- Carry forward approval to commit and push this PR branch; update PR conflict
  status and monitor CI after full relevant validation and privacy review.
- This authorizes branch integration only, not merging PR #200 into main. No
  deployment, live profile publication, pricing edits, jobs, inference, new
  resources or credential transfers. Preserve all unrelated worktrees.

Main integration validation completed (2026-09-10):

- Integrated main at 43232ca. Only textual conflict was CLI reasoning admission
  beside campaign-cost validation; preserved validation and removed the obsolete
  off-only restriction. Migrated six active feature fixture locations to the
  campaign field while retaining deliberate historical compatibility tests.
- Organization authentication/configuration and parent worker behavior/tests
  remain byte-identical to main. Native six-hour settings, metadata-only
  reasoning, pricing corrections and saved-recipe preservation remain intact.
- Combined CLI regressions exposed acceptance of NaN; reused the existing
  ceiling validator to reject nonfinite/nonpositive/out-of-range explicit costs
  before HTTP, independently of optional local policy bounds.
- Passed 1059 unit tests, 64 browser tests, 100 CLI tests at 89.10% coverage,
  155 agent tests, formatting, lint, types, build, generated checks, dependency
  audits, normal Slophammer/DRY and both Docker builds. Independent complete
  staged/feature diff review and privacy review found no integration blockers.
- Supplemental global coverage remains below 85% (82.32% lines, 74.77% branches);
  missing baseline/mutation files remain disclosed. Existing starter package
  availability hold is unchanged; build success does not prove installation.
- Publishing this branch integration to PR #200 only. No merge into main,
  deployment, live profile publication, cost correction, jobs or inference.

### QEMU-fixed source and preset publication (2026-09-09)

Status: completed
Approved at: 2026-09-09T00:00:00Z

- Direct user YES: reuse or create the PUBLIC fork
  https://github.com/evalstate/terminal-bench-2-1 and publish only `qemu-fixed`,
  based on d49e28f1e4ddd13d289e85a5f312a66750951932 plus the reviewed two-task
  repair and immutable image references. Never overwrite a conflicting branch.
- Publish diagnostic, non-leaderboard-eligible `-qemu-fixed` variants of all
  relevant current Terminal-Bench 2.1 presets and a two-task, two-native-attempt
  smoke (four logical trials, concurrency two, retries zero). Preserve originals.
  Push only `feat/qemu-fixed-presets` to the canonical Harbor-HF repository;
  no PR, default-branch push, merge, deployment, run or model inference.
- Explicit public privacy exception: the exact GitHub fork above and
  `ghcr.io/evalstate/harbor-hf-trial-worker` image references may appear in
  public source, Harbor-HF presets and their authorization/provenance records.
  No other operator identifiers, credential values, aliases or local paths.
- Inventory exception: one approved public Git fork is needed because canonical
  benchmark write access is unavailable and native Harbor needs published task
  definitions. The canonical control Space and Bucket are unchanged; the
  existing GHCR package is retained. No additional repository, package, service,
  paid compute or recurring resource is authorized. Retain pinned source/images
  until upstream is fixed AND historical retention is satisfied; deletion needs
  explicit approval. Existing fork identity and parent must match before reuse.
- Verify image indexes/configs anonymously, source fetchability and native Harbor
  metadata only. Reuse prior reference-validation evidence without rebuilding
  or executing containers. No image push, visibility change, credentials sent to
  a runtime, upstream issue/PR or contact. Preserve unrelated worktrees.
- Approval is recorded before source implementation or publication. Date denotes
  this session's direct approval; exact approval time was not supplied.

QEMU-fixed implementation and validation checkpoint (2026-09-09):

- Reused the verified public fork and published only `qemu-fixed` at
  75f5a2e66b2dfd9d7eba3065a9d919c1f9da5c5e. Baseline and reviewed dependency
  repair were retained; only the two task image pins and README provenance were
  added. Anonymous linux/amd64 index/manifest/config checks passed.
- Native metadata resolved 89, 445 and four trials for the three diagnostic
  presets. Exactly two effective image/fingerprint changes; 87 peers and native
  order unchanged. No smoke, container, model, deployment or upstream PR.
- Passed 1,063 unit and 64 isolated browser tests, formatting, lint, types, build,
  generated checks, dependency audit, normal Slophammer and DRY. Default-port
  browser reuse was discarded; absent baseline/mutation tooling is disclosed in
  docs/terminal-bench-2-1-qemu-fixed.md. Topic publication remains the final step.

QEMU-fixed publication completed (2026-09-09):

- Verified public source branch at 75f5a2e66b2dfd9d7eba3065a9d919c1f9da5c5e
  and public Harbor-HF `feat/qemu-fixed-presets` at implementation commit
  258cedf8a9b041ace3f3bc9087a3f990ed9bc12c. This completion record is the final
  additive documentation-only commit on that same approved topic branch.
- Three diagnostic presets are published, not deployed. Native metadata counts,
  exact image pins, fingerprints and validation limitations are documented in
  docs/terminal-bench-2-1-qemu-fixed.md. No smoke or other benchmark was launched.
- No PR, merge, default-branch update, deployment, model inference, new compute,
  credential transfer, image upload or unrelated worktree change occurred.
  All managed validation processes ended; the discarded browser process stopped.

### Held-50 QEMU-fixed preset amendment (2026-09-09)

Status: completed
Approved at: 2026-09-09T00:00:00Z

- Direct user request: implement and push the held-50 fixed variant on the
  existing `feat/qemu-fixed-presets` branch. Record approval before implementation.
- Add one diagnostic `held-50-1-trial-qemu-fixed` native preset, documentation
  and focused tests. Verify the exact historical basic-48 plus upgrade-2 union
  against the held-50 list, not an inferred first-50 selection. Preserve that
  task set with current HF preset execution defaults, not historical hardware
  partitioning or provider settings.
- Local configuration, tests, metadata-only native resolution, commits and push
  to that existing branch are approved. Retain the already approved public fork
  and exact image/source references, pinned at
  75f5a2e66b2dfd9d7eba3065a9d919c1f9da5c5e. Existing privacy exceptions apply
  only to the previously specified public destinations and values.
- No PR, merge, deployment, Jobs, inference, source-fork changes, image builds
  or publication, upstream changes, credential transfers or new resources.
  Preserve original presets and unrelated worktrees. Keep private selection
  paths and source hashes outside tracked records. Approval time is unspecified;
  the timestamp records this session date only.

Held-50 implementation checkpoint (2026-09-09):

- Added only the single-attempt diagnostic preset, exact-membership regression
  and documentation. Both historical partition unions match the 50-task held
  list; source hashes remain private. Original presets and source fork unchanged.
- Pinned native metadata inspection resolved 50 tasks and 50 trials; both QEMU
  image references match the existing repair, and all 48 other task trees are
  byte-identical to baseline. No execution or inference occurred.
- Reviewed native DatasetConfig and Git dataset resolution at the existing Harbor
  pin and upstream history through 191d1b98; no runtime logic or pin change needed.
- Passed 1,064 unit tests, 64 isolated browser tests, formatting, lint, types,
  build, generated checks, dependency audit and normal Slophammer/DRY. Missing
  baseline and mutation-script limitations persist; no gate was weakened.
- Publishing only this reviewed amendment on the already approved topic branch.
  No PR, merge, deployment, Job, upstream change or credential movement.

Held-50 publication completed (2026-09-09):

- Remote topic branch verified at implementation commit
  ef78513a42d862d7bdd78ee409b3cc774e19a393 after a normal, non-force push.
  The authorization was committed separately before implementation.
- Published one held-50 diagnostic preset, not deployed or executed. Fork pin,
  original presets and unrelated worktrees remain unchanged. No PR was created.
- All managed validation processes completed. This additive completion record
  is the final documentation-only commit on the same approved topic branch.

### Digest-pinned image Job-name repair

Status: completed

Approved at: 2026-09-10T11:54:20.135423+00:00

- Direct user approval: make a minimal patch and pull request and deploy this low-risk change. Remove the image digest from the readable automatically generated Job name while preserving the actual immutable image reference and invocation hash.
- Approved: SDK implementation and offline tests, upstream topic-branch publication and matching PR; Harbor-HF temporary SDK backport, tests, topic-branch publication and PR; publish the reviewed existing worker image through the existing workflow and deploy the reviewed revision to the existing user-selected control Space.
- Preserve explicit names, ownership labels, task inputs, image digests, concurrency, costs, hardware, visibility, Bucket, persistent secrets, run records and unrelated work. Only the deployment source/image references may change as required for this fix.
- No repository default-branch merge, new resource, benchmark/setup/inference Job, retry, credential movement or historical-result mutation is authorized. Deploy the reviewed topic revision if not merged; do not infer upstream merge permission from deployment approval.

Completed on 2026-09-10:

- SDK PR: https://github.com/huggingface/huggingface_hub/pull/4859,
  immutable fix `3493b0d86bee92db7c10511c534cec455aa84df6`; 24 offline
  Jobs tests and SDK quality checks pass. Existing terminal-result PR unchanged.
- Harbor-HF draft PR: https://github.com/huggingface/harbor-hf/pull/205.
  CI passed at `4b83cebf95ac52617479a79f67b8d11f8479b2ad`; that exact
  unmerged topic source was deployed through the existing deployment script.
- The existing worker workflow published digest
  `sha256:8bc1364f1d91575d4895af0ead8153689a3d6713556dc3588791fd18fc466388`.
  The pulled image passed all 46 offline SDK regressions and exact wheel audits.
- The existing control service is RUNNING with JSON live/ready HTTP 200;
  release and runtime revisions match. Build logs confirm the locked SDK version
  and wheel hash. Parent/workbench image references match the published digest;
  other variables, hardware, visibility and persistent-secret metadata remain
  unchanged. No Jobs were launched and no active Jobs were observed.
- Root: 100 tests, 89.10% coverage. Agents: 161 tests; npm: 1,064 tests;
  browser: 64 tests. Both amd64 images pass offline installed-SDK tests.
  Existing supplementary agent coverage debt (67.12%) and absent baseline/
  mutation tooling remain disclosed; no gates were weakened.
- Neither PR was merged. This local completion record is not part of the
  deployed source; the PR/deployment source remains the exact commit above.

### Explicit Sandbox Job-name simplification

Status: completed
Approved at: 2026-09-09T00:00:00Z

- Direct user instruction: replace the SDK naming backport with a simple explicit
  short name in the existing Harbor-HF Sandbox wrapper, updating existing PR #205.
  The timestamp records the session date, not the time of the original decision.
- Approved: local adapter implementation, offline regression tests and image
  builds, commits, normal push to the existing topic branch, and PR description
  updates after privacy review. Preserve the separate exact terminal-result SDK
  backport, native Harbor trial identity, immutable image payload and ownership
  labels. Do not change unrelated work or merge main into the branch unnecessarily.
- No SDK repository changes or publication, reopening the closed SDK naming PR,
  merge, deployment, remote image publication, Jobs, retries, inference, credential
  movement or new resources in this implementation stage. Parent review precedes
  any later deployment decision; earlier deployment approval is not exercised here.

Wrapper-only implementation checkpoint:

- Replaced the naming backport with seven lines in the existing Sandbox adapter:
  an explicit, deterministic display name from Harbor's public environment name,
  capped at 90 characters. Explicit names/name labels and SDK conflict handling
  remain unchanged; ownership labels, namespace and full image/command payloads
  are preserved. No persisted field, identity, scheduler or new binding is added.
- Restored the terminal-only SDK builder, dependency pin, lock and source-audit
  tests to main exactly. Wheel SHA-256 is
  `922641bbf132546da041086e73d6cdfca7f13f4e63609580575699396a5a8df1`;
  only the existing exact terminal-result production patch remains.
- Checked Harbor environments/base.py and environments/hf_sandbox.py at
  dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e and history through 191d1b98.
  This uses public environment_name and HfApi.run_job(name=...), not a Harbor
  behavior backport. No relevant naming implementation has landed upstream.
- Root: 100 tests, 89.10% coverage. Agents: 178 tests. Both linux/amd64 images
  built locally and passed 63 offline cases each (40 terminal, 23 wrapper).
  All 183 installed SDK Python files match the terminal-only wheel, and each
  installed wrapper matches reviewed source. Ruff, formatting, ty, root dependency
  audit, normal Slophammer and DRY passed. The control image typecheck/build passed.
- Supplementary agent-wide coverage remains below 85% (62.13%; changed adapter
  87%). The baseline file and mutation script remain absent. No gate was weakened.
  No TypeScript changed; standalone npm/browser checks were not rerun locally.
- Ready for publication to existing PR #205 and parent review. This stage did not
  touch the SDK repository or its PRs, publish an image, deploy, merge, launch Jobs,
  retry work or move credentials. The earlier deployed source remains unchanged.
  Historical SDK naming approval/completion entries above are superseded for
  future work by the wrapper-only authorization, not permission to reopen that PR.

Wrapper-only publication completed (2026-09-09 session):

- Normal push verified implementation `9452bd3d62a4597e6587e9437495379e3376343b`
  on the existing topic branch. Updated PR #205 title/body to describe only the
  wrapper naming approach and unchanged terminal backport; draft status and
  existing empty label set preserved. CI is pending at this checkpoint.
- This completion record changes no runtime source. No SDK repository/PR change,
  deployment, image publication, merge, Job, retry or credential movement occurred.
  Local image and test processes finished. Parent review remains the next action.

### Six-hour fixed preset suite (2026-09-09)

Status: completed
Approved at: 2026-09-09T00:00:00Z

- Direct user request: add explicit six-hour per-trial agent execution variants
  for the fixed 89-task one-attempt and five-attempt presets (89/445 trials),
  and a fixed held-50 three-attempt preset (150 trials). Use the same six-hour
  agent budget for the held-50 addition and clearly document that choice for
  pre-publication review. Preserve every existing preset and default selection.
- Approves isolated local configuration, tests, documentation and commits on
  `feat/six-hour-fixed-presets`, followed by one canonical Harbor-HF push and PR
  only after parent review. Stop at local commits and a private PR draft until
  that review; this record does not bypass the publication hold.
- Inspect pinned native Harbor timeout precedence and subsequent history first.
  Use existing native configuration and compilation, with no duplicated timeout
  resolver. Verify effective 21600-second agent limits through both submission
  paths; preserve setup/verifier limits, concurrency eight, zero retries, source
  and image pins, held-50 membership and diagnostic/non-leaderboard status.
- Reuse only the previously approved public source and image references at
  75f5a2e66b2dfd9d7eba3065a9d919c1f9da5c5e, within their existing exact public
  destinations. No source-fork mutation or new privacy exception.
- No whole-run cap, launch, retry, inference, Jobs, merge, deployment, credential
  handling, resource creation, image publication or upstream mutation. Preserve
  unrelated worktrees. Run required local validation and privacy review without
  weakening gates. Timestamp denotes session date; exact approval time unknown.

Six-hour suite local preparation checkpoint (2026-09-09 session):

- Added 89/445-trial `with-6h-qemu-fixed` full variants and the 150-trial
  `held-50-3-trials-qemu-fixed` preset. Held-50 uses the same explicit six-hour
  agent budget; that choice is documented for parent review before publication.
- Native override 21600, null max cap and multiplier one survive both compilers
  and all expanded public JobPlan trials. Inspected pinned Harbor timeout source
  and history through 191d1b98; existing native support needs no runtime change.
- All eight old presets are byte-identical; catalog-first default, source/image
  pins, held-50 membership, diagnostic status and other phase limits preserved.
- Passed 1,140 unit tests, 64 isolated browser tests, 100 Python tests (89.10%
  coverage), formatting, lint, types, build, generated checks, dependency audits,
  normal Slophammer/DRY and privacy checks. Existing lint warnings and supplemental
  TypeScript coverage below 85% remain; baseline/mutation files are still absent.
- Local commits and private draft only. No push or PR yet; parent review remains
  required. No launches, retries, inference, Jobs, merge, deployment, credential
  transfer, source-fork mutation, new resource or image publication occurred.

Completed after review: published the three-preset suite in draft PR #206 (https://github.com/huggingface/harbor-hf/pull/206), with the shared six-hour held-50 budget and existing validation limitations explicitly documented. No merge, deployment or execution occurred.

### Command-agent effective workdir correction (2026-09-09)

Status: approved
Approved at: 2026-09-09T00:00:00Z

- Direct user approval: a small local CommandAgent adapter fix and offline
  regressions using Harbor's public execution API to honor explicit task workdir
  and image defaults consistently for setup, run and workspace bindings.
- Local code, tests, documentation and commits on `fix/command-agent-workdir`
  are approved. Branch push and one PR require parent review first; prepare a
  private draft and stop before publication. Timestamp denotes the session date.
- No merge, deployment, image publication, Jobs, retries, reruns, inference,
  credential movement, upstream changes or unrelated modifications. Preserve
  existing worktrees, Harbor ownership and validation/privacy gates.

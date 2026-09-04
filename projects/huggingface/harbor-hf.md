---
schema_version: v1
slug: huggingface/harbor-hf
repository: https://github.com/huggingface/harbor-hf
default_branch: main
---

# Harbor-HF

> **Superseded runtime note (2026-09-02):** Harbor-HF now uses Harbor-first
> direct inference through the resolved `AgentConfig`. Earlier authorization
> text about an intermediary inference process and the removed harness is
> retained only as a factual record of what was approved at
> that time. It does not authorize new implementation, deployment, launch,
> retry, recovery, or publication on those retired paths. Current operations
> follow `docs/CONTROL_SERVICE.md`, `docs/harbor-integration-contract.md`, and
> `.agents/skills/harbor-hf/SKILL.md`.

## Current authorization

Status: approved
Approved at: 2026-08-17T06:48:55Z
Amended at: 2026-09-02
Direct-inference documentation amendment approved at: 2026-09-02
Harbor-first implementation amendment approved at: 2026-09-02T12:17:25Z
Harbor-first implementation amendment completed at: 2026-09-02T13:09:16Z
Harbor-first commit-and-push amendment approved at: 2026-09-02T13:20:28Z
Harbor-first commit-and-push amendment completed at: 2026-09-02T13:21:41Z
Harbor-first deployment amendment approved at: 2026-09-02T13:53:54Z
Harbor-first deployment amendment completed at: 2026-09-02T14:39:30Z
Canonical Bucket reset amendment approved at: 2026-09-02T14:59:25Z
Workbench installer-variable amendment approved at: 2026-09-02T15:03:05Z
Post-reset installation-repair amendment approved at: 2026-09-02T16:00:27Z
Amended at: 2026-09-01T18:11:42Z
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
Agent-Workbench amendment approved at: 2026-08-27T14:35:22Z
Agent-Workbench FX-example-and-push amendment approved at: 2026-08-27T22:02:30Z
Agent-Workbench canary-activation amendment approved at: 2026-08-28T07:28:34Z
Canonical work-remote amendment approved at: 2026-08-28T07:44:34Z
Private Harbor-HF recovery amendment approved at: 2026-08-28T08:21:01Z
Run-native profile migration amendment approved at: 2026-08-28T08:58:58Z
Agent-Workbench recipe-and-UX repair amendment approved at: 2026-08-28T15:38:33Z
Agent-Workbench upstream integration amendment approved at: 2026-09-01T08:56:03Z
Agent-Workbench upstream push amendment approved at: 2026-09-01T09:56:29Z
Mutation-tooling retirement amendment approved: 2026-08-26
GLM-5.3-Flash full-run amendment approved at: 2026-09-01T11:12:25Z
GLM-5.3-Flash streaming-replacement amendment approved at: 2026-09-01T14:07:05Z
Historical-Run continuation amendment approved at: 2026-09-01T18:11:42Z
Historical-Run continuation worker-repair amendment approved at: 2026-09-01T22:13:57Z
Historical-Run continuation successor-repair amendment approved at: 2026-09-02T07:03:36Z

### Execution-disabled integration amendment (2026-09-04)

Status: completed
Approved at: 2026-09-04T16:01:01Z
Completed at: 2026-09-04T16:23:54Z

- The user explicitly approved proceeding with execution-disabled integration:
  merge fresh main into `feat/leaderboard-submissions`, reconcile authoring UX
  with Harbor JobConfig, push only that feature branch without force, and open
  or update one visibility PR against main. Do not merge the PR or push main.
- Remove unsupported parent-worker execution, private Harbor or Hub patches,
  and control-credential forwarding. Fail closed before Job admission,
  reservations, Run actions, or execution credential resolution. Disable launch
  and remote setup tests with a clear explanation; never return accepted Runs.
- Preserve configure/save/load of immutable named harness configurations using
  Harbor-accepted JobConfig fragments. New Run may preview only without remote
  preparation. Do not restore removed profiles, invent Harbor-owned execution,
  discovery, lock resolution or retry behavior, or add a parallel reconciler.
- Preserve historical records and authorization history, the two-secret
  configuration, and the control-only HF_TOKEN boundary. Neither persistent
  secret is forwarded on the disabled path. No private Harbor patch is approved.
- Future per-user OAuth scopes, user-account billing, and Jobs/inference
  delegation are separate research for the parent agent, not implementation
  authority. No token forwarding or new credential store is authorized.
- No HF operational calls, deployment, Jobs, inference, spending, resources,
  credential transfers, reset, migration, or Run actions are authorized.
- Run required local checks and production Docker build, add security/API and
  browser regressions, and disclose failures without weakening thresholds.
  Publish a draft PR for intentionally disabled execution or incomplete gates.
  Check public privacy and full actual diffs and metadata before every commit,
  push, and PR. Include the pinned Harbor revision and files reviewed in the PR.

### Upstream compatibility, feature reconciliation, and PR visibility (2026-09-04)

Status: approved
Approved at: 2026-09-04T15:25:00Z

- Direct user approval: "see if they are compatible with our direction, merge
  and push (open a PR for visibility)". Review fresh canonical upstream main
  and all feature changes against the greenfield first-install direction.
- If safe, merge current `origin/main` into `feat/leaderboard-submissions`,
  reconcile implementation and tests with Harbor JobConfig and the parent-Job
  architecture, commit, push only that feature branch without force, and open
  one PR targeting main (or update its existing PR). This does not authorize
  merging the PR, pushing main, rebasing published history, or resetting.
- Workbench configures, tests, and saves named immutable harness versions;
  New Run selects benchmark subset, built-in or saved harness, model string,
  and cost ceiling. Profiles belong in Advanced. Do not restore obsolete
  five-profile admission or introduce a parallel reconciler. Existing-install
  upgrade support is not required; preserve historical immutable bindings.
- Read pinned Harbor source and subsequent history before implementation.
  Stop for an unresolved Harbor-owned gap or material unsafe incompatibility;
  no local Harbor patch or upstream issue or PR is authorized.
- Run required local checks, including production Docker build and integration
  regressions. Do not lower coverage or conceal failing gates. Use a draft PR
  if required checks remain red or incomplete; do not claim deployment or
  merge readiness. Check privacy and inspect complete diffs and public metadata
  before every commit, push, and PR publication.
- No HF API work, deployment, activation, Jobs, inference, spending, resource
  creation or retirement, credential access or transfer, Bucket reset, data
  migration, or real result publication is authorized. Earlier operational
  approvals do not expand this task.

### Harness library and New Run UX amendment (2026-09-04)

Status: approved
Approved at: 2026-09-04T14:12:04Z

- Directly approved local implementation and tests for the proposed Workbench
  configuration flow: installation commands and settings, optional setup testing
  as a user-facing goal, and named immutable versioned harness presets selectable
  alongside built-in harnesses in New Run. New Run presents benchmark subset or
  size, harness, model string, cost ceiling, and review before launch. Move the
  mixed profile registry and provider or Endpoint details into Advanced without
  bypassing server-side compatibility, authorization, or credential safeguards.
- This initial pass is read-only upstream and architecture review plus this
  authorization record only. Do not implement yet. Compare the pinned Harbor
  source with freshly fetched public upstream history, identify landed features,
  pin-upgrade effects and execution-owned gaps, and return a concrete plan.
- Subsequent local implementation may cover wrapper-owned preset storage,
  library, UI, and Harbor configuration submission after the review establishes
  a safe path. Store accepted Harbor configuration rather than duplicate its
  fields. Preserve old Run locks and saved recipe revisions; do not silently
  recompile, promote, migrate, or reinterpret them on a pin upgrade.
- A saved preset or successful setup test is not execution approval. Do not
  bypass immutable profile or reviewed-worker gates in the current runtime to
  simulate unrestricted model selection or optional setup. The simplification
  plan's credential decision and paid-test preconditions remain unsatisfied by
  this amendment; no runtime cutover or gate waiver is authorized here.
- Stop and report any missing Harbor-owned execution behavior with a proposed
  upstream change. No local Harbor patch, upstream issue, or upstream pull
  request is approved. Reuse landed upstream features instead of implementing
  them in Harbor-HF; any later pin update requires local compatibility checks.
- Local authorization and implementation commits are permitted after privacy
  review. No push, pull request, merge, release, deployment, activation, benchmark
  or setup Job, inference, spending, new resource, credential access or transfer,
  reset, migration, or real result publication is authorized by this amendment.
  Do not inherit publication or deployment permission from earlier milestones.
  Earlier deployment records remain intact and are not closed by this work.

### Workbench saved-configuration milestone (2026-09-04)

Approved at: 2026-09-04T08:35:55Z

- Implement and test a canonical-Bucket benchmark catalog and named durable
  Workbench configuration Save/Load for the existing fast-agent and FX paths.
  Keep the existing execution mechanism; do not perform the proposed runtime
  cutover or add a second control authority.
- Simplify the configure, save, select benchmark, confirm, run, and saved-result
  flow. Treat small/medium/large benchmark sizing as guidance rather than a
  guaranteed monetary bound. Preserve existing execution safeguards.
- Deploy the reviewed change to the user-selected existing test control Space
  only after confirming canonical ownership and resource identity. Verify one
  small diagnostic smoke run; do not expand this approval into full benchmark
  cohorts, endpoint work, billing changes, or recurring resources.
- The user approved proceeding and expressed tolerance for benchmark spending,
  without specifying a replacement numeric ceiling. Retain the existing
  diagnostic configuration ceiling for this milestone; ask before increasing it.
- No new resource, credential transfer, public result publication, upstream
  Harbor mutation, merge, or default-branch push is authorized. Keep private
  identifiers out of tracked files. Local authorization and implementation
  commits are permitted; public publication requires its own scope review.

### Credential-minimization follow-up (2026-09-04)

Approved at: 2026-09-04T09:04:31Z

- Verify public Hugging Face documentation for OAuth access to personal Buckets,
  permission granularity, token lifetime, and user submission to the shared
  leaderboard. Report unsupported or unverified provider capabilities honestly.
- Remove the installer's unconditional Endpoint-management permission requirement
  for the Jobs-based installation. Preserve required Job and canonical-Bucket
  permissions and existing credential boundaries; test the narrower acceptance.
- Local implementation and authorization commits are permitted. Do not deploy,
  transfer or replace credentials, revoke permissions, create resources, launch
  paid work, or publish results as part of this follow-up.
- Personal-Bucket delegation and a new leaderboard submission workflow remain
  design work, not approval to implement new storage or publication authority.

### Leaderboard submission and presentation milestone (2026-09-04)

Approved at: 2026-09-04T09:14:11Z

- Prioritize authenticated user result submission with separate administrator
  review and publication. Reuse the canonical Bucket, current result/evidence
  contracts and publication authority; do not grant submitters operator access.
- Support selection of authorized hosted results and bounded external Harbor
  bundle intake where the existing Harbor validation boundary supports it.
  Preserve provenance and never label external uploads as verified execution.
  Report Harbor gaps rather than adding Harbor-owned behavior locally.
- Tidy the frontend for a presentable desktop/mobile submission and review flow,
  including clear permissions, states, confirmation, and publication copy.
- Implement, test, document, and make local commits. Prepare for the user's own
  deployment and testing. Do not deploy, launch paid work, publish actual results,
  transfer credentials, create resources, push, or merge in this milestone.
- Personal-Bucket OAuth delegation remains deferred. No new credentials or
  persistent resources are authorized. Existing privacy and check gates remain.

### Feature-branch publication and test deployment (2026-09-04)

Approved at: 2026-09-04T10:29:15Z

- Create `feat/leaderboard-submissions` from the completed local milestone and
  push that branch to the canonical GitHub repository. Publish only reviewed,
  privacy-checked code and metadata. No pull request, merge, or default-branch
  push is authorized.
- Deploy the exact committed branch revision to the previously selected existing
  test control Space after verifying its canonical Space/Bucket ownership and
  deployment provenance. Use the supported existing-install workflow, preserving
  credentials, hardware, protection, Bucket data, and reviewed worker settings.
- The user requested deployment after the remaining coverage, audit, and missing
  tooling failures were disclosed. This is a test deployment request, not a
  declaration that those checks pass or permission to lower their thresholds.
- Read-only provenance and activity inspection is permitted. Stop on uncertain
  resource ownership, installer binding mismatch, unexpected credential requests,
  active work that makes reconfiguration unsafe, or failed deployment verification.
  Do not fabricate missing source markers or replace private installer state.
- No new resources, credential transfer/replacement/revocation, paid benchmark
  launch, external-result migration, or actual public leaderboard publication is
  authorized by this request. Enable application writes only after verifying the
  existing installation and confirming no queued work would be launched.

### Installer metadata reconciliation (2026-09-04)

Approved at: 2026-09-04T10:50:12Z

- Reconcile the existing test installation's source and bundle metadata against
  the verified deployed release and paired canonical resources, then continue
  the approved exact-source deployment on `feat/leaderboard-submissions`.
- Establish the current deployed source and file digests from immutable evidence
  before restoring metadata. Preserve the installer ownership ID and existing
  private state; do not fabricate provenance or discard receipts to bypass checks.
- Preserve secrets, Bucket contents, hardware, protection, and reviewed worker
  settings. No credential transfer, resource creation, benchmark execution,
  publication of real results, or legacy-result migration is approved.
- Use the supported installer sequence after reconciliation. Verify source,
  health, authentication, and idle control state before enabling writes. If a
  further unexplained mismatch prevents proof, stop and report it.
- Commit and push the authorization and any sanitized operational documentation
  to the approved feature branch only; no default-branch push or merge.

### Browser-authenticated installer verification (2026-09-04)

Approved at: 2026-09-04T11:01:54Z

- Replace the installer's bearer-only activation requirement with verification
  through the existing HF browser OAuth login. Implement and test this local
  installer change without adding a new service credential, OAuth application,
  server authentication authority, or persistent credential store.
- Keep browser authentication scoped to the exact planned control origin and
  operator identity. Do not export session cookies, copy local management
  credentials into the browser or Space, persist browser login state, or log
  credentials. Preserve existing source, health, write-mode, and activity gates.
- Commit and push reviewed changes to `feat/leaderboard-submissions`, then
  continue the previously approved provenance reconciliation and test deployment.
  Browser sign-in may require the user's interactive participation; never bypass
  it or claim authenticated verification without observing success.
- Existing constraints remain: no new persistent resources, credential transfer,
  benchmark execution, result publication/migration, default-branch push, or merge.

### Scope

- Diagnose the failed post-reset installation using sanitized read-only
  provider state and logs, implement and test any general installer or control
  startup repair required, commit and push the reviewed repair only to
  `feat/agent-workbench`, and retry the existing-resource
  `install:plan`/`install:configure`/`install:verify`/`install:activate`
  sequence. The repair may upload source, pause, restart, and update
  installer-owned variables on the existing canonical `<control-space>`, but
  must preserve its existing secrets, reviewed Workbench variables, hardware,
  protection, and canonical `<artifact-bucket>`. Keep writes disabled until
  verification succeeds. Do not provision or create resources, replace or
  retrieve credentials, publish an image, launch a setup or benchmark Job or
  Run, call inference, publish results, merge, or update the default branch.
  If the repaired installation cannot be verified, leave writes disabled and
  the Space paused.
- Preserve the existing reviewed `HARBOR_HF_WORKBENCH_RUNNER` and
  digest-pinned `HARBOR_HF_WORKBENCH_IMAGE` values in installer plans and
  phase transitions so the supported npm existing-install workflow accepts
  and retains the hosted Workbench configuration. Add deterministic tests,
  commit and push the repair before continuing the approved Bucket reset.
  Do not expose variable values, broaden accepted variable names, change the
  values remotely, or alter secrets, hardware, protection, resources, or Run
  state.
- Disable control writes, delete all application objects
  from the one live canonical artifact Bucket while preserving its single
  installer ownership marker and the Bucket resource, then use the supported
  existing-install npm sequence (`install:plan`, `install:configure`,
  `install:verify`, and `install:activate`) to deploy the exact latest
  `feat/agent-workbench` revision. Do not run `install:provision`, replace or
  retrieve existing secrets, change hardware or protection, republish the
  worker image, launch setup or benchmark Jobs, call inference, publish
  results, create resources, merge, or update the default branch. Verify a
  fresh projection, enabled write mode, and visibility of the 21 pinned
  deployment profiles. The deleted application records are intentionally not
  recoverable; if installation fails after deletion, leave writes disabled and
  stop rather than creating replacement resources.
- Publish one immutable `linux/amd64` trial-worker image
  from the reviewed Harbor-first branch, pin its real digest and source revision
  in every active compatible deployment profile, recompute profile identities,
  commit and push those pins to `feat/agent-workbench`, deploy that exact final
  revision to the existing canonical control Space, and verify service health
  plus approved profile visibility. Use only the existing Space, Bucket,
  secrets, image package, and branch. Do not launch a Workbench setup Job or
  benchmark Run, call inference, publish benchmark results, create resources,
  change hardware, merge, or update the default branch. If the control service
  fails health checks, restore only the immediately preceding known-good
  control revision.
- Commit the completed and locally verified Harbor-first refactor, including
  its source, tests, profiles, generated artifacts, documentation, and
  instruction updates, then push the current `feat/agent-workbench` branch to
  its tracked `origin` branch. Do not deploy, publish an image or package, run
  inference, use credentials beyond Git transport, merge, or mutate hosted
  runtime resources.
- Complete the already-started Harbor-first code refactor,
  remove the remaining active root Python provider proxy and its scoped routes,
  placeholder credential, request enforcement, isolation evidence, and cleanup,
  update affected tests and generated artifacts, and run local verification.
  No deployment, publication, credential use, inference, paid work, push, merge,
  hosted mutation, or remote resource change is included.
- Rewrite the documentation and repository instruction surface for
  Harbor-first direct inference, remove active guidance for the retired
  inference intermediary and request-accounting design, remove active support
  for the retired harness, preserve clearly marked historical facts, and
  restore `AGENTS.md` and `.agents/` as the canonical instruction paths. Do not
  edit code, tests, or `docs/agent-workbench.md`.
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
- Run one controlled phase-one installer apply against the operator-selected existing test installation to capture the sanitized HF failure category or complete creation of its canonical private Bucket and local ownership receipt.
- Diagnose and complete phase one for the operator-selected installer test installation autonomously, using the active local write-capable Hugging Face credential for bounded plan/apply retries and direct Bucket probes.
- Complete one bounded phase-two recovery for the operator-selected installer test installation using its exact prior private plan and existing remote credential names.
- Reset the operator-selected test installation after confirming that its marked Space is absent and its remaining private Bucket is empty, then recreate phase one.
- Complete one bounded source-staged retry after the operator installed both expected credential names interactively.
- Diagnose and complete the operator-selected installer test installation autonomously within its existing two-resource, free-hardware boundary.
- Add guarded installer commands for canary activation, production promotion, and emergency write disablement.
- Expand the README with an agent-oriented hosted-installation runbook and execution model that distinguishes the local npm installer, local Python operator CLI, hosted control service, reconciler, and remote workers.
- Replace the implicit two-pass apply and installer canary workflow with explicit provision, configure, verify, activate, and emergency-disable commands. Activation enables the inspected installation without changing hardware, transferring credentials, or embedding benchmark, model, or harness names in runtime policy.
- Fetch the canonical upstream default branch, preview and merge it into the current local topic branch, resolve any conflicts without discarding either side's intended behavior, and verify the integrated tree.
- Fetch the latest canonical upstream default branch and merge it into local `tweaks`, preserving local commits, installer behavior, and reviewed security behavior. Resolve mechanical conflicts, run relevant and full validation plus the public-privacy check, and commit the verified merge locally.
- Fetch the latest canonical upstream default branch for a third local integration cycle and merge it into `tweaks`, preserving local commits, installer behavior, and reviewed security hardening. Resolve mechanical conflicts, run relevant and full validation plus the public-privacy check, and commit the verified merge locally.
- Repair the pull-request CI cadence test so it isolates scheduled Bucket synchronization from terminal worker-receipt safety synchronization. Run focused and full validation, commit the verified test repair locally, and push the resulting commits only to the tracked public `tweaks` branch.
- Harden installer credential acceptance with a fresh exact-Bucket create/read-back probe before storing a proposed control credential, and make owner-only installer operation locks safely reclaimable after confirmed process death or host reboot.
- Require exact non-mutating fine-grained scope attestation before storing a proposed control credential, make source-staged recovery stop on receipt/Space SHA drift without overwriting attested source, and remove credential checks that enumerate durable control records.
- Remove installer credentials from advisory-lock subprocesses, make resources-only provisioning reject any installation where configuration has started, and serialize verification with all per-target installer operations.
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
- Retire mutation testing completely from the root project and Harbor agent package. Remove mutmut dependencies and configuration, mutation runner scripts and workflows, package-publication mutation preflights, active developer instructions, documentation, and lockfile entries. Preserve ordinary deterministic pytest regression tests whose filenames use `mutation_contracts`; they do not invoke mutation tooling.
- Add a leaderboard snapshot in the existing canonical `<artifact-bucket>`: a configuration digest, mechanical eligibility, and a derived SQLite file of the rows shown on the board. Keep one Space and one Bucket.
- Make the official leaderboard the Space default route and allow anonymous `GET /api/v1/leaderboard`. The current operator dashboard moves to `/overview` behind a "Run benchmark" button and Hugging Face login.
- Integrate the requested dashboard harnesses as Harbor agent plugins behind the existing campaign path: OpenCode, Qwen Code, mini-swe-agent, Pi, Kimi Code, Hermes, Codex, OpenHands, OpenClaw, and Claude Code. Prove each with one Terminal-Bench 2.1 two-task canary. Reject a harness that needs a native API the locked Hugging Face router route cannot preserve.
- Fix zero-token selection, fail-closed task exhaustion, campaign completion, publication commit safety, cooperative pause and resume, and append-only publication supersession. After the reviewed implementation is merged and deployed, run one fresh full 89-task Terminal-Bench 2.1 single-trial diagnostic campaign with worker concurrency eight to validate the rolling scheduler and produce a clean replacement publication.
- Finish the active diagnostic campaign. Fix and deploy terminal Job reservation settlement, recover only unresolved tasks through isolated one-task Jobs, publish the complete result, and append the required supersession record.
- Treat Harbor environment-setup failures as infrastructure, retry transient evidence-upload HTTP 500 responses, and keep an execution Job running after one task fails to upload evidence. Deploy that reviewed revision, then retry only eligible infrastructure failures on the existing gpt-oss OpenCode Terminal-Bench 2.1 single-trial campaign. Add a run-page control and CLI `--all-eligible` that call the existing per-task infrastructure retry path.
- After the gpt-oss OpenCode 89-task single-trial diagnostic exists, run the same Terminal-Bench 2.1 one-trial diagnostic for the other Chat Completions harnesses that already have a two-task canary: Qwen Code, mini-swe-agent, Pi, Kimi Code, Hermes, OpenHands, and OpenClaw. Use `openai/gpt-oss-20b` on Together, reasoning off, publication role diagnostic, and the existing promoted profiles. Do not add a campaign for OpenCode. Reject Codex and Claude Code on this route because they need a native API the locked Chat Completions router cannot preserve.
- Install Harbor from a pinned `harbor-framework/harbor` git commit instead of a PyPI release so new campaigns can evaluate harnesses as they land upstream. Remove the Harbor 0.21.0 empty-metrics sitecustomize workaround after that pin includes PR 2681. Deploy the reviewed revision. Existing campaign locks keep their Harbor pin.
- Make the namespace Sandbox cap an operator setting with default 16, then set the live service to 128 so the existing 89-task diagnostics can start more Sandboxes at once. Campaign ceilings stay unchanged. Existing campaign locks keep their per-run `max_sandboxes` and worker concurrency.
- Replace the Campaign concept with Run throughout source, contracts, durable records, API routes, CLI, web UI, tests, profiles, and documentation. Do not retain Campaign aliases or a compatibility API.
- Replace nested Sandboxes with one Hugging Face Job per physical trial attempt. A trial records the ordered list of Jobs that attempted it and selects a result only from a valid attempt receipt. A failed Job may create a replacement only for an eligible infrastructure failure within the locked attempt and budget limits.
- Remove logical-task pagination from the run detail and fix general control-Space responsiveness as part of the Run-native redesign.
- Delete every run-derived object from the canonical Bucket, including run locks, actions, tasks, attempts, evidence, publications, normalized results, catalogs, and leaderboard snapshots. Preserve ACLs, profiles, promotions, capacity policy, canonical resources, and credentials.
- After the redesigned service passes an unpaid control canary and a bounded paid task canary, launch fresh Terminal-Bench 2.1 single-trial runs for the Chat Completions harnesses with explicit launch authorization.
- Harden worker retries across control-service projection rebuilds, delete only the seven fresh Runs whose final preparation Jobs failed on `control_not_ready`, and launch one replacement Run for each same authorized harness after the hardened path passes its canaries.
- Repair the single detected Job admission-chain fork by deleting only its orphaned admission object, which has no dispatch, receipt, capacity release, advancement, or remote Job. Preserve its action intent and every other Run record. Add startup projection catch-up, deploy the reviewed revision, and restart the existing control Space.
- Build a user-friendly Agent Workbench for private customer-authored command-agent configurations. Support editable setup and run commands, typed environment bindings, redacted expansion previews, immutable execution revisions, setup-only tests, streaming logs, bounded private file browsing, result access, and direct transition from setup verification to a small benchmark run.
- Add one generic Harbor command-agent plugin behind the public agent interface. Keep install and execution commands, environment bindings, output declarations, and optional trace normalization as immutable configuration data. Harbor remains authoritative for task execution, verifier rewards, locks, results, and trial exceptions.
- Add a Fast-Agent 0.10.11 starter configuration that uses the command-agent path and supports a locked model route plus `--base-url`. Accept direct ATIF output when present without making normalized traces a prerequisite for private diagnostic verifier results.
- Exercise the Workbench end to end in the local control service and browser, including screenshot-based review, hostile-output rendering checks, setup logs, workspace browsing, command previews, and user-facing failure recovery.
- After all local gates pass, optionally deploy the exact reviewed revision to the existing canonical `<control-space>` and run bounded setup and diagnostic trial canaries through the existing control path. Use no new persistent resource and preserve every unrelated Run and control record.
- Activate the reviewed Fast-Agent Workbench canary path: keep Slophammer's Python mutation-declaration rule disabled, remove mutation execution from the mandatory local completion gate while retaining the on-demand tooling, push only `feat/agent-workbench`, publish one reviewed digest-pinned generic trial-worker image from the exact committed revision, add its compatible deployment and diagnostic launch-policy profiles, deploy the exact reviewed control revision to the existing canonical `<control-space>`, verify setup through the Workbench setup path, and submit one normal Run using `terminal-bench-2-1-canary`, `gpt-oss-20b`, and the reviewed Fast-Agent command-agent harness.
- Repair the Agent Workbench after the first Fast-Agent diagnostic: keep CLI installation and runtime provisioning in immutable recipes so Python/uv, npm/npx, and other ecosystems use the same generic command-agent path without core name branches; update the reviewed Fast-Agent recipe and route binding; make the Workbench workflow explicitly communicate configure, test, publish, and Run stages; consolidate or clearly distinguish setup and execution logs; improve reviewed-profile loading and failure states; correct deterministic setup and client-configuration outcome classification; test, commit, push, and deploy the exact reviewed repair; then launch one new two-task diagnostic canary under the same limits.
- Make the canonical `huggingface/harbor-hf` repository the normal work remote for this checkout. Rename that remote to `origin`, retain the former fork as a secondary `fork` remote, push `feat/agent-workbench` directly to the canonical repository, and use the canonical repository's existing Actions workflow and package permission for worker-image publication.
- Run one final Terminal-Bench 2.1 full evaluation with all 89 tasks and one trial per task, using the existing promoted GLM-5.3-Flash Together deployment and Pi 0.84.2 with reasoning off.
- Cancel only the GLM-5.3-Flash plus Pi full Run invalidated by the pre-streaming inference bridge after its admitted Jobs reach evidence boundaries, then launch exactly one clean 89-task replacement using the fixed streaming worker.
- Add one append-only execution-continuation attachment to each of the seven approved historical gpt-oss 89-task Runs so the current TypeScript control service can finish only their unresolved tasks without changing Run IDs or rerunning selected outcomes.
- Add one immutable worker-repair attachment to each of those seven continuation records. Bind each repair to its original continuation and permit only the digest-pinned worker image and source revision to change. Preserve Run IDs, ceilings, prepared inputs, harness, model, provider and inference settings, evidence, and selected outcomes. Prove the repair with one unresolved OpenHands task before admitting the remaining work.
- Add one immutable successor worker-repair attachment to each of those seven existing repairs after the first repair-aware worker exposed a cross-language continuation-digest defect. Bind each successor to the original continuation and prior repair digests, and permit only the digest-pinned worker image and source revision to change. Preserve every existing record, Run ID, ceiling, prepared input, harness, model, provider and inference setting, evidence item, and selected outcome. Prove the successor with the same unresolved OpenHands task before admitting the remaining work.

### Limits

- Deploy an exact merged source revision with writes disabled first.
- Use `cpu-upgrade` at USD 0.03 per active hour for the always-on control service.
- Keep total project spend within USD 300. This includes campaign, recovery, provider and endpoint costs plus the control service.
- For the next Terminal-Bench 2.1 production campaign, use the later explicitly approved USD 300 hard campaign ceiling. This campaign-specific amendment supersedes the preceding cumulative limit for that campaign only. Preserve and report all earlier spend separately.
- Do not create another persistent Space, Bucket, repository, Dataset, schedule, credential beyond the approved inference credential, lease store, status store, backup store, or result store.
- The 2026-08-20 amendment permits exactly one new private canonical `<artifact-bucket>` in the selected namespace. It does not permit another Space, Bucket, repository, Dataset, schedule, credential, or result store.
- The later 2026-08-20 replacement amendment permits exactly one new private canonical `<control-space>` in the selected namespace. It does not permit an additional Space or any other persistent resource.
- Do not rerun valid logical tasks or use inference during migration and publication recovery. The 2026-08-22 amendment permits one separate fresh 89-task diagnostic campaign after the validity fixes deploy; it does not reopen or retry the old campaign.
- Keep credential values, private resource identifiers, operator paths, and private topology out of Git and browsers. Do not expose credentials in logs or evidence; the approved inference credential may appear only in an eligible execution Job and the selected reviewed Harbor agent environment.
- Do not delete or retire a legacy resource without its completed private audit and a separate explicit approval for that resource.
- Anonymous callers may reach static application assets, login initiation, OAuth return handling, health checks, and `GET /api/v1/leaderboard`. That leaderboard response is the official snapshot only: ranked rows and Pareto flags, no `sqlite_key`, no diagnostic catalogs, and no campaign internals. Campaigns, results, system, events, Jobs, profiles, audit, and all mutations remain deny-by-default.
- Add bounded request-body and anonymous request-rate controls before changing Space visibility. If hosted denial, capability, or abuse-control verification fails, restore private visibility, disable writes, and stop.
- Keep exactly two operator-managed Space secrets: the control credential `HF_TOKEN` and the inference-only `HF_INFERENCE_TOKEN`.
- Workers must never receive `HF_TOKEN`. They may receive only `HF_INFERENCE_TOKEN`, whose permissions are limited to serverless and Endpoint inference calls.
- Pin each worker image and command, resolve the exact model, upstream, native API, credential reference, timeout, output limit, and prices into Harbor's immutable execution contract, and rotate the inference credential regularly. Revoke the prior credential only after every Job using it is terminal.
- Bind every Sandbox operation to the immutable campaign lock, launch action, task, expiration, approved image, hardware, paths, transfer limits, timeouts, and budget. Record fenced lifecycle receipts and do not expose general Hugging Face lifecycle authority.
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
- Limit the installer diagnostic apply to the existing protected, free-hardware test installation and its canonical private Bucket. Do not upload application source, prompt for or move service credentials, activate writes, create any other resource, incur paid compute, push, or open a pull request. Stop after the phase-one result or first failure.
- Limit autonomous installer diagnosis to the selected protected, free-hardware test Space and its one empty private test Bucket. Direct probes may create and, when required for deterministic recovery, delete only that empty test Bucket. Do not upload application source, read or move service credentials, activate writes, use paid hardware, mutate unrelated resources, push, or open a pull request. Stop after phase one succeeds or a concrete provider defect is isolated.
- Limit the phase-two recovery to re-uploading the exact previously planned source, adopting only the already-present expected secret names without reading or rewriting credential values, setting the installed phase, restarting on free hardware, and running verification with writes disabled. Create no resources, use no paid hardware, pause on failure, and do not push or open a pull request. This one recovery supersedes the earlier source-upload prohibition only for these exact actions.
- Limit the empty-installation reset to deleting the one verified-empty private test Bucket after rechecking that the marked Space remains absent, quarantining rather than deleting its stale owner-only local installer state, and running fresh plan plus phase-one apply for the same protected `cpu-basic` Space and private Bucket. Do not upload source, prompt for or move credentials, use paid hardware, push, or open a pull request. Stop after phase one succeeds or the first failure.
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
- The retired-harness amendments from 2026-08-23 are superseded and authorize no current canary, diagnostic, official run, retry, publication, deployment, persistent resource, or credential.
- The later 2026-08-23 harness full-run repair amendment does not raise any campaign ceiling and does not add a persistent resource or credential. Retries stay inside each supported campaign's locked ceiling. Do not reopen sealed semantic, agent, verifier, policy, refusal, cancelled, or benchmark-timeout outcomes. Do not launch a second 89-task campaign for a harness that already has one.
- The 2026-08-23 Sandbox-parallelism amendment raises only the shared namespace Sandbox cap from 16 to 128. It does not raise a campaign ceiling, add a persistent resource, or change a locked campaign. Sandbox hardware cost still counts against each campaign's existing ceiling.
- The 2026-08-24 Run-native reset amendment authorizes irreversible deletion only for run-derived objects under a reviewed exact-prefix allowlist. It does not authorize deleting ACLs, profiles, promotions, capacity policy, the canonical Space or Bucket, credentials, or unrelated objects.
- The Run-native path has no Sandbox lifecycle and no Campaign compatibility writer, reader, route, field, alias, or UI label. Existing run data is deleted instead of migrated.
- Replacement Jobs remain limited to explicit infrastructure failures, the locked physical-attempt count, the run ceiling, and the previously approved aggregate ceilings. Semantic, agent, verifier, policy, refusal, cancelled, benchmark-timeout, and scored outcomes remain terminal.
- Fresh runs start only after the exact deployed revision passes the unpaid control canary and bounded paid task canary. Retired or otherwise unsupported harnesses remain excluded from fresh launch.
- The 2026-08-25 failed-Run replacement amendment permits targeted deletion and replacement only for the seven fresh Runs invalidated by `control_not_ready` during the control deployment. Preserve every unrelated Run and retained control object. Keep the same profiles, USD 10.60 per-Run ceiling, USD 74.20 aggregate ceiling, and excluded harnesses. Do not rerun any scored or semantic outcome.
- The 2026-08-26 admission-integrity repair amendment permits deletion of exactly one orphaned Job admission object and no other object. It adds no compatibility path, persistent resource, credential, Run, retry, or ceiling increase.
- The Agent Workbench must keep arbitrary commands inside the unprivileged task runtime. It must not expose the control credential, the platform inference credential, a writable canonical Bucket mount, host authentication directories, or unrelated worker environment variables.
- Customer-authored recipes may execute without human promotion, but remain private or diagnostic by default. Final leaderboard eligibility, shared aliases, and wider reuse require the existing reviewed promotion and publication gates.
- Generate command and environment previews from the same immutable execution manifest used by the worker. Keep secret values redacted, reject literal credentials in durable recipes, escape arbitrary text, and never render customer HTML or scripts in the control application origin.
- The local Hugging Face CLI credential may be accessed during this session for authenticated development and bounded control-plane API calls without printing or recording its value. It must not be passed to a remote runtime, written to Git, logs, evidence, manifests, or browser state, or copied into another credential store.
- A provider-scoped Fast-Agent authentication export may be created only in an owner-only temporary local location for command-construction and schema testing, then removed. It must not be committed, logged, uploaded, passed to a remote Job, or used for local inference.
- Real inference tests may use only the existing purpose-scoped inference credential configured in the canonical control Space and attached to eligible execution Jobs. Do not retrieve, replace, or copy that credential.
- Keep this amendment's new paid verification at or below USD 10 total. Run at most three new single-attempt diagnostic logical trials with concurrency one after local verification succeeds. Count setup Jobs, model calls, retries, and cleanup; stop on a shared worker defect or unexpected cost.
- Do not create, resume, or resize an Inference Endpoint under this amendment. Direct calls to the reviewed serverless inference route are allowed only for the bounded diagnostic trials.
- Use only public Harbor APIs. Do not modify or publish another Harbor repository. If the command-agent implementation needs a Harbor change, stop and request a separate repository authorization.
- Local commits and an exact reviewed deployment to the existing canonical control Space are allowed. Do not push, open a pull request, merge, create a release, or publish an official result under this amendment.
- The 2026-08-28 Workbench canary-activation amendment supersedes the preceding no-push limit only for the current `feat/agent-workbench` branch and the bounded follow-up commits needed to pin the published worker image. It authorizes no pull request, merge, default-branch update, force push, GitHub release, Python-package publication, or official benchmark publication.
- Publish exactly one `linux/amd64` trial-worker image from an exact commit on `feat/agent-workbench` to the existing public worker-image package. Use the existing GitHub Actions package credential; do not move or expose a local credential.
- Keep the activation on the two canonical Harbor-HF runtime resources and the two existing control-Space secrets. Do not create or replace a Space, Bucket, repository, Dataset, schedule, Endpoint, credential, or other persistent resource.
- Run exactly two single-trial logical tasks from `terminal-bench-2-1-canary`, with at most one active trial Job, one physical infrastructure attempt per logical task, diagnostic publication only, and a hard Run ceiling of USD 1.00. Use only the existing direct serverless inference route and the inference-only credential attached to the eligible execution Job.
- Setup verification plus the two-task Run must remain within the existing Agent Workbench USD 10 aggregate allowance. Stop before another setup Job, retry, replacement, or Run if the reviewed image, worker revision, lock, task digest, model route, cost, credential boundary, or concurrency differs from this amendment.
- The recipe-and-UX repair must keep ecosystem-specific installation commands in immutable recipe/profile data. Do not add uv-, Python-, npm-, npx-, benchmark-, model-, or harness-name branches to Harbor-HF control, Run, schema, or worker orchestration.
- The repaired Workbench must present configure, setup test, reviewed publication, and benchmark Run as distinct stages; do not imply that a successful generic setup test alone authorizes a Run. Avoid duplicate log surfaces unless their scope is explicit, and distinguish profile loading or query failure from a confirmed unreviewed recipe.
- The follow-up authorization permits exactly one new `terminal-bench-2-1-canary` Run with two single-trial logical tasks, at most one active trial Job and provider request, one physical infrastructure attempt per logical task, diagnostic publication only, no Endpoint, and a hard Run ceiling of USD 1.00. Do not retry or replace the failed first canary.
- Preserve the failed first canary and its accepted evidence. The repair may update the generic worker image and immutable profiles when required, but must use the existing public image package, canonical `<control-space>`, canonical `<artifact-bucket>`, and two existing Space secrets. Do not create, delete, replace, or transfer a persistent resource or credential.
- Slophammer `py.mutation-required` remains explicitly disabled with a reason. The local mutation script and manual workflow may remain available on demand, but mutation execution is not a completion, deployment, or canary gate for this amendment.
- The canonical work-remote amendment authorizes normal feature-branch fetches and fast-forward pushes to `huggingface/harbor-hf`. It does not authorize changing the upstream default branch, merging, opening or modifying a pull request, force pushing, deleting a shared branch, creating a tag or release, or pushing additional commits to the retained fork without separate approval.
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
- Finish only still-supported existing 89-task rows, plus the existing OpenCode row, without a second campaign for the same harness. The retired harness row may not continue or publish under current authorization.
- Finish those existing 89-task rows, plus the existing OpenCode and FX 89-task rows, without a second campaign for the same harness.
- Attach and resume a historical Run only after deterministic replay and selection-preservation tests pass and that harness's reviewed worker passes its bounded canary.
- Admit remaining historical work only after the successor repair passes the same unresolved OpenHands task with valid evidence and nonzero provider token usage.
- Keep the approved GLM-5.3-Flash Together plus Pi replacement inside its USD 18 immutable ceiling and the rollout plan's 16-Job physical concurrency limit. Do not resume the invalidated first Run.

## Approval history

The entries below are immutable factual summaries of past approvals. Any
reference to a retired inference implementation or removed harness is
superseded by the 2026-09-02 notice above and has no active normative or
authorization effect.

### 2026-09-02

- Approved at 2026-09-02T16:00:27Z under the instruction to try and repair the
  failed post-reset installation: inspect sanitized provider diagnostics,
  implement and push a general repair on `feat/agent-workbench`, and retry the
  existing-resource installer sequence through activation. Preserve the
  existing secrets, Workbench variables, hardware, protection, Space, and
  Bucket; keep writes disabled until verification; do not provision resources,
  launch Jobs or Runs, call inference, publish results or images, merge, or
  update the default branch. On another unverifiable failure, leave the Space
  disabled and paused.
- Approved at 2026-09-02T15:03:05Z under the instruction to proceed with
  getting the reset installation working: model and preserve only the two
  existing reviewed Workbench variables across installer planning and phase
  transitions, add tests, commit, and push the repair. Do not expose or change
  their values or broaden the installer variable allowlist.
- Approved at 2026-09-02T14:59:25Z after inventory: disable
  writes, irreversibly deleting the 1,143 application objects from the one live
  canonical artifact Bucket while preserving its installer ownership marker
  and resource, and running the existing-install npm
  plan/configure/verify/activate sequence for the exact latest branch revision.
  Preserve existing secret values, hardware, protection, Space, and Bucket; do
  not provision resources, publish another image, launch Jobs or Runs, call
  inference, publish results, merge, or update the default branch. If the fresh
  installation fails, leave writes disabled and stop.
- Approved at 2026-09-02T13:53:54Z: publish one bridge-free worker image,
  refresh immutable deployment-profile pins, commit and push on
  `feat/agent-workbench`, exact control-Space deployment, profile-visibility
  verification, and bounded rollback to the immediately preceding control
  revision if health checks fail. This excludes setup or benchmark Jobs,
  inference, result publication, new resources, hardware changes, merge, and
  default-branch updates.
- Completed at 2026-09-02T14:39:30Z: published and verified the worker image,
  pinned and pushed all active compatible deployment profiles, and attempted
  the exact control deployment. Startup rejected one immutable historical
  action record under the stricter current schema, so the authorized rollback
  restored the immediately preceding control revision with healthy readiness,
  unchanged write mode, zero control-owned active Jobs, and a clean projection.
  No setup or benchmark Job, inference call, result publication, resource
  creation, hardware change, merge, or default-branch update occurred. During
  diagnostics, one private Space identifier and one historical Run identifier
  appeared in local tool output; no credential or private identifier was
  committed or pushed, and the local captured files were removed.
- Approved at 2026-09-02T13:20:28Z: commit the completed Harbor-first refactor
  and push only the current `feat/agent-workbench` branch to its tracked
  `origin` branch. No deployment, image or package publication, inference,
  merge, paid work, or hosted runtime mutation is authorized.
- Completed at 2026-09-02T13:21:41Z: committed the verified refactor and
  pushed `feat/agent-workbench` to its tracked `origin` branch. No deployment,
  image or package publication, inference, merge, paid work, or hosted runtime
  mutation occurred.
- Approved at 2026-09-02T12:17:25Z: complete the local Harbor-first implementation,
  including removal of the remaining active root Python custom provider proxy,
  integration-test repairs, generated-file refreshes, and local validation only.
  This amendment excludes credentials, local or remote inference, deployment,
  publication, spending, push, merge, hosted mutation, and resource changes.
- Completed at 2026-09-02T13:09:16Z: removed the active custom inference
  intermediary paths, migrated execution to direct Harbor agent configuration,
  refreshed tests and generated artifacts, and passed the approved local
  verification gates. No remote action or credential use occurred.

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
- Approved fully retiring mutation testing from every supported root and agent-package path, superseding the earlier requirement to retain on-demand tooling. Remove its dependencies, configuration, scripts, GitHub Actions workflow, release preflight, active documentation, and lockfile entries. Keep deterministic regression tests that do not execute mutation tooling. Limit this amendment to local repository changes, validation, and commits; do not push, deploy, mutate hosted resources, move credentials, or spend.

### 2026-08-27

- At 2026-08-27T14:35:22Z, fully authorized the Agent Workbench implementation and end-to-end feature-development session. The approved work includes a generic customer-authored command-agent recipe, setup and run previews, setup-only Jobs, private logs and workspace browsing, optional trace adaptation, a Fast-Agent 0.10.11 starter, local browser and screenshot testing, and up to three bounded diagnostic trials after local gates pass.
- Authorized session-only access to the locally authenticated Hugging Face CLI credential for development API calls without exposing its value, plus temporary local creation of a provider-scoped Fast-Agent authentication export for non-inference compatibility testing. Standing credential-isolation rules still prohibit passing either local credential into a remote runtime.
- Authorized an exact reviewed deployment to the existing canonical control Space when needed for bounded remote verification. No new persistent resource, official publication, Harbor repository change, push, pull request, merge, or release is authorized. New paid verification remains capped at USD 10.
- At 2026-08-27T22:02:30Z, approved adding an FX example to the Agent Workbench, committing the reviewed change, and pushing only the current `feat/agent-workbench` branch to its configured public `origin`. No pull request, merge, deployment, release, credential transfer, paid run, or other remote mutation is authorized.

### 2026-08-28

- At 2026-08-28T07:28:34Z, approved keeping Slophammer mutation testing disabled, checking the current upstream defect status, and proceeding with the remaining Agent Workbench activation steps.
- Approved pushing only `feat/agent-workbench`, publishing one exact generic trial-worker image, committing and pushing the resulting digest-pinned deployment and single-attempt diagnostic policy, deploying the exact reviewed revision to the existing canonical control Space, verifying the Fast-Agent setup path, and launching one two-task `terminal-bench-2-1-canary` Run with `gpt-oss-20b`.
- Keep trial concurrency at one, physical infrastructure attempts at one per logical task, diagnostic publication only, and the hard Run ceiling at USD 1.00. No new persistent resource, credential, Endpoint, pull request, merge, release, force push, default-branch update, official result, or unrelated hosted mutation is authorized.
- At 2026-08-28T07:44:34Z, approved making `huggingface/harbor-hf` the checkout's normal work remote, retaining the former fork only as a secondary remote, and pushing `feat/agent-workbench` directly to the canonical repository so its existing Actions publisher can build the exact worker image. This supersedes the unapproved temporary-branch proposal without authorizing a default-branch update, merge, pull-request mutation, force push, shared-branch deletion, tag, or release.
- At 2026-08-28T08:21:01Z, confirmed authority over the existing private Harbor-HF Spaces and Buckets in the operator-selected namespace. This authorizes restoring the failed control deployment to its prior known-good source, implementing and deploying a general durable-schema compatibility repair for the legacy capacity profile, and resuming the already-approved Workbench setup and two-task diagnostic canary. Keep private resource identifiers out of repository content. Do not create or delete persistent resources, replace or transfer credentials, create an Endpoint, increase the USD 1.00 Run ceiling, or broaden publication beyond diagnostic.
- At 2026-08-28T08:58:58Z, applied that authority to the exact reviewed one-time Run-native profile migration for the existing private `<artifact-bucket>`. The approved plan inventories 45 profiles and one promotion, adds and verifies 21 current-schema replacements, remaps one promotion, then deletes 21 superseded profile-prefix records. It transforms one capacity profile, 17 deployment profiles, and two launch policies under only `control/schema=v1/profiles/`, using the checked-in general worker image and revision. Keep the existing `<control-space>` paused during apply, require the digest-bound dry-run manifest and final verification manifest, and stop on any inventory drift. Do not touch ACL, Run, credential, configuration, or other Bucket prefixes.
- At 2026-08-28T15:38:33Z, approved repairing the Agent Workbench and reviewed Fast-Agent recipe after the first two-task diagnostic exposed hidden task-image Python assumptions, incompatible route-key naming, and unclear setup-to-Run UX. Keep each CLI ecosystem's installation and run behavior in immutable recipes through the generic command-agent path; improve the configure, test, publish, and Run workflow plus log and reviewed-profile states; correct deterministic failure classification; run the normal non-mutation gates; commit and push only `feat/agent-workbench`; publish and pin one replacement generic worker image only if worker code changes; deploy the exact reviewed revision to the existing canonical resources; and launch exactly one new two-task diagnostic canary under the same concurrency, one-attempt, diagnostic-only, no-Endpoint, and USD 1.00 limits. Preserve the failed first canary and do not retry or replace either of its attempts.

### 2026-09-01

- At 2026-09-01T08:56:03Z, approved fetching the latest canonical `main` branch and merging it into local `feat/agent-workbench`, preserving both sides' intended behavior. Resolve conflicts if necessary, run relevant validation and the public-privacy check, inspect the resulting diff and metadata, and commit the merge locally. Do not push, open or modify a pull request, update the default branch, deploy, mutate hosted resources, handle credentials, run inference, or incur cost.
- At 2026-09-01T09:56:29Z, approved committing this authorization amendment and pushing the verified local `feat/agent-workbench` history through the current merge commit to public `origin/feat/agent-workbench`. Require a normal fast-forward branch update after fetching and confirming no remote divergence. Do not force push, create or modify a pull request, update the default branch, create a tag or release, deploy, mutate hosted resources, handle credentials, run inference, or incur cost.

### 2026-09-01

- At 2026-09-01T11:12:25Z, approved one full 89-task, single-trial Terminal-Bench 2.1 Run with GLM-5.3-Flash through Together and Pi 0.84.2 reasoning off. The selected launch option fixes the hard ceiling at USD 18 and uses the existing profile limits of 16 active trial Jobs and two physical attempts per task.
- At 2026-09-01T14:07:05Z, approved cancelling only the paused GLM-5.3-Flash plus Pi Run invalidated by the pre-streaming inference bridge and launching one clean 89-task replacement on the fixed streaming worker. The replacement has a new USD 18 hard ceiling, at most 16 active trial Jobs, and at most two physical attempts per task. Outcomes from the invalidated Run may be rerun only in this replacement.
- At 2026-09-01T18:11:42Z, approved a narrow continuation mechanism for the seven historical gpt-oss full Runs that the current service cannot resume. Each Run may receive one append-only current execution attachment after local verification and its harness canary. The same Run then schedules only unresolved tasks, retains all selected outcomes and costs, and remains inside its existing ceiling. No replacement Run, selected-task retry, deletion, resource, credential, or budget increase is authorized.

### 2026-09-02

- At 2026-09-02T07:03:36Z, approved one immutable successor worker-repair attachment for each of the seven existing continuation repairs after the first repair-aware worker exposed a cross-language continuation-digest defect. Each successor binds to the original continuation and prior repair digests and may change only the worker image digest and source revision. Existing records, Run IDs, ceilings, prepared inputs, settings, evidence, and selected outcomes remain unchanged. The same unresolved OpenHands task must prove the corrected image before other historical work is admitted.

### 2026-09-04

- Approved the narrow saved-configuration Workbench milestone described above.
  The user preferred task size guidance over promises of exact cost enforcement.
  This does not authorize unbounded execution or removal of existing safeguards.

### 2026-09-04 credential-minimization follow-up

- Approved public-documentation verification and removal of the unnecessary
  installer Endpoint permission requirement. The user emphasized easy submission
  of results to the admin leaderboard. No credential change is authorized.

### 2026-09-04 leaderboard submission and presentation

- Approved prioritizing the proposed user submission/admin publication flow and
  a quick frontend presentation sweep, so the user can deploy and test afterward.

### 2026-09-04 branch publication and test deployment

- Approved creating and pushing the feature branch and deploying the completed
  milestone to the previously selected existing test control Space. Preserve
  the resource/credential boundaries and stop on failed provenance checks.
- Feature branch publication completed. Deployment stopped before mutation:
  the existing Space lacks its installer source-revision variable, and the live
  manifest binding has no matching saved installer plan. The deployed release
  record agrees with its Dockerfile and dependency-lock digests, but that does
  not by itself reconcile the installation binding.
- Pending approval: reconcile installer metadata against the verified deployed
  release and existing paired resources, then retry the supported deployment.
  Preserve all secrets, Bucket data, hardware, and ownership; do not fabricate
  provenance, discard installer state, or launch execution. If reconciliation
  cannot be proven, stop and report rather than forcing deployment.

### 2026-09-04 installer metadata reconciliation

- Approved the pending reconciliation request: repair only proven installation
  metadata and then continue deployment, preserving credentials and Bucket data.

### 2026-09-04 browser-authenticated installer verification

- Approved replacing the missing application-bearer requirement with existing
  HF browser login verification before continuing deployment. Preserve all
  verification gates and the two-token runtime credential boundary.

### 2026-09-04 narrow deployment build repair

Approved at: 2026-09-04

- Directly approved another deployment-fix attempt after the user confirmed
  they would stop manual restarts. Record this additively under the existing
  browser-installer and feature-branch deployment approvals.
- Repair only the installer-introduced production build boundary: exclude the
  local browser installer from Space compilation while preserving its strict
  local checks and browser dependencies. Add a regression check using the
  actual release install with development dependencies omitted. No Harbor
  runtime behavior or activation-gate change is authorized.
- Run required checks, review the full diff and public metadata, commit and
  push only `feat/leaderboard-submissions`, then plan the exact clean revision
  and attempt supported existing-resource configuration once with writes
  disabled and without credential replacement or input.
- Preserve prior installer receipts, canonical resources, hardware, secrets,
  worker configuration, Bucket objects, and Run state. Local management OAuth
  remains local-to-provider only. Do not activate, launch a browser, create
  resources, transfer credentials, launch Jobs or inference, publish results,
  migrate/reset data, open a pull request, merge, or update the default branch.
- On success verify anonymous source/health and canonical preservation, leaving
  the service running with writes disabled. On failure leave it disabled and
  paused, gather read-only diagnostics, and stop without a blind retry.
- The fresh deterministic build failure does not establish the cause of the
  earlier generic configuration failure. Previously disclosed coverage and
  retired/missing tooling limitations remain disclosed, not waived thresholds.

### 2026-09-04 sanitized configuration diagnostics completion

Approved at: 2026-09-04

- The user explicitly directed completion of the previously approved sanitized
  failure diagnostics and deployment retry. The build repair did not complete
  that diagnostic work. Add closed-allowlist operation and failure categories
  with privacy regression tests; never expose subprocess stderr, arbitrary
  provider messages, URLs, credentials, or private identifiers.
- Preserve all safety, provenance, authentication, and activation gates. Review
  and commit this additive record before implementation. Run the required
  checks without lowering thresholds, inspect full diffs and public metadata,
  and commit and push only `feat/leaderboard-submissions`.
- After fresh read-only ownership, source, resource, worker, and activity
  checks, permit at most one instrumented supported configure attempt from a
  new exact committed plan. Keep stdin closed and writes disabled; do not
  replace credentials or provide an application bearer. Preserve all prior
  receipts, canonical resources, hardware, secrets, Bucket and Run records.
- This is not approval for another unchanged retry. On failure leave the Space
  disabled and paused, diagnose read-only, and report the precise sanitized
  stage and proposed next fix. A straightforward in-scope local repair is
  allowed, but another configure attempt requires review. On success leave
  the service running with writes disabled, without activation.
- No Jobs, inference, new resources, credential transfer, reset, migration,
  real result publication, pull request, merge, or default-branch update.
  Local management OAuth stays local to provider APIs and Bucket inspection;
  no browser before healthy readiness. Keep operational evidence owner-only.

### 2026-09-04 harness library and New Run UX

- At 2026-09-04T14:12:04Z, directly approved the local UX and harness-library
  implementation scope recorded above, beginning with upstream compatibility and
  architecture review and an authorization-only commit. This pass must not
  implement. Preserve current execution safeguards, old locks, and saved recipe
  revisions; stop on an unresolved Harbor-owned gap. No deployment, push,
  spending, credential movement, migration, or upstream mutation is authorized.

### 2026-09-04 current-runtime UX implementation completion

Status: completed

- Following the completed upstream review, the user directly instructed local
  implementation of the independent Workbench library and New Run UX under the
  existing amendment. No further runtime cutover or Harbor patch was authorized.
- Implemented configure/test/save in Workbench and exact saved-version or
  built-in selection in New Run, using reviewed configurations and the existing
  admission paths. Kept model strings fail-closed, setup attestation and fresh
  review mandatory at launch, and the configuration registry under Advanced.
- Local verification: 806 unit tests and 11 mocked browser tests passed, along
  with formatting, lint, types, build, generated-contract checks, dependency
  inspection, dependency audit, DRY, and the non-baseline structure check.
  The repository-wide 85% coverage gate remains unmet; the structure baseline
  file and retired mutation script remain absent. No threshold was lowered and
  no retired tooling was restored.
- This completes only the local safe-current-runtime UX milestone. Prior
  deployment records and the broader project authorization remain unchanged.
  No push, PR, merge, deployment, live write-mode change, remote Job, inference,
  resource, credential transfer, migration, or result publication was performed.

### 2026-09-04 upstream compatibility and PR visibility

- Directly approved at 2026-09-04T15:25:00Z: compare fresh upstream main with
  the greenfield direction, reconcile by merging main into the feature branch
  if safe, test, push only the feature branch, and open or update one PR for
  visibility. No default-branch push or PR merge; no HF deployment, Jobs,
  credentials, resources, reset, or operational migration. Stop on material
  incompatibility rather than bypassing architecture or safety boundaries.

### 2026-09-04 execution-disabled integration

- Directly approved the execution-disabled integration amendment above. This
  resolves the prior safety stop by disabling incompatible execution, not by
  authorizing credential forwarding or a local Harbor patch. OAuth research
  remains separate and deferred; all operational prohibitions remain in force.

### 2026-09-04 execution-disabled integration completion

- Merged reviewed main into the feature branch in `e291f43`, pushed that branch
  without force, and updated the existing canonical draft PR 179. The default
  branch and PR were not merged. Authorization history is preserved additively.
- Execution fails closed before admission and credentials. Removed the parent
  worker, private Hub/Harbor patches and forwarding. Native immutable harness
  authoring and configuration-only preview are available; the old publication
  engine's submission UI was not restored and remains a disclosed follow-up.
- Passed 398 unit tests, eight mocked browser tests, 46 root Python tests with
  87.98% coverage, 32 agent-package tests, formatting/lint/types/build/generated
  checks, dependency checks and audits, DRY, the non-baseline structure check,
  public privacy, and both local Linux AMD64 Docker builds.
- Remaining red gates are disclosed in the draft: TypeScript coverage below 85%
  (72.83% lines, 70.22% statements, 68.59% functions, 63.14% branches), the absent
  structure baseline, and the retired mutation script. No threshold was lowered.
- No HF operational calls, deployment, Jobs, inference, resources, credential
  transfers, reset, migration, Run actions, or real result publication occurred.
  Per-user OAuth remains separate research, with no forwarding implementation.
- This completes only the approved disabled integration and visibility scope,
  not production readiness or any earlier operational milestone.

### Historical upstream wording retained during integration

The following incoming-main wording is retained only as historical evidence.
It grants no new permission, does not revive a retired runtime or bridge, and
cannot supersede the execution-disabled boundary or control-only HF_TOKEN rule.
All pre-integration authorization records above are retained as well.

- Run one controlled phase-one installer apply against the operator-selected existing bootstrap to capture the sanitized provider failure category or complete creation of its canonical private Bucket and local ownership receipt.
- Diagnose and complete phase one for the operator-selected installer test bootstrap autonomously, using the active local write-capable Hugging Face credential for bounded plan/apply retries and direct Bucket probes.
- Complete one bounded phase-two recovery for the operator-selected installer test bootstrap using its exact prior private plan and existing remote credential names.
- Reset the operator-selected test bootstrap after confirming that its marked Space is absent and its remaining private Bucket is empty, then recreate phase one.
- Diagnose and complete the operator-selected installer test bootstrap autonomously within its existing two-resource, free-hardware boundary.
- Remove installer credentials from advisory-lock subprocesses, make resources-only provisioning reject any bootstrap where configuration has started, and serialize verification with all per-target installer operations.
- Add FX as a Harbor agent plugin and promoted harness plus gpt-oss Together deployment so it appears in the launch list. Deploy the reviewed revision. Do not launch a campaign.
- Finish one successful full Terminal-Bench 2.1 single-trial diagnostic for each existing gpt-oss Chat Completions 89-task run by inspecting that run and its Jobs, fixing the shared defects those Jobs expose, deploying the reviewed revision, and retrying only eligible infrastructure failures or unresolved tasks on those same campaigns. The existing FX 89-task row may be finished. Do not add a second 89-task campaign for a harness that already has one. Do not launch Codex or Claude Code.
- Keep credential values, private resource identifiers, operator paths, and private topology out of Git and browsers. Do not expose credentials in logs or evidence; the approved inference credential may appear only in the trusted worker or root-owned inference bridge environment.
- Pin each worker image and command, enforce the locked model, route, token, request, concurrency, timeout, and cost limits in the worker bridge, and rotate the inference credential regularly. Revoke the prior credential only after every Job using it is terminal.
- Bind every Sandbox operation to the immutable campaign lock, launch action, task, expiration, approved image, hardware, paths, transfer limits, timeouts, and budget. Record fenced lifecycle receipts and do not expose a general Hugging Face API proxy.
- Limit the installer diagnostic apply to the existing protected, free-hardware bootstrap and its canonical private Bucket. Do not upload application source, prompt for or move service credentials, activate writes, create any other resource, incur paid compute, push, or open a pull request. Stop after the phase-one result or first failure.
- Limit the empty-bootstrap reset to deleting the one verified-empty private test Bucket after rechecking that the marked Space remains absent, quarantining rather than deleting its stale owner-only local installer state, and running fresh plan plus phase-one apply for the same protected `cpu-basic` Space and private Bucket. Do not upload source, prompt for or move credentials, use paid hardware, push, or open a pull request. Stop after phase one succeeds or the first failure.
- The 2026-08-23 FX harness amendment does not authorize a canary, 89-task diagnostic, official five-trial run, new persistent resource, or credential. It only adds the harness to the existing campaign path and deploys the reviewed revision.
- The later 2026-08-23 harness full-run repair amendment does not raise any campaign ceiling and does not add a persistent resource or credential. Retries stay inside each existing campaign's locked ceiling. The seven-campaign combined cap remains USD 74.20. The existing FX 89-task row stays inside its locked ceiling. Do not reopen sealed semantic, agent, verifier, policy, refusal, cancelled, or benchmark-timeout outcomes. Do not launch a second 89-task campaign for a harness that already has one.
- Fresh runs start only after the exact deployed revision passes the unpaid control canary and bounded paid task canary. FX, Codex, and Claude Code remain excluded from fresh launch without a separate amendment.

### 2026-09-04 additive authorization-history repair

- Final verification found that Git's automatic merge had applied upstream
  deletion of older authorization records. Restored the complete pre-integration
  record and retained incoming historical wording above without rewriting Git
  history. This changes no runtime behavior and grants no operational authority.

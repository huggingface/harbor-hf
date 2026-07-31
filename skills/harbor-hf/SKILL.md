---
name: harbor-hf
description: "Plan, profile, validate, launch, monitor, reconcile, recover, verify and score Harbor benchmark campaigns, then publish them through Hugging Face Jobs, Inference Providers, and Inference Endpoints."
---

# Harbor HF operations

Use this skill for operational work with `harbor-hf`. It covers single runs,
full campaigns, provider-backed agents, deployment profiles, paid canaries,
Hugging Face Jobs, recovery, private evidence, and result publication.

A Harbor HF campaign is a durable control-plane object. Treat HF Jobs as
replaceable workers. Read campaign state from the coordination Dataset and
canonical evidence from the private Bucket.

## Source documents

Read the complete source document before acting in that area:

- New campaign or live operation: `docs/harbor-cookbook.md`,
  `docs/run-spec.md`, `docs/benchmark-sources.md`, and
  `docs/single-job-campaign-controller.md`.
- New deployment or concurrency change: `docs/deployment-profiling.md`.
- Provider-backed agent: `docs/provider-agent-architecture.md` and
  `docs/harbor-integration-contract.md`.
- Evidence, audit, restoration, or repair: `docs/trial-evidence-bundle.md`.
- Publication or catalog change: `docs/result-publication.md` and the current
  `results publish` and `results catalog` CLI help.

The checked-out CLI is authoritative for command syntax. Run
`uv run harbor-hf <group> <command> --help` before using a mutating command.
Do not copy a stale command from a report or an older campaign checkout.

Load the focused references in this skill as needed:

- `references/planning-and-capacity.md` for immutable inputs, profiling,
  canaries and wave sizing, including timeouts and spend.
- `references/launch-and-monitoring.md` for submission, reconciliation, Jobs,
  live observations and cancellation plus operator handoff.
- `references/recovery.md` for failure classification, retries, interrupted
  finalization, immutable replacements, and duplicate prevention.
- `references/evidence-and-publication.md` for evidence, checksums, secret
  scans and scoring plus publication and catalog decisions.
- `references/provider-agents-and-security.md` for custom agents, ingress,
  credentials, identity checks, and provider-specific canaries.
- `references/operator-checklists.md` for the final go/no-go and reporting
  checklists.

## Operating invariants

Keep these rules in force throughout the session:

- Run models and benchmark tasks only on remote Hugging Face infrastructure.
- Pin every executable source and model reference. Pin tasks and images as well
  as agents and workers.
- Keep the control Dataset, input Bucket, evidence Bucket, and unpublished
  results private.
- Serialize campaign control mutations. A provider controller runs one internal
  wave at a time; trial requests may overlap only within locked provider limits.
- Treat `execution.concurrent_trials` and provider request concurrency as
  separate limits.
- Admit a wave only after measured end-to-end duration fits its deadline with
  explicit reserve for drain and evidence publication.
- Retry infrastructure failures only. Agent exits, time limits, refusals,
  incomplete tasks, and verifier rejections remain terminal outcomes.
- Never rerun an agent or judge to repair frozen historical evidence.
- Preserve physical executions and terminal evidence together with hashes and
  recovery provenance. Write terminal markers last.
- Public Git benchmark sources are anonymous. Local or private benchmark files
  use immutable bundles. Never forward a Git credential, SSH key, SSH agent, or
  local credential helper into remote infrastructure.
- Never copy an ambient local login into a remote secret. Every runtime
  credential must be purpose-scoped and explicitly approved for its exact
  source and destination. A named HF Job token selected through
  `harbor-hf auth use-job-token` records that approval and stores only its name.
- Never put credentials, route capabilities, authorization headers, cookies,
  secret query parameters, or environment values in durable artifacts.
- For endpoint work, success requires a verified paused endpoint with zero
  ready replicas.
- A reward of zero is a valid benchmark result when the execution evidence is
  complete.
- Missing, conflicting, unsafe, or ambiguous evidence fails closed.

## Authorization boundary

Planning, validation, local inspection, dry runs, and artifact verification do
not authorize paid remote work. Obtain explicit user authorization before a
command that can submit a Job, resume an endpoint, forward paid provider
requests, install automation, publish results, or change the primary catalog.

Before paid work, state the exact manifest, campaign identity policy, namespace,
provider or endpoint, model, trial count, wave count, maximum active waves,
wave deadline, Job deadline, spend cap, estimated wave cost, and recovery
policy. Ask for missing choices. Never ask the user to paste a secret into chat.

## Required workflow

### Repository and state inspection

1. Confirm the checkout and branch. Record the commit and working tree.
2. Read repository instructions and the source documents listed above.
3. Inspect the manifest, previous plans, launch records, active campaigns,
   running Jobs, and owned endpoints.
4. Determine whether the request concerns a new campaign, an immutable retry,
   an audit, publication, or a recovery operation.
5. Check for an existing campaign or Job before creating anything. Repeated
   prompts must remain idempotent.

### Immutable planning

1. Resolve full commits and SHA-256 digests for every behavior-affecting input.
   Resolve public Git anonymously. Resolve a local directory into the exact
   bundle source lock without uploading it during planning.
2. Verify the complete task set and exact logical attempt count.
3. Validate the manifest and write the campaign plan to a durable local file.
4. Plan again from a clean checkout when introducing a new benchmark,
   deployment, agent, or source revision. Compare plan digests and identities.
5. Inspect the plan directly. Record run and shard counts plus trial and wave
   counts instead of trusting a filename or manifest label.
6. Confirm that infrastructure retries do not consume logical attempt numbers.

Use:

```bash
uv run harbor-hf validate MANIFEST
uv run harbor-hf campaign plan MANIFEST --format json > PLAN.json
```

### Capacity gate

A valid schema does not prove that a wave can finish. Profile the exact workload
or run a representative paid canary before the full campaign. Record complete
trial wall time, p50, p95, maximum duration, provider calls per trial, request
spacing, queueing, evidence finalization time, and cleanup time.

Run the bundled duration check with a conservative planning duration:

```bash
uv run python skills/harbor-hf/scripts/check_wave_budget.py \
  --manifest MANIFEST \
  --plan PLAN.json \
  --planning-trial-seconds SECONDS \
  --reserve-seconds SECONDS \
  --headroom-factor FACTOR
```

The command must exit successfully. Review every deployment group and every
wave in its JSON output. A failing report blocks submission. Reduce
`max_shards_per_wave`, reduce `max_trials_per_shard`, or create a new profile.
Increasing a deadline without checking the enclosing HF Job and Sandbox limits
is not an acceptable fix.

### Canary and pilot gate

Use separate stages:

1. A transport canary proves source checkout, agent installation, ingress,
   provider routing, judge routing, session capture, trajectory identity,
   workspace output, checksums, and secret isolation.
2. A representative pilot wave proves throughput and deadline sizing under the
   selected concurrency and request pacing.
3. The full campaign starts only after both stages pass and their evidence is
   verified.

A canary that scores zero can pass the transport gate. A canary with an
exception, missing evidence, wrong identity, unsafe credential exposure, or an
unexplained provider error fails the gate.

### Submission gate

Before submission:

1. Re-run validation and planning from the pinned worker revision.
2. Compare the new plan digest with the approved plan.
3. Run `campaign submit --dry-run` and inspect every remote write.
4. Confirm Bucket privacy, source lock, bundle upload or reuse action, secret
   names, namespace, Job image digest, worker revision, Harbor revision, agent
   revision, provider route, and judge policy. Prove that no Git credential is
   included.
5. Confirm duration arithmetic and budget arithmetic from the same manifest.
6. Save the approved manifest, plan, duration report, and launch decision.
7. Submit once and capture the returned campaign ID, controller Job ID, input
   digest, plan digest, and launch receipt.

### Live operation

The campaign projection and controller status are the primary status surfaces:

```bash
uv run harbor-hf campaign status CAMPAIGN_ID --namespace NAMESPACE
uv run harbor-hf campaign reconcile CAMPAIGN_ID --namespace NAMESPACE --dry-run
```

A provider campaign advances inside its detached controller Job. Do not run an
applied local reconciliation loop. Check the controller attempt, claim,
heartbeat age, current wave, remaining-time admission, and block reason. HF Job
state and logs are supporting evidence. While work runs, confirm that terminal
trial bundles and provider records appear in the private Bucket.

Install the shared watchdog only for an explicit campaign list. The watchdog
may launch a sequential replacement after a retryable infrastructure failure.
It cannot continue a capacity or policy pause.

The controller stops new work when observed throughput makes the locked duration
infeasible, provider errors exceed the profile boundary, evidence publication
stalls, spend admission fails, or ownership becomes uncertain.

### Recovery gate

Observe before mutating. Load the campaign projection, control events, HF Job
state, wave evidence, trial markers, and checksums. Classify each affected
logical trial before requesting a retry.

Use `campaign retry` only for trials already classified as retryable
infrastructure failures. An immutable manifest change requires a new campaign
identity and explicit linkage to the superseded campaign. Build a trial-level
ledger before any replacement so completed logical outcomes are not executed
again by accident.

Never use `seal` merely to make a campaign terminal. Seal only a drained partial
campaign whose exhausted infrastructure outcomes are intentionally accepted as
zero under the declared publication policy.

### Evidence and publication gate

Before publication:

1. Reconcile until all Jobs, waves, leases, retries, and cleanup actions are
   terminal.
2. Verify endpoint pause evidence when applicable.
3. Run remote artifact verification.
4. Deep-validate representative and repaired trial bundles locally.
5. Verify every declared digest and terminal-marker ordering.
6. Scan all retained private and candidate public files for known secret values
   and high-confidence generic credential patterns.
7. Confirm trial counts, attempt counts, task digests, selected executions,
   rewards, judge identities, and result classification.
8. Dry-run publication, publish once, and record the receipt and exact Dataset
   revision.
9. Change the primary catalog only with explicit authorization and a stated
   reason.

## Hard stops

Stop without launching or mutating when any of these conditions holds:

- A required commit, digest, task identity, agent revision, or image pin is
  mutable or unknown.
- The task count, attempt count, shard count, or planned wave count differs from
  the approved protocol.
- No representative timing evidence exists for a paid full campaign.
- The duration checker fails or depends on unexplained concurrency.
- Estimated wave cost is missing, exceeds the campaign cap, or leaves no room
  for the declared retry policy.
- A provider or endpoint quota is unknown.
- A secret value would enter a command, manifest, lock, log, or agent process.
- A public Git source needs authentication, or a local/private source cannot be
  represented by a complete verified bundle.
- A credential would be copied from local configuration into a remote secret
  without approval naming the exact source and destination.
- An endpoint is running without a verified owner and watchdog.
- Existing terminal evidence is ambiguous, checksum-invalid, or duplicated.
- A requested retry would rerun an agent or benchmark failure.
- Full publication evidence has not passed checksum and secret validation.

## Final report

Report concrete evidence:

- manifest and plan paths plus SHA-256 digests;
- campaign, controller attempt, run, wave, shard, trial, execution, and HF Job IDs;
- requested and observed concurrency, pacing, trial latency, wave duration, and
  deadline headroom;
- spend cap, reservation, observed or unreported spend, and retry capacity;
- counts by queued, active, complete, retryable, exhausted, failed, cancelled,
  and invalid state;
- endpoint pause state or provider-route closure;
- artifact verification, deep validation, and secret-scan results;
- publication ID, Dataset revision, catalog state, and any remaining blocker.

Do not call a campaign successful because its Job exited zero. Success comes
from the durable campaign projection and verified canonical evidence.

# Operator checklists

Use these checklists as evidence gates. Mark an item complete only after
inspecting the named artifact or command output.

## New campaign checklist

### Scope

- [ ] Benchmark protocol, task set, attempt count, model set, agents, providers,
      judge, scoring denominator, and publication cohort are approved.
- [ ] The exact count of runs, tasks, logical trials, shards, and waves is known.
- [ ] Existing campaigns and Jobs were checked for duplicates.
- [ ] Remote writes and maximum spend have explicit authorization.

### Identity

- [ ] Worker and Harbor references are full commits. A public Git benchmark is
      anonymously readable at a full commit; a local benchmark has a verified
      bundle content digest. Model and Git agent references are full commits.
- [ ] Package agents use exact versions.
- [ ] Images use SHA-256 digests.
- [ ] Every selected task has a content digest.
- [ ] Provider API and route are locked together with the model and
      authoritative parameters.
- [ ] Judge API URL and model are locked. The secret name, reasoning policy,
      and temperature policy are locked too.

### Storage and secrets

- [ ] Control Dataset, input Bucket, evidence Bucket, and unpublished result
      stores are private.
- [ ] Benchmark source models contain no secret names or values.
- [ ] No Git credential, SSH key, SSH agent, or credential helper is forwarded
      to remote infrastructure.
- [ ] Manifest and plan contain only explicitly approved runtime secret names.
- [ ] Every runtime credential is purpose-scoped and approved for its exact
      source and destination; the submitter can load it without printing it.
- [ ] Provider-agent isolation requirements are present.
- [ ] Public publication destinations cannot receive raw private evidence.

### Planning

- [ ] `harbor-hf validate` passes.
- [ ] Campaign plan JSON and `source.lock.json` are saved with SHA-256 digests.
- [ ] A directory source bundle has a complete validated manifest and payload;
      a Git source passed anonymous preflight with credentials disabled.
- [ ] A clean-checkout plan has the same semantic digest.
- [ ] Plan task names and attempts match the protocol.
- [ ] Infrastructure retries are separate from logical attempts.
- [ ] Matrix includes and excludes produce the intended cells.

### Capacity

- [ ] Matching deployment profile or representative canary exists.
- [ ] Transport canary passed evidence and isolation gates.
- [ ] Representative pilot wave passed at intended concurrency and pacing.
- [ ] p50 and p95 are recorded. Maximum trial duration and request count are
      recorded together with queueing and finalization time.
- [ ] Effective concurrency names its limiting factor.
- [ ] `check_wave_budget.py` passes every deployment group and wave.
- [ ] Worst-wave estimate plus reserve fits the execution timeout.
- [ ] Sandbox and controller deadlines satisfy `docs/run-spec.md`.
- [ ] No trial can be admitted with too little time for its locked lifecycle.

### Spend

- [ ] Per-wave estimate and campaign cap are explicit.
- [ ] Concurrent reservations fit the cap.
- [ ] Infrastructure retry reservations fit the cap.
- [ ] Unknown billing attribution is treated conservatively.
- [ ] Endpoint quota and price or provider quota are verified.

### Submission

- [ ] Submit dry run matches the approved plan, source lock, bundle upload or
      reuse action, and exact source mount.
- [ ] The rendered Job secret list contains no source or Git credential.
- [ ] Launch record contains the manifest and plan plus duration and canary
      evidence.
- [ ] User has approved the exact paid launch.
- [ ] Submission response, campaign ID, controller Job ID, attempt, and input
      digest are saved.
- [ ] Provider campaigns have one controller Job and no child wave Jobs.

## Live campaign checklist

- [ ] Provider campaigns are not driven by an applied local reconcile loop.
- [ ] Status projection plus latest control and controller revisions are saved.
- [ ] Controller attempt, claim, heartbeat, wave, and HF Job identity match.
- [ ] Provider or endpoint identity matches the lock.
- [ ] Spend reservation remains within the approved bound.
- [ ] Provider records and terminal bundles advance in the Bucket.
- [ ] Completed trial count and observed throughput advance.
- [ ] Remaining work still fits the wave and controller deadlines with reserve.
- [ ] Retry counts stay within policy.
- [ ] No benchmark or agent failure is queued for infrastructure retry.
- [ ] Controller watchdog is scoped to the approved campaign list.
- [ ] Endpoint watchdog and lease remain healthy when applicable.
- [ ] The operator handoff names the next safe action.

## Cancellation checklist

- [ ] Durable cancellation was previewed and recorded.
- [ ] New shard admission stopped.
- [ ] Queued and active Jobs were observed or cancelled through control state.
- [ ] Active work drained or became terminal.
- [ ] Endpoint is paused with zero ready replicas when applicable.
- [ ] Existing valid trial evidence is retained.
- [ ] Cleanup and cancellation events are durable.
- [ ] Leases are released.
- [ ] Campaign projection is terminal or the remaining blocker is documented.

## Recovery checklist

- [ ] The immutable original manifest and plan are preserved with the lock and
      events.
- [ ] HF Job and endpoint identities were observed before mutation.
- [ ] Every affected trial has a failure classification.
- [ ] Completed benchmark outcomes are excluded from semantic rerun.
- [ ] Retry candidates fit retry count, wave duration, and spend admission.
- [ ] Interrupted finalization has one unique validated success.
- [ ] Original checksums and terminal markers are verified.
- [ ] Replacement campaign has a new identity and explicit provenance.
- [ ] Duplicate prevention ledger maps every affected logical trial.
- [ ] Replacement pilot wave passes before remaining work is admitted.

## Evidence checklist

- [ ] Harbor compatibility bundle matches the locked request.
- [ ] Frozen workspace archive and file index agree.
- [ ] Required native session and ATIF trajectory are present and nontrivial.
- [ ] Agent and model identities match. Provider and API identities match the
      revision too.
- [ ] Provider continuation and retry records are valid.
- [ ] Judge recorder counts and selected exchange are valid.
- [ ] Verifier reward and scorecard are finite and structurally consistent.
- [ ] Isolation evidence passes.
- [ ] Every referenced file matches its size and SHA-256.
- [ ] Terminal markers were written last.
- [ ] Remote artifact verification passes.
- [ ] Repaired or recovered bundles pass local deep validation.
- [ ] Known-secret and generic-pattern scans report zero findings.

## Publication checklist

- [ ] Campaign control state and Jobs are terminal. Waves and retries are
      terminal, and cleanup is complete.
- [ ] Expected and observed logical trial counts match.
- [ ] Task and attempt distributions match the approved protocol.
- [ ] Physical retry count and categories are reported.
- [ ] Score and denominator were independently recomputed.
- [ ] Result class and cohort eligibility are explicit.
- [ ] Provider model revision is `not_observed` where required.
- [ ] Publication dry run matches verified evidence.
- [ ] Publication receipt and exact Dataset commits are saved.
- [ ] Catalog change has explicit authorization plus a named actor and reason.
- [ ] Private evidence retention obligations are recorded.

## Final operator report template

```text
Campaign:
Namespace:
Manifest path and SHA-256:
Plan path and SHA-256:
Worker revision:
Harbor revision:
Benchmark revision and task count:
Model and deployment plus provider and agent:
Judge policy:
Logical runs and trials plus shards and waves:
Effective concurrency and limiting factor:
Planning trial duration:
Worst-wave estimate, reserve, and deadline:
Job and Sandbox deadlines:
Spend cap, wave reservation, and retry capacity:
Campaign state counts:
HF Job IDs and terminal states:
Endpoint pause or provider route state:
Artifact verification:
Deep validation:
Secret scan:
Score and denominator:
Publication ID and Dataset revisions:
Catalog state:
Repairs or replacements:
Remaining blockers:
Next safe action:
```

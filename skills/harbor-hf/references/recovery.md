# Recovery

Harbor HF recovery starts from durable state. Observe the coordination Dataset,
HF resource identity, private Bucket evidence, and terminal markers before any
retry or repair. Worker logs alone cannot authorize a rerun.

## Recovery inventory

Collect a secret-free snapshot:

- immutable campaign manifest and plan plus the lock;
- complete append-only event history and current projection;
- controller claim, status history, attempts, start and end receipts, and
  recovery decisions;
- action, endpoint wave, endpoint, and publisher leases;
- HF Job identities, exact labels, and terminal states;
- endpoint state, ready replicas, and watchdog identity when applicable;
- wave, shard, trial, and physical execution prefixes in the Bucket;
- execution locks, failures, compatibility bundles, checksums, and markers;
- provider records and judge recorder summaries;
- spend reservations and reported or unreported usage;
- local recovery commands already attempted.

Do not change the historical manifest or rewrite an event. A repair creates new
append-only provenance and writes only records allowed by the recovery contract.

## Failure classification

Classify at the physical execution boundary.

Retryable infrastructure failures include:

- immutable source preparation failure;
- transient custom-agent installation failure unrelated to locked content;
- HF Job or Sandbox loss before terminal evidence;
- private ingress startup or authentication failure;
- provider transport failure covered by the locked retry policy;
- interrupted artifact publication;
- incomplete evidence caused by worker loss;
- workspace archive or index write failure;
- missing expected judge recorder evidence;
- interrupted trial finalization with a uniquely valid execution.

Terminal agent or benchmark outcomes include:

- a validly started agent exits unsuccessfully;
- the agent reaches its turn or time limit;
- the agent leaves the task incomplete;
- the agent refuses for safety;
- the verifier rejects the frozen workspace;
- deterministic task image or command failure classified as benchmark-owned;
- a complete valid trial with reward zero.

Configuration failures block retries until a new immutable plan exists. Examples
include mutable revisions, malformed judge policy, workspace policy limits,
unsupported wire API, invalid custom-agent identity, and deterministic setup
errors tied to locked content.

Known secret detection requires operator review. Reject exact evidence that
contained a credential. Do not copy or redact it.

## Terminal Job without Bucket evidence

When a provider controller Job becomes terminal before terminal Bucket evidence
appears:

1. Inspect its exact campaign, attempt, plan, and input labels and final state.
2. Inspect the controller claim, latest status, start receipt, and checkpoint.
3. List wave, execution, and trial prefixes without modifying them.
4. Run the controller watchdog in dry-run mode for that campaign ID.
5. Confirm that the decision classifies only infrastructure loss, preserves
   completed trials, fits the original duration and spend bounds, and names the
   next sequential attempt.
6. Apply the reviewed watchdog pass. Verify the immutable recovery decision and
   replacement launch receipt before the new controller does provider work.

For an endpoint wave Job, inspect its wave and endpoint leases and use the
existing dry-run and applied reconciliation path so endpoint cleanup completes.

A timeout from an HF create, submit, inspect, cancel, resume, or pause call is an
ambiguous control outcome. The next watchdog or endpoint reconcile pass must
observe the deterministic remote identity before another side effect.

## Interrupted trial finalization

A logical trial can be recovered without rerunning the agent when exactly one
complete successful physical execution exists and the logical trial has no
terminal marker.

Validate:

- execution and logical trial identity;
- task name, task digest, logical attempt, and physical attempt;
- root execution checksum manifest;
- complete trial evidence manifest and inner references;
- Harbor compatibility bundle;
- provider and judge evidence requirements;
- absence of conflicting terminal markers;
- absence of another complete successful execution.

When the logical envelope is absent, the finalizer may write
`trial-finalization-recovery.json`, `trial.lock.json`, `trial-summary.json`, and
a complete checksum manifest. It writes `_SUCCESS` last. The recovery record
names the selected execution, its checksum digest, and
`interrupted_trial_finalization`.

When a valid envelope already exists and only the marker is missing, validate
that envelope and write only `_SUCCESS`. Adding a recovery record would change
the tree after its checksum manifest was finalized.

Multiple successes, invalid checksums, mismatched locks, or a partial envelope
are ambiguous. Stop without selecting one.

## Retry requests

Use the campaign projection to identify retryable trials in one shard. Preview:

```bash
uv run harbor-hf campaign retry CAMPAIGN_ID \
  --namespace NAMESPACE \
  --shard SHARD_ID \
  --reason 'REASON' \
  --dry-run
```

Review the exact target trial IDs and current classifications. Apply by removing
`--dry-run`. A live provider controller observes the request at its next action
boundary and runs the admitted retry wave in process. For endpoint campaigns,
preview reconciliation before submitting the retry wave.

A retry creates a new physical execution under the same logical trial. It does
not change the task, agent, model, judge, provider, logical attempt, or evidence
policy.

## Spend-cap blocks

The controller projection conservatively retains provider wave reservations
when billing cannot be attributed. A retry candidate can therefore remain
blocked even when the prior Job is terminal.

Inspect:

- campaign `max_spend_usd`;
- every wave `estimated_wave_cost_usd` reservation;
- observed spend and attribution status;
- retry candidate estimate;
- active and retained reservations;
- the dry-run block reason.

Never edit an immutable cap or erase a reservation. If the approved retry cannot
fit, choose one explicit path:

- accept the infrastructure exhaustion under the declared result policy;
- create a linked replacement campaign with a new budget and only the work that
  policy allows;
- stop and obtain a new protocol decision.

A replacement campaign must not quietly discard the original campaign or reuse
its identity.

## Immutable replacements

Create a new campaign identity when changing any behavior-affecting value,
including:

- worker, Harbor, model, benchmark, task, agent, or image revision;
- provider, endpoint, API, routing, or locked parameters;
- trial, shard, wave, concurrency, pacing, or timeout policy;
- judge model or reasoning policy;
- evidence limits;
- spend cap or reservation;
- publication role or evaluation identity.

Write a replacement record before submission. It should name the superseded
campaign, reason, original hashes, preserved evidence prefixes, selected logical
trials, excluded terminal outcomes, and new manifest and plan digests.

## Duplicate prevention ledger

Before a replacement or supplement, create one row per original logical trial:

```text
original campaign ID
run ID
trial ID
task name
task digest
logical attempt
state
selected execution ID
terminal marker
checksum status
replacement eligibility
replacement campaign ID
replacement trial ID
reason
```

Rules:

- Complete benchmark outcomes are ineligible for semantic rerun.
- Agent and verifier failures remain terminal.
- Retryable infrastructure failures may receive one new physical execution
  under the original identity when admission permits.
- A linked replacement needs an explicit mapping and must avoid selecting
  completed logical outcomes.
- Recovered evidence keeps original hashes and provenance.
- One original logical trial maps to at most one accepted replacement outcome.

Validate the ledger against both campaign plans and both Bucket trees before
launch and before publication.

## Duration-bound campaigns

When a wave reaches its duration bound after partial progress:

1. Preserve every complete trial and physical execution.
2. Mark unfinished active executions according to observed evidence.
3. Do not classify the entire wave as an agent failure.
4. Recalculate wave capacity from measured trial durations and effective
   provider concurrency.
5. Check whether the original campaign can admit bounded retry waves within its
   spend and retry policy.
6. If the manifest needs smaller waves, create a linked immutable replacement
   and a duplicate prevention ledger.
7. Run a pilot replacement wave before admitting the remaining workload.

A longer HF Job deadline alone does not fix an execution wave whose own timeout
is too short.

## Endpoint cleanup recovery

If a campaign stops in manual intervention:

1. Verify the owning controller and watchdog Jobs are terminal or identify the
   current owner.
2. Inspect the endpoint namespace, deterministic name, deployment digest, and
   lease owner.
3. Pause the owned endpoint through the approved control path.
4. Observe `state=paused` and `readyReplica=0`.
5. Preserve the observation and exact resource identity.
6. Preview resume:

```bash
uv run harbor-hf campaign resume CAMPAIGN_ID \
  --namespace NAMESPACE \
  --cleanup-verified \
  --reason 'REASON' \
  --dry-run
```

7. Apply the reviewed resume and then preview reconciliation.

Never release an unverified lease or resume while endpoint ownership is
uncertain.

## Cancellation recovery

A durable cancellation can return before cleanup finishes. The provider
controller stops admission at its next action boundary and lets the active wave
finish its evidence path. Continue status checks, plus endpoint reconciliation
when applicable, until:

- no queued or active owned Jobs remain;
- active executions are drained or terminal;
- all endpoint resources are paused with zero ready replicas;
- cancellation and cleanup evidence is durable;
- leases are released;
- available trial evidence is published to the private Bucket;
- the campaign projection is terminal.

Do not infer cancellation completion from a CLI return code.

## Sealing

`campaign seal` converts exhausted retries in a drained partial campaign into
explicit zero-score outcomes. It is irreversible policy work, so preview it:

```bash
uv run harbor-hf campaign seal CAMPAIGN_ID \
  --namespace NAMESPACE \
  --dry-run
```

Use it only when the publication protocol permits infrastructure-exhausted
zeros and the operator accepts the degraded result. Keep partial or degraded
labels. Do not place such a result into an ordinary complete cohort unless the
published protocol explicitly defines exhausted failures in that cohort.

## Frozen-artifact audit

Historical audit and reassessment use immutable workspaces. Verify source
checksums from run to trial to execution before extraction. Re-execute only the
approved verifier or judge path when the reassessment protocol explicitly
allows it. Never rerun the historical agent.

A historical judge response remains authoritative for its historical score.
Preserve exact request and response bytes, selected exchange ID, model,
reasoning settings, and repair provenance.

## Recovery report

Record:

- observed failure and exact evidence;
- classification and policy basis;
- commands and remote resources inspected;
- original hashes and terminal markers;
- retry or replacement eligibility;
- spend and deadline admission result;
- applied append-only events;
- new physical execution or replacement mappings;
- endpoint cleanup state;
- remaining ambiguity and the next input required.

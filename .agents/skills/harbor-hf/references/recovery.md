# Recovery

Recovery preserves immutable identity and evidence. It never converts a
semantic outcome into infrastructure, silently reruns valid work, or changes a
Run lock.

## Recovery inventory

Before acting, collect:

- Run, logical task, and physical attempt IDs;
- exact profile IDs and lock digests;
- preparation and prepared-trial state;
- action intents, observations, and receipts;
- deterministic HF Job or Endpoint identity;
- evidence manifests, checksums, and terminal markers;
- selected attempt and failure classification;
- physical-attempt allowance;
- accepted cost, active reservations, and remaining Run ceiling;
- cancellation state; and
- Endpoint ownership and observed replica state.

Logs and remote terminal state supplement but do not replace canonical records.

## Failure classification

Classify from evidence:

- **semantic:** model refusal or behavior, benchmark timeout, valid zero,
  agent outcome, verifier outcome;
- **replacement-eligible infrastructure:** transient HF lifecycle, image
  transfer, control availability, or other typed task-local platform failure;
- **deterministic infrastructure:** shared worker, profile, schema, image, or
  agent defect;
- **ambiguous:** ownership, evidence, or identity cannot be established.

Only the replacement-eligible class may receive another physical attempt.
Deterministic and ambiguous cases stop for repair or operator review.

## Ambiguous remote mutation

After a timeout or connection loss:

1. read immutable action intent;
2. derive the deterministic remote identity;
3. inspect HF state;
4. adopt an exact matching resource;
5. record an observation and receipt; or
6. stop if ownership or configuration differs.

Do not issue another create action until absence is proven under the durable
action contract.

## Terminal Job without receipt

When a Job is terminal but its receipt is absent:

1. inspect the Job and immutable action;
2. check for a complete evidence manifest;
3. verify Run, action, task, worker, and Harbor lock identity;
4. verify every evidence digest;
5. check credential-scan status;
6. finalize only if exactly one unambiguous complete attempt exists; and
7. otherwise record typed infrastructure failure without inventing evidence.

A log line or successful Job status does not prove a valid benchmark result.

## Interrupted logical finalization

A logical task may be finalized without rerunning the agent when exactly one
complete accepted physical attempt exists and no conflicting terminal logical
record exists.

Validate the physical receipt, evidence manifest, checksums, prepared and
emitted Harbor locks, task identity, and absence of another accepted success.
Write only the missing append-only logical records and terminal marker.

Multiple candidates, partial evidence, lock drift, or conflicting terminal
records are ambiguous and must stop.

## Infrastructure replacement

```bash
uv run harbor-hf run retry-infrastructure <run-id> \
  --task <task-id> \
  --reason "<infrastructure reason>" \
  --yes
```

Confirm:

- the latest state is replacement-eligible;
- the prepared trial is unchanged;
- model, agent, API, upstream, source, images, limits, and policy are unchanged;
- no physical attempt is active or ambiguously owned;
- the attempt limit remains; and
- the conservative replacement estimate fits the Run ceiling.

The replacement receives a new physical attempt ID under the same logical
task. It does not change the denominator.

## Spend blocks

Do not erase an accepted cost or active reservation to admit more work. If an
approved replacement cannot fit:

- accept infrastructure exhaustion when the publication protocol permits it;
- create a separately approved linked replacement Run containing only eligible
  work; or
- stop for a new protocol decision.

Unknown observed inference usage is not treated as zero. Use conservative
admission estimates and preserve the unknown value.

## Linked replacement Run

Create a new Run when changing any behavior-affecting value:

- Harbor, worker, agent, model, source, task, or image revision;
- inference provider, upstream, API, or parameters;
- hardware, resources, concurrency, or timeout;
- judge or verifier policy;
- evidence requirements;
- attempt or spend policy; or
- publication role.

Write a replacement record naming the superseded Run, reason, original hashes,
preserved evidence, eligible logical tasks, excluded semantic outcomes, and new
profile and plan digests.

One original logical task maps to at most one accepted replacement outcome.

## Duration-bound work

When a duration bound interrupts a Run:

1. preserve every complete attempt;
2. classify unfinished attempts from evidence;
3. do not label the whole Run as agent failure;
4. recompute reliable capacity from measured durations;
5. test whether unchanged prepared trials fit bounded infrastructure
   replacements;
6. use a linked Run if scheduling policy must change; and
7. validate the smaller design with an approved pilot.

Increasing only the outer Job deadline does not fix an inner trial or cleanup
bound.

## Endpoint cleanup

For manual intervention:

1. identify the owning action and exact Endpoint;
2. verify owning Jobs are terminal or identify the current owner;
3. inspect deployment digest and observed state;
4. request pause through the approved control action;
5. observe paused state and zero ready replicas;
6. preserve the observation and receipt; and
7. resume reconciliation only after ownership and cleanup validate.

Never release uncertain ownership or declare completion from a command return
without the observed state.

## Cancellation recovery

A cancellation request can return before cleanup finishes. Continue monitoring
until:

- no new work is admitted;
- active attempts are drained or terminal;
- available evidence is finalized;
- Jobs are observed;
- owned Endpoints are paused with zero ready replicas;
- cancellation and cleanup receipts are durable; and
- the Run projection is terminal.

## Sealing

Sealing infrastructure-exhausted tasks is irreversible policy work. Use it only
when the immutable publication protocol permits explicit exhausted outcomes and
the operator accepts the result classification. Preview the exact affected
tasks before applying.

Do not place a degraded result in an ordinary comparable cohort unless the
published protocol explicitly defines that treatment.

## Historical evidence

Historical audit and reassessment use immutable evidence at its pinned reader
revision. Verify source and checksum chains before extraction. Re-execute only
an explicitly approved verifier or judge path; never rerun the historical
agent under the old identity.

## Recovery report

Record:

- observed failure and canonical evidence;
- classification and policy basis;
- actions and remote resources inspected;
- original hashes and terminal markers;
- ownership determination;
- replacement eligibility and spend decision;
- append-only recovery records;
- new attempt or linked-Run mapping;
- Endpoint final state; and
- remaining ambiguity and next required decision.

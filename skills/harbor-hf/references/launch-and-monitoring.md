# Launch and monitoring

This reference covers live Harbor HF operation after the manifest and capacity
gates pass. Campaign projections and canonical Bucket evidence are authoritative.
HF Job logs help diagnose workers but do not define campaign completion.

## Pre-submission snapshot

Capture these local facts before remote mutation:

```bash
git status --short
git rev-parse HEAD
uv run harbor-hf validate MANIFEST
uv run harbor-hf campaign plan MANIFEST --format json > PLAN.json
sha256sum MANIFEST PLAN.json
uv run harbor-hf campaign submit MANIFEST --dry-run
```

Review the dry-run result. Confirm the namespace, campaign identity policy,
private repositories, remote image, worker revision, Harbor revision, secret
names, matrix cell, task count, shard count, trial count, spend reservation,
and publication destinations.

Check existing remote state before submission:

```bash
hf jobs ps --all --namespace NAMESPACE --format json
```

Also inspect local launch records and the coordination Dataset. A repeated
operator prompt must adopt an existing matching campaign instead of creating a
second campaign.

## Campaign submission

Submit once:

```bash
uv run harbor-hf campaign submit MANIFEST
```

Record the complete response. At minimum, preserve the campaign ID, plan and
manifest digests, controller Job ID, controller attempt, input URI and digest,
control revision, timestamp, operator checkout, and approved launch record.

For an Inference Provider campaign, submission creates the durable control state
and launches its one detached controller Job. It still does not prove that a
wave started or that paid provider calls occurred. The controller must first
verify its inputs and acquire ownership.

## Reconciliation

Read status and preview the next domain action:

```bash
uv run harbor-hf campaign status CAMPAIGN_ID --namespace NAMESPACE
uv run harbor-hf campaign reconcile CAMPAIGN_ID \
  --namespace NAMESPACE --dry-run
```

For a provider campaign with a controller lock, do not apply local
reconciliation. The detached controller owns all provider wave execution, and
the CLI rejects an applied pass. Use the preview to inspect action kind, shard
or trial identity, deployment digest, estimated cost, and block reason.

Only endpoint campaigns retain the applied reconciliation path. Serialize those
passes and wait for each durable outcome before the next mutation. Historical
provider campaigns remain tied to their pinned Harbor HF revision; do not drive
them with the current CLI.

## Managed automation

Automation is a remote mutation and needs explicit authorization. Preview the
exact schedule and explicit campaign list:

```bash
uv run harbor-hf automation install AUTOMATION_MANIFEST \
  --schedule 'CRON' \
  --namespace NAMESPACE \
  --campaign-id CAMPAIGN_ID \
  --dry-run
```

Repeat `--campaign-id` for each approved campaign. Install only after the
preview matches that list. Record the scheduled watchdog Job identity. The
watchdog checks controller liveness and may start a sequential replacement; it
does not reconcile trials or execute waves.

## HF Job inspection

Use the current HF CLI syntax:

```bash
hf jobs ps --all --namespace NAMESPACE --format json
hf jobs inspect JOB_ID --namespace NAMESPACE --format json
hf jobs logs JOB_ID --namespace NAMESPACE --tail 200
hf jobs stats JOB_ID --namespace NAMESPACE
```

Following logs can be useful during a short canary:

```bash
hf jobs logs JOB_ID --namespace NAMESPACE --follow --tail 100
```

A closed log stream does not prove the Job completed successfully. Inspect the
Job after log following exits.

Do not submit, cancel, or recreate a Job directly when Harbor HF owns it unless
the documented recovery path explicitly requires an operator action. Controller
launch and recovery must preserve exact labels and immutable receipts.

## Live status review

On every control pass, record:

- campaign outcome, control revision, and controller status revision;
- queued, active, retry-wait, complete, failed, invalid, exhausted, cancelled,
  plus lost logical trial counts;
- physical execution count and retry generation;
- controller attempt, Job ID, claim, heartbeat age, current wave, and remaining
  Job time;
- active wave IDs, deployment digests, and trial counts;
- provider request success and throttle observations together with retry and
  transport errors plus usage and pacing observations;
- endpoint startup and readiness together with the active and drain states,
  pause state, and ready-replica state;
- current spend reservation and observed or unreported spend;
- publisher and artifact checkpoints;
- oldest progress timestamp and time remaining before each deadline.

Compare observed throughput with the approved duration report. Recalculate the
projected finish whenever enough new trials complete to change the estimate.

## Checkpoint review

While a wave is active, canonical evidence should make monotonic progress. Check
for:

- a wave lock and lifecycle evidence;
- provider request records when using Inference Providers;
- execution directories with immutable input and compatibility records;
- complete execution checksum manifests and terminal markers;
- logical trial summaries and markers;
- run and shard progress records;
- endpoint snapshots and cleanup observations when applicable.

Do not wait until Job termination to discover that the Bucket is empty or that
provider evidence stopped advancing.

## Throughput stop rule

Stop admitting work when current evidence proves that the wave cannot drain
within its execution deadline. Use:

```text
remaining work estimate =
    ceil(remaining trials / observed effective concurrency)
    * current conservative trial duration

required remaining time =
    remaining work estimate + drain and publication reserve
```

If required remaining time exceeds the remaining execution time, the controller
must publish `paused-capacity` before admitting another wave. Let active work
drain according to policy. Preserving valid completed trials is safer than
forcing more work into the final minutes.

Do not start trial processes with a timeout shorter than the locked agent and
verifier lifecycle, including the judge, capture, and publication path.

## Provider review

Provider evidence is content-free. Review status, routing, request identity,
latency, usage, quota, retry, and throttle fields. Queued pacing delay is
separate from provider latency.

Pause admission when:

- the routed provider or model differs from the lock;
- authoritative parameters are absent or replaced;
- request concurrency or start interval exceeds policy;
- retries exceed the trial-scoped attempt bound;
- sustained throttling or transport errors invalidate the profile;
- request records stop reaching durable storage;
- the spend reservation or quota becomes unsafe.

A successful HTTP response does not establish a valid trial. Harbor output,
agent evidence, verifier evidence, and checksums must also complete.

## Endpoint review

Endpoint operation adds these mandatory checks:

- deterministic endpoint identity and exact deployment digest;
- paused baseline with zero ready replicas before ownership;
- watchdog readiness before resume;
- exact effective configuration after every target replica is ready;
- health probe through the endpoint's reported health route;
- lease ownership throughout active work;
- verified pause and zero ready replicas on every exit path.

If cleanup becomes uncertain, stop new work. Inspect controller and watchdog
Jobs, pause the owned endpoint, verify zero ready replicas, and preserve the
observations before using `campaign resume`.

## Cancellation

Preview and record a durable cancellation:

```bash
uv run harbor-hf campaign cancel CAMPAIGN_ID \
  --namespace NAMESPACE \
  --reason 'REASON' \
  --dry-run
```

Apply by removing `--dry-run` after review. A provider controller observes the
cancellation at its next action boundary: it admits no new wave and lets an
active in-process wave finish its evidence path. Continue status checks until
the controller and active wave are terminal. Endpoint campaigns continue their
cleanup reconciliation. Valid completed trials remain preserved.

Repeating cancellation is safe. Directly killing a controller can leave the
current wave and evidence ambiguous, so use campaign cancellation first unless
immediate safety requires direct intervention.

## Operator handoff

A handoff record should contain:

- campaign ID, namespace, manifest, plan, and controller input digests;
- current control revision and latest status snapshot path;
- controller attempt and claim plus active and terminal wave and Job IDs;
- endpoint state or provider route state;
- trial counts by state and latest durable progress time;
- spend reservation, observed spend status, and deadline headroom;
- last dry-run and applied reconcile outputs;
- known failures and their current classification;
- next safe command and commands that must not be run;
- unresolved authorization or policy choices.

The next operator should be able to continue without replaying a mutating
command to discover state.

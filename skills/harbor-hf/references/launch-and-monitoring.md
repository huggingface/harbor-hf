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

Record the complete response. At minimum, preserve the campaign ID, plan digest,
manifest digest, control repository and revision, timestamp, operator checkout,
and approved launch record.

Submission creates durable control state. It does not imply that a wave has
started or that paid provider calls have occurred.

## Reconciliation

Read status and preview actions:

```bash
uv run harbor-hf campaign status CAMPAIGN_ID --namespace NAMESPACE
uv run harbor-hf campaign reconcile CAMPAIGN_ID \
  --namespace NAMESPACE --dry-run
```

Inspect every action kind and target shard or trial. Check the deployment
digest, estimated cost, and block reason. Apply only the reviewed pass:

```bash
uv run harbor-hf campaign reconcile CAMPAIGN_ID \
  --namespace NAMESPACE --apply
```

Run one applied control pass at a time for a campaign. Wait for its durable
outcome before another mutation. The action and wave leases protect remote side
effects, while serialized operator control makes intent and recovery easier to
audit.

`reconcile-all` can operate a bounded queue:

```bash
uv run harbor-hf campaign reconcile-all \
  --namespace NAMESPACE \
  --campaign-id CAMPAIGN_ID \
  --provider-active-waves LIMIT \
  --dry-run
```

Repeat `--campaign-id` for an approved queue. Do not scan and mutate every
historical campaign merely because `reconcile-all` supports it. Apply only after
reviewing the dry run.

## Managed automation

Automation is a remote mutation and needs explicit authorization. Preview the
exact schedule and campaign filter together with the namespace and provider
wave limit:

```bash
uv run harbor-hf automation install AUTOMATION_MANIFEST \
  --schedule 'CRON' \
  --namespace NAMESPACE \
  --campaign-id CAMPAIGN_ID \
  --provider-active-waves LIMIT \
  --dry-run
```

Install only after the preview matches the approved campaign queue. Record the
scheduled Job and webhook identities. Automation reduces latency; campaign
correctness still comes from immutable plans and append-only events together with leases and canonical
evidence.

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
the documented recovery path explicitly requires an operator action. Campaign
reconciliation must observe deterministic Job identity and record the outcome.

## Live status review

On every control pass, record:

- campaign outcome and control revision;
- queued, active, retry-wait, complete, failed, invalid, exhausted, cancelled,
  plus lost logical trial counts;
- physical execution count and retry generation;
- active wave IDs, HF Job IDs, deployment digests, and leases;
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

If required remaining time exceeds the remaining execution time, request a
durable campaign cancellation or stop the next reconciliation admission. Let
active work drain according to policy. Preserving a smaller valid partial wave
is safer than forcing dozens of trials into the final minutes.

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

Apply by removing `--dry-run` after review. Continue reconciliation and status
checks until active Jobs, waves, endpoint leases, and cleanup actions are
terminal. Valid completed trials remain preserved.

Repeating cancellation is safe. Directly killing a controller can leave cleanup
and evidence ambiguous, so use campaign cancellation first unless immediate
safety requires direct intervention.

## Operator handoff

A handoff record should contain:

- campaign ID, namespace, manifest and plan digests;
- current control revision and latest status snapshot path;
- active and terminal wave and Job IDs;
- endpoint state or provider route state;
- trial counts by state and latest durable progress time;
- spend reservation, observed spend status, and deadline headroom;
- last dry-run and applied reconcile outputs;
- known failures and their current classification;
- next safe command and commands that must not be run;
- unresolved authorization or policy choices.

The next operator should be able to continue without replaying a mutating
command to discover state.

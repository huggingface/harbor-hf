# Fully Hosted Harbor Evaluations on Hugging Face

This recipe runs a reproducible Harbor campaign entirely on hosted Hugging Face
infrastructure. The operator submits profile aliases to one publicly reachable,
application-protected control Space. HF Jobs and Harbor Sandboxes execute the benchmark, and one private
Bucket stores immutable control records, evidence, results, and catalogs.

The operator machine does not load the model, run inference, or execute a
benchmark task.

> **Safety rule:** every endpoint-backed wave must finish with the Inference
> Endpoint reporting `paused` and zero ready replicas. This applies after
> success, failure, timeout, cancellation, control-process loss, and publication
> failure. A campaign cannot complete while cleanup is unverified.

## Hosted architecture

```text
operator CLI or browser
          |
          v
protected public control Space
  Fastify API, reconciler, SQLite projection, React console
          |
          +----> private Bucket
          |       control records, profiles, evidence, results, catalogs
          |
          +----> HF Jobs ----> Harbor HF Sandboxes
          |
          +----> Inference Providers or managed Endpoints
```

The Bucket is permanent truth. SQLite is a disposable projection. Deleting the
local database and replaying the Bucket must restore the same campaign state and
next action.

## 1. Prepare immutable profiles

A launch resolves five profile kinds:

- benchmark source revision, exact task IDs, and input digests;
- model ID and full revision;
- harness name, version, configuration, prompt, tools, and skills;
- deployment route, digest-pinned worker image, reviewed command, hardware,
  timeout, credential boundary, and inference request, concurrency, timeout, and
  output-token limits;
- launch policy, physical-attempt limit, reservation, and publication role.

Profiles are immutable Bucket records. A promotion maps a convenient alias to
one exact profile ID. Imported profiles describe history but cannot authorize a
new launch or retry.

Use two persistent Space secrets. `HF_TOKEN` is the control credential and must
never enter a Job. `HF_INFERENCE_TOKEN` is distinct and inference-only. A locked
deployment marks it `required` or `forbidden`; only a required, reviewed worker
receives it. Never record either value in a profile, campaign lock, action, log,
Bucket object, fixture, or result. The worker receives its short-lived
control capability separately and confines the inference credential to the
root-owned bridge. A benchmark agent, browser, and model server may not receive
either credential.

The CLI never reads or forwards the active local Hugging Face CLI credential.
Before using it, explicitly approve a purpose-scoped control bearer credential
for the local process and the control Space, then provide it through
`HARBOR_HF_CONTROL_BEARER_TOKEN` without printing it or storing it in the
repository. Inspect the ready service and aliases before spending:

```bash
export HARBOR_HF_CONTROL_URL=https://<control-space>.hf.space
export HARBOR_HF_CONTROL_BEARER_TOKEN=<approved-scoped-control-token>
uv run harbor-hf status
uv run harbor-hf profiles
```

Preserve the resolved profile IDs and campaign lock returned by the service.

## 2. Profile a new deployment

Before the first full campaign for an exact model and deployment, run the
[deployment profiling procedure](deployment-profiling.md). Start with one
verified smoke task, then test Harbor trial concurrency at powers of two:

```text
c1, c2, c4, c8, c16, c32, c64, ...
```

Continue while completed task throughput or declared goodput improves. Retry a
failed boundary after a health probe, refine between the last-good and first-bad
powers when useful, and repeat boundary candidates. Do not infer concurrency
from model size, GPU name, configured context capacity, or a synthetic token
throughput test.

The profile must use the same model revision, quantization, serving image,
hardware, context and output limits, KV precision, chat template, reasoning,
agent, and representative benchmark workload as the full campaign. Store the
selected profile and raw points in the private artifact Bucket. Set
`execution.concurrent_trials` to the selected value and retain the profile URI
and SHA-256 digest with the campaign notes until manifest linkage is
implemented.

Run the whole ladder under one leased endpoint lifecycle. Pause the endpoint
and verify zero ready replicas before writing the profile's terminal marker.
Do not create one endpoint-backed campaign per candidate.

## 3. Submit and reconcile

Inspect the ready control service and promoted profiles before submission:

```bash
export HARBOR_HF_CONTROL_URL=https://<control-space>.hf.space
uv run harbor-hf status
uv run harbor-hf profiles
uv run harbor-hf campaign submit \
  --benchmark <benchmark-profile> \
  --model <model-profile> \
  --harness <harness-profile> \
  --deployment <deployment-profile> \
  --launch-policy <launch-policy-profile> \
  --ceiling-microusd <approved-ceiling> \
  --idempotency-key <stable-request-key> \
  --yes
uv run harbor-hf campaign status <campaign-id>
```

The Space's single reconciler reads immutable Bucket records, derives the
SQLite projection, reserves deterministic actions, performs remote side
effects, and records receipts. SQLite is disposable. Restarting with an empty
local filesystem must reconstruct the same state and next action.

The idempotency key is part of campaign identity. Repeating the same request as
the same actor adopts the existing campaign. Deterministic action labels allow
the reconciler to adopt a Job after an ambiguous submit response.

Do not treat a timed-out create, resume, submit, cancel, or pause request as a
confirmed failure. Inspect or adopt the deterministic remote identity before
retrying. Do not create a lease repository, status store, webhook service, or
scheduled controller as a recovery path.

## 4A. Endpoint-backed execution path

An endpoint deployment digest covers the model revision, engine, image,
command, ordered arguments, non-secret environment, secret names, provider,
region, hardware, accelerator count, scaling, context and batching limits,
precision, parser and template controls, caching, speculative decoding, and
health probes.

For each bounded deployment wave, the controller and watchdog must:

1. acquire the endpoint lease with a parent-checked control commit;
2. start the independent watchdog and verify its readiness handshake;
3. adopt or create only the deterministic managed endpoint with the exact
   deployment digest;
4. require the endpoint to begin paused with zero ready replicas;
5. resume it once, re-verify the complete effective configuration after every
   target replica is ready, and probe the declared health route;
6. run only the wave's assigned Harbor shards at the locked concurrency;
7. stop admitting work at the first duration, shard, idle, or spend bound;
8. drain active work, pause the endpoint, observe `readyReplica=0`, write
   cleanup evidence, and only then release the lease.

The watchdog pauses the endpoint when the controller exits or loses ownership.
Cleanup actions take priority over new billable work. Ordinary completion
pauses the endpoint; deletion is a separate, explicit retention action.

If cleanup fails and the campaign enters `manual_intervention`, first verify
that the owning controller and watchdog Jobs are terminal, pause the endpoint,
and confirm `status.state=paused` with `readyReplica=0`. Release only the stale
resource whose exact owner was verified, then request cleanup through the
control API:

```bash
harbor-hf campaign pause-endpoint <campaign-id> \
  --reason "verified terminal cleanup" \
  --yes
harbor-hf endpoints
```

The pause action is immutable and idempotent. The campaign remains incomplete
until an endpoint resource record reports zero ready replicas. Do not write a
manual cleanup acknowledgement or bypass the observed-state check.

## 4B. Inference Provider execution path

A provider-backed wave uses the same campaign, run, shard, logical-trial,
physical-execution, Harbor, and artifact contracts. It does not create or lease
an Inference Endpoint. Record the requested provider and model, routing data,
request identity when exposed, retry and throttle observations, reported usage,
latency, and quoted or observed cost.

HF Inference Providers do not bind requests to or report a Hub model commit.
The private run lock preserves the selected model-profile revision, while the
published `model_revision` is `not_observed`. Never present it as equivalent to
an endpoint run whose served revision was verified.

The remote wave controller owns an OpenAI-compatible evidence recorder. The
production transport exposes it through authenticated HF Job ingress so agents
running in separate Harbor Sandboxes can reach it. OpenClaw sends its normal
requests to an opaque trial-scoped route; the recorder forwards them
to HF Inference Providers and writes `provider-requests.jsonl`. Each row
contains typed request metadata, response routing and quota headers, retry
attempt, usage, and latency. It never stores prompts, tool arguments, response
text, or credentials. The recorder is part of the hosted controller Job and
does not run inference itself. The
[provider evidence recorder plan](provider-evidence-recorder-plan.md) defines
the implementation, isolation, verification, and cutover requirements.

A provider spend cap requires an explicit `estimated_wave_cost_usd` in the
same provider limits block. The reconciler reserves that estimate while a wave
is active and conservatively retains it after the wave closes. Observed spend
is additive until the provider reports enough attribution to replace a wave's
reservation safely. This fails closed instead of letting missing billing data
reset the campaign budget.
`max_attempts` is also enforced at the proxy boundary per logical trial: an
identical request beyond that trial's configured attempt count is rejected
locally and is never forwarded or billed. Identical requests from independent
trials do not share a retry budget.

Do not infer a hidden engine, image, region, hardware, precision, cache policy,
or token count. Endpoint-only fields must be `not_applicable` and unreported
provider fields must be `not_reported`. Compare endpoint and provider runs only
on fields observed for both.

## 5. Monitor and cancel safely

Use projections instead of scraping worker logs:

```bash
uv run harbor-hf campaign status <campaign-id>
uv run harbor-hf jobs
uv run harbor-hf endpoints
```

Inspect queued, active, retrying, complete, invalid, failed, and cancelled
counts; physical retries; categorized infrastructure failures; endpoint
startup, active, idle, drain, and cleanup durations; observed throughput and
latency; estimated spend; and the most recent reconciler and publisher
checkpoints.

Cancellation is a durable control request:

```bash
uv run harbor-hf campaign cancel CAMPAIGN_ID --namespace NAMESPACE
```

After that request, reconciliation must stop admitting shards, cancel queued
and active Jobs, drain or terminate according to policy, pause every owned
endpoint, verify zero ready replicas, publish the evidence that exists, and
release leases only after cleanup. Repeating cancellation is safe. Valid
completed trials are retained, and the campaign may end as `partial`.

If cancellation returns before cleanup finishes, keep reconciling and checking
status. Do not consider cancellation finished while any owned endpoint is
running, any cleanup reservation is unresolved, or a watchdog reports lost
ownership.

If a managed HF Job becomes terminal without terminal Bucket evidence, the
next pass marks active executions as `lost`, drains and cleans the wave, and
admits the bounded retry generation. If a Job becomes terminal during a
cancellation call, the pass records an ambiguous action and stops so evidence
is re-observed before any cancellation outcome or cleanup is synthesized.
`reconcile-all` reports a malformed campaign as one failure record and
continues with the remaining campaigns.

## 6. Verify canonical artifacts

Run verification before publication:

```bash
uv run harbor-hf artifacts verify CAMPAIGN_ID --namespace NAMESPACE --format json
```

For each run, verify the immutable `run.lock.json`, terminal marker, normalized
summary, every object listed by `checksums.json`, and every child checksum
referenced by a parent summary. Reject traversal, symlinks, unsafe archive
members, conflicting markers, missing files, extra files, mismatched task
digests, non-finite verifier values, secret material, and unsanitized task or
session content.

Endpoint-backed wave evidence must include the exact endpoint snapshot, runtime
environment, lifecycle events, final pause observation, and zero-ready-replica
observation. A verifier reward of zero is a valid result; missing or invalid
evidence is not.

Canonical evidence remains under a unique Bucket prefix such as:

```text
campaigns/<campaign-id>/
  campaign.lock.json
  waves/<wave-id>/...                 # lifecycle and cleanup evidence
  runs/<run-id>/
    run.lock.json
    shards/<shard-id>/...
    trials/<trial-id>/
      executions/<execution-id>/...  # physical retries never overwrite
    run-summary.json
    _SUCCESS | _PARTIAL | _FAILED | _CANCELLED
```

## 7. Publish derived result tables

Publish only after artifact verification succeeds:

```bash
uv run harbor-hf results publish CAMPAIGN_ID --namespace NAMESPACE --format json
```

One leased publisher serializes commits to each destination. It writes flat,
versioned Parquet tables for runs, logical trials, physical executions,
metrics, and safe artifact metadata. It then writes one global index row that
points to the benchmark Dataset and its exact commit. Retrying adopts an
existing matching publication receipt instead of duplicating rows.
The publisher also updates consolidated power-of-two index windows from 1 to
2,048 rows. The Space reads the smallest window that covers its configured
publication limit, keeping refresh requests and bytes bounded as the immutable
per-publication index archive grows.

The publisher accepts only canonical v1 evidence with a verified native Harbor
bundle. It writes one checksummed projection and one catalog contract under the
v1 paths. Datasets from the superseded dual-publication format must be archived
and rebuilt from verified private evidence before they are configured as the
active Results Dataset; there is no mixed-version reader or migration shim.

Ordinary complete runs are the default comparable result class. A complete run
may contain exhausted task failures; each contributes zero to the fixed task
denominator and retains its failure and retry metadata. Partial, composite, and
manually selected results require an explicit publication path and must retain
their labels. They must never be inserted into an ordinary complete leaderboard
cohort. Raw Harbor sessions, trajectories, task bodies, logs, manifests, and
archives remain in the private Bucket and are never copied to a public Dataset.

Every published score must be traceable through these fields:

| Layer | Required provenance |
| --- | --- |
| Catalog entry | publication, run and campaign IDs; outcome, quality, publication role, result path, source digest, and primary metric unit |
| Run row | benchmark, observed model revision or `not_observed`, and agent revision; deployment identity; provider, region and hardware; source Bucket prefix; campaign-lock checksum |
| Trial row | task digest, logical attempt, selected physical execution and verifier metric owner |
| Execution row | physical attempt, runtime kind, remote Job identity when reported, timestamps, status and retry reason |
| Metric row | stable metric ID, typed owner, name, value, unit and aggregation |
| Artifact row | safe metadata path, media type, size and checksum; never raw evidence bytes |

Audit or rebuild compares these derived rows with the canonical Bucket evidence.
Deleting SQLite and replaying the Bucket must produce equivalent normalized rows
and stable publication paths.

## 8. Deploy the control Space

The pinned Docker release lives in
[`deploy/control-space/`](../deploy/control-space/). Build the exact reviewed
revision for `linux/amd64`, then deploy that source revision to the one private
control Space. Do not create a separate results Space.

Set the documented non-secret environment, install one Space secret named
`HF_TOKEN`, and enable Hugging Face OAuth. The browser uses same-origin API
requests and never receives the Bucket token. Production uses always-on paid CPU
because a sleeping reconciler cannot observe Jobs or verify endpoint cleanup.

Run the inference-free smoke profile first. Then verify OAuth roles, CSRF,
rebuild from an empty local filesystem, action adoption after a simulated
process stop, SSE reconnect with polling fallback, publication retry, and
endpoint pause recovery. Enable production writes only after those checks pass.

## Final operational checklist

- The campaign plan and all behavior-affecting references are immutable.
- No model or benchmark task ran on the operator machine.
- The control Space, input stores, artifact Bucket, and unpublished results
  were private.
- Every endpoint-backed wave has verified `state=paused` and
  `readyReplica=0`; provider-backed waves created no endpoint.
- Artifact verification passed against canonical checksums and exact task
  digests.
- Publication receipts, result object digests, control revisions, and evidence
  checksums are recorded.
- Exhausted task failures are scored as zero and remain separately auditable.
- Partial, composite, and manual results are labeled and excluded from the
  ordinary-complete cohort.
- The web console uses same-origin APIs and has no direct Bucket credential.

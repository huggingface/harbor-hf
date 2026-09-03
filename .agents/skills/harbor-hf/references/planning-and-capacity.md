# Planning and capacity

## Required operator inputs

Collect before planning:

- approved benchmark source and task selection;
- model route and observable revision;
- inference provider, upstream, and native API;
- harness import path, revision, reasoning, and evidence policy;
- worker and task image digests;
- hardware, resource, timeout, and output limits;
- physical-attempt policy;
- Run publication role;
- maximum Run spend and cumulative remaining authorization; and
- existing Jobs, Endpoints, and Runs that share capacity.

Keep real deployment identifiers in private operator state. Repository records
use placeholders.

## Immutable identity review

The Run identity must bind:

- exact profile record IDs and digests;
- source revision and task digests;
- Harbor and agent-package revisions;
- model route and inference API;
- agent configuration and exact revision;
- worker and task image digests;
- hardware and resource policy;
- timeout and output-token settings;
- attempt and cancellation policy;
- evidence contract; and
- publication role.

A change to any of these values needs a new profile and, after execution, a new
linked Run. Do not edit a lock or reuse an identity.

## Trial count

Derive the expected logical task count from Harbor's prepared job, not from a
hand-maintained list. Confirm:

- exact task selection;
- repeated-attempt protocol;
- expected denominator;
- one prepared trial per logical task;
- one selected terminal outcome per logical task; and
- maximum physical attempts.

Physical replacements do not change the logical denominator.

## Deployment profiling

Profile with the exact model, provider, API, harness, worker image, hardware,
limits, and representative benchmark workload.

Test reliable execution concurrency from a conservative starting point and
increase only while completed-task throughput improves without unacceptable
failure or latency. Repeat boundary measurements. Do not infer capacity from
model size, advertised context, or synthetic request throughput alone.

For managed Endpoints, include resume, health, drain, pause, and observed
zero-ready-replica time. Keep one controlled Endpoint lifecycle for a profiling
series when the approved procedure calls for it.

Store raw observations and the selected value in the private artifact Bucket.

## Effective concurrency

The effective task concurrency is the minimum of independent limits:

```text
effective =
  min(
    namespace active Job limit,
    Job start-rate capacity,
    deployment reliable trial concurrency,
    Run concurrency,
    available spend,
    Endpoint capacity when applicable
  )
```

Keep these limits separate in evidence and user-facing status. Do not combine
them into one unexplained number.

## Duration arithmetic

Estimate a conservative wall time:

```text
waves = ceil(logical_tasks / effective_concurrency)
run_seconds =
  preparation_seconds
  + waves * representative_trial_seconds
  + evidence_and_receipt_seconds
  + possible_replacement_seconds
  + endpoint_lifecycle_seconds
  + cleanup_margin_seconds
```

Use tail latency rather than only a mean. Include source checkout, image
transfer, agent installation, task execution, verifier work, evidence upload,
Job observation, and cleanup.

The helper can check bounded-wave arithmetic:

```bash
uv run python .agents/skills/harbor-hf/scripts/check_wave_budget.py \
  --trials <count> \
  --concurrency <count> \
  --trial-seconds <seconds> \
  --job-timeout-seconds <seconds> \
  --overhead-seconds <seconds>
```

## Canary design

A canary proves the exact path intended for the larger Run:

- same model route and API;
- same harness and revision;
- same worker and task-image handling;
- same direct inference configuration;
- same Harbor preparation and execution flow;
- same evidence requirements;
- same failure classification; and
- same Endpoint lifecycle when applicable.

Start with the smallest representative task set and one physical attempt. A
canary does not authorize a full Run or broader deployment.

## Spend arithmetic

Estimate:

```text
Job cost
  = active Job hours * hardware hourly price

Inference cost
  = estimated input tokens * input price
  + estimated output tokens * output price
  + declared cache prices when applicable

Endpoint cost
  = active replica hours * replica hourly price

Conservative Run cost
  = preparation
  + Job cost
  + inference cost
  + Endpoint cost
  + admitted replacement reserve
  + cleanup margin
```

Do not treat missing usage as zero. Use a conservative estimate for admission
and preserve unknown observed values as unknown. The immutable Run ceiling is a
hard upper bound, not a target.

## Go decision

Record:

- exact immutable inputs;
- profiling evidence and selected concurrency;
- logical task and maximum physical attempt counts;
- duration range;
- cost range and ceiling;
- current shared-capacity observations;
- canary evidence;
- unsupported cells;
- Endpoint cleanup plan;
- stop conditions; and
- operator approval.

Do not launch when price, reliable capacity, identity, or cleanup behavior is
unknown enough to invalidate the bound.

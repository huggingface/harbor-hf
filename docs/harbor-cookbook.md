# Fully Hosted Harbor Evaluations on Hugging Face

This cookbook runs a reproducible Harbor evaluation entirely on hosted
Hugging Face infrastructure. One protected control Space accepts the Run, one
private Bucket stores immutable state and evidence, and HF Jobs prepare and
execute the locked Harbor trials.

The operator machine does not execute a task or call the model.

## Hosted architecture

```text
operator CLI or browser
          |
          v
protected control Space
  API, reconciler, SQLite projection, React console
          |
          +----> private Bucket
          |       profiles, locks, evidence, results, catalogs
          |
          +----> HF Jobs
          |       Harbor preparation and one physical trial per Job
          |
          +----> HF inference upstreams or managed Endpoints
```

The Bucket is authoritative. SQLite is a disposable query projection.

> **Endpoint safety:** every endpoint-backed Run must end with each owned
> Endpoint observed paused and reporting zero ready replicas, including after
> failure, cancellation, timeout, process loss, or publication failure.

## 1. Prepare immutable profiles

A launch resolves five profile kinds:

1. benchmark source revision, task selection, and input digests;
2. model route, revision when observable, supported APIs, and limits;
3. harness import path, exact revision, configuration, capabilities, and
   evidence requirements;
4. deployment worker image, commands, hardware, direct inference settings or
   Endpoint configuration, prices, and timeouts; and
5. launch policy, physical-attempt limit, admission rules, Run ceiling, and
   publication role.

Profiles are immutable records. Promotions map convenient aliases to exact
profile IDs. Imported historical profiles are read-only.

For direct inference, verify that:

- the Harbor model route ends with the selected inference provider;
- the model and harness both support the deployment API;
- `inference_upstream` is the intended HF URL;
- the upstream hostname is suitable for Harbor's allowed-host list;
- timeout and output-token limits are positive and reviewed; and
- prices are present for cost estimation.

The service composes those values into Harbor `AgentConfig.env`. Do not add a
second model route in the deployment or tool configuration.

## 2. Configure credentials

The control Space has two narrowly scoped secrets:

- `HF_TOKEN` for Bucket and HF lifecycle operations; and
- `HF_INFERENCE_TOKEN` for direct inference in eligible execution Jobs.

The control credential never enters a Job. Preparation and no-inference Jobs
do not receive the inference credential. An inference-backed execution Job
receives it because the reviewed Harbor agent is the intended consumer.

Never store credential values in profiles, Run locks, action records, logs,
fixtures, evidence, or publication objects. Jobs use a separate short-lived
control capability and never receive a writable canonical Bucket mount.

Configure the operator CLI with a separately approved control bearer:

```bash
export HARBOR_HF_CONTROL_URL=https://<control-space>.hf.space
export HARBOR_HF_CONTROL_BEARER_TOKEN=<approved-control-bearer>
uv run harbor-hf status
uv run harbor-hf profiles
```

The local CLI credential is not copied into remote Jobs.

## 3. Profile a deployment

Before a full Run, follow
[`deployment-profiling.md`](deployment-profiling.md) with the exact model,
provider, API, agent, worker image, hardware, and representative workload.

For Job-backed direct inference, measure task duration and reliable concurrent
trial capacity. For Endpoint-backed execution, also validate serving
throughput, replica behavior, health checks, and cleanup.

Do not infer safe concurrency from model size or a synthetic request test.
Store the selected profile and raw measurements in the private Bucket. Keep
unknown service internals explicitly unknown.

## 4. Submit one Run

Inspect the service and exact promotions:

```bash
uv run harbor-hf status
uv run harbor-hf profiles
uv run harbor-hf capacity
```

Submit:

```bash
uv run harbor-hf run submit \
  --benchmark <benchmark-profile> \
  --model <model-profile> \
  --harness <harness-profile> \
  --deployment <deployment-profile> \
  --launch-policy <launch-policy-profile> \
  --ceiling-microusd <approved-ceiling> \
  --idempotency-key <stable-request-key> \
  --yes
```

Preserve the Run ID and idempotency key. Repeating the same request with the
same actor and key adopts the existing Run. After a timed-out mutation, inspect
the deterministic action and remote resource before retrying.

## 5. Preparation and execution

The service first launches a credential-free preparation Job. Harbor resolves
the benchmark and returns its exact job and trial locks. The worker stores one
prepared trial per logical task.

For each admitted physical attempt, the service launches one execution Job.
The Job:

1. validates its signed capability and exact task assignment;
2. downloads the prepared trial;
3. verifies and unpacks the digest-pinned task image;
4. reconstructs the one-attempt Harbor job;
5. loads the reviewed agent through `AgentConfig.import_path`;
6. calls the locked HF inference upstream directly when required;
7. freezes the post-agent workspace;
8. lets Harbor run the verifier;
9. verifies that Harbor's emitted lock matches preparation;
10. uploads content-addressed evidence; and
11. posts its terminal receipt.

The direct path preserves the agent's native API. Chat Completions and
Responses deployments are distinct; an incompatible combination is rejected,
not translated.

## 6. Endpoint-backed execution

For a managed Endpoint deployment, the immutable digest covers model and
engine revision, image, command, arguments, non-secret environment, secret
names, provider, region, hardware, replicas, context and batching settings,
parsers, templates, precision, and health probes.

The reconciler:

1. acquires durable ownership;
2. adopts or creates only the deterministic Endpoint;
3. requires the expected initial paused state;
4. resumes and verifies the complete effective configuration;
5. probes health;
6. admits only bounded work;
7. stops new work at duration, spend, or cancellation bounds;
8. drains active trials;
9. pauses the Endpoint; and
10. records an observation of zero ready replicas before releasing ownership.

If cleanup enters manual intervention, verify the owning Jobs, exact Endpoint
identity, and current ownership before requesting the supported pause action.
Never acknowledge cleanup without an observed paused state.

## 7. Monitor and cancel

```bash
uv run harbor-hf run status <run-id>
uv run harbor-hf jobs
uv run harbor-hf endpoints
uv run harbor-hf results
uv run harbor-hf audit
```

Use Bucket-backed receipts and evidence state as authority. Logs help diagnose
but do not seal a task.

Cancellation is asynchronous. Continue monitoring until no work remains
admitted, active attempts have completed evidence handling, owned Endpoints are
safe, and cancellation receipts are durable.

## 8. Repair infrastructure failures

Preview the exact failure in Run state. Retry only when it is typed
replacement-eligible infrastructure and the attempt and spend limits allow it:

```bash
uv run harbor-hf run retry-infrastructure <run-id> \
  --task <task-id> \
  --reason "<infrastructure reason>" \
  --yes
```

The replacement uses the same prepared trial. Never retry a model refusal,
valid zero, benchmark timeout, agent outcome, or verifier outcome as
infrastructure. A change to any behavior-affecting input requires a linked
replacement Run.

## 9. Verify canonical artifacts

After the Run becomes terminal:

```bash
uv run harbor-hf artifacts verify <run-id> \
  --namespace <namespace> \
  --format json > artifacts-verify.json
```

Review:

- Run and profile identities;
- prepared and emitted Harbor locks;
- task and image digests;
- selected physical attempt per logical task;
- required workspace, session, trajectory, and verifier evidence;
- evidence checksums and terminal markers;
- secret-scan status;
- retry classifications and attempt counts;
- finite metrics and cost fields; and
- Endpoint cleanup where applicable.

Unknown usage or provider internals remain unknown. They are not fabricated and
do not replace Harbor's native result.

## 10. Publish

Publication begins only after all logical tasks are sealed, action receipts are
durable, and Endpoint cleanup is verified.

```bash
uv run harbor-hf results
uv run harbor-hf audit
```

The reconciler derives normalized result tables and approved public views from
canonical private evidence. Workers never publish directly. A failed
publication is repaired without executing a task or calling the model again.

Public output must preserve infrastructure and semantic outcome categories,
task denominator, model and harness identity, observable revision facts,
attempt policy, score calculation, and evidence provenance. It must omit raw
private workspaces, credentials, capabilities, and private resource topology.

## Final checklist

- [ ] Exact profiles and promotions reviewed.
- [ ] Model, provider suffix, API, and harness compatibility validated.
- [ ] Worker and task images digest-pinned.
- [ ] Control and inference credentials are distinct and narrowly scoped.
- [ ] Run ceiling and physical-attempt limit approved.
- [ ] Stable idempotency key retained.
- [ ] Harbor preparation lock stored before execution.
- [ ] Every logical task has one selected terminal outcome.
- [ ] Replacement attempts are infrastructure-only and policy-admitted.
- [ ] Evidence manifests and secret scans pass.
- [ ] Every owned Endpoint is paused with zero ready replicas.
- [ ] Publication derives from canonical evidence.
- [ ] Replaying the Bucket rebuilds the same final state.

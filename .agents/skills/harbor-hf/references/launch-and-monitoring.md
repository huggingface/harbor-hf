# Launch and monitoring

Use the application-protected control Space for new Harbor-HF campaigns. The control API and immutable Bucket records are authoritative. HF Job logs are diagnostic and do not define campaign completion.

## Pre-submission checks

Confirm the service is ready and inspect the promoted profiles:

```bash
export HARBOR_HF_CONTROL_URL=https://<control-space>.hf.space
hf auth whoami
uv run harbor-hf status
uv run harbor-hf profiles
uv run harbor-hf jobs
uv run harbor-hf endpoints
```

Resolve the exact benchmark and model aliases plus the harness, deployment, and launch-policy aliases. Review the immutable profile IDs, task count, source revisions, worker image digest, hardware, attempt limit, reservation, cost ceiling, and publication role.

Before paid work, apply the paid-compute gate. Record the approved ceiling in micro-USD. Confirm that the cumulative authorized spend still covers every failed Job, repair, provider request, and active endpoint hour.

Do not create a repository, Bucket, Space, Dataset, schedule, lease store, or status store for a campaign.

## Campaign submission

Submit one profile-based request:

```bash
uv run harbor-hf campaign submit \
  --benchmark <benchmark-profile> \
  --model <model-profile> \
  --harness <harness-profile> \
  --deployment <deployment-profile> \
  --launch-policy <launch-policy-profile> \
  --ceiling-microusd <approved-ceiling> \
  --idempotency-key <stable-request-key> \
  --yes
```

Keep the campaign ID and action ID from the response. A repeated request from the same actor with the same idempotency key must adopt the campaign. It must not create another logical run.

The campaign lock records the resolved profile identities, exact task IDs, input digests, source revision, and cost ceiling before the control service creates physical work.

## Live monitoring

Use the API projection or web console:

```bash
uv run harbor-hf campaign status <campaign-id>
uv run harbor-hf jobs
uv run harbor-hf endpoints
uv run harbor-hf results
uv run harbor-hf audit
```

Check logical and physical state separately:

- sealed tasks versus total logical tasks
- physical attempts and their authorizing action IDs
- pending Job actions and observed remote state
- reserved and observed micro-USD versus the ceiling
- endpoint requested state, ready replicas, and cleanup receipt
- publication state and immutable result paths

The SSE stream is only a delivery optimization. Refresh the projected API state after reconnecting.

## HF Job inspection

Use HF CLI inspection only for diagnosis:

```bash
hf jobs ps --all --namespace <namespace> --format json
hf jobs inspect <job-id> --namespace <namespace> --format json
hf jobs logs <job-id> --namespace <namespace> --tail 200
hf jobs stats <job-id> --namespace <namespace>
```

Do not submit, cancel, or recreate a control-owned Job directly. After an ambiguous API response, let the reconciler adopt the deterministic remote action identity.

A stopped Job is not enough to declare a task complete. The selected attempt receipt and terminal selection in the Bucket are authoritative.

## Infrastructure repair

Only an unsealed task whose latest receipt is an eligible infrastructure failure can receive a replacement:

```bash
uv run harbor-hf campaign retry-infrastructure <campaign-id> \
  --task <task-id> \
  --reason "<infrastructure reason>" \
  --yes
```

The control service rejects semantic outcomes, refusals, verifier failures, and benchmark failures. It also rejects cancellations and benchmark timeouts. It also rejects retries after the launch policy's physical-attempt limit is exhausted.

A valid task never runs again. Publication recovery never runs a task.

## Cancellation

```bash
uv run harbor-hf campaign cancel <campaign-id> --yes
```

Cancellation seals open logical tasks, suppresses queued launches that no longer have open tasks, preserves existing evidence, and continues observing already-created remote resources until cleanup is known.

## Endpoint safety

For every control-owned endpoint:

1. Record the immutable endpoint identity before resume.
2. Verify the requested backend with a real model request.
3. Record active hourly cost.
4. Request pause at the terminal boundary.
5. Poll until the observed ready replica count is zero.
6. Keep the campaign incomplete while cleanup remains unverified.

Do not interpret a pause request or HTTP success as zero active replicas. If the control process stops during cleanup, the durable action receipt must let the restarted process continue from the same endpoint identity.

## Completion gate

A campaign is complete only when:

- every logical task has one terminal selection
- no control action is pending
- every owned endpoint has verified cleanup
- the result publication receipt is durable
- normalized rows and catalog objects validate
- observed spend does not exceed the campaign ceiling

Retain Jobs, attempts, evidence, metrics, costs, endpoint receipts, publication receipts, and audit records. Do not delete legacy resources until the private consumer and uniqueness audit authorizes that exact resource.

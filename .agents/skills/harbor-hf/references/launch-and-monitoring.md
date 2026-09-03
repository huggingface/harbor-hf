# Launch and monitoring

## Pre-submission checks

Before any remote action:

1. verify project authorization and cumulative spend;
2. inspect the current repository revision and working tree;
3. confirm the control service is ready and writes are enabled for the intended
   class;
4. inspect promoted profiles and exact resolved profile records;
5. check for an existing matching Run or action;
6. verify model provider suffix and inference API compatibility;
7. verify worker and task image digests;
8. review task count, physical-attempt limit, concurrency, timeouts, and Run
   ceiling; and
9. inspect active Jobs and owned Endpoints.

Do not launch from a stale alias, mutable image, unreviewed recipe, or changed
assumption.

## Submission

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

Preserve the Run ID, first action ID, resolved profile IDs, and idempotency key.
One request must produce one durable Run intent. After a timeout or connection
loss, inspect the Run and deterministic HF resource identity before taking
another mutating action.

## Monitoring

```bash
uv run harbor-hf run status <run-id>
uv run harbor-hf jobs
uv run harbor-hf endpoints
uv run harbor-hf results
uv run harbor-hf audit
```

Track logical and physical state separately:

- preparation status and prepared-lock digest;
- sealed, active, deferred, and unresolved logical tasks;
- every physical attempt and selected attempt;
- current action intent, observation, and receipt;
- active and observed Jobs;
- spend reservation and accepted cost;
- evidence upload and manifest validation;
- cancellation state; and
- Endpoint ownership and cleanup.

Job logs and terminal status are diagnostic. A logical task becomes
authoritative only through accepted evidence and a durable selection record.

## Direct inference checks

For inference-backed execution confirm:

- only execution Jobs receive `HF_INFERENCE_TOKEN`;
- `HF_TOKEN` is absent from all Jobs;
- Harbor receives the locked model route and `AgentConfig`;
- the upstream and API match the deployment;
- the agent uses its native supported API;
- the upstream host is in `extra_allowed_hosts`;
- timeout and output-token limits match the Run lock; and
- the agent and descendants stop before verifier execution.

## Infrastructure replacement

Use:

```bash
uv run harbor-hf run retry-infrastructure <run-id> \
  --task <task-id> \
  --reason "<infrastructure reason>" \
  --yes
```

Before applying, confirm:

- latest selected state is replacement-eligible infrastructure;
- the prepared trial remains unchanged;
- no physical attempt is active or ambiguously owned;
- the attempt limit and Run ceiling permit replacement; and
- the defect is not deterministic and shared.

Semantic outcomes are terminal.

## Cancellation

Cancellation records durable intent and stops future admission. It does not
erase active evidence work or skip Endpoint cleanup. Continue monitoring until
active attempts drain, receipts are durable, Endpoint state is safe, and the
Run projection is terminal.

## Endpoint safety

Before and during endpoint-backed work, track exact Endpoint identity,
deployment digest, owner, desired state, observed state, ready replica count,
health, and cleanup action.

A Run is not complete while an owned Endpoint is active or cleanup is
unverified. Never release ownership based only on a successful command return;
require a durable observation of paused state and zero ready replicas.

## Completion gate

Declare completion only when:

- preparation is valid;
- every logical task is sealed;
- every selected attempt has verified evidence;
- no control action is pending;
- no owned Job is unresolved;
- every owned Endpoint is safe;
- spend is within the Run ceiling;
- normalized results and publication receipts are durable; and
- clean Bucket replay produces the same final state.

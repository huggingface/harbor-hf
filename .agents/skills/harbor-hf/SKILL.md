---
name: harbor-hf
description: "Plan and profile Harbor benchmark campaigns, then launch and monitor them. Repair and verify results before publishing through the hosted Harbor-HF control service and Hugging Face infrastructure."
---

# Harbor-HF operations

Use this skill for Harbor benchmark work on Hugging Face Jobs, Inference Providers, and Inference Endpoints.

The steady-state service has two persistent resources: one publicly reachable, application-protected control Space and one private `<artifact-bucket>` Bucket. The Space runs the TypeScript API, reconciler, disposable SQLite projection, and React console. The Bucket stores immutable control records, profiles, evidence, normalized results, and catalogs. Anonymous callers can reach only bounded static, login, callback, and health surfaces. Control access requires an access-listed identity or a short-lived worker capability.

Do not create a campaign-specific repository, Space, Bucket, Dataset, schedule, lease store, status store, backup store, or result service. A new persistent resource needs an explicit failure-domain or access reason and operator approval.

The control Space has one operator-managed persistent secret named `HF_TOKEN`. Keep its value, display name, and local alias private. Never forward it to a Job, Harbor Sandbox, benchmark agent, model server, browser, log, action payload, or evidence object. Workers receive only a short-lived signed capability scoped to their campaign, launch action, and tasks, and they never receive a writable mount of the canonical control Bucket.

## Read before operating

Read the relevant complete documents:

- `docs/CONTROL_SERVICE.md`
- `docs/architecture.md`
- `docs/run-spec.md`
- `docs/harbor-integration-contract.md`
- `docs/trial-evidence-bundle.md`
- `references/planning-and-capacity.md`
- `references/launch-and-monitoring.md`
- `references/recovery.md`
- `references/evidence-and-publication.md`
- `references/provider-agents-and-security.md`
- `references/operator-checklists.md`

Use the paid-compute-launch skill before launching, scaling, retrying, or automatically continuing paid accelerator work.

## Required workflow

### Inspect state

1. Confirm the repository state and current commit.
2. Confirm the control service is ready.
3. Inspect promoted profiles and every campaign or Job. Check the Endpoint and result views plus the audit view.
4. Check for an existing campaign or physical action before creating anything.
5. Classify the request as a new campaign, infrastructure repair, audit, publication recovery, or migration.

```bash
export HARBOR_HF_CONTROL_URL=https://<control-space>.hf.space
uv run harbor-hf status
uv run harbor-hf profiles
uv run harbor-hf campaign list
uv run harbor-hf jobs
uv run harbor-hf endpoints
```

### Resolve immutable inputs

Resolve and record:

- benchmark source revision and exact task input digests
- model ID and revision
- harness name and version plus image and configuration, prompt, tool, or skill revisions
- worker image digest and reviewed command
- deployment hardware and route, timeout, plus credential boundary
- launch policy with its physical-attempt limit and reservation plus ceiling and publication role

Aliases are only submission conveniences. The campaign lock must contain exact resolved profile identities and task digests.

### Apply the cost and capacity gates

Use representative wall time and throughput measurements. Include failed Jobs, replacements, provider calls, and endpoint active time in the cost range. Compare the result with the remaining cumulative authorization.

Stop when cost, hardware, model, route, method, or checkpoint assumptions differ from the approved launch.

### Launch once

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

Preserve the returned campaign ID and action ID. Repeating the same actor and idempotency key must adopt the existing request.

### Monitor logical and physical state

```bash
uv run harbor-hf campaign status <campaign-id>
uv run harbor-hf jobs
uv run harbor-hf endpoints
uv run harbor-hf results
uv run harbor-hf audit
```

A Job log or remote terminal state is not authoritative. The Bucket must contain the selected attempt receipt with its terminal selection, recorded cost, and evidence digest. Before posting that receipt, a worker uses its short-lived capability to upload content-addressed evidence chunks and a canonical manifest. The control service verifies the manifest and every chunk during acceptance and replay. Jobs never receive `HF_TOKEN` or a writable canonical Bucket mount.

Do not run benchmark tasks, model servers, or provider agents on the operator machine.

### Repair only infrastructure failures

```bash
uv run harbor-hf campaign retry-infrastructure <campaign-id> \
  --task <task-id> \
  --reason "<infrastructure reason>" \
  --yes
```

A retry is valid only when the task is unsealed, the latest attempt is an eligible infrastructure failure, and the physical-attempt limit remains. Semantic outcomes, refusals, verifier failures, and benchmark failures are terminal. The same is true for cancellations and benchmark timeouts.

Never rerun a valid logical task. Never turn publication recovery into inference.

### Verify cleanup and publication

A campaign is complete only when:

- every logical task is sealed
- no control action is pending
- every owned endpoint is paused with zero ready replicas
- spend remains within the ceiling
- publication receipts and normalized objects are durable
- catalog provenance validates
- rebuilding SQLite from Bucket records produces the same state

## Stop conditions

Stop immediately for:

- credential, cookie, header, or private route exposure
- input digest or source revision mismatch
- a deterministic shared worker defect
- unsupported backend, fallback, emulation, or runtime mismatch
- spend above the approved ceiling
- duplicate logical execution
- endpoint cleanup that cannot be verified
- a projection or immutable-object integrity error

Record the durable evidence and ask for an operator decision. Do not bypass a stop with a new resource, credential, compatibility path, or unreviewed runtime.

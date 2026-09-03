---
name: harbor-hf
description: "Plan, launch, monitor, recover, verify, and publish Harbor benchmark Runs on Hugging Face infrastructure through the hosted Harbor-HF control service."
---

# Harbor-HF operations

Use this skill for Harbor Runs on HF Jobs, direct Hugging Face inference, and
managed Inference Endpoints.

The steady-state platform has one protected control Space and one private
`<artifact-bucket>` Bucket. The Space runs the TypeScript API, reconciler,
disposable SQLite projection, and React console. The Bucket stores immutable
profiles, control records, Harbor locks, evidence, normalized results, and
catalogs.

Do not create Run-specific persistent infrastructure. A new repository, Space,
Bucket, Dataset, schedule, status store, result service, or other durable
resource requires a documented access or failure-domain reason and explicit
approval.

`HF_TOKEN` remains in the control Space. An execution Job receives
`HF_INFERENCE_TOKEN` only when its resolved deployment has an inference
upstream. Harbor supplies that credential and the locked upstream directly to
the selected reviewed agent through `AgentConfig.env`. Preparation and
no-inference Jobs receive no inference credential. Jobs never receive a
writable canonical Bucket mount.

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

Before any external mutation, also follow
`.agents/skills/project-authorization/SKILL.md` and verify the exact approved
scope in `projects/huggingface/harbor-hf.md`.

## Keep one Harbor path

- Harbor resolves the benchmark and owns the task, agent, verifier, lock, and
  native result.
- A credential-free preparation Job stores the exact `JobLock` and prepared
  trials before execution.
- Every physical attempt reconstructs one prepared trial and uses Harbor's
  public API.
- Benchmark, model, and harness names remain data.
- New harness code belongs in a Harbor agent plugin.
- Unsupported model, API, harness, or deployment combinations fail before
  launch; do not add translation or fallback behavior.

For direct inference, confirm that the immutable model, harness, and deployment
profiles resolve to one `AgentConfig`, that the provider suffix and APIs match,
and that the exact upstream host is allowed. The agent calls the upstream
directly.

## Required workflow

### 1. Inspect state and authorization

Confirm the repository revision, working tree, project authorization, control
service health, promoted profiles, existing Runs, active Jobs, owned Endpoints,
and pending control actions.

```bash
export HARBOR_HF_CONTROL_URL=https://<control-space>.hf.space
uv run harbor-hf status
uv run harbor-hf profiles
uv run harbor-hf capacity
uv run harbor-hf run list
uv run harbor-hf jobs
uv run harbor-hf endpoints
uv run harbor-hf audit
```

Classify the request as planning, new execution, infrastructure recovery,
publication recovery, audit, or migration. Do not turn one class into another
without approval.

### 2. Resolve immutable inputs

Record:

- benchmark source revision and exact task digests;
- model route and observable revision;
- inference provider, upstream, and API;
- harness import path, exact version, configuration, and evidence policy;
- Harbor and agent-package revisions;
- worker and task image digests;
- hardware, resources, timeouts, and output limit;
- launch policy, physical-attempt limit, Run ceiling, and publication role.

Aliases are submission conveniences. Review exact resolved profile records.

### 3. Apply capacity and spend gates

Use representative wall time, observed reliable concurrency, Job cost, model
price, possible replacements, Endpoint active time, and cleanup time. Compare
the conservative total with the Run ceiling and cumulative authorization.

Stop if cost, hardware, model, API, route, task count, attempt policy, or
checkpoint assumptions differ from approval.

### 4. Submit once

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

Preserve the Run ID, action ID, and idempotency key. After an ambiguous
response, inspect durable state and deterministic remote identity; do not
submit again blindly.

### 5. Monitor logical and physical state

```bash
uv run harbor-hf run status <run-id>
uv run harbor-hf jobs
uv run harbor-hf endpoints
uv run harbor-hf results
uv run harbor-hf audit
```

Logs are diagnostic. The authoritative outcome is the Bucket-backed selected
attempt receipt with a verified evidence manifest and terminal logical state.

### 6. Repair only infrastructure

```bash
uv run harbor-hf run retry-infrastructure <run-id> \
  --task <task-id> \
  --reason "<infrastructure reason>" \
  --yes
```

Require a typed replacement-eligible infrastructure failure, unchanged
prepared trial, remaining physical-attempt allowance, and sufficient Run
ceiling. Never rerun a valid semantic outcome.

### 7. Verify and publish

A Run is ready only when:

- every logical task is sealed;
- no action remains pending;
- selected evidence and checksums validate;
- credential scanning passes;
- spend remains within the ceiling;
- every owned Endpoint is paused with zero ready replicas;
- publication objects and receipts are durable; and
- replaying the Bucket yields the same state.

Publication recovery must not execute a task or call a model.

## Stop conditions

Stop immediately for:

- credential, cookie, capability, or private-route exposure;
- task, source, image, Harbor lock, model, agent, API, or upstream drift;
- a deterministic shared worker or agent defect;
- unsupported fallback, emulation, or request translation;
- duplicate logical execution;
- spend beyond approval;
- uncertain remote ownership after an ambiguous mutation;
- Endpoint cleanup that cannot be verified; or
- immutable-record or projection integrity failure.

Record durable evidence and request an operator decision. Do not bypass a stop
with a new resource, credential, Run identity, or unreviewed runtime.

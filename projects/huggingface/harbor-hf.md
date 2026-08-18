---
schema_version: v1
slug: huggingface/harbor-hf
repository: https://github.com/huggingface/harbor-hf
default_branch: main
---

# Harbor-HF

## Current authorization

Status: approved
Approved at: 2026-08-17T06:48:55Z
Amended at: 2026-08-17T09:13:49Z
Inference-token amendment approved at: 2026-08-17T15:37:46Z
Sandbox-lifecycle amendment approved at: 2026-08-17T18:39:15Z
Finalization amendment approved at: 2026-08-18T00:25:01Z
Terminal-Bench 2.1 amendment approved at: 2026-08-18T10:40:26Z
Terminal-Bench 2.1 USD 300 campaign-ceiling amendment approved at: 2026-08-18T17:20:36Z

### Scope

- Add the project-authorization skill and this repository-indexed project file through the normal contribution workflow.
- Finish deployment and hard cutover of the hosted TypeScript control service described by the approved control-service plan.
- Install the retained purpose-scoped service credential as the control Space's `HF_TOKEN` control secret.
- Run the hosted no-inference recovery and cutover canaries, plus only bounded paid canaries required by the approved plan.
- Promote the verified historical migration and enable production writes only after every required gate passes.
- Audit legacy consumers and unique objects before proposing any resource retirement.
- Make the existing control Space publicly reachable only after adding and verifying application-layer protection for operator, browser, and worker routes.
- Admit workers with short-lived, signed, campaign-scoped control capabilities.
- Install a separate, regularly rotated, inference-only Hugging Face credential in the existing control Space and pass it only to reviewed benchmark workers as `HF_INFERENCE_TOKEN`.
- Extend signed worker capabilities to exact Hugging Face Sandbox lifecycle operations performed by the control Space for an immutable campaign task.
- Prepare and run the requested Terminal-Bench 3 campaign for the locked model in low adaptive-thinking mode after the bounded paid canary and launch-review gates pass.
- Prepare and run Terminal-Bench 2.1 at revision `d49e28f1e4ddd13d289e85a5f312a66750951932` with `deepseek-ai/DeepSeek-V4-Flash-0731` at revision `7872f01b1d1fe23eabc4c98b48bffcef5a386062`, the reviewed Pi 0.84.2 worker, and high reasoning. Run the official five-trial protocol when the measured launch review and enforced campaign ceiling fit within the total project limit.
- Migrate the remaining active ShellBench result catalog, verify parity, replace the legacy results viewer, and perform the hard cutover without deleting legacy resources.

### Limits

- Deploy an exact merged source revision with writes disabled first.
- Use `cpu-upgrade` at USD 0.03 per active hour for the always-on control service.
- Keep total project spend within USD 300. This includes campaign, recovery, provider and endpoint costs plus the control service.
- For the next Terminal-Bench 2.1 production campaign, use the later explicitly approved USD 300 hard campaign ceiling. This campaign-specific amendment supersedes the preceding cumulative limit for that campaign only. Preserve and report all earlier spend separately.
- Do not create another persistent Space, Bucket, repository, Dataset, schedule, credential beyond the approved inference credential, lease store, status store, backup store, or result store.
- Do not rerun valid logical tasks or use inference during migration and publication recovery.
- Keep credential values, private resource identifiers, operator paths, and private topology out of Git and browsers. Do not expose credentials in logs or evidence; the approved inference credential may appear only in the trusted worker or root-owned inference bridge environment.
- Do not delete or retire a legacy resource without its completed private audit and a separate explicit approval for that resource.
- Anonymous callers may reach only bounded public surfaces such as static application assets, login initiation, OAuth return handling, and health checks. Control data and operator mutations remain deny-by-default.
- Add bounded request-body and anonymous request-rate controls before changing Space visibility. If hosted denial, capability, or abuse-control verification fails, restore private visibility, disable writes, and stop.
- Keep exactly two operator-managed Space secrets: the control credential `HF_TOKEN` and the inference-only `HF_INFERENCE_TOKEN`.
- Workers must never receive `HF_TOKEN`. They may receive only `HF_INFERENCE_TOKEN`, whose permissions are limited to serverless and Endpoint inference calls.
- Pin each worker image and command, enforce the locked model, route, token, request, concurrency, timeout, and cost limits in the worker bridge, and rotate the inference credential regularly. Revoke the prior credential only after every Job using it is terminal.
- Bind every Sandbox operation to the immutable campaign lock, launch action, task, expiration, approved image, hardware, paths, transfer limits, timeouts, and budget. Record fenced lifecycle receipts and do not expose a general Hugging Face API proxy.
- Keep `HF_TOKEN` in the control Space. Never pass it to a worker or Sandbox. The control Space may derive and use a per-Sandbox credential only inside its trusted process while handling an authorized lifecycle operation.
- Keep the first Terminal-Bench canary below USD 5. Treat the full campaign as substantial paid compute: measure throughput and cost first, preserve durable partial evidence, prove pause and resume, and obtain explicit approval for the exact trial count, concurrency, hardware, and hard cost ceiling before launch.
- For the approved Terminal-Bench 2.1 campaign, use one bounded representative canary and then continue without another conversational prompt only when the hosted control plane admits the measured worst-case cost for 89 tasks and five trials under the existing USD 300 total project limit. Count setup, canaries, retries, recovery, and cleanup. Allow only infrastructure replacements; never rerun a terminal semantic outcome.

### Remaining gates

No project-scope amendment remains pending. Operational gates still apply:

- Keep production writes disabled and use free development hardware until local security tests and bounded hosted canaries pass.
- Do not retire the legacy results viewer or stores until catalog parity is verified. No deletion is authorized.
- Keep each substantial paid campaign behind its measured launch review and exact enforced cost ceiling.

## Approval history

### 2026-08-17

- Approved the current scope and limits before the remaining project work starts.
- Directed the project to keep one authorization file indexed by canonical repository slug and to record approvals here.
- At 2026-08-17T09:13:49Z, approved protected public ingress for the existing control Space so workers can use short-lived capabilities without receiving a persistent Hugging Face credential.
- At 2026-08-17T13:30:03Z, requested an additional decision on capability-scoped inference and sandbox lifecycle operations plus the remaining legacy result-catalog migration.
- At 2026-08-17T15:37:46Z, approved replacing the proposed inference gateway with a separate inference-only credential passed to reviewed workers and rotated regularly. The broader control credential remains confined to the control Space. Sandbox lifecycle operations and remaining result-catalog migration remained pending.
- At 2026-08-17T18:39:15Z, authorized finalizing the project, including capability-scoped Sandbox lifecycle operations and the requested Terminal-Bench 3 low-thinking campaign. The full paid campaign remains subject to the mandatory measured-cost launch approval. Remaining result-catalog migration was still pending.

### 2026-08-18

- At 2026-08-18T00:25:01Z, approved all remaining project work needed for autonomous finalization, including result-catalog migration and viewer replacement. This did not authorize deleting legacy resources or bypassing the measured substantial paid-compute gate.
- At 2026-08-18T10:40:26Z, directed the project to run DeepSeek V4 Flash on Terminal-Bench 2.1 autonomously while separate web UI work proceeds. The campaign uses the existing enforced total project limit and does not authorize a new credential, persistent store, or unreviewed runtime.
- At 2026-08-18T17:20:36Z, set a USD 300 hard ceiling for the next Terminal-Bench 2.1 production campaign. This later campaign-specific limit supersedes the earlier cumulative USD 300 limit for that campaign only; earlier spend remains part of the reported project cost.

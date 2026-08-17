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

### Scope

- Add the project-authorization skill and this repository-indexed project file through the normal contribution workflow.
- Finish deployment and hard cutover of the hosted TypeScript control service described by the approved control-service plan.
- Install the retained purpose-scoped service credential as the control Space's only operator-managed `HF_TOKEN` secret.
- Run the hosted no-inference recovery and cutover canaries, plus only bounded paid canaries required by the approved plan.
- Promote the verified historical migration and enable production writes only after every required gate passes.
- Audit legacy consumers and unique objects before proposing any resource retirement.
- Make the existing control Space publicly reachable only after adding and verifying application-layer protection for operator, browser, and worker routes.
- Admit workers with short-lived, signed, campaign-scoped capabilities instead of a persistent Hugging Face credential.

### Limits

- Deploy an exact merged source revision with writes disabled first.
- Use `cpu-upgrade` at USD 0.03 per active hour for the always-on control service.
- Keep total project spend within USD 300. This includes campaign, recovery, provider and endpoint costs plus the control service.
- Do not create another persistent Space, Bucket, repository, Dataset, schedule, credential, lease store, status store, backup store, or result store.
- Do not rerun valid logical tasks or use inference during migration and publication recovery.
- Keep credential values, private resource identifiers, operator paths, and private topology out of Git and browsers. Do not expose them in logs or worker environments.
- Do not delete or retire a legacy resource without its completed private audit and a separate explicit approval for that resource.
- Anonymous callers may reach only bounded public surfaces such as static application assets, login initiation, OAuth return handling, and health checks. Control data and operator mutations remain deny-by-default.
- Add bounded request-body and anonymous request-rate controls before changing Space visibility. If hosted denial, capability, or abuse-control verification fails, restore private visibility, disable writes, and stop.
- Keep the existing single-secret rule. Workers must not receive `HF_TOKEN` or another persistent Hugging Face credential.

## Approval history

### 2026-08-17

- Approved the current scope and limits before the remaining project work starts.
- Directed the project to keep one authorization file indexed by canonical repository slug and to record approvals here.
- At 2026-08-17T09:13:49Z, approved protected public ingress for the existing control Space so workers can use short-lived capabilities without receiving a persistent Hugging Face credential.

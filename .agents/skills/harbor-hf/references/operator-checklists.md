# Operator checklists

## Control service deployment

- [ ] Exact source revision and root lockfile reviewed.
- [ ] Target Space and Bucket supplied privately and match approved resources.
- [ ] Space is application-protected and Bucket is private.
- [ ] Release was produced from the reviewed repository revision.
- [ ] `HF_TOKEN` is narrowly scoped to control operations and remains in the
      Space.
- [ ] `HF_INFERENCE_TOKEN` is distinct and narrowly scoped to inference.
- [ ] Credential values do not appear in source, arguments, plans, logs, or
      receipts.
- [ ] Write mode remains disabled until verification and explicit activation.
- [ ] OAuth identity, same-origin, CSRF, bearer, and worker-capability checks
      pass.
- [ ] A clean Bucket replay rebuilds the same projection.
- [ ] No extra persistent repository, Space, Bucket, Dataset, or schedule was
      created.
- [ ] Production hardware and monthly ceiling are separately approved.

## Worker and direct inference

- [ ] Worker image is pinned by registry digest.
- [ ] Harbor and agent-package revisions are exact.
- [ ] Preparation Jobs have no persistent credentials.
- [ ] No Job receives `HF_TOKEN` or a writable canonical Bucket mount.
- [ ] Only a deployment with `inference_upstream` receives
      `HF_INFERENCE_TOKEN`.
- [ ] Harbor `AgentConfig.env` contains the locked upstream, credential
      reference, timeout, and output limit.
- [ ] Model provider suffix, deployment provider, model API, and harness API
      match.
- [ ] Upstream hostname is in `extra_allowed_hosts`.
- [ ] Agent uses its native API without translation or fallback.
- [ ] Direct inference settings are cleared after the agent run.
- [ ] Agent descendants stop before workspace freeze and verification.
- [ ] Task-image digest, extraction limits, host UID, capability, and
      `no_new_privs` checks pass.

## New Run

### Scope and identity

- [ ] Project file authorizes the exact benchmark, model, harness, deployment,
      task count, method, and publication role.
- [ ] Exact source and task digests are reviewed.
- [ ] Exact model route and observable revision are reviewed.
- [ ] Exact agent import path and revision are reviewed.
- [ ] Worker and task images are immutable.
- [ ] No existing matching Run or unresolved action already exists.

### Capacity and spend

- [ ] Representative duration and reliable concurrency evidence reviewed.
- [ ] Job, inference, possible replacement, Endpoint, and cleanup costs are
      included.
- [ ] Physical-attempt limit is explicit.
- [ ] Run ceiling fits cumulative authorization.
- [ ] Shared capacity is available.

### Submission

- [ ] Promoted aliases resolve to the reviewed profile IDs.
- [ ] One stable idempotency key is retained.
- [ ] The final request is shown and confirmed.
- [ ] Returned Run and action IDs are recorded.
- [ ] An ambiguous response will be investigated, not repeated blindly.

## Live Run

- [ ] Preparation completed and Harbor lock digest validates.
- [ ] Logical and physical progress are monitored separately.
- [ ] Active Job identity matches the deterministic action.
- [ ] Evidence upload and receipt state are monitored.
- [ ] Spend and remaining ceiling are monitored.
- [ ] Replacement attempts are admitted only for typed infrastructure failure.
- [ ] Deterministic shared defects stop affected work.
- [ ] Endpoint ownership, health, and ready replicas are monitored when
      applicable.
- [ ] Logs are treated as diagnostic rather than authoritative.

## Cancellation

- [ ] Correct Run and reason confirmed.
- [ ] Durable cancellation intent recorded.
- [ ] New admission stopped.
- [ ] Active attempts drained or became terminal.
- [ ] Available evidence finalized.
- [ ] Owned Endpoints observed paused with zero ready replicas.
- [ ] Cleanup and cancellation receipts are durable.
- [ ] Final Run state confirmed.

## Recovery

- [ ] Failure classified from canonical evidence.
- [ ] Remote ownership and deterministic resource identity verified.
- [ ] Prepared trial and all behavior-affecting inputs remain unchanged.
- [ ] Replacement eligibility, attempt allowance, and spend admission pass.
- [ ] No valid semantic outcome is rerun.
- [ ] Any changed input creates a linked replacement Run.
- [ ] Original evidence and attempt history remain immutable.
- [ ] Recovery actions and receipts are append-only.

## Evidence and publication

- [ ] Every logical task has one selected terminal outcome.
- [ ] Harbor locks and results match preparation.
- [ ] Required workspace, session, trajectory, verifier, and provenance
      evidence exists.
- [ ] Every referenced object passes size and digest validation.
- [ ] Credential scans pass over paths and bytes.
- [ ] Scores and outcome counts are independently recomputed.
- [ ] Unknown hosted-service details remain unknown.
- [ ] Partial, diagnostic, corrected, or composite outputs are labeled.
- [ ] Publication derives only from canonical private evidence.
- [ ] Public output omits private topology, credentials, capabilities, and raw
      private evidence.
- [ ] Publication recovery does not execute benchmark work.

## Final operator report

Record:

- authorization source and remaining scope;
- repository and deployed revisions;
- Run ID and exact profile IDs;
- task count and attempt policy;
- model route, inference provider, API, and observable revision;
- Job and Endpoint identities inspected privately;
- logical outcome and physical attempt counts;
- replacement reasons;
- accepted cost and ceiling;
- evidence verification and credential-scan result;
- Endpoint final state;
- publication IDs and digests; and
- unresolved risks or required operator decisions.

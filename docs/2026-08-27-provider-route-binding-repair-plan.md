---
title: Repair provider route binding
author: Harbor-HF maintainers
date: 2026-08-27
tags: [profiles, providers, terminal-bench]
---

# Repair provider route binding

> **Historical record — superseded 2026-09-02.** The failure observations and
> approved work below are retained as dated facts. The described inference
> implementation is retired and must not be used for new work. Current agents
> connect directly through the resolved Harbor `AgentConfig`; see
> [`harbor-integration-contract.md`](harbor-integration-contract.md).

**Historical status.** This was an approved repair plan with deployment and
verification boundaries. It is now superseded by the notice above.

The first two-task reliability canary failed before it sent a provider request.
Both tasks used both allowed attempts and reported the same infrastructure
error. The root bridge model did not match the locked execution. The affected
Jobs are terminal, and no affected Endpoint remains active.

The two new deployment profiles copied the full Harbor agent model name into
`trial_job_template.inference_model`. The full name starts with the Harbor
provider segment `openai/`. The root bridge expects the same route after that
first segment is removed. The provider suffix stays in both forms.

The [control service specification](CONTROL_SERVICE.md#inference-model-route-binding)
defines this binding. The [provider agent architecture](provider-agent-architecture.md)
defines the wider custom-agent and bridge boundary.

## Scope

Preserve and verify the intended changes in these documents:

- `docs/CONTROL_SERVICE.md`
- `docs/2026-08-27-provider-route-binding-repair-plan.md`

Change these deployment profiles:

- `profiles/deployment/tb21-qwen3-8-27b-deepinfra-providers.json`
- `profiles/deployment/tb21-glm-5-3-flash-together-providers.json`

Change the existing reliability-matrix case in
`packages/control-core/test/terminal-bench-profiles.test.ts`.

The final contribution contains exactly these five files. The repair uses the
existing contribution branch and pull request 140. It deploys to the existing
control Space. It creates no persistent resource.

## Contracts

The Qwen Harbor agent name remains
`openai/Qwen/Qwen3.8-27B:deepinfra`. Its root bridge route becomes
`Qwen/Qwen3.8-27B:deepinfra`.

The GLM Harbor agent name remains
`openai/zai-org/GLM-5.3-Flash:together`. Its root bridge route becomes
`zai-org/GLM-5.3-Flash:together`.

Only the first `openai/` segment is removed. Model IDs and revisions stay
unchanged. Provider suffixes, harnesses, API, and prices also stay unchanged.
Hardware and timeouts stay unchanged. Concurrency stays unchanged. Trial count
and attempt limit stay unchanged. Publication role remains unchanged. The worker image and worker revision remain
pinned. The Harbor version remains pinned.

Each changed profile gets a new `record_id` from the existing content-derived
formula:

```text
deterministicId("profile", profile_kind, name, sha256(canonicalJson(spec)))
```

The profile aliases stay the same. New runs resolve the repaired profile IDs.
Existing run locks keep their original IDs and digests. The failed canary stays
a truthful failed run. The repair does not select an attempt, publish a result,
change its cost records, consume another attempt, or rewrite its evidence.

Observed spend and unsettled or terminal reservations remain separate values in
private control evidence. The repair does not hide or combine them. A new
canary needs a new stable idempotency key and a fresh cost check after this plan
is complete.

## Implementation

1. Confirm that the worktree is on `feat/tb21-reliability-matrix` and that its
   HEAD matches the remote branch and pull request 140. The initial changed path
   set must contain only the two intended documents. Re-read the failed run. It
   must still have two terminal exhausted tasks. Selected result and pending
   action counts must be zero. Publication must be absent, with zero active
   matrix Jobs and Endpoints.
2. Verify the two documents separately. Compare the `CONTROL_SERVICE.md`
   AI-smell result with the base branch and record the unchanged one violation
   and 14 review items as nonblocking baseline. Check the new plan on its own and
   require zero AI-smell violations. Run SimpleDoc and formatting checks. Run
   privacy and link checks, then check whitespace. Repair only new findings.
3. In the Qwen deployment profile, remove only the leading `openai/` from
   `trial_job_template.inference_model`. Recompute the content-derived
   `record_id`.
4. Apply the same change to the GLM deployment profile. Recompute its
   content-derived `record_id`.
5. Update the existing two-model test case. Keep each harness assertion on the
   full Harbor model name. Assert that each bridge model equals that name after
   the verified first `openai/` segment is removed. Keep the existing checks for
   every protected profile field.
6. Inspect the diff before broad checks. The changed path set must contain the
   two documents and two deployment profiles. It must also contain the focused
   test. A field-level comparison must show that each profile changed only its
   bridge model and content-derived record ID.
7. Run the focused test and all approved repository checks. Compare an unclear
   nonzero result with the base branch before deciding whether this change
   caused it. Keep unrelated baseline failures visible and nonblocking.
8. Create one Conventional Commit and push the contribution branch. Confirm
   that local HEAD matches the remote branch. Pull request 140 must point to the
   same commit, and required CI must report that commit. Do not merge or release.
9. Deploy that exact commit to the existing control Space. If the upload result
   is unclear, inspect the deployed revision before retrying. Do not create or
   rename a resource.
10. Wait for the projection rebuild. Verify the source revision and readiness.
    Verify that development mode is off and write mode is enabled. Check the
    resource contract and repaired profile IDs and routes. Check the integrity
    state. Re-read the failed canary and its immutable evidence. Check its cost
    state and Jobs. Check Endpoints, then finish without submitting a run.

## Checks

Run the AI-smell checks separately. `docs/CONTROL_SERVICE.md` is base-eligible:
the base and candidate each have one violation and 14 review items. Record this
unchanged finding as unrelated and nonblocking. The new plan is candidate-only
and must have zero violations. Do not combine the two files into one
non-base-eligible check.

Run these commands from the repository root:

```sh
npm test -- packages/control-core/test/terminal-bench-profiles.test.ts
npm run format:check
npm run lint
npm run typecheck
npm run check:generated
npm test
git diff --check
uv run python scripts/check_public_privacy.py .
npx -y @simpledoc/simpledoc check
```

Run the repository's programmatic link check and any additional gate required by
current guidance. Inspect complete output. Mutation testing is an optional
pre-release workflow and is not an every-commit gate for this repair.

The focused test must prove all of the following:

- Both changed profile records have valid content-derived IDs.
- Each harness keeps its full Harbor agent model name.
- Each bridge route removes only the first Harbor provider segment.
- Every protected model, provider, runtime, budget, and execution field stays
  unchanged.

Before deployment, local HEAD must match the remote branch. Pull request 140
must point to the same commit. Required CI must pass for that commit. An
unrelated baseline failure stays visible and does not become a passing result.

Deploy with:

```sh
npm run deploy:space -- <control-space>
```

The deployment output must report the pushed source revision. The existing
Space must reach `RUNNING` with development mode off. The control API must then
report initialization ready with writes enabled. It must report no projection
integrity error. It must also report the existing resource contract and both
repaired profile IDs and bridge routes.

## Failure handling

Stop before commit if the worktree, branch, pull request head, failed-run facts,
or worker cleanup state no longer matches the preflight.

Stop before push if a profile ID is not content-derived, a protected field
changed, a required command has incomplete output, or a change-related check
fails.

After an unclear commit, push, or deployment response, inspect the durable
result and adopt it when it matches. Do not repeat a completed effect. A Space
restart is allowed once only when the exact repaired revision is present and
startup is demonstrably stalled.

Stop the repair for credential exposure, revision or digest mismatch, provider
fallback, unsupported API behavior, duplicate logical execution, evidence or
projection integrity failure, unverified cleanup, or a budget violation. If the
same route mismatch appears in the next separately authorized canary, stop
instead of adding a compatibility path or spending another attempt.

## Boundaries

This plan does not change Harbor upstream, Pi, Hugging Face platform behavior,
the worker image, or any unrelated repository or Job. It does not change the
profile schema, resolver, control API, run-lock schema, worker protocol, adapter
behavior, benchmark tasks, or publication contract.

This plan does not launch, retry, or resume a canary or full diagnostic run. It
does not rewrite or delete historical tasks, attempts, Jobs, evidence, costs,
publications, or locks. It does not merge pull request 140 or publish a release.

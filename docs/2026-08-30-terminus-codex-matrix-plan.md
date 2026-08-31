---
title: Add Terminus and standalone Codex harnesses
author: Harbor-HF maintainers
date: 2026-08-30
tags: [agents, codex, terminus, mini-swe-agent]
---

# Add Terminus and standalone Codex harnesses

**Status.** The harnesses are implemented. The runnable matrix has nine cells.
GLM-5.3-Flash through Together plus standalone Codex is an unsupported cell:
Codex 0.118.0 requires Responses, while the Together route provides Chat
Completions. The matrix skips this cell without a run or benchmark failure.
Qwen3.8-27B through DeepInfra plus Codex remains a native Responses cell.

## Goal

Support the exact Terminal-Bench harness set Pi, mini-swe-agent, Terminus, FX,
and standalone Codex. Keep each harness identity and native wire API. Bound
mini-swe-agent before it reaches the outer task timeout.

## Source change

Add a `terminus` profile backed by Harbor 0.22's `Terminus2`. The adapter must
validate the locked Chat Completions Job route, use the immutable model limits
and prices as LiteLLM model information, and stop the root bridge before the
verifier starts. The profile name is `terminus`; Harbor results retain the
`terminus-2` identity and version 2.0.0.

Add a standalone `codex` profile backed by Harbor 0.22's official Codex adapter
and exact Codex CLI version 0.118.0. The adapter must use native Responses,
preserve the complete namespaced model ID, run under the isolated agent account,
and retain Harbor's config, session, trajectory, and cleanup behavior. It must
not use OpenClaw or report an OpenClaw identity.

Set mini-swe-agent's per-task cost limit to USD 0.25. Generate its LiteLLM model
registry from the immutable inference contract, including exact model identity,
context and output limits, and input, output, cache-read, and cache-write prices.
Do not disable the limit or use an unpriced fallback.

The route loader may expose a validated non-secret route object to trusted
in-process code. Installed agents still perform the existing process-isolation
check. Bridge ownership and cleanup may accept the trusted Terminus object for a
Job bridge, but environment-owned bridges still require an installed agent that
can execute as root.

## Contracts

Terminus and mini-swe-agent use Chat Completions. Standalone Codex uses
Responses. The root bridge exposes only the selected API. There is no API
translation, payload normalization, or fallback to another harness. A cell is
runnable only when the deployment's native API matches the harness capability.
Unsupported cells are recorded and skipped before run admission.

Models, providers, revisions, benchmark tasks, prices, context and output
limits, evidence rules, publication rules, timeouts, concurrency, credentials,
and budget policy stay unchanged. The generated model information copies these
values; it does not become another source of truth.

The source pull request adds harness profiles only. It does not add Codex to a
Chat Completions deployment or point an active deployment at source that its
pinned worker does not contain.

## Tests

Add focused tests that prove:

- Terminus validates the exact Job route, keeps `terminus-2` identity, and
  cleans up the bridge;
- standalone Codex requests Responses, preserves the full model ID, uses the
  isolated user, installs 0.118.0, and never invokes OpenClaw;
- mini-swe-agent receives USD 0.25 and an exact model registry for both matrix
  models;
- profile IDs remain deterministic and all profiles pass the generated schema;
- existing installed-agent route and cleanup behavior remains unchanged.

Run the complete agent-package suite and applicable repository checks from
`CONTRIBUTING.md`. Keep Python coverage at or above 85%. Run generated checks,
privacy validation, dependency audits, and Pi Reviewer until no P0 or P1
finding remains. Inspect the full diff and public metadata before each public
operation.

## Rollout

Pin the two existing Chat Completions deployments to the exact merged worker
revision and image digest. Their harness list is `pi-off`, `mini-swe-agent`,
`terminus`, `fx`, and `pi`. Keep the Responses-only `codex` deployment for
Qwen3.8-27B through DeepInfra. Do not create a Codex deployment for
GLM-5.3-Flash through Together. Preserve each runnable model, provider, price,
context limit, output limit, Job policy, and evidence contract. Regenerate
deterministic profile IDs and rerun all profile and contract checks.

Merge and deploy only after the profile change is reviewed and green. Paid
canaries are a later action. Run one exact cell at a time and require positive
input and output tokens, valid receipts, exact provenance, publication, cost
reconciliation, and cleanup. Stop if the same deterministic failure repeats
after this reviewed repair.

## Boundaries

Do not change upstream Harbor, Codex, Terminus, mini-swe-agent, providers,
benchmark data, or external services. Do not add a compatibility fallback,
model alias, API or payload translation, new service, repository, credential,
Endpoint, Space, Bucket, Dataset, or release.

The source change does not publish a worker, edit active deployments, deploy the
control service, launch a Job, call a provider, run a canary, merge before review
and green CI, or expose operator-specific details.

---
title: Add Terminus and standalone Codex harnesses
author: Harbor-HF maintainers
date: 2026-08-30
tags: [agents, codex, terminus, mini-swe-agent]
---

# Add Terminus and standalone Codex harnesses

> **Historical record — superseded 2026-09-02.** The matrix results and cost
> estimates below are retained as dated facts. Retired harness entries and the
> former inference implementation are not active support or launch guidance.
> Current compatibility follows
> [`harbor-integration-contract.md`](harbor-integration-contract.md).

**Historical status.** The recorded runnable cells completed their two-task
canaries. The compatibility observations remain factual, but the former next
stage and retired harness entries are not active launch instructions.

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

Use the `tb21-mini-swe-canary` launch policy for mini-swe-agent canaries. Reserve
USD 0.70 for each trial attempt because the agent checks its cost limit between
requests, so one final maximum-size request can exceed the USD 0.25 threshold
before the agent stops. The reservation covers that request, the locked cache
prices, and the maximum CPU Job duration. Limit this canary Run to USD 3.00 so
two tasks and their allowed infrastructure attempts fit inside one immutable
ceiling without under-reserving exposure. Keep the shared canary and replacement
policies unchanged because other harnesses do not have mini-swe-agent's cost cap.

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

The original source pull request added harness profiles only. It did not add
Codex to a Chat Completions deployment or point an active deployment at source
that its pinned worker did not contain.

## Full campaigns

Add `terminal-bench-2-1-full` as the exact 89-task, one-trial benchmark profile.
It uses the same revision, task IDs, task digests, source task IDs, and artifact
contract as the first trial of `terminal-bench-2-1-official-5`. Set Harbor's
requested task concurrency to 16. The shared namespace capacity remains the
hard global limit, so two active Runs still share at most 16 physical Jobs.

Use a measured launch policy for each runnable cell. Pi and Codex on Qwen share
one policy, and Pi, Terminus, and FX on GLM share another, because their rounded
reserves and ceilings are identical. The other cells use distinct policies. The
measured low estimate scales the
cell's complete two-task canary cost from 2 to 89 tasks. The per-attempt
reservation is at least twice the higher canary task cost and is rounded up to a
simple amount. The two mini-swe-agent policies instead cover the USD 0.25 agent
limit, one final maximum-size request, and CPU time at each model's locked
prices. Each immutable ceiling matches the launch form's generated bound: two
times 89 trial reservations plus two preparation reservations. This equals 178
trial reservations plus four USD 0.05 preparation reservations.

Mark the full benchmark as requiring a profile-constrained launch policy. Each
full policy lists its allowed benchmark, model, harnesses, and deployments. The
resolver rejects a generic policy or a policy from another cell before run
admission. This prevents a low-cost policy from being selected for a higher-cost
cell.

| Cell | Canary cost | Measured low | Attempt reserve | Run ceiling |
| --- | ---: | ---: | ---: | ---: |
| Qwen plus Pi | USD 0.148153 | USD 6.592809 | USD 0.25 | USD 44.70 |
| Qwen plus mini-swe-agent | USD 0.351956 | USD 15.662042 | USD 0.70 | USD 124.80 |
| Qwen plus Terminus | USD 0.159101 | USD 7.079994 | USD 0.20 | USD 35.80 |
| Qwen plus FX | USD 0.245204 | USD 10.911578 | USD 0.40 | USD 71.40 |
| Qwen plus Codex | USD 0.123175 | USD 5.481288 | USD 0.25 | USD 44.70 |
| GLM plus Pi | USD 0.046113 | USD 2.052029 | USD 0.10 | USD 18.00 |
| GLM plus mini-swe-agent | USD 0.022520 | USD 1.002140 | USD 0.50 | USD 89.20 |
| GLM plus Terminus | USD 0.047060 | USD 2.094170 | USD 0.10 | USD 18.00 |
| GLM plus FX | USD 0.068910 | USD 3.066495 | USD 0.10 | USD 18.00 |

The policy mapping is:

- Qwen plus Pi and Qwen plus Codex: `tb21-full-qwen-standard`;
- Qwen plus mini-swe-agent: `tb21-full-qwen-mini-swe-agent`;
- Qwen plus Terminus: `tb21-full-qwen-terminus`;
- Qwen plus FX: `tb21-full-qwen-fx`;
- GLM plus Pi, GLM plus Terminus, and GLM plus FX:
  `tb21-full-glm-standard`;
- GLM plus mini-swe-agent: `tb21-full-glm-mini-swe-agent`.

The measured low estimates total USD 53.942544. They are planning estimates
from two tasks, not statistical confidence bounds. The nine immutable ceilings
total USD 464.60. These are not money spent. Before each launch, the operator
must add observed campaign cost, active unsettled exposure, the complete next
Run ceiling, and continued control-service runtime, then verify that the durable
campaign limit still admits the action.

Launch one full Run first. Treat its first admitted group as the representative
pilot wave. Verify terminal receipts, positive tokens, observed task costs,
durations, provenance, and durable partial output before a second campaign
starts. If the first wave proves a deterministic shared defect, pause affected
work at durable task boundaries. Otherwise allow at most two full Runs to remain
active, with the global 16-Job capacity shared between them. A valid task never
runs again, and only a receipt classified as an eligible infrastructure failure
can use the second physical attempt.

The full-profile change adds only the benchmark profile, six launch policies,
focused profile tests, and this plan update. It does not change a model, harness,
deployment, worker, provider, benchmark task, price, context limit, output
limit, evidence rule, or publication rule. It does not launch paid work.

## Tests

Add focused tests that prove:

- Terminus validates the exact Job route, keeps `terminus-2` identity, and
  cleans up the bridge;
- standalone Codex requests Responses, preserves the full model ID, uses the
  isolated user, installs 0.118.0, and never invokes OpenClaw;
- mini-swe-agent receives USD 0.25 and an exact model registry for both matrix
  models;
- profile IDs remain deterministic and all profiles pass the generated schema;
- the full benchmark contains exactly the 89 first-trial tasks and requests
  concurrency 16;
- the full benchmark rejects generic and wrong-cell launch policies;
- every full policy ceiling equals 178 trial reservations plus four preparation
  reservations, and all nine ceilings total USD 464.60;
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

Merge and deploy the full profiles only after the change is reviewed and green.
Verify the exact source revision, active profile IDs, task count, ceilings,
write readiness, idle capacity, and zero managed Endpoints before admitting a
full Run. Record a fresh private launch review before each paid action.

Start with one full campaign and inspect its first wave. Then run staged batches
with no more than two full campaigns active and no more than 16 physical Jobs in
the shared namespace. Require positive input and output tokens, valid terminal
receipts, exact provenance, durable partial outputs, final publication, cost
reconciliation, and cleanup. Keep GLM plus Codex as unsupported and do not
create a Run for it.

## Boundaries

Do not change upstream Harbor, Codex, Terminus, mini-swe-agent, providers,
benchmark data, or external services. Do not add a compatibility fallback,
model alias, API or payload translation, new service, repository, credential,
Endpoint, Space, Bucket, Dataset, or release.

The source change does not publish a worker, edit active deployments, deploy the
control service, launch a Job, call a provider, run a canary, merge before review
and green CI, or expose operator-specific details.

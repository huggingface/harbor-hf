---
title: Bind the OpenCode chat driver
author: Harbor-HF maintainers
date: 2026-08-27
tags: [agents, opencode, providers]
---

# Bind the OpenCode chat driver

**Status.** Approved implementation plan. This work ends after the tested source
change is committed and pushed to the existing task branch. It does not deploy a
worker or run a remote canary.

Durable execution evidence showed that OpenCode sent a Responses request while
the locked Job route allowed only Chat Completions. The strict loopback bridge
rejected the request before provider usage. The adapter relied on OpenCode's
built-in provider default instead of selecting the driver required by the
registered wire API.

The [Harbor compatibility contract](harbor-integration-contract.md#custom-provider-agents)
defines the agent-owned driver selection and strict bridge boundary. The
[control service specification](CONTROL_SERVICE.md#inference-model-route-binding)
defines the separate binding between the Harbor-facing model name and the root
bridge route.

## Goal

Make every compatible OpenCode Chat Completions configuration select OpenCode's
documented OpenAI-compatible driver. Preserve the locked model identity,
loopback route, one-API bridge, and unrelated caller configuration.

## Scope

Change only these implementation files:

- `packages/harbor-hf-agents/src/harbor_hf_agents/opencode/agent.py`
- `packages/harbor-hf-agents/tests/test_opencode.py`

Keep this plan and the Harbor compatibility contract accurate as the work
proceeds. Review all changes against `origin/feat/tb21-reliability-matrix`.
Commit and push the existing `fix/opencode-worker-canary` branch after all
checks pass.

## Contracts

The generated OpenCode provider entry must declare:

```json
{
  "npm": "@ai-sdk/openai-compatible"
}
```

This field selects Chat Completions behavior for the adapter's existing Job
route. The adapter continues to derive the provider and complete nested model ID
from the generic Harbor model string. The Harbor-facing model string, adapter
import path, OpenCode version, allowed bridge model, provider identity, route
URL, evidence records, and outcome rules stay unchanged.

Caller `opencode_config` remains supported. The adapter copies it before adding
the route-owned provider fields. Unrelated provider options, model entries, and
top-level settings survive the merge. The adapter-owned npm driver, loopback
`baseURL`, and locked model registration replace conflicting caller values.

The root bridge remains fail-closed on the one API selected by the immutable
route. It does not accept a Responses request for a Chat Completions route and
does not translate between the two APIs.

This is a direct adapter correction. It adds no fallback, compatibility path,
or branch based on a run, benchmark, model, provider, task, or harness name. It
changes no profile, run lock, schema, API, storage record, publication record,
or live resource. Existing immutable runs and evidence stay unchanged.

## Implementation

### OpenCode adapter

In `OpenCodeAgent.after_route_prepared`, add an adapter-owned constant or literal
for `@ai-sdk/openai-compatible`. Include it as the authoritative `npm` field in
the provider entry after the Job route is ready.

Keep the existing generic provider and model parsing. Keep the loopback
`baseURL` authoritative. Use the existing deep merge so unrelated caller fields
remain present.

### Regression tests

Strengthen the existing Job-route test to inspect the structured provider
configuration. It must prove all of these facts:

- the npm driver is `@ai-sdk/openai-compatible`;
- the allowed model keeps its complete nested model ID;
- the loopback base URL and placeholder key reach the agent;
- the run command keeps the original Harbor-facing model string; and
- the bridge stops exactly once.

Add a merge test with a different compatible nested model ID and conflicting
caller provider fields. The route-owned npm driver, base URL, and locked model
registration must win. Unrelated caller options, models, and top-level fields
must remain.

Keep the existing missing-route and isolated-agent installation tests. All tests
use mocks. They must not make an inference or remote request.

## Verification

Run the focused test first:

```sh
uv run --project packages/harbor-hf-agents \
  pytest packages/harbor-hf-agents/tests/test_opencode.py
```

Run the package checks:

```sh
uv run --project packages/harbor-hf-agents \
  ruff check packages/harbor-hf-agents
uv run --project packages/harbor-hf-agents \
  ruff format --check packages/harbor-hf-agents
uv run --project packages/harbor-hf-agents \
  ty check packages/harbor-hf-agents/src packages/harbor-hf-agents/tests
uv run --project packages/harbor-hf-agents \
  pytest packages/harbor-hf-agents/tests
```

Run the applicable repository checks:

```sh
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov=src/harbor_hf --cov-fail-under=85
uv run slophammer-py dry .
uv run python scripts/check_mutation.py --min-kill-rate 90
```

Run any generated-contract or npm check required by the final changed-file set.
Run Pi Reviewer against `origin/feat/tb21-reliability-matrix` until it reports no
P0 or P1 finding.

Before commit and push, inspect the complete diff and public metadata, then run:

```sh
git diff --check
uv run python scripts/check_public_privacy.py .
```

Use a focused Conventional Commit such as
`fix(agents): bind OpenCode chat completions driver`. Push only the existing task
branch to the configured fork. Verify that the remote branch points to local
`HEAD` and that the worktree is clean.

## Failure handling

Stop if OpenCode's pinned configuration contract does not accept the documented
npm driver, if the structured merge cannot keep unrelated caller fields, or if
a change-related check fails. Do not broaden the bridge, add translation, roll
back the runtime, or add an identity-based special case.

A local test cannot attest a real provider request. Keep that limit explicit.
The strict bridge remains the runtime guard. A remote canary, worker deployment,
or failed-run replacement needs separate scope and is not part of this plan.

Stop before a public commit or push if the diff, commit metadata, generated
files, or logs contain private evidence, operator details, credentials, private
infrastructure, or machine-specific paths.

## Boundaries

This plan does not change Harbor, OpenCode, AI SDK packages, inference
providers, profiles, model IDs, harness names, provider selection, deployment
configuration, run locks, schemas, or immutable evidence.

It does not rerun, retry, resume, replace, publish, or otherwise change a failed
run. It does not launch paid work, inference, Jobs, Endpoints, Spaces, Buckets,
or a remote canary. It does not move or store credentials.

It does not open a pull request, merge, deploy, release, change repository
policy, edit another repository, rewrite comparison-base history, or change
unrelated files.

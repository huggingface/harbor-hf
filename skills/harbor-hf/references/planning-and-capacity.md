# Planning and capacity

This reference defines the preflight work required before Harbor HF creates
paid remote work. The manifest schema proves structure and identity. The
operator must also prove that each wave fits its runtime and spend bounds.

## Required operator inputs

Collect these values before editing a manifest:

- benchmark source type, anonymous Git commit or local directory, exact task
  selection, task digests, and attempt count;
- model repository and full source commit;
- deployment kind, provider route or endpoint identity, and wire API;
- agent name, custom import path when required, and exact revision;
- judge provider, API URL, model, reasoning policy, and secret name;
- private namespace, control Dataset, input Bucket, evidence Bucket, result
  Dataset, and index Dataset;
- controller image digest, worker commit, Harbor commit, and Sandbox flavor;
- provider request concurrency and request interval, or selected endpoint
  serving profile;
- trial and shard timeouts plus wave, Sandbox, controller Job, judge, and
  capture timeouts;
- campaign spend cap, per-wave reservation, retry policy, and maximum active
  waves;
- publication role and evaluation identity.

Missing policy choices should remain visible. Do not silently copy them from a
campaign with a different model, runtime, agent, judge, or provider.

## Immutable identity review

Inspect every behavior-affecting reference. Full campaigns require:

- 40-character lowercase commits for anonymously readable public Git sources,
  or a verified content and manifest digest for a local-directory bundle;
- `@sha256:` image digests;
- exact package versions or full Git agent revisions;
- a complete task-name-to-digest map;
- a model source revision even when an Inference Provider cannot prove the
  served revision;
- one exact worker revision that also pins `packages/harbor-hf-agents`;
- private storage destinations and explicit publication identity.

Planning should produce the same semantic plan from two clean checkouts. Keep
both outputs when introducing a new source or deployment. Compare
`plan_digest`, `manifest_digest`, `source.lock.json`, bundle content and manifest
digests when applicable, run IDs, deployment digests, task identities, shard
composition, and trial identities. Equivalent directory contents at different
operator paths must produce the same source content digest and semantic plan.

A Git source must pass anonymous preflight with local credential helpers and
authentication variables disabled. If it needs authentication, use a local
checkout and the directory-bundle flow. Never solve a private-source failure by
adding a Git token to an HF Job.

## Trial count review

Compute the expected logical trial count independently:

```text
logical trials = selected tasks * logical attempts * resolved matrix cells
```

The campaign plan reports `run_count`, `shard_count`, and `trial_count`. Inspect
`runs[].shards[].trials[]` to verify task names and logical attempts. Include
literal task names that contain spaces, brackets, or deprecation labels when
they are part of the pinned protocol.

Infrastructure retries create physical executions beneath the same logical
trial. They do not increase the logical trial count and do not consume a new
attempt ordinal.

## Deployment profiling

Use `docs/deployment-profiling.md` for a new endpoint configuration, provider
route, model, agent, benchmark workload, context limit, output limit, reasoning
mode, or Harbor runtime. The profile must use representative benchmark tasks.
A synthetic token test cannot select Harbor trial concurrency.

The profile ladder starts at concurrency 1 and tests powers of two. Each point
needs at least `max(8, 2 * concurrency)` observations, and boundary points need
three successful repetitions. Store raw measurements and the selected profile
in the private Bucket. Bind the selected profile to the campaign when the
manifest supports it.

Provider-backed agents still need profiling. Provider request concurrency,
Harbor trial concurrency, request spacing, and active waves are separate
limits. Record all four. The controller uses one parent-checked namespace claim
per provider service, so independent campaigns cannot run internal waves against
the same service concurrently. This conservative limit stays at one until a
future immutable contract can prove and divide a larger shared quota.

## Effective concurrency

For duration planning, choose the most restrictive measured bottleneck. A
conservative provider estimate is:

```text
effective concurrency = min(
    execution.concurrent_trials,
    provider.limits.max_concurrent_requests,
    measured stable concurrency,
)
```

For endpoint work, use the selected serving profile and the measured Harbor
trial concurrency. Replica count and server sequence capacity remain separate
quantities unless the profile evidence proves their relationship.

Do not treat `execution.concurrent_trials` as provider parallelism. Several
Harbor trials can wait behind one fleet-wide provider request slot.

## Wave duration arithmetic

Use a high-percentile or conservative observed end-to-end trial duration from
the same workload. It must include agent startup, model calls, tools, verifier,
judge, evidence capture, and trial publication. Keep one separate reserve for
wave bootstrap, drain, final evidence, and endpoint cleanup when applicable.

For a wave containing `T` trials with effective concurrency `C`:

```text
batches = ceil(T / C)
work estimate = batches * planning trial duration
bounded estimate = work estimate * headroom factor + fixed reserve
```

The gate is:

```text
bounded estimate <= execution.timeout_seconds
```

The enclosing controller Job must also satisfy the limits in
`docs/run-spec.md`. Endpoint-backed Jobs need at least 4,800 seconds beyond the
execution timeout and must stay within the controller ceiling. Sandbox idle
time must exceed the longest uninterrupted agent or verifier command.

For provider-backed campaigns, the same execution deadline still bounds Harbor
work. A long controller Job does not rescue a wave whose shorter execution
deadline has expired.

## Mechanical duration check

Generate a current plan and run:

```bash
uv run harbor-hf validate MANIFEST
uv run harbor-hf campaign plan MANIFEST --format json > PLAN.json
uv run python skills/harbor-hf/scripts/check_wave_budget.py \
  --manifest MANIFEST \
  --plan PLAN.json \
  --planning-trial-seconds 480 \
  --reserve-seconds 900 \
  --headroom-factor 1.25
```

The numbers above are examples. Derive them from the matching canary or profile
and document the chosen reserve and headroom. The script groups compatible
shards by deployment digest, applies `max_shards_per_wave`, uses the tighter of
trial and provider request concurrency, and reports each possible wave.

A successful exit means the stated assumptions fit mathematically. It does not
prove provider availability or endpoint stability. A nonzero exit blocks paid
submission.

## Failed-wave example

The following shape cannot pass a duration review:

```yaml
execution:
  concurrent_trials: 16
  max_trials_per_shard: 16
  max_shards_per_wave: 44
  timeout_seconds: 16200
matrix:
  deployments:
    - kind: inference-provider
      limits:
        max_concurrent_requests: 1
```

A 690-trial run can place all 44 shards in one wave. Provider concurrency limits
the conservative effective concurrency to 1. Even an unrealistically low
three-minute planning duration needs 124,200 seconds before reserve. The
16,200-second deadline is impossible.

The safe correction changes the immutable campaign manifest. Reduce the number
of shards per wave until the measured estimate fits. If one shard remains too
large, reduce `max_trials_per_shard`. Generate a new campaign identity and keep
the superseded manifest as provenance.

## Canary design

A transport canary should prove one complete trial for each applicable
combination of provider and API for each agent family. Validate:

- the exact worker and Harbor revisions;
- custom-agent loading and reported agent revision;
- routed model and provider identity;
- successful provider continuation, including tool results;
- required locked parameters;
- judge model and reasoning policy;
- native session and ATIF trajectory;
- workspace output and verifier records;
- root-owned ingress isolation from the unprivileged agent;
- checksums, terminal markers, remote artifact verification, and secret scan.

A transport canary does not estimate full-wave throughput by itself. Run a pilot
wave with representative tasks and the intended concurrency. Use its p50, p95,
maximum trial duration, provider request count, queueing, finalization time, and
cleanup time for the full-wave calculation.

## Spend arithmetic

Provider campaigns require `max_spend_usd` and `estimated_wave_cost_usd`
together. The controller reserves the next wave estimate and may retain it after
the wave closes when provider billing is unattributed.

Before launch, compute:

```text
maximum concurrently reserved campaign spend = estimated next-wave cost

retry reservation requirement =
    estimated cost of every infrastructure retry generation allowed by policy
```

Both must fit the campaign cap. Do not assume a closed wave releases its full
reservation. If the cap cannot admit the declared retry generation, fix the
manifest before launch. An immutable campaign whose retained reservation blocks
a retry needs a linked replacement campaign or an explicit terminal decision.

Endpoint campaigns also need price and startup estimates together with active
drain plus retry estimates.
Unknown quota or price fails profiling preflight.

## Go decision record

Keep a small, secret-free launch record with:

- manifest and plan digests;
- selected task and run counts plus shard and trial counts and the wave count;
- measured workload and profile digest;
- effective concurrency and its limiting factor;
- planning trial duration and headroom factor plus reserve and worst-wave
  estimate;
- execution, Sandbox, and controller deadlines;
- spend cap, per-wave estimate, active-wave bound, and retry capacity;
- canary and pilot evidence paths;
- operator authorization and timestamp.

A later operator should be able to reconstruct the launch decision without
reading chat history.

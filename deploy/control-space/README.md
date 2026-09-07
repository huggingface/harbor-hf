---
title: Harbor-HF Control
nsfw: false
sdk: docker
app_port: 7860
hf_oauth: true
hf_oauth_expiration_minutes: 720
hf_oauth_scopes:
  - jobs
  - inference-api
suggested_hardware: cpu-upgrade
---

> **Personal execution wiring:** `/personal` provides supplied-token identity,
> native configuration preview, exact-approval-gated dedicated HF Job dispatch,
> personal Jobs/logs, and private artifact inspection. No launch is approved by
> deployment alone. See `docs/personal-execution.md` in the release source.
>
> **Historical execution-disabled integration (2026-09-04):** This greenfield branch is not
> production-ready. Run submission, actions, remote setup tests, and automatic
> reconciliation are disabled before admission or credential resolution, even
> when configuration writes are enabled. Workbench saves native Harbor JobConfig
> fragments; New Run previews configuration without task resolution or a Job.
> HF_TOKEN stays exclusively in the control Space. Neither persistent secret is
> forwarded. Parent-worker execution and private Hub/Harbor patches are removed.
> Execution descriptions below are deferred design, not available behavior or
> permission to launch. See [execution boundary](../../docs/execution-disabled-integration.md).

# Harbor-HF control

This private Docker Space runs the Harbor-HF API and web console.
Historical automatic reconciliation remains disabled.
The release comes from one exact Harbor-HF source revision.

The Space uses one private Bucket for immutable run records, mutable desired
state, and Harbor job folders. SQLite is a disposable local projection.

Operators retain two distinct persistent secrets: HF_TOKEN for control-side
Bucket access and HF_INFERENCE_TOKEN for a future reviewed inference boundary.
Neither persistent secret is forwarded. Personal operations instead require a
separate supplied user token matching the signed-in identity; dispatch additionally
requires exact, single-use server approval. Without a configured approval file,
deployment cannot enable paid launches. Configuration writes do not require a
parent image. Historical Run actions remain disabled.

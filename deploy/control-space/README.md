---
title: Harbor-HF Control
nsfw: false
sdk: docker
app_port: 7860
hf_oauth: true
hf_oauth_expiration_minutes: 720
suggested_hardware: cpu-upgrade
---

> **Execution-disabled integration (2026-09-04):** This greenfield branch is not
> production-ready. Run submission, actions, remote setup tests, and automatic
> reconciliation are disabled before admission or credential resolution, even
> when configuration writes are enabled. Workbench saves native Harbor JobConfig
> fragments; New Run previews configuration without task resolution or a Job.
> HF_TOKEN stays exclusively in the control Space. Neither persistent secret is
> forwarded. Parent-worker execution and private Hub/Harbor patches are removed.
> Execution descriptions below are deferred design, not available behavior or
> permission to launch. See [execution boundary](../../docs/execution-disabled-integration.md).

# Harbor-HF control

This private Docker Space runs the Harbor-HF API, reconciler, and web console.
The release comes from one exact Harbor-HF source revision.

The Space uses one private Bucket for immutable run records, mutable desired
state, and Harbor job folders. SQLite is a disposable local projection.

Operators retain two distinct persistent secrets: HF_TOKEN for control-side
Bucket access and HF_INFERENCE_TOKEN for a future reviewed inference boundary.
Neither is forwarded. This branch cannot launch or act on Jobs. Configuration
writes do not require a parent image; execution remains disabled regardless of
configured image or runner values. See `docs/execution-disabled-integration.md`.

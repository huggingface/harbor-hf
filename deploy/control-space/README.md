---
title: Harbor-HF Control
sdk: docker
app_port: 7860
hf_oauth: true
hf_oauth_expiration_minutes: 720
suggested_hardware: cpu-upgrade
---

# Harbor-HF control

This protected Docker Space runs the Harbor-HF API, reconciler, disposable
SQLite projection, and web application from one exact reviewed source
revision.

The Space reads and writes immutable objects in the canonical private artifact
Bucket. Operators configure:

- `HF_TOKEN` for Bucket and Hugging Face lifecycle operations; and
- `HF_INFERENCE_TOKEN` for execution Jobs that use direct inference.

Deployment-specific resource identifiers and initial OAuth operator subjects
remain private Space variables.

Preparation and execution Jobs use signed capabilities bound to one Run,
launch action, task set, operation set, and expiration. The service never sends
`HF_TOKEN` or a writable Bucket mount to a Job. It sends
`HF_INFERENCE_TOKEN` only when the resolved deployment contains an inference
upstream; Harbor supplies that credential and the locked upstream directly to
the selected reviewed agent through `AgentConfig.env`.

The Bucket is durable truth. The local SQLite file may be removed and rebuilt
from immutable records. The Space must stay available while paid Jobs or owned
Endpoints may require reconciliation and cleanup.

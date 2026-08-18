---
title: Harbor-HF Control
sdk: docker
app_port: 7860
hf_oauth: true
hf_oauth_expiration_minutes: 720
suggested_hardware: cpu-upgrade
---

# Harbor-HF control

This private Docker Space runs the Harbor-HF control API and web application.
The release is generated from an exact reviewed Harbor-HF source revision.

The Space reads and creates immutable objects in the canonical private Bucket
through the Hugging Face API. Operators configure two persistent secrets:
`HF_TOKEN` for control operations and `HF_INFERENCE_TOKEN` for reviewed
benchmark workers. Deployment-specific resource identifiers and OAuth bootstrap
subjects remain private Space variables.

Sandbox-enabled workers use signed capabilities bound to one immutable campaign
lock, task set and operation set. The control process retains lifecycle authority,
derives a per-Sandbox token, and never forwards `HF_TOKEN` or `SBX_DL_TOKEN`.
Worker and browser responses expose only opaque action IDs, not remote Job IDs or
proxy URLs.

---
title: Harbor-HF Control
sdk: docker
app_port: 7860
hf_oauth: true
hf_oauth_expiration_minutes: 720
hf_oauth_scopes:
  - profile
suggested_hardware: cpu-upgrade
---

# Harbor-HF control

This private Docker Space runs the Harbor-HF control API and web application.
The release is generated from an exact reviewed Harbor-HF source revision.

The Space reads and creates immutable objects in the canonical private Bucket
through the Hugging Face API. Operators configure one persistent secret named
`HF_TOKEN`. Deployment-specific resource identifiers and OAuth bootstrap
subjects remain private Space variables.

---
title: Harbor-HF Control
nsfw: false
sdk: docker
app_port: 7860
hf_oauth: true
hf_oauth_expiration_minutes: 720
suggested_hardware: cpu-upgrade
---

# Harbor-HF control

This private Docker Space runs the Harbor-HF API, reconciler, and web console.
The release comes from one exact Harbor-HF source revision.

The Space uses one private Bucket for immutable run records, mutable desired
state, and Harbor job folders. SQLite is a disposable local projection.

Operators configure two persistent secrets. `HF_TOKEN` controls the Bucket and
HF Jobs. `HF_INFERENCE_TOKEN` is used for benchmark inference. A reviewed parent
Job receives both as ephemeral Job secrets so it can run Harbor and create
labeled child Sandbox Jobs. Credential values do not enter run records, labels,
or results.

Write mode also requires `HARBOR_HF_PARENT_IMAGE` with an immutable image
digest. See `docs/CONTROL_SERVICE.md` in the source repository for the complete
configuration and deployment checks.

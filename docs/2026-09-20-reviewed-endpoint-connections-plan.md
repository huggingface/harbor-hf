---
date: 2026-09-20
author: Onur Solmaz
title: Reviewed endpoint connections for native agent presets
tags: [architecture, harbor, inference]
---

# Reviewed endpoint connections for native agent presets

A run may use the Hugging Face router, or a reviewed Workbench recipe, but not a
native preset pointed at another HTTPS endpoint. This plan removes that
limitation without weakening the credential review.

## Problem

Native presets can only reach the router. `buildPresetJobConfig` writes
`OPENAI_BASE_URL` from the `ROUTER_URL` constant, and `InferenceBindings.selected`
denies any other value while the run carries the Hugging Face inference token.
A reviewed custom base URL is accepted only from a Workbench recipe, because
`reviewed()` matches grants on `agent_import_path` plus `recipe_digest` and
requires `kwargs.config.route_api` and a `model_base_url` run binding.

A user who serves a model on their own HTTPS endpoint, for example a Hugging Face
Inference Endpoint, therefore cannot evaluate it with a preset such as `pi`, even
though Harbor already supports a custom base URL for that agent. The only
alternatives are a separate unpublished runner or leaving the reviewed control
path entirely.

## Harbor-first evidence

Checked at the pinned revision in `packages/harbor-hf-agents/pyproject.toml`,
`harbor-framework/harbor@dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` (the
repository URL redirects from `osolmaz/harbor`):

- `src/harbor/agents/model_connection.py`: `ResolvedModelConnection` carries
  `api_key`, `base_url`, `configured_base_url` and `env`; `resolve_model_connection`
  reads the base URL from the spec's declared environment names and returns
  `configured_base_url`.
- `src/harbor/agents/installed/pi.py`: `_build_custom_models_json` uses
  `access.configured_base_url`, requires the `model_api` agent argument for a
  custom endpoint, and requires an API-key environment reference. Pi then writes
  its own `models.json` with that base URL and key reference.
- `packages/harbor-hf-agents/src/harbor_hf_agents/pi/agent.py`: the harbor-hf
  override pins the router only for `huggingface/` model names; the base class
  path already supports a resolved custom endpoint.

Harbor owns the model connection. It already reads the base URL and the key from
the declared environment. This change must not add a second connection record, a
mirrored field, a fallback reader, or a local alias for a Harbor concept. No
upstream Harbor change is required, so the "missing Harbor behavior" rule does
not apply and no upstream issue or pull request is opened.

## Ownership

Harbor-HF owns one decision that Harbor does not represent: the credential
review. Which key may be delivered to which host, for which model, by which
implementation and worker image, is a Harbor-HF policy decision and already
lives in the canonical Bucket registry as an inference binding.

The change therefore touches only the review object and the value source:

1. Generalize the grant subject. A grant names a reviewed implementation as
   either a Workbench recipe (`import_path` plus recipe digest, unchanged) or a
   native preset identity (agent slug plus version, resolved through the preset
   catalog). Every other grant field keeps its current meaning and validation:
   `operator_subjects`, `worker_image@sha256`, `destination_env`, `route_api`,
   `base_url`, `allowed_hosts`, `allowed_models`.
2. Source the connection from the approved grant for preset runs. The service
   writes `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the matched grant instead of
   from the `ROUTER_URL` constant. A preset does not carry the model route, so a
   preset edit cannot redirect a credential.
3. Keep the equality rule. The compiled agent environment must equal
   `{OPENAI_API_KEY: "${ref}", OPENAI_BASE_URL: grant.base_url}` and
   `extra_allowed_hosts` must equal `grant.allowed_hosts`, exactly as the
   existing reviewed-credential path already requires.
4. Admission and restart use the same check. A preset run whose model is not in
   `allowed_models`, whose actor, worker image or agent identity has no granted
   subject, whose host and base URL do not match the grant, or whose declared
   wire API style for the granted `route_api` no longer matches the built record
   is denied. The preset file stays the sole owner of the adapter option that
   selects a wire API style, so admission resolves the preset from the reviewed
   import path and version and compares the declaration with the record instead
   of trusting the record's value.
5. Registry registration accepts a preset subject. Operators select it from the
   preset catalog instead of quoting a recipe digest. The registry remains the
   only write authority, with `expected_revision`, and the existing
   invalidation rules apply unchanged.
6. Keep `inference-bindings-v1` in place. The contract changes in place; no
   `v2`, no alias, no dual reader.

## Boundaries

- The Hugging Face account token stays forbidden as a binding source. `source_env`
  continues to reject `HF_TOKEN` and `HF_INFERENCE_TOKEN`, so an endpoint needs
  its own purpose-scoped token registered under its own name.
- The existing denial for the inference-token template with a non-router URL
  stays, because that rule protects the account token rather than the endpoint
  route.
- No credential provisioning, movement, or registration happens in this change.
- No deployment to the control Space is part of this change. A deploy is a
  separate, explicitly approved step.
- No raw base URL field is added to presets, and no base URL is accepted from a
  run submission. Either would bypass the review object.
- Pricing and context metadata for a custom endpoint continue to come from Hub
  model metadata for the model id named by the submission.

## Verification

- Unit tests for admission with each subject kind: a preset subject passes when
  actor, image, model, host and base URL match; a recipe subject behaves as
  today.
- Unit tests for denial: unknown model, mismatched host, mismatched base URL,
  a changed wire API style for the granted route, an unresolvable preset, a route
  the preset does not declare, missing grant, and an HF-token environment with a
  non-router URL.
- Existing control, Workbench and inference tests stay green.
- Generated contracts, OpenAPI and browser clients regenerate byte-stable.
- Repository checks, run from the worktree: `npm run format:check`,
  `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`,
  `npm run check:generated`, and `npm run test:e2e`.
- Documentation updated: `docs/provider-credential-references.md` and
  `docs/CONTROL_SERVICE.md`.

## Limits

Offline validation does not prove that an endpoint is reachable, that a token
works, or that a model answers. Preparing a grant is not authorization to
launch, infer, deploy, publish, or move credentials.

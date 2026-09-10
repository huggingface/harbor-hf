---
schema_version: v1
slug: evalstate/terminal-bench-2-1
repository: https://github.com/evalstate/terminal-bench-2-1
default_branch: main
---

# Diagnostic benchmark source fork

## Current authorization

Status: approved
Approved at: 2026-09-09T00:00:00Z

### Scope

- Direct user YES to creating or reusing this exact PUBLIC fork of
  harbor-framework/terminal-bench-2-1. Publish only `qemu-fixed` from
  d49e28f1e4ddd13d289e85a5f312a66750951932 with reviewed repair
  46d924fcdf822f0dfdf6848ca660f5eaede89ae1 and two immutable image pins.
- Only qemu-startup and qemu-alpine-ssh Dockerfiles, task image references and
  environment/provenance README notes may change. Preserve task instructions,
  guest artifacts, kernel assertions, reference solutions, scoring and 87 peers.
- Reference the exact public commit in diagnostic Harbor-HF presets.

### Limits

- No default-branch mutation, force push, unrelated changes, upstream issue/PR,
  deployment, run, rebuild, image upload or credential transfer.
- Exact public identifier exception permits this fork and the existing
  ghcr.io/evalstate/harbor-hf-trial-worker references in source and public
  Harbor-HF presets/provenance/authorization. No other operator identifiers.
- One public Git fork is the approved inventory exception: canonical write is
  unavailable and native Harbor requires published task definitions. Existing
  control Space, Bucket and GHCR package remain unchanged. No other resource
  or paid compute. Retain pins until upstream repair AND historical retention;
  deletion requires explicit approval.

## Approval history

### 2026-09-09

- Direct approval received for this exact public fork and topic branch, plus
  public Harbor-HF diagnostic preset references. Record committed before work.
  Date denotes this session; exact approval time was not supplied.
- Read-only inspection found an existing public fork with the expected parent;
  `qemu-fixed` was absent. Reuse it, without changing the default branch.

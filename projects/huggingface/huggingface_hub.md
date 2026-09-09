---
schema_version: v1
slug: huggingface/huggingface_hub
repository: https://github.com/huggingface/huggingface_hub
default_branch: main
---

# Hugging Face Hub SDK

## Current authorization

Status: approved

Approved at: 2026-09-09T17:44:31.882149+00:00

### Scope

- The user explicitly approved updating the existing SDK checkout against latest main without discarding local work, opening one extremely concise upstream issue first, and implementing and publishing one matching pull request for Sandbox terminal-result handling.
- Stop stream consumption after a complete validated terminal exit event, close the response, preserve exit/timeout checks, and add offline regression tests. Missing or malformed terminal events remain failures; never replay command submissions.
- Build a reviewed wheel locally and provide immutable source/artifact provenance for the separately authorized Harbor-HF integration.

### Limits

- No merge, deployment, remote Sandbox/benchmark/inference execution, credential movement, package-index release, or unrelated SDK changes. Keep operator identifiers and private incident evidence out of public content. Use the canonical upstream repository for issue/PR publication; a personal fork destination requires exact approval before publishing its identifier.

## Approval history

### 2026-09-09

- Direct approval: concise SDK issue followed by matching PR, with priority on a Harbor-HF PR consuming the fix. Preserve existing checkout work.

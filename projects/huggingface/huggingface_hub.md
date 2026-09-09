---
schema_version: v1
slug: huggingface/huggingface_hub
repository: https://github.com/huggingface/huggingface_hub
default_branch: main
---

# Hugging Face Hub SDK

## Current authorization

Status: completed

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


### Completion (2026-09-09)

- Upstream issue #4850 and PR #4851 are available at the canonical repository:
  https://github.com/huggingface/huggingface_hub/issues/4850 and
  https://github.com/huggingface/huggingface_hub/pull/4851.
- Reviewed immutable fix commit: `f1c01f06919a5e57e57b6d78bc3d7e4de81534e0`.
  The production diff stops after the existing exit-result construction;
  offline regression tests accompany it. No Harbor patch is involved.
- The local 1.31.0.dev0 wheel has SHA-256
  `64ca28d8a0f9dd1e3b479df1771f152fba63a864111008eb56ca90769d67625a`.
  Harbor-HF deliberately does not consume it: the authorized integration uses a
  reproducible 1.28.0 release-wheel backport of only the reviewed two-line fix,
  version `1.28.0+terminal.f1c01f0`, SHA-256
  `922641bbf132546da041086e73d6cdfca7f13f4e63609580575699396a5a8df1`.
- No merge, deployment, package/image publication, credential movement or remote
  workload was performed during the integration. Harbor-HF publication remains
  a separate authorized parent-owned action.

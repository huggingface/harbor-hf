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

### Digest-pinned image Job-name repair

Status: completed

Approved at: 2026-09-10T11:54:20.135423+00:00

- Direct user approval: make a minimal patch and pull request and deploy this low-risk change. Remove the image digest from the readable automatically generated Job name while preserving the actual immutable image reference and invocation hash.
- Approved: SDK implementation and offline tests, upstream topic-branch publication and matching PR; Harbor-HF temporary SDK backport, tests, topic-branch publication and PR; publish the reviewed existing worker image through the existing workflow and deploy the reviewed revision to the existing user-selected control Space.
- Preserve explicit names, ownership labels, task inputs, image digests, concurrency, costs, hardware, visibility, Bucket, persistent secrets, run records and unrelated work. Only the deployment source/image references may change as required for this fix.
- No repository default-branch merge, new resource, benchmark/setup/inference Job, retry, credential movement or historical-result mutation is authorized. Deploy the reviewed topic revision if not merged; do not infer upstream merge permission from deployment approval.

Completed on 2026-09-10:

- SDK PR: https://github.com/huggingface/huggingface_hub/pull/4859,
  immutable fix `3493b0d86bee92db7c10511c534cec455aa84df6`; 24 offline
  Jobs tests and SDK quality checks pass. Existing terminal-result PR unchanged.
- Harbor-HF draft PR: https://github.com/huggingface/harbor-hf/pull/205.
  CI passed at `4b83cebf95ac52617479a79f67b8d11f8479b2ad`; that exact
  unmerged topic source was deployed through the existing deployment script.
- The existing worker workflow published digest
  `sha256:8bc1364f1d91575d4895af0ead8153689a3d6713556dc3588791fd18fc466388`.
  The pulled image passed all 46 offline SDK regressions and exact wheel audits.
- The existing control service is RUNNING with JSON live/ready HTTP 200;
  release and runtime revisions match. Build logs confirm the locked SDK version
  and wheel hash. Parent/workbench image references match the published digest;
  other variables, hardware, visibility and persistent-secret metadata remain
  unchanged. No Jobs were launched and no active Jobs were observed.
- Root: 100 tests, 89.10% coverage. Agents: 161 tests; npm: 1,064 tests;
  browser: 64 tests. Both amd64 images pass offline installed-SDK tests.
  Existing supplementary agent coverage debt (67.12%) and absent baseline/
  mutation tooling remain disclosed; no gates were weakened.
- Neither PR was merged. This local completion record is not part of the
  deployed source; the PR/deployment source remains the exact commit above.

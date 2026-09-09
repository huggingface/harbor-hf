---
title: Remove the Sandbox idle-timeout stopgap
author: Harbor-HF maintainers
date: 2026-09-09
tags: [sandbox, timeout, maintenance]
---

# Remove the Sandbox idle-timeout stopgap

## Purpose

Harbor-HF temporarily forces native Harbor configuration to use:

```yaml
environment:
  type: hf-sandbox
  kwargs:
    job_timeout: none
```

The deployed Sandbox server can treat a live foreground command as idle and stop
it after 30 minutes. [sandbox-server PR 21] corrects the server activity check.
[Harbor-HF PR 191] adds this stopgap without adding a keepalive loop or a second
lifecycle implementation.

This stopgap disables the Sandbox idle limit. Harbor phase timeouts, cancellation,
cleanup, and the Hugging Face 24-hour Job limit still bound work.

[sandbox-server PR 21]: https://github.com/huggingface/sandbox-server/pull/21
[Harbor-HF PR 191]: https://github.com/huggingface/harbor-hf/pull/191

## Ownership

- Hugging Face Sandbox owns the server correction and deployment.
- Harbor owns `environment.kwargs.job_timeout` and its timeout semantics.
- Harbor-HF only sets and reviews the native Harbor value.

Do not add provider, model, agent, harness, or benchmark conditions. Do not add a
keepalive request loop.

## Removal gates

Complete all checks before removal:

- [ ] Merge sandbox-server PR 21, or an equivalent correction. Record the merged
      commit.
- [ ] Build and deploy a Sandbox server release that contains the correction.
      Record the release version and immutable commit or image digest.
- [ ] Confirm from runtime evidence that a new HF Sandbox starts that exact fixed
      server build. A merge or mutable download URL is not deployment evidence.
- [ ] Run one foreground command for more than 30 minutes with no keepalive API
      traffic. Confirm that it stays alive, returns complete output, exits normally,
      and has no idle-shutdown log.
- [ ] Run a true-idle canary with a finite timeout. Confirm that the server still
      removes an inactive Sandbox.
- [ ] Confirm that Harbor cancellation, phase timeouts, and Sandbox cleanup still
      work with the fixed server.

If a gate fails, keep `job_timeout: none` and record the exact server revision,
command, duration, and logs. Do not restore a finite timeout from merge status
alone.

## Removal changes

After all gates pass, restore the reviewed `30m` idle timeout in one hard cutover:

1. Change `job_timeout` from `none` to `30m` in all files under
   `presets/benchmarks/`.
2. Change the `job_timeout` constant from `none` to `30m` in
   `packages/contracts/schemas/benchmark-preset-v1.schema.json`.
3. Regenerate `packages/contracts/src/generated/benchmark-preset-v1.ts`.
4. In `packages/control-core/src/direct-config.ts`:
   - remove `SANDBOX_IDLE_TIMEOUT_STOPGAP` and `SANDBOX_IDLE_TIMEOUT_FIX`;
   - remove the temporary rejection of finite values;
   - restore positive duration validation such as `30m`;
   - restore `30m` as the default native value; and
   - remove the stopgap comments.
5. In `apps/control-web/src/launch-draft.ts`, restore `30m` as the new draft
   default and remove the stopgap comments.
6. In `apps/control-web/src/launch-page.tsx`, restore the `30m` fallback and
   remove the stopgap notice and upstream link.
7. Update the related contract, control-core, browser, and end-to-end tests:
   - `packages/contracts/test/contracts.test.ts`;
   - `packages/control-core/test/control.test.ts`;
   - `packages/control-core/test/direct-config.test.ts`;
   - `apps/control-web/test/App.test.tsx`;
   - `apps/control-web/test/launch.test.tsx`; and
   - `apps/control-web/e2e/control.spec.ts`.
8. Remove the temporary stopgap text and links from:
   - `docs/DESIGN_PRINCIPLES.md`;
   - `docs/CONFIGURABLE_LAUNCH.md`; and
   - `docs/2026-09-04-simplification-implementation-spec.md`.
9. Delete this TODO document in the same removal pull request. Put the completed
   gate evidence in that pull request description.

## Removal verification

Run these checks after the cutover:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run check:generated
npm run test:e2e
uv run python scripts/check_public_privacy.py .
git diff --check
```

Also run the foreground and true-idle canaries from the removal gates against the
fixed deployed server. CI must pass its AMD64 Docker and secret-backed privacy
checks before merge.

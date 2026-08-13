---
title: Add explicit private result publication
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-13
---

# Add explicit private result publication

Harbor HF currently requires every result Dataset and shared result index to be public. Private benchmark programs need the same verified publication flow without exposing normalized results or index rows. The manifest must state the intended visibility, and Harbor HF must fail before writing when an existing repository does not match it.

## Requirements

- Make the result Dataset and index Dataset visibility explicit in each manifest.
- Include both visibility values in the immutable campaign plan and digest.
- Create missing repositories with the exact requested visibility.
- Verify existing repositories have the exact requested visibility.
- Fail closed on a mismatch. Do not change repository visibility automatically.
- Support private result and private index Datasets through the same idempotent publication and recovery flow.
- Keep the current public publication flow available only when the manifest explicitly requests it.
- Do not add an implicit default or compatibility reader for old manifests.

## Scope

Change the publishing schema, generated schemas, planning and lock serialization, automatic publisher repository checks, examples, tests, and result-publication documentation.

The qrlow benchmark will use a private result Dataset and a separate private qrlow index. Existing public Harbor result programs can continue by setting both values to `public`.

## Non-goals

- Harbor HF will not change repository visibility.
- This change will not copy canonical private evidence into result Datasets.
- This change will not rerun completed benchmark agents.
- This change will not merge private qrlow publications into a public index.

## Implementation

1. Add required `dataset_visibility` and `index_dataset_visibility` fields to `PublishingSpec`, each limited to `private` or `public`.
2. Require `index_dataset_visibility` exactly when `index_dataset` is present.
3. Pass the requested visibility to repository creation and verify the observed setting before publication.
4. Keep repository initialization and parent-checked publication unchanged for both visibility modes.
5. Update all checked-in manifests and examples to select visibility explicitly.
6. Regenerate JSON Schemas and update the publication contract.
7. Add tests for private creation, public creation, matching existing repositories, result mismatch, index mismatch, missing index visibility, redirects, retries, and immutable digest changes.

## Acceptance criteria

- A private/private manifest publishes to two existing or new private Datasets.
- A public/public manifest preserves the current public result flow.
- Mixed visibility works only when both values are explicit.
- A private/public mismatch fails before any result commit and does not change repository settings.
- Omitting either required visibility field fails manifest validation.
- A repository redirect is accepted only when its resolved repository has the requested visibility.
- Publication retries remain idempotent.
- Focused tests, the full test suite, type checks, formatting, lint, schema checks, and SimpleDoc checks pass.
- Pi Reviewer reports no P0 or P1 findings against `main`.

## Verification

```bash
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest tests/test_models.py tests/test_campaigns.py tests/test_operations.py tests/test_cli.py
uv run pytest
npx -y @simpledoc/simpledoc check
pi-reviewer --base main
```

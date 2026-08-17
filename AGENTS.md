# Repository Instructions

## Public repository privacy

- This repository is public. Treat all operator-specific information as private
  before writing or publishing anything here.
- Never publish personal names, usernames, account namespaces, email addresses,
  home-directory paths, machine names, private repository names, private Space
  or Bucket names, endpoint IDs, token display names, credential aliases, or
  private infrastructure topology.
- This applies to tracked files, documentation, examples, tests, fixtures,
  generated artifacts, logs, commit messages, branch names, issues, pull
  requests, review comments, and release notes. Platform-assigned authorship
  required to submit a contribution is the only exception; do not repeat that
  identity in repository content.
- Use placeholders such as `<namespace>`, `<control-space>`,
  `<artifact-bucket>`, and `<service-token>`.
- Public availability elsewhere does not grant permission to repeat an
  identifier here. Do not infer permission from local configuration,
  conversation history, existing files, or general approval to commit or open a
  pull request.
- Publishing any operator-specific identifier requires explicit approval for
  that exact value and exact public destination.
- Before every public commit, push, issue, pull request, review comment, or
  release, run `uv run python scripts/check_public_privacy.py .` and inspect the
  complete diff and public metadata for operator-specific information. Stop and
  redact it before publishing.
- If operator-specific information is published accidentally, stop immediately,
  report exactly what was exposed and where, remove it from the current version,
  and ask before rewriting public history or rotating credentials.

## Development

- Use Python 3.12+, uv, Pydantic, Typer, Ruff, ty, and pytest for the existing
  CLI and remote workers.
- Implement the new control service and web application in TypeScript as
  specified in `docs/CONTROL_SERVICE.md`. Use the current Node.js LTS release,
  npm workspaces, one root npm lockfile, Fastify, React, Vite, Tailwind CSS,
  shadcn/ui, strict TypeScript, Biome, Vitest and Playwright.
- Keep versioned JSON Schema authoritative for durable Bucket records. Generate
  TypeScript types and the browser API client. Do not maintain handwritten
  copies of portable contracts.
- Run `uv run ruff check .`, `uv run ruff format --check .`,
  `uv run ty check`, and `uv run pytest --cov=src/harbor_hf --cov-fail-under=85`
  before finishing Python code changes.
- Run the root npm formatting, lint, type, test, build, dependency and browser
  checks before finishing TypeScript or web changes.
- Run `uv run slophammer-py check .` after changing project structure or CI.
- Run `uv run slophammer-py dry .` and
  `uv run python scripts/check_mutation.py --min-kill-rate 90` before finishing
  behavior changes.
- Keep domain planning separate from Hugging Face, Harbor, filesystem, clock,
  and process-state adapters.
- Use only public Harbor APIs. Do not monkeypatch Harbor internals.
- Do not load models or run inference locally. Remote integration tests must be
  explicit and leave every Inference Endpoint paused.
- Never write secret values to manifests, logs, tests, locks, or artifacts.
- Treat Hugging Face repositories and Buckets as shared namespace
  infrastructure. Spaces and schedules are shared too. Endpoints follow the
  same rule. Reuse the canonical configured resources.
- Never create a repository, Bucket, Space, or schedule for one campaign,
  repair, profile, lease, status record, result subset, or temporary workflow.
- The complete steady-state Harbor-HF runtime inventory is one private control
  Space and one private `<artifact-bucket>` Bucket. Store control objects,
  profiles, evidence, receipts, reassessments, normalized results, and the
  result catalog under stable prefixes in that Bucket.
- Do not add another Harbor-HF repository, Bucket, Space, Dataset, result
  service, backup store, lease store, or status store. Any exception requires an
  inventory, a reason the two canonical resources cannot meet the requirement,
  lifecycle and cost records, and explicit approval.
- The control Space has exactly one operator-managed persistent secret named
  `HF_TOKEN`. Its value is an approved fine-grained service token. Do not
  publish the token's display name or local alias. Do not create a second
  Harbor-HF credential for a migration, campaign, repair, worker, backup, or
  result reader.
- Treat any other Harbor-HF service credential as a deprecation candidate. Do
  not revoke it until a private consumer audit and a canary using only the
  retained credential prove that control writes, evidence upload, endpoint
  cleanup, and publication still work.
- Follow `docs/CONTROL_SERVICE.md` and
  `docs/2026-08-16-harbor-hf-control-service-plan.md` when changing campaign
  control, the web application, profiles, storage, recovery, or publication
  architecture.
- The TypeScript control service is the only planned shared control authority.
  Python workers may write their assigned attempt and evidence records, but do
  not add a Python control-service fallback, dual-write path, or second
  reconciler.
- Never pass a locally configured personal or broad account credential, including
  the output of `gh auth token`, to a Hugging Face Job, Sandbox, Endpoint, or
  other remote runtime. Never copy any credential between stores without the
  user's explicit approval for that exact source and destination. Use a
  purpose-scoped credential approved for the remote workload instead.
- Add tests for every behavior change and preserve at least 85% coverage.
- Avoid `Any`; validate untrusted provider data at the adapter boundary.
- Use Conventional Commits.
- Apply the Slophammer standards configured for this repository.
- Before starting implementation or an external mutation, read and follow
  `.agents/skills/project-authorization/SKILL.md`. Verify that the requested
  scope is approved in the repository-indexed project file before continuing.
- Before planning, launching, monitoring, reconciling, recovering, verifying,
  or publishing a Harbor HF campaign, read and follow
  `skills/harbor-hf/SKILL.md`.

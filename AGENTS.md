# Repository instructions

## Public repository privacy

- This repository is public. Treat all operator-specific information as private.
- Do not publish personal names, usernames, account namespaces, email addresses,
  home paths, machine names, private repository names, private Space or Bucket
  names, Job IDs, token display names, credential aliases, or private topology.
- This rule covers source, documentation, examples, tests, fixtures, generated
  files, logs, commits, branches, issues, pull requests, comments, and releases.
  Platform-assigned authorship is the only automatic exception.
- Use placeholders such as `<namespace>`, `<control-space>`, `<artifact-bucket>`,
  and `<service-token>`.
- Public availability elsewhere does not grant permission to repeat a private or
  operator-specific identifier in this repository.
- Publishing an exact external identifier or destination requires explicit
  approval for that exact value and exact public destination.
- If private data is published, remove it from the current public surface,
  disclose what was exposed and where, and recommend rotation when a credential
  could be affected. Ask before rewriting public history.
- Before each public commit, push, issue, pull request, comment, or release, run
  `uv run python scripts/check_public_privacy.py .`. Inspect the complete diff
  and public metadata. Remove private values before publication.

## Harbor boundary

- Harbor owns `JobConfig`, benchmark task resolution, trial execution,
  concurrency, retries, resume, locks, results, rewards, costs, trajectories,
  and built-in agents.
- Harbor-HF owns authenticated submission, reviewed presets, the control Space
  and Bucket, parent and child HF Job lifecycle, post-trial cost stops, the
  SQLite projection, the web console, and the leaderboard.
- Before adding behavior, check the pinned Harbor source. Name the checked file
  in the pull request description.
- Use Harbor's public APIs. Do not add a second task loop, retry loop, resume
  rule, lock writer, result writer, or benchmark parser.
- Keep benchmark and model names as data. Keep harness-specific behavior in a
  Harbor agent plugin behind `import_path`.
- If Harbor lacks required general behavior, document the gap and get approval
  before adding a temporary compatibility implementation.

## Storage and resources

- The steady-state inventory is one private control Space and one private
  Bucket. Do not add a repository, Space, Bucket, Dataset, endpoint, schedule,
  backup store, lease store, status store, or result service for a run.
- Store current data under `runs/<run-id>/`. The service writes `run.json` and
  `state.json`. Harbor alone writes below `job/`.
- SQLite is a disposable three-table projection. It must rebuild from Bucket
  data and HF Job observations.
- Use a hard cutover. Do not add compatibility readers, dual writes, old profile
  support, or a second API version.

## Credentials

- The control Space has two operator-managed secrets. `HF_TOKEN` is the
  purpose-scoped control credential. `HF_INFERENCE_TOKEN` is the separate
  inference credential. Their values must differ.
- The reviewed parent Job receives both as ephemeral Job secrets. It uses the
  control credential to start and label child HF Sandbox Jobs. The benchmark
  agent receives only the inference credential through the fixed environment
  template.
- Never put credential values in variables, source, requests, run records,
  Bucket objects, image arguments, labels, logs, tests, or results.
- Never copy a locally configured personal or broad account credential to a
  remote runtime. Never copy any credential between stores without approval for
  that exact source and destination.

## Development

- Use Python 3.12+, uv, Typer, Ruff, ty, and pytest for the thin CLI.
- Use the pinned Harbor package for the parent worker and agent adapters.
- Use Node.js from `.nvmrc`, npm workspaces, strict TypeScript, Fastify, React,
  Vite, Biome, Vitest, and Playwright for the control service and console.
- Keep versioned JSON Schema authoritative for durable records and presets.
  Generate TypeScript types and the browser OpenAPI file.
- Avoid `Any`. Validate untrusted provider data at adapter boundaries. An
  override of an upstream variadic Python API can use a narrow lint exception.
- Add tests for behavior changes and keep coverage at or above 85%.
- Apply the configured Slophammer standards.
- Use Conventional Commits.

Before finishing Python changes, run:

```bash
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov=src/harbor_hf --cov-fail-under=85
uv run pip-audit
```

Before finishing TypeScript or web changes, run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run check:generated
npm audit --audit-level=low
npm run test:e2e
```

After project structure or CI changes, run:

```bash
uv run slophammer-py check . --baseline
uv run slophammer-py dry .
```

Build both Dockerfiles for `linux/amd64`. Run Ruff, ty, and pytest in
`packages/harbor-hf-agents`.

## Operations

- Read `.agents/skills/project-authorization/SKILL.md` before an external
  mutation. Verify that the repository-indexed project authorization covers the
  exact scope.
- Read `.agents/skills/harbor-hf/SKILL.md` before submitting, launching,
  monitoring, pausing, resuming, cancelling, or publishing a run.
- Use `docs/2026-09-04-simplification-implementation-spec.md`,
  `docs/architecture.md`, and `docs/CONTROL_SERVICE.md` as the current contract.
- Use the paid-compute review before a paid Job launch, retry, or resume.
- Do not run model inference locally. Remote integration tests must be explicit.
- Stop for credential exposure, revision mismatch, duplicate execution, cost
  outside approval, an immutable conflict, a deterministic shared defect, or a
  labeled Job that cannot be stopped.

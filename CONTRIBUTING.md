# Contributing

## Public repository privacy

This repository is public. Do not include operator-specific information in
tracked files, examples, tests, fixtures, generated artifacts, commit messages,
branch names, issues, pull requests, comments, logs, or releases. This includes
personal names, usernames, account namespaces, email addresses, home-directory
paths, machine names, private repository names, private Space or Bucket names,
endpoint IDs, token display names, credential aliases, and private
infrastructure topology.

Use placeholders such as `<namespace>`, `<control-space>`,
`<artifact-bucket>`, and `<service-token>`. Public availability elsewhere does
not grant permission to repeat an identifier here. Publishing an
operator-specific identifier requires explicit approval for that exact value
and exact public destination.

Before publishing, inspect the complete diff and public metadata. Stop and
redact operator-specific information first. If anything is published
accidentally, report what was exposed and where, remove it from the current
version, and ask before rewriting public history or rotating credentials.
Platform-assigned authorship required to submit a contribution is the only
exception; do not repeat that identity in repository content.

Maintainers may configure the `PUBLIC_PRIVACY_DENYLIST` Actions secret with
newline-separated private identifiers. The privacy checker reports only the
finding category and location, never the matched value.

## Development

Benchmark workers and migration helpers use Python. The control API, shared
control authority, and web application use the TypeScript stack in
[`docs/CONTROL_SERVICE.md`](docs/CONTROL_SERVICE.md). Keep both sets of checks
green. The TypeScript workspace uses Node.js 22.22.0, npm workspaces, one root
npm lockfile and strict TypeScript. Biome handles formatting and linting.
Vitest runs unit tests. Playwright runs browser tests.

Install the locked development environment:

```bash
uv sync --all-groups
npm ci
```

Before submitting a change, run:

```bash
uv run python scripts/check_public_privacy.py .
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov=src/harbor_hf --cov-fail-under=85
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run check:generated
npm audit --audit-level=low
npx playwright install chromium
npm run test:e2e
docker build --platform linux/amd64 -f deploy/control-space/Dockerfile .
uv run slophammer-py dry .
uv run pip-audit
uv run slophammer-py check .
```

Run TypeScript formatting and linting from the repository root. Run type and
unit checks there too. Run the browser tests and build before checking
dependencies. Generated
JSON Schema types, OpenAPI output, and the browser client must be current.

Mutation testing is not part of this project. Do not add mutmut dependencies,
mutation workflows, mutation release gates, or mutation configuration. Use
focused deterministic pytest, Vitest, and Playwright regression coverage for
behavior changes.

Tests must mock Hugging Face and Harbor network boundaries unless they are
explicitly marked remote integration tests. Never place tokens, endpoint URLs,
or captured secrets in fixtures.

Use Conventional Commits for commit messages and pull request titles.

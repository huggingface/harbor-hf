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

Install the locked development environment:

```bash
uv sync --all-groups
```

Before submitting a change, run:

```bash
uv run python scripts/check_public_privacy.py .
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov=src/harbor_hf --cov-fail-under=85
(cd apps/results-web && npm ci && npm run build)
docker build -f deploy/space/Dockerfile .
uv run slophammer-py dry .
uv run pip-audit
uv run slophammer-py check . --baseline
```

The slower mutation suite is available as an explicit local command and a
manually dispatched GitHub Actions workflow. It is not part of the pull-request
critical path. The checked-in Slophammer baseline records that deliberate
exception and still rejects every new finding:

```bash
uv run python scripts/check_mutation.py --min-kill-rate 90
```

Tests must mock Hugging Face and Harbor network boundaries unless they are
explicitly marked remote integration tests. Never place tokens, endpoint URLs,
or captured secrets in fixtures.

Use Conventional Commits for commit messages and pull request titles.

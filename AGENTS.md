# Repository Instructions

- Use Python 3.12+, uv, Pydantic, Typer, Ruff, ty, and pytest.
- Run `uv run ruff check .`, `uv run ruff format --check .`,
  `uv run ty check`, and `uv run pytest --cov=src/harbor_hf --cov-fail-under=85`
  before finishing code changes.
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
- Before adding a persistent Hub resource, inventory the namespace and prove
  that the existing private evidence Bucket, normalized results Dataset,
  control Space, results Space, source repository, or backup Bucket cannot meet
  the privacy, access, retention, or failure-domain requirement. Record the
  owner and lifecycle. Record the cost and removal condition, then obtain
  explicit approval.
- Keep control objects and profiles under clear prefixes in the existing
  private evidence Bucket. Keep evidence and receipts there as well, including
  reassessments. Do not create a new Bucket to avoid designing a clear schema
  or prefix.
- Keep the backup Bucket separate from the primary evidence Bucket. Reusing
  resources does not permit weakening the backup failure boundary.
- Follow `docs/2026-08-16-harbor-hf-control-service-plan.md` when changing
  campaign control, profiles, storage, recovery, or publication architecture.
- Never pass a locally configured personal or broad account credential, including
  the output of `gh auth token`, to a Hugging Face Job, Sandbox, Endpoint, or
  other remote runtime. Never copy any credential between stores without the
  user's explicit approval for that exact source and destination. Use a
  purpose-scoped credential approved for the remote workload instead.
- Add tests for every behavior change and preserve at least 85% coverage.
- Avoid `Any`; validate untrusted provider data at the adapter boundary.
- Use Conventional Commits.
- Apply the standards in
  `https://github.com/osolmaz/slophammer/blob/main/docs/AGENT_ENTRYPOINT.md`.
- Before planning, launching, monitoring, reconciling, recovering, verifying,
  or publishing a Harbor HF campaign, read and follow
  `skills/harbor-hf/SKILL.md`.

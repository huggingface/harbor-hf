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
- The complete steady-state Harbor-HF runtime inventory is one private control
  Space and one private `benchmark-runs` Bucket. Store control objects,
  profiles, evidence, receipts, reassessments, normalized results, and the
  result catalog under stable prefixes in that Bucket.
- Do not add another Harbor-HF repository, Bucket, Space, Dataset, result
  service, backup store, lease store, or status store. Any exception requires an
  inventory, a reason the two canonical resources cannot meet the requirement,
  lifecycle and cost records, and explicit approval.
- The control Space has exactly one persistent secret named `HF_TOKEN`. Its
  value is the existing fine-grained token with display name `harbor-hf-jobs`.
  Do not create a second Harbor-HF credential for a migration, campaign, repair,
  worker, backup, or result reader.
- Treat any other Harbor-HF service credential as a deprecation candidate. Do
  not revoke it until a private consumer audit and a canary using only
  `harbor-hf-jobs` prove that control writes, evidence upload, endpoint cleanup,
  and publication still work.
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

# Temporary SDK backports

Issue: <https://github.com/huggingface/huggingface_hub/issues/4850>

Fix: <https://github.com/huggingface/huggingface_hub/pull/4851>, immutable commit
`f1c01f06919a5e57e57b6d78bc3d7e4de81534e0`.

The terminal-result patch is the exact two-line production diff from that commit. It
stops consuming a foreground response after the existing SDK parser constructs
its exit result. It does not accept EOF as success, relax parsing, retry POSTs,
change background execution, or mask nonzero exits/timeouts. Tests use an offline
HTTP transport and cover chunk fragmentation, transport tails, missing/malformed
results, callbacks, response closure and `check` behavior.

Job-name fix: <https://github.com/huggingface/huggingface_hub/pull/4859>,
immutable commit `3493b0d86bee92db7c10511c534cec455aa84df6`.
`job-name.patch` is that commit's exact production diff: strip the digest from
only the readable Docker basename, retaining the full image in the invocation
hash and HTTP payload. Tags, explicit names, labels and Space references retain
their existing behavior. No generic truncation or Harbor workaround is added.
The installed-SDK tests mock HTTP; they never create a Job or Sandbox.

## Why a release-wheel backport

The previously locked SDK is 1.28.0. Do not install the upstream 1.31.0.dev0 wheel:
that includes unrelated development changes. Instead, the standard-library build
script verifies the original PyPI wheel before applying the reviewed source
patches with `git apply`. It executes no downloaded build backend. It changes only
`_sandbox.py`, `_jobs_api.py`, the version in `__init__.py` and `METADATA`, the dist-info directory
name, and regenerated wheel `RECORD` hashes. Fixed ZIP metadata and uncompressed
entries make output byte-reproducible without a compression-library dependency.
Upstream license files and all other contents remain intact.

- Input: `huggingface_hub-1.28.0-py3-none-any.whl`, URL in `build.py`.
- Input SHA-256: `58a8bacb03072edfc38067065e9dc24bbb34805410fcd36a1632de0b329660bb`.
- Terminal patch SHA-256: `5f5434dfc4bbcf051b4644b7dee890644a2d69523e3527088b48018e66eca723`.
- Job-name patch SHA-256: `d89561aafaa90ed9ef449a8e6a0bf42fa71f952425f6ec47739b7ceb0e19c216`.
- Local version: `1.28.0+terminal.f1c01f0.jobname.3493b0d`, authoritative in `pyproject.toml`.
- Output SHA-256: `fdd23ace680c9c09aafab55e88e888c6b314cf21808cc4601ec548a86a0a0e1b`.
- Output and input wheels live in ignored `sdk-backport/dist/`; no binary is
  committed, uploaded, or served by a new resource. `uv.lock` records the output
  wheel hash and local path. Other locked dependency versions are unchanged;
  uv additionally records the local wheel's existing optional metadata.

From the repository root, before any agents-package sync, lock or test command:

```sh
python3 packages/harbor-hf-agents/sdk-backport/build.py
uv sync --project packages/harbor-hf-agents --all-groups --locked
uv run --project packages/harbor-hf-agents pytest packages/harbor-hf-agents/tests
```

For an offline rebuild, pass `--source <release-wheel>` to the build script; the
same input hash is required. `test_sdk_backport_build.py` audits the source diff,
RECORD, reproducibility and lock hash, and rejects altered input/invalid patches.
`test_sdk_terminal_result.py` exercises the actually installed SDK, not a copy.

Both existing Dockerfiles build before frozen installation: the parent uses
`/opt/harbor-hf-parent`, and the control image uses `/opt/harbor-launch` for native
launch/setup work. The shared agents lock selects the patched SDK in both. This
is the environment in which Harbor calls Sandbox, not the Fast-Agent task recipe.
Other SDK functions in those shared environments retain their 1.28.0 code; the
root CLI dependencies and task recipes are unchanged.

## Harbor boundary and removal

Reviewed `src/harbor/environments/hf_sandbox.py` at pinned Harbor
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`: native `exec` delegates to public
`Sandbox.run(check=False)` and maps the returned result. Upstream history through
`191d1b989` has no fix for SDK stream consumption or Job names. The same
file calls public `Sandbox.create(image=image)` without rewriting the image. No Harbor
pin update, internal import, runtime monkeypatch, mirrored field, retry loop or
result interpretation is introduced. This is an explicitly approved **SDK**
backport, not a Harbor-owned patch.

Remove this directory, the local dependency/source override, and build steps when
a compatible released SDK contains commit
`f1c01f06919a5e57e57b6d78bc3d7e4de81534e0` and
`3493b0d86bee92db7c10511c534cec455aa84df6` (or reviewed merged equivalents).
Update the agents lock to that release; retain the offline terminal regressions,
update their version assertion, and verify both image environments before any
separately authorized rollout. No released version containing the fix is claimed
here. Deployment and existing worker-image publication have separate recorded
approval for this repair; no Jobs or package-index release are authorized.

## Local validation (2026-09-09)

Both `linux/amd64` images built locally. All 40 terminal regression cases passed
with networking disabled in each final image's actual Python environment, using
read-only mounted test tools (no SDK replacement). Installed `_sandbox.py` and
`__init__.py` bytes matched the locked wheel; metadata and runtime versions agreed.
The unpatched 1.28.0 wheel failed 34 cases (including the intentional version
assertion) and passed the six pre-result failure cases. The new builder has
97.47% coverage; source/hash/RECORD tests and an offline rebuild passed.

Root Python tests pass with 87.98% coverage. The full agents suite passes, but
supplementary existing agent-runtime coverage is 61.72%, below 85%. Ruff, format,
ty, lock checks, installed dependency integrity, root dependency audit and normal
Slophammer check/DRY pass. No thresholds were changed. The requested Slophammer
baseline and mutation script are absent; those commands cannot pass. No TypeScript
source changed; separate npm/browser gates were not run. The control image's
existing typecheck and web build passed. Keep the integration PR draft while
validation blockers remain. No rollout or live Sandbox behavior is claimed.


## Job-name repair validation (2026-09-10)

The root suite passes 100 tests with 89.10% coverage; the agents suite passes
161 tests. Both final `linux/amd64` images pass all 46 installed-SDK regression
cases with networking disabled, including the existing 40 terminal cases.
Installed SDK version, metadata and changed modules match the locked wheel.
The original SDK fails both digest-name cases; all four payload cases pass.
Source/RECORD/lock audits and byte-reproducibility pass; builder coverage is
98.61%. Only the SDK entry changes in the dependency lock.

Root and agents Ruff, formatting and ty checks pass. All 1,064 npm tests and
64 isolated-port browser tests pass, as do format/lint/type/build/generated
checks and dependency audits. The initial browser attempt reused an unrelated
local server; the isolated-port run verifies this checkout instead.
Normal Slophammer check and DRY pass. The baseline file and mutation script
remain absent. Supplementary agents-plus-builder coverage is 67.12%, below
85%; this existing coverage debt is disclosed, not hidden by weaker gates.
Image publication and deployment require the existing remote CI to pass.

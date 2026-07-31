# Benchmark source implementation plan

Status: proposed

This plan implements the [benchmark source specification](benchmark-sources.md). It keeps anonymous public Git checkout, adds immutable local-directory bundles, and removes authenticated Git from new remote execution.

The implementation changes the current `harbor-hf/v1alpha1` contract in place. Historical campaigns remain readable through their pinned worker revisions. Current code does not keep a compatibility path that forwards source credentials.

## Target behavior

One campaign YAML accepts:

- a public Git source cloned anonymously by the remote Job
- a local directory resolved into a private immutable bundle
- an existing verified bundle
- an existing content-addressed Harbor package

Remote Jobs never receive Git credentials. A local directory follows the same campaign lifecycle as another immutable benchmark source, including run and trial identity, retries, evidence, and recovery.

## Architectural boundary

Add one source-resolution application boundary:

```text
requested ExperimentSpec
        |
        v
BenchmarkSourceResolver
        |
        +-- public Git ----------> GitSourceLock
        +-- local directory -----> bundle builder -> BundleSourceLock
        +-- existing bundle -----> bundle verifier -> BundleSourceLock
        +-- Harbor package ------> PackageSourceLock
        |
        v
source.lock.json -> campaign plan and lock -> remote source loader -> Harbor
```

Domain planning consumes a resolved source lock. Filesystem traversal, Git probing, Bucket upload, archive construction, and remote extraction remain adapters outside the planner.

## Phase 1: source models and schemas

Target files:

- `src/harbor_hf/models.py`
- a new source-lock module under `src/harbor_hf/`
- `schemas/benchmark-source-lock-v1alpha1.schema.json`
- `schemas/benchmark-bundle-v1alpha1.schema.json`
- schema generation and validation tests

Replace `GitHubTokenCredentials` and the `credentials` field on `GitBenchmarkSource` with a strict source union:

```text
GitBenchmarkSource
DirectoryBenchmarkSource
BundleBenchmarkSource
```

Add a separate frozen resolved union:

```text
GitSourceLock
BundleSourceLock
PackageSourceLock
BenchmarkSourceLock
```

The author-facing directory path exists only on `DirectoryBenchmarkSource`. It is absent from `BundleSourceLock`, `CampaignLock`, `RunLock`, and remote commands.

Keep the schema version at `harbor-hf/v1alpha1`. This pre-release contract replacement does not create a parallel version. Generate the two new resource schemas from Pydantic. Run Schemator on the draft and retain the source and final graphs, decisions, diff and context, plus the manual review.

Tests cover strict unions, unknown fields, unsafe paths, full Git revisions, credential-field rejection, canonical serialization, digest derivation, and generated-schema parity.

## Phase 2: deterministic bundle builder

Target modules:

- `src/harbor_hf/benchmark_bundle.py`
- filesystem adapter tests
- bundle fixtures containing nested tasks, executable files, empty directories, Unicode names, and boundary sizes

Implement pure models and separate filesystem operations for:

- deterministic entry ordering
- canonical content digest calculation
- normalized directory and file modes
- source inventory capture
- payload construction
- exact bundle manifest serialization
- full local bundle validation

Build into a new temporary directory outside the repository. Open source files without following links. Read the bytes once into the payload and hash those same bytes. Rescan the source after construction and fail if the entry set or any source identity changed.

Reject symlinks, hard-link preservation, devices, sockets, FIFOs, `.git` directories, invalid normalized paths, duplicate paths, and configured size limits. Store each hard-linked source path as independent regular-file bytes. The bundle does not preserve inode identity.

Reuse the repository's existing secret-detection primitives where their contract fits. Scan known configured credential values and high-confidence private-key patterns before publication. A source finding fails the bundle; the builder does not rewrite benchmark input.

Property and mutation tests cover ordering, canonical JSON, path normalization, mode normalization, source mutation, archive metadata, extra members, missing members, digest mismatches, extraction traversal, and decompression limits.

## Phase 3: private bundle storage

Target modules:

- `src/harbor_hf/benchmark_staging.py`
- existing Bucket adapter protocols
- fake-Bucket and integration tests

Use the managed private `<namespace>/jobs-artifacts` Bucket. Store bundles under the content digest defined by the specification.

Implement:

- privacy verification before any upload
- complete-bundle lookup
- exact reuse validation
- payload-first upload
- authoritative post-upload verification
- manifest-last publication
- immutable conflict detection
- safe repair of an exact partial upload
- typed upload and adoption receipts

Do not add a fallback reader, mutable alias, latest pointer, or overwrite path. The content digest is the only bundle identity.

No remote workload credential is needed to construct the bundle. The local uploader uses configured HF authentication in place for its normal API calls. Remote runtime credentials remain governed by their separate purpose and approval policy.

## Phase 4: resolution and campaign identity

Target modules:

- `src/harbor_hf/planner.py`
- `src/harbor_hf/campaigns.py`
- `src/harbor_hf/campaign_input.py`
- `src/harbor_hf/submission.py`
- planner and lock tests, plus input and submission tests

Add an explicit resolution step before semantic planning.

For a directory source, planning computes the content and manifest identities without remote upload. Submission rebuilds the bundle and requires exact equality with the approved source lock. It then uploads or adopts the bundle before it creates campaign state or launches a Job.

For a Git source, planning performs the anonymous preflight and writes the canonical repository and commit together with the safe path. It does not use ambient Git credentials.

Update the campaign input package to contain exactly:

```text
manifest.yaml
source.lock.json
campaign.lock.json
input-manifest.json
```

The input manifest covers the exact bytes of the other three files. Campaign lock reproduction uses the requested manifest plus the verified source lock. The semantic plan digest covers the source lock; the manifest digest still covers the exact request.

A repeated submission must adopt the same complete bundle and source lock. It must also adopt the same campaign and controller Job. Any difference fails before a remote write or billable launch.

## Phase 5: anonymous Git adapter

Target modules:

- the benchmark source adapter used by worker and controller execution
- process environment helpers
- anonymous Git tests

Run public Git checks and checkout in a sanitized process environment:

- unset `GITHUB_TOKEN`, `GH_TOKEN`, Git authorization variables, SSH variables, and askpass variables
- set `GIT_TERMINAL_PROMPT=0`
- disable global and system Git configuration
- disable credential helpers explicitly
- accept only canonical GitHub repository identity
- verify the final checkout commit
- reject submodules and authenticated Git LFS requirements

Do not inspect or call `gh auth token`. Do not retry with an authenticated URL. Do not inherit the caller's Git credential helper into the remote Job.

The Job command and stored launch contract must contain no Git secret names.

## Phase 6: remote bundle loader

Target modules:

- `src/harbor_hf/campaign_controller.py`
- `src/harbor_hf/wave_worker.py`
- `src/harbor_hf/harbor_adapter/adapter.py`
- source loader and Harbor request tests

Mount the selected bundle prefix read-only at a fixed path. Validate the source lock, bundle manifest, payload size, payload digest, content digest, and entry limits before extraction.

Extract into a new empty Job-local directory. Never extract onto the Bucket mount. Reject traversal, links, special files, duplicate members, unexpected members, and limit overruns while streaming. Validate every extracted file and mode against the manifest before invoking Harbor.

Render a public Harbor `DatasetConfig(path=...)` for bundle-backed tasks. Keep Harbor's native `repo` and `path` rendering for anonymous Git. Keep the existing digest-pinned package rendering for Harbor packages.

Run source preparation once in a provider controller. Endpoint wave Jobs load the same resolved source lock independently. Every physical retry reuses the original source lock and bundle; it never consults the operator directory again.

## Phase 7: credential removal and submission guard

Target modules:

- `src/harbor_hf/submission.py`
- source preparation and worker process helpers
- CLI dry-run rendering
- secret-isolation tests

Delete source-secret collection, source-secret requirements, temporary Git token files, and Git credential-helper installation. `campaign_job_secret_names()` and `job_secret_names()` must ignore benchmark sources because source models cannot request secrets.

Add a submission assertion that rejects Git credential secret names and authenticated Git configuration. Render an exact allowlist of independently approved runtime secret mappings. The submitter must not forward ambient environment variables.

Test that `GITHUB_TOKEN`, `GH_TOKEN`, SSH keys, and local Git configuration cannot enter:

- Job commands
- secret files
- manifests and locks
- controller or Harbor environments
- evidence and logs
- source preparation subprocesses

## Phase 8: CLI and operator workflow

Update:

- `docs/run-spec.md`
- `docs/architecture.md`
- `docs/harbor-cookbook.md`
- `docs/single-job-campaign-controller.md`
- `docs/harbor-integration-contract.md`
- `skills/harbor-hf/`
- examples and ShellBench launch generators

`validate` reports the requested source type and path errors. `campaign plan` reports the resolved source type, content digest, entry count, total bytes, and whether an existing remote bundle was inspected. It creates no remote resource.

`campaign submit --dry-run` reports:

- the approved source lock
- local bundle bytes and file count
- destination prefix
- upload, reuse, or conflict action
- exact Job volume mount
- exact runtime secret names
- proof that no Git credential is included

Normal submit prints the source lock digest and bundle receipt with campaign and Job identities.

## Phase 9: validation

Required local tests include:

- public anonymous Git success and private Git rejection
- no local credential-helper use during public preflight
- local directory to canonical bundle
- equivalent directories at different paths producing the same content digest
- one-byte, mode, or path changes producing a different digest
- source mutation during construction
- rejection of symlinks, devices, sockets, FIFOs, traversal, duplicate members,
  and decompression-limit violations
- known-secret rejection without rewriting input
- exact bundle reuse and conflicting destination failure
- interrupted upload and safe exact repair
- input package and source-lock tampering
- bundle extraction and Harbor local-path rendering
- retry and recovery reuse of the same source
- Job commands containing no Git credential secret
- provider and endpoint execution parity

Run the repository quality gates from `AGENTS.md`. A behavior implementation is not complete while the mutation gate is below its required threshold.

## Remote acceptance

Use a one-task canary from a local directory that is not available to the remote Job through Git. Before launch, verify the destination bundle and inspect the exact Job command.

The canary passes only when:

- exactly one approved Job is launched
- no Git credential secret appears in Job configuration
- the remote Job validates and extracts the locked bundle
- Harbor loads the extracted local path through its public API
- the task digest matches the campaign lock
- provider and judge behavior matches the approved manifest
- evidence and source inputs pass secret scanning
- controller status, trial evidence, and final publication are complete
- actual runtime and cost remain within the approved bounds

Run a second no-inference integration check with an anonymously readable public repository. It must clone the locked commit with the sanitized Git environment and no credential secret.

## Completion criteria

The implementation is complete when:

- the current manifest schema covers public Git and bundle sources, including
  the author-facing directory request
- authenticated Git fields and code paths are absent
- private and local benchmark files reach HF only through verified bundles
- public Git runs anonymously at a full commit
- every remote execution consumes a verified source lock
- retries and recovery preserve the original source identity
- docs, skills, examples, generated schemas, tests, mutation checks, and remote canaries agree with the specification

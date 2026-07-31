# Benchmark source specification

Status: proposed

This specification defines how one Harbor-HF campaign identifies and loads its benchmark files. An operator selects one source in the campaign YAML. Harbor-HF resolves that request into one immutable source lock before it creates remote work.

The current CLI does not yet implement directory bundles. Until the accompanying implementation is complete, new campaigns may use a content-addressed Harbor package or an anonymously readable public Git repository. Authenticated remote Git is prohibited even if an older checkout accepts its manifest shape.

## Campaign YAML

A campaign selects one of three sources.

### Public Git repository

```yaml
benchmark:
  dataset: shellbench/public-115
  source:
    type: git
    repository: ShellBench/public-tasks
    revision: "0000000000000000000000000000000000000000"
    path: tasks/115-tasks
```

The remote Job clones this source anonymously. Git sources never declare credentials.

### Local directory

```yaml
benchmark:
  dataset: shellbench/public-115
  source:
    type: directory
    path: ../../../../public-tasks/tasks/115-tasks
```

The submitter snapshots and uploads this directory before launching a Job. The remote Job never receives the operator's path.

### Existing bundle

```yaml
benchmark:
  dataset: shellbench/public-115
  source:
    type: bundle
    content_digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
    manifest_sha256: "0000000000000000000000000000000000000000000000000000000000000000"
```

This form reuses a complete bundle already stored in the managed private Job input Bucket.

A content-addressed Harbor package remains valid when `benchmark.source` is omitted. Its package digest is the resolved benchmark source.

## Source model

The author-facing source is a discriminated union.

| Type | Required fields | Resolution | Remote network access |
| --- | --- | --- | --- |
| `git` | `repository`, `revision`, `path` | Preserved as anonymous Git | Public Git host only |
| `directory` | `path` | Replaced by a bundle reference | None for benchmark loading |
| `bundle` | `content_digest`, `manifest_sha256` | Verified and preserved | Private Bucket mount only |
| Harbor package | Digest-pinned `benchmark.dataset` | Preserved as a package reference | Harbor's package transport |

Unknown source types and unknown fields are errors. A source object cannot combine fields from different variants.

## Directory path

`directory.path` is an operator-machine path. A relative path is resolved from the directory containing the campaign YAML. An absolute path is accepted but is less portable. Shell expansion, environment expansion, and `~` expansion do not occur.

The path must identify a real directory. The root and every descendant must be a real directory or regular file. Harbor-HF rejects:

- symbolic links
- sockets and named pipes, as well as devices
- path components named `.git`
- paths that are not valid UTF-8 in Unicode Normalization Form C (NFC)
- entries that appear, disappear, or change while the snapshot is built
- files or totals that exceed the locked bundle limits
- known credential values and high-confidence private-key material

The exact requested YAML remains part of private campaign audit history. The local path does not enter the resolved source lock, remote Job command, semantic plan digest, evidence, or publication.

## Public Git source

`git.repository` is a canonical GitHub `owner/name` reference. It must not contain a scheme, user information, password, query, fragment, revision suffix, or path inside the repository.

`git.revision` is one full lowercase 40-character commit ID. Branches, tags, abbreviated commits, and symbolic revisions are invalid.

`git.path` is a nonempty POSIX path relative to the repository root. Absolute paths, `.` as the complete value, backslashes, empty components, and `..` components are invalid.

Planning and execution must prove that the repository and commit are anonymously readable. The check runs with credential helpers, SSH agents, askpass programs, interactive prompting, global Git configuration, system Git configuration, and Git authentication environment variables disabled. The remote checkout must report the locked commit before Harbor reads any task.

A public Git source must not require submodules, private dependencies, or authenticated Git LFS objects. When those files are needed, the operator checks out the source locally and uses `type: directory`.

A repository that becomes unavailable after planning causes a bounded infrastructure failure. Harbor-HF must not fall back to a credential, another revision, a mutable branch, or a locally cached checkout.

## No source credentials

Benchmark source resolution never contributes a Job secret name. The source models have no `credentials`, `secret_name`, token, key, header, cookie, or authorization field.

Harbor-HF must not forward `GITHUB_TOKEN`, `GH_TOKEN`, an SSH key, an SSH agent, a Git credential helper, or the output of `gh auth token` to a Hugging Face Job, Sandbox, Endpoint, schedule, or remote secret store.

Private Git may still be used on the operator machine. The operator may use an existing local checkout or use locally configured Git authentication in place, then submit that directory as a bundle. The credential remains in its original local store.

This boundary does not remove runtime credentials that are independently required for private HF storage, model inference, or judging. Each runtime credential requires a purpose-scoped value and explicit approval for its exact source and remote destination.

## Resolved source lock

Planning writes one internal JSON file named `source.lock.json` with schema `harbor-hf/benchmark-source-lock/v1alpha1`. The campaign YAML remains the only author-facing file.

A public Git lock has this shape:

```json
{
  "schema_version": "harbor-hf/benchmark-source-lock/v1alpha1",
  "source": {
    "type": "git",
    "repository": "ShellBench/public-tasks",
    "revision": "0000000000000000000000000000000000000000",
    "path": "tasks/115-tasks"
  }
}
```

A directory resolves to this shape:

```json
{
  "schema_version": "harbor-hf/benchmark-source-lock/v1alpha1",
  "source": {
    "type": "bundle",
    "content_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "manifest_sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

A package lock records the exact content-addressed package reference:

```json
{
  "schema_version": "harbor-hf/benchmark-source-lock/v1alpha1",
  "source": {
    "type": "package",
    "reference": "harbor/terminal-bench@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

The source lock never records an operator path, mutable ref, credential name, credential value, or temporary staging location.

The campaign plan digest covers the complete source lock. The separate manifest digest continues to identify the exact requested YAML. Moving an unchanged directory therefore changes the manifest digest but not the source content digest or semantic campaign plan.

## Benchmark bundle

A bundle has two stored files:

```text
benchmark-bundles/sha256/<content-digest-without-prefix>/
├── payload.tar.zst
└── bundle.json
```

The managed location is beneath the submitting namespace's private `jobs-artifacts` Bucket. The payload is written and verified first. `bundle.json` is written last and is the completion marker. A prefix without a valid `bundle.json` is incomplete and cannot be mounted or reused.

`bundle.json` uses schema `harbor-hf/benchmark-bundle/v1alpha1`:

```json
{
  "schema_version": "harbor-hf/benchmark-bundle/v1alpha1",
  "content_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "entries": [
    {
      "path": "dataset.toml",
      "type": "file",
      "mode": 420,
      "bytes": 123,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
    },
    {
      "path": "tasks",
      "type": "directory",
      "mode": 493
    }
  ],
  "payload": {
    "filename": "payload.tar.zst",
    "media_type": "application/vnd.harbor-hf.benchmark-bundle.tar+zstd",
    "bytes": 456,
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

### Bundle fields

| Field | Required | Meaning |
| --- | --- | --- |
| `schema_version` | Yes | Exact bundle schema identifier. |
| `content_digest` | Yes | Digest of the canonical entry sequence. |
| `entries` | Yes | Complete sorted directory and file inventory. |
| `payload` | Yes | Exact stored archive identity. |

A directory entry contains `path`, `type: directory`, and `mode`. It forbids `bytes` and `sha256`. A file entry contains `path`, `type: file`, `mode`, `bytes`, and `sha256`.

Entry paths are unique, normalized POSIX paths relative to the bundle root. They never begin with `/` and never contain empty, `.`, or `..` components. Parent directories must appear before descendants. Entries are sorted by UTF-8 path bytes after normalization.

Directory modes are normalized to decimal `493` (`0755`). File modes are decimal `420` (`0644`) or `493` (`0755`), preserving only whether the source file was executable. The bundle does not preserve ownership, ACLs, extended attributes, hard-link identity, inode numbers, or timestamps.

`content_digest` is SHA-256 over canonical JSON containing only the ordered `entries` array. Canonical JSON uses UTF-8, sorted object keys, no insignificant whitespace, and no trailing newline. The digest is independent of the original path and archive compression. Machine identity, ownership, and timestamps also have no effect on it.

`bundle.json` itself is serialized as canonical JSON plus one trailing newline. `manifest_sha256` in the source lock is SHA-256 over those exact bytes.

## Payload construction

The payload contains exactly the entries in `bundle.json` and no enclosing directory. Tar member names equal entry paths. The writer normalizes ownership to UID and GID zero, clears user and group names, sets modification time to zero, and uses the modes in the entry records. It does not emit links or special members.

Compression settings belong to the bundle writer implementation and affect `payload.sha256`. They do not affect `content_digest`. If a complete bundle already exists for the same content digest, the submitter verifies and reuses its stored manifest and payload.

The snapshot builder reads each source file into the frozen payload while hashing those exact bytes. It records the source inventory before and after construction and fails if any path, type, size, modification identity, or file content changed. It never uploads directly from a mutable source tree.

## Upload and reuse

Bundle publication follows this order:

1. Verify that the managed Bucket is private.
2. Build and validate the complete bundle locally.
3. Inspect the content-addressed destination.
4. If a complete bundle exists, verify its manifest and payload, including every entry digest, and reuse it.
5. If no complete bundle exists, upload the payload to the unique destination.
6. Read the payload back or use an authoritative remote checksum and verify it.
7. Upload `bundle.json` last.
8. Read and validate `bundle.json` from the Bucket.
9. Record its exact digest in `source.lock.json`.

Harbor-HF never overwrites a complete bundle. A conflicting object at the same content address is a hard failure. An incomplete prefix may be repaired only when every existing object matches the new bundle; otherwise it is quarantined for operator inspection.

The local uploader uses the operator's configured HF authentication in place for normal Bucket access. That credential is not copied into the remote benchmark source contract.

## Remote loading

The Job input package contains:

```text
campaign-input/
├── manifest.yaml
├── source.lock.json
├── campaign.lock.json
└── input-manifest.json
```

`input-manifest.json` covers the exact bytes of the other three files. The source bundle is a separate content-addressed volume mounted read-only at a fixed path. It is not copied into every campaign input package.

For a bundle source, the controller:

1. validates the input package
2. validates the source lock
3. validates `bundle.json` against the locked manifest digest
4. validates the payload digest and bounded size
5. extracts into a new Job-local empty directory without following links
6. verifies the extracted inventory and every file digest
7. gives Harbor a local `DatasetConfig.path` rooted at that directory

Extraction rejects absolute paths, traversal, duplicate members, links, devices, FIFOs, unexpected entries, size overruns, mode mismatches, and writes through an existing path. Failure occurs before agent, judge, provider, endpoint, or other paid benchmark work.

For a Git source, the controller performs the isolated anonymous checkout and gives Harbor the locked repository path. For a package source, Harbor receives the exact content-addressed package reference.

## Planning and identity

Validation checks the author-facing source shape. Planning resolves it and writes the source lock. Planning a directory reads local files but creates no remote resource. Submission rebuilds the bundle and requires the resulting source lock to match the approved plan before upload or Job creation.

The resolved source lock participates in every run, shard, wave, and trial identity within the campaign. `task_digests` remain required for the selected task set. After loading the source, Harbor's reported task digests must match them before a trial can be accepted.

A controller retry, endpoint wave, or recovery attempt reuses the original source lock. It must not reread an operator directory, resolve a newer Git commit, or select another bundle.

## Retention and deletion

Bundles are shared immutable inputs. Campaign locks reference them by digest. Normal campaign cleanup never deletes a referenced bundle.

A separate dry-run garbage collector may identify bundles unreachable from retained campaign locks. Deletion requires an explicit operator action, a fresh reachability scan, and a record of every deleted digest. Age alone is not sufficient proof that a bundle is unused.

## Validation failures

Planning or submission fails when:

- a Git source is not anonymously readable
- a Git revision or path is mutable or unsafe
- a source declares credentials
- a directory is missing, changes during construction, or contains a prohibited entry
- a bundle contains a credential finding
- a bundle is incomplete, conflicting, oversized, or checksum-invalid
- the rebuilt source lock differs from the approved plan
- the managed input Bucket is not private
- the exact source cannot be loaded without an unapproved credential

Runtime fails before benchmark execution when anonymous Git checkout, bundle validation, extraction, or task-digest verification fails.

## Boundaries

This format identifies benchmark input files. It does not define Harbor task structure, verifier behavior, agent configuration, evidence bundles, model credentials, judge credentials, provider credentials, or result publication.

A benchmark bundle is an immutable execution input. It is not a public dataset release format and does not make private task content publishable.

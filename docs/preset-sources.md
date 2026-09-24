# Preset sources

The catalog in `presets/` holds reviewed presets for very popular benchmarks only. Every other
benchmark, harness, model set, or personal campaign comes from a **preset source**: a Hugging
Face repository at one exact commit that an operator names in the environment. An operator can
therefore add, change, or remove new presets without changing this repository or rebuilding the
control Space.

## What a source is

`HARBOR_HF_PRESET_SOURCES` holds a JSON list of at most eight sources:

```json
[
  {
    "repository": "<namespace>/<preset-repository>",
    "kind": "dataset",
    "revision": "<40-character commit>",
    "path": "presets"
  }
]
```

- `repository` is the canonical `namespace/name` Hub repository. A scheme, a port, a query, a
  fragment, or a credential is refused.
- `kind` is `dataset` or `model`.
- `revision` is the exact 40-character commit. A branch, a tag, and a short form are refused.
- `path` is the directory inside the repository that holds `agents/` and `benchmarks/`, and it
  defaults to the repository root. An entry outside those two directories refuses the source.

A source is the single interface for harnesses, benchmarks, and presets together. An agent
preset names its harness artifact and its pinned version, and a benchmark preset names its
dataset and its pinned commit. One source revision therefore changes all three without a
service rebuild, and the preset contract itself does not change.

## What the service does at startup

1. It reads each source over the Hub API with the control credential: the requested commit must
   resolve to itself, the listing under `path` may contain preset files only, and every file
   must match the git object of that commit.
2. It validates every file with the same `agent-preset-v1` and `benchmark-preset-v1` schemas
   that the baked catalog uses.
3. It merges the sources into a disposable directory over a copy of the baked catalog, and
   hands that one root to the preset catalog and to the native launch inspection.
4. It reports the repository, commit, directory, content digest, and preset identities of every
   source in `GET /api/v1/presets`.

Harbor still owns the run. The merged root holds the reviewed preset shape; the service adds no
field of its own to a preset, and Harbor validates the resulting `JobConfig` as before.

## Failure rules

- A source that cannot be reached, resolved, listed, read, decoded, or verified stops startup.
  The service does not start with a partial catalog, and no fallback source is used.
- Two owners of one preset file name, or of one preset identity, stop startup. The service never
  picks a winner between the baked catalog and a source, or between two sources.
- The merged directory is disposable. The service removes it when it stops, and the pinned
  sources rebuild it at every startup, so the change adds no storage, backup, or migration.
- A loose pin, an unknown field, an unexpected path, an oversized file, and an off-origin
  response are refused, so a source cannot smuggle in a preset that no reviewer saw.

## Credential boundary

The read uses the control credential in place, towards `huggingface.co` only, and only while
reading a configured source. The credential never enters the merged directory, a run record, a
log, a response, or a preset file. A preset must not name a credential or a credential alias:
use the fixed inference template or a reviewed endpoint connection, as
[provider credential references](provider-credential-references.md) describes.

## Harbor-first evidence

Checked at pinned revision `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- No file under `src/harbor/` contains the word `preset`, at this revision or through the
  current upstream history. Harbor has no preset catalog, no preset identity, and no preset
  source; the catalog is Harbor-HF's own reviewed layer.
- `src/harbor/models/job/config.py` (`JobConfig`, `DatasetConfig`, `AgentConfig`) keeps sole
  ownership of job configuration. A preset still resolves into these native fields, and this
  change adds no Harbor field, alias, or wrapper.
- `src/harbor/registry/` and `src/harbor/tasks/` keep task and dataset resolution. The preset
  source resolves no task; Harbor resolves every requested task from the preset unchanged.
- `src/harbor/cli/config_sources.py` reads one YAML or JSON configuration document for a run
  from a local path or an HTTP(S) URL. It is not a catalog: it carries no preset identity, no
  per-file validation, no commit pin, and no control-plane merge, so it cannot replace a
  reviewed preset source and is not used for one.

The change is one reviewed preset contract in Harbor-HF. No parser, resolver, scheduler, or
result format is added, and no upstream Harbor change is needed.

## Limits

- Startup reads a source once. A change to a source needs a new commit and a service restart,
  which is the same moment the operator already reviews a new preset.
- The console lists presets as before and does not yet render source provenance. The API is the
  authoritative surface for it.
- Offline validation proves the shape and identity of every preset. It does not prove that a
  benchmark dataset or a harness artifact exists, and it is not authorization to launch work.

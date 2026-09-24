# Reviewed presets

This directory holds the baked preset catalog: what the control service serves without any
external configuration.

- `benchmarks/` holds `benchmark-preset-v1` documents. Each names a benchmark dataset and the
  native job fragment for it.
- `agents/` holds `agent-preset-v1` documents. Each names a harness artifact and its pinned
  version.

A preset belongs here only for a **very popular benchmark**. Every other benchmark, harness,
model set, or personal campaign belongs in a pinned preset source instead; see
[preset sources](../docs/preset-sources.md).

Two rules apply to every file here:

- Do not name a credential or a credential alias. Use the fixed inference template or a reviewed
  endpoint connection.
- Keep the file close to a Harbor `JobConfig` fragment. Do not add a field that Harbor already
  represents.

A preset identity and a file name must be unique across this catalog and every configured
source. Two owners of one preset stop the service instead of silently choosing a winner.

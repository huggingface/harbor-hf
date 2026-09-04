---
title: Historical result field ownership
author: Harbor-HF maintainers
date: 2026-09-04
tags: [historical, results, harbor]
---

# Historical result field ownership

> **Status:** Historical record. The current result and storage contract is in
> [Architecture](architecture.md) and the
> [simplification implementation specification](2026-09-04-simplification-implementation-spec.md).
> Publication tables, profiles, execution bundles, catalog fields, managed
> Endpoints, and supersession rules below are obsolete. The retained Harbor
> field ownership tables explain why Harbor remains the authority for trial
> results, rewards, costs, exceptions, and trajectories.

This inventory described the earlier authority boundary between Harbor and
`harbor-hf`. Dataset columns could repeat values for query performance, but
repetition did not transfer ownership.

## Harbor-Owned Values

| Published field | Canonical source | Projection rule |
| --- | --- | --- |
| `trial_id` | Harbor `TrialResult.id` | Copy from the pinned compatibility export. |
| `task_name`, `task_digest` | Harbor trial lock and result | Public allowlist only; never publish task bodies. |
| verifier metric names and values | Harbor `VerifierResult.rewards` | Preserve names and numeric values without reinterpretation. |
| verifier result and selected successful execution | Harbor trial result | Derive only through the pinned Harbor models. |
| Harbor timing and usage | Harbor job and trial results | Add query columns only when the public contract explicitly allows them. |
| Harbor exceptions | Harbor job and trial results | Keep complete values private; public projections use approved classifications only. |
| native artifacts and sessions | Harbor job directory | Keep bytes in the private Bucket; public rows contain allowlisted metadata only. |

`harbor-hf` does not define replacement models for these concepts. Until
Harbor provides a storage-neutral export contract, the compatibility exporter
runs inside the pinned Harbor environment and records native serialized model
paths and digests in `harbor-native-bundle.json`.

## harbor-hf-Owned Values

| Published field | Canonical source |
| --- | --- |
| run and run IDs | run and run locks |
| physical execution ID and attempt | execution lock |
| physical execution bundle status | verified bundle presence or `not_available` for failed or cancelled execution |
| physical execution status, failure category, and retry reason | run recovery events |
| task outcome | selected execution, Harbor result, and exhausted retry decision |
| run quality | deterministic projection of all task outcomes |
| planned trial denominator | immutable run and run locks |
| provider, region, hardware, and accelerator count | resolved deployment lock |
| model repository, revision, engine, quantization, context, and concurrency | resolved model and deployment profiles |
| remote HF Job, Endpoint, Dataset, Bucket, and Space identity | HF control-plane evidence |
| endpoint cleanup outcome | terminal run decision after all waves close |
| source, archive, envelope, and projection checksums | immutable evidence and publication manifests |
| sanitizer and projector versions | `harbor-hf` publication contract |

## Derived Query Values

The `runs`, `trials`, `attempts`, `metrics`, and `artifacts` Parquet tables are
query projections, not canonical evidence. The cutover replaces their contract
in place under the `v1` identifier; superseded shapes are not retained by the
production reader.

The following catalog values are derived:

- `score`: sum of selected trial rewards divided by the locked planned-trial count;
- `passed_trials`: selected trial rewards greater than or equal to `1.0`;
- `duration_seconds`: run completion time minus run creation time;
- `scored_trial_count`, `agent_failed_count`, `benchmark_failed_count`, and
  `infrastructure_exhausted_count`: counts of explicit task outcomes;
- `failed_attempts`: count of failed physical attempts, regardless of category;
- row counts: counts of validated projection rows.

Every catalog row points to a checksummed projection manifest. That manifest
binds the derived tables to one canonical v1 execution envelope and its Harbor
archive digests. A successful run without verified native bundle provenance is
excluded from the active catalog until it is rebuilt or rerun.

## Privacy Boundary

Public publication rejects credentials, environment values, task bodies,
hidden tests, solutions, raw sessions, unrestricted logs, trajectories,
tracebacks, and artifact bytes. Those remain in the private Bucket under the
run's immutable evidence prefix. A public Dataset contains only allowlisted
rows and manifest references; the public Space has no Bucket credential.

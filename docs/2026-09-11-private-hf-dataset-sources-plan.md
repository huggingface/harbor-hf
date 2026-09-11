---
title: Add private Hugging Face dataset sources
author: Harbor-HF maintainers
date: 2026-09-11
tags: [harbor, hugging-face, datasets, credentials]
---

# Add private Hugging Face dataset sources

## Goal

Allow a reviewed Harbor benchmark to stay in a private Hugging Face Dataset
repository while Harbor remains the dataset resolver and run engine.

The implementation must use Harbor's native Git dataset configuration. It must
not create another source format or copy Harbor's task-resolution behavior.

## Selected design

Use Harbor's existing `DatasetConfig.repo` and `DatasetConfig.path` fields. A
private source has this form:

```text
repo: https://huggingface.co/datasets/example-org/<dataset>.git@<40-character-commit>
path: <task-tree-path>
```

The `repo` and `path` values pass to Harbor unchanged. Harbor's
`GitRepoRegistryClient` resolves the repository, and `TaskClient` finds and
loads the Harbor-format task tree. Harbor-HF adds only reviewed source admission
and credential delivery.

This feature is for any reviewed private Hugging Face benchmark Dataset. It must
not contain rules for a specific benchmark, agent, model, provider, or harness.

## Harbor boundary

The Harbor package is pinned at
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`. The following files and public APIs
were checked:

- `src/harbor/models/job/config.py`: `DatasetConfig`
- `src/harbor/registry/client/git_repo.py`: `resolve_repo_source` and
  `GitRepoRegistryClient`
- `src/harbor/registry/client/factory.py`: `RegistryClientFactory`
- `src/harbor/tasks/client.py`: `TaskClient`

The pinned code already recognizes Hugging Face Dataset Git URLs and resolves
Git-backed task trees. Harbor owns repository checkout, task discovery, task
loading, and run execution. Harbor-HF owns only source admission and secure
credential delivery.

Do not add a dataset source schema, task resolver, downloader, scheduler, result
format, or API. Do not translate the source into a Harbor-HF record. Keep the
native `repo` and `path` values as the only source description.

## Source admission

A reviewed private Hugging Face Dataset source must meet all these rules:

- The scheme is HTTPS.
- The host is exactly `huggingface.co`.
- The URL has no user name, password, port, query, or fragment.
- The path has the exact Dataset repository form
  `/datasets/<namespace>/<dataset>.git`.
- The Git revision is an exact 40-character hexadecimal commit.
- The task-tree location remains in the native `path` field.

The source validator must reject a mutable branch, tag, abbreviated commit,
different host, malformed Dataset path, embedded credential, port, query, or
fragment. Existing public GitHub source admission must not change.

ACP and other executable agent source admission remains separate and unchanged.
Private Dataset access must not grant a credential to agent source installation.

## Credential bridge

Use the existing `HF_TOKEN` service secret. Do not add a new credential field or
secret name.

A small Git credential helper must implement the standard Git credential
protocol. It may return the token only when Git requests credentials for the
exact `huggingface.co` host. It must reject every other host. It must read the
token from the current process environment and must not persist it.

Configure the helper for both places that call Harbor's native Git source APIs:

1. control-side launch inspection; and
2. the trusted parent Job.

The control service and parent Job must keep the token out of URLs, process
arguments, Git credential files, run configuration, Bucket records, projections,
browser responses, and logs. The control `HF_TOKEN` must not enter a trial agent
environment. Existing delivery of the separate inference credential must not
change.

## Failure behavior

Source checks must finish before model inference. The launch must fail closed
when:

- `HF_TOKEN` is missing for an admitted private source;
- the Dataset repository cannot be accessed;
- the exact commit cannot be found;
- the URL or source does not pass admission; or
- Harbor cannot resolve the source through its native Git APIs.

There is no fallback to another repository, revision, source type, or local
copy.

## Implementation steps

1. Extend reviewed dataset admission to accept the strict private Hugging Face
   Dataset Git form while preserving public GitHub behavior.
2. Add the host-restricted, non-persistent Git credential helper.
3. Configure the helper for control-side native launch inspection.
4. Include the helper in the trusted parent image and configure it for parent
   Harbor execution.
5. Prove that the native dataset `repo` and `path` reach Harbor unchanged.
6. Prove that trial agent environments do not receive the control `HF_TOKEN`.
7. Update operator documentation for the existing token's required private
   Dataset read access.

Creating a private Dataset repository, changing token grants, deploying the
Space, and launching paid work are separate operator actions. They are not part
of this code change.

## Verification

Add tests that prove:

- valid private Hugging Face Dataset URLs are accepted;
- invalid schemes, hosts, paths, credentials, ports, queries, fragments, and
  mutable or shortened revisions are rejected;
- public GitHub admission is unchanged;
- the credential helper follows the Git protocol and answers only for
  `huggingface.co`;
- a missing token fails before inference;
- the token is not disclosed in output, arguments, files, records, responses,
  or logs;
- control-side inspection and the trusted parent receive the helper
  configuration;
- trial agents do not receive the control `HF_TOKEN`;
- inference credential delivery is unchanged;
- native `repo` and `path` values reach Harbor unchanged; and
- no custom source record, downloader, resolver, scheduler, result format, or
  API is introduced.

Run the focused Python and TypeScript tests. Then run formatting, lint, type,
public privacy, generated-file, build, and relevant dependency-audit checks. Run
Pi Reviewer against `main` until there are no P0 or P1 findings, address
proportionate P2 findings, and verify that pull-request CI is green.

## Removal condition

The local Git credential bridge fills one gap in the pinned Harbor release.
Replace it when a pinned Harbor release provides an equivalent documented way
to authenticate private Hugging Face Git dataset sources. Keep the native
`DatasetConfig` contract during that simplification and remove the local helper,
its configuration, and its bridge-specific tests.

## Non-goals

This work does not:

- change Harbor's dataset or task semantics;
- add a Hugging Face Dataset downloader;
- add private access for ACP or other executable agent sources;
- expose the control token to trial agents;
- change inference credential delivery;
- create a compatibility source path or fallback; or
- create, modify, or publish a Dataset repository.

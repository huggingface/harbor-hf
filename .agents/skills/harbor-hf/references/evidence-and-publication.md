# Evidence and publication

Harbor HF publishes results derived from canonical private evidence. The
private `<artifact-bucket>` Bucket holds evidence, normalized rows, and catalog
objects. The TypeScript control service rebuilds a disposable SQLite projection
and serves authenticated result views through the same React application used
for campaign progress. The browser never reads the Bucket. Keep deployed names
in private configuration.

## Evidence hierarchy

Canonical campaign evidence follows this hierarchy:

```text
campaign lock
wave lifecycle and cleanup evidence
run lock
shard progress
logical trial lock and summary
physical execution lock and evidence
checksums
terminal marker
```

A physical retry creates a new execution directory. It never overwrites a prior
execution. A logical trial summary selects the accepted execution and binds its
checksum manifest.

Terminal markers are written last. Parent summaries must bind child checksum
manifests. A marker without its complete immutable envelope is invalid.

## Complete physical execution

A scored physical execution needs:

- immutable execution and Harbor requests;
- the Harbor compatibility bundle;
- complete frozen `/app` archive and file index;
- native agent session and trajectory when required;
- provider route and request evidence for provider-backed agents;
- judge recorder summary and selected complete exchange when required;
- native verifier reward and scorecard plus stdout and stderr;
- private artifact inventory;
- exact secret scan;
- complete root checksums;
- terminal marker written after validation.

A zero reward can satisfy this list. Missing evidence cannot.

## Workspace boundary

The workspace archive captures `/app` after the agent and descendants stop and
before verification. The frozen copy is the verifier input. Verifier-created
files are verifier evidence and do not alter the authoritative post-agent
workspace.

The archive and index must agree on paths and node types. They must also agree
on modes and sizes plus digests. They must also agree on safe symlink targets. Capture cannot omit files to fit a policy limit.
Unsupported nodes, unsafe symlinks, changing files, limit overflow, and known
secrets invalidate the physical execution.

## Judge evidence

Judge calls use an execution-scoped recorder. Retain:

- exact received and forwarded request bytes;
- exact upstream and delivered response bytes;
- strict exchange metadata;
- allowlisted response and request metadata;
- recorder call counts and close state;
- selected exchange ID used by the scorecard;
- locked provider, API URL, model, reasoning policy, and temperature policy.

Credentials, cookies, authorization headers, and route capabilities are never
retained. A missing recorder cannot be replaced by a direct judge call.

A deterministic no-submission path may close the recorder with zero calls when
the locked task policy permits it. The evidence must state that branch and omit
a selected exchange.

## Provider evidence

Provider records remain content-free. They may retain request identity,
routing and status together with timing and quota. They also retain usage and retry
observations plus throttle observations. They do
not retain prompts, responses, tool names, arguments, credentials, or scoped
capabilities.

Check continuation across tool calls and verify that retries use normalized
request identity after authoritative provider parameters are applied. Fleet
queue delay remains separate from provider latency.

## Structural, digest, and deep validation

Structural validation checks schemas, strict fields, safe paths, identity,
states and references together with ordering and media types. It also checks timestamps and
completion rules.

Digest validation reads every referenced file and checks exact size and SHA-256.
It also checks parent coverage.

Deep validation streams the workspace archive, parses every session and
trajectory record, validates judge body references and native verifier records,
and compares restored content with the file index.

Run local trial validation on downloaded evidence:

```bash
uv run harbor-hf artifacts verify-trial TRIAL_ROOT --deep
```

Restore only to a new empty destination:

```bash
uv run harbor-hf artifacts restore-trial TRIAL_ROOT DESTINATION
```

A restore operation performs no remote fetch. Download private evidence first
through an approved credential path.

## Campaign verification

After reconciliation is terminal:

```bash
uv run harbor-hf artifacts verify CAMPAIGN_ID \
  --namespace NAMESPACE \
  --format json > artifacts-verify.json
```

Review every run and declared checksum. Confirm:

- campaign and run identities;
- task names, task digests, and logical attempts;
- selected physical executions;
- finite rewards and metric ownership;
- compatible Harbor and agent identities;
- endpoint cleanup evidence or provider route closure;
- complete terminal markers;
- absence of traversal, unsafe members, extra files, and conflicting markers.

Remote verification is mandatory before publication. Local deep validation adds
audit confidence and is mandatory for repaired or recovered evidence.

## Secret scanning

Known injected secret values are the mandatory scan set. Load them from the
approved local secret store without printing them. Scan path components and
regular-file bytes in:

- workspace archives and indexes;
- sessions and trajectories;
- provider and judge evidence;
- Harbor and worker logs;
- manifests, locks, failures, compatibility bundles, and checksums;
- candidate normalized public files and publication receipts.

Also use high-confidence generic patterns for API keys, bearer tokens, private
keys, cookies, signed URLs, scoped capabilities, and secret query parameters.

Report only the file, detector category, and count needed for remediation. Do
not print matching bytes. A known secret in exact trial evidence invalidates the
execution; rewriting it with a redaction token would destroy reproducibility.

## Scoring review

Before publication, independently compute:

- expected logical trial denominator;
- selected tasks and attempt distribution;
- reward counts and finite-value checks;
- strict pass count;
- mean reward;
- per-task pass count across attempts;
- infrastructure-exhausted and agent-failed counts plus benchmark-failed and
  cancelled counts and invalid counts;
- physical retry count and retry reasons.

For six-attempt protocols, report the mean across six independent attempts and
each task's 0-to-6 pass count. Do not use any-of-six as the headline score.

Keep failure categories in the result. Infrastructure exhaustion cannot be
presented as a model answer, even when the fixed-denominator policy assigns it
zero.

## Result classes

Ordinary complete results may enter the comparable cohort defined by the
publication contract. Complete campaigns can contain terminal benchmark zeros
and declared exhausted failures when the protocol defines them.

Partial and composite results need explicit labels. Correction and diagnostic results need them too. Manually selected results
also need
explicit labels and publication paths. Do not insert them into an ordinary
complete cohort.

A provider-backed run publishes `model_revision: not_observed` because the
Inference Provider does not prove which Hub commit it served. Endpoint-backed
runs publish only the revision verified from endpoint configuration.

## Publication

Publication is a separate deterministic action after every logical task is
sealed, all physical actions have receipts, and endpoint cleanup is verified.
The reconciler writes immutable Parquet tables, catalog objects, and a
publication receipt. A publication failure does not reopen benchmark work.

Inspect the projected publications with:

```bash
uv run harbor-hf results
uv run harbor-hf audit
```

Record:

- publication ID and campaign ID
- immutable paths and SHA-256 digests for every result object
- source campaign, selected attempts, and Bucket evidence paths
- full model, benchmark, harness, and deployment provenance
- row counts for each normalized table
- result outcome, quality, publication role, and metric unit
- publication receipt and catalog digest

A repeated matching publication adopts the existing objects and receipt. It
does not duplicate rows or execute a task.

## Catalog decisions

Profile promotions and result corrections are immutable records with an actor,
reason, evidence, and source digest. A withdrawal changes comparison
eligibility without deleting private evidence. Keep evidence while any result,
correction, audit, or recovery record refers to it.

## Public boundary

Public result stores may contain normalized rows and safe artifact metadata,
including private relative path, media type, size, and digest. They must not
contain raw sessions, trajectories, workspaces, task bodies, prompts, judge
responses, scorecards, manifests, logs, or archives.

The React console reads validated catalogs through same-origin APIs. It has no
direct Bucket credential and owns no authoritative state.

## Publication report

A final report should state:

- campaign result class and completeness
- logical and physical execution counts
- score calculation and denominator
- failures and infrastructure retries by category
- artifact verification and deep-validation results
- secret-scan file count, byte count, detector set, and zero-finding status
- provider or endpoint identity limits
- publication object digests and control revision
- catalog role or correction action
- remaining retention and audit obligations

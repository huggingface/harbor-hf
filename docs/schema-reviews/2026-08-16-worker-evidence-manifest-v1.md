# Worker evidence manifest v1 schema review

## Scope

This review covers
`packages/contracts/schemas/worker-evidence-manifest-v1.schema.json`.
The manifest binds immutable evidence chunks to one campaign and one physical
launch action. It also identifies the logical task.

## Schemator result

The deterministic local Schemator strategy converged after one iteration. It
retained all nine fields. It proposed no field or structural changes and
reported no consistency warnings.

The Codex-backed strategy was also attempted, but the configured reviewer had
no remaining usage allowance. It produced no field decisions and made no
schema changes.

## Manual semantic review

The source schema is accepted without changes.

The campaign and action identifiers prevent substitution across scopes. The
task identifier prevents evidence from moving between logical tasks.

The `objects` field is a bounded list because workers upload evidence in
resumable content-addressed chunks. Every object records its path and digest.
It also records byte size. Receipt acceptance and replay check all three facts
against the immutable store.

The schema version and kind follow the repository's durable-record conventions.
Unknown fields remain invalid.

Canonical JSON includes a trailing newline. The contracts package enforces
that byte-level rule because JSON Schema cannot express it.

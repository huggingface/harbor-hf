# Control record v1 schema review

## Scope

This review covers [`control-record-v1.schema.json`](../../packages/contracts/schemas/control-record-v1.schema.json) after completion of the TypeScript control service and its historical-import and recovery paths.

## Schemator result

Schemator local review converged after one iteration. The initial and final
graphs both contained 128 fields. It applied no changes. It also found no
skipped or manual proposals and no consistency warnings. The graph diff was
empty.

## Manual decisions

The final product-semantics pass retained the following deliberate boundaries:

- Closed record and profile objects remain authoritative, as do action and attempt objects. The same applies to endpoint and publication objects, plus migration records.
- Imported deployment profiles describe historical work and cannot authorize a new launch or retry.
- Real task IDs may begin with digits, and two-character harness names such as `pi` are valid.
- Worker attempts remain bound to the exact durable action that authorized the physical work.
- Action receipts have a separate action-advanced marker so a restart can recover a crash between the remote receipt and its deterministic domain transition.
- Evidence, actor, digest, source revision, cost, terminal selection, endpoint cleanup, and publication provenance remain explicit.
- Profiles embedded in campaign locks remain exact even if promoted aliases later change.

No schema reduction was applied.

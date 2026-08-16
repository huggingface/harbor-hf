# Result catalog v1 schema review

## Scope

This review covers [`result-catalog-v1.schema.json`](../../packages/contracts/schemas/result-catalog-v1.schema.json) after historical result imports and current publication records were exercised through the rebuilt projection.

## Schemator result

Schemator local review converged after one iteration. The initial and final
graphs both contained 25 fields. It applied no changes. It also found no
skipped or manual proposals and no consistency warnings. The graph diff was
empty.

## Manual decisions

The final product-semantics pass retained the following provenance fields:

- publication identity and its campaign, with a run identity when one exists
- publication time and immutable result path
- benchmark and model labels together with harness and inference-provider labels
- run outcome and quality plus the publication role
- task counts covering total and scored work plus strict passes
- the named primary metric and unit
- the digest linking the catalog to its source records

Imported catalogs use the same closed contract as new publications. Missing historical facts remain `null`. The migration does not invent provenance. No schema reduction was applied.

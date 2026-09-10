---
title: Immutable launch pricing
author: Harbor-HF maintainers
date: 2026-09-09
tags: [pricing, workbench, leaderboard]
---

# Immutable launch pricing

Workbench offers **Record launch pricing**, initially off. When enabled, all three
USD-per-million rates are required: input including cache, cached input, and output.
Each rate must be finite and between zero and 1,000,000 inclusive. Zero is valid;
blank is not zero. Pricing is operator-entered, not fetched from a provider.

The optional top-level `pricing` object is saved once in the existing Bucket
`runs/<run-id>/run.json`. It is not part of Harbor `JobConfig`, `lock.json`, recipe
provenance, scripts, or setup identity. The same idempotency key with unchanged
rates returns the existing run; changing or removing rates conflicts. Historical
unpriced records remain valid. Original launch prices cannot be edited. The
[audited pricing correction flow](run-pricing-corrections.md) records separate
shared rate revisions without changing the launch record or rerunning work.

Workbench saves raw incomplete edits in its existing browser draft. Disabled rates
remain in that draft but are omitted from the launch request. Saved browser-only
scenario prices are never automatically copied into launch pricing. Reload requires
fresh confirmation. Editing prices resets launch confirmation, not the tested
recipe or setup attestation. Browser validation is generated from the versioned
schema ahead of time; it requires no dynamic compilation under CSP.

## Shared estimates and missing evidence

SQL list/detail reads derive `shared_estimate` from the already-loaded immutable
record and native job `result.stats`. They make no extra Bucket reads and add no
SQLite column or durable estimate cache. The browser-safe contracts helper also
supplies the existing browser scenario arithmetic:

```text
((input_tokens - cache_tokens) * input_rate
 + cache_tokens * cached_rate
 + output_tokens * output_rate) / 1,000,000
```

All three usage counters must be nonnegative safe integers, with cache no greater
than input. Missing, malformed, fractional, nonfinite or inconsistent counters
produce unknown (`null`), never zero. A missing rate card reports `pricing_unset`;
unusable usage reports `usage_unavailable`.

**Available is not complete.** Harbor's native aggregation can include only the
trials that supplied a counter. Neither finished status nor measured agent-time
coverage proves complete usage. The estimate uses reported aggregate usage only;
it is not a provider bill, total lifetime spend, or a claim about complete charges.
It does not infer per-request pricing tiers from cumulative tokens.

## Leaderboard and displays

The existing leaderboard eligibility, grouping, scores and trial counts are
unchanged. Each contributing run uses its own immutable rates before summation;
prices are never averaged or applied to pooled tokens. The group includes
`estimated_runs` and `total_runs`. If some contributing runs have no usable estimate,
**Launch estimate** shows a partial subtotal and **X/Y runs**. No estimates means
unknown. Zero remains zero; a nonfinite group sum becomes unknown. Counts describe
estimate availability, not billing or usage completeness.

Runs, detail and leaderboard keep **Launch estimate** separate from native reported
cost and browser-local **Scenario estimate**. The run estimate tooltip exposes its
immutable rates and the usage limitation for audit. Reported `cost_usd` is never
replaced or filled from prices. The existing cost-per-scored-trial chart continues
to use native reported cost only. Cost ceilings, reservations, receipts, execution,
archive visibility, authentication and write-mode enforcement are unchanged.

## Harbor boundary review

Inspected Harbor `src/harbor/models/job/config.py` (`JobConfig`),
`src/harbor/models/agent/context.py` (`AgentContext`), and
`src/harbor/models/job/result.py` (`JobStats` aggregation and `JobResult`) at pin
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`, plus the 19 cached upstream commits
through `7d5285b4`. Input includes cache; aggregation skips unavailable contributions.
There is no native generic launch rate-card field in these contracts or intervening
history. This is Harbor-HF hosted estimate metadata, not a Harbor execution feature;
no upstream patch, rate-library integration or pin change is needed for it.

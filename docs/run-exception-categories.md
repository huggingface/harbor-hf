# Run exception display categories

Only the exact native `AgentTimeoutError` is labeled **Agent execution timeout**.
It is counted separately from environment/transport, provider, rate-limit,
verifier and unclassified errors. Generic `TimeoutError` and
`AgentSetupTimeoutError` remain unclassified; `VerifierTimeoutError` remains a
verifier exception. Raw exception names and native trial states are preserved.

Agent execution timeouts are separate from infrastructure-related errors; native
type alone does not prove timeout origin. Harbor's outer execution deadline and
an inner `asyncio.TimeoutError` can both produce this type. Measured wall time
cannot establish a numeric budget or budget exhaustion. No replacement eligibility,
replacement-candidate labels or retry actions are introduced.

The summary shows a neutral **Agent timeouts: N** only for positive evidence.
Known agent timeouts do not increase infrastructure-related or unclassified
counts. Affected-trial totals are deduplicated across types and evaluations;
each category is independently deduplicated, so category counts may overlap and
need not sum to the total. Positive exception totals remain red. Partial evidence
retains lower-bound labels (`≥` / “at least”); missing evidence is not zero.

## Native source review

Reviewed Harbor at pinned revision
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- `src/harbor/trial/errors.py`: execution, setup and verifier timeout types are
  distinct subclasses of `asyncio.TimeoutError`.
- `src/harbor/trial/trial.py`, execution timeout handler (lines 539–556): wraps
  `asyncio.wait_for` and catches `asyncio.TimeoutError`, including inner errors.

Reviewed upstream history through `1f84b4c0`; these files have no intervening
changes. This is a display-only taxonomy, not new Harbor execution behavior,
root-cause inference or a pin update.

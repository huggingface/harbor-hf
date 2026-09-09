# Compact results UI

Display-only changes preserve native identity, slot assignment, whole-column
filtering/pagination and navigation resets. Desktop cells are container-responsive squares: `clamp(12px,
calc((100cqw - row-label-budget) / shown-column-count), 18px)`. The scroll
container establishes inline-size containment; its content width excludes padding.
The row-label budget reserves at least two digits, grows for 100+ repeats,
and includes a 2px rounding allowance. Only integer display counts enter CSS.
The max-content table does not shrink: all 89 columns fit at desktop widths
of 1600px and above, while narrow containers scroll at the 12px minimum.
Small matrices stay compact at the 18px maximum, without stretching. Coarse
pointers receive 24px square targets. No intercell spacing is added. Markers are 11px, except unmapped
observations (4px). Unfinished is solid cyan, not a claim of running execution;
unknown/interrupted is a purple outline. Semantic task headers remain available
to assistive technology without hidden focusable controls. Legend magnitudes
match cells. Tooltips retain measured agent time and omit unavailable budgets.

A fixed-size header slot reserves freshness/error feedback across background
loading, healthy and stale states. Refresh failures retain Retry. The matrix
links to native exception evidence, shows positive affected counts in red, and
keeps diagnostic caveats in existing help rather than repeating summary prose.

Cache hit is reported cached/input × 100, rounded to one decimal. Native input
includes cache; cache is never added to input. Known zero cache with positive
input is 0.0%; missing, negative, nonfinite, zero input or cache exceeding input
is unavailable. Exact native token counts remain accessible via existing hints.
Summary cards retain status, Agent Σ, partial coverage and critical values, with
compact padding and six columns at the 2xl breakpoint. The Agent Σ caveat
lives in keyboard-accessible Status help, not repeated visible prose. The
reported-token heading uses M (millions); cache remains prominent with exact
native values in hints. Summary and freshness wrappers expose named region
and group semantics respectively.

## Harbor boundary review

Reviewed pinned `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` source:
`src/harbor/models/agent/context.py`, `src/harbor/models/trial/result.py`,
`src/harbor/models/trial/config.py`, `src/harbor/models/job/config.py`,
`src/harbor/models/job/result.py`, and `src/harbor/models/job/lock.py`.
Reviewed locally available upstream history since the pin through `1f84b4c0`;
no resolved-budget evidence has landed that warrants changing the pin here.
Lock/config retain timeout resolution inputs, not effective/base budgets.
A future upstream change must expose native resolved per-trial/per-step budgets
before this UI can show them. No local timeout formula, new budget field,
benchmark-file read or Harbor patch is introduced. No upstream publication.

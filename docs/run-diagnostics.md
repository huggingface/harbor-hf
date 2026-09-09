# Run diagnostics and configuration provenance

## Automatic native-evidence display

The Runs table and run detail project Harbor's existing
`result.json.stats.evals[*].exception_stats`. The normal control projection and
browser polling refresh these diagnostics; there is no new completion hook,
background analyzer, durable diagnosis record, or second reconciler. Existing
runs become readable through the same path without rewriting their evidence.

The table reports distinct affected trial names, deduplicated across native
exception groups. Run detail groups names by the exact Harbor-reported exception
type and links to each trial's evidence. Missing, malformed, or contradictory
exception evidence is labelled unknown/partial, not zero. A fully populated
empty exception map means only **no recorded exceptions**.

Harbor completion counts include errored trials. A finished run is not proof that
all trials passed, or even that every trial was validly scored. Rewards and
exceptions can coexist. Diagnostics do not change rewards, completion timestamps,
status, cost accounting, retry policy, or leaderboard selection.

## What these records cannot establish

Do not call a generic `RuntimeError` or `RemoteProtocolError` a proven
infrastructure incident solely from its name. Do not classify a zero reward as
model failure solely because `exception_info` is absent. Do not parse task names,
traceback frames, or verifier log strings into an alternative failure taxonomy.
Harbor owns classification and execution semantics.

Pinned Harbor does not persist a general verifier-bootstrap/scoring-validity
signal. A test script can fail to prepare its dependencies while still leaving a
reward file. Likewise, a command-stream error does not identify which remote
lifecycle or network condition ended the stream. The UI therefore presents native
exception evidence and leaves infrastructure classification unknown.

### Required upstream evidence (proposal, not implemented)

A Harbor-owned backward-compatible extension should preserve:

- failure phase and a typed failure kind, with underlying cause/provenance;
- command transport interruption separately from a returned process exit;
- verifier command termination and explicit bootstrap/scoring lifecycle evidence;
- whether scoring actually started/completed, independently of its reward;
- subsequent failures rather than only the first exception where appropriate.

Exit status alone cannot distinguish setup failure from a failed assertion. A
native verifier lifecycle protocol is needed before a deterministic bootstrap
classification is available. Old records without those fields remain unknown;
do not heuristically backfill them or mark them passed. Once Harbor records the
classification, Harbor-HF should project it rather than recreate it.

## Configured versus effective agent settings

Run detail displays each stored `JobConfig.agents` entry separately: implementation,
model/route string, explicit version/source reference, and native reasoning kwargs.
It does not combine independently joined model/version lists into an implied
single runtime profile. An absent version is not labelled as a verified bundled
version. An absent reasoning option does not mean reasoning is off.

The displayed kwargs are not a parser for arbitrary model strings or command
recipes. Those remain available in the original JobConfig. Provider-effective
reasoning, sampling, and defaults need observed runtime/request provenance;
submission summary fields and exported metadata are insufficient by themselves.

## Completion-boundary investigation

An offline synthetic check of OpenAI SDK 3.8.0 confirms that
`ChatCompletionStreamState.get_final_completion()` can return reasoning-only
output with no finish reason or usage after normal iterator exhaustion. Its
contract does not guarantee that the stream actually finished. Proper terminal
responses, explicit length/safety terminations, and zero-chunk controls must be
kept distinct.

Fast-Agent 0.10.20's inspected OpenAI-compatible path accepts reasoning-only output
as substantive and maps absent/unrecognized finish reasons to `END_TURN`. This
establishes a possible incomplete-stream acceptance path, not proof that any
particular historical provider response was truncated. An explicit provider stop
with only reasoning can produce the same exported shape. Raw structural terminal
events are required to settle attribution; do not infer a transport incident from
an empty answer or missing usage alone.

The corresponding fix belongs at Fast-Agent's provider/completion boundary:
preserve terminal-event provenance, distinguish missing termination from normal
completion, and test reasoning-only responses without treating missing usage as
zero. Do not add a harness-specific completion parser to Harbor-HF. No upstream
source change or issue is included here.

## Harbor boundary review

Checked Harbor revision `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- `src/harbor/models/job/result.py`: native exception groups and completion counts;
- `src/harbor/models/trial/result.py`: exception and timing evidence;
- `src/harbor/models/verifier/result.py` and `src/harbor/verifier/verifier.py`:
  reward parsing without a general bootstrap/scoring-validity contract;
- `src/harbor/agents/installed/base.py`: native command-exit classification;
- `src/harbor/environments/hf_sandbox.py`: command-stream handling;
- `src/harbor/trial/single_step.py`: verification can follow an agent exception;
- `src/harbor/models/trial/config.py`: native agent configuration fields.

Reviewed subsequent upstream history through `90e28af3`. It does not add the
structured evidence needed to close the classification gap. No pin update,
Harbor patch, retry logic, or result writer is introduced by this display change.

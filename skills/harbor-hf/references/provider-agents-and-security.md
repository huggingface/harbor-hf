# Provider agents and security

Provider-backed Harbor runs load external custom agents from
`packages/harbor-hf-agents`. Upstream Harbor remains unchanged. The worker
revision pins orchestration and the complete custom-agent package.

## Supported boundary

New provider campaigns use Harbor's public `AgentConfig.import_path`. The
current package has separate modules for:

- Hermes through Chat Completions;
- embedded OpenClaw through Chat Completions;
- OpenClaw with the genuine Codex runtime through Responses;
- Pi through Chat Completions.

Each module owns installation, configuration, invocation, session collection,
and ATIF-v1.7 conversion. One agent's runtime files or trajectory converter
cannot substitute for another agent.

Generic Harbor HF code uses a declarative registry. It validates logical agent
name, import path, wire API, allowed parameters, trajectory schema, session
requirement, revision kind, and retry taxonomy. Unknown combinations fail
before paid work.

## Revision rules

The custom-agent implementation comes from `remote.worker.revision`. The
underlying agent profile separately pins its runtime:

- package-backed agents use an exact numeric package version;
- Git-backed agents use a full 40-character commit;
- provider-backed agents require the expected custom import path;
- the Harbor result must report the locked logical name and revision.

Layer the dependency-free package into pinned Harbor with `uv run --with`.
Do not mutate the Harbor checkout, modify its lock, use `PYTHONPATH`, depend on
current working directory, or install a mutable package globally.

## Wire API preservation

Preserve each runtime's native API:

- Hermes and Pi use Chat Completions. Embedded OpenClaw uses it too.
- OpenClaw Codex uses Responses and must retain genuine Codex identity.

The scoped proxy exposes one selected path and rejects the other. Rewriting a
native Responses request into a different schema changes runtime provenance and
is forbidden.

Provider deployment parameters are authoritative. They replace same-named
agent parameters after request normalization. Transport fields such as model and messages remain reserved. Input and tools remain reserved. Stream remains reserved too. Verify model-required values
in provider evidence, including sampling and reasoning controls.

## Credential isolation

The trusted recorder holds the real upstream credential and one trial-scoped
capability. Private HF Job ingress may require another credential. Neither value
may enter the benchmark agent.

The custom agent starts a root-owned loopback bridge through Harbor's public
root-execution API. The bridge:

- binds to `127.0.0.1`;
- accepts only the registry-selected API path;
- injects private ingress authorization upstream;
- strips client authorization;
- rejects unexpected methods and paths as well as oversized requests;
- logs no request or response bodies and no headers;
- terminates after the trial.

Run the agent as the dedicated unprivileged account. Use an isolated home and
runtime directory. The agent receives only a localhost URL and a non-secret
placeholder key.

A paid canary must prove:

- bridge UID differs from agent UID;
- the agent cannot read `/proc/<bridge-pid>/environ`;
- agent environment lacks `HF_TOKEN`, provider keys, judge keys, private ingress
  authorization, route capability, and scoped upstream URL;
- bridge binds only to loopback;
- only the selected API path succeeds;
- route revocation occurs before success publication.

Redaction does not replace process isolation.

## Benchmark source credentials

Remote benchmark source loading has no credential path. A Git source must be
anonymously readable at its full locked commit. Disable credential helpers,
SSH agents, askpass programs, interactive prompts, global and system Git
configuration, and ambient Git authentication during both preflight and remote
checkout.

Local and private benchmark files use the bundle contract in
`docs/benchmark-sources.md`. The submitter uses local source access in place,
builds a content-addressed bundle, and uploads it to the managed private input
Bucket. The remote Job receives the verified bundle, not the source credential
or operator path.

Reject a launch when it would forward `GITHUB_TOKEN`, `GH_TOKEN`, an SSH key,
an SSH agent, a Git credential helper, or `gh auth token`. Do not treat a
temporary secret file, later deletion, environment blanking, or log redaction
as permission to copy a personal credential into remote infrastructure.

## Provider evidence

Record one content-free row for every provider attempt. Verify:

- campaign, run, trial, execution, wave, and request identity;
- requested and routed provider and model;
- selected wire API;
- authoritative parameter fingerprint;
- retry attempt and normalized request key;
- queue delay, provider latency, and total duration as separate quantities;
- status, HTTP outcome, throttle and quota observations;
- reported usage and explicit `not_reported` fields;
- checkpoint durability while the wave is active.

Do not store prompts, messages, tool names, tool arguments, response text,
credentials, cookies, or authorization headers.

## Trial-scoped retries

Provider `max_attempts` limits identical forwarded requests within one logical
trial. Independent logical trials have independent retry budgets. Normalize the
request after authoritative provider parameters are applied, then derive the
retry key.

Classify provider transport failures through the locked taxonomy. A recoverable
provider call can succeed on a later bounded attempt within the same physical
execution. An exhausted provider transport failure may authorize a new physical
execution only when the registry and campaign recovery policy classify it as
infrastructure.

Agent and benchmark failures remain terminal even when the last provider HTTP
request succeeded.

## Agent evidence

A successful provider-agent trial must retain:

- Harbor's typed result and compatibility bundle;
- exact custom import path and reported agent revision;
- nonempty native session JSONL when required;
- ATIF-v1.7 trajectory with correct agent and model identity;
- provider request evidence with continuation through tool calls;
- frozen workspace output;
- judge exchange or valid deterministic no-call branch;
- isolation evidence;
- checksums and a zero-finding secret scan.

Generic artifact discovery uses artifact kinds and safe path predicates. It does
not hard-code one session filename per agent.

## Canary matrix

Run a paid canary for every applicable provider, wire API, and agent family.
A canary should use a representative task that exercises tools and produces
workspace output. When the full benchmark uses an external judge, the canary
must exercise that judge path as well.

Validate the canary in this order:

1. remote Job and Harbor process completed without infrastructure exception;
2. provider records contain at least one successful request and valid routing;
3. continuation after tool results is accepted;
4. native session and ATIF trajectory are nontrivial;
5. agent, model, provider, API, and revision identities match the lock;
6. required workspace output exists in the frozen archive;
7. judge exchange uses the locked model and reasoning policy;
8. bridge and agent isolation evidence passes;
9. remote artifact verification passes;
10. deep validation and secret scanning pass.

A reward of zero can pass this matrix. Report it as a benchmark outcome.

## Agent-specific checks

### Hermes

Verify the exact Hermes source commit, `hermes-cli` toolset, turn limit, memory
and profile policy, compression threshold, terminal timeout, delegation limit,
checkpoint policy, approval mode, selected provider family, session identity,
and ATIF conversion. Chat tool-result messages can include a valid `name`; the
bridge and provider schema must preserve it.

### Embedded OpenClaw

Verify the exact package version, embedded harness identity, Chat Completions
route, thinking policy, model-required parameters, retained session, and ATIF
identity. Embedded traces cannot be labeled as Codex.

### OpenClaw Codex

Require genuine `agentHarnessId: "codex"`, Responses traffic, and a Codex-owned
session. Session files may resolve only beneath the isolated agent home or the
retained `logs/openclaw-sessions` root. Preserve incompatibility evidence when
the provider rejects Codex's native Responses request. Do not rewrite the
request or substitute embedded OpenClaw evidence.

### Pi

Verify the exact Pi package version, model configuration, Chat Completions
route, reasoning setting, native Pi transcript, and ATIF identity. Keep Pi
provider files inside the isolated agent home.

## Judge isolation

The judge recorder is separate from the agent provider recorder. The verifier
receives an execution-scoped judge route and ingress credential. It does not
receive the upstream judge key.

The recorder enforces API URL, model, reasoning effort, request and response
limits, call limit, timeout, and temperature policy. It stores exact bounded
request and response bytes after scanning for known secrets. The selected
exchange ID must bind the scorecard.

## Security failure response

Stop the campaign when:

- agent and bridge UIDs are equal;
- bridge environment is readable by the agent;
- a real credential appears in the agent environment or runtime files;
- ingress accepts an unexpected route;
- provider or judge evidence contains a capability or authorization material;
- a session path escapes its allowed root;
- exact evidence contains a known secret;
- route revocation or bridge termination is unverified.

Revoke affected credentials and capabilities through the approved provider and
HF controls. Preserve only content-free incident metadata. Do not upload the
secret-bearing evidence bundle.

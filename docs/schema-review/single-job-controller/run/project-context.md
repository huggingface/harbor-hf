# Single-job campaign controller schema context

Harbor HF uses strict Pydantic models and generated JSON Schemas. These fields replace the provider execution contract inside the existing `v1alpha1` campaign formats. Unknown fields remain errors.

The stable product concepts are:

- one logical campaign with one active physical controller Job;
- immutable provider controller policy and duration bounds;
- deterministic initial wave plans in the plan and concrete shard IDs in the campaign lock;
- a content-addressed three-file controller input package;
- exclusive renewable ownership tied to campaign, plan, physical Job, and attempt;
- immutable physical-attempt reservations and started, ended, and recovery receipts;
- mutable latest status whose repository history preserves older revisions.

Names such as campaign, run, shard, trial, execution, wave, plan digest, physical Job, heartbeat, lease, provider, and controller are existing domain vocabulary and should remain consistent. Duration fields use explicit `_seconds` suffixes. Monetary values use integer `_microusd`. Digests state their algorithm when the value is a raw hex digest and use the existing `sha256:` content-digest form elsewhere.

The model must preserve exact decimal arithmetic for `headroom_factor`, reject unsafe path identities and non-UTC times, and keep provider model revisions `not_observed` when they cannot be proven. Do not add compatibility aliases, defaults for production controller policy, target reporting dates, child wave Job identities, or a second provider execution mode.

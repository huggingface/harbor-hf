# Headless installer authentication: provider eligibility evidence

Status: implementation stopped before runtime changes. This is not a working
headless login implementation or an assertion that Space device grants fail.

## Verified from public sources

- HF discovery at <https://huggingface.co/.well-known/openid-configuration>
  advertises `/oauth/device`, `/oauth/token` and the RFC 8628 device-code grant.
  It lists `client_secret_basic` and `client_secret_post` token authentication.
  Discovery describes the provider, not the grant permissions of one client.
- [Official OAuth documentation](https://huggingface.co/docs/hub/oauth), section
  **Device code OAuth**, explicitly requires HTTP Basic client authentication on
  **both** device authorization and token requests for apps with a secret.
  Public clients can use their client ID alone. Public-client conversion requires
  deleting the existing secret; that is not authorized here.
- [Spaces OAuth documentation](https://huggingface.co/docs/hub/spaces-oauth)
  describes the managed public `OAUTH_CLIENT_ID` and confidential
  `OAUTH_CLIENT_SECRET`, and documents authorization-code login. It does not
  establish the registered device-grant permissions of the existing control Space.
- Public docs source inspected: `huggingface/hub-docs`, revision
  `b2940b66fd3a5022cffbd0473ac2211714c004d7`, files
  `docs/hub/oauth.md` and `docs/hub/spaces-oauth.md`.
- Public Hub client source inspected: `huggingface/huggingface_hub`, revision
  `deb97775d91cb1ce2a4c254b29ad30081044257d`, files
  `src/huggingface_hub/cli/auth.py` and
  `src/huggingface_hub/utils/_oauth_device.py`. `request_device_code()` and
  `poll_device_token()` use `constants.DEVICE_CODE_OAUTH_CLIENT_ID`, not the
  existing Space client. Successful HF CLI login therefore would not establish
  Space client eligibility and must not become application-token fallback.

## Verified locally

Inspected at application source `e572cfc`:

- `scripts/control-service/installer/browser-auth.ts`: rejects Linux without a
  graphical display, launches headed Chromium and requires the planned username
  with `transport === "session"`.
- `apps/control-api/src/config.ts`: production OAuth configuration requires the
  managed client ID and secret. A direct secretless CLI implementation cannot
  simply reuse this confidential-client configuration.
- `apps/control-api/src/auth.ts`, `bearerActor()`: calls HF `whoami-v2`, caches
  identity by token digest and checks the current ACL. It is **not** a static
  bearer-token registry. It currently returns username `API client`; it does not
  establish a Space-client audience/scope binding for a headless installer.
  Replacing the browser transport assertion alone is not sufficient.

## Remaining prerequisite and decision

The existing managed Space client's device-grant eligibility remains unverified.
No authenticated client metadata was inspected, no live device code was issued,
no operator login occurred, and no managed secret was retrieved. Public sources
support a confidential-client broker in general; they are not evidence that such
clients are unsupported, nor proof about this particular registration.

Reject the direct secretless fast path for the current confidential configuration.
The next bounded check is non-secret registered client metadata identifying grant
permissions, or provider confirmation explicitly covering managed Space clients.
If metadata cannot settle that question, a separately reviewed, bounded probe
must run inside the existing Space so its secret never leaves that runtime.
It must request only `openid profile`, avoid logging the device code or tokens,
and must not trigger operator login without interactive agreement. This document
neither authorizes nor performs that probe or a deployment to enable it.

If eligibility is established, record the narrow broker design before code:
existing server-held client authentication on both provider requests; bounded,
rate-limited polling with ephemeral consumer binding; a fresh purpose-scoped token
only in CLI/application memory; exact origin and planned operator checks; fresh
source, health, idle and write-mode checks after restart. No management-token
fallback, cookie export, persistent credential, or custom approval authority.
Do not invent a hosted pairing protocol merely to avoid the unresolved check.

## Validation and scope

Only authorization and this evidence document changed. Privacy and whitespace
checks passed. Runtime unit tests, browser tests, coverage and Docker builds were
not run because no implementation was made; no mocked success is claimed as
provider eligibility. No Harbor behavior, schema, persisted runtime field, API or
UI changed. A subsequent behavior change still requires pinned Harbor source and
history inspection. Local commits only: no push, deployment, write activation,
remote resource mutation, credential transfer, Jobs or inference.

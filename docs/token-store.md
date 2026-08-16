# Local token store

**Status.** Current CLI credential contract, retired from shared control after
the TypeScript service replacement. The control Space uses its one
operator-managed `HF_TOKEN` secret and must never copy values from this file.
Historical CLI workflows may use the store until the new-write switch.

Harbor HF keeps named remote Job tokens in one local INI file. Operators should
manage this file through `harbor-hf auth` instead of editing it.

## File

The default file is:

```text
~/.config/harbor-hf/stored_tokens
```

A minimal file looks like this:

```ini
[campaign]
hf_token = TOKEN_VALUE
```

`TOKEN_VALUE` is a placeholder, not a usable token. Each section stores one
Hugging Face token.

| Part | Required | Meaning |
| --- | --- | --- |
| Section name | Yes | The local name used by Harbor HF. |
| `hf_token` | Yes | The opaque fine-grained Hugging Face token value. |

The file has no version field or extension fields. Unknown fields and
`DEFAULT` values are errors.

## Names and values

A section name must be unique, nonempty, at most 256 characters, and free of
outer whitespace and control characters. Names are case-sensitive; `DEFAULT`
is reserved and invalid.

`hf_token` must be nonempty, at most 16 KiB when encoded as UTF-8, and free of
outer whitespace and control characters. Harbor HF treats the value as opaque.
It does not require a particular token prefix.

The store accepts at most 256 sections and at most 1 MiB of encoded content.
Duplicate sections or fields are errors.

## Paths and permissions

`HARBOR_HF_TOKEN_STORE` replaces the default token-store path. Otherwise the
store lives beside the config selected by `HARBOR_HF_CONFIG` or
`XDG_CONFIG_HOME`.

The store is plaintext, like the Hugging Face CLI token store. On POSIX systems,
its directory must be owned by the current user with mode `0700`; the file must
be an owner-owned regular file with mode `0600`. Harbor HF rejects symlinks and
insecure permissions.

Writes hold an owner-only `.stored_tokens.lock` file across the complete
read-modify-write operation. Authentication commands also hold `.auth.lock`
while changing the token store and selected name together. Writes use a
temporary `0600` file in the same directory, flush it, replace the old file
atomically, and sync the directory. A failed replacement removes the temporary
file.

## Commands

Add, verify, and select a token with one command:

```bash
harbor-hf auth add-job-token campaign
```

The command confirms both destinations, reads the value through a hidden
prompt, verifies that Hugging Face reports the `fineGrained` role, writes it to
the token store, and writes only `campaign` to Harbor HF's JSON config. Use
`--force` to replace an existing entry.

List and switch saved entries without printing values:

```bash
harbor-hf auth tokens
harbor-hf auth use-job-token campaign
```

Remove an entry or clear only the current selection:

```bash
harbor-hf auth remove-job-token campaign
harbor-hf auth clear-job-token
```

`HARBOR_HF_JOB_TOKEN` remains the non-persistent automation override and takes
precedence over the selected entry.

## Runtime behavior

Harbor HF reads the selected value only while constructing the remote Job
secret input. The rendered command contains the secret name `HF_TOKEN`, not the
value. Harbor HF does not read the Hugging Face CLI token store, the active HF
login, or `hf auth token`.

A missing selection, missing store entry, malformed file, permission mismatch,
failed token verification, or non-fine-grained role stops submission. Harbor HF
does not migrate tokens from another store or fall back to another credential.

# Secrets

[README](../README.md) · [Configuration](configuration.md) · [Ingress](ingress.md) · [Caddy templates](caddy-templates.md) · [SSH deployment](ssh-deployment.md) · [Development](development.md)

Secrets are resolved on the CLI machine from one explicitly selected source. Never put tokens, passwords or account authentication in `deploy.yaml`, `environment`, assets or Docker build contexts.

- [Sources](#sources)
- [Where sources apply](#where-sources-apply)
- [1Password](#1password)
- [Verifying access](#verifying-access)
- [Names and dotenv format](#names-and-dotenv-format)
- [Using secrets in Compose](#using-secrets-in-compose)
- [SSH execution](#ssh-execution)
- [Recovery and lifecycle](#recovery-and-lifecycle)

## Sources

`secrets` accepts exactly one complete source.

A dotenv file on the CLI machine:

```yaml
env-file:
  path: ~/.config/compoza/sample-app.env
```

A 1Password Environment:

```yaml
1password:
  environmentId: fictional-atlas-environment-id
```

No secrets:

```yaml
none: {}
```

The source object selects exactly one extension by name: `secrets["1password"]`, `secrets["env-file"]`, or `secrets.none`. Settings belong inside that extension object. Unknown extensions, missing required settings, multiple selected extensions and mixed legacy/nested selectors are rejected.

Existing flat objects such as `{ provider: 1password, environmentId: … }` remain supported for migration. Both forms follow the same source replacement, local isolation, validation and dry-run rules.

Relative dotenv paths resolve against the deploy folder; `~/` expands to the operator's home folder. Both providers work with client and SSH execution.

## Where sources apply

- `secrets` is supported at app level, under a destination, and under `local`.
- A destination's `secrets` replaces the whole inherited source, including inherited legacy `envFile` and `remote.envFile` settings.
- Use `none: {}` to intentionally clear an inherited source.
- A production source requires an explicit `local.secrets` for `--local` runs, including `none` when local Compose needs no secrets.

### Legacy sources and aliases

| Setting           | Meaning                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `envFile`         | Legacy alias for the client-side `env-file` provider                                 |
| `remote.envFile`  | SSH execution only: a host-owned dotenv file, read on the host                       |
| `<stackDir>/.env` | SSH execution only: optional host-owned dotenv used when `remote.envFile` is omitted |

Select one source, never competing aliases: declaring `secrets` together with a legacy source at the same level is an error. Client-resolved dotenv is parsed locally; legacy host dotenv stays on the host.

## 1Password

The 1Password provider lazily loads the official optional `@1password/sdk` (pinned to 0.5.0) and calls `client.environments.getVariables(environmentId)` on the CLI machine.

- By default it imports **every** returned variable. Set `variables` to an allowlist of exact names to retain only the secrets this deployment needs. The SDK's `masked` flag is display metadata and does not exclude a value.
- It does not invoke the beta CLI environment export, install anything on the host, or require 1Password in application containers.
- A normal install includes the SDK. Dotenv, ordinary checks and dry runs also work when optional dependencies are omitted.

For example, share one Environment across applications while selecting only this API's key:

```yaml
secrets:
  1password:
    environmentId: fictional-atlas-environment-id
    variables:
      - PROMPTSUB_API_KEY
```

`variables` accepts environment identifiers, matched exactly and case-sensitively, with no wildcards or renaming. A missing requested variable fails the secret read before builds or host writes. An empty list imports nothing and skips the SDK read; omitting the field retains the existing import-all behavior. An existing variable with an empty value is still imported; applications can require a nonempty value in Compose with `${PROMPTSUB_API_KEY:?required}`.

The SDK still reads the complete Environment into CLI memory. Compoza discards excluded entries before validating deployment variables or producing commands and payloads, so excluded names and values are absent from the generated `.env`, SSH upload and secret-access report. This applies to client and SSH execution, named and legacy 1Password selections, destinations and explicit local sources. Other providers are unchanged. Ordinary nonsecret settings and image references are still written to `.env`.

### Authentication

**Interactive desktop:** enable the SDK integration in the 1Password app and set `COMPOZA_1PASSWORD_ACCOUNT` to the account selected in the desktop app:

```sh
export COMPOZA_1PASSWORD_ACCOUNT="Atlas Example"
```

Unlock the app and approve its request when prompted.

**Automation:** supply `OP_SERVICE_ACCOUNT_TOKEN` through the operator's protected environment and grant the service account access to the selected Environment. A nonempty service-account token takes precedence over desktop account selection.

Authentication variables are stripped from Docker, Buildx, SSH and Git child processes. See the [official Environment read guide](https://www.1password.dev/environments/read-environment-variables).

### Test coverage

SDK API and type behavior and mocked integrations are tested. A live 1Password Environment read has not been validated against a disposable account by this repository's test suite.

## Verifying access

Secrets are fetched once per real deployment, before builds or host mutation. The ordinary readiness report and every dry run fetch no secrets. To verify access explicitly, including before the first SSH deployment:

```sh
compoza check infra --destination atlas --secrets --json
compoza check infra --secrets --local --json
```

- Reports include status and variable names only, never values.
- Provider failures are reported generically; inspect authentication privately.
- The `--local` form checks only the explicit local source.
- These checks do not stage files or validate the full candidate Compose model.

## Names and dotenv format

Secret names must be valid environment identifiers and unique. Collisions with configured non-secret variables, image variables, Compose/Docker/Buildx controls and process-control variables fail instead of overriding them.

Dotenv files use simple `KEY=value` lines:

- Optional matching surrounding quotes are removed; there is no interpolation or escape processing.
- Literal dollars, quotes, backslashes and empty strings are preserved.
- Multiline, carriage-return and NUL values are rejected with safe diagnostics.
- Malformed-line errors report the line number without the original line.

## Using secrets in Compose

Provider variables supply Compose **interpolation** inputs. They are not injected into every container; each service must explicitly map the keys it needs:

```yaml
services:
  web:
    environment:
      API_TOKEN: '${API_TOKEN:?required}'
```

- With client execution, resolved values are added only to Compose, never to build or transport commands.
- Explicit sources, including `none`, disable Compose's implicit `.env` discovery, so missing keys cannot fall back to a production dotenv file.
- Secret-bearing Compose output is suppressed because third-party diagnostics can repeat values. Application logs still stream through `logs`, and redacting them is the application's responsibility.

## SSH execution

With a managed source (`env-file` or `1password`), the selected values travel over SSH stdin and are combined with generated nonsecret variables and image references in the stack `.env`, mode `0600`. Compose validates the staged files before replacing the flat stack. No resolved credentials enter `compose.yaml`, `.compoza.json`, process arguments or deployment logs; private validation diagnostics are discarded.

Upload or validation failure preserves the deployed `.env`. Later replacement, Compose or readiness failure may leave updated files or containers; recover by redeploying. No older credential copies or deployment backups are retained.

An explicit `remote.envFile` selects a separate live operator-owned host file. It cannot be the generated `<stackDir>/.env`; move an existing operator `.env` to a separate path before deploying into that folder. Host overlays remain live and are never overwritten. See [host layout](ssh-deployment.md#host-layout-and-ownership).

## Recovery and lifecycle

- `status`, `logs`, `stop`, `start` and `delete` read deployed host files without fetching 1Password or client dotenv.
- `deploy --tag <known-tag>` reuses older images with current local configuration and freshly resolves the selected source. It does not restore older passwords or archived configuration.
- Deploying `none` writes the generated `.env` without managed secret values; there is no fallback to an earlier source.
- Delete retains the stack `.env` and other files; remove sensitive files separately only when that cleanup is explicitly intended.

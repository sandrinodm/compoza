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
- [Rollback and lifecycle](#rollback-and-lifecycle)

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

- It imports **every** returned variable. The SDK's `masked` flag is display metadata and does not exclude a value.
- It does not invoke the beta CLI environment export, install anything on the host, or require 1Password in application containers.
- A normal install includes the SDK. Dotenv, ordinary checks and dry runs also work when optional dependencies are omitted.

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

With a managed source (`env-file` or `1password`):

1. The resolved source is uploaded over SSH stdin to a mode-0600 snapshot in the mode-0700 `<stackDir>/.secrets` directory, outside release bundles.
2. The candidate release is validated with that snapshot before any Compose mutation. Managed-source validation output is discarded.
3. Activation binds the successful release, its predecessor and the effective source in one immutable record behind `current`.

No values are stored in manifests or deployment logs. A failed fetch or validation leaves the active snapshot unchanged. Staged snapshots may remain, still private, after a failed candidate; `delete` retains them, and cleanup is deliberately manual. See [host layout](ssh-deployment.md#host-layout-and-ownership).

Legacy host dotenv (`remote.envFile` or `<stackDir>/.env`) remains live, operator-owned input, and host overlays remain live in every mode.

## Rollback and lifecycle

- `status`, `logs`, `stop`, `start`, `delete` and `rollback` use the active host source without contacting 1Password or reading client dotenv.
- Rollback combines the older configuration and images with the **currently active** source: the active managed snapshot or the live legacy host dotenv. It never selects an earlier password snapshot.
- Explicitly deploying `none`, or returning to legacy host dotenv, changes the effective source without falling back to a previous managed snapshot.
- Upgrading an older release resolves the configured source again; it does not infer credentials from an old wrapper or reuse its snapshot. See [Upgrading older SSH releases](ssh-deployment.md#upgrading-older-ssh-releases).

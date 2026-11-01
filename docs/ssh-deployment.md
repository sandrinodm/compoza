# SSH deployment

[README](../README.md) · [Configuration](configuration.md) · [Ingress](ingress.md) · [Caddy templates](caddy-templates.md) · [Secrets](secrets.md) · [Development](development.md)

With `execution: ssh`, compoza writes a flat stack folder and runs the host's own Compose CLI over SSH. Recover by deploying a known image tag with the current configuration. Client execution remains the default; see [Configuration](configuration.md#execution-and-transport) for how execution combines with image transport.

## Host prerequisites

The host must provide:

- SSH with key authentication
- Bash 3.2 or newer and jq 1.6 or newer
- Docker Engine access
- Docker Compose supporting `up --wait --wait-timeout` and `config --no-interpolate --no-env-resolution --no-path-resolution`
- `base64`, and curl for HTTP health checks
- Working BuildKit/Buildx for `remote-build`

The operator provisions a separate host dotenv file (when used), host overlays and Docker registry authentication. Managed secret providers supply values from the CLI machine for the private stack `.env`.

**What `check` verifies.** The read-only `check` command probes Docker access, Compose wait/config support, jq availability, the selected host paths, and optional curl/Buildx, without creating folders or changing builders. It does **not** enforce the minimum Bash/jq versions or exhaustively probe system utilities; provisioning must supply them.

**Accounts and environment.**

- The SSH account needs write access to the stack root and configured data directories. Rootless Linux needs no sudo.
- `$HOME`, Docker configuration and connection settings, and `XDG_RUNTIME_DIR` are preserved for rootless Linux and macOS.
- Noninteractive macOS sessions gain `/usr/local/bin` and `/opt/homebrew/bin` on `PATH`.
- Remote actions run under `bash -c` regardless of the login shell.

## Example: two destinations

This app deploys to `atlas` (a `registry` host with a shared Caddy, from the [hosts example](configuration.md#hosts)) or to `borealis`, which builds on the host:

```yaml
borealis:
  ssh: deploy@borealis.example.com
  address: 198.51.100.73
  platform: linux/amd64
  transport:
    mode: remote-build
```

`deploy.yaml`:

```yaml
name: sample-app
host: atlas
targets:
  - web
dockerfile: Dockerfile
context: ..
execution: ssh
composeFiles:
  - compose.yaml
assets:
  - config/nginx.conf
profiles:
  - web
environment:
  PUBLIC_TITLE: Sample app
remote:
  stackDir: /srv/stacks/sample-app
  envFile: /srv/secrets/sample-app.env
  overlayFile: /srv/stacks/sample-app/compose.host.yaml
  waitTimeoutSeconds: 180
ingress:
  caddy:
    domain: app.example.com
    upstream: sample-app-web:3000
destinations:
  atlas: {}
  borealis:
    host: borealis
    projectName: sample-app-dev
    composeFiles:
      - compose.yaml
      - compose.borealis.yaml
    profiles:
      - web
      - worker
    remote:
      stackDir: /home/deploy/stacks/sample-app
      envFile: /home/deploy/secrets/sample-app.env
      overlayFile: /home/deploy/stacks/sample-app/compose.host.yaml
      waitTimeoutSeconds: 180
    ingress:
      none: {}
    health:
      url: http://127.0.0.1:8080/healthz
      timeoutSeconds: 120
```

`compose.yaml`:

```yaml
services:
  web:
    image: ${WEB_IMAGE:?built image required}
    profiles: [web]
    volumes:
      - ./config/nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ${DATA_PATH:?absolute host data path required}:/data
    environment:
      API_TOKEN: ${API_TOKEN:?host secret required}
```

- The separate host-owned env file provides `DATA_PATH` as an **absolute host path**, and `API_TOKEN`.
- Host overlays add ports, networks or machine-specific absolute mounts: here the `atlas` overlay joins Caddy's external network, and the `borealis` overlay publishes `127.0.0.1:8080:3000`.
- `compose.borealis.yaml` supplies any worker service selected by that destination's profiles.
- `remote.envFile` and `remote.overlayFile` are absolute host paths; explicitly configured files must already exist.

```sh
compoza check infra --destination atlas --json
compoza deploy infra --destination atlas --dry-run
compoza deploy infra --destination atlas
compoza deploy infra --destination borealis --dry-run
compoza deploy infra --destination borealis
compoza logs infra --destination borealis --follow
```

## Health and readiness

- Application healthchecks belong in Compose. `up --wait` waits for healthy services, or running services when they have no healthcheck, bounded by `remote.waitTimeoutSeconds`.
- The independent `health.url` probe runs **on the host** over SSH, so loopback-only URLs need no client port forward. It accepts HTTP statuses below 500, like the public URL wait, within `health.timeoutSeconds`. Bodies and curl errors are discarded.
- Routing and any public URL wait also finish before deployment is reported successful.

## Host layout and ownership

A deployed stack contains:

```text
<stackDir>/
  compose.yaml        # selected Compose files merged without interpolation
  .env                # generated variables, image tags and selected managed secrets (0600)
  .compoza.json       # small nonsecret lifecycle metadata file (0600)
  config/nginx.conf   # explicitly declared assets retain their relative paths
  compose.host.yaml   # optional live operator-owned overlay
```

There are no release, activation, current/previous, backup or archived-secret directories. The transient `.deploy-lock` holds upload files and disappears when the operation exits. No runtime shell scripts or jq filters are installed in the stack.

`.compoza.json` records the deployed project, tag, profiles, declared files, owned file paths, host env/overlay paths, credential policy and ingress removal operation. Lifecycle commands use these settings rather than undeployed local edits. It contains no resolved credentials or previous deployment snapshots.

The CLI replaces only its own stack files. It refuses symlinked stack ancestors and outputs, invalid existing metadata, and preexisting files it does not own. An existing `.env` without lifecycle metadata is treated as operator data: move it to a separate host file and select that file with `remote.envFile`, or choose a fresh `stackDir`. Explicit host env/overlay paths must be separate from generated outputs.

Operator overlays, separate host env files, persistent data and undeclared files are retained. Assets removed from configuration are left in place, and their ownership is remembered so they can be declared again later. Retained assets must be declared again before use as relative file references or binds. The CLI does not prune operator storage. Existing directories from older deployment layouts are not removed or migrated automatically.

## Stack bundle and assets

The CLI uploads only the selected `composeFiles` and explicitly declared nonsecret regular-file `assets`. The total is bounded to 128 files and four MiB before base64 encoding. Source trees belong to BuildKit's dockerignore-aware transfer instead.

`composeFiles` may name explicit absolute workstation paths, allowing a central deployment YAML to use the app repository's own Compose files. They are read directly and staged under their basenames before normalization; merge order is preserved, and basename collisions with other sources or assets fail before upload. Symlinks and symlinked source ancestors are rejected. Assets remain deploy-relative, including relative file references from external Compose files; credentials and persistent mounts still use absolute host paths.

Bundle paths must be deploy-relative and contain no dot components or dotfiles. `.env`, `.compoza.json` and `.deploy-lock` are reserved. Symlinked local files and parent directories are rejected. The generated `compose.yaml` cannot also be an asset.

All relative file references resolve from the stack root, including when a selected source Compose file lives in a subdirectory. Relative config files and bind mounts must be declared assets; relative binds must be read-only. Persistent data mounts use absolute host paths. `include` and external `extends.file` are unsupported: select explicit Compose overlays instead.

Service `env_file` and `secrets.file` must use absolute host paths, with optional missing env files allowed only when `required: false`. Uploaded assets cannot be used as secret files. The root `.env` is protected input, not a bundled asset or bind-mounted file.

## Environment precedence

Compose runs with a clean shell environment, retaining only home, path and Docker connection settings. Arbitrary SSH-session values cannot override application settings.

1. An explicit `remote.envFile`, when present, supplies live host-owned values.
2. The private generated `.env` supplies configured `environment`, selected managed secrets and the image references for this deployment. These values override the separate host env file.

`secrets` and `remote.envFile` are alternative sources, as in client configuration validation. An explicit `secrets.none` writes no managed credentials. The CLI does not implicitly adopt an existing root `.env`. Managed values are encoded literally, never evaluated as shell code, and stay out of process arguments and lifecycle metadata.

## Validation and privacy

The host normalizes selected Compose files with `--no-interpolate --no-env-resolution --no-path-resolution`. This preserves variable expressions, raw service env-file declarations and relative asset paths. The operator overlay remains separate and live.

Before replacing the deployed files or running `up`, Compose validates the normalized file with the selected env and overlay. A private JSON model check rejects undeclared relative files, unsafe writable asset binds and relative secret/env paths. Resolved Compose configuration and third-party diagnostics are suppressed because they can contain secrets; no validation log is left in the stack.

Managed status projects only service/state/health/exit-code fields and redacts selected dotenv values. Requested application logs can still contain secrets; applications are responsible for their logging policy.

## Deploy transaction

1. Check host readiness and build/ship images when needed.
2. Acquire the per-stack `mkdir` lock and upload into its temporary folder.
3. Normalize and validate Compose, dotenv, asset references and the live host overlay.
4. Replace `compose.yaml`, `.env`, declared assets and lifecycle metadata in place.
5. Create configured persistent directories and run `up --detach --force-recreate --remove-orphans --no-build --wait`. Every deployment recreates services, including when reusing image tags, so file bind mounts see updated assets. This restarts containers even when their configuration is unchanged.
6. Apply the ingress route and run configured HTTP readiness checks.

Upload or validation failures leave deployed files unchanged. File replacement is in place, without backups or an atomic multi-file commit. An interruption during replacement can leave a mixed set of files; a Compose, route or health failure can leave changed containers or routes. Redeploy to recover. Database migrations are never reversed.

## Dry runs

`deploy --dry-run` shows the planned operations without writing host files, acquiring locks, building images or reading a credential provider. It cannot fully validate the candidate against the host env and overlay until a real deployment stages it.

## Recover with an image tag

```sh
compoza deploy infra --destination borealis --tag <known-image-tag> --dry-run
compoza deploy infra --destination borealis --tag <known-image-tag>
compoza status infra --destination borealis
```

`--tag` skips Git and builds and reuses available images. It uses the current local Compose/configuration and resolves the currently selected credential source again. There is no release rollback command or saved configuration history. Check out an earlier application revision yourself when its configuration is also required, and review migrations before redeploying.

## Lifecycle on SSH execution

`status`, `logs`, `stop`, `start` and `delete` use the deployed flat files and lifecycle metadata. They do not fetch credentials from a client provider or load local Compose changes. Mutations take the same stack lock as deployment; read-only inspection creates no host files.

Delete removes the deployed ingress route, containers and networks. It retains stack files, dotenv, overlays and data. Named volumes are removed only with `--volumes`.

For direct operator inspection on the host, use Docker Compose with `--project-name`, `--project-directory`, the deployed `compose.yaml`, `.env`, and any configured host env/overlay/profile flags. Never print resolved secret-bearing configuration into shared logs. CLI commands apply the stored flags and privacy rules automatically.

Normal SSH termination releases the stack lock. After power loss or SIGKILL, inspect `.deploy-lock/owner` and confirm no operation is active before removing only that stale lock. No deployment history needs cleanup.

## Third-party-only stacks

Use `targets: []` for stacks that run published images. Git, a Dockerfile, a build context and application-registry build authentication are unnecessary. Compose still pulls missing third-party images; the same stack validation and readiness rules apply. The [README quickstart](../README.md#quickstart) is a complete example.

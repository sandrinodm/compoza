# SSH deployment

[README](../README.md) · [Configuration](configuration.md) · [Ingress](ingress.md) · [Caddy templates](caddy-templates.md) · [Secrets](secrets.md) · [Development](development.md)

With `execution: ssh`, compoza uploads the selected Compose definitions as a versioned release and runs the host's own Compose CLI over SSH. Releases can be inspected, rolled back and recovered on the host. Client execution remains the default; see [Configuration](configuration.md#execution-and-transport) for how execution combines with image transport.

- [Host prerequisites](#host-prerequisites)
- [Example: two destinations](#example-two-destinations)
- [Health and readiness](#health-and-readiness)
- [Host layout and ownership](#host-layout-and-ownership)
- [Release bundle and assets](#release-bundle-and-assets)
- [Compose file rules](#compose-file-rules)
- [Environment precedence](#environment-precedence)
- [Validation and privacy](#validation-and-privacy)
- [Deploy transaction](#deploy-transaction)
- [Dry runs](#dry-runs)
- [Rollback](#rollback)
- [Lifecycle on SSH execution](#lifecycle-on-ssh-execution)
- [Direct recovery and locks](#direct-recovery-and-locks)
- [Upgrading older SSH releases](#upgrading-older-ssh-releases)
- [Third-party-only stacks](#third-party-only-stacks)

## Host prerequisites

The host must provide:

- SSH with key authentication
- Bash 3.2 or newer and jq 1.6 or newer
- Docker Engine access
- Docker Compose supporting `up --wait --wait-timeout` and `config --no-env-resolution --no-path-resolution`
- `base64`, and curl for HTTP health checks
- Working BuildKit/Buildx for `remote-build`

The operator provisions legacy host dotenv (when used), host overlays and Docker registry authentication. Managed secret providers instead supply a protected snapshot from the CLI machine.

**What `check` verifies.** The read-only `check` command probes Docker access, Compose wait/config support, jq availability, the selected host paths, and optional curl/Buildx, without creating folders or changing builders. It does **not** enforce the minimum Bash/jq versions or exhaustively probe system utilities; provisioning must supply them.

Before Compose mutation, the runtime verifies atomic symlink replacement using the platform's `mv` option in a disposable locked directory.

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
  envFile: /srv/stacks/sample-app/.env
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
      envFile: /home/deploy/stacks/sample-app/.env
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

- The host-owned `.env` provides `DATA_PATH` as an **absolute host path**, and `API_TOKEN`.
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
- For `caddy`, routing and the public URL wait also finish before the release is promoted.

## Host layout and ownership

| Path                                             | Owner and lifetime                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `<stackDir>/.secrets/<id>.env`                   | Tool-owned protected managed snapshot, outside releases; retained until explicit manual cleanup |
| `<stackDir>/.env`                                | Host operator; used in legacy mode when `remote.envFile` is omitted                             |
| `remote.envFile` / `remote.overlayFile`          | Absolute host paths; explicitly configured files must already exist                             |
| `<stackDir>/releases/<id>/`                      | Tool-owned versioned Compose, declared assets, nonsecret env, manifest and recovery scripts     |
| `<stackDir>/.activations/<id>/`                  | Immutable record binding successful release, predecessor and effective secret source            |
| `<stackDir>/current`                             | Sole atomic state pointer, linking an activation record under the stack lock                    |
| `<stackDir>/current/previous`                    | Predecessor release frozen into the current activation                                          |
| `<stackDir>/previous`                            | Convenience alias to `current/previous`; tools read the immutable activation directly           |
| `<stackDir>/.deploy-lock/owner`                  | Portable per-stack mutation lock, with host and PID information                                 |
| Absolute data mounts / `directories` / `content` | Persistent host storage; not managed as release assets                                          |

Managed snapshots are mode 0600 inside the mode-0700 `.secrets` directory. Release and activation-record cleanup is deliberately manual; never remove records or releases still referenced by `current` or its predecessor.

## Release bundle and assets

The bundle contains only `composeFiles` and explicitly listed `assets`:

- At most 128 regular files and 4 MiB total.
- Deploy-relative file paths without a leading `./`, dot components, hidden files or symlinks.
- Directories must be listed file by file.
- Tool-owned names are reserved, including `compose.sh`, `compose.json`, `runtime.sh`, `model.jq`, `status.jq`, `release.env` and `manifest.json`. They cannot be supplied as app assets or used as asset directories.

No upload uses a broad `rsync --delete`.

Each release freezes its `runtime.sh`, `model.jq`, `status.jq` and `compose.json` alongside its recovery wrapper. `compose.json` contains non-secret Compose arguments and image assignments; resolved secrets stay outside the release. New releases require no Python.

## Compose file rules

- All relative Compose asset references resolve from the release root (`--project-directory`), even when a selected Compose file lives in a subdirectory.
- Relative bind mounts are allowed only for declared **read-only files**. Persistent or writable mounts must be absolute host paths. Runtime validation also catches relative data paths supplied through host dotenv, including `../data` and default expressions.
- Use explicit selected overlays rather than `include` or external-file `extends`; this prevents recursive implicit file and dotenv loading.
- Non-secret `configs.file` can name declared assets or absolute host files.
- `secrets.file` and service `env_file` must name absolute host files outside releases.
- Optional service env files with `required: false` may be absent; a present file must still be readable, and relative paths remain forbidden.
- Put secrets in host files or a [secret source](secrets.md), never in `assets`, `environment` or a build context.

## Environment precedence

The recovery wrapper starts Compose with a clean environment, retaining only home, path and Docker connection settings.

1. The selected host secret source is passed first.
2. Generated nonsecret variables override it.
3. Exported reserved `<TARGET>_IMAGE` references override both.

The host overlay is applied after the selected versioned Compose files.

Configured `environment` values are single-line strings; dollar signs, quotes and backslashes remain literal. Keys controlling Docker or Compose, home or path, and generated image variables are rejected, as are targets that collide after image-variable normalization. Secret source rules are in [Secrets](secrets.md).

## Validation and privacy

- Compose's resolved model is parsed privately with jq, and its filesystem references are checked by the host Bash runtime.
- Neither the model nor candidate validation errors are printed, even with `--log-level debug`.
- Managed-source validation diagnostics are discarded.
- Legacy-source diagnostics remain in `<release>/validation.log` with restrictive permissions. Inspect them on the host and never paste them into chat or shared logs.
- Inspection, lifecycle actions and the recovery dispatcher silently prevalidate configuration.
- Managed lifecycle output is suppressed. Managed `status` prints only service, state, health and exit code, omitting commands, images and container names.
- Inspection performs no host writes or locks.
- Application container logs stream when requested; redacting them remains the application's responsibility.

## Deploy transaction

1. Build or transfer images according to the host's transport.
2. Take the per-stack lock and stage a fresh release.
3. Validate the candidate with the host env and overlay.
4. Create requested data directories.
5. Run `up --no-build --wait` with a bounded timeout.
6. Finish routing and HTTP readiness.
7. Promote: create an immutable activation containing the release and its predecessor, then atomically replace only `current`.

A failure or interrupted upload leaves `current` pointing at the previous successful release. An interruption at the commit leaves either the old or the new complete pair, never a mixed rollback history.

> [!WARNING]
> A failed Compose operation **can partially change containers**, and a route or health failure can leave candidate containers or the route active. This is not an atomic container or database rollback. Inspect `status` and `logs`, then recover explicitly. Data migrations are never reversed.

## Dry runs

A dry run performs read-only readiness probes and local bundle validation, then prints the planned transport and host transaction. It performs **no builds, locks, uploads, directory creation or Compose mutations**.

The candidate Compose configuration cannot be fully validated with the production env and overlay until it has been staged, so a successful dry run is not proof that the candidate will deploy.

## Rollback

```sh
compoza rollback infra --destination borealis --dry-run      # preview without a host lock or writes
compoza rollback infra --destination borealis                # restore the previous successful release
compoza rollback infra --destination borealis --release <id>
compoza deploy infra --destination borealis --tag <tag>      # current LOCAL config, existing image tag
```

- `rollback` restores a supported version-2 release's Compose files, profiles, project, configured variables and image references.
- The default predecessor is selected under the stack lock, so a concurrent deployment cannot make the selection stale.
- Explicitly selecting the current successful release reapplies validation, Compose, routing and health to recover partially changed containers, while preserving its existing predecessor and activation history.
- Rollback keeps the currently active managed snapshot or live legacy host dotenv; it never selects an earlier password snapshot. The host overlay remains a live operator-owned file.
- Images must still be available locally or in their registry.
- `deploy --tag` keeps its image-reuse meaning and skips Git and builds. It uses the current local configuration and does **not** restore an earlier Compose release.
- Release IDs are printed by `deploy`; manifests remain under `releases/<id>/manifest.json` on the host.

## Lifecycle on SSH execution

`status`, `logs`, `stop`, `start` and `delete` use the host's current recovery wrapper, ignoring undeployed local Compose edits.

`delete` removes the deployed route, containers and networks. It keeps release and activation records, host secrets, bind data and images. Named volumes are removed only with `--volumes`.

## Direct recovery and locks

The current release's wrapper can be run directly on the host:

```sh
ssh deploy@borealis.example.com 'bash /home/deploy/stacks/sample-app/current/compose.sh ps --all'
ssh deploy@borealis.example.com 'bash /home/deploy/stacks/sample-app/current/compose.sh up --detach --no-build --wait --wait-timeout 180'
```

- Direct recovery **bypasses the tool's lock and promotion**. First ensure no tool deployment is running.
- Normal SSH termination releases the lock. A power loss or SIGKILL can leave a stale `.deploy-lock`: inspect its `owner`, confirm that no deployment is active, then remove only that lock directory.
- Legacy direct `current -> releases/<id>` state remains readable and migrates on the next successful promotion. Once activation records exist, the convenience `previous` alias is not used to select rollback.
- Archived wrappers keep their original runtime requirements and should not be invoked directly.

## Upgrading older SSH releases

Version 2 refers to the **host release format**, independently of the CLI package version. The current Bash/jq runtime executes only version-2 release wrappers. The CLI can read older activation metadata to perform a fresh deployment, but it does not parse or execute old shell wrappers: `status`, `logs`, lifecycle commands and `rollback` reject unsupported wrappers before running Compose.

1. Provision Bash 3.2+, jq 1.6+ and the other [host prerequisites](#host-prerequisites).
2. Confirm the selected destination and secret source in the local configuration. The upgrade resolves that source again; it does not infer credentials from an old wrapper or automatically reuse its snapshot.
3. Preview, deploy and verify the desired application revision:

   ```sh
   compoza check infra --destination borealis --json
   compoza deploy infra --destination borealis --dry-run
   compoza deploy infra --destination borealis
   compoza status infra --destination borealis
   ```

The first upgraded release can still have a version-1 predecessor, which default rollback refuses. Redeploy the desired revision as a new version-2 release to make it a rollback target; later version-2 releases can roll back to one another. `deploy --tag <tag>` does not convert an archived release or recover its old Compose files. Old files and snapshots remain on the host.

## Third-party-only stacks

Use `targets: []` for stacks that only run published images. There is no Git, Dockerfile or build-context requirement, and no build or application-registry authentication check. Compose still pulls missing third-party images, and the same release and health rules apply. The [README quickstart](../README.md#quickstart) is a complete example.

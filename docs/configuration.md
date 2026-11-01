# Configuration reference

[README](../README.md) · [Ingress](ingress.md) · [Caddy templates](caddy-templates.md) · [Secrets](secrets.md) · [SSH deployment](ssh-deployment.md) · [Development](development.md)

compoza reads two kinds of files: global and repository-local `hosts.yaml` files describing Docker hosts, and a `deploy.yaml` in each app repository. The hosts, accounts, paths and domains below are fictional, and IP addresses use reserved documentation ranges. Replace them with your own configuration.

- [Hosts](#hosts)
- [Apps](#apps)
- [Destinations](#destinations)
- [Execution and transport](#execution-and-transport)
- [Client execution](#client-execution)
- [Checks](#checks)
- [Lifecycle](#lifecycle)
- [Ingress providers and setup](ingress.md)
- [Caddy templates](caddy-templates.md)
- [Publishing content](#publishing-content)

Configuration uses a single YAML 1.2 document. Duplicate keys, unknown fields and unsupported tags are rejected. Quote values that must remain strings, such as `environment: { PORT: "8080" }`; unquoted numbers and booleans retain their YAML types. App discovery prefers `deploy.yaml` and accepts `deploy.yml` when it is absent. Explicit app paths, `--hosts`, `COMPOZA_HOSTS` and `$ref` values select the exact file given.

## Hosts

Global hosts live in `~/.config/compoza/hosts.yaml`. A `hosts.yaml` in the **current working directory** overrides global entries with the same host name and adds new ones. Each local entry replaces the entire global host configuration; fields are not merged. Either file may be absent. Run from the repository root to use its hosts file, including when targeting a nested app such as `compoza deploy infra`. There is no parent-directory search, and the app folder does not change host discovery.

An explicit `--hosts <file>` selects only that file. Otherwise, `COMPOZA_HOSTS` selects only its file. Both bypass automatic local/global loading; a missing explicit file is an error. Malformed files and invalid host settings fail validation rather than falling back to another host.

```yaml
atlas:
  ssh: deploy@atlas.example.com
  platform: linux/arm64
  transport:
    mode: registry
    registry: registry.example.com
  ingress:
    caddy:
      address: 192.0.2.42
      dir: /srv/proxy
      container: caddy
      service: caddy
      network: edge_network
      tls: dns cloudflare {env.CLOUDFLARE_API_TOKEN}
      logSnippet: request_log
cedar:
  ssh: deploy@cedar.example.com
  platform: linux/amd64
  transport:
    mode: ssh-load
borealis:
  ssh: deploy@borealis.example.com
  platform: linux/amd64
  transport:
    mode: remote-build
```

| Field       | Description                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `ssh`       | SSH destination. The Docker endpoint is `ssh://<ssh>`. Key authentication is required (`BatchMode`). |
| `platform`  | Platform each target is built for, such as `linux/arm64`.                                            |
| `transport` | How images reach the host; see [Image transports](#image-transports).                                |
| `ingress`   | Exactly one named extension and its host settings; see [Ingress](ingress.md).                        |

### External host files

Both global and local hosts files can reference a separate YAML file for each host:

```yaml
atlas:
  $ref: ~/infrastructure/atlas.yaml
cedar:
  $ref: ./hosts/cedar.yaml
```

Each referenced file contains **one complete host configuration**, without the outer host-name key. For example, `~/infrastructure/atlas.yaml`:

```yaml
ssh: deploy@atlas.example.com
platform: linux/amd64
transport:
  mode: ssh-load
ingress:
  caddy:
    address: 192.0.2.42
    dir: /srv/caddy
    container: caddy
    network: edge
```

References accept absolute paths, `~/` paths, and paths relative to the containing hosts file. They read local files on the CLI machine; remote infrastructure paths such as `ingress.caddy.dir` still refer to the remote host. Caddy template paths are local to the CLI machine and resolve relative to the declaring YAML file; see [template sources](caddy-templates.md#select-template-sources). Inline hosts and references can coexist in the same hosts file. A reference cannot include host fields or point to another reference. Missing or invalid referenced files fail validation. References are resolved after local overrides, so a superseded global reference is not read.

### Image transports

| `transport.mode` | Build and delivery                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `registry`       | Builds with `--push` to `transport.registry`; Compose pulls. The host needs a stored `docker login`.         |
| `ssh-load`       | Builds with `--load` and pipes `docker save` through `ssh` into `docker load`.                               |
| `remote-build`   | Builds with the host daemon's default BuildKit builder, so the image loads there. Requires `execution: ssh`. |

`remote-build` explicitly selects both `docker --host ssh://…` and `buildx --builder default --load`, so an unrelated selected client builder or Docker context cannot redirect it. BuildKit transfers only the needed build context and respects `.dockerignore`; no source-tree rsync is needed. The host needs working BuildKit/Buildx.

With every transport, exclude production dotenv files and other secrets from build contexts with `.dockerignore`.

## Apps

An app opts in with a folder holding `deploy.yaml`, its Dockerfile and its Compose files, for example `infra/` or `apps/<app>/deploy/`. This example uses the default client execution with two built targets and Caddy routing:

```yaml
name: sample-app
host: atlas
dockerfile: Dockerfile
targets:
  - worker
  - web
composeFiles:
  - compose.yaml
  - compose.production.yaml
ingress:
  caddy:
    domain: app.example.com
    upstream: sample-app-web:3000
directories:
  - /srv/sample-app/data
  - /srv/sample-app/pgdata
environment:
  SAMPLE_APP_DATA_PATH: /srv/sample-app/data
secrets:
  env-file:
    path: ~/.config/compoza/sample-app.env
local:
  composeFiles:
    - compose.yaml
  environment: {}
  secrets:
    none: {}
```

| Field                   | Description                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                  | Compose project name and image prefix.                                                                                                |
| `host`                  | Host key in `hosts.yaml`.                                                                                                             |
| `targets`               | Images to build from the Dockerfile, one per target. Use `[]` for third-party-only stacks.                                            |
| `dockerfile`, `context` | Relative to the deploy folder. Default to `Dockerfile` beside `deploy.yaml` and the Git root.                                         |
| `composeFiles`          | Compose files to apply, in order.                                                                                                     |
| `profiles`              | Compose profiles to enable.                                                                                                           |
| `execution`             | `client` (default) or `ssh`; see [Execution and transport](#execution-and-transport).                                                 |
| `ingress`               | `caddy`, `cloudflare-tunnel` or `none` (default); see [Ingress](#ingress).                                                            |
| `health`                | SSH execution: optional `url` and `timeoutSeconds`, probed on the host; see [SSH deployment](ssh-deployment.md#health-and-readiness). |
| `directories`           | Absolute host folders created before Compose runs.                                                                                    |
| `content`               | Absolute host folders for content sections, created before Compose runs; see [Publishing content](#publishing-content).               |
| `environment`           | Non-secret variables passed to Compose.                                                                                               |
| `secrets`               | Exactly one secret source; see [Secrets](secrets.md). Legacy `envFile` remains an alias for the dotenv provider.                      |
| `local`                 | Overrides for `--local` runs; see [Local runs](#local-runs).                                                                          |
| `assets`                | SSH execution only: declared read-only files uploaded to the stack.                                                                   |
| `remote`                | SSH execution only: `stackDir`, `envFile`, `overlayFile`, `waitTimeoutSeconds`.                                                       |
| `destinations`          | Named alternative deployments of the same app; see [Destinations](#destinations).                                                     |

SSH-specific fields are described in [SSH deployment](ssh-deployment.md).

### Images and tags

- Each target is named `<name>-<target>:<tag>`, prefixed with the registry for registry transport, and handed to Compose as `<TARGET>_IMAGE`. Compose files read `${WEB_IMAGE}`, `${WORKER_IMAGE}` and so on.
- A deploy requires a clean checkout with at least one commit and tags images with the commit's first twelve characters. `--allow-dirty` permits a dirty checkout and tags `<commit>-dirty`.
- `--tag <tag>` reuses images built earlier and skips Git and builds, so it works from a deploy folder that is no longer inside a checkout. It always uses the **current local configuration**; there is no saved Compose configuration history.
- With `targets: []` there is no Git, Dockerfile or build-context requirement, and no build or application-registry authentication check. Compose still pulls missing third-party images.

### Ingress

Host `ingress` settings describe shared infrastructure; app `ingress` settings describe a route. Select one extension per block: `caddy`, `cloudflare-tunnel`, or `none: {}`. Destinations replace the complete ingress selection.

See the [Ingress guide](ingress.md) for provider selection, host and app settings, setup commands, migration, and lifecycle behavior. For custom Caddyfiles and site blocks, see [Caddy templates](caddy-templates.md).

### Host folders and mounts

Compose resolves relative bind mounts on the host, so host paths must be absolute. With client execution, configuration files belong in images, not mounts. SSH execution additionally supports declared read-only [assets](ssh-deployment.md#stack-bundle-and-assets).

### Local runs

`local` overrides `composeFiles`, `environment` and the complete secret source for `--local` runs. When the app declares a production secret source, an explicit `local.secrets` is required, including `none: {}` when local Compose needs no secrets.

`--local` builds into this machine's Docker and starts the stack here, without remote readiness checks, transport or routes. It keeps this client build-and-run behavior regardless of `execution`.

## Destinations

One `deploy.yaml` can deploy to several hosts or projects. Select one with `--destination <name>`, which every app command accepts, including `check`, `logs`, lifecycle commands and `publish`. Without the flag the default destination is used.

```yaml
name: sample-app
host: atlas
targets:
  - web
composeFiles:
  - compose.yaml
environment:
  PUBLIC_TITLE: Sample app
destinations:
  atlas: {}
  cedar:
    host: cedar
    projectName: sample-app-dev
    composeFiles:
      - compose.yaml
      - compose.cedar.yaml
    ingress:
      none: {}
```

- When supplied, a destination **replaces** `host`, `projectName`, `composeFiles`, `execution`, the entire `remote` object, `profiles`, `ingress`, `health`, `directories`, `content` and the complete `secrets` source.
- A destination's `environment` **merges** over the app defaults.
- `name` remains the image prefix; `projectName` selects the Compose project and the Caddy site-file key.
- Unknown destination names fail.

A complete two-host SSH example is in [SSH deployment](ssh-deployment.md#example-two-destinations).

## Execution and transport

Execution and image transport are independent:

| Execution          | Transport               | Build and delivery                                        | Compose                                |
| ------------------ | ----------------------- | --------------------------------------------------------- | -------------------------------------- |
| `client` (default) | `registry` / `ssh-load` | Client build and push or load                             | Client `docker --host ssh://… compose` |
| `ssh`              | `registry`              | Client Buildx builds and pushes; host pulls               | Host `docker compose`                  |
| `ssh`              | `ssh-load`              | Client builds and loads; `docker save` over SSH into host | Host `docker compose`                  |
| `ssh`              | `remote-build`          | Host daemon's default BuildKit builder; image loads there | Host `docker compose`                  |

`remote-build` requires SSH execution. `--local` keeps the client build-and-run behavior in every mode. SSH execution updates a flat stack folder, described in [SSH deployment](ssh-deployment.md).

## Client execution

Client execution is the default and backward-compatible mode. A `deploy`:

1. Resolves the image tag from Git, or uses `--tag`.
2. Runs the readiness checks and stops if DNS, the proxy, the network or the registry login is not ready.
3. Creates the host folders.
4. Builds each target for the host's platform and ships it by the host's transport.
5. Runs `docker --host ssh://<host> compose up --detach --remove-orphans --no-build`, with `--pull always` for a `registry` host and `--pull missing` for `ssh-load` hosts and `--local`. For `ssh-load` and local runs, already-loaded images are reused while missing third-party images such as `postgres` are fetched. The explicit `--host` overrides any active Docker context, so a `DOCKER_CONTEXT` on this machine never redirects a deploy.
6. For `caddy`, atomically replaces the site file under a shared proxy lock and uses Caddy reload to validate and activate it; a rejected reload restores the file and attempts a recovery reload. Long-lived connections depend on the configured drain and streaming policy. Then waits up to three minutes for the URL to answer.

`--dry-run` prints every command (secrets masked) and the site file without running anything that changes state; the checks still run.

With client execution, `status`, `logs`, `stop`, `start` and `delete` address the running project by name (`docker --host ssh://<host> compose --project-name <name>`), without Compose files. Compose finds the containers by their project label, so these commands need neither the files nor the secrets their variables come from.

## Checks

```sh
compoza check infra --json
compoza check infra --destination atlas --secrets --json
compoza check infra --secrets --local --json
```

- `check` is read-only and fetches no secrets.
- `--secrets` explicitly resolves the selected secret source and reports status and variable names only.
- `--secrets --local` checks only the local source and skips remote readiness. `--local` alone neither resolves secrets nor checks local Docker.
- A valid hosts configuration is still needed to resolve the app.

For SSH execution, `check` also probes host capabilities; see [SSH deployment](ssh-deployment.md#host-prerequisites). Secret checks are described in [Secrets](secrets.md#verifying-access).

## Lifecycle

An app on a host is deployed, stopped or deleted, and one command moves it to each state:

| Command  | What changes on the host                                                                        |
| -------- | ----------------------------------------------------------------------------------------------- |
| `deploy` | Images, containers, networks and the Caddy route are created or replaced; host folders are made |
| `stop`   | The containers halt; networks, volumes, images, route and data stay, so `start` restores them   |
| `start`  | The stopped containers resume                                                                   |
| `delete` | The route is removed first, then the containers and networks (`down --remove-orphans`)          |

- `delete` never touches the `directories` and `content` folders: they are the data, and a later `deploy` finds it again.
- `--volumes` also removes the project's named Compose volumes.
- For a `caddy` app the route is removed before the containers so the domain stops being served cleanly. A Caddy reload validates and activates the configuration without the file; a failed reload restores the file and attempts a recovery reload.
- `delete` is also available as `down`.
- `stop`, `start` and `delete` take `--dry-run`, which prints the commands and scripts without running them.

With SSH execution these commands use the host's deployed stack instead; see [SSH deployment](ssh-deployment.md#lifecycle-on-ssh-execution).

## Publishing content

`publish` mirrors a local folder into one of the app's `content` sections on the host using rsync. Add a section to `deploy.yaml`:

```yaml
content:
  public: /home/deploy/content/sample-app/public
```

Then preview and publish:

```sh
compoza publish infra public ./public --dry-run
compoza publish infra public ./public
compoza publish infra public ./public --destination cedar
```

Publishing deletes destination files absent from the source. Review `*deleting` entries in the dry run. Dotfiles and `node_modules` are excluded.

The folder argument is required for `publish` because two more arguments follow it. Content folders are persistent host storage: they are not stack assets, and `delete` leaves them in place.

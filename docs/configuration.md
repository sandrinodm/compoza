# Configuration reference

[README](../README.md) · [Commands](commands.md) · [Ingress](ingress.md) · [Caddy templates](caddy-templates.md) · [Secrets](secrets.md) · [SSH deployment](ssh-deployment.md) · [Development](development.md)

compoza reads three kinds of files: global, linked and repository-local `hosts.yaml` files describing Docker hosts, a `deploy.yaml` for each app, and an optional settings file holding your own defaults. The hosts, accounts, paths and domains below are fictional, and IP addresses use reserved documentation ranges. Replace them with your own configuration.

- [Hosts](#hosts)
  - [External host files](#external-host-files)
  - [Linked hosts files](#linked-hosts-files)
- [Settings](#settings)
- [Apps](#apps)
  - [Roles](#roles)
  - [Images and tags](#images-and-tags)
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

Hosts files shared from another location, such as an infrastructure repository, can be linked with `compoza hosts link` and are then read together with the global file; see [Linked hosts files](#linked-hosts-files). The complete lookup order is:

1. `--hosts <file>`, else `COMPOZA_HOSTS`: only that file. Nothing else is read.
2. Otherwise `~/.config/compoza/hosts.yaml` and every linked hosts file. These are peers: a host name may appear in only one of them.
3. Then `./hosts.yaml` in the current working directory, whose entries replace any of the above by name.

`compoza hosts list` prints the hosts a run would use and the file each one comes from.

An explicit `--hosts <file>` selects only that file. Otherwise, `COMPOZA_HOSTS` selects only its file. Both bypass automatic local, global and linked loading; a missing explicit file is an error. Malformed files and invalid host settings fail validation rather than falling back to another host.

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

| Field       | Description                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `ssh`       | SSH destination. The Docker endpoint is `ssh://<ssh>`. Key authentication is required (`BatchMode`).    |
| `platform`  | Platform each target is built for, such as `linux/arm64`.                                               |
| `transport` | How images reach the host; see [Image transports](#image-transports).                                   |
| `ingress`   | One or both named providers (`caddy`, `cloudflare-tunnel`), or `none` alone; see [Ingress](ingress.md). |

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

### Linked hosts files

`compoza hosts link <path>` adds a hosts file, or a folder holding a `hosts.yaml`, to the files every run reads alongside the global hosts file. Use it for hosts kept in a shared infrastructure repository:

```sh
compoza hosts link ~/infrastructure          # reads ~/infrastructure/hosts.yaml
compoza hosts list                           # each host and the file defining it
compoza hosts unlink ~/infrastructure
```

Links are stored as absolute paths in the [settings file](#settings), in the order they were added:

```yaml
hosts:
  links:
    - /Users/you/infrastructure
```

A linked file uses the global hosts file format, and its `$ref` paths resolve relative to the linked file. The global file and the linked files must not define the same host name; a clash fails the run with both file paths, and `hosts link` refuses a link that would cause one. A `hosts.yaml` in the current working directory still overrides any of them. A link whose file or folder disappears fails every run until it is restored or unlinked; `hosts unlink` works even when the target is gone. `--hosts` and `COMPOZA_HOSTS` ignore links. Linking the same path twice changes nothing, and links are read on the CLI machine only. See [`hosts`](commands.md#hosts) for the command reference.

### Image transports

| `transport.mode` | Build and delivery                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `registry`       | Builds with `--push` to `transport.registry`; Compose pulls. The host needs a stored `docker login`.         |
| `ssh-load`       | Builds with `--load` and pipes `docker save` through `ssh` into `docker load`.                               |
| `remote-build`   | Builds with the host daemon's default BuildKit builder, so the image loads there. Requires `execution: ssh`. |

`remote-build` explicitly selects both `docker --host ssh://…` and `buildx --builder default --load`, so an unrelated selected client builder or Docker context cannot redirect it. BuildKit transfers only the needed build context and respects `.dockerignore`; no source-tree rsync is needed. The host needs working BuildKit/Buildx.

With every transport, exclude production dotenv files and other secrets from build contexts with `.dockerignore`.

## Settings

Your own defaults live in `~/.config/compoza/config.yaml`, beside the global hosts file. They apply to every app you deploy from this machine and never belong in a repository. The file is optional; compoza creates it the first time a command saves a setting.

```yaml
1password:
  account: Atlas Example # the desktop account for 1Password Environment reads
hosts:
  links: # hosts files, or folders holding a hosts.yaml
    - /Users/you/infrastructure
```

| Field               | Set with                                         | Meaning                                                                                                                                                                               |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1password.account` | `compoza config set 1password.account <account>` | The 1Password desktop account, by name or UUID, used when neither `OP_SERVICE_ACCOUNT_TOKEN` nor `COMPOZA_1PASSWORD_ACCOUNT` is set. See [Authentication](secrets.md#authentication). |
| `hosts.links`       | `compoza hosts link <path>`                      | Absolute paths of linked hosts files or folders. See [Linked hosts files](#linked-hosts-files).                                                                                       |

Prefer the commands to editing the file by hand: they validate the result before writing, and keep your comments and the order of the other settings. Hand edits are allowed and follow the same rules as every configuration file, so an unknown field, an empty value or invalid YAML is an error. Because the hosts links are read whenever compoza looks up hosts without `--hosts` or `COMPOZA_HOSTS`, an invalid settings file stops those runs until it is fixed. Nothing in the file is secret: a 1Password account is a name or UUID, and the desktop app keeps the credentials.

## Apps

An app opts in with a folder holding `deploy.yaml` and its Compose files. Its source and Dockerfile can live there or in a separate `workingDirectory`. A typical deployment folder is `infra/` or `apps/<app>/deploy/`. This example uses the default client execution with two built services and Caddy routing:

```yaml
name: sample-app
host: atlas
dockerfile: Dockerfile
roles:
  web:
    build:
      target: web
  worker:
    build:
      target: worker
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

| Field                   | Description                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                  | Compose project name and image prefix.                                                                                                        |
| `host`                  | Host key in `hosts.yaml`.                                                                                                                     |
| `roles`                 | Per Compose service: what to build, and the container environment and secrets it gets; see [Roles](#roles). Omit for third-party-only stacks. |
| `workingDirectory`      | Default source directory for Git and builds; defaults to the deploy folder. Accepts absolute, `~/`, or config-relative paths.                 |
| `dockerfile`, `context` | Defaults for every role with `build`. Relative to `workingDirectory`; default to `Dockerfile` there and the source Git root.                  |
| `composeFiles`          | Compose files to apply, in order; relative to the YAML folder or explicit absolute source paths.                                              |
| `profiles`              | Compose profiles to enable.                                                                                                                   |
| `execution`             | `client` (default) or `ssh`; see [Execution and transport](#execution-and-transport).                                                         |
| `ingress`               | `caddy`, `cloudflare-tunnel` or `none` (default); see [Ingress](#ingress).                                                                    |
| `health`                | SSH execution: optional `url` and `timeoutSeconds`, probed on the host; see [SSH deployment](ssh-deployment.md#health-and-readiness).         |
| `directories`           | Absolute host folders created before Compose runs.                                                                                            |
| `content`               | Absolute host folders for content sections, created before Compose runs; see [Publishing content](#publishing-content).                       |
| `environment`           | Non-secret variables passed to Compose for interpolation.                                                                                     |
| `secrets`               | Exactly one secret source: `env-file`, `1password` or `none`; see [Secrets](secrets.md). Provides Compose interpolation and role secrets.     |
| `local`                 | Overrides for `--local` runs; see [Local runs](#local-runs).                                                                                  |
| `assets`                | SSH execution only: declared read-only files uploaded to the stack.                                                                           |
| `remote`                | SSH execution only: `stackDir`, `overlayFile`, `waitTimeoutSeconds`.                                                                          |
| `destinations`          | Named alternative deployments of the same app; see [Destinations](#destinations).                                                             |

SSH-specific fields are described in [SSH deployment](ssh-deployment.md).

### Separate source and deployment folders

Keep deployment configuration centrally while building from an application repository:

```text
Repositories/
├── foo/
│   └── Dockerfile
└── deployments/foo/
    ├── deploy.yaml
    ├── compose.yaml
    └── app.env
```

```yaml
# Repositories/deployments/foo/deploy.yaml
name: foo
host: atlas
workingDirectory: ../../foo
roles:
  web:
    build:
      target: web
composeFiles: [compose.yaml]
secrets:
  env-file:
    path: ./app.env
```

Git checks and image tags use the repository containing a role's working directory (here the top-level `workingDirectory`). Build commands run there; relative `dockerfile` and `context` paths resolve there, and the default context remains that repository's root. Absolute build paths remain absolute. `workingDirectory` itself resolves relative to the selected YAML file, including an explicitly named file such as `production.yaml`; it also accepts absolute paths and `~/`.

Relative Compose files and the project directory, assets, dotenv paths and app templates use the deployment YAML folder. Host paths still refer to the remote host. Host inventory discovery continues to use the CLI's current working directory, independently of both folders.

All destinations share `workingDirectory` and the roles' `build` settings; they cannot be overridden per destination. A real build requires the working directories to exist. `--tag`, stacks without a `build`, status, logs and lifecycle commands do not require the source checkout.

To use the app repository's Compose files directly, select their absolute workstation paths:

```yaml
# Source paths on the machine running Compoza.
workingDirectory: /home/operator/Repositories/foo
dockerfile: /home/operator/Repositories/foo/docker/Dockerfile
context: /home/operator/Repositories/foo
composeFiles:
  - /home/operator/Repositories/foo/compose.yaml
  - /home/operator/Repositories/foo/compose.production.yaml
```

SSH execution reads those files for each deployment and stages them under their basenames, then merges them in the listed order into the host's flat `compose.yaml`. Selected files must have distinct upload paths: two external files named `compose.yaml`, or an external filename colliding with a relative Compose file or asset, are rejected. Source symlinks, symlinked ancestors and dot traversal are rejected. Assets and any relative file references inside Compose still belong beside `deploy.yaml`; absolute Compose paths do not change that base. Keep persistent data and secret file references as absolute **host** paths. Lifecycle operations use the already deployed stack and do not need the source files.

### Roles

A role configures one Compose service: the image compoza builds for it, and the environment variables and secrets its container receives. The top-level `environment` and `secrets` are Compose interpolation inputs instead: one pool for the whole project, which each service maps by hand (`FOO: ${FOO}`).

```yaml
name: sample-app
host: atlas
workingDirectory: /Users/you/Repositories/sample-app
dockerfile: infra/Dockerfile
secrets:
  1password:
    environmentId: fictional-atlas-environment-id
environment:
  SAMPLE_APP_DATA_DIR: /srv/sample-app/data
roles:
  web:
    build:
      target: server
    secrets:
      - SAMPLE_APP_API_TOKEN
  worker:
    build:
      target: worker
      dockerfile: infra/worker.Dockerfile
    environment:
      MY_API_BASE_URL: https://api.example.com/v1
  postgres:
    secrets:
      - POSTGRES_PASSWORD
```

Role names are Compose service names, and a role name becomes a component of an image name, so it must match Docker's rule without dots: lowercase letters and digits joined by single or double underscores or runs of dashes (`^[a-z0-9]+(?:(?:_|__|-+)[a-z0-9]+)*$`). `web_` and `a_-b` are rejected. Every role must be a service in at least one selected Compose file.

| Field         | Meaning                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`       | Optional. Present means compoza builds an image for the service. A role without `build` only sets environment and secrets, like the third-party `postgres` above.             |
| `environment` | Optional map of container environment variables for this service only. Values are literal: nothing is interpolated.                                                           |
| `secrets`     | Optional list of variable names read from the stack's secret source. Each is delivered to this service under the same name. Secret values never enter the generated override. |

compoza sets each built service's `image:` itself, so the Compose files leave it out. A role's `environment` and `secrets` reach the container without a `${NAME}` mapping in the Compose file; see [How roles reach services](#how-roles-reach-services).

#### Build per role

`build` accepts these fields, all optional:

| Field              | Meaning                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `target`           | Dockerfile stage. Without it no `--target` flag is passed and the final stage is built.                                              |
| `workingDirectory` | Source directory of the role. Resolved like the top-level field: relative to the deploy YAML file, `~/` and absolute paths accepted. |
| `dockerfile`       | Relative to the role's working directory; absolute paths are kept. Default `Dockerfile`.                                             |
| `context`          | Relative to the role's working directory; absolute paths are kept. Default the Git root of the role's working directory.             |

A field that is unset falls back to the top-level field of the same name, then to the default. Build commands for a role run in its working directory.

Two Dockerfiles in one repository, each role building from its own file:

```yaml
workingDirectory: ../../sample-app
context: .
roles:
  web:
    build:
      dockerfile: docker/web.Dockerfile
  worker:
    build:
      dockerfile: docker/worker.Dockerfile
```

Both roles build from one repository, so it is checked once and both images get the same tag. They also share the context, and BuildKit applies the context's `.dockerignore` to every build. To give one image its own ignore rules, put a file named after its Dockerfile beside it, such as `docker/web.Dockerfile.dockerignore`. BuildKit uses it instead of the context's `.dockerignore` for that build.

A role built from another repository:

```yaml
workingDirectory: ../../sample-app
roles:
  web:
    build:
      target: server
  jobs:
    build:
      workingDirectory: ../../sample-jobs
```

`jobs` builds from the `Dockerfile` at the root of `sample-jobs` and is tagged with that repository's commit, so the two roles usually have different tags. Each repository is checked separately: both need a commit and a clean checkout.

#### Environment and secrets

Names in a role's `environment` and `secrets` must be valid environment identifiers, and `environment` values cannot contain carriage returns, line feeds or NUL. Role secrets also join the interpolation pool, so they follow the same naming rules as any secret.

A role fails validation, before anything is built, when:

- a name is in both its `environment` and its `secrets`;
- a secret name is reserved, or is also a key of the top-level `environment` (or `local.environment` for `--local`);
- a name is also set in the service's own `environment:` in a selected Compose file, in map or list form, because Compose's precedence would otherwise pick a winner silently (see below);
- it takes secrets but the run has no secret source, or `none`;
- the secret source lacks one of its secrets. This is known only once values are read, so it is checked by a real deploy and `check --secrets`.

The other rules need no secret values, so `check` and `--dry-run` report them too.

The duplicate check follows the selected Compose files the way Compose merges them:

- A later file's `environment: !reset` clears the earlier entries and `!override` replaces them. A per-key `!reset` removes one key. A key removed this way no longer clashes.
- A service that uses `extends`, in the same file or another one, also carries the base service's keys.
- Services from `include:` files count, for client execution and `--local` runs. SSH execution rejects `include:`.

Role secrets work with `env-file` and `1password`; see [Secrets](secrets.md#role-secrets).

#### What stays stack-wide

`workingDirectory`, `dockerfile` and `context` are defaults that roles inherit. The top-level `environment` and `secrets` stay stack-wide, because Compose interpolates the whole project from one pool: `${SAMPLE_APP_DATA_DIR}` in a volume path, a published port or a third-party image tag cannot belong to one service. Roles set container environment, which can. A value needed both for interpolation and inside a container is declared in both places.

#### How roles reach services

With roles, compoza generates one extra Compose file, `compoza.roles.yaml`, and applies it as the last file. For each role it contains the `image` of a building role and the role's `environment`: literal values (with `$` written as `$$`) and secrets as `${NAME}` references. It never contains secret values; those stay in the interpolation pool (the stack `.env` for SSH execution, the process environment for client execution) under their own names.

- Client execution and `--local`: written as a `0600` file in a private temporary folder, passed as the last `--file` of `compose up` and removed afterwards.
- SSH execution: uploaded with the bundle and merged into the flat `compose.yaml`. It is not installed as a separate file on the host. A Compose file or asset that uses the upload name `compoza.roles.yaml` is rejected.

`--dry-run` prints the file in every execution mode.

Without `roles` there is no extra file and nothing changes.

#### Migrating from 0.6.0

`targets` was removed in favor of `roles`. A configuration that still has it fails with a dedicated message that names the replacement.

1. Give each target a role named after the Compose service that runs it, with the target as `build.target`. Delete `targets: []` outright.

   ```yaml
   # 0.6.0: the server stage ran as the web service
   targets: [server, worker]

   # now
   roles:
     web:
       build:
         target: server
     worker:
       build:
         target: worker
   ```

2. Remove `image: ${SERVER_IMAGE}` and the other `<TARGET>_IMAGE` lines from Compose files. compoza sets each built service's image, and those variables no longer exist. A fallback such as `${WEB_IMAGE:-web:local}` can stay: compoza's image overrides it.
3. Images are now named `<name>-<role>:<tag>`. Where the role name differs from the old target name (`server` above), the image name changes and earlier tags cannot be reused with `--tag`. Build that role once from Git.
4. On SSH hosts the next deploy rewrites `.env` without `*_IMAGE` variables and `.compoza.json` with `tags` per role instead of one `tag`.

### Images and tags

- The image of a role with `build` is `<name>-<role>:<tag>`, prefixed with the registry for registry transport. compoza sets it as the service's `image`.
- A build requires a clean checkout with at least one commit in each role's repository. Each repository is checked once, and its roles are tagged with the first twelve characters of its commit. `--allow-dirty` permits a dirty checkout and tags `<commit>-dirty`.
- `--tag` reuses images built earlier and skips Git and builds, so it works from a deploy folder outside any checkout. `--tag <tag>` applies to every role with `build`, and `--tag <role>=<tag>` overrides it for one role; repeat the flag as needed. Every role with `build` must end up with a tag. A stack where no role has `build` (after any [role removal](#destinations)) has no images to reuse, so any `--tag` fails. Naming a role that a destination or `local.roles` removed fails and says the role is removed for the run. `--tag` always uses the **current local configuration**; there is no saved Compose configuration history.
- Progress messages show the single tag when all roles share it, and `web=abc worker=def` otherwise.
- Without any role that has `build` there is no Git, Dockerfile or build-context requirement, and no build or application-registry authentication check. Compose still pulls missing third-party images, and the deploy is tagged `third-party`.

```sh
compoza deploy infra --tag 1a2b3c4d5e6f
compoza deploy infra --tag 1a2b3c4d5e6f --tag worker=9f8e7d6c5b4a
```

### Ingress

Host `ingress` settings describe shared infrastructure; app `ingress` settings describe a route. An app selects exactly one of `caddy`, `cloudflare-tunnel`, or `none: {}`. A host can configure both Caddy and Cloudflare Tunnel; `none` is valid only on its own. Destinations replace the app’s complete ingress selection. On a host with both providers, `setup-proxy <host>` requires `--ingress caddy` or `--ingress cloudflare-tunnel`; setup never runs both implicitly. See the [combined host example](examples.md#one-host-with-caddy-and-cloudflare-tunnel).

See the [Ingress guide](ingress.md) for provider selection, host and app settings, setup commands and lifecycle behavior. For custom Caddyfiles and site blocks, see [Caddy templates](caddy-templates.md).

### Host folders and mounts

Compose resolves relative bind mounts on the host, so host paths must be absolute. With client execution, configuration files belong in images, not mounts. SSH execution additionally supports declared read-only [assets](ssh-deployment.md#stack-bundle-and-assets).

### Local runs

`local` overrides `composeFiles`, `environment` and the complete secret source for `--local` runs. `local.roles` sets `environment` and `secrets` per role and merges over the app's roles the way [destinations](#destinations) do; `build` cannot be changed. Setting a role to `null` removes it from local runs (no build, image, environment, secrets or Compose validation), for a stack whose local Compose files leave a service out: `local: { roles: { worker: null } }`. The removal is checked when the config loads (see [Destinations](#destinations)). If the Compose files still declare the service, it runs as they define it, without compoza's image or role settings. When the app declares a production secret source, an explicit `local.secrets` is required, including `none: {}` when local Compose needs no secrets.

`--local` builds into this machine's Docker and starts the stack here, without remote readiness checks, transport or routes. It keeps this client build-and-run behavior regardless of `execution`.

## Destinations

One `deploy.yaml` can deploy to several hosts or projects. Select one with `--destination <name>`, which every app command accepts, including `check`, `logs`, lifecycle commands and `publish`. Without the flag the default destination is used.

```yaml
name: sample-app
host: atlas
composeFiles:
  - compose.yaml
environment:
  PUBLIC_TITLE: Sample app
roles:
  web:
    build:
      target: web
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
- A destination's `roles` take `environment` and `secrets` per role, without `build`: destinations share the source. For each role, `environment` merges key by key over the app role's, and `secrets` replaces the app role's list. A role named only in the destination is allowed and sets environment only.
- A destination removes a role with `null`, for a destination whose Compose files have no such service. The role gets no build, image, environment or secrets, is not checked against the Compose files, is not Git-checked or tagged, and its secrets are no longer added to a 1Password `variables` allowlist. If the selected Compose files still declare the service, it runs as they define it, without compoza's image or role settings. Every `null` in every destination and in `local.roles` is checked when the config loads, including destinations you do not select, and must name a role in the top-level `roles`; otherwise loading fails with the file name and a message such as `Destination "staging" removes role "wrker", which is not a role; roles: web, worker`. A role removed by the selected destination stays removed in a `--local` run: `local.roles` entries for it are ignored. `null` is accepted only under `destinations.<name>.roles` and `local.roles`, not in the top-level `roles`.

```yaml
destinations:
  staging:
    composeFiles: [compose.yaml] # has no worker service
    roles:
      worker: null
```

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

Client execution is the default mode. A `deploy`:

1. Resolves the image tags from Git, or uses `--tag`.
2. Runs the readiness checks and stops if DNS, the proxy, the network or the registry login is not ready.
3. Creates the host folders.
4. Builds each role with a `build` for the host's platform and ships it by the host's transport.
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
- A blocking `roles` check validates the roles against the selected Compose files: unknown services, clashing environment keys, reserved or colliding secret names and secrets without a secret source. `check --local` checks `local.roles` and `local.composeFiles`. It runs without fetching secrets.
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

Every command's flags, output and exit status are in the [command reference](commands.md).

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

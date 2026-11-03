# compoza

<p align="center">
  <img src="docs/assets/readme-hero-v3.png" width="720" alt="compoza — Bash / Compose / SSH, with a minimal geometric deployment symbol">
</p>

Deploy Docker Compose stacks to remote machines over SSH. Build and deliver images, manage secrets, check health, and recover with known image tags.

A good fit for side projects, home labs, and apps you run on a VPS from providers like Hetzner, OVHcloud, or DigitalOcean. Bring your own server and Compose files; Compoza handles the deployment workflow.

Any app opts in with a `deploy.yaml` beside its Compose files; its source repository can live separately. A separate host inventory can live globally on the operator's machine or in a repository-local `hosts.yaml`.

Docker and Compose are the core. Credential providers (dotenv and 1Password) and ingress (Caddy and Cloudflare Tunnel) are [bundled extensions](docs/development.md#extensions), with interfaces for adding other implementations.

For differences in deployment behavior, operational scope and trade-offs, see [Comparing Kamal, Dokploy, Coolify and Compose](docs/comparisons.md).

[Install](#install) · [Quickstart](#quickstart) · [Commands](#commands) · [Agent skills](#agent-skills) · [Documentation](#documentation)

## What it does

- **Checks readiness** before changing anything, such as DNS, the proxy, its network, registry login and host Docker access.
- **Builds and ships images** tagged with the commit, through a registry, `docker save` over SSH, or a build on the host itself.
- **Runs Compose** from this machine against the host's Docker endpoint (the default), or on the host from a flat stack folder.
- **Templates Caddy configuration** with bundled defaults, custom site and shared Caddyfile templates, and per-app overrides. [Template settings](docs/caddy-templates.md).
- **Provisions Caddy** with an opt-in host `ingress.caddy.provision` block, including persistent storage, health checks, bounded logs, graceful shutdown and DNS challenge settings, or integrates an operator-managed Caddy stack.
- **Provisions Cloudflare connectors** with a digest-pinned image, private credentials from 1Password or dotenv, connection readiness and customizable Compose/route templates. Supports dashboard-managed routes without an API token. [Cloudflare provisioning](docs/cloudflare-provisioning.md).
- **Routes traffic** through shared Caddy or an existing Cloudflare Tunnel, then waits for the URL to answer.
- **Resolves secrets** from a dotenv file or a 1Password Environment, without putting values in configuration.
- **Manages the lifecycle**: status, logs, stop, start, delete and publishing static content.

## Install

Requires Node.js 26.0 or newer on the machine running the CLI; remote Docker hosts do not need Node.js. Install the CLI globally with pnpm:

```sh
pnpm add -g compoza
compoza --version
```

The `compoza` command is then available from any app repository. A normal install includes the optional 1Password SDK; dotenv secrets, checks and dry runs work without it. For running from source, see the [development guide](docs/development.md).

## Quickstart

This deploys the [official nginx image](https://hub.docker.com/_/nginx) to a server over SSH, checks that it answers, then removes it again. It needs no Dockerfile, Git checkout or Docker on your machine: the server pulls the image and runs Compose itself.

**You need:**

- On your machine: compoza ([installed above](#install)) and an SSH key the server accepts. `ssh deploy@juniper.example.com docker version` should print Docker's version without asking for a password.
- On the server: Docker Engine with a recent Compose plugin (one that supports `up --wait`), Bash 3.2+, jq 1.6+, `base64` and curl, and write access for the SSH account to the stack folder. `check` verifies most of this; see [host prerequisites](docs/ssh-deployment.md#host-prerequisites).

The host `juniper`, the `deploy` account and the paths are examples; use your own.

### 1. Describe the server

Create `~/.config/compoza/hosts.yaml`. Every app can deploy to the hosts listed here:

```yaml
juniper:
  ssh: deploy@juniper.example.com # what you would pass to `ssh`
  platform: linux/amd64 # the server's platform, used when compoza builds images
  transport:
    mode: ssh-load # how built images reach the server; unused here because nothing is built
```

A `hosts.yaml` in the current folder overrides these entries by name, and `--hosts <file>` selects one file instead. Hosts kept elsewhere, such as in an infrastructure repository, can be added with `compoza hosts link <folder>`. See [Hosts](docs/configuration.md#hosts).

### 2. Describe the app

In your app repository, create an `infra` folder with two files:

```text
my-app/
└── infra/
    ├── deploy.yaml
    └── compose.yaml
```

`infra/deploy.yaml` says where and how the app runs:

```yaml
name: hello-web # the Compose project name on the server
host: juniper # a host from hosts.yaml
targets: [] # images to build; none, because nginx is pulled as is
execution: ssh # run Compose on the server from a stack folder
composeFiles:
  - compose.yaml
remote:
  stackDir: /home/deploy/stacks/hello-web # where the server keeps the stack's files
health:
  url: http://127.0.0.1:8080/ # probed from the server before the deploy succeeds
```

`infra/compose.yaml` is an ordinary Compose file:

```yaml
services:
  web:
    image: nginx:alpine
    ports:
      - '127.0.0.1:8080:80'
```

The port is bound to `127.0.0.1`, so the app is only reachable from the server itself until you [add a domain](#next-steps).

### 3. Check the server

Run the commands from `my-app`. `check` is read-only:

```console
$ compoza check infra
ok   docker: docker ready for SSH execution
ok   compose: compose ready for SSH execution
ok   jq: jq ready for SSH execution
…
8 checks, 0 failing
```

A failing check names what is missing on the server. `check` exits with status 2 while anything blocks a deploy.

### 4. Preview and deploy

`--dry-run` runs the same checks and prints the plan without changing anything:

```console
$ compoza deploy infra --dry-run
…
Dry run complete. No host writes, locks, builds or staging. …
```

Then deploy:

```console
$ compoza deploy infra
Deploying hello-web third-party to juniper over SSH
[1/2] Checking SSH host readiness …
ok   docker: docker ready for SSH execution
…
[1/2] Checking SSH host readiness … ok (0.4 s)
[2/2] Staging, validating and updating the host stack …
$ ssh deploy@juniper.example.com <stage 1 declared files; lock, validate, compose up --wait, route, health>
Validating stack Compose configuration
Starting stack and waiting for running/healthy services
Waiting for HTTP readiness
Stack deployment complete
[2/2] Staging, validating and updating the host stack … ok (2.0 s)
Deployed hello-web third-party to juniper; stack folder updated.
```

The deploy writes `compose.yaml`, `.env` and a small metadata file into `stackDir`, runs `docker compose up --wait` on the server, and succeeds only once `health.url` answers. `third-party` is the image tag of an app that builds nothing; apps with `targets` are tagged with the commit.

### 5. Look at it

```console
$ compoza status infra
$ ssh deploy@juniper.example.com <ps deployed stack>
NAME              IMAGE          COMMAND                  SERVICE   CREATED         STATUS         PORTS
hello-web-web-1   nginx:alpine   "/docker-entrypoint.…"   web       2 seconds ago   Up 2 seconds   127.0.0.1:8080->80/tcp

$ compoza logs infra --tail 20 --follow
$ ssh deploy@juniper.example.com <logs deployed stack>
web-1  | 2026/11/03 10:06:20 [notice] 1#1: start worker process 40
web-1  | 192.168.158.1 - - [03/Nov/2026:10:06:21 +0000] "GET / HTTP/1.1" 200 896 "-" "curl/8.7.1" "-"
```

`--follow` keeps printing new lines until you press Ctrl-C, each prefixed with the container that wrote it. To see the page itself, ask the server: `ssh deploy@juniper.example.com curl -s http://127.0.0.1:8080/`.

### 6. Clean up

```console
$ compoza delete infra
$ ssh deploy@juniper.example.com <delete deployed stack; keep stack files, secrets and data>
 Container hello-web-web-1 Stopping
…
Deleted hello-web; data, secrets and stack files stay
```

`delete` removes the containers and network. The stack folder stays, so a later `deploy` picks up where this one left off.

### Next steps

- **Serve it on a domain** through a shared [Caddy proxy or a Cloudflare Tunnel](docs/ingress.md): configure the provider on the host, run `compoza setup-proxy juniper` once, and add `ingress` with the app's domain to `deploy.yaml`.
- **Build your own images** by listing Dockerfile `targets`; each is built, tagged with the commit and shipped to the server. See [Apps](docs/configuration.md#apps) and [Image transports](docs/configuration.md#image-transports).
- **Add secrets** from a dotenv file or 1Password without putting values in configuration. For 1Password, save your desktop account once with `compoza config set 1password.account "<account>"`. See [Secrets](docs/secrets.md).
- **Share hosts across machines or teammates** by keeping a `hosts.yaml` in an infrastructure repository and running `compoza hosts link <folder>`. See [Linked hosts files](docs/configuration.md#linked-hosts-files).
- **Run Compose from your machine instead** by leaving `execution` out: the default, client execution, runs Compose locally against `docker --host ssh://<host>` and needs Docker on your machine. See [Execution and image transport](#execution-and-image-transport).
- **Keep deployment configuration out of the app repository.** For `Repositories/deployments/foo/deploy.yaml`, set `workingDirectory: ../../foo`; Git checks and builds then use `Repositories/foo`, while Compose files, assets and templates stay beside `deploy.yaml`. See [separate source and deployment folders](docs/configuration.md#separate-source-and-deployment-folders).
- **Recover** from a bad deploy with `compoza deploy infra --tag <earlier-tag>`.

## Execution and image transport

Two independent settings decide how a deploy runs:

| Setting                 | Values                                 | Effect                                                                                                 |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `execution` (app)       | `client` (default), `ssh`              | Run Compose from this machine, or update a flat stack folder and run the host's own Compose            |
| `transport.mode` (host) | `registry`, `ssh-load`, `remote-build` | Push and pull via a registry, pipe `docker save` over SSH, or build on the host (`ssh` execution only) |

`--local` always builds into this machine's Docker and starts the stack here, whatever the execution mode. See [Configuration](docs/configuration.md#execution-and-transport) and [SSH deployment](docs/ssh-deployment.md) for the details.

## Commands

| Task                   | Command                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| Check readiness        | `compoza check <folder> [--json] [--secrets]`                                 |
| Preview / deploy       | `compoza deploy <folder> [--dry-run]`                                         |
| Reuse an earlier image | `compoza deploy <folder> --tag <image-tag>`                                   |
| Inspect services       | `compoza status <folder>`                                                     |
| Read or follow logs    | `compoza logs <folder> [--service <name>] [--tail <lines>] [--follow]`        |
| Stop / resume          | `compoza stop <folder>` / `compoza start <folder>`                            |
| Remove a stack         | `compoza delete <folder> [--volumes]`                                         |
| Mirror content         | `compoza publish <folder> <section> <source>`                                 |
| Set up host ingress    | `compoza setup-proxy <host> [--ingress caddy\|cloudflare-tunnel] [--dry-run]` |

`<folder>` holds `deploy.yaml` (or is the file itself) and defaults to the working directory, except for `publish`, which requires it. Every app command accepts `--destination <name>`, and `stop`, `start`, `delete`, `publish` and `setup-proxy` accept `--dry-run`. `delete` is also available as `down`.

The [command reference](docs/commands.md) covers every flag, what each command changes on the host, its output and its exit status. `compoza help <command>` (or `compoza <command> --help`) explains a command, its flags and examples from the CLI.

A host can configure both Caddy and Cloudflare Tunnel. Each app selects one; use `setup-proxy <host> --ingress caddy` or `--ingress cloudflare-tunnel` to set up one provider on a shared host. See the [combined host example](docs/examples.md#one-host-with-caddy-and-cloudflare-tunnel).

## Operational notes

- **A dry run is not proof.** It runs read-only probes and prints the plan, but the candidate Compose model cannot be fully validated against host files until it is staged.
- **Failures can be partial.** A failed Compose run, route or health check can leave candidate containers or routes active. There is no automatic container rollback, and database changes are never reversed. Inspect `status` and `logs`, then recover explicitly.
- **`deploy --tag <tag>` uses the current local configuration.** It reuses existing images and skips Git and builds; it resolves the selected credentials again and stores no configuration history.
- **Keep secrets out of configuration.** Never put them in `deploy.yaml`, `environment`, assets or build contexts; exclude dotenv files from build contexts with `.dockerignore`.
- **Data stays.** `delete` keeps host folders and bind data; named volumes are removed only with `--volumes`.

## Agent skills

Two workflows are included for Codex and Claude Code:

| Agent       | Skill folders                                       | Invoke                |
| ----------- | --------------------------------------------------- | --------------------- |
| Codex       | `.agents/skills/deploy/`, `.agents/skills/compoza/` | `$deploy`, `$compoza` |
| Claude Code | `.claude/skills/deploy/`, `.claude/skills/compoza/` | `/deploy`, `/compoza` |

- **`deploy`** guides a deployment through target selection, readiness checks, preview, deployment and verification.
- **`compoza`** handles operations such as status, logs, image-tag recovery, stop/start, deletion and content publishing.

Install the CLI first. To use the skills in another repository, copy the **entire folders**, including Codex metadata:

```sh
# Run from this checkout; replace /path/to/app with the target repository.
mkdir -p /path/to/app/.agents/skills
cp -R .agents/skills/deploy .agents/skills/compoza /path/to/app/.agents/skills/
```

[Codex discovers repository skills](https://developers.openai.com/codex/skills) under `.agents/skills/`. Both support explicit invocation and automatic selection. They are not installed globally. For Claude Code, copy the corresponding folders into `.claude/skills/`; `/deploy` remains explicitly invoked.

## Documentation

| Document                                                   | Covers                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [Comparing deployment tools](docs/comparisons.md)          | Kamal, Dokploy, Coolify and Compose: deployment models, strengths, limits and when to choose each                  |
| [Commands](docs/commands.md)                               | Every command and flag, what it changes on the host, output and exit status                                        |
| [Examples](docs/examples.md)                               | Complete host and app configurations, central source directories, destinations, credentials and ingress variations |
| [Configuration](docs/configuration.md)                     | `hosts.yaml`, linked hosts, settings, `deploy.yaml`, destinations, execution and transport, lifecycle, `publish`   |
| [Ingress](docs/ingress.md)                                 | Provider selection, Caddy host/app settings and setup, Cloudflare Tunnel, route ownership and lifecycle            |
| [Caddy templates](docs/caddy-templates.md)                 | File and inline templates, placeholders, app overrides and custom proxy headers                                    |
| [Caddy production operations](docs/caddy-production.md)    | Hardening defaults, monitoring, backups, recovery and hardening an integrated stack                                |
| [Cloudflare provisioning](docs/cloudflare-provisioning.md) | Host connector setup, native credentials, manual routes, hardening and Compose/route templates                     |
| [Secrets](docs/secrets.md)                                 | Providers, 1Password authentication, dotenv rules, collisions, access checks, private SSH dotenv                   |
| [SSH deployment](docs/ssh-deployment.md)                   | Host prerequisites, flat stack layout, assets, validation, privacy and image-tag recovery                          |
| [Development](docs/development.md)                         | Source layout, checks, tests and host-runtime conventions                                                          |

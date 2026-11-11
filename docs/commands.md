# Commands

[README](../README.md) · [Configuration](configuration.md) · [Ingress](ingress.md) · [Secrets](secrets.md) · [SSH deployment](ssh-deployment.md) · [Examples](examples.md)

Every compoza command, its arguments and flags, and what it changes. `compoza help <command>`, or `compoza <command> --help`, prints a shorter version of the same from the CLI itself, with examples.

| Command                       | Changes the host | Summary                                                         |
| ----------------------------- | ---------------- | --------------------------------------------------------------- |
| [`check`](#check)             | No               | Readiness report: DNS, proxy, registry login, host capabilities |
| [`deploy`](#deploy)           | Yes              | Check, build, ship, run and route the app                       |
| [`status`](#status)           | No               | The app's containers and their state                            |
| [`logs`](#logs)               | No               | Container logs, optionally followed live                        |
| [`stop`](#stop-and-start)     | Yes              | Halt the containers and keep everything else                    |
| [`start`](#stop-and-start)    | Yes              | Resume stopped containers                                       |
| [`delete`](#delete)           | Yes              | Remove the route, containers and networks; data stays           |
| [`publish`](#publish)         | Yes              | Mirror a local folder into a content section                    |
| [`setup-proxy`](#setup-proxy) | Yes              | Set up or provision a host's ingress provider                   |
| [`hosts`](#hosts)             | No               | List hosts; link or unlink extra hosts files and folders        |
| [`config`](#config)           | No               | Read and change settings such as the 1Password account          |
| `help`                        | No               | Explain a command, its arguments and its flags                  |

- [Common arguments and flags](#common-arguments-and-flags)
- [Exit status](#exit-status)

## Common arguments and flags

**`<folder>`** names the app: a folder holding `deploy.yaml` (or `deploy.yml`), or the file itself. It defaults to the working directory, so `compoza status` inside the app folder and `compoza status infra` from the repository root are the same. `publish` is the exception: it requires the folder because two more arguments follow it.

These flags work with every app command:

| Flag                    | Effect                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--destination <name>`  | Use a named destination from `deploy.yaml` instead of the default; see [Destinations](configuration.md#destinations).                                                                                                            |
| `--hosts <file>`        | Read hosts from this file only. Without it, `COMPOZA_HOSTS` selects one file, or `./hosts.yaml` overrides `~/.config/compoza/hosts.yaml` and the [linked hosts files](#hosts) by host name; see [Hosts](configuration.md#hosts). |
| `--log-level <level>`   | `debug` also prints the plan, the host scripts and the readiness probes. Defaults to `info`.                                                                                                                                     |
| `--help`, `-h`          | Explain the command and print its arguments, flags and examples; the same as `compoza help <command>`.                                                                                                                           |
| `--version`, `-v`       | Print the CLI version.                                                                                                                                                                                                           |
| `--completions <shell>` | Print a completion script for `bash`, `zsh`, `fish`, `sh`, `powershell` or `pwsh`.                                                                                                                                               |

How a command reaches the host depends on the app's `execution` setting. With client execution (the default), Compose runs on this machine against `docker --host ssh://<host>`. With `execution: ssh`, compoza runs the host's own Compose over SSH against the deployed stack folder. The commands and flags are the same in both; differences are noted below. See [Execution and transport](configuration.md#execution-and-transport).

## Exit status

| Code | Meaning                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | The command succeeded.                                                                                                         |
| `1`  | The command failed. The reason is printed on standard error as one message, without a stack trace.                             |
| `2`  | `check` only: at least one check blocks a deploy. A failing `route` check alone does not, because the deploy writes the route. |

## check

```sh
compoza check [<folder>] [--json] [--secrets] [--local]
```

A read-only readiness report. It changes nothing on the host and fetches no secrets unless asked to.

| Flag        | Effect                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `--json`    | Print `{ app, host, checks }` as JSON instead of one line per check.                                    |
| `--secrets` | Also read the selected secret source and report whether it is accessible, with variable names only.     |
| `--local`   | Skip the remote checks. With `--secrets`, check the `local.secrets` source instead of the deployment's. |

What is checked depends on the app and host: DNS for the app's domain, the ingress proxy and its network, registry login when images are pushed, the roles (each role is a service in the selected Compose files, and its environment and secrets do not clash), and, for `execution: ssh`, the host's Docker, Compose, jq, curl and stack folder (see [host prerequisites](ssh-deployment.md#host-prerequisites)). Each line names the check and what was found. The last line counts the failures, and says how many block a deploy when that is not all of them:

```text
ok   docker: docker ready for SSH execution
ok   compose: compose ready for SSH execution
…
8 checks, 0 failing
```

See [Checks](configuration.md#checks) and [Verifying secret access](secrets.md#verifying-access).

## deploy

```sh
compoza deploy [<folder>] [--dry-run] [--tag <tag|role=tag>]... [--allow-dirty] [--local]
```

Checks readiness, builds and ships the images, runs Compose, routes traffic, and waits for the app to answer. Progress is printed as numbered phases, each with its duration, and the last line names the deployed tag.

| Flag            | Effect                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`     | Run the read-only checks and print every command and host script instead of running it. Nothing is built, shipped, written or started.                                               |
| `--tag <tag>`   | Reuse images built earlier instead of building, skipping Git. Repeatable: `<tag>` for every role with a `build`, `<role>=<tag>` for one role. See [Reusing images](#reusing-images). |
| `--allow-dirty` | Build from a checkout with uncommitted changes and tag the images `<commit>-dirty`. Without it, a build requires a clean checkout.                                                   |
| `--local`       | Build into this machine's Docker and start the stack here, with the `local` overrides; no remote checks, transport, routes or wait.                                                  |

The phases run in this order, and a phase with nothing to do is left out:

1. **Checks**: the same readiness checks as `check`. A blocking failure stops the deploy before anything changes.
2. **Folders** (client execution): creates the app's `directories` and `content` folders on the host.
3. **Build**: builds each role that has a `build` and ships it through the host's transport (registry, `ssh-load` or `remote-build`). There is no build when no role has a `build`, or with `--tag`.
4. **Compose**: `docker compose up --wait` on the host. With `execution: ssh` this one phase also stages and validates the flat stack folder, creates the folders, writes the route and probes `health.url` (or the app's public URL) from the host.
5. **Route** (client execution, with ingress): writes the app's Caddy site or Cloudflare route.
6. **Wait** (client execution, with ingress): waits for the app's public URL to answer with a status below 500.

Each role's image is tagged with the first twelve characters of its repository's commit, so roles from one repository share a tag. The deploy is tagged `third-party` when no role has a `build`.

```sh
compoza deploy infra --dry-run
compoza deploy infra
```

### Reusing images

`--tag <tag>` sets the tag of every role with a `build`, and `--tag <role>=<tag>` overrides it for one role:

```sh
compoza deploy infra --tag 1a2b3c4d5e6f
compoza deploy infra --tag 1a2b3c4d5e6f --tag worker=9f8e7d6c5b4a
```

Every role with a `build` must end up with a tag. Naming an unknown role, a role without `build` or the same role twice fails, and so does a second bare tag. A tag follows Docker's rules: letters, digits, underscores, dots and dashes, at most 128 characters, not starting with a dot or dash. That rejects `--tag web:abc`, a likely typo for `--tag web=abc`. On a stack where no role has a `build`, any `--tag` fails, because there are no images to reuse. The **current local configuration** is used; there is no saved configuration history.

A failed deploy can leave new containers or routes running: there is no automatic rollback. Inspect `status` and `logs`, then deploy a known tag. See [Images and tags](configuration.md#images-and-tags), [Local runs](configuration.md#local-runs) and, for SSH execution, the [deploy transaction](ssh-deployment.md#deploy-transaction).

## status

```sh
compoza status [<folder>]
```

Lists the app's containers with `docker compose ps --all`, so a stopped stack shows as stopped instead of missing:

```text
NAME              IMAGE          COMMAND                  SERVICE   CREATED         STATUS        PORTS
hello-web-web-1   nginx:alpine   "/docker-entrypoint.…"   web       2 seconds ago   Up 1 second   127.0.0.1:8080->80/tcp
```

With `execution: ssh` and a managed secret source, status prints one JSON object per container with only its service, image, state, health and exit code, with managed secret values redacted (all dotenv values for a stack deployed by an earlier version). An image that does not look like an image reference shows as `(image)`.

## logs

```sh
compoza logs [<folder>] [--service <name>] [--tail <lines>] [--follow]
```

Shows the app's container logs from its host, using `docker compose logs`.

| Flag               | Effect                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `--tail <lines>`   | How many existing lines to print **per container** first. Defaults to 100.                       |
| `--follow`, `-f`   | Keep the command running and print new lines as containers write them. Stop with Ctrl-C.         |
| `--service <name>` | Only that Compose service's containers. An unknown name fails and lists the services that exist. |

```sh
compoza logs infra                      # the last 100 lines of every container
compoza logs infra --tail 20 --follow   # the last 20 lines, then new lines as they arrive
compoza logs infra --service web -f     # only the web service, live
```

Every line starts with the container that wrote it, as `<service>-<replica>`, so a service with several replicas and a stack with several services stay readable while following:

```text
web-1     | GET /healthz 200
web-2     | GET /orders 200
worker-1  | processed job 4182
```

With `--follow`, lines from different containers are printed in the order they arrive. The command keeps running until you interrupt it, so leave `--follow` out in scripts and CI. Ctrl-C ends it with exit status 0; closing the terminal or stopping compoza ends it too, on this machine and, with `execution: ssh`, on the host.

Logs are read from the running project by name, so they need no Compose files, source checkout or secrets on this machine. With `execution: ssh` the host's own Compose reads them from the deployed stack.

`--service` is checked before any logs are read, because Compose itself prints nothing and succeeds for a service it does not know. With client execution the name must have containers in the running project, stopped ones and those of other Compose profiles included; with `execution: ssh` it must be a service of the deployed stack in any profile. A name that fails lists the ones that would work:

```text
No service "wbe" in the running project; services: maint, web
No service "wbe" in the deployed stack; services: maint, web
```

Application logs are printed as the containers wrote them, and can contain secrets if the application logs them.

## stop and start

```sh
compoza stop [<folder>] [--dry-run]
compoza start [<folder>] [--dry-run]
```

`stop` halts the app's containers. Networks, volumes, images, the route and data stay, so `start` brings the stack back exactly as it was. Neither builds, pulls or changes configuration; to change what runs, deploy. `--dry-run` prints the commands and host scripts without running them.

## delete

```sh
compoza delete [<folder>] [--volumes] [--dry-run]
compoza down [<folder>] [--volumes] [--dry-run]
```

Removes the app's route first, so the domain stops being served cleanly, then its containers and networks (`docker compose down --remove-orphans`). `down` is another name for `delete`.

| Flag        | Effect                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| `--volumes` | Also remove the project's named Compose volumes. Bind-mounted host folders always stay. |
| `--dry-run` | Print the commands and host scripts without running them.                               |

`delete` never removes the `directories` and `content` folders, or, with `execution: ssh`, the stack folder with its dotenv and overlays: a later `deploy` finds them again. See [Lifecycle](configuration.md#lifecycle).

## publish

```sh
compoza publish <folder> <section> <source> [--dry-run]
```

Mirrors the local folder `<source>` into the content section `<section>` declared under `content` in `deploy.yaml`, using rsync over SSH. The host folder becomes an exact copy: files missing from `<source>` are deleted there. Dotfiles and `node_modules` are never copied.

```sh
compoza publish infra public ./public --dry-run   # list what would change; *deleting marks removals
compoza publish infra public ./public
```

`--dry-run` runs rsync's own dry run, so it lists the files that would be copied or deleted. See [Publishing content](configuration.md#publishing-content).

## setup-proxy

```sh
compoza setup-proxy <host> [--ingress caddy|cloudflare-tunnel] [--dry-run]
```

Runs the explicit host setup of an ingress provider. `<host>` is a host name from the hosts file; this command takes no app folder. Deploys never set up ingress on their own.

| Flag        | Effect                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `--ingress` | The provider to set up. Required when the host configures both `caddy` and `cloudflare-tunnel`. |
| `--dry-run` | Print the setup script and its input without connecting to the host.                            |

- **Caddy**: prepares the shared proxy's `sites` folder and recreates Caddy, or, with `ingress.caddy.provision`, creates a hardened Caddy stack. Recreating Caddy can briefly interrupt sites it already serves. See [Run host setup](ingress.md#run-host-setup) and [Provision a new Caddy stack](ingress.md#provision-a-new-caddy-stack).
- **Cloudflare Tunnel**: with API-managed routes, verifies access to the existing tunnel and prepares private route ownership storage; with manual routes, checks the connector. With `provision`, it first creates the connector stack. See [Set up DNS and route ownership](ingress.md#set-up-dns-and-route-ownership) and [Cloudflare provisioning](cloudflare-provisioning.md).

## hosts

```sh
compoza hosts list
compoza hosts link <path>
compoza hosts unlink <path>
```

Manages the hosts files every run reads, stored in the [settings file](configuration.md#settings). None of these connect to a host.

- **`list`** prints each host a run would use and the hosts file defining it, then the linked paths. It honours `--hosts` and `COMPOZA_HOSTS`, and fails like any other command when a hosts file is missing, invalid or clashes with another.
- **`link <path>`** adds a hosts file, or a folder holding a `hosts.yaml`, to the files read alongside `~/.config/compoza/hosts.yaml`. A relative path resolves against the working directory, and the absolute path is what is stored. It refuses a missing target, a folder without `hosts.yaml`, an invalid file or `$ref`, and a host name that the global file or another link already defines; nothing is saved in those cases. Linking an already linked path changes nothing.
- **`unlink <path>`** removes a link, given as written or as any path resolving to it. The target does not need to exist, so a link to a deleted folder can still be removed. It fails, listing the current links, when the path is not linked.

```text
$ compoza hosts link ~/infrastructure
Linked /Users/you/infrastructure in /Users/you/.config/compoza/config.yaml
$ compoza hosts list
atlas  /Users/you/.config/compoza/hosts.yaml
cedar  /Users/you/infrastructure/hosts.yaml

Linked: /Users/you/infrastructure
```

See [Linked hosts files](configuration.md#linked-hosts-files).

## config

```sh
compoza config get <key>
compoza config set <key> <value>
compoza config unset <key>
```

Reads and changes the [settings file](configuration.md#settings), `~/.config/compoza/config.yaml`. `set` creates the file and its folder when needed, validates the result before writing, and keeps comments and other settings. `get` prints the saved value and exits with status 1 when the key is not set; it does not report environment variables that override the setting. `unset` of a key that is not set changes nothing.

| Key                 | Meaning                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1password.account` | The 1Password desktop account, by name or UUID, used when neither `OP_SERVICE_ACCOUNT_TOKEN` nor `COMPOZA_1PASSWORD_ACCOUNT` is set; see [Authentication](secrets.md#authentication). |

```sh
compoza config set 1password.account "Atlas Example"
compoza config get 1password.account   # Atlas Example
compoza config unset 1password.account
```

Linked hosts are stored in the same file but are changed with [`hosts link`](#hosts), not `config set`.

---
name: compoza
description: 'Operate applications configured for the compoza CLI: inspect readiness, status and logs, redeploy known image tags, stop or start services, remove a stack, or publish content. Use for compoza operations and configuration questions; use deploy for a guided new deployment.'
---

# Operate compoza stacks

Use the installed CLI instead of reproducing its deployment scripts. Locate it on
`PATH` or invoke `node /path/to/compoza/bin/compoza.ts` from its checkout.
The CLI machine needs Node.js 26.0 or newer; remote Docker hosts do not need Node.js.
Use `--help` and the tool's README/reference docs when available. This skill remains
self-contained when copied into another repository.

## Resolve scope first

- Locate the requested `deploy.yaml`. Ask if the app or destination is ambiguous.
  It may live outside the app repository. `workingDirectory` selects the source for Git
  and builds, relative to the YAML unless absolute or `~/`; it defaults to the YAML folder.
  Compose, assets, dotenv files and app templates keep the YAML folder as their base.
  Destinations share this source; hosts discovery still uses the CLI working directory.
- Preserve `--destination <name>` and any `--hosts` override on every app command.
  Global hosts live in `~/.config/compoza/hosts.yaml`; `./hosts.yaml` in the current
  working directory overrides complete entries by name. `--hosts` or `COMPOZA_HOSTS`
  selects one file exclusively. Entries may use `{ "$ref": "path" }` for a single external
  host config, relative to the containing file. Files linked with `compoza hosts link`
  are read with the global file and must not repeat its host names; `compoza hosts list`
  shows each host and its file. Do not invent addresses, aliases, paths, or credentials.
- Read the selected execution mode. `client` is the default; `ssh` updates a flat
  host stack folder. Image transport is separately `registry`, `ssh-load`, or
  `remote-build`; the last requires SSH execution.
- Honor authorization already given in the session. Read-only inspection does not
  need a new approval. Confirm destructive or shared-infrastructure changes only
  when they are outside the scope already authorized.

## Choose the operation

The examples use `infra`; substitute the actual folder and retain destination flags.

| Need                      | Command                                      |
| ------------------------- | -------------------------------------------- |
| Readiness                 | `compoza check infra --json`                 |
| Source access, names only | `compoza check infra --secrets --json`       |
| Running services          | `compoza status infra`                       |
| Recent logs               | `compoza logs infra --tail 50`               |
| One service's live logs   | `compoza logs infra --service web --follow`  |
| Stop / resume             | `compoza stop infra` / `compoza start infra` |
| Remove the stack          | `compoza delete infra`                       |
| Hosts and their files     | `compoza hosts list`                         |
| Saved 1Password account   | `compoza config get 1password.account`       |

Each log line starts with its container (`web-1`, `worker-1`). An unknown `--service` fails and
lists the available services; retry with one of those names. `--follow` streams until
interrupted, so in an agent session read a bounded `--tail` without `--follow` unless the user
wants to watch live output.

`stop`, `start`, and `delete` accept `--dry-run`. Delete retains host folders, secrets,
stack configuration and images. `--volumes` additionally removes named Compose
volumes; do not add it implicitly. `setup-proxy <host> --dry-run` previews ingress setup
without opening SSH. Caddy hosts with `ingress.caddy.provision` can bootstrap a fresh
proxy, shared network, persistent storage and logging. A configured `provision.envFile`
must already exist on the host; provisioning refuses differing files already there and
foreign containers. Without `provision`, setup integrates the operator-managed proxy.
Starting/recreating shared Caddy can interrupt all routed sites; that impact needs
authorization within the task scope.

Caddy `templates.site` and `templates.config` accept local filenames or `{ inline }` text.
Host template paths resolve relative to the declaring host YAML, including external `$ref`
files. An app's `ingress.caddy.siteTemplate` overrides the host site template and resolves
relative to deploy.yaml after destination selection. Credentials stay in Caddy environment
placeholders, never literal template text. Shared config templates apply only during
provisioning; they do not overwrite operator-managed configuration.

## Recover with a known image tag

```sh
compoza deploy infra --tag <image-tag> --dry-run
compoza deploy infra --tag <image-tag>
compoza status infra
```

`--tag` skips Git/builds and reuses images with the current local configuration and
currently selected secret source. A missing source checkout is allowed for `--tag`,
`targets: []`, status, logs and lifecycle commands. There is no release rollback command, saved
configuration history or backup folder. Check out an earlier app revision separately
when its configuration is required. Never imply that database changes are reversed.

SSH stacks contain `compose.yaml`, private `.env`, declared assets and one nonsecret
`.compoza.json` lifecycle metadata file. A live host overlay may also be present.
Runtime scripts and filters are sent with each CLI operation, not installed on the host.
Upload and validation failures leave deployed files unchanged. Later replacement,
Compose, routing or health failures can leave changed files or containers; recover
by redeploying, then verify status and health.

Lifecycle commands use deployed metadata and ignore unshipped local Compose or route
changes. They do not contact a provider. Inspect `.deploy-lock/owner` and confirm its
operation is inactive before removing a stale lock. Undeclared folders and operator
data are never cleaned up automatically.

## Publish content

```sh
compoza publish infra <section> <local-folder> --dry-run
compoza publish infra <section> <local-folder>
```

Publishing mirrors the local folder into the configured host content section,
including deletions. Review the preview's `*deleting` lines and ensure that scope is
authorized before publishing. Do not change section paths to work around a failure.

## Keep secrets private

- Client-resolved `secrets` accepts dotenv, 1Password Environments, or `none`.
  Complete source overrides and explicit `local.secrets` prevent production fallback.
  Each level names one complete source; sources are never merged.
- Providers resolve on the CLI machine for deployment. SSH writes selected values to
  the flat stack `.env` with mode 0600. Lifecycle reads that host state without
  contacting a provider. Host-only values stay in operator-owned files referenced by
  absolute Compose `env_file:` paths, outside `secrets`.
- Ordinary checks/dry runs do not fetch secrets. Explicit `check --secrets` reports
  names/status only. Pair `--local` with `--secrets` for local source access;
  `--local` alone skips remote readiness without checking a provider or local Docker.
- Keep 1Password credentials in the operator environment, never app YAML or chat. The
  desktop account may be saved with `compoza config set 1password.account`. Leave changing
  it, and `hosts link`/`unlink`, to the user unless asked: they affect every later run.
  Do not fetch a personal vault just to validate implementation changes.
- Do not print resolved Compose config, dotenv contents or provider exceptions. Managed status omits command/image/container-name
  fields; requested application logs can still contain secrets and need care.

## Diagnose and report

Act on the readiness report's `fix`; a missing app route is repaired by deployment,
whereas DNS, host setup, network and registry failures need correction. SSH hosts
require Bash 3.2+, jq 1.6+ and supported Compose; readiness does not enforce all minimum
versions. Never silently install host dependencies or repeat a failed mutation.

For additional planning detail, use `deploy --dry-run --log-level debug`. It does not
retrieve old output or reveal suppressed diagnostics. Finish with the destination,
operation, verification result, and any unresolved failure; avoid copying secret-bearing logs.

## Hosts with multiple ingress providers

One host file can configure both `ingress.caddy` and `ingress["cloudflare-tunnel"]`.
Each app still selects exactly one provider; use its selection for checks and deployment.
For shared host setup, choose `setup-proxy <host> --ingress caddy` or
`setup-proxy <host> --ingress cloudflare-tunnel`, retaining any explicit hosts file.
Omitting the selector on a host with both is an error; never infer that both should
be recreated. Single-provider hosts can omit the flag. Host templates and client-side
credential paths remain relative to the declaring host YAML, including `$ref` files.

## Cloudflare connector provisioning

Host `ingress["cloudflare-tunnel"].provision` lets `setup-proxy` create the host connector and shared network. It requires a pre-existing remotely managed tunnel and exactly one of `envFile` (private host file with raw `TUNNEL_TOKEN`) or `secrets` (native 1Password/dotenv source, selected `CLOUDFLARE_TUNNEL_TOKEN`). Setup dry runs fetch no secrets or SSH. Real setup sends only the selected token over stdin, checks its account/tunnel identity, guards file/container ownership and waits for the native connection health check. Reruns recreate the shared connector and can briefly affect its applications.

`templates.compose` customizes the hardened connector stack; `templates.route` and app `routeTemplate` customize managed `originRequest` settings. Filenames resolve relative to their declaring YAML. Preserve identity, credential and isolation invariants; differing Compose files already on the host require explicit reconciliation. `routing: "manual"` leaves dashboard routes untouched and needs no API token or state directory. Managed routing requires the separate host `apiTokenFile` and `stateDir`. DNS, tunnel creation and Access remain operator-owned. Read `docs/cloudflare-provisioning.md` when available.

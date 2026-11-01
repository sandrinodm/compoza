---
name: compoza
description: 'Operate applications configured for the compoza CLI: inspect readiness, status and logs, roll back SSH releases, stop or start services, remove a stack, or publish content. Use for compoza operations and configuration questions; use deploy for a guided new deployment.'
---

# Operate compoza stacks

Use the installed CLI instead of reproducing its deployment scripts. Locate it on
`PATH` or invoke `node /path/to/compoza/bin/compoza.ts` from its checkout.
Use `--help` and the tool's README/reference docs when available. This skill remains
self-contained when copied into another repository.

## Resolve scope first

- Locate the requested `deploy.yaml`. Ask if the app or destination is ambiguous.
- Preserve `--destination <name>` and any `--hosts` override on every app command.
  Global hosts live in `~/.config/compoza/hosts.yaml`; `./hosts.yaml` in the current
  working directory overrides complete entries by name. `--hosts` or `COMPOZA_HOSTS`
  selects one file exclusively. Entries may use `{ "$ref": "path" }` for a single external
  host config, relative to the containing file. Do not invent addresses, aliases, paths, or credentials.
- Read the selected execution mode. `client` is the default; `ssh` uses versioned
  host releases. Image transport is separately `registry`, `ssh-load`, or
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

`stop`, `start`, and `delete` accept `--dry-run`. Delete retains host folders, secrets,
release/activation records, and images. `--volumes` additionally removes named Compose
volumes; do not add it implicitly. `setup-proxy <host> --dry-run` previews ingress setup
without opening SSH. Caddy hosts with `ingress.caddy.provision` can bootstrap a fresh
proxy, shared network, persistent storage and logging. The configured host env file
must already exist; provisioning refuses differing existing files and foreign containers.
Without `provision`, setup adapts the existing proxy. Starting/recreating shared Caddy
can interrupt all routed sites; that impact needs authorization within the task scope.

Caddy `templates.site` and `templates.config` accept local filenames or `{ inline }` text.
Host template paths resolve relative to the declaring host YAML, including external `$ref`
files. An app's `ingress.caddy.siteTemplate` overrides the host site template and resolves
relative to deploy.yaml after destination selection. Credentials stay in Caddy environment
placeholders, never literal template text. Shared config templates apply only during
provisioning; they do not overwrite existing operator-managed configuration.

## Restore a release or reuse images

```sh
compoza rollback infra --dry-run
compoza rollback infra
compoza rollback infra --release <release-id>
compoza deploy infra --tag <image-tag>
```

- `rollback` requires SSH execution and a successful version-2 release. The default
  predecessor is selected under the stack lock. It restores frozen configuration
  and images with the **currently active** managed snapshot or legacy host dotenv.
  It never restores an earlier password. Host overlays remain live.
- The first upgraded release may have an unsupported older predecessor. Redeploy
  the desired application revision as a new version-2 release; do not run or modify
  the archived wrapper to bypass the format boundary.
- `deploy --tag` works with current local configuration and existing image tags.
  It skips Git/builds and is not a configuration rollback.
- Failed validation preserves the activation pointer. A later failure can leave
  partial container or route changes. Never imply automatic rollback or reversal
  of database migrations. After an authorized recovery, verify status and health.
- Direct `current/compose.sh` calls bypass the CLI lock and promotion. Use only
  when no deployment is active. Inspect a stale lock's owner before removing it.

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
  Preserve legacy aliases only where unambiguous; never merge competing sources.
- Providers resolve on the CLI machine for deployment. SSH snapshots live outside
  releases with mode 0600 under a mode-0700 `.secrets` directory. Lifecycle and
  rollback use that host state without contacting a provider.
- Ordinary checks/dry runs do not fetch secrets. Explicit `check --secrets` reports
  names/status only. Pair `--local` with `--secrets` for local source access;
  `--local` alone skips remote readiness without checking a provider or local Docker.
- Keep 1Password credentials in the operator environment, never app YAML or chat.
  Do not fetch a personal vault just to validate implementation changes.
- Do not print resolved Compose config, snapshot contents, provider exceptions, or
  legacy host validation logs. Managed status omits command/image/container-name
  fields; requested application logs can still contain secrets and need care.

## Diagnose and report

Act on the readiness report's `fix`; a missing app route is repaired by deployment,
whereas DNS, host setup, network and registry failures need correction. SSH hosts
require Bash 3.2+, jq 1.6+ and supported Compose; readiness does not enforce all minimum
versions. Never silently install host dependencies or repeat a failed mutation.

For additional planning detail, use `deploy --dry-run --log-level debug`. It does not
retrieve old output or reveal suppressed diagnostics. Finish with the destination,
operation, verification result, and any unresolved failure; avoid copying secret-bearing logs.

## Cloudflare connector provisioning

Host `ingress["cloudflare-tunnel"].provision` lets `setup-proxy` create the host connector and shared network. It requires a pre-existing remotely managed tunnel and exactly one of `envFile` (private host file with raw `TUNNEL_TOKEN`) or `secrets` (native 1Password/dotenv source, selected `CLOUDFLARE_TUNNEL_TOKEN`). Setup dry runs fetch no secrets or SSH. Real setup sends only the selected token over stdin, checks its account/tunnel identity, guards file/container ownership and waits for the native connection health check. Reruns recreate the shared connector and can briefly affect its applications.

`templates.compose` customizes the hardened connector stack; `templates.route` and app `routeTemplate` customize managed `originRequest` settings. Filenames resolve relative to their declaring YAML. Preserve identity, credential and isolation invariants; differing existing Compose files require explicit reconciliation. `routing: "manual"` leaves dashboard routes untouched and needs no API token or state directory. Managed routing requires the separate host `apiTokenFile` and `stateDir`. DNS, tunnel creation and Access remain operator-owned. Read `docs/cloudflare-provisioning.md` when available.

---
name: deploy
description: Deploy an application with the compoza CLI by resolving its deploy.yaml and destination, checking readiness, previewing the plan, deploying, and verifying the result. Use for a deployment request; use compoza for inspection, recovery, or other operations.
argument-hint: <folder holding deploy.yaml> [--destination <name>]
---

# Deploy with compoza

Use the CLI's rules rather than assembling Docker or SSH deployment commands yourself.
The user's request supplies the app folder, destination, and scope. Ask only for missing
information that cannot be established from the repository or current session.

## Resolve the target

1. Locate `compoza` on `PATH`. Otherwise locate its checkout and invoke
   `node /path/to/compoza/bin/compoza.ts`. The CLI machine needs Node.js 26.0 or newer;
   remote Docker hosts do not need Node.js. Check `--help` before assuming flags.
2. Find the requested `deploy.yaml`, commonly under `infra/` or a central deployment folder.
   If several apps fit and the target is unclear, ask which one. Never guess host addresses.
   Resolve `workingDirectory` relative to that YAML (absolute and `~/` paths also work);
   it defaults to the YAML folder. Git checks and builds use that source directory.
   Compose, assets, dotenv files and app templates stay relative to the YAML.
3. Select the requested `--destination <name>`, or retain the app defaults. Carry the
   same selection through every command. `./hosts.yaml` in the current working directory
   overrides global hosts in `~/.config/compoza/hosts.yaml` by name. Preserve the
   working directory and any explicit `--hosts` or `COMPOZA_HOSTS` selection; explicit
   selection uses one file exclusively. Host entries may reference external files with `$ref`.
   Files linked with `compoza hosts link` are read with the global file; `compoza hosts list`
   shows which file defines the selected host.

Read the tool's README and relevant reference docs when available. This skill is also
usable when copied into an application repository; do not assume those docs were copied.

## Check, preview, deploy

Run these commands for the selected folder, adding the same destination/hosts flags:

```sh
compoza check infra --json
compoza deploy infra --dry-run
compoza deploy infra
compoza status infra
compoza logs infra --tail 50
```

- Stop on a blocking check and follow its `fix`: DNS, host setup, network and registry
  failures need correction. A missing app route is fixed by deploy.
- `setup-proxy` briefly recreates shared Caddy and affects other apps. Obtain approval
  if the session has not already authorized that infrastructure change.
- Explain the target, image transport, and proposed changes from the preview. An SSH
  dry run does not stage files, build images, lock the stack, or validate the full host
  candidate. Do not present it as proof that deployment will succeed.
- Each role with `build` normally requires a clean committed checkout of its source
  repository, and is tagged with that repository's commit. Do not commit changes or add
  `--allow-dirty` without authorization. Stacks whose roles build nothing, and `--tag`
  deploys, need no source checkout or Dockerfile. Status, logs and lifecycle operations
  also work without that source directory.
- A config that still has `targets` fails to load. Propose the migration to `roles`
  (docs/configuration.md, "Migrating from 0.6.0") instead of editing it unasked.
- Once deployment is authorized, continue through verification; do not request the
  same permission again. Report phase failures rather than retrying blindly.
- Success requires the final `Deployed` message and expected service state. Only
  inspect enough logs to verify the result; do not copy sensitive application output.

## Secret handling

- `secrets` selects `env-file`, `1password`, or `none`; app, destination and local
  overrides replace the complete source; sources are never merged. Host-only values
  belong in operator-owned files referenced by absolute Compose `env_file:` paths.
- Production sources require explicit `local.secrets` for `--local`, even when that
  source is `none`. Never use production credentials merely to test a local build.
- Ordinary checks and dry runs do not resolve providers. Use `check --secrets --json`
  only when source access needs verification; add `--local` to test the local source.
  Reports contain names/status only. `--local` alone performs no secret access check.
- Authentication belongs to the operator environment: `OP_SERVICE_ACCOUNT_TOKEN`,
  `COMPOZA_1PASSWORD_ACCOUNT`, or the saved `1password.account` setting
  (`compoza config get 1password.account`). Never place credentials in app YAML, assets,
  image builds, command arguments, or chat. Never read a personal vault just to test
  the CLI implementation.
- Do not print resolved Compose configuration or secret-bearing host diagnostics. Managed
  validation output is discarded; host dotenv diagnostics can contain secrets.

## SSH recovery boundaries

SSH execution needs Bash 3.2+, jq 1.6+, Docker/Compose and the documented host utilities.
Readiness probes do not enforce every minimum version. Registry, SSH image loading,
and remote BuildKit builds are separate from Compose execution mode; remote builds require SSH execution.

SSH deployment normalizes selected Compose files into `<stackDir>/compose.yaml`,
writes private `.env` and declared assets, and keeps one nonsecret `.compoza.json`
for deployed lifecycle settings and the removal operation. An operator overlay remains
separate and live. No releases, activation records, current/previous pointers, backups
or helper scripts are installed. Undeclared folders and operator data are left alone.

The CLI owns only its declared outputs. An unowned `.env` in the stack folder must be
moved to a separate host path and referenced with an absolute `env_file:` path in
Compose or the host overlay, or use a fresh stack folder.
Never overwrite operator data to bypass an ownership error.

Upload and validation failure preserve deployed files. Replacement is in place, and
later failure can leave changed files, containers or routes. Recover using
`deploy --tag <known-image-tag>`, adding `--tag <role>=<tag>` where roles differ, with
the current local configuration and credential source. There is no saved release configuration or rollback command.
Do not promise automatic recovery or reversal of database changes. Lifecycle uses the
deployed files without fetching a provider. Do not remove a lock without establishing
that its owner has exited.

## Handoff

Report the destination, image tag (per role when they differ), verification result,
and URL when configured.
Identify any remaining action, such as publishing a content section. Do not claim
success when a phase failed or cleanup is still required.

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

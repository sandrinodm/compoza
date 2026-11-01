---
name: deploy
description: Deploy an application with the compoza CLI by resolving its deploy.yaml and destination, checking readiness, previewing the plan, deploying, and verifying the result. Use for a deployment request; use compoza for inspection, rollback, or other operations.
---

# Deploy with compoza

Use the CLI's rules rather than assembling Docker or SSH deployment commands yourself.
The user's request supplies the app folder, destination, and scope. Ask only for missing
information that cannot be established from the repository or current session.

## Resolve the target

1. Locate `compoza` on `PATH`. Otherwise locate its checkout and invoke
   `node /path/to/compoza/bin/compoza.ts`. Check `--help` before assuming flags.
2. Find the requested `deploy.yaml`, commonly under `infra/` or an app's deploy folder.
   If several apps fit and the target is unclear, ask which one. Never guess host addresses.
3. Select the requested `--destination <name>`, or retain the app defaults. Carry the
   same selection through every command. `./hosts.yaml` in the current working directory
   overrides global hosts in `~/.config/compoza/hosts.yaml` by name. Preserve the
   working directory and any explicit `--hosts` or `COMPOZA_HOSTS` selection; explicit
   selection uses one file exclusively. Host entries may reference external files with `$ref`.

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
- Built targets normally require a clean committed checkout. Do not commit changes or
  add `--allow-dirty` without authorization. `targets: []` needs no Git or Dockerfile.
- Once deployment is authorized, continue through verification; do not request the
  same permission again. Report phase failures rather than retrying blindly.
- Success requires the final `Deployed` message and expected service state. Only
  inspect enough logs to verify the result; do not copy sensitive application output.

## Secret handling

- `secrets` selects `env-file`, `1password`, or `none`; app, destination and local
  overrides replace the complete source. Do not combine competing legacy aliases.
- Production sources require explicit `local.secrets` for `--local`, even when that
  source is `none`. Never use production credentials merely to test a local build.
- Ordinary checks and dry runs do not resolve providers. Use `check --secrets --json`
  only when source access needs verification; add `--local` to test the local source.
  Reports contain names/status only. `--local` alone performs no secret access check.
- Authentication belongs to the operator environment: `OP_SERVICE_ACCOUNT_TOKEN` or
  `COMPOZA_1PASSWORD_ACCOUNT`. Never place credentials in app YAML, assets,
  image builds, command arguments, or chat. Never read a personal vault just to test
  the CLI implementation.
- Do not print resolved Compose configuration or host validation logs. Managed
  validation output is discarded; legacy host diagnostics can contain secrets.

## SSH recovery boundaries

SSH execution needs Bash 3.2+, jq 1.6+, Docker/Compose and the documented host utilities.
Readiness probes do not enforce every minimum version. Registry, SSH image loading,
and remote BuildKit builds are separate from Compose execution mode; remote builds require SSH execution.

Activation commits a release, predecessor, and secret source together. Failed activation
keeps the old pointer, but containers or routes may already have changed. Do not promise
automatic container rollback or reversal of migrations.

Use `rollback` for supported version-2 release configuration and images with the
**currently active** secrets. Older wrappers require redeploying the intended app
revision as a new release. `deploy --tag` reuses images with current local configuration;
it does not restore archived Compose files. Direct `current/compose.sh` recovery bypasses
the CLI lock and promotion. Do not use it during a deployment or remove a lock without
establishing that its owner is no longer active.

## Handoff

Report the destination, tag/release, verification result, and URL when configured.
Identify any remaining action, such as publishing a content section. Do not claim
success when a phase failed or cleanup is still required.

## Cloudflare connector provisioning

Host `ingress["cloudflare-tunnel"].provision` lets `setup-proxy` create the host connector and shared network. It requires a pre-existing remotely managed tunnel and exactly one of `envFile` (private host file with raw `TUNNEL_TOKEN`) or `secrets` (native 1Password/dotenv source, selected `CLOUDFLARE_TUNNEL_TOKEN`). Setup dry runs fetch no secrets or SSH. Real setup sends only the selected token over stdin, checks its account/tunnel identity, guards file/container ownership and waits for the native connection health check. Reruns recreate the shared connector and can briefly affect its applications.

`templates.compose` customizes the hardened connector stack; `templates.route` and app `routeTemplate` customize managed `originRequest` settings. Filenames resolve relative to their declaring YAML. Preserve identity, credential and isolation invariants; differing existing Compose files require explicit reconciliation. `routing: "manual"` leaves dashboard routes untouched and needs no API token or state directory. Managed routing requires the separate host `apiTokenFile` and `stateDir`. DNS, tunnel creation and Access remain operator-owned. Read `docs/cloudflare-provisioning.md` when available.

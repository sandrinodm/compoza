---
name: deploy
description: Deploy an app to its Docker host with compoza — checks DNS and the shared Caddy, then builds, ships, runs, and routes it.
disable-model-invocation: true
argument-hint: <folder holding deploy.json> [--destination <name>]
---

# Deploy

Deploy the app whose `deploy.json` is in `$ARGUMENTS` with `compoza`. The tool does the work and owns every rule (its `--help` and its `README.md` are the reference); this skill sequences it and stops for the decisions that belong to the user.

## 1. Resolve the app

If `$ARGUMENTS` is empty, look for `deploy.json` files in the repository (for example `infra/deploy.json` or `apps/*/deploy/deploy.json`) and ask which one to deploy.

Done when one folder with a `deploy.json` is chosen. If it has `destinations`, resolve the requested destination or use its app defaults; carry the same `--destination <name>` through every app command. Never guess SSH aliases or host paths. Explicit user authorization in the current session takes precedence over confirmation prompts below.

## 2. Check readiness

```sh
compoza check <folder> --json
```

The ordinary command is read-only and does not access a provider. Explicit `check --secrets` verifies source access and reports names only. Each entry in `checks` has `ok`, a `detail`, and a `fix` naming who resolves a failure. SSH hosts require Bash 3.2+ and jq 1.6+; the report probes Docker/Compose support, jq availability, selected host paths and optional curl/Buildx. It does not enforce minimum Bash/jq versions. It does not stage or validate the candidate against production secrets. Exit code 2 means at least one check besides `route` failed. Act on every failed check by its `fix`:

- `dns`: public A/AAAA lookup returned no answer, or an optional configured address assertion did not match. Check the diagnostic and intended DNS/CDN setup; do not assume DNS should point directly to the Docker host. DNS changes require user authorization.
- `setup-proxy`: the host's shared Caddy cannot load per-app site files yet. This is a one-time change per host. Explain that `compoza setup-proxy <host>` backs up the proxy's Caddyfile and Compose file, adds a `sites/` import and mount, validates with a throwaway Caddy, and recreates the Caddy container, which briefly interrupts every site on the host. Ask for approval with AskUserQuestion; run it only on a yes, then rerun the check.
- `manual`: a missing proxy folder, network, or registry login. Report the `detail` and stop; these need a person on the host.
- `deploy`: the app's route file is missing or outdated. The deploy writes it; no action.

Done when the check exits 0, or you have stopped and told the user which check blocks and why.

## 3. Preview

```sh
compoza deploy <folder> --dry-run
```

Show the user the image tag, the host, and the route the dry run prints. Built targets need a clean checkout because images are tagged with the commit. Third-party-only `targets: []` stacks need no Git or Dockerfile. `--tag` reuses images with current local config; it is not a release rollback. An SSH dry run performs no writes, locks, staging or builds, and cannot fully validate the candidate against the host dotenv/overlay. If the tool reports uncommitted changes, ask whether to commit first or deploy with `--allow-dirty`.

Done when the dry run completes and the user has seen what will change.

## 4. Deploy

```sh
compoza deploy <folder>
```

The tool rechecks readiness, builds and ships images using the host transport, runs Compose, and, for a `caddy-sites` ingress, replaces the Caddy route under a shared proxy lock, uses a validating reload, and waits up to three minutes for the URL. A rejected reload restores the prior file and attempts a recovery reload. Failed recovery retains the lock and private recovery files for inspection. Long-lived connections depend on the configured drain and streaming policy. Coordinate old frozen release scripts and manual writers separately because they may not use the shared lock. With `execution: "ssh"`, it takes the per-stack lock, stages selected Compose files plus declared non-secret assets in a versioned host release, validates using the selected protected host secret source and live overlay files, and waits for Compose running/healthy services before routing and any independent host HTTP probe. The successful release is promoted only after those checks. `remote-build` builds with the host default BuildKit builder; registry and ssh-load use the same SSH Compose workflow.

Done when the final `Deployed` line prints (SSH includes its release ID) and `status` shows the containers up. On failure, report the failing phase and output. SSH failures retain the previous successful current pointer, but containers or routes may already be partially changed; do not claim automatic rollback or undo data migrations. Do not print resolved Compose config or copy host `validation.log` into chat: it can contain secrets, even though normal/debug command output suppresses it. Inspect status/logs first.

For SSH release recovery use `compoza rollback <folder> [--release <id>]` with the same destination, previewing with `--dry-run`. This restores a supported version-2 release’s archived Compose config, profiles and image references while using the currently active secret source and live host overlay. `deploy --tag` retains current local config. Lifecycle commands use the deployed host wrapper and ignore local Compose edits. Delete retains data, host secrets and releases; named volumes go only with explicit `--volumes`. Do not clear a stale deployment lock without confirming no deployment is active.

## 5. Report

Give the user the URL, the deployed tag, and anything that still needs them, such as publishing content into a section named in `deploy.json` `content`.

## Host activation and private diagnostics

SSH promotion atomically switches one `current` link to an immutable activation record, which binds its successful
release and predecessor together. `current/compose.sh` dispatches through the active source and `current/manifest.json` retains manifest access;
`current/previous` names the rollback predecessor. Default rollback selects it under the same mutation lock. An
interruption around promotion leaves the old or new complete state; it never mixes release and predecessor identities.
Explicit rollback to the current release reapplies validation, Compose, routing and health to recover partial container
changes while retaining its predecessor. Managed secrets remain a retained host snapshot; legacy host dotenv and overlays remain live operator files.

Status/logs and lifecycle commands silently prevalidate the live host config before streaming output. Inspection
creates no host diagnostic files or locks; malformed dotenv diagnostics may contain literal secrets and must remain
suppressed. Managed lifecycle diagnostics are suppressed and status emits only service/state/health/exit code. Application logs still stream once config validation succeeds. Optional absolute service env files with
`required: false` may be absent; relative env-file paths are never allowed. Keep activation records as well as release
files during deletion and manual cleanup unless they are demonstrably unreferenced.

## Secret sources and recovery

Carry the selected destination through secret access checks. `secrets` at app/destination/local selects a complete
`env-file` or `1password` provider; `none` deliberately clears it. Do not combine it with legacy aliases at the same
level. Local runs with a production source require explicit `local.secrets`, including `none` when appropriate. Explicit
sources disable implicit Compose `.env` discovery, preventing production fallback for missing development keys.

Ordinary checks and dry runs never fetch secrets. If source access needs verification, run
`compoza check <folder> --secrets --json` (add `--local` for local source access). This reads on the CLI machine
and prints names/status only; it works before the first managed SSH snapshot exists. It does not validate the complete
candidate. Pair `--local` with `--secrets`; `--local` alone skips remote readiness without testing a provider or local
Docker. Do not display resolved values, SDK exception details or secret-bearing Compose output. Multiline/CR/NUL
values and collisions with configured variables or deployment controls are rejected; fix sources privately.

1Password authentication is operator-owned: `OP_SERVICE_ACCOUNT_TOKEN` for automation, or
`COMPOZA_1PASSWORD_ACCOUNT` with an unlocked desktop app for interactive use. Never add credentials to
`deploy.json` or fetch a personal vault merely to validate this implementation. SDK imports are optional and lazy;
real-provider integration needs an explicitly authorized disposable Environment.

SSH managed snapshots live mode 0600 under `<stackDir>/.secrets` (0700), outside release bundles. Activation commits
release, predecessor and effective source together. Failed fetch/validation retains the active source. Lifecycle,
inspection and rollback do not contact the provider. Rollback uses old config/images with the currently active source;
it never restores old passwords. The Bash/jq runtime executes only version-2 release wrappers; older releases must
be deployed again before inspection, lifecycle or rollback can use them. Those commands reject older wrappers before
Compose runs. A fresh deploy reads existing activation metadata and upgrades it using the newly selected source. The first upgraded
release may have an unsupported older predecessor; redeploy the desired application revision as a new version-2
release instead of invoking that wrapper. `deploy --tag` still uses current local config. Do not invoke archived wrappers
directly; they retain their historical runtime requirements. Explicit none/legacy deployments clear or replace the source without old-snapshot fallback.
Delete keeps snapshots. Managed validation output is discarded; legacy host validation logs stay private on the host.
Never describe source activation as atomic container rollback or claim reversal of migrations.

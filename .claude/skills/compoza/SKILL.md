---
name: compoza
description: Deploy, inspect, stop, start or delete a Compose stack on a remote Docker host with the compoza CLI. Use when asked to deploy an app to a server, check whether it is ready to deploy, roll back, see what is running or read its logs, or take a deployed stack down.
---

# compoza

`compoza` takes a Compose stack from a Git checkout to a remote Docker host over SSH: readiness checks, images
tagged with the commit, build and ship, `docker compose up` on the host, optional Caddy routing, and configured health checks. It also
stops, starts and deletes what it deployed. The tool owns every rule; its `--help` and `README.md` are the reference.

Caddy host `templates.site` and `templates.config` accept local filenames or `{ inline }`
text; paths resolve relative to the declaring host JSON (including external references).
App `ingress.caddy.siteTemplate` resolves relative to deploy.json after destination selection.
Templates use literal variables and sections; credentials remain Caddy environment placeholders.
Shared config templates apply only during provisioning and never bypass existing-file checks.

## Locate the tool and the app

- The CLI is `compoza` on `PATH` when linked. Otherwise locate the tool checkout and run
  `node /path/to/compoza/bin/compoza.ts`; do not assume a particular checkout directory.
- An app opts in with a folder holding `deploy.json` next to its Dockerfile and Compose files, usually `infra/` or
  `apps/<app>/deploy/`. Find it with a glob for `**/deploy.json` (ignore `node_modules`). Every app command takes that
  folder as its first argument; `publish` requires it, the others default to the working directory.
- Global hosts live in `~/.config/compoza/hosts.json`; `./hosts.json` in the current working directory
  overrides complete entries by name. Preserve that directory across commands. `--hosts` or `COMPOZA_HOSTS`
  selects one file exclusively. Entries may use `{ "$ref": "path" }` for a single external host config, relative
  to the containing file. If configuration is missing or a host is unknown, ask the user for missing details;
  SSH destinations and addresses are never guessed.
- Select `--destination <name>` when requested; propagate it through check/deploy/status/logs/lifecycle/publish/rollback.
  App defaults remain valid without it. Destinations can select a different host, project, Compose files, profiles,
  host paths and ingress. Never infer production host addresses or secret paths.
- `execution` defaults to `client`, retaining existing behavior. In `ssh` mode, selected Compose definitions and
  explicitly declared non-secret `assets` form a versioned host release; the host's own Compose CLI runs it.
  `registry`, `ssh-load` and `remote-build` determine image delivery independently; `remote-build` explicitly targets
  the host default BuildKit builder and transfers source with `.dockerignore`, without full-source rsync.
- `secrets` selects client-resolved dotenv or 1Password Environments in either execution mode. Legacy `envFile` is a
  client dotenv alias; legacy SSH `remote.envFile` (or optional `<stackDir>/.env`) remains host-owned. Never download,
  print or overwrite legacy host dotenv. Never put secrets into assets, configured non-secret environment or builds.
- Relative release mounts must be declared read-only files; persistent mounts use absolute host paths. Use selected
  overlays rather than Compose include/external extends. SSH hosts need Bash 3.2+, jq 1.6+, Docker/Compose wait/config support,
  base64 and optional curl/Buildx. `check` probes jq availability and selected runtime/path requirements without
  writes; it does not enforce minimum Bash/jq versions or exhaustively check every system utility.
- Session authorization takes precedence over confirmation prompts in this skill; do not ask again for actions the
  user already authorized.

Done when the command runs and the deploy folder is known.

## Deploy

Run the steps in order and stop at the first one that fails.

1. **Check** (read-only):

   ```sh
   compoza check <folder> --json
   ```

   SSH execution also checks host runtime and host env/overlay paths. Ordinary probes do not access providers or fully validate the candidate until staging; explicit `check --secrets` verifies access and reports names only. Exit code 2 means a check other than `route` failed. Each entry has `ok`, `detail` and `fix`:
   - `dns`: the user must create an A record with the address in `detail`; ask, then rerun.
   - `setup-proxy`: shared ingress needs preparation. Preview with `compoza setup-proxy <host> --dry-run`
     without opening SSH. Caddy `ingress.caddy.provision` bootstraps a fresh stack, network and persistent storage;
     its credential env file must already exist. It refuses differing existing files and foreign containers.
     Without `provision`, setup adapts the existing proxy. Starting/recreating shared Caddy can interrupt all routed
     sites; confirm that impact only if it is outside the user's existing authorization.
   - `manual`: a missing proxy folder, network or registry login needs a person on the host. Report `detail` and stop.
   - `deploy`: the route file is missing or outdated; the deploy writes it, no action.

2. **Preview**:

   ```sh
   compoza deploy <folder> --dry-run
   ```

   Show the user the tag, the host and the planned commands. Built targets need a clean checkout with at least one commit; third-party-only `targets: []` needs no Git, build context or Dockerfile. An SSH dry run performs no builds, locks, staging, host writes or Compose mutation, and cannot fully validate candidate configuration against host dotenv/overlay. For built targets,
   if the tool refuses a dirty one, ask whether to commit first or use `--allow-dirty`.

3. **Deploy**:

   ```sh
   compoza deploy <folder>
   ```

   Output is numbered phases, `[n/total] <title> … ok (duration)`, with the `$ …` command lines inside them and a
   final `Deployed <app> <tag> …` line (SSH includes a release ID). A failed phase prints `… failed` and the error; report the phase and the
   output, do not retry blindly. For more detail on a future preview, use `deploy --dry-run --log-level debug`.
   Debug mode does not retrieve past output or reveal suppressed secret-bearing diagnostics; do not repeat a real
   deployment solely to obtain more logs.

4. **Verify**: `compoza status <folder>` lists the containers; `compoza logs <folder> --tail 50` shows
   recent logs (`--service <name>` for one, `--follow` to stream).

Done when the `Deployed` line printed and `status` shows the containers up.

## Roll back

For SSH execution, preview then restore a successful versioned release, keeping the destination consistent:

```sh
compoza rollback <folder> --destination <name> --dry-run
compoza rollback <folder> --destination <name> [--release <id>]
```

Omitting `--release` selects the previous successful release; the selected release must use the version-2 format. This restores archived Compose files, profiles, project,
non-secret configured variables and image references. The current secret source and live host overlay are retained; images
must still be available. Data migrations are not reversed. Release IDs print during deploy; manifests live under
`<stackDir>/releases/<id>/manifest.json`. Host `current/compose.sh` is the activation recovery dispatcher using the current source with frozen release Compose args.
Direct `current/compose.sh` calls bypass the CLI lock and promotion. Use them only when no deployment is active;
do not remove a stale lock until that is confirmed.

The existing image-reuse command works in either execution mode:

```sh
compoza deploy <folder> --tag <earlier tag>
```

It skips Git and builds, reuses existing images and applies the **current local configuration**. It does not restore
an earlier release's Compose files. Commit tags use the first twelve characters of the commit SHA.

## Stop, start, delete

```sh
compoza stop <folder>              # containers halt; networks, volumes, images and route stay
compoza start <folder>             # the stopped containers resume
compoza delete <folder> [--volumes]   # route, containers and networks go; host data folders stay
```

All three take `--dry-run` and `--destination`. SSH commands use the deployed host manifest/wrapper and ignore undeployed local Compose edits. Delete keeps host secrets, overlays and all release files as well as bind-mounted data. `delete` is destructive: confirm with the user before running it, and say whether
`--volumes` is included (it removes the project's named volumes; bind-mounted host folders listed in `deploy.json`
are never removed). A deleted app comes back with `deploy`.

## Publish content

Apps with `content` sections in `deploy.json` take files from this machine:

```sh
compoza publish <folder> <section> <local folder> --dry-run   # lists changes; *deleting marks removals
compoza publish <folder> <section> <local folder>
```

Show the user any `*deleting` lines before publishing for real.

## When something is off

- `ssh … exited with 255` or a password prompt: the host needs key authentication (`BatchMode`); ask the user.
- `Not ready to deploy: …`: run `check` and act on the `fix` of each failure as above.
- `did not respond successfully within 180 s`: the stack is up but the URL is not answering; check `logs`, and the
  Caddy site file the dry run prints.
- The tool refuses a `deploy.json` with unknown keys. If one still has top-level `domain` and `upstream`, move them
  under `"ingress": { "mode": "caddy-sites", "domain": …, "upstream": … }`.

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
Compose runs. A fresh deploy reads existing activation metadata and upgrades it using the newly selected source. Its first
predecessor may still be unsupported; redeploy the desired application revision as a new version-2 release.
`deploy --tag` still uses current local config. Do not invoke archived wrappers
directly; they retain their historical runtime requirements. Explicit none/legacy deployments clear or replace the source without old-snapshot fallback.
Delete keeps snapshots. Managed validation output is discarded; legacy host validation logs stay private on the host.
Never describe source activation as atomic container rollback or claim reversal of migrations.

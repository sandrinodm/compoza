# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vp node <file>` runs plain Node.js.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

# compoza

Read `README.md` for the quickstart and commands. Detailed references live in `docs/configuration.md`,
`docs/ingress.md`, `docs/caddy-templates.md`, `docs/secrets.md`, `docs/ssh-deployment.md` and `docs/development.md`. Portable skills live in `.claude/skills/`
and `.agents/skills/`; keep both aligned with command behavior. Rules that are not obvious from the code:

- Effect 4 (`effect@4.1.1`): `effect/cli`, `effect/process` and `effect/http` are subpaths of the `effect` package;
  `Context.Service` defines services, each with a `static layer`. Verify APIs against `node_modules/effect/ai-docs`
  and the `.d.ts` files rather than memory of Effect 3.
- The tool runs under Node type stripping, no build step: `.ts` extensions in relative imports, `import type` for
  types, no enums or parameter properties (`erasableSyntaxOnly` enforces this). `bin/compoza.ts` is the
  executable.
- Planning is pure, execution is a service. `plan.ts`, ingress extension folders, `checks.ts` and `command.ts` build commands,
  scripts and checks from values and are tested without Docker or SSH; only `services/Shell.ts` and
  `services/Remote.ts` spawn processes. Keep new behaviour on that side of the line so `--dry-run` stays a faithful
  preview.
- Local commands go through `Shell.run`; SSH transactions go through `Remote.run`. Both honor `DryRun`. Read-only
  calls use `Shell.capture` or `Remote.probe`. Client Compose secrets are environment values masked by `secret`;
  managed SSH secret bytes travel only in the private transaction stdin, never command arguments or printed payloads.
- Scripts sent to a host run under `bash -c` (see `Remote`); never assume the login shell. Quote with `shellQuote`.
- SSH host logic lives in `src/remote/runtime.sh` and jq filters, loaded relative to the CLI module by TypeScript planners and frozen
  into each release. Target Bash 3.2 and jq 1.6 on Linux/macOS; do not add Python, GNU-only utilities or shell eval.
  Keep secret payloads on stdin, JSON parsing in jq, and filesystem checks in Bash. Promotion must replace the
  current symlink itself, including when it points to a directory; ordinary `mv source current` can follow it.
- Global hosts (`~/.config/compoza/hosts.json`) are overlaid by `hosts.json` in the current working directory,
  replacing complete hosts by name. `--hosts` or `COMPOZA_HOSTS` selects one file exclusively. Host entries can
  use `{ "$ref": "path" }` to reference one complete host config, relative to the containing file. `deploy.json` is
  per app, next to its Dockerfile and Compose files.

## Tooling and comments

- Documentation describes product behavior, trade-offs and operating procedures. Omit dated review notes, session
  histories and research activity counts; retain useful source links and reproducible verification instructions.
- Tooling is Vite+ only: format, lint, type check and test through `vp` (`vp check`, `vp test`, `vp run`). Never
  call prettier, eslint, vitest or biome directly.
- Run `pnpm check` before committing: it runs `vp check`, then `jsdoc-lint` (configured in `jsdoc.json`). The
  pre-commit hook runs both on staged files.
- Every function, class, interface, type alias, top-level `const`, class member, and member of a service's inline
  shape gets a multiline `/** … */` block; a single-line `/** X. */` counts as missing. Leave a blank line between
  documented members.
- Functions open with a present-tense verb ("Reads the …"); types, fields and constants open with a noun phrase
  ("The HTTP request …"). Constants give their unit, meaning and limits.
- A second paragraph says why: invariants, defaults and their consequences, and what is deliberate. Cite verified
  facts where a claim is not obvious.
- No `@param`, `@returns` or `@example`: prose plus types. Describe behaviour and edge cases, never restate the type,
  and drop any comment that adds nothing to the signature.
- Error classes say when the error happens; services describe what they are, who owns them and the trade-off;
  commands say what they do and why a constraint exists.
- Backticks around identifiers, full sentences ending with a period. Inline `//` comments only for a non-obvious
  "why" inside a body.
- No banner or separator comments; a file that needs sections is too big: split it.

## Verification

- `vp test` includes real Bash/jq integration tests with fake Docker and temporary files. The integration groups use
  a 15-second per-test timeout; other tests use five seconds. Compose parser tests are conditional on CLI availability.
  Tests do not deploy live stacks or access real providers. Verify Bash 3.2 compatibility and both platform-specific
  atomic rename paths when changing host behavior; preserve the no-Python and secret-isolation regressions.

## SSH releases

- `execution` defaults to `client`; `ssh` is independent of `registry` / `ssh-load` / `remote-build` transport.
  Resolve destinations before host lookup. Keep the app name as the shared image prefix; use `projectNameOf` for the
  Compose project and Caddy site identity.
- `bundle.ts` reads only selected Compose files and explicit non-secret assets, with bounded size/count and no
  symlinks, dot paths, implicit includes or directory recursion. Do not add a full-tree sync or rsync deletion.
- `ssh-plan.ts` constructs transaction plans from configuration and tool-owned runtime assets; it never reads host
  state or executes processes while planning. It stages restrictive-permission releases and a recovery wrapper; managed secrets resolve only on the CLI machine and transfer over stdin into protected snapshots outside releases.
  Legacy host dotenv is read only by host Compose. The resolved Compose JSON stays on the host, managed-source
  validation diagnostics are discarded and legacy diagnostics stay private on the host, even in debug output. Do not log the transaction input or resolved model.
- SSH mutations share a portable mkdir lock. Validate before Compose mutation, use `up --wait --wait-timeout`, and
  promote one current symlink to an immutable activation record only after route/HTTP readiness. The record binds the release and predecessor together; default rollback resolves it under the mutation lock. Failures preserve the prior pointer
  but can partially change containers or routes; never describe this as atomic container rollback or undo migrations.
- Lifecycle and inspection use the deployed wrapper rather than local Compose files. Delete keeps secrets, data and
  all releases; only explicit `--volumes` removes named volumes. `rollback` restores release config and refs with the currently active secret source;
  `deploy --tag` still means image reuse with the current local config.
- `remote-build` forces `docker --host ssh://… buildx build --builder default --load`, clearing client Docker/Buildx
  selection overrides. BuildKit owns dockerignore-aware source transfer. Empty targets skip Git and all builds.
- `Remote.run` optionally streams progress without retaining output; `probe` remains read-only. Follow logs stream
  through `Shell.run` with a concise display label. Never route a mutating transaction through `probe`.
- Dry runs may probe readiness and read local declared assets, but never stage, lock, create host directories or build.
  Explicitly state that full candidate validation needs staging with the host env/overlay.

- SSH inspection and direct recovery wrappers silently prevalidate live host configuration before streaming any
  command. Inspection stays read-only and must never create diagnostic files; malformed dotenv errors can contain
  literal secrets. Application log streams still reach the terminal after validation succeeds.
- Optional absolute service env files honor Compose `required: false`; missing optional files are allowed without
  weakening absolute-host-path rules or checks for present/required files.
- Reapplying the current release with explicit rollback still runs validation, Compose, route and health recovery.
  Skip only activation-history promotion in that case, preserving the existing predecessor. Never skip recovery just
  because the successful pointer already names the requested release.

## Secret source invariants

- `config/secrets.ts` owns source selection, local-source isolation and validation. credential extension folders own
  provider reads and optional lazy SDK loading; `extensions/credentials.ts` registers providers and authentication prefixes.
  App/destination/local `secrets` objects replace complete sources; reject ambiguous legacy aliases. A production source
  requires explicit `local.secrets` for local runs; `secrets: { none: {} }` deliberately clears it (legacy `provider: none` also works).
- 1Password uses official SDK 0.5.0 structured `environments.getVariables`; `masked` is display metadata. Authentication
  belongs to `OP_SERVICE_ACCOUNT_TOKEN` or `COMPOZA_1PASSWORD_ACCOUNT` in the operator environment. Never add
  credentials to app/host JSON or forward provider auth to child processes. SDK exceptions must never reach diagnostics.
- Dry runs and normal checks fetch/read no secret source. Only real deploys or explicit `check --secrets` resolve it;
  report names/status only. Real-provider integration is unverified without an authorized disposable Environment.
- Reject duplicate/invalid/reserved names, nonsecret/image/control collisions, multiline/CR/NUL values. Preserve literal
  dollars, quotes, backslashes and empty strings. Dotenv parser failures never include raw lines or values.
- Client secrets are Compose-only, with subprocess stdout/stderr suppressed and implicit `.env` disabled for explicit
  source selections (including `none`). Never attach resolved secrets to builds,
  transport, printed arguments, manifests, release assets or debug logs. Keep SDK auth out of all child environments.
- `ssh-secrets.ts` plans source selection; `compoza_stage_secret` in `src/remote/runtime.sh` writes mode-0600 snapshots
  under a mode-0700 `.secrets` store and rejects any existing target. Immutable activation metadata
  binds release/predecessor/source at the existing sole commit point. Failed fetch/validation preserves active source;
  managed validation diagnostics are discarded. Lifecycle uses the host snapshot without contacting any provider.
- Rollback always uses the current effective source with older supported config/images. Execute only version-2
  Bash/jq release wrappers; reject earlier wrappers before Compose with redeploy guidance, without parsing or
  executing archived shell code. Read existing activation metadata to allow a fresh deploy to upgrade it. Explicit
  none/legacy transitions must not reuse an old snapshot.
  Preserve legacy host-dotenv behavior and the existing partial container/route failure caveats.

- Legacy activation upgrades use the new deployment's configured secret source; do not infer a source by parsing
  archived shell wrappers. After the first version-2 deploy, its old predecessor remains unsupported; redeploy an
  older app revision as a new version-2 release when needed. Never claim `deploy --tag` restores archived config.
  Managed lifecycle output is suppressed;
  status privately projects service/state/health/exit code. Explicit application log stdout remains visible.

- Named extension config uses `ingress.caddy`, `ingress["cloudflare-tunnel"]`, `secrets["1password"]` and
  `secrets["env-file"]`. Select exactly one extension per block; `{ none: {} }` opts out. Host `ingress` cannot coexist
  with legacy `proxy`. Resolve named settings before dispatch and preserve compatibility with old flat selectors.

- Caddy `ingress.caddy.provision` bootstraps a fresh shared proxy via `extensions/caddy/provision.ts` and `provision.sh`.
  It validates before installing files, refuses differing existing configuration or foreign containers, and preserves
  site routes, data and credentials on repeat runs. Host env-file contents and Docker/Caddy validation diagnostics
  must not reach CLI output. `setup-proxy --dry-run` does not open SSH. Without `provision`, retain existing-proxy setup.

- Caddy templates are loaded through extension file-resolution hooks before pure planning. Host paths are relative
  to the winning host JSON (including external references); app paths are relative to deploy.json after destination
  selection. Preserve site template compatibility; document changes to fresh-stack production defaults. Template substitution never evaluates code or environment,
  never recursively renders replacement values, and leaves single-brace Caddy placeholders untouched.

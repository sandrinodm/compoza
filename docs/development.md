# Development

[README](../README.md) · [Configuration](configuration.md) · [Ingress](ingress.md) · [Caddy templates](caddy-templates.md) · [Secrets](secrets.md) · [SSH deployment](ssh-deployment.md)

## Requirements

- Node.js 22.18 or newer; Node runs the TypeScript directly.
- pnpm 12 (`devEngines` downloads it when missing).
- Bash, jq and standard Unix utilities for the host-script tests.
- Optionally, the Docker Compose CLI for the parser tests.

## Commands

```sh
pnpm install
pnpm check                # vp check (format, lint, types), then jsdoc-lint
vp check --fix             # apply formatting and safe lint fixes
vp test                   # unit tests and isolated Bash/jq host-script regressions
pnpm build                # JavaScript distribution with runtime assets
node bin/compoza.ts --help
```

The pre-commit hook runs `vp check --fix` and `jsdoc-lint` on staged files.

## Source layout

| Path                      | What it is                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `bin/compoza.ts`          | The executable                                                                          |
| `src/cli.ts`              | The commands and their flags (`effect/cli`)                                             |
| `src/deploy.ts`           | The deploy pipeline                                                                     |
| `src/publish.ts`          | `publish`: rsync of a local folder into a content section                               |
| `src/ssh-plan.ts`         | Plans uploads and host runtime calls for deploy, lifecycle and rollback                 |
| `src/ssh-runtime.ts`      | Loads versioned host assets for planning and release staging                            |
| `src/remote/`             | Bash state, validation, locking and activation; jq JSON filters                         |
| `src/ssh-state.ts`        | Planning adapter for the host runtime's checked state lookup                            |
| `src/ssh-deploy.ts`       | SSH execution pipeline and deployed-release inspection                                  |
| `src/bundle.ts`           | Bounded explicit Compose asset loading and path validation                              |
| `src/plan.ts`             | Builds the Docker commands of a deployment from configuration                           |
| `src/extensions/`         | Ingress integrations and credential providers                                           |
| `src/checks.ts`           | Readiness checks                                                                        |
| `src/command.ts`          | Commands as plain values, how they print, and `shellQuote`                              |
| `src/wait.ts`             | The wait for the public URL after a deploy                                              |
| `src/config/`             | Configuration loading, secret selection and validation                                  |
| `src/services/`           | `Shell` (local), `Remote` (SSH: `run` honours `--dry-run`, `probe` is read-only), `Git` |
| `.claude/skills/deploy/`  | Claude Code `/deploy` skill: a guided deploy for a person at the keyboard               |
| `.claude/skills/compoza/` | Claude Code `/compoza` skill for deployments and operations                             |
| `.agents/skills/deploy/`  | Codex `$deploy` skill, the guided variant                                               |
| `.agents/skills/compoza/` | Codex `$compoza` skill for inspection, recovery and operations                          |

## Extensions

Docker and Compose deployment remain the standard implementation. Integrations live under `src/extensions/` and register at two boundaries:

| Extension kind      | Contract and registry                                  | Bundled implementations            |
| ------------------- | ------------------------------------------------------ | ---------------------------------- |
| Credential provider | `src/extensions/credentials.ts` (`CredentialProvider`) | `env-file`, `1password`            |
| Ingress             | `src/extensions/ingress.ts` (`IngressExtension`)       | `caddy-sites`, `cloudflare-tunnel` |

Each integration owns one folder, including its configuration and implementation:

```text
src/extensions/
  1password/          config.ts, index.ts
  env-file/           config.ts, index.ts
  caddy/              config.ts, index.ts, checks.ts, scripts.ts, route.sh, provision.ts, provision.sh, templates.ts, templates/, tests
  cloudflare-tunnel/  config.ts, index.ts, runtime.sh, merge.jq, cloudflare.test.ts
  config.ts           supported configuration schemas
  credentials.ts      credential contract and registry
  ingress.ts          ingress contract and registry
```

These are bundled, source-level extensions. There is no package discovery, install command or arbitrary module loading from application JSON. Adding another implementation means shipping it with the CLI; existing configuration remains compatible.

### Credential providers

The core selects the effective source, enforces explicit local overrides, skips reads for dry runs, validates returned names and values, and supplies credentials only to Compose. A provider resolves its source on the CLI machine and returns a variable map. Provider errors must contain safe diagnostics, never raw SDK errors or secret values. Optional SDKs must load only inside a real read.

Each provider declares the environment prefixes used for operator authentication. The core masks and strips those variables from subprocesses for **all** registered providers, even when a different provider is selected.

To add a provider:

1. Add its implementation and configuration schema under `src/extensions/<provider>/`.
2. Include its named selection schema in `SecretsConfig` and its normalized input in `ResolvedSecretsConfig` in `src/extensions/config.ts`; add its settings resolution there.
3. Register its implementation in `credentialProviders`. The registry's type requires an entry for every supported provider selector.
4. Test resolution, safe failures, dry-run isolation, local overrides and authentication isolation with a fake provider client.

`secrets: { "none": {} }` is a core empty-source selection and invokes no provider.

### Ingress extensions

An ingress extension supplies pure plans for readiness probes, host setup, route activation, removal and an optional public health URL. The core runs these plans through `Remote`, preserving dry-run behavior. SSH releases freeze the generated activation and removal scripts, so recovery uses the deployed version's operations. Scripts must support Bash 3.2, and ingress configuration must contain no credentials; secret snapshots remain a separate core channel.

To add ingress:

1. Add the implementation and app/host configuration schemas under `src/extensions/<ingress>/`.
2. Include its named app/host schemas in `Ingress` and `HostIngress` in `src/extensions/config.ts`. Add its normalized input to `ResolvedIngress` / `ProxyConfig` and extend the corresponding resolution functions. Keep legacy configuration accepted during migration.
3. Register the implementation in `ingressExtensions`, covering setup, probes, check interpretation, activation and removal. Check failures with `fix: "deploy"` are repaired by deployment and do not block it; other failures block.
4. Test both client execution and frozen SSH operations, including route failure, removal and recovery.

Apps and hosts select Caddy through `ingress.caddy`, or Cloudflare through `ingress["cloudflare-tunnel"]`, with settings nested under the extension name. Credential sources use `secrets["1password"]` and `secrets["env-file"]`. Exactly one extension is allowed per block. Omitted ingress or `{ "none": {} }` bypasses ingress. Legacy flat selectors and host `proxy` entries normalize to the existing internal contracts, so planners and frozen SSH scripts preserve their behavior. `setup-proxy` dispatches to the host's selected extension and remains explicit.

### Caddy implementation

Caddy's optional host `provision` settings dispatch to `extensions/caddy/provision.ts` and `provision.sh`. Planning generates non-secret Compose/Caddyfile content; the host script validates it with credentials from an existing host env file. Bootstrap never overwrites differing files or adopts another stack's container. Repeat runs retain per-app routes and persistent storage. `setup-proxy --dry-run` renders the planned script and input without opening SSH. Provisioning remains separate from ordinary app deployment and from the legacy existing-proxy setup script.

Caddy defaults live in `extensions/caddy/templates/*.tmpl`. Host `templates.site`/`templates.config` and app `siteTemplate` accept filenames or `{ inline }` sources. Extension configuration loading resolves winning host files relative to their declaring JSON and app files after destination selection, replacing paths with inline text before pure planning. The renderer supports literal variables and truthy/inverted sections; it never evaluates JavaScript, shell code or environment variables. Frozen SSH routes contain the rendered configuration, not local template dependencies.

Route mutations run the frozen `route.sh` runtime under the same proxy lock as setup. Files are staged and renamed before a validating reload; failures restore the file and attempt a recovery reload. Recovery failure retains the lock and private staging directory. Fresh stacks have healthchecks, bounded logs and explicit drain budgets.

Operator guides: [Ingress](ingress.md), [Caddy templates](caddy-templates.md) and [Caddy production operations](caddy-production.md). The production guide also documents the opt-in real-Docker smoke test.

## Tests

- **Host-script tests** run real Bash and jq against temporary directories and a fake Docker executable. They cover activation, rollback, secret isolation, malformed metadata, and execution with Python blocked.
- **Optional Compose parser tests** run `docker compose config` when the Docker CLI is available.
- **Limits:** no test deploys a live stack or accesses a secret provider. 1Password behavior is covered through SDK API/type checks and mocked integrations only.
- The multi-process integration groups use a 15-second per-test limit; ordinary unit tests keep five seconds.

## Host runtime conventions

- Edit host behavior in `src/remote/runtime.sh` and its jq filters, and keep launch parameters in `compose.json` as data.
- Do not regenerate executable code from configuration or add Python dependencies.
- Remote actions run under `bash -c` regardless of the login shell, so scripts must not depend on the login shell.
- New releases freeze `runtime.sh`, `model.jq`, `status.jq` and `compose.json`; changes affect only releases deployed afterwards. The runtime executes only version-2 release wrappers; see [Upgrading older SSH releases](ssh-deployment.md#upgrading-older-ssh-releases).

## Distribution

`pnpm build` uses Vite+ pack to compile the CLI to `dist/bin/compoza.mjs`, preserving the module layout and copying Bash, jq and template assets beside their modules. Development can still run `node bin/compoza.ts`; installed packages run JavaScript because Node does not strip TypeScript inside `node_modules`.

Use `pnpm pack`, which builds through `prepack` and resolves `catalog:` dependency versions. Do not publish the source directory with `npm publish`.

```sh
pnpm pack --out /tmp/compoza.tgz
pnpm test:package /tmp/compoza.tgz
```

The package smoke check installs the tarball into a temporary consumer, runs the installed executable, checks dependency versions and compares every runtime asset with its source.

## CI and npm releases

`ci.yml` checks formatting, lint, types and JSDoc, runs the test suite on Linux (Node 22.18, 24 and 26) and macOS (Node 24), and builds and installs the npm tarball on every matrix entry. Bash and jq are required; no personal hosts or provider credentials are used.

`publish.yml` publishes stable GitHub releases through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). It requires the tag `v<package.json version>`, a commit on `main`, and a successful push-triggered CI run for that exact commit. It reruns checks and tests, builds with pnpm, verifies the installed package, and publishes that tarball with provenance. Manual workflow dispatch is available for retrying a release; select its **tag**, not `main`.

One-time setup:

1. Create the GitHub environment `npm`, optionally with required reviewers or tag deployment restrictions.
2. For a new npm package, make its first publication from an authenticated maintainer session using a verified `pnpm pack` tarball. From a directory outside this checkout, run `npm publish /tmp/compoza.tgz --access public` (the source checkout declares pnpm as its development package manager).
3. In the npm package settings, add a GitHub Actions trusted publisher: owner `sandrinodm`, repository `compoza`, workflow `publish.yml`, environment `npm`, with direct `npm publish` allowed. No `NPM_TOKEN` secret is needed. Complete the first trusted publish within npm's configuration expiry window.

For subsequent releases, update `package.json`, commit the version change with a conventional commit such as `chore: release v0.1.1`, push to `main`, and wait for CI to pass. Create and push the matching tag, then publish a GitHub release for it. Prereleases are not published by this workflow. A release created with another workflow's `GITHUB_TOKEN` does not trigger this workflow automatically; that workflow must explicitly dispatch `publish.yml` at the tag.

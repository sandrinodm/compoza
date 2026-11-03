# Ingress

[README](../README.md) · [Commands](commands.md) · [Configuration](configuration.md) · [Caddy templates](caddy-templates.md) · [Secrets](secrets.md) · [SSH deployment](ssh-deployment.md) · [Development](development.md)

Ingress connects an application's public hostname to its running service. Docker and Compose handle deployment; an ingress extension supplies the route, host setup, and public readiness URL. Choose the extension in both the host and app configuration.

For how this differs from Kamal's traffic switching or the routing managed by Dokploy and Coolify, see [Comparing deployment tools](comparisons.md). A successful proxy reload alone does not make a Compose application update zero-downtime.

| Extension           | Use it when                                                                    | Setup responsibility                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `caddy`             | Apps should be reached through a shared Caddy reverse proxy.                   | Provision a fresh proxy or prepare an existing Caddy stack.                                                                        |
| `cloudflare-tunnel` | Apps should be reached through an existing remotely managed Cloudflare Tunnel. | Optionally provision a host connector; manage routes through the API or leave them in the dashboard. DNS remains operator-managed. |
| `none`              | The stack needs no managed public route.                                       | No ingress setup.                                                                                                                  |

- [Select an extension](#select-an-extension)
- [Caddy host and app settings](#shared-caddy-proxy)
- [Provision a new Caddy stack](#provision-a-new-caddy-stack)
- [Integrate an existing Caddy stack](#integrate-an-existing-caddy-stack)
- [Customize Caddy templates](caddy-templates.md)
- [Cloudflare Tunnel](#cloudflare-tunnel)
- [Deployment and lifecycle](#deployment-and-lifecycle)

Examples use fictional hosts and reserved documentation IP addresses. For host-file locations, local precedence and external `$ref` files, see [Configuration](configuration.md#hosts).

## Select an extension

Nest settings under the provider name. Each app selects exactly one provider; a host can declare both Caddy and Cloudflare Tunnel: `deploy.yaml` contains app routing settings, while `hosts.yaml` contains host infrastructure settings. The extension name is the selector; there is no separate `mode` or `provider` field.

For example, application routing:

```yaml
ingress:
  caddy:
    domain: app.example.com
    upstream: web:3000
    healthPath: /health
```

Each extension validates its required settings. Empty selections, unknown extensions and unknown settings are errors. Multiple app providers are rejected; hosts may include both supported providers. `none` must appear alone. Omit `ingress` or use `"ingress": { "none": {} }` to disable routing. A destination replaces the complete ingress selection, allowing it to switch extensions without inheriting the previous extension's settings.

When a host configures both providers, setup requires an explicit selection:

```sh
compoza setup-proxy macmini-server --ingress caddy --dry-run
compoza setup-proxy macmini-server --ingress cloudflare-tunnel --dry-run
```

Remove `--dry-run` only when ready to set up that provider. Omitting `--ingress` on a host with both fails before SSH or credential-provider access. On a single-provider host the flag is optional. Apps select their matching host settings automatically; no app-command selector is needed. See [one host with both providers](examples.md#one-host-with-caddy-and-cloudflare-tunnel).

- `caddy` atomically replaces `sites/<name>.caddy` under a shared lock and uses Caddy reload to validate and activate it and waits for `https://<domain><healthPath>`. `upstream` is the address Caddy proxies to, such as `sample-app-web:3000`.
- `cloudflare-tunnel` manages an HTTP(S) hostname rule in an existing remotely managed tunnel; see [Cloudflare Tunnel](#cloudflare-tunnel).
- `none` (the default) adds no route or ingress health URL. An app can still configure separate SSH health checks.
- `healthPath` defaults to `/` and must start with `/`, because it is appended to the domain as is.
- The URL wait accepts any HTTP status below 500.

## Shared Caddy proxy

Caddy serves app domains and proxies requests to services on a shared Docker network. The host entry describes Caddy's infrastructure; each app provides its hostname and upstream. An app's Compose services must join the configured network so Caddy can reach them.

### Host settings

Place these fields inside `ingress.caddy` in `hosts.yaml`. Cloudflare uses `ingress["cloudflare-tunnel"]` instead; see [Cloudflare Tunnel](#cloudflare-tunnel).

| Field         | Description                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `address`     | Optional IPv4/IPv6 assertion for DNS readiness; omit it to accept any A/AAAA answer.                         |
| `dir`         | Folder holding the proxy's Compose file and Caddyfile on the host.                                           |
| `container`   | Name of the running Caddy container.                                                                         |
| `service`     | Compose service name of the Caddy container. Defaults to the value of `container`.                           |
| `network`     | The proxy's network.                                                                                         |
| `tls`         | Body of each site's `tls` block. Omit it to not write a `tls` block.                                         |
| `logSnippet`  | A snippet in the shared Caddyfile, imported with the app name. Omit it to not write the import.              |
| `composeFile` | The proxy's Compose file. Defaults to `docker-compose.yaml`.                                                 |
| `provision`   | Optional fresh-stack provisioning settings; see [Provision a new Caddy stack](#provision-a-new-caddy-stack). |
| `templates`   | Optional site and root Caddyfile sources; see [Caddy templates](caddy-templates.md).                         |

A host using an existing proxy could declare:

```yaml
atlas:
  ssh: deploy@atlas.example.com
  platform: linux/arm64
  transport:
    mode: ssh-load
  ingress:
    caddy:
      address: 192.0.2.42
      dir: /srv/caddy
      container: caddy
      network: edge
```

### App settings

Place these fields under `ingress.caddy` in `deploy.yaml` or a destination override:

| Field          | Required | Meaning                                                                                                        |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `domain`       | Yes      | Public hostname, such as `app.example.com`.                                                                    |
| `upstream`     | Yes      | Container name or network alias and port, such as `web:3000`.                                                  |
| `healthPath`   | No       | Path appended to the HTTPS domain for readiness; defaults to `/`.                                              |
| `siteTemplate` | No       | App-specific [site template](caddy-templates.md#override-a-template-for-one-app), overriding the host default. |

Configure the app domain's A/AAAA records for its public ingress. `address` is only an optional check that one DNS answer matches; Caddy does not use it to bind or issue certificates. Omit it behind a CDN or when a fixed IP assertion is inappropriate. The check queries public resolvers and does not prove connectivity or certificate issuance. Caddy must be able to reach the upstream on the shared Docker network. With the default template, it uses HTTP to contact the upstream and HTTPS for the public URL.

### Run host setup

Choose whether to provision a new stack or integrate an existing one before running setup:

```sh
compoza setup-proxy atlas --dry-run
compoza setup-proxy atlas
```

`--dry-run` renders the planned script and input locally without opening SSH. Actual setup may start or recreate shared infrastructure; app deployment never runs it implicitly.

### Provision a new Caddy stack

Add `provision` under the host's `ingress.caddy`. This example creates a shared proxy with rotating request logs, using a Cloudflare-enabled image and a credential file that already exists on the host:

```yaml
atlas:
  ssh: deploy@atlas.example.com
  platform: linux/arm64
  transport:
    mode: ssh-load
  ingress:
    caddy:
      address: 192.0.2.42
      dir: /srv/caddy
      container: caddy
      network: edge_network
      logSnippet: request_log
      provision:
        image: registry.example.com/infra/caddy-cloudflare:tested-release
        envFile: /srv/caddy/.env
        acmeDns: cloudflare {env.CLOUDFLARE_API_TOKEN}
        networkAliases:
          - notes.example.com
```

`provision.image` is required; replace the fictional image above with your tested image. Pin its digest for reproducible production deployments; tags, including version tags, can move. The other provisioning fields are optional. `envFile` must be an absolute, existing host file; the CLI neither reads its contents nor creates credentials. `acmeDns` supplies the global Caddy `acme_dns` arguments; use environment placeholders, never literal credentials. The image must include the requested DNS module. `networkAliases` adds Docker DNS aliases for Caddy; it does not create public DNS records. For standard Caddy automatic HTTPS, select a standard Caddy image and omit `envFile` and `acmeDns`.

`gracePeriodSeconds` optionally sets the default template’s drain limit (1–3600 seconds, default 30). Docker’s stop budget is ten seconds longer. Custom config templates should use `{{gracePeriod}}` to stay aligned.

Provisioning creates:

- A Compose service with the configured image, container and service names, `restart: unless-stopped`, and ports 80/TCP, 443/TCP and 443/UDP bound to `0.0.0.0`.
- Persistent `data/` and `config/` directories, plus a read-only `Caddyfile` and `sites/` mount.
- The shared Docker network if it is missing, reused as an external Compose network. App Compose services must join that network themselves.
- A Caddyfile importing `sites/*.caddy`, private admin access on container loopback, metrics on that admin endpoint, a 30-second drain limit, and global DNS challenge settings when requested.
- A read-only container root filesystem, a 64 MiB `/tmp` tmpfs, and `no-new-privileges`. `/data` and `/config` remain writable.
- Docker JSON log rotation (10 MiB per file, three files), independently of request log rotation.
- A container healthcheck against `http://127.0.0.1:2019/config/` that discards the response. Port 2019 is never published.
- When `logSnippet` is configured, a snippet writing JSON logs to `/data/{app}.log`, rotating at 100 MB, retaining ten files for up to 720 hours. App routes import that snippet automatically.

The Compose project is named `<container>-ingress`. The optional `composeFile` must be a YAML filename inside the proxy directory. Docker and jq must already be installed and Docker must be running; using `envFile` requires Compose 2.30+ for raw env-file values, which preserve literal dollar signs and quotes. Validation uses a disposable container, then setup starts Caddy with `compose up --wait` (60-second timeout). Setup waits for the generated admin healthcheck to pass. The image must provide `caddy` and a BusyBox-style `wget`, run with permission to access the private bind directories, and support a read-only root filesystem (tested with Alpine-based images). Custom root templates must keep the HTTP admin API at `localhost:2019`; disabling or relocating it fails this healthcheck. This check does not verify public DNS, certificates or upstream application availability.

Provisioning is a bootstrap operation, not a configuration replacement or upgrade command. Reruns require a Caddyfile and Compose file already in the directory to match the generated files exactly, preserve app routes, certificates, logs and env files, and ensure the service is running. A container owned by another Compose project, service, or working directory is rejected. Differing files are never overwritten: omit `provision` to integrate an operator-managed proxy or choose a fresh directory and a nonconflicting container/ports. Changing provisioning settings after creation requires deliberate operator-managed reconciliation; there is no force/adopt mode.

Configuration is validated before generated files are installed or the shared service is started. Failed validation leaves the current configuration untouched. A failed start retains generated files, persistent directories and any newly created network for inspection and retry; setup does not promise to restore container state. Diagnostics from Compose and Caddy are suppressed because they may contain expanded credentials. Setup, route installation and removal share a per-directory `.compoza-caddy.lock`; overlapping operations fail with retry guidance. Read [production operations and recovery](caddy-production.md) before clearing a retained lock.

### Integrate an existing Caddy stack

Omit `provision` to integrate an operator-managed Caddy stack. Setup makes the host's Caddy load every `sites/*.caddy` file:

1. Appends `import /etc/caddy/sites/*.caddy` to the Caddyfile.
2. Adds a `./sites` mount to the proxy's Compose file.
3. Validates with a throwaway Caddy.
4. Recreates the Caddy container, which **briefly interrupts** every site it serves.

Both files are backed up as `*.pre-sites-<timestamp>` and restored if any step fails.

If the Caddyfile import, Compose mount and running container mount already exist, setup is a no-op. It does not move inline routes from the Caddyfile into `sites/` or replace the base Caddyfile. To move an inline route into a managed site file, coordinate removal of its old block with creation of its managed site file so the same hostname is not declared twice.

Readiness requires the container to be running. A configured Docker healthcheck must be healthy; provisioned stacks must have a healthy check. Integrated stacks without a healthcheck are accepted, but their readiness only establishes process state and configuration mounts.

Integration does not apply the fresh-stack hardening defaults. See [hardening an integrated stack](caddy-production.md#hardening-an-integrated-stack) to apply them deliberately.

### Customize the configuration

Use [Caddy templates](caddy-templates.md) to control the shared Caddyfile and each app's site block, including TLS, log rotation and custom proxy headers. The bundled root template supplies the production defaults above; custom templates own their policy. The root template applies during provisioning; site templates apply during app deployment.

## Cloudflare Tunnel

Use a **remotely managed tunnel that you create in Cloudflare**. Optional host `provision` settings let `setup-proxy` create a hardened connector stack, shared network and private credentials with a customizable Compose template. See [Cloudflare provisioning](cloudflare-provisioning.md) for setup, native 1Password/dotenv credentials, manual routing and per-app origin templates.

By default, Compoza manages each app's public hostname rule using a host API token. With `routing: "manual"`, routes stay in the dashboard and checks use the local connector instead; no management API token or state directory is required. Tunnel creation, DNS and Cloudflare Access remain operator-managed. Every connector must be able to reach the app's configured origin. A connector in Docker usually shares a network with the app, so `http://web:8080` addresses that service; `localhost` would address the connector itself.

### Host settings

In `hosts.yaml`, select the extension (the IDs below are fictional):

```yaml
atlas:
  ssh: deploy@atlas.example.com
  platform: linux/amd64
  transport:
    mode: ssh-load
  ingress:
    cloudflare-tunnel:
      accountId: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      tunnelId: 12345678-1234-1234-1234-123456789abc
      apiTokenFile: /home/deploy/.config/compoza/cloudflare.token
      stateDir: /home/deploy/.local/state/compoza/cloudflare
```

`apiTokenFile` is an absolute **host** path to a private regular file containing only a Cloudflare API token, preferably mode `0600`. Use a token scoped to the tunnel's account with **Cloudflare Tunnel Write** (or the equivalent cloudflared connector write permission). A connector's tunnel token cannot manage routes. The API token is read only on the host and passed to curl on stdin, not in arguments, generated scripts, stack assets, or diagnostic output. [Cloudflare configuration API permissions](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/).

### App settings

Select the ingress in `deploy.yaml` or a destination override:

```yaml
ingress:
  cloudflare-tunnel:
    domain: app.example.com
    service: http://web:8080
    healthPath: /ready
```

`ingress["cloudflare-tunnel"].service` accepts an HTTP(S) origin without credentials, a URL path, or a query. `healthPath` belongs to the public readiness URL. A public origin address is not required: DNS resolves to Cloudflare's edge rather than to the Docker host.

### Set up DNS and route ownership

Create a **proxied CNAME** from `app.example.com` to `<tunnelId>.cfargotunnel.com` in Cloudflare DNS, then run:

```sh
compoza setup-proxy atlas
compoza check infra
compoza deploy infra --dry-run
compoza deploy infra
```

`setup-proxy` verifies access to the existing remotely managed tunnel and prepares private ownership storage. It does not alter tunnel configuration. Checks and dry runs perform authenticated read-only API requests using the host token; they do not fetch application credentials, write state, or change routes. The DNS check verifies public resolution, not the underlying CNAME target. Configure that target correctly and use an app-specific readiness endpoint. The standard HTTP probe accepts any status below 500, including Access login responses and 404s; it is not a strict content check. [Cloudflare's tunnel publication and DNS guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/).

### Ownership and recovery

Deployment preserves other hostname rules, the final catch-all, and global origin settings. It refuses to take over an unowned exact hostname or overwrite a managed rule edited outside compoza. `projectName` identifies the route owner. Changing this app's domain updates its managed rule; create the new DNS record separately. Delete removes the owned rule, leaving the tunnel, connectors, DNS, Access policies and state directory intact. Redeployment uses current local route settings and the token currently at the configured host path.

Use **one writer host and one `stateDir` per shared tunnel**. A shared host lock serializes app deployments, and a version recheck detects changes made before the update. Cloudflare's full-configuration update is not an atomic compare-and-swap: concurrent dashboard, Terraform, or other-host writers can still race after that recheck. Keep those writers idle while deploying.

The private ownership journal records both possible outcomes before an API update. After a rejected or timed-out update, retry the same deployment or remove its managed route; the journal allows recovery even if Cloudflare accepted a request whose response was lost. Do not delete journals to bypass a conflict. If a process was killed and left a `.lock` directory, confirm no deployment is running before removing that lock. As with other ingress, a later health failure can leave a route changed; the deployment does not promise atomic container/route rollback. Live Cloudflare access is not exercised by the test suite.

## Deployment and lifecycle

After host setup, check and deploy the app:

```sh
compoza check infra
compoza deploy infra --dry-run
compoza deploy infra
```

| Operation        | Ingress behavior                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`          | Reads provider readiness and compares the managed route with the current app configuration. A route-only failure is repaired by deployment. |
| `deploy`         | Activates the route after Compose and waits for the configured public URL.                                                                  |
| `stop` / `start` | Keeps the route while stopping or starting the app's containers.                                                                            |
| `delete`         | Removes the managed route while retaining shared ingress infrastructure.                                                                    |
| `--local`        | Runs the app locally without remote ingress setup, checks or routing.                                                                       |

The standard public HTTP wait accepts any status below 500. A login page or 404 can therefore count as reachable; choose an app-specific health endpoint when appropriate. Route activation followed by a health failure can leave a changed route. Deployment does not promise an atomic rollback of containers and routing.

For execution modes and host health checks, see [SSH deployment](ssh-deployment.md#health-and-readiness). For adding a new ingress implementation, see [Development](development.md#ingress-extensions).

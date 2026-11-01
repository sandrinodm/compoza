# Configuration examples

[README](../README.md) · [Configuration reference](configuration.md) · [Secrets](secrets.md) · [Ingress](ingress.md) · [SSH deployment](ssh-deployment.md)

These examples combine the configuration patterns supported by Compoza: central deployment folders, separate source repositories, local development, multiple destinations and shared ingress. Hostnames, addresses and account IDs are fictional. Replace them with your own values; these are configuration examples, not records of live deployments.

Complete files are labeled with their filename. **Variations are partial mappings**: replace the indicated settings in a complete example rather than saving the fragment as a standalone configuration. Examples use named extensions; see the reference for [legacy migration](ingress.md#migrating-existing-extension-settings).

The CLI machine needs Node.js 26.0 or newer. Remote hosts need the [SSH runtime prerequisites](ssh-deployment.md#host-prerequisites), not Node.js. Image tags here follow the tutorial examples elsewhere in these docs; select reviewed tags or digests for your own deployments.

- [Host inventory and external host files](#host-inventory-and-external-host-files)
- [A third-party stack with assets and persistent content](#a-third-party-stack-with-assets-and-persistent-content)
- [Central configuration with a separate app repository](#central-configuration-with-a-separate-app-repository)
- [Local runs and named destinations](#local-runs-and-named-destinations)
- [Choose execution and image transport](#choose-execution-and-image-transport)
- [Choose one application secret source](#choose-one-application-secret-source)
- [Caddy provisioning and templates](#caddy-provisioning-and-templates)
- [Cloudflare Tunnel with manual routes](#cloudflare-tunnel-with-manual-routes)
- [Cloudflare managed routes and credential variations](#cloudflare-managed-routes-and-credential-variations)
- [Preview, deploy and recover](#preview-deploy-and-recover)

## Host inventory and external host files

Complete `~/.config/compoza/hosts.yaml`:

```yaml
atlas:
  $ref: ./hosts/atlas.yaml
cedar:
  ssh: deploy@cedar.example.com
  platform: linux/arm64
  transport:
    mode: ssh-load
borealis:
  ssh: deploy@borealis.example.com
  platform: linux/amd64
  transport:
    mode: remote-build
relay:
  $ref: ./hosts/relay.yaml
```

The complete `atlas.yaml` and `relay.yaml` files appear in the Caddy and Cloudflare examples below. A referenced file contains one host, without an outer host-name key. References resolve relative to the inventory file and also accept absolute paths or `~/`. Do not combine `$ref` with inline host fields or chain references.

Optional complete `./hosts.yaml` in the directory where you invoke the CLI:

```yaml
cedar:
  ssh: cedar-development
  platform: linux/amd64
  transport:
    mode: ssh-load
```

This replaces the **entire** global `cedar` entry; `atlas`, `borealis` and `relay` remain available. `cedar-development` must be an operator-configured SSH alias. The CLI does not search parent directories. Neither the target deploy folder nor `workingDirectory` changes host discovery.

Use `--hosts ./hosts.yaml` or `COMPOZA_HOSTS` to select one inventory exclusively instead of merging global and local files. Explicit `--hosts` takes precedence. Quote string values that look like numbers or booleans, such as `PORT: "8080"`; duplicate keys and unknown settings are errors.

## A third-party stack with assets and persistent content

This stack runs nginx without building an application image. It uses `cedar` from the inventory and exposes HTTP only on the host's loopback interface, with no managed public ingress.

Complete `static-site/deploy.yaml`:

```yaml
name: static-site
host: cedar
targets: []
execution: ssh
composeFiles: [compose.yaml]
assets: [nginx.conf]
ingress:
  none: {}
secrets:
  none: {}
remote:
  stackDir: /srv/static-site/stack
  overlayFile: /srv/static-site/operator.yaml
  waitTimeoutSeconds: 120
health:
  url: http://127.0.0.1:8080/
  timeoutSeconds: 45
directories:
  - /srv/static-site/content
content:
  site: /srv/static-site/content
environment:
  SITE_ROOT: /srv/static-site/content
  HTTP_PORT: '8080'
```

Complete `static-site/compose.yaml`:

```yaml
services:
  web:
    image: nginx:alpine
    ports:
      - '127.0.0.1:${HTTP_PORT}:80'
    volumes:
      - type: bind
        source: ./nginx.conf
        target: /etc/nginx/conf.d/default.conf
        read_only: true
      - type: bind
        source: ${SITE_ROOT}
        target: /usr/share/nginx/html
        read_only: true
```

Complete `static-site/nginx.conf`:

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    location / { try_files $uri $uri/ =404; }
}
```

Complete `/srv/static-site/operator.yaml`, created separately **on cedar**:

```yaml
services:
  web:
    restart: unless-stopped
```

`assets` are explicit, deploy-relative regular files; relative bind mounts must be declared and read-only. Do not put dotenv files or other credentials in assets. Persistent content uses an absolute host path and is not uploaded with the stack. The host overlay remains live and operator-owned; omit `overlayFile` if you do not need one.

`targets: []` needs no Git checkout, Dockerfile or build context. Compose still pulls missing third-party images. `waitTimeoutSeconds` controls Compose readiness; `health` adds a separate HTTP probe executed on the host. Any HTTP status below 500 counts as reachable, including a 404 while the content folder is empty; this is not a content assertion.

After creating a local `public/index.html`, the intended flow is:

```sh
compoza deploy static-site --dry-run
compoza deploy static-site
compoza publish static-site site ./public --dry-run
compoza publish static-site site ./public
```

Publishing mirrors the local folder, including deletions. Review the preview before updating shared content.

## Central configuration with a separate app repository

Keep deployment settings in one repository and application source in another:

```text
Repositories/
├── foo/
│   ├── docker/Dockerfile
│   └── public/index.html
└── localcloud/compose/foo/
    ├── deploy.yaml
    ├── compose.yaml
    ├── compose.local.yaml
    ├── compose.staging.yaml
    └── production.env
```

Complete `Repositories/localcloud/compose/foo/deploy.yaml`:

```yaml
name: foo
projectName: foo-production
host: atlas
workingDirectory: ../../../foo
dockerfile: docker/Dockerfile
context: .
targets: [web, worker]
execution: ssh
composeFiles: [compose.yaml]
profiles: [jobs]
remote:
  stackDir: /srv/foo/production
  waitTimeoutSeconds: 180
ingress:
  caddy:
    domain: foo.example.com
    upstream: foo-production-web:80
    healthPath: /
environment:
  APP_MODE: production
  PUBLIC_ALIAS: foo-production-web
secrets:
  env-file:
    path: ./production.env
local:
  composeFiles: [compose.local.yaml]
  environment:
    APP_MODE: development
  secrets:
    none: {}
destinations:
  staging:
    host: borealis
    projectName: foo-staging
    composeFiles: [compose.yaml, compose.staging.yaml]
    profiles: []
    remote:
      stackDir: /srv/foo/staging
      waitTimeoutSeconds: 90
    ingress:
      none: {}
    environment:
      APP_MODE: staging
      PUBLIC_ALIAS: foo-staging-web
    secrets:
      1password:
        environmentId: fictional-foo-staging-environment
```

Complete `Repositories/localcloud/compose/foo/compose.yaml`:

```yaml
services:
  web:
    image: ${WEB_IMAGE}
    environment:
      APP_MODE: ${APP_MODE}
      APP_TOKEN: ${APP_TOKEN:-}
    networks:
      edge:
        aliases: ['${PUBLIC_ALIAS}']
  worker:
    image: ${WORKER_IMAGE}
    profiles: [jobs]
    environment:
      APP_MODE: ${APP_MODE}
networks:
  edge:
    external: true
    name: caddy-edge
```

The Caddy setup below creates the external `caddy-edge` network on `atlas`. The staging override below instead gives the private staging stack its own Compose-managed network. The unique alias makes the production route resolve `foo-production-web:80`, even when other apps also have a service named `web`.

Complete `Repositories/foo/docker/Dockerfile`, with both configured build targets:

```dockerfile
FROM nginx:alpine AS web
COPY public/ /usr/share/nginx/html/

FROM nginx:alpine AS worker
CMD ["sh", "-c", "while :; do sleep 60; done"]
```

Add a `public/index.html` in the source repository and commit it with the Dockerfile. This minimal image pair demonstrates target wiring; replace the worker with the application's real job process. `APP_TOKEN` demonstrates explicit container environment mapping; these example images do not consume it. Keep `production.env` private and out of version control; its values are not shown here. Exclude any secrets inside a build context with `.dockerignore`.

`workingDirectory` resolves relative to `deploy.yaml`, accepts absolute and `~/` paths, and defaults to the deploy folder. Git checks and image tags use the repository containing that directory. Relative `dockerfile` and `context` paths resolve there; omitting `context` uses the source Git root. Build commands run in `workingDirectory`.

Compose files, assets, relative dotenv paths and app templates remain beside the selected YAML file. An explicitly named `production.yaml` works the same way. Host paths in `remote`, `directories` and `content` still point to the remote machine.

## Local runs and named destinations

The previous deploy file defines both variations. Complete `compose.local.yaml`, beside that file:

```yaml
services:
  web:
    image: ${WEB_IMAGE}
    ports: ['127.0.0.1:8081:80']
    environment:
      APP_MODE: ${APP_MODE}
  worker:
    image: ${WORKER_IMAGE}
    profiles: [jobs]
```

Complete `compose.staging.yaml`, also beside that file:

```yaml
services:
  web:
    ports: ['127.0.0.1:8082:80']
networks:
  edge:
    external: false
    name: foo-staging-edge
```

```sh
compoza deploy Repositories/localcloud/compose/foo --local --dry-run
compoza deploy Repositories/localcloud/compose/foo --destination staging --dry-run
```

`--local` builds and runs on the CLI machine, without remote checks, transport or ingress, even when `execution` is `ssh`. It replaces `composeFiles` and the secret source with the local choices and merges local `environment`. A declared production source requires explicit `local.secrets`; `none` prevents production credential fallback.

A destination replaces the selected arrays and objects rather than merging their contents. For example, staging's `remote` includes its own `stackDir`, and `profiles: []` disables the jobs profile. `environment` alone merges by key. `secrets` replaces the entire source, and `ingress.none` clears the public route selection. Destinations can also replace `execution`, `health`, `directories` and `content`. `name`, `workingDirectory`, build settings, targets and assets remain shared.

`projectName` changes Compose and route identity; it does not change the `foo-web` and `foo-worker` image prefixes. Keep `--destination staging` on subsequent check, status, logs, lifecycle and publish commands.

## Choose execution and image transport

The inventory deliberately shows all three transports:

| Host       | Transport      | Result for built targets                                                       |
| ---------- | -------------- | ------------------------------------------------------------------------------ |
| `atlas`    | `registry`     | Build locally and push to `registry.example.com`; the host pulls images.       |
| `cedar`    | `ssh-load`     | Build locally, then stream compressed images into the host daemon.             |
| `borealis` | `remote-build` | Transfer build context through BuildKit and build directly in the host daemon. |

Registry transport needs appropriate operator and host registry authentication. `remote-build` requires `execution: ssh`; it uses the host's default BuildKit builder. Platforms such as `linux/arm64` and `linux/amd64` describe the selected host's image architecture.

For a small **client execution** variation, save this complete deploy file in the `foo` source repository root and copy the `compose.local.yaml` above into that root. Keep the Dockerfile at `docker/Dockerfile`:

```yaml
name: foo-client
host: cedar
dockerfile: docker/Dockerfile
targets: [web, worker]
execution: client
composeFiles: [compose.local.yaml]
environment:
  APP_MODE: production
secrets:
  none: {}
ingress:
  none: {}
```

Here Compose runs on the CLI machine against the remote Docker endpoint; the selected Compose file publishes loopback port 8081 **on cedar**. `execution: client` is the default when omitted. It does not stage an SSH bundle or use `remote`, host overlays or SSH asset uploads. Build reusable configuration into the image, and use absolute host paths for persistent binds. Image transport remains independent of where Compose runs.

## Choose one application secret source

These are **alternative partial `deploy.yaml` mappings**. Use exactly one source at a time; the same source selections work under a destination or `local`.

Client-side dotenv:

```yaml
secrets:
  env-file:
    path: ~/.config/compoza/foo.env
```

1Password Environment:

```yaml
secrets:
  1password:
    environmentId: fictional-foo-production-environment
```

Deliberately no secrets:

```yaml
secrets:
  none: {}
```

A separate, operator-owned dotenv file **on the SSH host**, replacing the entire `secrets` selection:

```yaml
execution: ssh
remote:
  stackDir: /srv/foo/production
  envFile: /home/deploy/.config/foo/production.env
```

Remove `secrets` when selecting `remote.envFile`; even `secrets.none` is a competing source. Do not point `remote.envFile` at the generated `<stackDir>/.env`. Existing unowned `.env` files inside a stack folder must be moved to a separate host path before deployment. Legacy app `envFile` is documented for migration, but new client-side dotenv examples use `secrets.env-file`.

Native 1Password authentication belongs in the operator environment: `COMPOZA_1PASSWORD_ACCOUNT` for the desktop SDK integration, or `OP_SERVICE_ACCOUNT_TOKEN` for automation. No values belong in YAML. See [authentication and dotenv parsing](secrets.md). Compose interpolation inputs reach a container only when its service explicitly maps them through `environment` or another supported Compose field.

## Caddy provisioning and templates

Complete `~/.config/compoza/hosts/atlas.yaml`, referenced by the inventory:

```yaml
ssh: deploy@atlas.example.com
platform: linux/arm64
transport:
  mode: registry
  registry: registry.example.com
ingress:
  caddy:
    address: 192.0.2.42
    dir: /srv/caddy
    container: caddy
    service: proxy
    composeFile: compose.yaml
    network: caddy-edge
    logSnippet: request_log
    provision:
      image: caddy:2
      networkAliases: [proxy.internal.example.com]
      gracePeriodSeconds: 30
```

Create the app's public DNS record before deployment. `address` is an optional expected DNS address. `container` names the running container while `service` names its Compose service. This example provisions a fresh Caddy stack using its default certificate challenges and the bundled templates. Omit `provision` to integrate an existing operator-managed stack; setup can recreate the shared proxy, briefly interrupting its applications.

```sh
compoza setup-proxy atlas --dry-run
compoza setup-proxy atlas
```

For DNS challenges, this **partial replacement inside `ingress.caddy`** selects a custom image that must contain the Cloudflare DNS module, plus a private existing host dotenv file. The image name is illustrative:

```yaml
tls: dns cloudflare {env.CLOUDFLARE_API_TOKEN}
provision:
  image: registry.example.com/caddy-cloudflare:reviewed
  envFile: /home/deploy/.config/caddy/dns.env
  acmeDns: cloudflare {env.CLOUDFLARE_API_TOKEN}
  networkAliases: [proxy.internal.example.com]
  gracePeriodSeconds: 45
```

To customize templates, add this **partial mapping inside `ingress.caddy`**. Start those files from the [bundled templates](caddy-templates.md):

```yaml
templates:
  config: ./caddy/Caddyfile.tmpl
  site: ./caddy/site.caddy.tmpl
```

Those paths are relative to `hosts/atlas.yaml`. The root template must keep the sites import and the provisioned HTTP admin healthcheck at `localhost:2019`. A custom template owns its TLS and logging directives; settings only take effect where its placeholders use them.

An app-specific **replacement `ingress` block in `deploy.yaml`** can override the host's site template inline:

```yaml
ingress:
  caddy:
    domain: foo.example.com
    upstream: foo-production-web:80
    healthPath: /
    siteTemplate:
      inline: |
        {{domain}} {
          {{#tls}}
          tls {
            {{tls}}
          }
          {{/tls}}
          {{#logSnippet}}import {{logSnippet}} {{name}}{{/logSnippet}}
          reverse_proxy http://{{upstream}} {
            header_up X-Real-IP {remote_host}
          }
        }
```

A filename such as `siteTemplate: ./caddy/foo.caddy.tmpl` instead resolves beside the deploy YAML, not `workingDirectory`. Shared root templates apply during provisioning; site templates apply during app deployment. Provisioning refuses differing existing generated files; it is not an automatic Caddy upgrade mechanism.

## Cloudflare Tunnel with manual routes

Create a remotely managed tunnel first. Complete `~/.config/compoza/hosts/relay.yaml`, referenced by the inventory:

```yaml
ssh: deploy@relay.example.com
platform: linux/amd64
transport:
  mode: ssh-load
ingress:
  cloudflare-tunnel:
    accountId: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    tunnelId: 12345678-1234-1234-1234-123456789abc
    routing: manual
    dir: /srv/cloudflare
    container: cloudflared
    service: connector
    composeFile: compose.yaml
    network: cloudflare-edge
    provision:
      secrets:
        1password:
          environmentId: fictional-connector-environment
      tokenVariable: CLOUDFLARE_TUNNEL_TOKEN
      user: '65532:65532'
      gracePeriodSeconds: 30
      waitTimeoutSeconds: 120
```

The selected variable must contain the raw connector token, not an installation command. With `image` omitted, provisioning uses the bundled digest-pinned cloudflared image; `provision.image` may select another reviewed compatible image. Set up the shared connector before deploying the app:

```sh
compoza setup-proxy relay --dry-run
compoza setup-proxy relay
```

Complete `tunnel-site/deploy.yaml`:

```yaml
name: tunnel-site
host: relay
targets: []
execution: ssh
composeFiles: [compose.yaml]
remote:
  stackDir: /srv/tunnel-site
secrets:
  none: {}
ingress:
  cloudflare-tunnel:
    domain: tunnel-site.example.com
    service: http://tunnel-site-web:80
    healthPath: /
```

Complete `tunnel-site/compose.yaml`:

```yaml
services:
  web:
    image: nginx:alpine
    networks:
      edge:
        aliases: [tunnel-site-web]
networks:
  edge:
    external: true
    name: cloudflare-edge
```

Configure the dashboard route with exactly that hostname and origin, and a proxied CNAME to the tunnel's `<tunnelId>.cfargotunnel.com` hostname. Every connector must be able to reach `tunnel-site-web:80`; `localhost` inside the connector would refer to the connector itself. No application host port is published.

Manual routing needs no management API token or ownership state directory. Deploy and delete leave dashboard routes untouched. DNS, tunnel creation and Access policies remain operator-owned. Public readiness accepts statuses below 500, so verify the actual application response when an Access login page could satisfy the probe.

## Cloudflare managed routes and credential variations

For Compoza to manage hostname rules, replace `routing` and add these **partial settings inside `ingress.cloudflare-tunnel`** on `relay`:

```yaml
routing: managed
apiTokenFile: /home/deploy/.config/compoza/cloudflare-api.token
stateDir: /home/deploy/.local/state/compoza/cloudflare
```

Keep the other host fields. The private host API token is distinct from the connector token and needs the documented tunnel-write permission. Use one writer host and one state directory per tunnel. Managed routing checks ownership and preserves unrelated rules; it does not create DNS records. See [route ownership and recovery](ingress.md#ownership-and-recovery).

Connector credential alternatives are **replacement `provision` blocks**, not additional sources. A dotenv source on the CLI machine, relative to the declaring host YAML:

```yaml
provision:
  secrets:
    env-file:
      path: ./cloudflare/connector.env
  tokenVariable: CLOUDFLARE_TUNNEL_TOKEN
```

Or an existing private host dotenv file containing the raw token under `TUNNEL_TOKEN`:

```yaml
provision:
  envFile: /home/deploy/.config/cloudflare/connector.env
```

Select exactly one of `provision.secrets` and `provision.envFile`. The latter requires raw env-file support in Compose; see [connector prerequisites](cloudflare-provisioning.md#production-defaults).

For templates, add this **partial mapping inside the host's `ingress.cloudflare-tunnel`**:

```yaml
templates:
  compose: ./cloudflare/compose.yaml.tmpl
  route:
    inline: |
      hostname: {{domain}}
      service: {{service}}
      originRequest:
        connectTimeout: 20
```

Copy the [bundled connector Compose template](../src/extensions/cloudflare-tunnel/templates/compose.yaml.tmpl) to that local filename before customizing it. Required identity, credentials, networks, isolation and native readiness are validated. Placeholders are already quoted YAML scalars; use `{{image}}`, not `"{{image}}"`. A changed template does not silently overwrite an existing connector stack.

The route template affects managed routing only. To override it for one app, use this **replacement ingress block in `tunnel-site/deploy.yaml`**:

```yaml
ingress:
  cloudflare-tunnel:
    domain: tunnel-site.example.com
    service: http://tunnel-site-web:80
    healthPath: /
    routeTemplate:
      inline: |
        hostname: {{domain}}
        service: {{service}}
        originRequest:
          httpHostHeader: origin.example.com
```

A route-template filename resolves beside the app YAML. Templates must preserve the selected hostname and service; only `originRequest` settings may be added. Do not include credentials in templates. Existing connectors can remain operator-managed by omitting `provision`.

## Preview, deploy and recover

For the central app, retain the same target, destination and host selection throughout:

```sh
compoza check Repositories/localcloud/compose/foo --destination staging --json
compoza deploy Repositories/localcloud/compose/foo --destination staging --dry-run
compoza deploy Repositories/localcloud/compose/foo --destination staging
compoza status Repositories/localcloud/compose/foo --destination staging
compoza logs Repositories/localcloud/compose/foo --destination staging --tail 50
```

Ordinary checks and dry runs do not fetch credentials; `check --secrets --json` explicitly verifies source access and reports names, not values. Dry runs do not validate a full candidate on the host. Built images normally require a clean committed source checkout; `--allow-dirty` permits changes and appends `-dirty` to the commit tag.

An SSH stack contains `compose.yaml`, private `.env`, declared assets and one nonsecret `.compoza.json`. There are no application release directories, previous/current pointers or configuration backups. Upload and validation failures preserve deployed files; failures after replacement can leave changed files or containers.

Recover with an existing image tag and the **current** local configuration and credentials:

```sh
compoza deploy Repositories/localcloud/compose/foo --destination staging --tag abc123def456 --dry-run
compoza deploy Repositories/localcloud/compose/foo --destination staging --tag abc123def456
```

`--tag` skips Git and builds; it does not restore older configuration, secrets or database state. A missing `workingDirectory` is allowed for `--tag`, `targets: []`, status, logs and lifecycle operations. `stop`, `start` and `delete` operate on the deployed stack; delete retains host files and persistent bind data, and removes named volumes only when `--volumes` is explicitly selected.

# Cloudflare connector provisioning and templates

`setup-proxy` can provision a shared `cloudflared` Docker connector, using the same explicit host setup workflow as Caddy. Create the remotely managed tunnel in Cloudflare first and provide its connector token. Compoza creates the host Compose stack and shared Docker network, validates the token's account/tunnel identity, and waits for a healthy Cloudflare connection.

Tunnel creation, DNS and Cloudflare Access remain operator-managed. Published application routes can be managed manually in the dashboard or by Compoza's existing route integration. Provisioning is opt-in; existing host configurations retain their behavior.

## Host configuration with 1Password and manual routes

```yaml
atlas:
  ssh: deploy@atlas.example.com
  platform: linux/arm64
  transport:
    mode: ssh-load
  ingress:
    cloudflare-tunnel:
      accountId: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      tunnelId: 12345678-1234-1234-1234-123456789abc
      routing: manual
      dir: /home/deploy/ingress/cloudflare
      container: cloudflared
      network: cloudflare-edge
      provision:
        secrets:
          1password:
            environmentId: your-environment-id
```

The selected 1Password Environment must contain **only the raw connector token** in `CLOUDFLARE_TUNNEL_TOKEN`, not an installation command. Override the variable name with `provision.tokenVariable`. Other Environment values are discarded before transport or persistence. Native SDK authentication follows the [credential provider guide](secrets.md#authentication).

```sh
export COMPOZA_1PASSWORD_ACCOUNT="Your account name or UUID"
compoza setup-proxy atlas --dry-run
compoza setup-proxy atlas
```

The dry run prints nonsecret scripts and rendered configuration, with no SSH connection, provider read or host writes. A real setup fetches the selected provider once and sends only the selected token over SSH stdin. The host stores it in `dir/.credentials.env`, mode `0600`. Docker reads that file and supplies `TUNNEL_TOKEN` only to the connector. The token is absent from Compose templates, process arguments, setup output and application stacks. Docker administrators can inspect container environment values.

Alternatively, use `provision.secrets["env-file"].path` for a dotenv source on the CLI machine. Its path resolves relative to the host YAML declaring the configuration, including external `$ref` files. Or use `provision.envFile` for an existing absolute host file containing `TUNNEL_TOKEN=<raw-token>` without surrounding quotes. The latter uses Compose's raw env-file format. Select exactly one of `envFile` and `secrets`. Existing host credential files must have owner-only permissions.

## Production defaults

- A reviewed, digest-pinned multiarchitecture `cloudflare/cloudflared:2026.10.0` image; `provision.image` can select another reviewed image.
- Nonroot `65532:65532` (`provision.user` overrides the numeric UID/GID), a read-only root, all capabilities dropped and no privilege escalation.
- No host ports, host volumes or Docker socket. Metrics bind to `127.0.0.1:20241` inside the connector.
- A native `cloudflared tunnel ready` health check. A running process alone does not satisfy setup readiness.
- A 128 MiB memory limit, 64 PID limit, restart policy, and three rotating 10 MiB local log files.
- A 30-second cloudflared request drain deadline and a 40-second Docker stop deadline. `provision.gracePeriodSeconds` adjusts both with ten seconds of shutdown headroom.
- A private shared bridge network for origins and a separate egress bridge for Cloudflare connections. Applications join the shared network explicitly.

The host needs Bash 3.2+, jq, Docker and Compose 2.30+ (raw env files), with `up --wait`. `provision.waitTimeoutSeconds` defaults to 120. The default Compose service is `connector`; `service` and `composeFile` can override the service name and `compose.yaml` filename.

Setup takes a host lock and refuses symlinked stack paths, foreign containers and differing existing Compose files. Reruns preserve the generated configuration, rotate provider-supplied credentials and recreate the owned connector, then wait for connections. This can briefly interrupt all applications using that connector. It does not delete/recreate the Cloudflare tunnel or edit its routes. Failed startup retains configuration for inspection and retry; diagnostic output that might contain credentials is suppressed. Inspect an abandoned lock's owner before removing it.

## Application configuration and manual routes

```yaml
ingress:
  cloudflare-tunnel:
    domain: app.example.com
    service: http://sample-app-web:8080
    healthPath: /health
```

Join the host's network in the application's Compose file:

```yaml
services:
  web:
    networks:
      ingress:
        aliases: [sample-app-web]
networks:
  ingress:
    external: true
    name: cloudflare-edge
```

Create a proxied CNAME to `<tunnel-id>.cfargotunnel.com`, then publish the application route in the tunnel dashboard using the same hostname and HTTP service URL. With `routing: "manual"`, Compoza checks DNS and local connector/network health and performs the public readiness wait. Deploy and delete leave dashboard routes untouched and make no Cloudflare API calls. The public URL wait accepts HTTP statuses below 500; verify the expected application response as well.

For API-managed routes, omit `routing` or set it to `managed`, and supply `apiTokenFile` and `stateDir` as described in [Ingress](ingress.md#cloudflare-tunnel). The API token needs Cloudflare Tunnel Write permission and is distinct from the connector token. Existing ownership, conflict detection and recovery behavior are preserved. Provisioning checks API access before starting the managed connector.

## Customize the connector Compose template

Host `templates.compose` accepts a filename relative to its host YAML or `inline: ...`, like Caddy templates. Start with the [bundled template](../src/extensions/cloudflare-tunnel/templates/compose.yaml.tmpl), then adjust connection protocol, resource budgets, logging or health timings.

```yaml
templates:
  compose: ./cloudflare/compose.yaml.tmpl
```

Supported placeholders are `project`, `service`, `image`, `container`, `user`, `envFile`, `network`, `gracePeriod` and `stopGracePeriod`. Each substitution is already a JSON-quoted YAML scalar: use `image: {{image}}`, not `image: "{{image}}"`. Literal text and conditional sections follow the [Caddy template syntax](caddy-templates.md#variables-and-sections); unknown placeholders fail before SSH. Templates are bounded to 256 KiB and are never shell-evaluated.

Custom templates must preserve the connector identity, credential source, native readiness command, private metrics address, network layout and security boundaries. Host ports/volumes, privileged execution, extra services, environment overrides and token arguments are rejected. Resource sizes, supported run flags and health/log timing remain customizable. A changed template is not silently written over an existing stack; reconcile the host-owned Compose file deliberately before rerunning setup.

## Customize API-managed origin settings

`templates.route` defines the host's default YAML application rule. An app can override it with `ingress["cloudflare-tunnel"].routeTemplate`, resolving relative to the selected `deploy.yaml`. The route template applies only to managed routing; dashboard routes use dashboard settings.

```yaml
hostname: { { domain } }
service: { { service } }
originRequest:
  connectTimeout: 20
  httpHostHeader: origin.example.com
```

`name`, `domain` and `service` are JSON-quoted scalar placeholders. The rendered rule must preserve the selected hostname and service; only `originRequest` settings may be added. This protects route ownership and keeps the existing catch-all and unrelated applications intact. Use the appropriate Cloudflare origin setting types; the API remains authoritative for their validation. Templates must not contain credentials.

Run the ordinary tests for Bash/daemon fixtures and Compose parsing. `COMPOZA_TEST_CLOUDFLARED_IMAGE=<local-image> pnpm test` additionally runs the native image offline with a synthetic token; it verifies isolation and that readiness fails without a connection. Real Cloudflare connection success requires an operator-authorized tunnel and is not claimed by offline tests.

References: [connector run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/), [remotely managed tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/), [origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/).

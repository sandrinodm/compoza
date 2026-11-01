# Caddy production operations

[README](../README.md) · [Ingress](ingress.md) · [Caddy templates](caddy-templates.md)

This guide covers a hardened **single-host** Caddy deployment. A host, Docker engine or network outage still interrupts every app on that host. The extension does not provide automatic failover, capacity planning, backups or an external monitoring service.

## Defaults and their purpose

Fresh stacks created with `ingress.caddy.provision` have these defaults. Existing stacks keep their operator-managed Compose and Caddyfile settings.

| Area                  | Behavior                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration updates | Route writes and removals share one lock with setup. Complete files replace the old file by rename. `caddy reload` validates and activates the complete configuration inside the running process.              |
| Failed updates        | Restore the prior site file and attempt a recovery reload. If recovery fails, retain the lock and private recovery directory for inspection. Never print raw Caddy diagnostics, which can include credentials. |
| Admin interface       | Bind explicitly to `localhost:2019` inside the container. Publish only web ports; never publish 2019 or proxy it through a public site.                                                                        |
| Health                | Probe the private admin API with `wget`, discard its response and require healthy status during startup. Readiness also rejects stopped or unhealthy Caddy containers.                                         |
| Shutdown              | Set `grace_period 30s` and Docker `stop_grace_period: 40s`. Configure `provision.gracePeriodSeconds` when applications need a different drain budget.                                                          |
| Storage               | Persist `/data` and `/config`; mount the root Caddyfile and sites read-only. Keep the container root filesystem read-only, with a 64 MiB temporary filesystem at `/tmp`.                                       |
| Privileges            | Set `no-new-privileges`. The image still needs permission to read private host bind directories and write its state; this is not a rootless-container profile.                                                 |
| Logs                  | Limit Docker JSON logs to three 10 MiB files. Optional request logs retain the existing 100 MB rotation, ten rotated files and 720-hour retention. Budget disk for every app and certificate storage.          |
| Metrics               | Enable metrics on the private admin endpoint without per-host labels. Monitoring collection and alerts remain operator responsibilities.                                                                       |
| DNS                   | Resolve A and AAAA records. `ingress.caddy.address` is an optional IP assertion; omit it behind a CDN or whenever public DNS should not equal the origin IP.                                                   |

Caddy recommends reloads for production configuration changes. Reload validates and provisions before replacing the running configuration; separate `caddy validate` processes can conflict with modules that require exclusive resources. Bootstrap still validates using a disposable container before starting the shared service. See [Caddy commands](https://caddyserver.com/docs/command-line#caddy-reload) and [validation](https://caddyserver.com/docs/command-line#caddy-validate).

The storage and graceful shutdown choices follow [Caddy's Docker guidance](https://caddyserver.com/docs/running#docker-compose) and [global options](https://caddyserver.com/docs/caddyfile/options#grace-period). Image compatibility still matters: provisioning expects `caddy`, BusyBox-compatible `wget`, and support for the read-only root filesystem. Custom root templates must preserve HTTP admin access at `localhost:2019` for the generated healthcheck and should use `grace_period {{gracePeriod}}`.

## Workload-specific templates

Keep these choices in [templates](caddy-templates.md) rather than adding universal settings that can break applications:

- **Streaming and WebSockets:** assess `stream_close_delay` in the site's `reverse_proxy` block to spread reconnects during config changes. Do not promise uninterrupted streams across reloads. Select the delay and shutdown budget for the actual clients.
- **Timeouts and retries:** measure upload sizes, response times and streaming behavior before setting timeouts. Avoid blanket write retries; an upstream may have processed a request before its connection failed. Health checks and load balancing must match the number and behavior of real upstreams.
- **Client IPs behind a CDN:** configure only the actual proxy CIDRs and use strict forwarded-chain parsing when appropriate. Do not blindly trust all private networks or user-supplied forwarding headers. Caddy already handles standard forwarded headers; custom `X-Real-IP` is an app-specific choice.
- **TLS and headers:** use Caddy's automatic HTTPS defaults. Add HSTS, authentication, caching or content policies only after checking all affected applications and subdomains. Do not enable unrestricted on-demand TLS.

See the [reverse proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [trusted proxies](https://caddyserver.com/docs/caddyfile/options#trusted-proxies), and [automatic HTTPS](https://caddyserver.com/docs/automatic-https).

## Monitor, back up and maintain

Pin a tested image **digest**, including the required DNS plugin. Tags can move; the extension accepts them for compatibility but cannot make them reproducible. Test updates in a disposable environment, retain the previous digest and configuration, and schedule shared-container recreation because it can interrupt all sites. Plan security updates for Caddy, DNS modules, Docker and the host OS.

Back up `data/`, `config/`, `Caddyfile`, `sites/`, the Compose file and the separately managed credential file. `/data` contains certificate private keys and ACME accounts; encrypt backups, restrict access and test restoration. Do not delete persistent storage to fix a deployment. Rotate DNS API tokens and scope them to the necessary zones and permissions.

Scrape `/metrics` through a trusted collector that can reach the container's loopback interface, or design a separate protected metrics endpoint. Do not expose the admin API merely to make scraping easier: it can read and replace configuration. Alert on external HTTPS availability, certificate expiry, upstream failures, latency, container health/restarts and disk usage. Metrics are described in [Caddy monitoring](https://caddyserver.com/docs/metrics); admin capabilities and security are in the [API reference](https://caddyserver.com/docs/api).

Docker marks a container unhealthy but does not automatically restart a running unhealthy process with `restart: unless-stopped`; that policy restarts exited processes. Establish an operational response for unhealthy status. The generated healthcheck confirms admin responsiveness, not public TLS or app readiness. The CLI's public HTTP wait accepts statuses below 500, so a login page or 404 can count as reachable. Use application health endpoints, service healthchecks in Compose, and external probes that assert the expected status/body.

Load-test representative traffic, uploads, slow clients, WebSockets and reloads before setting capacity targets. Observe memory, CPU, open files and network limits. Test graceful shutdown with your longest supported requests. The defaults are a starting point, not evidence of a particular throughput or availability target. Ports are published on IPv4 by default; IPv6 DNS support alone does not configure end-to-end IPv6 listening or firewall rules.

## Locks and recovery

Every new setup, route and removal operation uses `<dir>/.compoza-caddy.lock`. An overlapping operation fails rather than overwriting another app's changes. Retry once the other operation completes. Direct manual edits, older CLI versions, old frozen release scripts, and other admin API clients do not honor this lock; coordinate them separately. Deploy fresh releases to capture the updated route runtime before relying on it during rollback.

On reload failure, the extension restores the old file and tries a recovery reload to handle ambiguous outcomes such as a lost response. If recovery succeeds, the command still reports failure. If it fails, the lock and `sites/.compoza-route.*` directory remain; the CLI prints its path but not its contents. This directory is private and does not match `sites/*.caddy` imports.

Before clearing a retained lock:

1. Confirm no setup or route operation is still running. A lock can also remain after host failure or `SIGKILL`.
2. Inspect the current site file, the private recovery directory and Caddy's state locally on the host. `previous` holds the prior site when one existed. Logs/configuration can contain secrets; do not paste them into shared output.
3. Restore the intended file if needed, then reload Caddy using its configured root Caddyfile. Verify the affected sites and admin health. A killed process may have left disk and running configuration at different revisions.
4. Remove only the verified stale lock and its recovery directory, then retry the interrupted deployment.

These protections coordinate configuration files and reloads. They do not roll back application containers, databases or migrations when later deployment steps fail.

## Adopting the changes on an existing host

`setup-proxy` without `provision` only integrates per-app sites; it does not retrofit these container defaults. Provisioning also refuses to overwrite differing existing files, including files generated by an earlier CLI version. Adding `provision` to an existing host does not automatically upgrade its proxy configuration.

Back up the current stack and review its inline routes, custom mounts, environment requirements and image modules. Merge the desired root-template settings into the existing Caddyfile; preserve every existing route and the sites import. Merge the healthcheck, stop budget, log limits and filesystem restrictions into its Compose service, checking that extra modules have all required writable paths. Verify the exact image in a disposable environment first. Reconcile the stored template/host configuration with the reviewed files so future previews remain useful.

Apply shared Caddyfile changes with a validating reload. Applying Compose changes requires a controlled container recreation, with a maintenance window if brief interruption is unacceptable. Verify private admin health, public certificates and each important application afterward. Keep the original files and image digest available for recovery. Updating the CLI does not modify running hosts.

## Reference documentation and verification

Use `docsdown` to keep a local copy of the official Caddy documentation in `.reference/caddy/`. That directory is ignored by Git; `docsdown.json` and `manifest.json` record the source and crawl. To download or refresh the local reference:

```sh
docsdown https://caddyserver.com/docs/ --output .reference/caddy --concurrency 4 --max-pages 250 --max-media-mb 5
```

Automated tests exercise real Bash transactions with fake Docker failures, concurrency, interrupted staging, file restoration, retained recovery state, credential redaction, schema checks and the Compose parser. An opt-in Docker smoke test starts a disposable stack with a random loopback HTTP port, then checks real admin health, metrics, writable logs, route activation, rejected reload recovery and removal:

```sh
COMPOZA_TEST_CADDY_IMAGES=caddy:2.10.2-alpine,caddy:2-alpine vp test src/extensions/caddy/caddy.docker.test.ts
```

Images must already be present; the test never pulls them. It uses unique containers/networks and cleans them up. These checks do not exercise public ACME issuance, a real DNS token, host failover or production load.

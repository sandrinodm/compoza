# Caddy templates

[README](../README.md) · [Commands](commands.md) · [Configuration](configuration.md) · [Ingress](ingress.md) · [Secrets](secrets.md) · [SSH deployment](ssh-deployment.md) · [Development](development.md)

Use templates when a shared Caddyfile or an app route needs custom directives. Host setup and provisioning are in [Ingress](ingress.md#shared-caddy-proxy).

- [Select template sources](#select-template-sources)
- [Shared Caddyfile template](#shared-caddyfile-template)
- [Site template](#site-template)
- [Variables and sections](#variables-and-sections)
- [Override a template for one app](#override-a-template-for-one-app)
- [Validation and lifecycle](#validation-and-lifecycle)

Caddy configuration lives in templates: the [bundled site template](../src/extensions/caddy/templates/site.caddy.tmpl) and [bundled Caddyfile template](../src/extensions/caddy/templates/Caddyfile.tmpl) define the default configuration. See [Caddy production operations](caddy-production.md) for the hardening defaults and how to apply them to an integrated stack.

## Select template sources

Override either under the host's `ingress.caddy.templates`:

```yaml
templates:
  site: ./caddy/site.caddy.tmpl
  config: ./caddy/Caddyfile.tmpl
```

These paths refer to files **on the CLI machine**, relative to the YAML file declaring the host. With a host `$ref`, they resolve relative to the referenced host file. Absolute paths and `~/` paths work too. Local hosts override entire global entries before template files are read. Files must be readable text files no larger than 256 KiB. Inline templates are also accepted:

```yaml
templates:
  site:
    inline: |
      {{domain}} {
        reverse_proxy http://{{upstream}}
      }
```

## Shared Caddyfile template

A shared `Caddyfile.tmpl` can own your TLS and logging choices directly:

```caddyfile
{
    admin localhost:2019
    metrics
    grace_period {{gracePeriod}}
    acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}
}

(request_log) {
    log {
        output file /data/{args[0]}.log {
            roll_size 100mb
            roll_keep 10
            roll_keep_for 720h
        }
        format json
    }
}

{{sitesImport}}
```

## Site template

The default template for apps can be as simple as this `site.caddy.tmpl`:

```caddyfile
{{domain}} {
    import request_log {{name}}
    reverse_proxy http://{{upstream}}
}
```

With those templates, `tls`, `logSnippet` and `provision.acmeDns` can be omitted from the host YAML because the template text supplies those choices. Provisioning still needs its image and any host env-file path. Never put literal credentials in templates: Caddy resolves `{env.CLOUDFLARE_API_TOKEN}` inside its container.

## Variables and sections

| Template      | Supported variables                                                      |
| ------------- | ------------------------------------------------------------------------ |
| Site          | `name` (Compose project name), `domain`, `upstream`, `tls`, `logSnippet` |
| Shared config | `acmeDns`, `logSnippet`, `sitesImport`, `gracePeriod`                    |

Use `{{variable}}` for literal substitution, `{{#variable}}...{{/variable}}` for a section included when the value is nonempty, and `{{^variable}}...{{/variable}}` for a section included when it is empty. Sections may nest. Optional missing values are empty strings. Unknown variables, malformed placeholders and unclosed sections are errors, including inside skipped sections. There is no code evaluation, escaping, environment lookup, file include or loop syntax. Single-brace Caddy placeholders such as `{remote_host}`, `{args[0]}` and `{env.TOKEN}` remain untouched, and replacement values are never interpreted as further templates.

`gracePeriod` is a duration such as `30s`, derived from `provision.gracePeriodSeconds`. Custom root templates must retain admin HTTP on `localhost:2019` for the provisioned healthcheck. If you hardcode a different drain duration, keep it below the generated Docker stop budget.

## Override a template for one app

An app or destination can override the host's site template through `deploy.yaml`:

```yaml
ingress:
  caddy:
    domain: budget.example.com
    upstream: host.docker.internal:8300
    siteTemplate: ./caddy/budget.caddy.tmpl
```

The app template path resolves relative to `deploy.yaml`, after destination selection. For budget's custom header, that file could contain:

```caddyfile
{{domain}} {
    reverse_proxy http://{{upstream}} {
        header_up X-Real-IP {remote_host}
    }
}
```

## Validation and lifecycle

Templates are read once during configuration resolution and rendered before remote execution. Readiness compares the rendered site, deployment uses a validating reload under the shared Caddy lock, and SSH lifecycle metadata retains the deployed removal operation so deletion ignores unshipped local template edits. `templates.config` is used only for provisioning a fresh root Caddyfile; it must render `{{sitesImport}}` on its own line at top level. Template CRLF line endings are normalized to LF. It does not replace an operator-managed Caddyfile or bypass provisioning's checks for files already on the host. Updating a shared config template after provisioning therefore requires the same explicit reconciliation as other provisioning changes.

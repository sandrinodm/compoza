import { Effect, Path } from 'effect';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import type { App } from '../../config/deploy.ts';
import type { HostConfig } from '../../config/hosts.ts';
import type { CloudflareProxy } from './config.ts';

import { parseConfig } from '../../config/config-file.ts';
import { loadTemplate, renderTemplate } from '../caddy/templates.ts';

/**
 * The largest rendered Compose or route template accepted, in bytes. Anything larger is rejected
 * before it is parsed.
 */
export const MAX_RENDERED_TEMPLATE_BYTES = 256 * 1024;

/**
 * The shipped connector Compose template; all dynamic scalars are JSON-quoted before substitution.
 */
export const defaultComposeTemplate = readFileSync(
  new URL('./templates/compose.yaml.tmpl', import.meta.url),
  'utf8',
);

/**
 * The route template used when neither the application nor the host supplies one.
 */
const DEFAULT_ROUTE_TEMPLATE = ['hostname: {{domain}}', 'service: {{service}}', ''].join('\n');

/**
 * The only fields a rendered route may contain; `originRequest` is the one optional addition.
 */
const ROUTE_RULE_FIELDS = new Set(['hostname', 'service', 'originRequest']);

/**
 * Resolves host-relative templates and credential file sources before pure operation planning.
 */
export const loadCloudflareHostFiles = Effect.fn('loadCloudflareHostFiles')(function* (
  host: HostConfig,
  file: string,
) {
  const named = host.ingress !== undefined && 'cloudflare-tunnel' in host.ingress;
  const selected = cloudflareHostSettings(host);
  if (selected === undefined) {
    return host;
  }

  if (selected.templates === undefined && envFileSecret(selected.provision) === undefined) {
    return host;
  }

  const templates = { ...selected.templates };
  for (const kind of ['compose', 'route'] as const) {
    const source = templates[kind];
    if (source !== undefined) {
      templates[kind] = yield* loadTemplate(source, file, `Cloudflare ${kind} template`);
    }
  }

  let provision = selected.provision;
  const secret = envFileSecret(provision);
  if (provision !== undefined && secret !== undefined) {
    const path = yield* Path.Path;
    const source = secret.path;
    // This repeats `expandHome` from config/hosts.ts, which imports this module through
    // extensions/config.ts, so importing it here would create an import cycle.
    const expanded = source.startsWith('~/') ? path.join(homedir(), source.slice(2)) : source;
    provision = {
      ...provision,
      secrets: { 'env-file': { path: path.resolve(path.dirname(file), expanded) } },
    };
  }

  const result = { ...selected, ...(provision === undefined ? {} : { provision }), templates };
  return named
    ? { ...host, ingress: { ...host.ingress, 'cloudflare-tunnel': result } }
    : { ...host, proxy: { ...result, provider: 'cloudflare-tunnel' as const } };
});

/**
 * Selects Cloudflare host settings from either named or legacy host configuration.
 */
function cloudflareHostSettings(host: HostConfig) {
  if (host.ingress !== undefined && 'cloudflare-tunnel' in host.ingress) {
    return host.ingress['cloudflare-tunnel'];
  }

  return host.proxy?.provider === 'cloudflare-tunnel' ? host.proxy : undefined;
}

/**
 * The env-file secret source of a provisioned connector, or undefined when the connector is not
 * provisioned or uses another credential source.
 */
function envFileSecret(provision: CloudflareProxy['provision']) {
  const secrets = provision?.secrets;
  return secrets !== undefined && 'env-file' in secrets ? secrets['env-file'] : undefined;
}

/**
 * Selects Cloudflare application settings from either named or legacy ingress configuration.
 */
function cloudflareAppSettings(ingress: App['config']['ingress']) {
  if (ingress === undefined) {
    return undefined;
  }

  if ('cloudflare-tunnel' in ingress) {
    return ingress['cloudflare-tunnel'];
  }

  return 'mode' in ingress && ingress.mode === 'cloudflare-tunnel' ? ingress : undefined;
}

/**
 * Distinguishes YAML mappings from scalars, null and sequences before accessing route fields.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Loads only the selected application's override; unselected destination files are never accessed.
 */
export const loadCloudflareAppFiles = Effect.fn('loadCloudflareAppFiles')(function* (app: App) {
  const ingress = app.config.ingress;
  const selected = cloudflareAppSettings(ingress);
  if (ingress === undefined || selected?.routeTemplate === undefined) {
    return app;
  }

  const routeTemplate = yield* loadTemplate(
    selected.routeTemplate,
    app.file ?? `${app.dir}/deploy.yaml`,
    'Cloudflare route template',
  );
  return {
    ...app,
    config: {
      ...app.config,
      ingress:
        'cloudflare-tunnel' in ingress
          ? { 'cloudflare-tunnel': { ...selected, routeTemplate } }
          : { ...selected, mode: 'cloudflare-tunnel' as const, routeTemplate },
    },
  };
});

/**
 * Renders one YAML route while preserving ownership identity and rejecting credential-bearing
 * top-level fields.
 */
export function routeRule(proxy: CloudflareProxy, app: App, name: string) {
  const selected = cloudflareAppSettings(app.config.ingress);
  if (selected === undefined) {
    throw new Error('Cloudflare route settings are missing');
  }

  const text = renderTemplate(
    selected.routeTemplate ?? proxy.templates?.route,
    DEFAULT_ROUTE_TEMPLATE,
    {
      name: JSON.stringify(name),
      domain: JSON.stringify(selected.domain),
      service: JSON.stringify(selected.service),
    },
    'Cloudflare route template',
  );
  if (Buffer.byteLength(text) > MAX_RENDERED_TEMPLATE_BYTES) {
    throw new Error('Cloudflare route template is too large');
  }

  let rule: unknown;
  try {
    rule = parseConfig(text);
  } catch {
    throw new Error('Cloudflare route template must render valid YAML');
  }

  if (!isRecord(rule) || !preservesRoute(rule, selected)) {
    throw new Error(
      'Cloudflare route template must preserve hostname/service ' +
        'and may add only originRequest settings',
    );
  }

  return rule;
}

/**
 * Whether a rendered route keeps the application's hostname and service and adds nothing but an
 * `originRequest` mapping.
 */
function preservesRoute(
  rule: Record<string, unknown>,
  selected: { readonly domain: string; readonly service: string },
): boolean {
  return (
    rule.hostname === selected.domain &&
    rule.service === selected.service &&
    Object.keys(rule).every((key) => ROUTE_RULE_FIELDS.has(key)) &&
    (rule.originRequest === undefined || isRecord(rule.originRequest))
  );
}

import { Effect, FileSystem, Path } from 'effect';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import type { App } from '../../config/deploy.ts';
import type { HostConfig } from '../../config/hosts.ts';
import type { CaddyTemplate, ProxyConfig } from './config.ts';

import { DeployError } from '../../errors.ts';

/**
 * The bundled site template preserves existing app route output.
 */
export const defaultSiteTemplate = readFileSync(new URL('./templates/site.caddy.tmpl', import.meta.url), 'utf8');

/**
 * The shared Caddyfile template used for fresh-stack provisioning by default.
 */
export const defaultConfigTemplate = readFileSync(new URL('./templates/Caddyfile.tmpl', import.meta.url), 'utf8');

/**
 * The maximum template size in bytes, preventing accidental reads of large unrelated files.
 */
const MAX_TEMPLATE_BYTES = 256 * 1024;

/**
 * Renders literal text, variables, truthy sections and inverted sections without evaluating code or environment.
 *
 * Sections can nest. Every token is checked even in a skipped section, so configuration mistakes fail early.
 * Substituted values are never parsed again, preserving Caddy placeholders and literal dollar signs.
 */
export function renderTemplate(
  source: CaddyTemplate | undefined,
  fallback: string,
  values: Record<string, string>,
  label: string,
): string {
  if (typeof source === 'string') {
    throw new Error(`${label}: template file must be loaded before planning`);
  }

  const template = (source?.inline ?? fallback).replaceAll('\r\n', '\n');
  const stack: Array<{ key: string; active: boolean }> = [];
  let cursor = 0;
  let output = '';
  const active = () => stack.every((section) => section.active);

  for (const match of template.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const before = template.slice(cursor, match.index);
    if (before.includes('{{')) {
      throw new Error(`${label}: malformed template placeholder`);
    }

    if (active()) {
      output += before;
    }

    const token = /^\s*([#^/]?)([a-zA-Z][a-zA-Z0-9]*)\s*$/.exec(match[1]!);
    if (token === null) {
      throw new Error(`${label}: invalid template placeholder`);
    }

    const kind = token[1]!;
    const key = token[2]!;
    if (!Object.hasOwn(values, key)) {
      throw new Error(`${label}: unknown template variable ${key}`);
    }

    if (kind === '/') {
      if (stack.pop()?.key !== key) {
        throw new Error(`${label}: mismatched template section ${key}`);
      }
    } else if (kind === '#' || kind === '^') {
      stack.push({ key, active: kind === '#' ? values[key] !== '' : values[key] === '' });
    } else if (active()) {
      output += values[key];
    }

    cursor = match.index + match[0].length;
  }

  const tail = template.slice(cursor);
  if (tail.includes('{{')) {
    throw new Error(`${label}: unclosed template placeholder`);
  }

  if (stack.length > 0) {
    throw new Error(`${label}: unclosed template section`);
  }

  if (active()) {
    output += tail;
  }

  return output;
}

/**
 * Loads template sources relative to their declaring YAML file; only inline text enters pure planning.
 */
export const loadTemplate = Effect.fn('loadTemplate')(function* (
  source: CaddyTemplate,
  file: string,
  label = 'Caddy template',
) {
  if (typeof source !== 'string') {
    return source;
  }

  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const resolved = path.resolve(
    path.dirname(file),
    source.startsWith('~/') ? path.join(homedir(), source.slice(2)) : source,
  );
  const fail = () =>
    new DeployError({
      message: `Cannot read ${label} ${resolved}; use a readable text file no larger than 256 KiB`,
    });
  const info = yield* fs.stat(resolved).pipe(Effect.mapError(fail));
  if (info.type !== 'File' || Number(info.size) > MAX_TEMPLATE_BYTES) {
    return yield* fail();
  }

  const inline = yield* fs.readFileString(resolved).pipe(Effect.mapError(fail));
  if (Buffer.byteLength(inline) > MAX_TEMPLATE_BYTES) {
    return yield* fail();
  }

  return { inline };
});

/**
 * The supported placeholders for each template kind, also used to reject typos before any host operation.
 */
const templateVariables = {
  site: { name: '', domain: '', upstream: '', tls: '', logSnippet: '' },
  config: { acmeDns: '', logSnippet: '', sitesImport: '', gracePeriod: '' },
};

/**
 * Validates file and inline template syntax while errors can still be reported as configuration failures.
 */
const loadCheckedTemplate = Effect.fn('loadCheckedCaddyTemplate')(function* (
  source: CaddyTemplate,
  file: string,
  kind: keyof typeof templateVariables,
) {
  const loaded = yield* loadTemplate(source, file);
  yield* Effect.try({
    try: () => renderTemplate(loaded, '', templateVariables[kind], `Caddy ${kind} template declared in ${file}`),
    catch: (cause) => new DeployError({ message: cause instanceof Error ? cause.message : 'Invalid Caddy template' }),
  });

  return loaded;
});

/**
 * Resolves only a winning host entry, preserving named and legacy ingress selection.
 */
export const loadHostTemplates = Effect.fn('loadCaddyHostTemplates')(function* (host: HostConfig, file: string) {
  const proxy = host.ingress !== undefined && 'caddy' in host.ingress ? host.ingress.caddy : host.proxy;
  if (proxy === undefined || ('provider' in proxy && proxy.provider === 'cloudflare-tunnel')) {
    return host;
  }

  const caddy = proxy as ProxyConfig;
  if (caddy.templates === undefined) {
    return host;
  }

  const templates = { ...caddy.templates };
  if (templates.site !== undefined) {
    templates.site = yield* loadCheckedTemplate(templates.site, file, 'site');
  }

  if (templates.config !== undefined) {
    templates.config = yield* loadCheckedTemplate(templates.config, file, 'config');
  }

  return host.ingress !== undefined && 'caddy' in host.ingress
    ? { ...host, ingress: { ...host.ingress, caddy: { ...host.ingress.caddy, templates } } }
    : { ...host, proxy: { ...caddy, templates } };
});

/**
 * Loads an app override after destination selection, avoiding reads from unselected destinations.
 */
export const loadAppTemplates = Effect.fn('loadCaddyAppTemplates')(function* (app: App) {
  const ingress = app.config.ingress;
  if (ingress === undefined) {
    return app;
  }

  const settings =
    'caddy' in ingress ? ingress.caddy : 'mode' in ingress && ingress.mode === 'caddy' ? ingress : undefined;
  if (settings?.siteTemplate === undefined) {
    return app;
  }

  const siteTemplate = yield* loadCheckedTemplate(settings.siteTemplate, app.file ?? `${app.dir}/deploy.yaml`, 'site');
  return {
    ...app,
    config: {
      ...app.config,
      ingress:
        'caddy' in ingress
          ? { caddy: { ...ingress.caddy, siteTemplate } }
          : { ...settings, mode: 'caddy' as const, siteTemplate },
    },
  };
});

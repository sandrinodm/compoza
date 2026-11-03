import { Effect, FileSystem, Path } from 'effect';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import type { App } from '../../config/deploy.ts';
import type { HostConfig } from '../../config/hosts.ts';
import type { CaddyTemplate } from './config.ts';

import { DeployError } from '../../errors.ts';

/**
 * The bundled site template, used when neither the app nor the host supplies one.
 */
export const defaultSiteTemplate = readFileSync(
  new URL('./templates/site.caddy.tmpl', import.meta.url),
  'utf8',
);

/**
 * The shared Caddyfile template used for fresh-stack provisioning by default.
 */
export const defaultConfigTemplate = readFileSync(
  new URL('./templates/Caddyfile.tmpl', import.meta.url),
  'utf8',
);

/**
 * The maximum template size in bytes, preventing accidental reads of large unrelated files.
 */
const MAX_TEMPLATE_BYTES = 256 * 1024;

/**
 * Matches one `{{...}}` placeholder; the capture is everything between the braces, newlines
 * included, so a malformed token is reported rather than copied as literal text.
 */
const PLACEHOLDER_PATTERN = /\{\{([\s\S]*?)\}\}/g;

/**
 * Splits a placeholder body into its optional section sigil (`#` opens, `^` opens inverted, `/`
 * closes) and a variable name, allowing surrounding whitespace.
 */
const TOKEN_PATTERN = /^\s*([#^/]?)([a-zA-Z][a-zA-Z0-9]*)\s*$/;

/**
 * Renders literal text, variables, truthy sections and inverted sections without evaluating code or
 * environment.
 *
 * Sections can nest. Every token is checked even in a skipped section, so configuration mistakes
 * fail early. Substituted values are never parsed again, preserving Caddy placeholders and literal
 * dollar signs.
 */
export function renderTemplate(
  source: CaddyTemplate | undefined,
  fallback: string,
  values: Record<string, string>,
  label: string,
): string {
  if (typeof source === 'string') {
    throw templateError(label, 'template file must be loaded before planning');
  }

  const template = (source?.inline ?? fallback).replaceAll('\r\n', '\n');
  const stack: Array<{ key: string; active: boolean }> = [];
  let cursor = 0;
  let output = '';

  /**
   * Whether output is currently being kept: true when every open section's condition holds.
   */
  const active = () => stack.every((section) => section.active);

  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const before = template.slice(cursor, match.index);
    if (before.includes('{{')) {
      throw templateError(label, 'malformed template placeholder');
    }

    if (active()) {
      output += before;
    }

    const token = TOKEN_PATTERN.exec(match[1]!);
    if (token === null) {
      throw templateError(label, 'invalid template placeholder');
    }

    const kind = token[1]!;
    const key = token[2]!;
    if (!Object.hasOwn(values, key)) {
      throw templateError(label, `unknown template variable ${key}`);
    }

    if (kind === '/') {
      if (stack.pop()?.key !== key) {
        throw templateError(label, `mismatched template section ${key}`);
      }
    } else if (kind === '#' || kind === '^') {
      // A section renders when its value is set; an inverted section when it is empty.
      stack.push({ key, active: kind === '#' ? values[key] !== '' : values[key] === '' });
    } else if (active()) {
      output += values[key];
    }

    cursor = match.index + match[0].length;
  }

  const tail = template.slice(cursor);
  if (tail.includes('{{')) {
    throw templateError(label, 'unclosed template placeholder');
  }

  if (stack.length > 0) {
    throw templateError(label, 'unclosed template section');
  }

  if (active()) {
    output += tail;
  }

  return output;
}

/**
 * Builds a template syntax error prefixed with the template's label. A plain `Error` because
 * `renderTemplate` is synchronous; `loadCheckedTemplate` turns it into a configuration error.
 */
function templateError(label: string, problem: string): Error {
  return new Error(`${label}: ${problem}`);
}

/**
 * Loads template sources relative to their declaring YAML file; only inline text enters pure
 * planning.
 */
export const loadTemplate = Effect.fn('loadTemplate')(function* (
  source: CaddyTemplate,
  file: string,
  label = 'Caddy template',
): Effect.fn.Return<{ readonly inline: string }, DeployError, FileSystem.FileSystem | Path.Path> {
  if (typeof source !== 'string') {
    return source;
  }

  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const resolved = path.resolve(
    path.dirname(file),
    source.startsWith('~/') ? path.join(homedir(), source.slice(2)) : source,
  );

  /**
   * The single error for every way the file can be unusable: missing, not a regular file, too
   * large, or unreadable.
   */
  const fail = () =>
    new DeployError({
      message:
        `Cannot read ${label} ${resolved}; ` +
        `use a readable text file no larger than ${MAX_TEMPLATE_BYTES / 1024} KiB`,
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
 * The supported placeholders for each template kind, also used to reject typos before any host
 * operation.
 */
const templateVariables = {
  /**
   * The per-app site file, `sites/<project>.caddy`.
   */
  site: { name: '', domain: '', upstream: '', tls: '', logSnippet: '' },

  /**
   * The shared Caddyfile of a provisioned Caddy.
   */
  config: { acmeDns: '', logSnippet: '', sitesImport: '', gracePeriod: '' },
};

/**
 * Validates file and inline template syntax while errors can still be reported as configuration
 * failures.
 */
const loadCheckedTemplate = Effect.fn('loadCheckedCaddyTemplate')(function* (
  source: CaddyTemplate,
  file: string,
  kind: keyof typeof templateVariables,
) {
  const loaded = yield* loadTemplate(source, file);
  yield* Effect.try({
    try: () =>
      renderTemplate(
        loaded,
        '',
        templateVariables[kind],
        `Caddy ${kind} template declared in ${file}`,
      ),
    catch: (cause) =>
      new DeployError({
        message: cause instanceof Error ? cause.message : 'Invalid Caddy template',
      }),
  });

  return loaded;
});

/**
 * Loads the template files of a winning host entry's Caddy ingress, returning the host unchanged
 * when it has no Caddy ingress or names no templates.
 */
export const loadHostTemplates = Effect.fn('loadCaddyHostTemplates')(function* (
  host: HostConfig,
  file: string,
): Effect.fn.Return<HostConfig, DeployError, FileSystem.FileSystem | Path.Path> {
  if (host.ingress === undefined || !('caddy' in host.ingress)) {
    return host;
  }

  const proxy = host.ingress.caddy;
  if (proxy.templates === undefined) {
    return host;
  }

  const templates = { ...proxy.templates };
  if (templates.site !== undefined) {
    templates.site = yield* loadCheckedTemplate(templates.site, file, 'site');
  }

  if (templates.config !== undefined) {
    templates.config = yield* loadCheckedTemplate(templates.config, file, 'config');
  }

  return { ...host, ingress: { ...host.ingress, caddy: { ...proxy, templates } } };
});

/**
 * Loads an app override after destination selection, avoiding reads from unselected destinations.
 */
export const loadAppTemplates = Effect.fn('loadCaddyAppTemplates')(function* (
  app: App,
): Effect.fn.Return<App, DeployError, FileSystem.FileSystem | Path.Path> {
  const ingress = app.config.ingress;
  if (ingress === undefined || !('caddy' in ingress)) {
    return app;
  }

  const settings = ingress.caddy;
  if (settings.siteTemplate === undefined) {
    return app;
  }

  const siteTemplate = yield* loadCheckedTemplate(
    settings.siteTemplate,
    app.file ?? `${app.dir}/deploy.yaml`,
    'site',
  );
  return {
    ...app,
    config: {
      ...app.config,
      ingress: { caddy: { ...settings, siteTemplate } },
    },
  };
});

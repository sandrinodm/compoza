import { Effect } from 'effect';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';

import type { App } from './config/deploy.ts';

import { expandHome } from './config/hosts.ts';
import { secretSource } from './config/secrets.ts';
import { DeployError } from './errors.ts';

/**
 * One explicitly selected release file, encoded for line-oriented SSH input.
 *
 * Binary assets remain intact, and neither shell interpolation nor a host tar implementation controls extraction paths.
 */
export interface BundleFile {
  /**
   * The safe deploy-relative path, preserving the release directory layout.
   */
  readonly path: string;

  /**
   * The base64-encoded contents, never including a production dotenv file.
   */
  readonly encoded: string;
}

/**
 * The maximum upload size in bytes, before base64 encoding: four MiB across at most 128 regular files.
 *
 * Source trees belong to BuildKit's dockerignore-aware context transfer, rather than the Compose release bundle.
 */
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

/**
 * Validates an explicit release path without normalizing away dangerous components.
 *
 * Dotfiles and tool-owned files are excluded so a declared asset cannot overwrite release metadata or upload dotenv
 * secrets.
 */
export function bundlePath(path: string): string {
  if (
    !/^[\w./-]+$/.test(path) ||
    path.split('/').some((part) => part === '' || part.startsWith('.')) ||
    path.startsWith('/') ||
    [
      'compose.sh',
      'compose.json',
      'runtime.sh',
      'model.jq',
      'status.jq',
      'release.env',
      'directories.sh',
      'route.sh',
      'unroute.sh',
      'health.sh',
      'manifest.json',
      'validation.log',
      'successful',
    ].some((reserved) => path === reserved || path.startsWith(`${reserved}/`))
  ) {
    throw new Error(`Unsafe bundle path: ${path}; use deploy-relative regular files without dot components`);
  }
  return path;
}

/**
 * Checks a Compose document's file references against the explicit bundle.
 *
 * Production env files and secret files stay absolute on the host. Includes and external extends are deliberately
 * replaced by selected `composeFiles`, avoiding implicit dotenv discovery and undeclared recursive file loading.
 */
export function validateComposeAssets(text: string, file: string, declared: ReadonlySet<string>): void {
  const document = parseDocument(text, { merge: true, prettyErrors: false });
  if (document.errors.length > 0) {
    throw new Error(`Cannot parse ${file}; check its YAML syntax`);
  }
  const model = document.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
  const walk = (value: unknown, parent = ''): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, parent));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (
          key === 'include' ||
          (key === 'extends' && typeof child === 'object' && child !== null && 'file' in child)
        ) {
          throw new Error(`${file}: use explicit composeFiles overlays instead of include or external extends`);
        }
        if (key === 'env_file') {
          const entries = Array.isArray(child) ? child : [child];
          for (const entry of entries) {
            const path = typeof entry === 'string' ? entry : entry?.path;
            if (typeof path !== 'string' || (!path.startsWith('/') && !path.startsWith('${'))) {
              throw new Error(
                `${file}: env_file paths must be absolute host paths; production secrets are never bundled`,
              );
            }
          }
        }
        if (key === 'file' && typeof child === 'string' && !child.startsWith('/') && !child.startsWith('${')) {
          const asset = child.replace(/^\.\//, '');
          if (parent === 'secrets' || !declared.has(asset)) {
            throw new Error(
              `${file}: declare non-secret file ${asset} in assets, or use an absolute host path for secrets`,
            );
          }
        }
        walk(child, parent === 'secrets' ? parent : key === 'secrets' ? 'secrets' : parent);
      }
    }
  };
  walk(model);
  const services = model?.services;
  if (services !== null && typeof services === 'object') {
    for (const [service, config] of Object.entries(services)) {
      for (const volume of config?.volumes ?? []) {
        const source = typeof volume === 'string' ? volume.split(':')[0] : volume?.source;
        const readOnly =
          typeof volume === 'string' ? volume.split(':').at(-1)?.split(',').includes('ro') : volume?.read_only === true;
        if (
          typeof source === 'string' &&
          (source.startsWith('.') || source.includes('/')) &&
          !source.startsWith('/') &&
          !source.startsWith('${')
        ) {
          const asset = source.replace(/^\.\//, '');
          if (!readOnly || !declared.has(asset)) {
            throw new Error(
              `${file}: service ${service} bind ${source} must be a declared read-only asset; use absolute host paths for data`,
            );
          }
        }
      }
    }
  }
}

/**
 * Reads the bounded release bundle without following symlinks, including symlinked parent directories.
 *
 * Only the selected Compose files and explicit regular-file assets leave the deploy folder; production env files are
 * not read.
 */
export const readBundle = Effect.fn('readBundle')(function* (app: App) {
  return yield* Effect.tryPromise({
    try: async () => {
      const paths = [...new Set([...app.config.composeFiles, ...(app.config.assets ?? [])])];
      if (paths.length > 128) {
        throw new Error('Compose bundles allow at most 128 files');
      }
      const source = secretSource(app);
      const secretPath = source?.provider === 'env-file' ? resolve(app.dir, expandHome(source.path)) : undefined;
      const secretRealPath = secretPath === undefined ? undefined : await realpath(secretPath).catch(() => secretPath);
      const files: Array<BundleFile> = [];
      const declared = new Set(paths.map(bundlePath));
      let total = 0;
      for (const path of paths) {
        if ((await lstat(app.dir)).isSymbolicLink()) {
          throw new Error('Deploy folder cannot be a symlink for SSH bundles');
        }
        let current = app.dir;
        for (const part of path.split('/')) {
          current = join(current, part);
          if ((await lstat(current)).isSymbolicLink()) {
            throw new Error(`Bundle symlinks are not allowed: ${path}`);
          }
        }
        const stat = await lstat(current);
        if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES || total + stat.size > MAX_BUNDLE_BYTES) {
          throw new Error(`Bundle must contain regular files totalling at most ${MAX_BUNDLE_BYTES} bytes: ${path}`);
        }
        if (secretRealPath !== undefined && (await realpath(current)) === secretRealPath) {
          throw new Error('Secret source files cannot be included in release assets');
        }
        const contents = await readFile(current);
        total += contents.length;
        if (app.config.composeFiles.includes(path)) {
          validateComposeAssets(contents.toString('utf8'), path, declared);
        }
        files.push({ path, encoded: contents.toString('base64') });
      }
      return files;
    },
    catch: (cause) =>
      new DeployError({
        message: `Compose bundle: ${cause instanceof Error ? cause.message : 'cannot read selected files'}`,
      }),
  });
});

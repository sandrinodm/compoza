import type { PlatformError } from 'effect/PlatformError';

import { Effect, FileSystem } from 'effect';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';

import type { App } from './config/deploy.ts';

import { expandHome } from './config/hosts.ts';
import { selectSecretSource } from './config/secrets.ts';
import { DeployError } from './errors.ts';

/**
 * One explicitly selected stack file, encoded for line-oriented SSH input.
 *
 * Binary assets remain intact, and neither shell interpolation nor a host tar implementation controls extraction paths.
 */
export interface BundleFile {
  /**
   * The safe deploy-relative path, preserving the stack directory layout.
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
 * Source trees belong to BuildKit's dockerignore-aware context transfer, rather than the Compose stack bundle.
 */
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

/**
 * Validates an explicit stack path without normalizing away dangerous components.
 *
 * Dotfiles are excluded so a declared asset cannot overwrite .env, .compoza.json or .deploy-lock, or upload dotenv
 * secrets.
 */
export const bundlePath = Effect.fn('bundlePath')(function* (path: string) {
  if (
    !/^[\w./-]+$/.test(path) ||
    path.split('/').some((part) => part === '' || part.startsWith('.')) ||
    path.startsWith('/')
  ) {
    return yield* Effect.fail(
      new DeployError({
        message: `Unsafe bundle path: ${path}; use deploy-relative regular files without dot components`,
      }),
    );
  }

  return path;
});

/**
 * Absolute paths and Compose variables refer to host-owned files rather than bundled assets.
 */
function isHostPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('${');
}

/**
 * Relative bind sources contain a path separator or begin with a dot; other sources name Docker volumes.
 */
function isRelativeBind(source: unknown): source is string {
  return typeof source === 'string' && (source.startsWith('.') || source.includes('/')) && !isHostPath(source);
}

/**
 * Narrows parsed YAML mappings before inspecting their fields.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Walks Compose file references, keeping production secrets outside the explicit asset bundle.
 */
function validateFileReferences(
  value: unknown,
  file: string,
  declared: ReadonlySet<string>,
  inSecrets = false,
  ancestors: ReadonlySet<object> = new Set(),
): Effect.Effect<void, DeployError> {
  return Effect.gen(function* () {
    if (value === null || typeof value !== 'object') {
      return;
    }

    if (ancestors.has(value)) {
      return yield* Effect.fail(new DeployError({ message: `${file}: cyclic YAML references are unsupported` }));
    }

    const parents = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        yield* validateFileReferences(item, file, declared, inSecrets, parents);
      }
      return;
    }

    if (!isRecord(value)) {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      const externalExtends = key === 'extends' && isRecord(child) && 'file' in child;
      if (key === 'include' || externalExtends) {
        return yield* Effect.fail(
          new DeployError({
            message: `${file}: use explicit composeFiles overlays instead of include or external extends`,
          }),
        );
      }

      if (key === 'env_file') {
        const entries = Array.isArray(child) ? child : [child];

        for (const entry of entries) {
          const path = typeof entry === 'string' ? entry : isRecord(entry) ? entry.path : undefined;
          if (typeof path !== 'string' || !isHostPath(path)) {
            return yield* Effect.fail(
              new DeployError({
                message: `${file}: env_file paths must be absolute host paths; production secrets are never bundled`,
              }),
            );
          }
        }
      }

      if (key === 'file' && typeof child === 'string' && !isHostPath(child)) {
        const asset = child.replace(/^\.\//, '');
        if (inSecrets || !declared.has(asset)) {
          return yield* Effect.fail(
            new DeployError({
              message: `${file}: declare non-secret file ${asset} in assets, or use an absolute host path for secrets`,
            }),
          );
        }
      }

      yield* validateFileReferences(child, file, declared, inSecrets || key === 'secrets', parents);
    }
  });
}

/**
 * Checks a Compose document's file references against the explicit bundle.
 *
 * Production env files and secret files stay absolute on the host. Includes and external extends are deliberately
 * replaced by selected `composeFiles`, avoiding implicit dotenv discovery and undeclared recursive file loading. Parser
 * exceptions are translated at the YAML boundary without exposing source contents.
 */
export const validateComposeAssets = Effect.fn('validateComposeAssets')(function* (
  text: string,
  file: string,
  declared: ReadonlySet<string>,
) {
  const invalidYaml = () => new DeployError({ message: `Cannot parse ${file}; check its YAML syntax` });
  const document = yield* Effect.try({
    try: () => parseDocument(text, { merge: true, prettyErrors: false }),
    catch: invalidYaml,
  });
  if (document.errors.length > 0) {
    return yield* Effect.fail(invalidYaml());
  }

  const model: unknown = yield* Effect.try({
    try: () => document.toJS({ maxAliasCount: 100 }),
    catch: invalidYaml,
  });
  if (!isRecord(model)) {
    return yield* Effect.fail(new DeployError({ message: `${file}: Compose document must be a mapping` }));
  }

  yield* validateFileReferences(model, file, declared);

  const services = model.services;
  if (services === undefined) {
    return;
  }

  if (!isRecord(services)) {
    return yield* Effect.fail(new DeployError({ message: `${file}: services must be a mapping` }));
  }

  for (const [service, config] of Object.entries(services)) {
    if (!isRecord(config)) {
      return yield* Effect.fail(new DeployError({ message: `${file}: service ${service} must be a mapping` }));
    }

    const volumes = config.volumes;
    if (volumes === undefined || volumes === null) {
      continue;
    }

    if (!Array.isArray(volumes)) {
      return yield* Effect.fail(new DeployError({ message: `${file}: service ${service} volumes must be a list` }));
    }

    for (const volume of volumes) {
      if (typeof volume !== 'string' && !isRecord(volume)) {
        return yield* Effect.fail(
          new DeployError({ message: `${file}: service ${service} volumes must contain strings or mappings` }),
        );
      }

      const source = typeof volume === 'string' ? volume.split(':')[0] : volume.source;
      if (!isRelativeBind(source)) {
        continue;
      }

      const readOnly =
        typeof volume === 'string' ? volume.split(':').at(-1)?.split(',').includes('ro') : volume.read_only === true;
      const asset = source.replace(/^\.\//, '');
      if (!readOnly || !declared.has(asset)) {
        return yield* Effect.fail(
          new DeployError({
            message: `${file}: service ${service} bind ${source} must be a declared read-only asset; use absolute host paths for data`,
          }),
        );
      }
    }
  }
});

/**
 * Resolves one bundle file while rejecting a symlink at any level of its deploy-relative path.
 */
const bundleFilePath = Effect.fn('bundleFilePath')(function* (fs: FileSystem.FileSystem, dir: string, path: string) {
  const root = yield* fs.lstat(dir);
  if (root.type === 'SymbolicLink') {
    return yield* Effect.fail(new DeployError({ message: 'Deploy folder cannot be a symlink for SSH bundles' }));
  }

  let current = dir;

  for (const part of path.split('/')) {
    current = join(current, part);
    const info = yield* fs.lstat(current);
    if (info.type === 'SymbolicLink') {
      return yield* Effect.fail(new DeployError({ message: `Bundle symlinks are not allowed: ${path}` }));
    }
  }

  return current;
});

/**
 * Reads the bounded stack bundle without following symlinks, including symlinked parent directories.
 *
 * Only the selected Compose files and explicit regular-file assets leave the deploy folder; production env files are
 * not read. Expected validation and filesystem failures use the typed channel; defects remain defects.
 */
export const readBundle = Effect.fn('readBundle')(
  function* (app: App) {
    const fs = yield* FileSystem.FileSystem;
    const paths = [...new Set([...app.config.composeFiles, ...(app.config.assets ?? [])])];
    if (paths.length > 128) {
      return yield* Effect.fail(new DeployError({ message: 'Compose bundles allow at most 128 files' }));
    }

    const source = yield* Effect.fromResult(selectSecretSource(app));
    const secretPath = source?.provider === 'env-file' ? resolve(app.dir, expandHome(source.path)) : undefined;
    const secretRealPath =
      secretPath === undefined
        ? undefined
        : yield* fs.realPath(secretPath).pipe(Effect.orElseSucceed(() => secretPath));
    const declared = new Set(yield* Effect.forEach(paths, bundlePath));

    const files: Array<BundleFile> = [];
    let total = 0;

    for (const path of paths) {
      const current = yield* bundleFilePath(fs, app.dir, path);
      const stat = yield* fs.lstat(current);
      if (stat.type !== 'File' || total + Number(stat.size) > MAX_BUNDLE_BYTES) {
        return yield* Effect.fail(
          new DeployError({
            message: `Bundle must contain regular files totalling at most ${MAX_BUNDLE_BYTES} bytes: ${path}`,
          }),
        );
      }

      if (secretRealPath !== undefined && (yield* fs.realPath(current)) === secretRealPath) {
        return yield* Effect.fail(
          new DeployError({ message: 'Secret source files cannot be included in stack assets' }),
        );
      }

      const contents = Buffer.from(yield* fs.readFile(current));
      total += contents.length;

      if (app.config.composeFiles.includes(path)) {
        yield* validateComposeAssets(contents.toString('utf8'), path, declared);
      }

      files.push({ path, encoded: contents.toString('base64') });
    }

    return files;
  },
  Effect.mapError(
    (error: DeployError | PlatformError) => new DeployError({ message: `Compose bundle: ${error.message}` }),
  ),
);

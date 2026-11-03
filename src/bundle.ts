import type { PlatformError } from 'effect/PlatformError';

import { Effect, FileSystem } from 'effect';
import { basename, isAbsolute, join, parse, resolve } from 'node:path';
import { parseDocument } from 'yaml';

import type { App } from './config/deploy.ts';

import { expandHome } from './config/hosts.ts';
import { selectSecretSource } from './config/secrets.ts';
import { DeployError } from './errors.ts';

/**
 * One explicitly selected stack file, encoded for line-oriented SSH input.
 *
 * Binary assets remain intact, and neither shell interpolation nor a host tar implementation
 * controls extraction paths.
 */
export interface BundleFile {
  /**
   * The safe upload path; absolute Compose sources are staged under their basename.
   */
  readonly path: string;

  /**
   * The base64-encoded contents, never including a production dotenv file.
   */
  readonly encoded: string;
}

/**
 * The maximum upload size in bytes, before base64 encoding: four MiB across all selected files.
 *
 * Source trees belong to BuildKit's dockerignore-aware context transfer, rather than the Compose
 * stack bundle.
 */
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

/**
 * The maximum number of distinct Compose files and assets in one bundle.
 */
const MAX_BUNDLE_FILES = 128;

/**
 * The most YAML alias expansions accepted while converting a Compose document, which bounds the
 * work a small file with nested aliases can cause.
 */
const MAX_YAML_ALIASES = 100;

/**
 * The characters a bundle path may contain: word characters, dots, slashes and hyphens.
 */
const SAFE_BUNDLE_PATH = /^[\w./-]+$/;

/**
 * Line breaks and NUL, which no path passed to the host may contain.
 */
const LINE_BREAK_OR_NUL = /[\r\n\0]/;

/**
 * The optional `./` prefix of a relative Compose reference, removed before comparing it with the
 * declared assets.
 */
const LEADING_DOT_SLASH = /^\.\//;

/**
 * Keeps explicit external Compose sources inside the upload folder without exposing workstation
 * paths to the host.
 *
 * Relative Compose paths retain their layout. The bundle reader validates names and rejects output
 * collisions before reading files, so two external files with the same basename cannot overwrite
 * one another.
 */
export function composeBundlePath(file: string): string {
  return isAbsolute(file) ? basename(file) : file;
}

/**
 * Validates an explicit stack path without normalizing away dangerous components.
 *
 * Dotfiles are excluded so a declared asset cannot overwrite .env, .compoza.json or .deploy-lock,
 * or upload dotenv secrets.
 */
export const bundlePath = Effect.fn('bundlePath')(function* (
  path: string,
): Effect.fn.Return<string, DeployError> {
  const hasEmptyOrDotComponent = path
    .split('/')
    .some((part) => part === '' || part.startsWith('.'));
  if (!SAFE_BUNDLE_PATH.test(path) || hasEmptyOrDotComponent || path.startsWith('/')) {
    return yield* new DeployError({
      message:
        `Unsafe bundle path: ${path}; ` +
        'use deploy-relative regular files without dot components',
    });
  }

  return path;
});

/**
 * Checks a Compose document's file references against the explicit bundle.
 *
 * Production env files and secret files stay absolute on the host. Includes and external extends
 * are deliberately replaced by selected `composeFiles`, avoiding implicit dotenv discovery and
 * undeclared recursive file loading. Parser exceptions are translated at the YAML boundary without
 * exposing source contents.
 */
export const validateComposeAssets = Effect.fn('validateComposeAssets')(function* (
  text: string,
  file: string,
  declared: ReadonlySet<string>,
): Effect.fn.Return<void, DeployError> {
  const model = yield* parseComposeModel(text, file);
  yield* validateFileReferences(model, file, declared);
  yield* validateServices(model.services, file, declared);
});

/**
 * Reads the bounded stack bundle without following symlinks, including symlinked parent
 * directories.
 *
 * Compose files may be explicit absolute sources outside the deploy folder; assets remain
 * deploy-relative. Production env files are not read. Expected validation and filesystem failures
 * use the typed channel; defects remain defects.
 */
export const readBundle = Effect.fn('readBundle')(
  function* (
    app: App,
  ): Effect.fn.Return<Array<BundleFile>, DeployError | PlatformError, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const paths = [...new Set([...app.config.composeFiles, ...(app.config.assets ?? [])])];
    if (paths.length > MAX_BUNDLE_FILES) {
      return yield* new DeployError({
        message: `Compose bundles allow at most ${MAX_BUNDLE_FILES} files`,
      });
    }

    const secretRealPath = yield* secretSourceRealPath(fs, app);
    const compose = new Set(app.config.composeFiles);
    const declared = yield* declaredUploadPaths(app, paths, compose);

    const files: Array<BundleFile> = [];
    let total = 0;
    for (const path of paths) {
      const current = yield* bundleFilePath(fs, app.dir, path);
      const stat = yield* fs.lstat(current);
      if (stat.type !== 'File' || total + Number(stat.size) > MAX_BUNDLE_BYTES) {
        return yield* new DeployError({
          message:
            `Bundle must contain regular files totalling at most ${MAX_BUNDLE_BYTES} bytes: ` +
            path,
        });
      }

      if (secretRealPath !== undefined && (yield* fs.realPath(current)) === secretRealPath) {
        return yield* new DeployError({
          message: 'Secret source files cannot be included in stack assets',
        });
      }

      const contents = Buffer.from(yield* fs.readFile(current));
      total += contents.length;

      if (compose.has(path)) {
        yield* validateComposeAssets(contents.toString('utf8'), path, declared);
      }

      files.push({ path: uploadPath(path, compose), encoded: contents.toString('base64') });
    }

    return files;
  },
  Effect.mapError(
    (error: DeployError | PlatformError) =>
      new DeployError({ message: `Compose bundle: ${error.message}` }),
  ),
);

/**
 * Builds a validation failure that names the Compose file it was found in.
 */
function composeFileError(file: string, problem: string): DeployError {
  return new DeployError({ message: `${file}: ${problem}` });
}

/**
 * Builds the parse failure for a Compose file, deliberately leaving out the parser's message so
 * file contents never reach the output.
 */
function unparsableYaml(file: string): DeployError {
  return new DeployError({ message: `Cannot parse ${file}; check its YAML syntax` });
}

/**
 * Absolute paths and Compose variables refer to host-owned files rather than bundled assets.
 */
function isHostPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('${');
}

/**
 * Relative bind sources contain a path separator or begin with a dot; other sources name Docker
 * volumes.
 */
function isRelativeBind(source: unknown): source is string {
  return (
    typeof source === 'string' &&
    (source.startsWith('.') || source.includes('/')) &&
    !isHostPath(source)
  );
}

/**
 * Narrows parsed YAML mappings before inspecting their fields.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The declared asset a relative Compose reference names, without its optional `./` prefix.
 */
function assetPath(reference: string): string {
  return reference.replace(LEADING_DOT_SLASH, '');
}

/**
 * Parses one Compose file into a plain mapping, reporting syntax errors, excessive alias expansion
 * and non-mapping documents without exposing the file's contents.
 */
function parseComposeModel(
  text: string,
  file: string,
): Effect.Effect<Record<string, unknown>, DeployError> {
  return Effect.gen(function* () {
    const document = yield* Effect.try({
      try: () => parseDocument(text, { merge: true, prettyErrors: false }),
      catch: () => unparsableYaml(file),
    });
    if (document.errors.length > 0) {
      return yield* unparsableYaml(file);
    }

    const model: unknown = yield* Effect.try({
      try: () => document.toJS({ maxAliasCount: MAX_YAML_ALIASES }),
      catch: () => unparsableYaml(file),
    });
    if (!isRecord(model)) {
      return yield* composeFileError(file, 'Compose document must be a mapping');
    }

    return model;
  });
}

/**
 * Walks Compose file references, keeping production secrets outside the explicit asset bundle.
 *
 * `inSecrets` marks values below a `secrets` key, whose files must never be bundled; `ancestors`
 * holds the objects on the current path so cyclic YAML aliases fail instead of recursing forever.
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
      return yield* composeFileError(file, 'cyclic YAML references are unsupported');
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
      const problem = fileReferenceProblem(key, child, declared, inSecrets);
      if (problem !== undefined) {
        return yield* composeFileError(file, problem);
      }

      yield* validateFileReferences(child, file, declared, inSecrets || key === 'secrets', parents);
    }
  });
}

/**
 * Checks one mapping entry for a file reference the bundle cannot honour: includes and external
 * extends, bundled env files, and undeclared or secret files. Returns the requirement that failed,
 * or `undefined` when the entry is acceptable.
 */
function fileReferenceProblem(
  key: string,
  child: unknown,
  declared: ReadonlySet<string>,
  inSecrets: boolean,
): string | undefined {
  const externalExtends = key === 'extends' && isRecord(child) && 'file' in child;
  if (key === 'include' || externalExtends) {
    return 'use explicit composeFiles overlays instead of include or external extends';
  }

  if (key === 'env_file') {
    const entries = Array.isArray(child) ? child : [child];
    for (const entry of entries) {
      const path = envFilePath(entry);
      if (typeof path !== 'string' || !isHostPath(path)) {
        return 'env_file paths must be absolute host paths; production secrets are never bundled';
      }
    }
  }

  if (key === 'file' && typeof child === 'string' && !isHostPath(child)) {
    const asset = assetPath(child);
    if (inSecrets || !declared.has(asset)) {
      return (
        `declare non-secret file ${asset} in assets, ` + 'or use an absolute host path for secrets'
      );
    }
  }

  return undefined;
}

/**
 * The path of one `env_file` entry, written either as a string or as a mapping with `path`.
 */
function envFilePath(entry: unknown): unknown {
  if (typeof entry === 'string') {
    return entry;
  }

  return isRecord(entry) ? entry.path : undefined;
}

/**
 * Checks every service's bind mounts: relative binds must be declared, read-only assets, so host
 * data always lives behind an absolute path.
 */
function validateServices(
  services: unknown,
  file: string,
  declared: ReadonlySet<string>,
): Effect.Effect<void, DeployError> {
  return Effect.gen(function* () {
    if (services === undefined) {
      return;
    }

    if (!isRecord(services)) {
      return yield* composeFileError(file, 'services must be a mapping');
    }

    for (const [service, config] of Object.entries(services)) {
      const problem = serviceProblem(config, declared);
      if (problem !== undefined) {
        return yield* composeFileError(file, `service ${service} ${problem}`);
      }
    }
  });
}

/**
 * Checks one service's shape and volumes. Returns the requirement that failed, phrased to follow
 * the service name, or `undefined` when the service is acceptable.
 */
function serviceProblem(config: unknown, declared: ReadonlySet<string>): string | undefined {
  if (!isRecord(config)) {
    return 'must be a mapping';
  }

  const volumes = config.volumes;
  if (volumes === undefined || volumes === null) {
    return undefined;
  }

  if (!Array.isArray(volumes)) {
    return 'volumes must be a list';
  }

  for (const volume of volumes) {
    if (typeof volume !== 'string' && !isRecord(volume)) {
      return 'volumes must contain strings or mappings';
    }

    const source = volumeSource(volume);
    if (!isRelativeBind(source)) {
      continue;
    }

    if (!isReadOnlyVolume(volume) || !declared.has(assetPath(source))) {
      return (
        `bind ${source} must be a declared read-only asset; ` + 'use absolute host paths for data'
      );
    }
  }

  return undefined;
}

/**
 * The source of a volume in short (`source:target[:options]`) or long (mapping) syntax.
 */
function volumeSource(volume: string | Record<string, unknown>): unknown {
  return typeof volume === 'string' ? volume.split(':')[0] : volume.source;
}

/**
 * Whether a volume is mounted read-only: an `ro` option in short syntax, or `read_only: true` in
 * long syntax.
 */
function isReadOnlyVolume(volume: string | Record<string, unknown>): boolean {
  if (typeof volume === 'string') {
    return volume.split(':').at(-1)?.split(',').includes('ro') === true;
  }

  return volume.read_only === true;
}

/**
 * Resolves the canonical path of an `env-file` secret source, so the bundle can refuse to upload it
 * under any name. A path that cannot be resolved is compared as written.
 */
function secretSourceRealPath(
  fs: FileSystem.FileSystem,
  app: App,
): Effect.Effect<string | undefined, DeployError> {
  return Effect.gen(function* () {
    const source = yield* Effect.fromResult(selectSecretSource(app));
    if (source?.provider !== 'env-file') {
      return undefined;
    }

    const secretPath = resolve(app.dir, expandHome(source.path));
    return yield* fs.realPath(secretPath).pipe(Effect.orElseSucceed(() => secretPath));
  });
}

/**
 * Validates the upload path of every selected file and returns them as a set. Fails when two files
 * would be staged under the same name (for example two absolute Compose files with one basename) or
 * when an asset is absolute.
 */
function declaredUploadPaths(
  app: App,
  paths: ReadonlyArray<string>,
  compose: ReadonlySet<string>,
): Effect.Effect<ReadonlySet<string>, DeployError> {
  return Effect.gen(function* () {
    const staged = paths.map((path) => uploadPath(path, compose));
    const declared = new Set(yield* Effect.forEach(staged, bundlePath));
    if (declared.size !== paths.length) {
      return yield* new DeployError({
        message: 'Compose and asset upload paths must be distinct',
      });
    }

    if (app.config.assets?.some(isAbsolute)) {
      return yield* new DeployError({ message: 'Assets must use deploy-relative paths' });
    }

    return declared;
  });
}

/**
 * The path a selected file is uploaded under: Compose files go through `composeBundlePath`, assets
 * keep their deploy-relative path.
 */
function uploadPath(path: string, compose: ReadonlySet<string>): string {
  return compose.has(path) ? composeBundlePath(path) : path;
}

/**
 * Resolves one selected source while rejecting symlinks at every inspected component of its path.
 */
const bundleFilePath = Effect.fn('bundleFilePath')(function* (
  fs: FileSystem.FileSystem,
  dir: string,
  path: string,
) {
  const root = yield* fs.lstat(dir);
  if (root.type === 'SymbolicLink') {
    return yield* new DeployError({ message: 'Deploy folder cannot be a symlink for SSH bundles' });
  }

  // Absolute sources are selected Compose files, never assets. Every ancestor of the source is
  // inspected before it is read.
  const absolute = isAbsolute(path);
  const parts = absolute ? path.slice(parse(path).root.length).split('/') : path.split('/');
  const hasDotOrEmptyComponent = parts.some((part) => part === '' || part === '.' || part === '..');
  if (absolute && (LINE_BREAK_OR_NUL.test(path) || hasDotOrEmptyComponent)) {
    return yield* new DeployError({
      message: 'Absolute Compose paths cannot contain dot or empty components',
    });
  }

  let current = absolute ? parse(path).root : dir;
  for (const part of parts) {
    current = join(current, part);
    const info = yield* fs.lstat(current);
    if (info.type === 'SymbolicLink') {
      return yield* new DeployError({ message: `Bundle symlinks are not allowed: ${path}` });
    }
  }

  return current;
});

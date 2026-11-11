import { Effect, FileSystem } from 'effect';
import { dirname, relative, resolve } from 'node:path';
import { type Document, isAlias, isMap, isScalar, isSeq } from 'yaml';

import type { App, RunOptions } from './config/deploy.ts';

import { type ComposeFile, parseComposeFile } from './bundle.ts';
import { composeFilesOf } from './config/deploy.ts';
import { DeployError } from './errors.ts';

/**
 * The YAML tag that removes a value, or a whole `environment:`, set by an earlier file.
 */
const RESET_TAG = '!reset';

/**
 * The YAML tag that replaces a value set by an earlier file instead of merging into it.
 */
const OVERRIDE_TAG = '!override';

/**
 * How deep merge keys and aliases are followed before a mapping is treated as empty, which only a
 * cyclic document can reach.
 */
const MAX_MERGE_DEPTH = 32;

/**
 * The variable names every service sets in its `environment:` after Compose merges the selected
 * files, each with the file that last set it.
 */
export type ComposeEnvironment = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * What one service of one file does to the `environment:` accumulated from earlier files.
 */
interface Contribution {
  /**
   * Whether earlier files' variables are dropped first (`!reset` or `!override`).
   */
  readonly replace: boolean;

  /**
   * The variables set, each with the file that sets it.
   */
  readonly keys: ReadonlyMap<string, string>;

  /**
   * The variables removed with a per-key `!reset`.
   */
  readonly removed: ReadonlySet<string>;
}

/**
 * A Compose file read for this check, with the name used in messages.
 */
interface Loaded {
  /**
   * The absolute path, which also keys the cache and detects cycles.
   */
  readonly path: string;

  /**
   * The name shown in messages: as written in `composeFiles`, else relative to the deploy folder.
   */
  readonly name: string;

  /**
   * The parsed file.
   */
  readonly file: ComposeFile;
}

/**
 * Reads the selected Compose files the way Compose merges them and returns, for every service, the
 * variables it sets in `environment:`.
 *
 * Later files merge into earlier ones; `environment: !reset` clears what came before, `environment:
 * !override` replaces it, and a `!reset` value removes one variable. A service's `extends` (same
 * file, or another file relative to the declaring file) contributes its variables first. Under
 * client execution `include:` entries are read relative to the including file, and the services
 * they declare count; SSH execution rejects `include:` elsewhere, so it is ignored here unless the
 * run is local, because a local run always uses client-side Compose. Service fields are read
 * through `<<` merge keys. A file named by `extends` or `include` that cannot be read is skipped,
 * because Compose reports it. Fails when a selected file cannot be read or parsed.
 */
export const readComposeEnvironment = Effect.fn('readComposeEnvironment')(function* (
  app: App,
  options: RunOptions,
): Effect.fn.Return<ComposeEnvironment, DeployError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const cache = new Map<string, Loaded | undefined>();
  const follow = app.config.execution !== 'ssh' || options.local === true;

  const load = Effect.fn('loadComposeFile')(function* (
    path: string,
    name: string,
    required: boolean,
  ): Effect.fn.Return<Loaded | undefined, DeployError> {
    const known = cache.get(path);
    if (known !== undefined || (!required && cache.has(path))) {
      return known;
    }

    const text = yield* fs
      .readFileString(path)
      .pipe(Effect.orElseSucceed((): string | undefined => undefined));
    if (text === undefined && required) {
      return yield* new DeployError({ message: `Cannot read Compose file ${name}` });
    }

    const loaded =
      text === undefined ? undefined : { path, name, file: yield* parseComposeFile(text, name) };
    cache.set(path, loaded);

    return loaded;
  });

  const contributionOf = Effect.fn('contributionOf')(function* (
    loaded: Loaded,
    node: unknown,
    visiting: ReadonlySet<string>,
  ): Effect.fn.Return<Contribution, DeployError> {
    const service = resolveNode(node, loaded.file.document);
    if (!isMap(service)) {
      return emptyContribution();
    }

    const fields = mappingEntries(service, loaded.file.document);
    const own = environmentContribution(fields.get('environment'), loaded);
    const base = yield* inheritedContribution(loaded, fields.get('extends'), visiting);
    return combine(base, own);
  });

  const inheritedContribution = Effect.fn('inheritedContribution')(function* (
    loaded: Loaded,
    extension: unknown,
    visiting: ReadonlySet<string>,
  ): Effect.fn.Return<Contribution, DeployError> {
    const reference = extendsReference(extension, loaded.file.document);
    if (reference === undefined) {
      return emptyContribution();
    }

    const target =
      reference.file === undefined
        ? loaded
        : yield* load(
            resolve(dirname(loaded.path), reference.file),
            relative(app.dir, resolve(dirname(loaded.path), reference.file)),
            false,
          );
    const key = `${target?.path}#${reference.service}`;
    const node = target === undefined ? undefined : servicesOf(target).get(reference.service);
    if (target === undefined || node === undefined || visiting.has(key)) {
      return emptyContribution();
    }

    return yield* contributionOf(target, node, new Set(visiting).add(key));
  });

  const apply = Effect.fn('applyFile')(function* (
    loaded: Loaded,
    services: Map<string, Map<string, string>>,
    inProgress: ReadonlySet<string>,
  ): Effect.fn.Return<void, DeployError> {
    const path = new Set(inProgress).add(loaded.path);
    if (follow) {
      for (const include of includedFiles(loaded)) {
        if (path.has(include)) {
          continue;
        }

        const included = yield* load(include, relative(app.dir, include), false);
        if (included !== undefined) {
          yield* apply(included, services, path);
        }
      }
    }

    for (const [name, node] of servicesOf(loaded)) {
      if (tagOf(node) === RESET_TAG) {
        services.delete(name);
        continue;
      }

      const contribution = yield* contributionOf(loaded, node, new Set([`${loaded.path}#${name}`]));
      const base = tagOf(node) === OVERRIDE_TAG ? undefined : services.get(name);
      services.set(name, merge(base, contribution));
    }
  });

  const services = new Map<string, Map<string, string>>();
  for (const name of composeFilesOf(app.config, options)) {
    const loaded = yield* load(resolve(app.dir, name), name, true);
    if (loaded !== undefined) {
      yield* apply(loaded, services, new Set());
    }
  }

  return services;
});

/**
 * A contribution that sets and removes nothing.
 */
function emptyContribution(): Contribution {
  return { replace: false, keys: new Map(), removed: new Set() };
}

/**
 * The services declared by one file, by name, with their YAML nodes.
 */
function servicesOf(loaded: Loaded): ReadonlyMap<string, unknown> {
  return mappingEntries(loaded.file.document.get('services', true), loaded.file.document);
}

/**
 * The absolute paths named by a file's top-level `include:`, each written as a string or as a
 * mapping whose `path` is a string or a list of strings, relative to the including file.
 */
function includedFiles(loaded: Loaded): ReadonlyArray<string> {
  const document = loaded.file.document;
  const include = resolveNode(document.get('include', true), document);
  if (!isSeq(include)) {
    return [];
  }

  const paths = include.items.flatMap((item) => {
    const entry = resolveNode(item, document);
    if (isScalar(entry)) {
      return [entry.value];
    }

    const path = resolveNode(mappingEntries(entry, document).get('path'), document);
    return isSeq(path) ? path.items.map((part) => resolveNode(part, document)) : [path];
  });
  return paths
    .map((path) => (isScalar(path) ? path.value : path))
    .filter((path): path is string => typeof path === 'string')
    .map((path) => resolve(dirname(loaded.path), path));
}

/**
 * The service, and optionally the file, a service's `extends` names, written as a string or a
 * mapping. `undefined` when it is absent or malformed.
 */
function extendsReference(
  node: unknown,
  document: Document.Parsed,
): { readonly service: string; readonly file: string | undefined } | undefined {
  const extension = resolveNode(node, document);
  if (isScalar(extension)) {
    return scalarString(extension) === undefined
      ? undefined
      : { service: String(extension.value), file: undefined };
  }

  const fields = mappingEntries(extension, document);
  const service = scalarString(resolveNode(fields.get('service'), document));
  const file = scalarString(resolveNode(fields.get('file'), document));
  return service === undefined ? undefined : { service, file };
}

/**
 * The string value of a scalar node, else `undefined`.
 */
function scalarString(node: unknown): string | undefined {
  return isScalar(node) && typeof node.value === 'string' ? node.value : undefined;
}

/**
 * What an `environment:` node does: its variables, written as a mapping or a list of `KEY=value`
 * and `KEY` entries, and whether its tag clears earlier values. A whole-node `!reset` discards its
 * payload as well, so it sets no variables; `!override` keeps its payload as the replacement.
 */
function environmentContribution(node: unknown, loaded: Loaded): Contribution {
  const document = loaded.file.document;
  const environment = resolveNode(node, document);
  const keys = new Map<string, string>();
  const removed = new Set<string>();
  const tag = tagOf(environment);
  if (tag === RESET_TAG) {
    return { replace: true, keys, removed };
  }

  if (isMap(environment)) {
    for (const [key, value] of mappingEntries(environment, document)) {
      if (tagOf(resolveNode(value, document)) === RESET_TAG) {
        removed.add(key);
      } else {
        keys.set(key, loaded.name);
      }
    }
  } else if (isSeq(environment)) {
    for (const item of environment.items) {
      const entry = scalarString(resolveNode(item, document));
      if (entry !== undefined) {
        keys.set(entry.split('=')[0] ?? entry, loaded.name);
      }
    }
  }

  return { replace: tag === OVERRIDE_TAG, keys, removed };
}

/**
 * The contribution of a service that inherits `base` through `extends` and sets `own`.
 */
function combine(base: Contribution, own: Contribution): Contribution {
  if (own.replace) {
    return own;
  }

  const keys = new Map(base.keys);
  for (const key of own.removed) {
    keys.delete(key);
  }

  for (const [key, file] of own.keys) {
    keys.set(key, file);
  }

  const removed = new Set([...base.removed, ...own.removed]);
  for (const key of own.keys.keys()) {
    removed.delete(key);
  }

  return { replace: base.replace, keys, removed };
}

/**
 * The variables of a service after a later file's `contribution` is merged into `base`.
 */
function merge(
  base: ReadonlyMap<string, string> | undefined,
  contribution: Contribution,
): Map<string, string> {
  const next = new Map(contribution.replace ? undefined : base);
  for (const key of contribution.removed) {
    next.delete(key);
  }

  for (const [key, file] of contribution.keys) {
    next.set(key, file);
  }

  return next;
}

/**
 * The node an alias points at, or the node itself.
 */
function resolveNode(node: unknown, document: Document.Parsed): unknown {
  return isAlias(node) ? node.resolve(document) : node;
}

/**
 * The explicit YAML tag of a node, such as `!reset`, or `undefined` for an untagged one.
 */
function tagOf(node: unknown): string | undefined {
  return isScalar(node) || isSeq(node) || isMap(node) ? node.tag : undefined;
}

/**
 * The entries of a mapping node by key, following aliases and `<<` merge keys. Explicit keys win
 * over merged ones, and earlier merge sources win over later ones. Anything that is not a mapping
 * has no entries.
 */
function mappingEntries(
  node: unknown,
  document: Document.Parsed,
  depth = 0,
): ReadonlyMap<string, unknown> {
  const mapping = resolveNode(node, document);
  const entries = new Map<string, unknown>();
  if (!isMap(mapping) || depth > MAX_MERGE_DEPTH) {
    return entries;
  }

  const inherited = new Map<string, unknown>();
  for (const pair of mapping.items) {
    const key: unknown = isScalar(pair.key) ? pair.key.value : pair.key;
    if (typeof key === 'symbol') {
      const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
      for (const source of sources) {
        for (const [name, value] of mappingEntries(source, document, depth + 1)) {
          if (!inherited.has(name)) {
            inherited.set(name, value);
          }
        }
      }
    } else if (typeof key === 'string') {
      entries.set(key, pair.value);
    }
  }

  for (const [name, value] of inherited) {
    if (!entries.has(name)) {
      entries.set(name, value);
    }
  }

  return entries;
}

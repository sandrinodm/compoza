import { Effect, type FileSystem, Path } from 'effect';

import { DeployError } from '../errors.ts';
import { checkSharedHosts, DEFAULT_HOSTS_PATH, expandHome } from './hosts.ts';
import {
  deleteSetting,
  editSettings,
  HOST_LINKS_SETTING,
  loadSettings,
  SettingsFile,
} from './settings.ts';

/**
 * What a link or unlink did, for the command to report.
 */
export interface LinkChange {
  /**
   * The link as stored in the settings file: an absolute path.
   */
  readonly link: string;

  /**
   * Whether the settings file changed; `false` when the link was already present.
   */
  readonly changed: boolean;

  /**
   * The settings file.
   */
  readonly file: string;
}

/**
 * How `linkHosts` validates a new link.
 */
interface LinkOptions {
  /**
   * The global hosts file the link must not clash with; `DEFAULT_HOSTS_PATH` when left out.
   */
  readonly globalFile?: string;
}

/**
 * The linked hosts files and folders, in the order they are read.
 */
export const hostLinks = Effect.fn('hostLinks')(function* (): Effect.fn.Return<
  ReadonlyArray<string>,
  DeployError,
  FileSystem.FileSystem
> {
  return (yield* loadSettings()).hosts?.links ?? [];
});

/**
 * Links a hosts file, or a folder holding a `hosts.yaml`, so every run reads its hosts alongside
 * the global hosts file. The target is stored as an absolute path, resolved against the working
 * directory.
 *
 * Nothing is saved when the target is missing or invalid, or when it defines a host that the global
 * file or another link already defines; those fail with a `DeployError`. Linking a path that is
 * already linked changes nothing.
 */
export const linkHosts = Effect.fn('linkHosts')(function* (
  target: string,
  { globalFile = DEFAULT_HOSTS_PATH }: LinkOptions = {},
): Effect.fn.Return<LinkChange, DeployError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const link = path.resolve(expandHome(target));
  const links = yield* hostLinks();

  if (links.some((existing) => path.resolve(expandHome(existing)) === link)) {
    return { link, changed: false, file: yield* SettingsFile };
  }

  const next = [...links, link];
  yield* checkSharedHosts(next, globalFile);

  const file = yield* editSettings((document) => document.setIn(HOST_LINKS_SETTING, next));
  return { link, changed: true, file };
});

/**
 * Removes a link, matching it as written or as the absolute path it resolves to. The target does
 * not need to exist. Fails with a `DeployError` listing the links when it is not linked.
 */
export const unlinkHosts = Effect.fn('unlinkHosts')(function* (
  target: string,
): Effect.fn.Return<LinkChange, DeployError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const resolved = path.resolve(expandHome(target));
  const links = yield* hostLinks();
  /**
   * Whether a stored link is the target, as written or as the path it resolves to.
   */
  const matches = (link: string) => link === target || path.resolve(expandHome(link)) === resolved;
  const removed = links.find(matches);

  if (removed === undefined) {
    return yield* new DeployError({
      message: `${target} is not linked (links: ${links.join(', ') || 'none'})`,
    });
  }

  const kept = links.filter((link) => !matches(link));
  const file = yield* editSettings((document) => {
    if (kept.length === 0) {
      deleteSetting(document, HOST_LINKS_SETTING);
    } else {
      document.setIn(HOST_LINKS_SETTING, kept);
    }
  });
  return { link: removed, changed: true, file };
});

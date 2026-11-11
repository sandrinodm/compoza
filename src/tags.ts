import type { DeployConfig, RunOptions } from './config/deploy.ts';
import type { RoleSources } from './roles.ts';

import { rolesOf } from './config/deploy.ts';
import { buildingRoles } from './roles.ts';

/**
 * The tag shown for a deploy that builds nothing, so there is no commit to name the images after.
 */
const THIRD_PARTY_TAG = 'third-party';

/**
 * What Docker accepts as an image tag: up to 128 letters, digits, underscores, dots and dashes, not
 * starting with a dot or dash.
 */
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * What `parseTagFlags` needs to know about the run.
 */
export interface TagOptions extends RunOptions {
  /**
   * The roles the run removed, so `--tag` can say so instead of calling them unknown.
   */
  readonly removed?: ReadonlyArray<string>;
}

/**
 * Reads the values of the repeatable `--tag` flag into one tag per building role.
 *
 * `--tag <tag>` is the default for every building role and `--tag <role>=<tag>` overrides it for
 * one role. Throws an `Error` naming the problem when a role is unknown or has no `build`, a role
 * or the bare tag is given twice, a tag is empty or not a valid Docker tag, or a building role is
 * left without a tag. Any `--tag` fails when no role builds, since there are no images to reuse. A
 * role that a destination or local run removed cannot be named.
 */
export function parseTagFlags(
  values: ReadonlyArray<string>,
  config: DeployConfig,
  options: TagOptions = {},
): Readonly<Record<string, string>> {
  const roles = Object.keys(rolesOf(config, options));
  const building = buildingRoles(config, options);
  const named = new Map<string, string>();
  const bare: Array<string> = [];

  for (const value of values) {
    const separator = value.indexOf('=');
    const role = separator < 0 ? undefined : value.slice(0, separator);
    const tag = separator < 0 ? value : value.slice(separator + 1);
    if (tag === '') {
      throw new Error(
        role === undefined ? '--tag needs a tag' : `--tag ${role}= needs a tag after =`,
      );
    }

    if (!TAG_PATTERN.test(tag)) {
      throw new Error(
        `--tag ${value} is not a valid Docker tag (letters, digits, underscores, dots and ` +
          'dashes, at most 128 characters, not starting with a dot or dash); ' +
          'to name a role use --tag <role>=<tag>',
      );
    }

    if (role === undefined) {
      bare.push(tag);
      continue;
    }

    if (options.removed?.includes(role) === true && !roles.includes(role)) {
      throw new Error(`Role "${role}" is removed for this run, so --tag cannot name it`);
    }

    if (!roles.includes(role)) {
      throw new Error(`Unknown role "${role}" in --tag; roles: ${roles.join(', ') || 'none'}`);
    }

    if (!building.includes(role)) {
      throw new Error(
        `Role "${role}" has no build, so --tag cannot name it; ` +
          `roles with build: ${building.join(', ') || 'none'}`,
      );
    }

    if (named.has(role)) {
      throw new Error(`Role "${role}" is given twice in --tag`);
    }

    named.set(role, tag);
  }

  if (building.length === 0 && values.length > 0) {
    throw new Error('No role has a build, so there are no images to reuse; deploy without --tag');
  }

  if (bare.length > 1) {
    throw new Error('Only one --tag without a role is allowed; use --tag <role>=<tag> per role');
  }

  const tags: Record<string, string> = {};
  for (const role of building) {
    const tag = named.get(role) ?? bare[0];
    if (tag === undefined) {
      throw new Error(`No tag for role "${role}"; pass --tag <tag> or --tag ${role}=<tag>`);
    }

    tags[role] = tag;
  }

  return tags;
}

/**
 * The tags of a deploy as one phrase for messages: the single tag when every role shares it,
 * `web=abc worker=def` otherwise, and `third-party` when nothing is built.
 */
export function tagLabel(sources: RoleSources): string {
  const entries = Object.entries(sources);
  const tags = new Set(entries.map(([, source]) => source.tag));
  if (tags.size === 0) {
    return THIRD_PARTY_TAG;
  }

  if (tags.size === 1) {
    return [...tags][0] ?? THIRD_PARTY_TAG;
  }

  return entries.map(([role, source]) => `${role}=${source.tag}`).join(' ');
}

/**
 * The tag of every role in `sources`, as recorded in the deployed stack's metadata.
 */
export function tagsOf(sources: RoleSources): Record<string, string> {
  return Object.fromEntries(Object.entries(sources).map(([role, source]) => [role, source.tag]));
}

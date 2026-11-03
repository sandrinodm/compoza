import { readFileSync } from 'node:fs';

import { shellQuote } from './command.ts';

/**
 * Reads an installed host-runtime asset relative to this module, independently of the caller's
 * working directory.
 *
 * The ordinary Bash and jq sources are sent with each CLI transaction; the host keeps only
 * lifecycle metadata.
 */
export function runtimeAsset(name: 'runtime.sh' | 'model.jq' | 'status.jq'): string {
  return readFileSync(new URL(`./remote/${name}`, import.meta.url), 'utf8');
}

/**
 * Builds the shared host function definitions from the versioned Bash source.
 *
 * App configuration is passed separately as quoted arguments or JSON; it never changes these
 * program definitions.
 */
export function runtimeSource(): string {
  return [
    runtimeAsset('runtime.sh'),
    `model_filter=${shellQuote(runtimeAsset('model.jq'))}`,
    `status_filter=${shellQuote(runtimeAsset('status.jq'))}`,
    '',
  ].join('\n');
}

import { readFileSync } from 'node:fs';

/**
 * Reads an installed host-runtime asset relative to this module, independently of the caller's working directory.
 *
 * The same ordinary Bash and jq sources are sent for CLI transactions and staged for standalone host recovery.
 */
export function runtimeAsset(name: 'runtime.sh' | 'model.jq' | 'status.jq'): string {
  return readFileSync(new URL(`./remote/${name}`, import.meta.url), 'utf8');
}

/**
 * Builds the shared host function definitions from the versioned Bash source.
 *
 * App configuration is passed separately as quoted arguments or JSON; it never changes these program definitions.
 */
export function runtimeSource(): string {
  return `${runtimeAsset('runtime.sh')}\n`;
}

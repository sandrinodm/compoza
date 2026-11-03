import { REMOTE_PATH, shellQuote } from './command.ts';

/**
 * Parses the `key=value` lines that host readiness scripts print into a record. Values are trimmed,
 * a later line wins over an earlier one with the same key, and lines without a key before `=` are
 * ignored.
 */
export function parseCheck(output: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      values[line.slice(0, separator)] = line.slice(separator + 1).trim();
    }
  }

  return values;
}

/**
 * A host script that reports whether Docker on the host has a stored login for `registry`, as
 * `registry_login=yes` or `registry_login=no`, whichever ingress the host uses.
 *
 * It looks for the quoted registry name in `~/.docker/config.json`; a missing file counts as no
 * login.
 */
export function registryProbe(registry: string): string {
  const quotedRegistry = shellQuote(`"${registry}"`);
  return [
    'set -u',
    REMOTE_PATH,
    `if grep -q ${quotedRegistry} ~/.docker/config.json 2>/dev/null; then ` +
      'echo registry_login=yes; else echo registry_login=no; fi',
    '', // trailing newline
  ].join('\n');
}

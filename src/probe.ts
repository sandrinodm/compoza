import { REMOTE_PATH, shellQuote } from './command.ts';

/**
 * Parses the `key=value` output of `checkScript`; lines without `=` are ignored.
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
 * Probes the host's stored registry login independently of its ingress implementation.
 */
export function registryProbe(registry: string): string {
  return `set -u\n${REMOTE_PATH}\nif grep -q ${shellQuote(`"${registry}"`)} ~/.docker/config.json 2>/dev/null; then echo registry_login=yes; else echo registry_login=no; fi\n`;
}

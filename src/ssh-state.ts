import { runtimeSource } from './ssh-runtime.ts';

/**
 * Builds a read-only state lookup into shell variables from one immutable activation record.
 *
 * Inspections create no paths or diagnostics; mutations perform the same lookup while holding the stack lock.
 */
export function readStateScript(): string {
  return `${runtimeSource()}compoza_read_state\n`;
}

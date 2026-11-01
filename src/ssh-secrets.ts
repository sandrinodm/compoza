import type { App } from './config/deploy.ts';

import { shellQuote } from './command.ts';
import { resolveSecrets } from './extensions/config.ts';

/**
 * Builds protected snapshot staging from the next stdin record, separately from release files.
 *
 * Exclusive Bash redirection prevents symlink overwrite; failed staging cannot select the candidate source.
 */
export function stageSecrets(_root: string, id: string): string {
  return `compoza_stage_secret ${shellQuote(id)} || { echo 'Secret snapshot staging failed; active secrets unchanged' >&2; exit 1; }\n`;
}

/**
 * Builds the candidate source assignment after coherent current state lookup.
 *
 * Explicit `none` clears managed secrets; rollback omits this assignment and retains the current activation's source.
 */
export function candidateSecrets(app: App, root: string, id: string, managed: boolean): string {
  const path = managed
    ? `${root}/.secrets/${id}.env`
    : app.config.secrets !== undefined && resolveSecrets(app.config.secrets).provider === 'none'
      ? '-'
      : (app.config.remote?.envFile ?? `${root}/.env`);
  return `secret_file=${shellQuote(path)}\nsecret_required=${managed || app.config.remote?.envFile !== undefined ? 'yes' : 'no'}\nsecret_managed=${managed ? 'yes' : 'no'}\n`;
}

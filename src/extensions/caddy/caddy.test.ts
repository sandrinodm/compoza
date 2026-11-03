import { assert, describe, it } from '@effect/vitest';

import type { CaddyIngress } from '../../config/deploy.ts';
import type { ProxyConfig } from './config.ts';

import { mkdirScript } from '../../command.ts';
import { registryProbe } from '../../probe.ts';
import { parseCheck } from '../../probe.ts';
import {
  checkScript,
  setupScript,
  sha256,
  siteFile,
  SITES_DESTINATION,
  SITES_IMPORT,
  SITES_MOUNT,
} from './scripts.ts';

const ingress: CaddyIngress = {
  mode: 'caddy',
  domain: 'demo.example.com',
  upstream: 'demo-web:80',
};

const proxy: ProxyConfig = {
  dir: '/srv/proxy',
  container: 'caddy',
  network: 'edge',
  tls: 'dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
  logSnippet: 'request_log',
};

/**
 * The three set-up conditions as both scripts must emit them for `proxy`, written out so a change
 * to one script cannot silently drift from the other.
 */
const conditions = {
  caddyfileImport: `grep -qsxF '${SITES_IMPORT}' Caddyfile`,
  composeMount: `grep -qsF '${SITES_DESTINATION}' 'docker-compose.yaml'`,
  runningMount: `docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' 'caddy' 2>/dev/null | grep -qF '${SITES_DESTINATION}'`,
};

describe('siteFile', () => {
  it('writes the tls block and log import from the proxy entry', () => {
    assert.strictEqual(
      siteFile('demo', ingress, proxy),
      `# Managed by compoza for demo. Changes are overwritten on deploy.
demo.example.com {
\timport request_log demo
\ttls {
\t\tdns cloudflare {env.CLOUDFLARE_API_TOKEN}
\t}
\treverse_proxy http://demo-web:80
}
`,
    );
  });

  it('leaves both out when the proxy entry has neither', () => {
    const site = siteFile('demo', ingress, {
      dir: '/srv/proxy',
      container: 'caddy',
      network: 'edge',
    });
    assert.notInclude(site, 'tls');
    assert.notInclude(site, 'import');
    assert.include(site, 'reverse_proxy http://demo-web:80');
  });

  it('hashes like shasum', () => {
    assert.strictEqual(
      sha256('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('checkScript', () => {
  it('probes only what is asked for', () => {
    const full = [checkScript({ proxy, name: 'demo' }), registryProbe('registry.example.com')].join(
      '\n',
    );
    assert.include(full, "cd '/srv/proxy'");
    assert.include(full, `'${SITES_IMPORT}'`);
    assert.include(full, "'sites/demo.caddy'");
    assert.include(full, `'"registry.example.com"'`);

    const registryOnly = registryProbe('registry.example.com');
    assert.notInclude(registryOnly, 'proxy_dir');
    assert.include(registryOnly, 'registry_login');
    assert.notInclude(checkScript({ proxy, name: 'demo' }), 'registry_login');
  });

  it('keeps probing the network and registry when the proxy folder is missing', () => {
    const script = [
      checkScript({ proxy, name: 'demo' }),
      registryProbe('registry.example.com'),
    ].join('\n');
    assert.notInclude(script, 'exit');
    assert.include(script, "if cd '/srv/proxy' 2>/dev/null; then");

    const missing = script.indexOf('echo proxy_dir=missing\nfi\n');
    assert.isAbove(missing, 0);
    assert.isAbove(script.indexOf('echo site_sha256='), 0);
    assert.isBelow(script.indexOf('echo site_sha256='), missing);
    assert.isAbove(script.indexOf('running_mount=yes'), missing);
    assert.isAbove(script.indexOf('docker network inspect'), missing);
    assert.isAbove(script.indexOf('registry_login=yes'), missing);
  });

  it('detects the Compose mount by its destination, not by the inserted line', () => {
    const script = checkScript({ proxy, name: 'demo' });
    assert.include(
      script,
      `if ${conditions.composeMount}; then echo compose_mount=yes; else echo compose_mount=no; fi`,
    );
    assert.notInclude(script, SITES_MOUNT);
  });

  it('reports the shared set-up conditions with errors silenced', () => {
    const script = checkScript({ proxy, name: 'demo' });
    assert.include(
      script,
      `  if ${conditions.caddyfileImport}; then echo caddyfile_import=yes; else echo caddyfile_import=no; fi\n`,
    );
    assert.include(
      script,
      `if ${conditions.runningMount}; then echo running_mount=yes; else echo running_mount=no; fi\n`,
    );
  });

  it('hashes with shasum or, where it is missing, sha256sum', () => {
    assert.include(
      checkScript({ proxy, name: 'demo' }),
      "{ shasum -a 256 'sites/demo.caddy' 2>/dev/null || sha256sum 'sites/demo.caddy'; } | cut -d' ' -f1",
    );
  });

  it('parses key=value output', () => {
    assert.deepStrictEqual(parseCheck('proxy_dir=present\nsite_sha256=none\nnoise\n'), {
      proxy_dir: 'present',
      site_sha256: 'none',
    });
  });

  it('parses the output of a probe whose proxy folder is missing', () => {
    assert.deepStrictEqual(
      parseCheck('proxy_dir=missing\nrunning_mount=no\nnetwork=yes\nregistry_login=yes\n'),
      {
        proxy_dir: 'missing',
        running_mount: 'no',
        network: 'yes',
        registry_login: 'yes',
      },
    );
  });
});

describe('host scripts', () => {
  it('set up the proxy with backups and a validation run', () => {
    const script = setupScript({ ...proxy, composeFile: 'compose.yaml' });
    assert.include(script, "cd '/srv/proxy'");
    assert.include(script, "'compose.yaml'");
    assert.include(script, 'trap cleanup EXIT');
    assert.include(script, 'caddy validate');
    assert.include(script, "docker compose -f 'compose.yaml' config --quiet");
    assert.include(script, "docker compose -f 'compose.yaml' up -d 'caddy'");
  });

  it('test the same set-up conditions as the probe before changing anything', () => {
    const script = setupScript(proxy);
    assert.include(
      script,
      `if ${conditions.caddyfileImport} && ${conditions.composeMount} \\\n  && ${conditions.runningMount}; then\n  echo "proxy already set up; nothing to do"`,
    );
    assert.isBelow(script.indexOf(conditions.runningMount), script.indexOf('stamp='));
    assert.include(script, `if ! ${conditions.caddyfileImport}; then\n`);
  });

  it('insert the sites mount only when nothing mounts at its destination', () => {
    const script = setupScript(proxy);
    assert.include(script, `if ! ${conditions.composeMount}; then\n  # Insert the sites mount`);
    assert.include(script, `-v add='- ${SITES_MOUNT}'`);
    assert.notInclude(script, `grep -qF '${SITES_MOUNT}'`);
  });

  it('recreate the Compose service, not the container, when they differ', () => {
    const script = setupScript({ ...proxy, container: 'proxy-caddy-1', service: 'caddy' });
    assert.include(script, "docker compose -f 'docker-compose.yaml' up -d 'caddy' >/dev/null");
    assert.include(script, "docker inspect -f '{{.Config.Image}}' 'proxy-caddy-1'");
  });

  it('stop and restore when the Compose edit fails, removing the temporary file', () => {
    const script = setupScript(proxy);
    assert.notMatch(script, /awk[^]*?&& mv/);
    assert.include(script, "tmp='docker-compose.yaml'.tmp\n  if ! awk ");
    assert.include(
      script,
      `' 'docker-compose.yaml' > "$tmp"; then\n    rm -f "$tmp"\n    false\n  fi\n`,
    );
    assert.include(script, `  mv "$tmp" 'docker-compose.yaml'\n`);
    assert.isBelow(script.indexOf('trap cleanup EXIT'), script.indexOf('if ! awk'));
  });

  it('pass the env file to the validation run only when it exists', () => {
    const script = setupScript(proxy);
    assert.include(
      script,
      'if [ -f .env ]; then set -- --env-file .env; fi\ndocker run --rm "$@" ',
    );
    assert.notInclude(script, '--rm --env-file');
  });

  it('quote folders for mkdir', () => {
    assert.strictEqual(mkdirScript(['/a b', "/c'd"]), `mkdir -p '/a b' '/c'\\''d'`);
  });
});

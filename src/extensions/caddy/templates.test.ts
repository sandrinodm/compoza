import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { mkdir, mkdtempDisposable, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as YAML from 'yaml';

import { loadDefaultHosts, loadHosts, ingressConfigOf } from '../../config/hosts.ts';
import { resolve } from '../../deploy.ts';
import { ingressOperationScript } from '../ingress.ts';
import { caddyIngress } from './index.ts';
import { provisionOperation } from './provision.ts';
import { siteFile } from './scripts.ts';
import { renderTemplate } from './templates.ts';

const caddy = {
  address: '192.0.2.1',
  dir: '/srv/caddy',
  container: 'caddy',
  network: 'edge',
  provision: { image: 'caddy:2' },
} as const;

const host = {
  ssh: 'server',
  platform: 'linux/arm64',
  transport: { mode: 'ssh-load' },
  ingress: { caddy },
} as const;
const site = {
  mode: 'caddy',
  domain: 'budget.example.com',
  upstream: 'host.docker.internal:8300',
} as const;
const budget =
  '{{domain}} {\n\treverse_proxy http://{{upstream}} {\n\t\theader_up X-Real-IP {remote_host}\n\t}\n}\n';

/**
 * Provides isolated local, global and referenced host directories without touching the operator's
 * configuration.
 */
const fixture = Effect.gen(function* () {
  const { path: dir } = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtempDisposable(join(tmpdir(), 'dd-template-'))),
    (directory) => Effect.promise(() => directory.remove()),
  );

  for (const folder of ['global', 'repo', 'shared', 'repo/templates']) {
    yield* Effect.promise(() => mkdir(join(dir, folder), { recursive: true }));
  }

  return dir;
});

/**
 * Writes YAML for the real configuration loaders.
 */
const yaml = (path: string, value: unknown) =>
  Effect.promise(() => writeFile(path, YAML.stringify(value)));

/**
 * Writes a template as literal text without any shell interpretation.
 */
const file = (path: string, value: string) => Effect.promise(() => writeFile(path, value));

describe('Caddy templates', () => {
  it('normalizes template line endings for host import detection', () => {
    const rendered = JSON.parse(
      provisionOperation({
        ...caddy,
        templates: { config: { inline: '# Windows template\r\n{{sitesImport}}\r\n' } },
      }).input!,
    ).caddyfile;
    assert.strictEqual(rendered, '# Windows template\nimport /etc/caddy/sites/*.caddy\n');
  });

  it('supports sections and literal Caddy syntax without recursively interpolating replacement values', () => {
    const source = {
      inline:
        '{{#tls}}TLS: {{tls}}{{#logSnippet}} {{logSnippet}}{{/logSnippet}}{{/tls}}{{^tls}}default TLS{{/tls}} {remote_host} {env.TOKEN} $HOME',
    };
    assert.strictEqual(
      renderTemplate(source, '', { tls: 'dns {{literal}}', logSnippet: 'logs' }, 'site'),
      'TLS: dns {{literal}} logs {remote_host} {env.TOKEN} $HOME',
    );
    assert.strictEqual(
      renderTemplate(source, '', { tls: '', logSnippet: 'logs' }, 'site'),
      'default TLS {remote_host} {env.TOKEN} $HOME',
    );
  });

  it.each([
    '{{typo}}',
    '{{#tls}}{{typo}}{{/tls}}',
    '{{/tls}}',
    '{{#tls}}',
    '{{#tls}}{{/name}}',
    '{{name',
    '{{# name}}',
    '{{{name}}}',
    '{{constructor}}',
  ])('rejects malformed or unknown placeholders: %s', (inline) => {
    assert.throws(() => renderTemplate({ inline }, '', { name: 'app', tls: '' }, 'site'));
  });

  it('supports an app override and requires the shared config to load site files', () => {
    const proxy = {
      ...caddy,
      templates: {
        site: { inline: '{{domain}} { respond "host template" }' },
        config: { inline: '# custom rotation and settings\n{{sitesImport}}\n' },
      },
    };
    assert.include(
      siteFile('budget', { ...site, siteTemplate: { inline: budget } }, proxy),
      'header_up X-Real-IP {remote_host}',
    );
    assert.include(siteFile('budget', site, proxy), 'host template');
    assert.strictEqual(
      JSON.parse(provisionOperation(proxy).input!).caddyfile,
      '# custom rotation and settings\nimport /etc/caddy/sites/*.caddy\n',
    );
    assert.throws(
      () =>
        provisionOperation({
          ...proxy,
          templates: { config: { inline: '# missing sites import' } },
        }),
      'sitesImport',
    );
  });

  it.effect(
    'resolves paths relative to external host files and local overrides, ignoring superseded templates',
    () =>
      Effect.gen(function* () {
        const dir = yield* fixture;
        yield* file(join(dir, 'shared', 'site.tmpl'), budget);
        yield* file(join(dir, 'shared', 'root.tmpl'), '# shared custom config\n{{sitesImport}}\n');
        yield* yaml(join(dir, 'shared', 'host.yaml'), {
          ...host,
          ingress: {
            caddy: { ...caddy, templates: { site: './site.tmpl', config: './root.tmpl' } },
          },
        });
        yield* yaml(join(dir, 'global', 'hosts.yaml'), {
          external: { $ref: '../shared/host.yaml' },
          local: {
            ...host,
            ingress: { caddy: { ...caddy, templates: { site: './missing.tmpl' } } },
          },
        });
        yield* file(join(dir, 'repo', 'site.tmpl'), '{{domain}} { respond "local" }\n');
        yield* yaml(join(dir, 'repo', 'hosts.yaml'), {
          local: { ...host, ingress: { caddy: { ...caddy, templates: { site: './site.tmpl' } } } },
        });

        const hosts = yield* loadDefaultHosts({
          directory: join(dir, 'repo'),
          globalFile: join(dir, 'global', 'hosts.yaml'),
        });
        const external = ingressConfigOf(hosts.external!)!;
        assert.strictEqual(external.provider, 'caddy');

        if (external.provider !== 'caddy') {
          throw new Error('Wrong extension');
        }

        assert.include(siteFile('budget', site, external), 'header_up X-Real-IP {remote_host}');
        assert.include(
          JSON.parse(provisionOperation(external).input!).caddyfile,
          '# shared custom config',
        );

        const local = ingressConfigOf(hosts.local!)!;
        if (local.provider !== 'caddy') {
          throw new Error('Wrong extension');
        }

        assert.include(siteFile('budget', site, local), 'respond "local"');

        yield* file(join(dir, 'shared', 'site.tmpl'), '{{domain}} { respond "changed" }');

        assert.include(siteFile('budget', site, external), 'header_up');
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('accepts absolute and home-relative template paths in host entries', () =>
    Effect.gen(function* () {
      const dir = yield* fixture;
      const path = join(dir, 'site.tmpl');
      yield* file(path, budget);

      for (const source of [path, `~/${relative(homedir(), path)}`]) {
        yield* yaml(join(dir, 'hosts.yaml'), {
          server: {
            ssh: host.ssh,
            platform: host.platform,
            transport: host.transport,
            ingress: { caddy: { ...caddy, templates: { site: source } } },
          },
        });

        const hosts = yield* loadHosts(join(dir, 'hosts.yaml'));
        const proxy = ingressConfigOf(hosts.server!, 'caddy');
        assert.deepStrictEqual(proxy?.provider === 'caddy' && proxy.templates?.site, {
          inline: budget,
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('resolves selected app overrides from deploy.yaml and freezes the rendered route', () =>
    Effect.gen(function* () {
      const dir = yield* fixture;
      yield* yaml(join(dir, 'hosts.yaml'), { server: host });
      yield* file(join(dir, 'repo', 'templates', 'budget.tmpl'), budget);
      yield* yaml(join(dir, 'repo', 'deploy.yaml'), {
        name: 'budget',
        host: 'server',
        targets: [],
        composeFiles: ['compose.yaml'],
        ingress: {
          caddy: {
            domain: site.domain,
            upstream: site.upstream,
            siteTemplate: './not-selected.tmpl',
          },
        },
        workingDirectory: '../absent-app-checkout',
        destinations: {
          staging: {
            ingress: {
              caddy: {
                domain: site.domain,
                upstream: site.upstream,
                siteTemplate: './templates/budget.tmpl',
              },
            },
          },
        },
      });

      const resolved = yield* resolve(
        join(dir, 'repo'),
        Option.some(join(dir, 'hosts.yaml')),
        'staging',
      );
      const operation = caddyIngress.plan(resolved.app, resolved.host).route;
      const frozen = ingressOperationScript(operation);
      assert.include(frozen, 'header_up X-Real-IP {remote_host}');
      assert.include(frozen, 'budget.example.com');
      assert.notInclude(frozen, '{{domain}}');
      assert.notInclude(frozen, 'budget.tmpl');

      yield* rmTemplate(join(dir, 'repo', 'templates', 'budget.tmpl'));

      assert.strictEqual(
        ingressOperationScript(caddyIngress.plan(resolved.app, resolved.host).route),
        frozen,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'reports unreadable and invalid templates as config errors without exposing template contents',
    () =>
      Effect.gen(function* () {
        const dir = yield* fixture;
        const hostsFile = join(dir, 'hosts.yaml');

        for (const source of [
          './missing.tmpl',
          './repo',
          { inline: 'PRIVATE_TEMPLATE_SENTINEL {{typo}}' },
        ]) {
          yield* yaml(hostsFile, {
            server: { ...host, ingress: { caddy: { ...caddy, templates: { site: source } } } },
          });

          const error = yield* loadHosts(hostsFile).pipe(Effect.flip);
          assert.strictEqual(error._tag, 'DeployError');
          assert.include(error.message, 'template');
          assert.notInclude(error.message, 'PRIVATE_TEMPLATE_SENTINEL');
        }

        yield* file(join(dir, 'large.tmpl'), 'x'.repeat(256 * 1024 + 1));
        yield* yaml(hostsFile, {
          server: {
            ...host,
            ingress: { caddy: { ...caddy, templates: { site: './large.tmpl' } } },
          },
        });

        assert.include((yield* loadHosts(hostsFile).pipe(Effect.flip)).message, '256 KiB');
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

/**
 * Removes the source to prove frozen operations do not need it after resolution.
 */
const rmTemplate = (path: string) => Effect.promise(() => rm(path));

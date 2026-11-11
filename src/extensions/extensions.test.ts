import { assert, describe, it } from '@effect/vitest';
import { Schema } from 'effect';
import { execFileSync } from 'node:child_process';

import type { App } from '../config/deploy.ts';
import type { HostConfig } from '../config/hosts.ts';

import { DeployConfig } from '../config/deploy.ts';
import { Hosts } from '../config/hosts.ts';
import { credentialProvider, credentialProviders, isCredentialEnvironment } from './credentials.ts';
import {
  hostIngress,
  ingressExtension,
  ingressExtensions,
  ingressFor,
  ingressOperationScript,
} from './ingress.ts';

const app: App = {
  dir: '/repo',
  config: {
    name: 'demo',
    projectName: 'demo-staging',
    host: 'atlas',
    composeFiles: ['compose.yaml'],
    ingress: {
      caddy: { domain: 'demo.example.com', upstream: 'demo:80', healthPath: '/ready' },
    },
  },
};

const proxy = { address: '192.0.2.42', dir: '/srv/proxy', container: 'caddy', network: 'edge' };

const host: HostConfig = {
  ssh: 'deploy@atlas.example.com',
  platform: 'linux/amd64',
  transport: { mode: 'ssh-load' },
  ingress: { caddy: proxy },
};

describe('bundled extensions', () => {
  it('registers matching selectors and rejects unsupported integrations', () => {
    for (const [id, provider] of Object.entries(credentialProviders)) {
      assert.strictEqual(provider.id, id);
      assert.strictEqual(credentialProvider(id), provider);
    }

    for (const [id, extension] of Object.entries(ingressExtensions)) {
      assert.strictEqual(extension.id, id);
      assert.strictEqual(ingressExtension(id), extension);
    }

    assert.throws(() => credentialProvider('unsupported'), 'Unknown credential provider');
    assert.throws(() => ingressExtension('unsupported'), 'Unknown ingress extension');
    assert.throws(() =>
      Schema.decodeUnknownSync(DeployConfig)({
        ...app.config,
        secrets: { unsupported: {} },
      }),
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(DeployConfig)({ ...app.config, ingress: { unsupported: {} } }),
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(Hosts)({
        atlas: { ...host, ingress: { unsupported: proxy } },
      }),
    );
  });

  it('plans the Caddy route of an app on a host with Caddy ingress', () => {
    const extension = ingressFor(app)!;
    assert.strictEqual(hostIngress(host), extension);

    const plan = extension.plan(app, host);
    assert.strictEqual(plan.healthUrl, 'https://demo.example.com/ready');
    assert.include(plan.route.script, "file='demo-staging.caddy'");
    assert.include(plan.unroute.script, "file='demo-staging.caddy'");
    assert.include(plan.route.input!, 'reverse_proxy http://demo:80');
  });

  it('skips ingress for omitted and explicit none settings without requiring a host proxy', () => {
    const { ingress: _ingress, ...config } = app.config;
    assert.isUndefined(ingressFor({ ...app, config }));
    assert.isUndefined(ingressFor({ ...app, config: { ...config, ingress: { none: {} } } }));

    const { ingress: _hostIngress, ...bareHost } = host;
    assert.throws(() => hostIngress(bareHost), 'Host has no proxy entry');

    const extension = ingressFor(app)!;
    assert.throws(() => extension.plan(app, bareHost), 'requires a host proxy');
    assert.throws(() => extension.setup(bareHost), 'requires a host proxy');
    assert.isUndefined(extension.probe(app, bareHost));
    assert.isUndefined(extension.domain(app, bareHost));
    assert.deepStrictEqual(
      extension.checks(app, bareHost, [], {}).map(({ name, ok }) => ({ name, ok })),
      [{ name: 'proxy', ok: false }],
    );
  });

  it('reserves authentication for all registered providers, regardless of the selected source', () => {
    assert.isTrue(isCredentialEnvironment('OP_SERVICE_ACCOUNT_TOKEN'));
    assert.isTrue(isCredentialEnvironment('COMPOZA_1PASSWORD_ACCOUNT'));
    assert.isFalse(isCredentialEnvironment('APP_TOKEN'));
    assert.isFalse(isCredentialEnvironment('PATH'));
  });
});

describe('frozen ingress operations', () => {
  it('preserves arbitrary literal stdin for any ingress implementation under Bash 3.2', () => {
    const input = 'quotes \' and "; $(exit 91) `exit 92` $HOME \\ end\nCOMPOZA_SITE\n\n';
    const script = ingressOperationScript({ script: 'set -eu\ncat', input, label: '<test route>' });
    assert.strictEqual(execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' }), input);
    assert.strictEqual(
      execFileSync(
        '/bin/bash',
        ['-c', ingressOperationScript({ script: 'cat', input: '', label: '<empty>' })],
        { encoding: 'utf8' },
      ),
      '',
    );
  });

  it('preserves mutation failure and supports operations without stdin', () => {
    assert.throws(() =>
      execFileSync('/bin/bash', [
        '-c',
        ingressOperationScript({ script: 'exit 23', input: 'config', label: '<fails>' }),
      ]),
    );
    assert.strictEqual(
      ingressOperationScript({ script: 'set -eu\nexit 0\n', label: '<no payload>' }),
      'set -eu\nexit 0\n',
    );
  });
});

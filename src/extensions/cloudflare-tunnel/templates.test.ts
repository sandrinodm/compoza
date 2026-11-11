import { assert, describe, it } from '@effect/vitest';

import type { App } from '../../config/deploy.ts';
import type { CloudflareProxy } from './config.ts';

import { routeRule } from './templates.ts';

const proxy: CloudflareProxy = {
  accountId: 'a'.repeat(32),
  tunnelId: '12345678-1234-1234-1234-123456789abc',
  apiTokenFile: '/private/api-token',
  stateDir: '/private/state',
};

const settings = { domain: 'app.example.com', service: 'http://app:80' };
const app: App = {
  dir: '/app',
  config: { name: 'app', host: 'host', composeFiles: ['compose.yaml'] },
};

const namedApp: App = {
  ...app,
  config: { ...app.config, ingress: { 'cloudflare-tunnel': settings } },
};

describe('Cloudflare route templates', () => {
  it('renders the application settings', () => {
    assert.deepStrictEqual(routeRule(proxy, namedApp, 'app'), {
      hostname: settings.domain,
      service: settings.service,
    });
  });

  it('reports missing route settings without dereferencing absent ingress', () => {
    assert.throws(() => routeRule(proxy, app, 'app'), 'Cloudflare route settings are missing');
  });

  it.each([
    'null',
    '42',
    'text',
    '[]',
    'hostname: {{domain}}\nservice: {{service}}\noriginRequest: []',
  ])('rejects non-mapping routes and origin settings: %s', (inline) => {
    assert.throws(
      () => routeRule({ ...proxy, templates: { route: { inline } } }, namedApp, 'app'),
      'must preserve hostname/service',
    );
  });

  it('rejects oversized rendered output before parsing malformed YAML', () => {
    const inline = '[' + 'é'.repeat(128 * 1024);
    assert.throws(
      () => routeRule({ ...proxy, templates: { route: { inline } } }, namedApp, 'app'),
      'Cloudflare route template is too large',
    );
  });
});

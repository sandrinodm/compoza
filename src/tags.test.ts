import { assert, describe, it } from '@effect/vitest';

import type { DeployConfig } from './config/deploy.ts';

import { parseTagFlags, tagLabel, tagsOf } from './tags.ts';

const config: DeployConfig = {
  name: 'demo',
  host: 'atlas',
  composeFiles: ['compose.yaml'],
  roles: {
    web: { build: { target: 'web' } },
    worker: { build: {} },
    postgres: { environment: { POSTGRES_USER: 'demo' } },
  },
};

describe('parseTagFlags', () => {
  it('handles a building role named like an Object.prototype member', () => {
    const named: DeployConfig = { ...config, roles: { constructor: { build: {} } } };
    assert.deepStrictEqual(parseTagFlags(['abc'], named), { constructor: 'abc' });
    assert.deepStrictEqual(parseTagFlags(['constructor=def'], named), { constructor: 'def' });
    assert.throws(() => parseTagFlags(['constructor=a', 'constructor=b'], named), 'given twice');
  });

  it('applies a bare tag to every building role', () => {
    assert.deepStrictEqual(parseTagFlags(['abc'], config), { web: 'abc', worker: 'abc' });
  });

  it('lets a role tag override the bare tag, in either order', () => {
    const expected = { web: 'abc', worker: 'def' };
    assert.deepStrictEqual(parseTagFlags(['abc', 'worker=def'], config), expected);
    assert.deepStrictEqual(parseTagFlags(['worker=def', 'abc'], config), expected);
  });

  it('accepts role tags alone when every building role is named', () => {
    assert.deepStrictEqual(parseTagFlags(['web=1', 'worker=2'], config), { web: '1', worker: '2' });
  });

  it('keeps everything after the first equals sign in the tag', () => {
    assert.throws(() => parseTagFlags(['abc', 'web=a=b'], config), 'not a valid Docker tag');
  });

  it('accepts Docker tags with dots, dashes and underscores', () => {
    assert.strictEqual(parseTagFlags(['v1.2_3-rc'], config).web, 'v1.2_3-rc');
    assert.strictEqual(parseTagFlags(['_a'.padEnd(128, 'b')], config).web?.length, 128);
  });

  it.each([
    [['ghost=abc'], 'Unknown role "ghost" in --tag; roles: web, worker, postgres'],
    [['postgres=abc', 'abc'], 'Role "postgres" has no build, so --tag cannot name it'],
    [['abc', 'web=1', 'web=2'], 'Role "web" is given twice in --tag'],
    [['one', 'two'], 'Only one --tag without a role is allowed'],
    [['web=1'], 'No tag for role "worker"; pass --tag <tag> or --tag worker=<tag>'],
    [[''], '--tag needs a tag'],
    [['web='], '--tag web= needs a tag after ='],
    [['web:abc'], 'to name a role use --tag <role>=<tag>'],
    [['.abc'], 'not a valid Docker tag'],
    [['-abc'], 'not a valid Docker tag'],
    [['web=a b'], 'not a valid Docker tag'],
    [['a'.repeat(129)], 'not a valid Docker tag'],
  ] as const)('rejects %j', (values, message) => {
    assert.throws(() => parseTagFlags(values, config), message);
  });

  it('names no roles when the app has none', () => {
    const bare: DeployConfig = { name: 'demo', host: 'atlas', composeFiles: ['compose.yaml'] };
    assert.throws(() => parseTagFlags(['web=1'], bare), 'roles: none');
    assert.deepStrictEqual(parseTagFlags([], bare), {});
  });

  it('fails any --tag when no role has a build', () => {
    const bare: DeployConfig = { name: 'demo', host: 'atlas', composeFiles: ['compose.yaml'] };
    const message = 'No role has a build, so there are no images to reuse; deploy without --tag';
    assert.throws(() => parseTagFlags(['abc'], bare), message);

    const thirdParty: DeployConfig = { ...bare, roles: { db: { environment: { A: '1' } } } };
    assert.throws(() => parseTagFlags(['v1'], thirdParty), message);
    assert.throws(() => parseTagFlags(['db=v1'], thirdParty), 'Role "db" has no build');
  });

  it('treats a role removed for a local run as unknown', () => {
    const removed: DeployConfig = { ...config, local: { roles: { worker: null } } };
    assert.deepStrictEqual(parseTagFlags(['abc'], removed, { local: true }), { web: 'abc' });
    assert.throws(
      () => parseTagFlags(['worker=1'], removed, { local: true }),
      'Unknown role "worker" in --tag; roles: web, postgres',
    );
    assert.deepStrictEqual(parseTagFlags(['abc'], removed), { web: 'abc', worker: 'abc' });
  });

  it('says a role removed for the run is removed instead of unknown', () => {
    const removed: DeployConfig = { ...config, local: { roles: { worker: null } } };
    assert.throws(
      () => parseTagFlags(['worker=1'], removed, { local: true, removed: ['worker'] }),
      'Role "worker" is removed for this run, so --tag cannot name it',
    );
  });

  it('fails --tag when every building role is removed', () => {
    const removed: DeployConfig = { ...config, local: { roles: { web: null, worker: null } } };
    assert.throws(() => parseTagFlags(['abc'], removed, { local: true }), 'No role has a build');
  });
});

describe('tagLabel', () => {
  it('shows one tag when every role shares it', () => {
    const sources = { web: { tag: 'abc', context: '/a' }, worker: { tag: 'abc', context: '/b' } };
    assert.strictEqual(tagLabel(sources), 'abc');
  });

  it('lists the tag of each role when they differ', () => {
    const sources = { web: { tag: 'abc', context: '/a' }, worker: { tag: 'def', context: '/b' } };
    assert.strictEqual(tagLabel(sources), 'web=abc worker=def');
    assert.deepStrictEqual(tagsOf(sources), { web: 'abc', worker: 'def' });
  });

  it('names the third-party tag when nothing is built', () => {
    assert.strictEqual(tagLabel({}), 'third-party');
  });
});

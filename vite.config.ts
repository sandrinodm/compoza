import { defineConfig } from 'vite-plus';

/**
 * Paths neither the formatter nor the linter touches: dependencies, build output and agent
 * worktrees.
 */
const ignoredPatterns = [
  '**/.claude/**',
  '**/.reference/**',
  '**/dist/**',
  '**/node_modules/**',
  '**/*.tsbuildinfo',
  'pnpm-lock.yaml',
];

/**
 * How long one test may run before Vitest fails it, in milliseconds.
 *
 * Unit tests retain a five-second limit. Real Bash/jq integration groups override it to fifteen
 * seconds because they start multiple processes; optional Compose parser tests require only the
 * CLI, never a live deployment.
 */
const TEST_TIMEOUT_MILLIS = 5_000;

export default defineConfig({
  pack: {
    entry: ['bin/compoza.ts'],
    platform: 'node',
    target: 'node26',
    format: ['esm'],
    dts: false,
    unbundle: true,
    root: '.',
    // Runtime assets must remain beside the modules that read them through import.meta.url.
    copy: { from: 'src/**/*.{sh,jq,tmpl}', to: 'dist/src', flatten: false },
  },
  staged: {
    '*': 'vp check --fix',
    // jsdoc-lint checks a file named on the command line even when `jsdoc.json` excludes it, so
    // this glob leaves out tests and declarations itself.
    '{src,bin}/**/!(*.test|*.spec|*.d).{ts,mts,cts}': 'jsdoc-lint',
  },
  fmt: {
    arrowParens: 'always',
    bracketSameLine: true,
    bracketSpacing: true,
    jsdoc: {
      commentLineStrategy: 'multiline',
    },
    objectWrap: 'preserve',
    printWidth: 100,
    semi: true,
    singleQuote: true,
    sortImports: {
      groups: [
        'type-import',
        ['value-builtin', 'value-external'],
        'type-internal',
        'value-internal',
        ['type-parent', 'type-sibling', 'type-index'],
        ['value-parent', 'value-sibling', 'value-index'],
        'unknown',
      ],
    },
    sortPackageJson: true,
    ignorePatterns: ignoredPatterns,
  },
  lint: {
    plugins: ['typescript', 'unicorn', 'oxc', 'jsdoc'],
    jsPlugins: [
      { name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' },
      { name: '@stylistic', specifier: '@stylistic/eslint-plugin' },
    ],
    rules: {
      curly: 'error',
      // A blank line after a block when more code follows it in the same block. The `block-like`
      // selector is left out on purpose: it also matches `const handler = () => { … };`.
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: ['if', 'for', 'while', 'do', 'switch', 'try'], next: '*' },
      ],
      'jsdoc/check-tag-names': 'error',
      'jsdoc/check-access': 'error',
      'jsdoc/check-property-names': 'error',
      'jsdoc/require-property': 'off',
      'jsdoc/require-property-description': 'off',
      'jsdoc/require-property-name': 'off',
      'jsdoc/require-property-type': 'off',
      'jsdoc/require-yields': 'off',

      'typescript/no-deprecated': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    // `vp check` is this repository's type checker: there is no separate `tsc` step.
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ignoredPatterns,
    overrides: [
      {
        files: ['**/*.{test,spec}.ts'],
        plugins: ['vitest'],
        rules: {
          // Vitest's expect(value, message) form is used for readable failures.
          'vitest/valid-expect': ['error', { maxArgs: 2 }],
          'vitest/require-mock-type-parameters': 'off',
        },
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: TEST_TIMEOUT_MILLIS,
    hookTimeout: TEST_TIMEOUT_MILLIS,
  },
  run: {
    cache: { scripts: false, tasks: true },
  },
});

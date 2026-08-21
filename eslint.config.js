import js from '@eslint/js';
import globals from 'globals';

/**
 * Layering is enforced here rather than by convention: src/core must stay free
 * of the DOM and of three.js so it can be unit-tested in plain node, and the
 * renderers must not reach for engine or UI internals.
 */
const noBrowserInCore = {
  files: ['src/core/**/*.js'],
  languageOptions: { globals: { ...globals.es2024 } },
  rules: {
    'no-restricted-globals': [
      'error',
      { name: 'window', message: 'src/core must stay DOM-free (it is unit-tested in node).' },
      { name: 'document', message: 'src/core must stay DOM-free (it is unit-tested in node).' },
      { name: 'localStorage', message: 'src/core must stay DOM-free; inject storage instead.' },
    ],
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: ['three', 'three/*'], message: 'src/core must not depend on the renderer.' },
          { group: ['../render/*', '../ui/*'], message: 'src/core is the bottom layer.' },
        ],
      },
    ],
  },
};

export default [
  {
    ignores: [
      'vendor/**',
      'node_modules/**',
      'legacy/**',
      'assets/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2024 },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
    },
  },
  {
    files: ['tools/**/*.mjs', '*.config.js', 'tests/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['src/workers/**/*.js'],
    languageOptions: { globals: { ...globals.worker } },
  },
  noBrowserInCore,
];

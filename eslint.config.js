// Flat ESLint config (ESLint v9). The custom rules live in tools/lint-rules
// and enforce monorepo boundaries (Phase 2 §12 of the architecture).
//
// This file is JS rather than TS so ESLint v9 can load it without jiti hops.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import apex from './tools/lint-rules/dist/index.js';

const tsRecommended = tseslint.configs.recommendedTypeChecked;

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/generated/**',
      'packages/db/prisma/migrations/**',
      'packages/db/src/generated/**',
      'tools/lint-rules/dist/**',
    ],
  },
  js.configs.recommended,
  ...tsRecommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        project: ['./tsconfig.base.json', './packages/*/tsconfig.json', './apps/*/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      apex,
    },
    rules: {
      // Custom monorepo boundary rules (audit Step 4 §12).
      'apex/no-cross-app-imports': 'error',
      'apex/app-uses-package-only': 'error',
      'apex/package-declared-deps': 'error',
      'apex/no-secrets-in-source': 'error',
      'apex/zod-only-in-shared-types': 'error',
      'apex/error-class-from-shared-errors': 'error',
      'apex/no-direct-prisma-in-apps': 'error',

      // Project hygiene.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='setTimeout'][arguments.length>1] > Literal[value=0]",
          message: 'Use queueMicrotask() instead of setTimeout(_, 0).',
        },
      ],
    },
  },
  // Test files relax some rules.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**', '**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      'apex/no-direct-prisma-in-apps': 'off',
    },
  },
  // Config files don't need full type-check.
  {
    files: ['**/*.config.{ts,js,cjs,mjs}', '**/eslint.config.js'],
    languageOptions: { parserOptions: { project: null } },
    rules: {
      ...Object.fromEntries(Object.keys(tsRecommended.at(-1)?.rules ?? {}).map((k) => [k, 'off'])),
    },
  },
];

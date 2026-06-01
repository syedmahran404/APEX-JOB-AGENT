// @apex/lint-rules — custom ESLint plugin enforcing monorepo boundaries
// (Audit Step 4 §12). Loaded by ./eslint.config.js.

import { noCrossAppImports } from './rules/no-cross-app-imports.js';
import { appUsesPackageOnly } from './rules/app-uses-package-only.js';
import { packageDeclaredDeps } from './rules/package-declared-deps.js';
import { noSecretsInSource } from './rules/no-secrets-in-source.js';
import { zodOnlyInSharedTypes } from './rules/zod-only-in-shared-types.js';
import { errorClassFromSharedErrors } from './rules/error-class-from-shared-errors.js';
import { noDirectPrismaInApps } from './rules/no-direct-prisma-in-apps.js';

const plugin = {
  meta: {
    name: '@apex/lint-rules',
    version: '0.1.0',
  },
  rules: {
    'no-cross-app-imports': noCrossAppImports,
    'app-uses-package-only': appUsesPackageOnly,
    'package-declared-deps': packageDeclaredDeps,
    'no-secrets-in-source': noSecretsInSource,
    'zod-only-in-shared-types': zodOnlyInSharedTypes,
    'error-class-from-shared-errors': errorClassFromSharedErrors,
    'no-direct-prisma-in-apps': noDirectPrismaInApps,
  },
};

export default plugin;

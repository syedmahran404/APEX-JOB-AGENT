import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { appUsesPackageOnly } from '../app-uses-package-only.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('app-uses-package-only', appUsesPackageOnly, {
  valid: [
    // intra-app relative import is fine
    {
      code: "import { x } from '../infra/x.js';",
      filename: '/repo/apps/api/src/modules/x.ts',
    },
    // bare-specifier import (zero relative) — not this rule's concern
    {
      code: "import { x } from '@apex/shared-errors';",
      filename: '/repo/apps/api/src/x.ts',
    },
  ],
  invalid: [
    // relative import that escapes into another package
    {
      code: "import { x } from '../../../packages/shared-errors/src/x.js';",
      filename: '/repo/apps/api/src/x.ts',
      errors: [{ messageId: 'forbiddenWorkspace' }],
    },
    // relative import that escapes into a sibling app
    {
      code: "import { x } from '../../web/src/x.js';",
      filename: '/repo/apps/api/src/x.ts',
      errors: [{ messageId: 'forbiddenWorkspace' }],
    },
  ],
});

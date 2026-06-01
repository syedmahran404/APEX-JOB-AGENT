import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { zodOnlyInSharedTypes } from '../zod-only-in-shared-types.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('zod-only-in-shared-types', zodOnlyInSharedTypes, {
  valid: [
    // zod is allowed
    {
      code: "import { z } from 'zod';",
      filename: '/repo/packages/shared-types/src/x.ts',
    },
    // relative imports inside the package are allowed
    {
      code: "import { x } from './y.js';",
      filename: '/repo/packages/shared-types/src/x.ts',
    },
    // outside the leaf package — rule is a no-op
    {
      code: "import { Logger } from '@apex/shared-logger';",
      filename: '/repo/apps/api/src/x.ts',
    },
  ],
  invalid: [
    {
      code: "import { something } from '@apex/shared-logger';",
      filename: '/repo/packages/shared-types/src/x.ts',
      errors: [{ messageId: 'forbiddenInternal' }],
    },
    {
      code: "import { Buffer } from 'node:buffer';",
      filename: '/repo/packages/shared-types/src/x.ts',
      errors: [{ messageId: 'forbiddenExternal' }],
    },
    {
      code: "import lodash from 'lodash';",
      filename: '/repo/packages/shared-types/src/x.ts',
      errors: [{ messageId: 'forbiddenExternal' }],
    },
  ],
});

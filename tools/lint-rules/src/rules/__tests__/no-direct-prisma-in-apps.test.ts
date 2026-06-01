import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { noDirectPrismaInApps } from '../no-direct-prisma-in-apps.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('no-direct-prisma-in-apps', noDirectPrismaInApps, {
  valid: [
    // Allowed: imports through @apex/db.
    {
      code: "import { getPrisma } from '@apex/db';",
      filename: '/repo/apps/api/src/x.ts',
    },
    // Allowed inside @apex/db itself.
    {
      code: "import { PrismaClient } from '@prisma/client';",
      filename: '/repo/packages/db/src/client.ts',
    },
    // Allowed inside tools.
    {
      code: "import { PrismaClient } from '@prisma/client';",
      filename: '/repo/tools/db-scrub/src/x.ts',
    },
    // Allowed in test files.
    {
      code: "import { PrismaClient } from '@prisma/client';",
      filename: '/repo/apps/api/src/x.test.ts',
    },
  ],
  invalid: [
    {
      code: "import { PrismaClient } from '@prisma/client';",
      filename: '/repo/apps/api/src/modules/x.ts',
      errors: [{ messageId: 'directPrisma' }],
    },
    {
      code: "import { PrismaClient } from '@prisma/client';",
      filename: '/repo/packages/realtime/src/x.ts',
      errors: [{ messageId: 'directPrisma' }],
    },
    {
      code: "import * as p from '.prisma/client';",
      filename: '/repo/apps/api/src/x.ts',
      errors: [{ messageId: 'directPrisma' }],
    },
  ],
});

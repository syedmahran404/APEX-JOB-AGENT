import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { noCrossAppImports } from '../no-cross-app-imports.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('no-cross-app-imports', noCrossAppImports, {
  valid: [
    {
      code: "import { x } from '../infra/x.js';",
      filename: '/repo/apps/api/src/modules/x.ts',
    },
    {
      code: "import { x } from '@apex/shared-errors';",
      filename: '/repo/apps/api/src/x.ts',
    },
    {
      code: "import { x } from '../../../packages/shared-errors/src/x.js';",
      filename: '/repo/apps/api/src/x.ts',
    },
    {
      // packages can import each other freely (this rule only fires on apps)
      code: "import { x } from '../../shared-errors/src/x.js';",
      filename: '/repo/packages/shared-events/src/x.ts',
    },
  ],
  invalid: [
    {
      code: "import { x } from '../../web/src/something.js';",
      filename: '/repo/apps/api/src/x.ts',
      errors: [{ messageId: 'crossApp' }],
    },
    {
      code: "import { x } from '../../../apps/orchestrator/src/x.js';",
      filename: '/repo/apps/api/src/x.ts',
      errors: [{ messageId: 'crossApp' }],
    },
  ],
});

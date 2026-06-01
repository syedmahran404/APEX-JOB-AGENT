import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { errorClassFromSharedErrors } from '../error-class-from-shared-errors.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('error-class-from-shared-errors', errorClassFromSharedErrors, {
  valid: [
    { code: 'throw new ValidationError("bad")', filename: '/repo/apps/api/src/x.ts' },
    { code: 'throw new Error("ok")', filename: '/repo/packages/shared-errors/src/x.ts' },
    { code: 'throw new Error("ok")', filename: '/repo/apps/api/src/x.test.ts' },
  ],
  invalid: [
    {
      code: 'throw new Error("nope")',
      filename: '/repo/apps/api/src/x.ts',
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: 'class Boom extends Error {}',
      filename: '/repo/apps/api/src/x.ts',
      errors: [{ messageId: 'subclass' }],
    },
  ],
});

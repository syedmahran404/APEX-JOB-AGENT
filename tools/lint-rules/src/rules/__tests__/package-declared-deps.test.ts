import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { packageDeclaredDeps } from '../package-declared-deps.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fooFile = path.join(fixturesRoot, 'packages', 'foo', 'src', 'x.ts');
const barFile = path.join(fixturesRoot, 'packages', 'bar', 'src', 'x.ts');

ruleTester.run('package-declared-deps', packageDeclaredDeps, {
  valid: [
    // foo declares @apex/bar — this import is allowed.
    {
      code: "import { x } from '@apex/bar';",
      filename: fooFile,
    },
    // self-imports are allowed.
    {
      code: "import { x } from '@apex/foo/sub';",
      filename: fooFile,
    },
    // external (non-@apex) imports are out of scope for this rule.
    {
      code: "import { x } from 'zod';",
      filename: fooFile,
    },
    // bar doesn't declare any internal deps; relative imports are fine.
    {
      code: "import { x } from './y.js';",
      filename: barFile,
    },
    // outside the workspace: rule is a no-op
    {
      code: "import { x } from '@apex/anything';",
      filename: '/some/other/path/x.ts',
    },
  ],
  invalid: [
    // bar imports @apex/foo without declaring it.
    {
      code: "import { x } from '@apex/foo';",
      filename: barFile,
      errors: [{ messageId: 'undeclared' }],
    },
    // foo imports @apex/baz which is not in its package.json.
    {
      code: "import { x } from '@apex/baz';",
      filename: fooFile,
      errors: [{ messageId: 'undeclared' }],
    },
  ],
});

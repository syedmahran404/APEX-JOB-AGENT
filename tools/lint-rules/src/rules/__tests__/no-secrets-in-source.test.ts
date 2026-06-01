import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { noSecretsInSource } from '../no-secrets-in-source.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

// We assemble realistic-looking secrets at runtime so this source file itself
// does not contain literal patterns that GitHub Push Protection would flag.
const AWS_KEY = 'AKIA' + 'IOSFODNN' + '7EXAMPLE';
const GH_PAT = 'ghp_' + 'a'.repeat(36);
const ANTHROPIC = 'sk-ant-' + 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6';
const STRIPE = 'sk_li' + 've_' + 'a'.repeat(20);
const SLACK = 'xoxb-' + '1'.repeat(10) + '-' + 'a'.repeat(20);

ruleTester.run('no-secrets-in-source', noSecretsInSource, {
  valid: [
    { code: "const ok = 'just-a-normal-string';" },
    { code: "const url = 'https://example.com/path';" },
    // Shapes that look similar but don't match patterns.
    { code: "const id = 'AKIA-not-a-real-key';" },
    // Template with safe content.
    { code: 'const t = `hello ${name}`;' },
  ],
  invalid: [
    {
      code: `const k = '${AWS_KEY}';`,
      errors: [{ messageId: 'secret' }],
    },
    {
      code: `const t = '${GH_PAT}';`,
      errors: [{ messageId: 'secret' }],
    },
    {
      code: `const t = '${ANTHROPIC}';`,
      errors: [{ messageId: 'secret' }],
    },
    {
      code: `const t = '${STRIPE}';`,
      errors: [{ messageId: 'secret' }],
    },
    {
      code: `const t = '${SLACK}';`,
      errors: [{ messageId: 'secret' }],
    },
  ],
});

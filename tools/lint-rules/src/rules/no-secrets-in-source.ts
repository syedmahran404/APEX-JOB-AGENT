import { createRule } from '../utils.js';

// Patterns that look like real secrets in source code. Conservative;
// false positives can be silenced with eslint-disable on the specific line.
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS secret access key (heuristic)', re: /\b[A-Za-z0-9/+]{40}\b(?=.*aws)/i },
  { name: 'GitHub PAT (classic)', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub PAT (fine-grained)', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  { name: 'Slack token', re: /\bxox[abp]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'Stripe live secret', re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'Stripe restricted live', re: /\brk_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9-_]{20,}\b/ },
  { name: 'OpenAI API key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'Voyage API key', re: /\bpa-[A-Za-z0-9-_]{32,}\b/ },
  { name: 'JWT (raw)', re: /\beyJ[A-Za-z0-9_=-]{16,}\.[A-Za-z0-9_=-]{16,}\.[A-Za-z0-9_=-]{16,}\b/ },
  { name: 'PGP private block', re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
];

export const noSecretsInSource = createRule({
  name: 'no-secrets-in-source',
  meta: {
    type: 'problem',
    docs: { description: 'Detect strings that look like real secrets in source files.' },
    schema: [],
    messages: { secret: 'Possible secret leak ({{kind}}). Move to Vault or env; do not commit.' },
  },
  defaultOptions: [],
  create(context) {
    function check(node: { value: unknown }, raw: string): void {
      for (const { name, re } of PATTERNS) {
        if (re.test(raw)) {
          context.report({ node: node as never, messageId: 'secret', data: { kind: name } });
          return;
        }
      }
    }
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        check(node, node.value);
      },
      TemplateLiteral(node) {
        for (const q of node.quasis) check(q as never, q.value.cooked ?? q.value.raw);
      },
    };
  },
});

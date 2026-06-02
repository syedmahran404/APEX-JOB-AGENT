import { createRule, workspaceFor } from '../utils.js';

const FORBIDDEN_SPECIFIERS = new Set<string>(['@prisma/client', '.prisma/client']);

export const noDirectPrismaInApps = createRule({
  name: 'no-direct-prisma-in-apps',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Apps must not import `@prisma/client` directly; use a repository from `@apex/db`. Database knowledge is consolidated there.',
    },
    schema: [],
    messages: {
      directPrisma: 'Apps must not import `{{spec}}` directly. Use a repository from `@apex/db` instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    const ws = workspaceFor(context.filename);
    if (!ws) return {};
    // Allowed in @apex/db itself.
    if (ws.kind === 'package' && ws.name === 'db') return {};
    // Allowed in tools (codegen, scrub).
    if (ws.kind === 'tool') return {};
    // Test files are allowed to use prisma directly.
    if (/\.(test|spec)\.tsx?$/.test(context.filename)) return {};
    return {
      ImportDeclaration(node) {
        const spec = node.source.value;
        if (typeof spec !== 'string') return;
        if (FORBIDDEN_SPECIFIERS.has(spec)) {
          context.report({ node: node.source, messageId: 'directPrisma', data: { spec } });
        }
      },
    };
  },
});

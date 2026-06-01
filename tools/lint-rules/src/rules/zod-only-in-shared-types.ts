import { createRule, workspaceFor, workspaceFromSpecifier, isRelativeImport } from '../utils.js';

const ALLOWED_EXTERNAL = new Set<string>([
  'zod',
  'zod/v4',
  // Standard Node and TS internals can be imported by .d.ts shims, but in source code we keep it strict.
]);

export const zodOnlyInSharedTypes = createRule({
  name: 'zod-only-in-shared-types',
  meta: {
    type: 'problem',
    docs: {
      description:
        '`packages/shared-types` is a leaf package. It must not import from any other internal package; only `zod` is allowed externally.',
    },
    schema: [],
    messages: {
      forbiddenInternal:
        '`packages/shared-types` may not depend on `{{spec}}`. It is a leaf package — only `zod` is allowed.',
      forbiddenExternal:
        '`packages/shared-types` may not import the external module `{{spec}}`. Only `zod` is allowed.',
    },
  },
  defaultOptions: [],
  create(context) {
    const ws = workspaceFor(context.filename);
    if (!ws || ws.kind !== 'package' || ws.name !== 'shared-types') return {};
    return {
      ImportDeclaration(node) {
        const spec = node.source.value;
        if (typeof spec !== 'string') return;
        if (isRelativeImport(spec)) return;
        const internal = workspaceFromSpecifier(spec);
        if (internal) {
          context.report({ node: node.source, messageId: 'forbiddenInternal', data: { spec } });
          return;
        }
        if (!ALLOWED_EXTERNAL.has(spec)) {
          context.report({ node: node.source, messageId: 'forbiddenExternal', data: { spec } });
        }
      },
    };
  },
});

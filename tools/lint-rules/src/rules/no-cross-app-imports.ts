import path from 'node:path';
import { createRule, workspaceFor, isRelativeImport } from '../utils.js';

export const noCrossAppImports = createRule({
  name: 'no-cross-app-imports',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow imports between sibling apps (apps/<a> may not import from apps/<b>).',
    },
    schema: [],
    messages: {
      crossApp: '`apps/{{from}}` may not import from `apps/{{to}}`. Cross-app imports must go through a `packages/*`.',
    },
  },
  defaultOptions: [],
  create(context) {
    const file = context.filename;
    const ws = workspaceFor(file);
    if (!ws || ws.kind !== 'app') return {};
    return {
      ImportDeclaration(node) {
        const spec = node.source.value;
        if (typeof spec !== 'string') return;
        if (!isRelativeImport(spec)) return;
        // Resolve the relative import.
        const resolved = path.resolve(path.dirname(file), spec);
        const target = workspaceFor(resolved);
        if (target?.kind === 'app' && target.name !== ws.name) {
          context.report({
            node: node.source,
            messageId: 'crossApp',
            data: { from: ws.name, to: target.name },
          });
        }
      },
    };
  },
});

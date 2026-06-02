import path from 'node:path';
import { createRule, workspaceFor, isRelativeImport } from '../utils.js';

export const appUsesPackageOnly = createRule({
  name: 'app-uses-package-only',
  meta: {
    type: 'problem',
    docs: {
      description: 'Within an app, all non-relative imports outside the app must come from `packages/*`.',
    },
    schema: [],
    messages: {
      forbiddenWorkspace:
        'In `apps/{{app}}`, do not reach outside the app via relative imports. Use a `@apex/*` package.',
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
        const resolved = path.resolve(path.dirname(file), spec);
        const target = workspaceFor(resolved);
        if (target && (target.kind !== 'app' || target.name !== ws.name)) {
          context.report({ node: node.source, messageId: 'forbiddenWorkspace', data: { app: ws.name } });
        }
      },
    };
  },
});

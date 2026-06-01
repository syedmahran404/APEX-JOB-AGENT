import { createRule, workspaceFor } from '../utils.js';

export const errorClassFromSharedErrors = createRule({
  name: 'error-class-from-shared-errors',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Throwing a raw `Error` outside `packages/shared-errors` is forbidden. Use a typed error from `@apex/shared-errors`.',
    },
    schema: [],
    messages: {
      rawError: 'Use a typed error from `@apex/shared-errors` instead of `new Error(...)`.',
      subclass:
        'Subclass `ApexError` from `@apex/shared-errors`, not the built-in `Error`. The hierarchy lives there for serialization.',
    },
  },
  defaultOptions: [],
  create(context) {
    const ws = workspaceFor(context.filename);
    // Allowed inside the shared-errors package itself, and inside test files.
    if (ws?.kind === 'package' && ws.name === 'shared-errors') return {};
    if (/\.(test|spec)\.tsx?$/.test(context.filename)) return {};
    return {
      ThrowStatement(node) {
        const arg = node.argument;
        if (
          arg?.type === 'NewExpression' &&
          arg.callee.type === 'Identifier' &&
          arg.callee.name === 'Error'
        ) {
          context.report({ node: arg, messageId: 'rawError' });
        }
      },
      ClassDeclaration(node) {
        if (
          node.superClass?.type === 'Identifier' &&
          node.superClass.name === 'Error'
        ) {
          context.report({ node: node.superClass, messageId: 'subclass' });
        }
      },
    };
  },
});

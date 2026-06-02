import fs from 'node:fs';
import path from 'node:path';
import { createRule, workspaceFor, workspaceFromSpecifier } from '../utils.js';

interface PkgJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const pkgJsonCache = new Map<string, PkgJson>();

function loadPkg(workspaceDir: string): PkgJson | null {
  const cached = pkgJsonCache.get(workspaceDir);
  if (cached !== undefined) return cached;
  const p = path.join(workspaceDir, 'package.json');
  if (!fs.existsSync(p)) {
    pkgJsonCache.set(workspaceDir, null as unknown as PkgJson);
    return null;
  }
  const data = JSON.parse(fs.readFileSync(p, 'utf8')) as PkgJson;
  pkgJsonCache.set(workspaceDir, data);
  return data;
}

function workspaceDir(absFile: string): string | null {
  const norm = absFile.replace(/\\/g, '/');
  const m = /^(.*\/(apps|packages|tools)\/[^/]+)(?:\/|$)/.exec(norm);
  return m ? m[1]! : null;
}

export const packageDeclaredDeps = createRule({
  name: 'package-declared-deps',
  meta: {
    type: 'problem',
    docs: {
      description: 'Workspace files may only import @apex/* packages declared in their own package.json.',
    },
    schema: [],
    messages: {
      undeclared:
        '`@apex/{{dep}}` is not declared in `{{owner}}/package.json`. Add it to dependencies or devDependencies.',
    },
  },
  defaultOptions: [],
  create(context) {
    const file = context.filename;
    const dir = workspaceDir(file);
    if (!dir) return {};
    const ws = workspaceFor(file);
    if (!ws) return {};
    const pkg = loadPkg(dir);
    if (!pkg) return {};
    const declared = new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    return {
      ImportDeclaration(node) {
        const spec = node.source.value;
        if (typeof spec !== 'string') return;
        const wsName = workspaceFromSpecifier(spec);
        if (!wsName) return;
        if (wsName === pkg.name) return; // self-import
        if (!declared.has(wsName)) {
          context.report({
            node: node.source,
            messageId: 'undeclared',
            data: { dep: wsName.replace('@apex/', ''), owner: ws.name },
          });
        }
      },
    };
  },
});

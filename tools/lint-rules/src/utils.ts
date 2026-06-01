import { ESLintUtils } from '@typescript-eslint/utils';

export const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/syedmahran404/APEX-JOB-AGENT/blob/main/tools/lint-rules/README.md#${name}`,
);

/**
 * Best-effort: extract the workspace folder ('apps/<name>' | 'packages/<name>' | 'tools/<name>')
 * from an absolute file path. Returns null when the file isn't inside a workspace folder.
 */
export function workspaceFor(absPath: string): { kind: 'app' | 'package' | 'tool'; name: string } | null {
  const norm = absPath.replace(/\\/g, '/');
  const m = /\/(apps|packages|tools)\/([^/]+)(?:\/|$)/.exec(norm);
  if (!m) return null;
  const kindMap = { apps: 'app', packages: 'package', tools: 'tool' } as const;
  return { kind: kindMap[m[1] as keyof typeof kindMap], name: m[2]! };
}

/**
 * Resolve an import specifier into its workspace identity ('@apex/<name>') if it is one,
 * or null otherwise (external modules, relative imports).
 */
export function workspaceFromSpecifier(spec: string): string | null {
  if (!spec.startsWith('@apex/')) return null;
  const slash = spec.indexOf('/', '@apex/'.length);
  return slash === -1 ? spec : spec.slice(0, slash);
}

export function isRelativeImport(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/');
}

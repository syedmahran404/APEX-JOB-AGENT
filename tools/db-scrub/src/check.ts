// CI-side check: every backing column in packages/db/prisma/schema.prisma must
// have a rule in tools/db-scrub/rules.yaml. New columns without a rule fail CI.
//
// Relation (virtual) fields have no backing column and are skipped: a field is a
// relation when its base type is another model (not a Prisma scalar and not an
// enum declared in the schema).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

interface ScrubFile {
  version: number;
  tables: Record<string, { columns: Record<string, { strategy: string; kind?: string }> }>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const PRISMA_SCALARS = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
  'Bigint',
]);

function readYaml(): ScrubFile {
  const text = fs.readFileSync(path.join(repoRoot, 'tools/db-scrub/rules.yaml'), 'utf8');
  return parseYaml(text) as ScrubFile;
}

interface PrismaColumn {
  table: string;
  column: string;
}

interface ModelBlock {
  tsName: string;
  body: string;
}

/**
 * Split the schema into model blocks by brace-depth tracking, so braces that
 * appear inside string literals (e.g. `@default("{}")`) do not terminate a
 * block prematurely.
 */
function extractModelBlocks(text: string): ModelBlock[] {
  const blocks: ModelBlock[] = [];
  const lines = text.split('\n');
  let current: { tsName: string; lines: string[] } | null = null;
  let depth = 0;
  for (const line of lines) {
    if (!current) {
      const start = /^\s*model\s+(\w+)\s*\{/.exec(line);
      if (start) {
        current = { tsName: start[1]!, lines: [] };
        // Account for braces already present on the declaration line.
        depth = countChar(line, '{') - countChar(line, '}');
        if (depth <= 0) {
          // Single-line model (unlikely); close immediately.
          blocks.push({ tsName: current.tsName, body: '' });
          current = null;
        }
      }
      continue;
    }
    depth += countChar(line, '{') - countChar(line, '}');
    if (depth <= 0) {
      blocks.push({ tsName: current.tsName, body: current.lines.join('\n') });
      current = null;
    } else {
      current.lines.push(line);
    }
  }
  return blocks;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function collectEnumNames(text: string): Set<string> {
  const names = new Set<string>();
  const re = /^\s*enum\s+(\w+)\s*\{/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) names.add(m[1]!);
  return names;
}

function readPrismaColumns(): PrismaColumn[] {
  const schemaPath = path.join(repoRoot, 'packages/db/prisma/schema.prisma');
  const text = fs.readFileSync(schemaPath, 'utf8');
  const enums = collectEnumNames(text);
  const cols: PrismaColumn[] = [];

  for (const block of extractModelBlocks(text)) {
    const mapMatch = /@@map\(\s*"([^"]+)"\s*\)/.exec(block.body);
    const tableName = mapMatch ? mapMatch[1]! : toSnakeCase(block.tsName);

    for (const line of block.body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('@@')) continue;
      // field: `<name> <Type>[modifiers] ...`
      const fieldMatch = /^([a-zA-Z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?/.exec(trimmed);
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1]!;
      const fieldType = fieldMatch[2]!;
      const isList = fieldMatch[3] === '[]';

      // Relation field: base type is a model (not a scalar, not an enum).
      const isScalarOrEnum = PRISMA_SCALARS.has(fieldType) || enums.has(fieldType);
      if (!isScalarOrEnum) continue; // model reference → virtual relation, no column
      // List of scalars is still backed by a column (e.g. String[]); keep it.
      void isList;

      const colMap = /@map\(\s*"([^"]+)"\s*\)/.exec(trimmed);
      const columnName = colMap ? colMap[1]! : toSnakeCase(fieldName);
      cols.push({ table: tableName, column: columnName });
    }
  }
  return cols;
}

function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function main(): void {
  const yaml = readYaml();
  const cols = readPrismaColumns();
  const missing: PrismaColumn[] = [];
  for (const c of cols) {
    const t = yaml.tables[c.table];
    if (!t) {
      missing.push(c);
      continue;
    }
    if (!t.columns[c.column]) missing.push(c);
  }
  if (missing.length > 0) {
    console.error(
      `db-scrub check failed: ${String(missing.length)} column(s) missing rule entry in tools/db-scrub/rules.yaml`,
    );
    for (const m of missing) console.error(`  - ${m.table}.${m.column}`);
    process.exit(1);
  }
  console.warn(`db-scrub check passed: ${String(cols.length)} columns covered.`);
}

main();

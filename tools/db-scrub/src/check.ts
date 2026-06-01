// CI-side check: every column in packages/db/prisma/schema.prisma must have a
// rule in tools/db-scrub/rules.yaml. New columns without a rule fail CI.

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

function readYaml(): ScrubFile {
  const text = fs.readFileSync(path.join(repoRoot, 'tools/db-scrub/rules.yaml'), 'utf8');
  return parseYaml(text) as ScrubFile;
}

interface PrismaColumn {
  table: string;
  column: string;
}

function readPrismaColumns(): PrismaColumn[] {
  const schemaPath = path.join(repoRoot, 'packages/db/prisma/schema.prisma');
  const text = fs.readFileSync(schemaPath, 'utf8');
  const cols: PrismaColumn[] = [];
  // Tokenize models. A model block: `model Foo { ... }`
  const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/g;
  for (let m = modelRe.exec(text); m; m = modelRe.exec(text)) {
    const tsName = m[1]!;
    const body = m[2]!;
    // The DB table name may be remapped via @@map("snake_case").
    const mapMatch = /@@map\(\s*"([^"]+)"\s*\)/.exec(body);
    const tableName = mapMatch ? mapMatch[1]! : toSnakeCase(tsName);
    // Extract field lines: "name <Type> ..."
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('@@')) continue;
      const fieldMatch = /^([a-zA-Z_][\w]*)\s+/.exec(trimmed);
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1]!;
      // Skip relation virtual fields (no backing column). Heuristic:
      // a field whose type is a model name with no scalar primitive and no @relation
      // we still emit only when there's a `@map(...)` or a scalar type. Easier heuristic:
      // skip lines that contain "@relation" without "@map".
      const isRelation = /\s+\w+\s*\??\s+@relation\b/.test(trimmed);
      if (isRelation && !/@map\(/.test(trimmed)) continue;
      // Resolve column name: @map("col") if present.
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
      `db-scrub check failed: ${missing.length} column(s) missing rule entry in tools/db-scrub/rules.yaml`,
    );
    for (const m of missing) console.error(`  - ${m.table}.${m.column}`);
    process.exit(1);
  }
  console.warn(`db-scrub check passed: ${cols.length} columns covered.`);
}

main();

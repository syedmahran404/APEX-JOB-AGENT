// Transaction helper with automatic retry on serialization conflicts.
// Prisma maps PG error 40001 (serialization_failure) and 40P01 (deadlock_detected)
// to errors with codes P2034 / P2025 etc. We catch by SQLSTATE-equivalent.

import type { PrismaClient, Prisma } from '@prisma/client';
import { ConflictError } from '@apex/shared-errors';

export type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export interface RunInTransactionOptions {
  /** Total attempts before giving up. */
  maxAttempts?: number;
  /** Initial backoff in ms; multiplied by 2^(attempt-1). */
  initialBackoffMs?: number;
  /** Prisma transaction options (timeout, isolationLevel, etc.). */
  prismaOptions?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel };
}

const RETRYABLE_PRISMA_CODES = new Set<string>(['P2034']); // serialization conflict
const RETRYABLE_PG_SQLSTATES = new Set<string>(['40001', '40P01']);

function isRetryablePrismaError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; meta?: { code?: unknown } };
  if (typeof e.code === 'string' && RETRYABLE_PRISMA_CODES.has(e.code)) return true;
  if (e.meta && typeof e.meta.code === 'string' && RETRYABLE_PG_SQLSTATES.has(e.meta.code)) return true;
  // Check stringified message as last resort.
  const msg = (err as Error).message ?? '';
  return /could not serialize access|deadlock detected/i.test(msg);
}

export async function runInTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: TxClient) => Promise<T>,
  opts: RunInTransactionOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initialBackoff = opts.initialBackoffMs ?? 25;

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await prisma.$transaction(async (tx) => fn(tx as unknown as TxClient), opts.prismaOptions);
    } catch (err) {
      if (attempt < maxAttempts && isRetryablePrismaError(err)) {
        const delay = initialBackoff * 2 ** (attempt - 1) + Math.floor(Math.random() * 25);
        await sleep(delay);
        continue;
      }
      if (isUniqueViolation(err)) {
        throw new ConflictError('Resource conflict (unique constraint)', { cause: serializeCause(err) });
      }
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown };
  return e.code === 'P2002';
}

function serializeCause(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

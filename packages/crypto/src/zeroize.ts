// Best-effort sensitive-buffer wipe. Node's GC may relocate buffers, so this
// is a defense-in-depth, not a guarantee. We also avoid persistent allocators
// for sensitive state.

export function zeroize(buf: Buffer | Uint8Array | undefined | null): void {
  if (!buf) return;
  for (let i = 0; i < buf.length; i++) buf[i] = 0;
}

/**
 * Run a function with a sensitive Buffer in scope, guaranteeing zeroize on
 * exit (whether the function returns, throws, or is interrupted by an
 * `await` rejection).
 */
export async function withZeroizedBuffer<T>(buf: Buffer, fn: (b: Buffer) => Promise<T> | T): Promise<T> {
  try {
    return await fn(buf);
  } finally {
    zeroize(buf);
  }
}

import { useQuery } from '@tanstack/react-query';

interface HealthEnvelope {
  status: 'ok' | 'degraded' | 'down';
  service: string;
  version: string;
  uptimeSec: number;
}

async function fetchHealth(): Promise<HealthEnvelope> {
  const resp = await fetch('/healthz', { credentials: 'omit' });
  if (!resp.ok) throw new TypeError(`Health check failed: ${String(resp.status)}`);
  return (await resp.json()) as HealthEnvelope;
}

export function App(): JSX.Element {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 5_000,
    staleTime: 1_000,
  });

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 gap-6">
      <header className="flex flex-col items-center gap-2 text-center">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-full bg-accent shadow-[0_0_24px_var(--color-accent)]"
        />
        <h1 className="font-display text-4xl tracking-tight">Apex Job Agent</h1>
        <p className="text-text-secondary max-w-md">
          The cockpit for your autonomous job application agent. Phase 1 foundation is online.
        </p>
      </header>

      <section
        className="rounded-xl border border-white/10 bg-bg-glass backdrop-blur p-6 min-w-[320px] shadow-elev-2"
        role="status"
        aria-live="polite"
      >
        <h2 className="font-display text-sm uppercase tracking-widest text-text-muted mb-3">
          API health
        </h2>
        {health.isPending && <p className="text-text-secondary">Checking…</p>}
        {health.isError && <p className="text-error">API unreachable.</p>}
        {health.data && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
            <dt className="text-text-muted">Status</dt>
            <dd className="text-success">{health.data.status}</dd>
            <dt className="text-text-muted">Service</dt>
            <dd>{health.data.service}</dd>
            <dt className="text-text-muted">Version</dt>
            <dd>{health.data.version}</dd>
            <dt className="text-text-muted">Uptime</dt>
            <dd>{health.data.uptimeSec}s</dd>
          </dl>
        )}
      </section>

      <footer className="text-xs text-text-muted">
        See <code className="font-mono">docs/architecture/</code> and{' '}
        <code className="font-mono">docs/audit/</code>.
      </footer>
    </main>
  );
}

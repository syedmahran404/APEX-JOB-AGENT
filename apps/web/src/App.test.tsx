import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Promise.resolve(new Response(
    JSON.stringify({ status: 'ok', service: 'apex-api', version: '0.1.0', uptimeSec: 7 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderApp(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe('<App />', () => {
  it('shows the cockpit hero text', () => {
    renderApp();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Apex Job Agent/i);
  });

  it('shows a status region with a live region for screen readers', () => {
    renderApp();
    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('renders an initial pending state before fetch resolves', () => {
    renderApp();
    expect(screen.getByText(/Checking/i)).toBeInTheDocument();
  });
});

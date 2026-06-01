import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        // Don't retry 4xx (assumed client error / auth).
        const code = (error as { status?: number } | null)?.status;
        if (typeof code === 'number' && code >= 400 && code < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

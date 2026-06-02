import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// With `globals: false`, RTL does not auto-register its afterEach cleanup.
// Unmount rendered trees between tests so the jsdom document does not
// accumulate multiple component instances across test cases.
afterEach(() => {
  cleanup();
});

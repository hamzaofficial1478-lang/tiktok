import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The test suite is deliberately Electron-free. Every module under test
 * (db, migrator, sidecars, config, logging, and later the queue engine and
 * URL normalizer) must be importable in a plain Node process. If a test ever
 * fails with "Cannot find module 'electron'", that is the architecture
 * telling you a headless module grew a UI-shell dependency — fix the module,
 * not the test.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 15_000,
  },
});

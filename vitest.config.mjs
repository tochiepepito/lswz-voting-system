/** @type {import('vitest/config')} */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Unit suite: pure domain logic, validation schemas and crypto helpers.
 * Runs with no database and no network, so it is safe in CI and pre-commit.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '~tests': fileURLToPath(new URL('./tests', import.meta.url)),
    },
  },
  test: {
    name: 'unit',
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup-unit.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});

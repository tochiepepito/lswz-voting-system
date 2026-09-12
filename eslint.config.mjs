import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

/**
 * Flat config: later blocks win. The per-directory overrides must therefore come
 * AFTER the project-wide rules block, or the general block silently re-enables
 * the very rule the override was added to switch off.
 */
export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'node_modules/**', 'src/generated/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],

      // Application code must go through the shared client in `lib/prisma.ts`;
      // a second PrismaClient means a second connection pool.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              importNames: ['PrismaClient'],
              message:
                'Import the shared singleton from "@/lib/prisma" instead of constructing a PrismaClient.',
            },
          ],
        },
      ],
    },
  },
  {
    // Standalone scripts run under plain `tsx`, outside Next and outside the
    // path aliases, so they cannot import the app's Prisma singleton and must
    // construct their own short-lived client. They exit when finished, so the
    // connection-pool concern the rule guards against does not apply.
    files: ['prisma/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];

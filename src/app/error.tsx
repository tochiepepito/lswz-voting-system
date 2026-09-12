'use client';

import { useEffect } from 'react';
import { buttonClass } from '@/components/ui';

/**
 * Global error boundary.
 *
 * Deliberately shows nothing about what actually failed. In production Next.js
 * already replaces the message with a generic one, but this boundary also runs
 * in development, where `error.message` would happily render a database error
 * onto the screen an organiser is sharing.
 *
 * `error.digest` is the server-side correlation id - safe to show, and it is
 * what lets an operator find the matching line in the server log.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] render error', error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center px-4 text-center">
      <div className="text-4xl" aria-hidden="true">
        ⚠️
      </div>
      <h1 className="mt-4 text-2xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-muted">
        The page could not be loaded. Please try again in a moment.
      </p>

      {error.digest ? (
        <p className="mt-4 font-mono text-xs text-faint">Reference: {error.digest}</p>
      ) : null}

      <div className="mt-6 flex gap-2">
        <button type="button" onClick={reset} className={buttonClass('primary')}>
          Try again
        </button>
        {/*
          A real document navigation, not a client-side one. This boundary
          catches render failures, and the router itself may be part of what
          broke - a full reload is the reliable escape hatch.
        */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/events" className={buttonClass('secondary')}>
          Back to events
        </a>
      </div>
    </main>
  );
}

'use client';

import { useEffect } from 'react';
import { Alert, buttonClass } from '@/components/ui';

/**
 * Error boundary for the voter routes.
 *
 * WHY THIS EXISTS AT THIS SEGMENT, not just at the root.
 *
 * `loading.tsx` puts a Suspense boundary around these pages. When a Server
 * Component throws *after* the shell has already been flushed to the browser -
 * a database outage being the obvious case - there must be an error boundary
 * INSIDE that Suspense boundary for Next.js to swap the fallback out. Without
 * one, the skeleton renders forever and the voter has no idea anything is wrong.
 *
 * The message stays deliberately vague. A voter cannot act on "the connection
 * pool is exhausted", and saying so out loud tells an attacker which component
 * is unhealthy.
 */
export default function EventsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[events] render error', error);
  }, [error]);

  return (
    <div className="space-y-5">
      <Alert tone="danger" title="Voting is temporarily unavailable">
        We could not load the voting events just now. This is usually brief - please try again in a
        moment.
      </Alert>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={reset} className={buttonClass('primary')}>
          Try again
        </button>
      </div>

      {error.digest ? (
        <p className="font-mono text-xs text-faint">
          Reference: {error.digest} - quote this if you contact an organiser.
        </p>
      ) : null}
    </div>
  );
}

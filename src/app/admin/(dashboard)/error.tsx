'use client';

import { useEffect } from 'react';
import { Alert, buttonClass } from '@/components/ui';

/**
 * Error boundary for the admin dashboard.
 *
 * Operators get more detail than voters do - they are the people who can
 * actually act on it - but still never the raw error. In production Next.js
 * replaces `error.message` with a generic string anyway; this boundary also runs
 * in development, where the raw message would happily render a database
 * connection string onto a screen an organiser may be sharing.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[admin] render error', error);
  }, [error]);

  return (
    <div className="space-y-5">
      <Alert tone="danger" title="This screen could not be loaded">
        Something went wrong while loading this page. If it keeps happening, check that the
        application can reach its database, then look at the server logs.
      </Alert>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={reset} className={buttonClass('primary')}>
          Try again
        </button>
        <a href="/admin" className={buttonClass('secondary')}>
          Back to overview
        </a>
      </div>

      {error.digest ? (
        <p className="font-mono text-xs text-faint">Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}

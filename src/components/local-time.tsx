'use client';

import { useEffect, useState } from 'react';
import { formatCountdown, formatDateTimeLocal, formatDateTimeUtc } from '@/lib/format';

/**
 * Timezone-aware timestamps without a hydration mismatch.
 *
 * The server has no idea what timezone the voter is in, so it renders the
 * unambiguous UTC form. After mount - when the browser's timezone is finally
 * knowable - the component swaps in the local format. Rendering the local
 * format directly would produce different HTML on the server and the client and
 * React would discard the whole subtree with a hydration error.
 */
export function LocalTime({ value, className }: { value: string; className?: string }) {
  const [local, setLocal] = useState<string | null>(null);

  useEffect(() => {
    setLocal(formatDateTimeLocal(value));
  }, [value]);

  return (
    <time dateTime={value} className={className} suppressHydrationWarning>
      {local ?? formatDateTimeUtc(value)}
    </time>
  );
}

/**
 * Live countdown to a deadline.
 *
 * Ticks once a second while more than a minute remains and the tab is visible;
 * the interval is cleared on unmount. It is a convenience only - the server
 * decides whether voting is actually open, so a drifting clock or a paused tab
 * can never let a late ballot through.
 */
export function Countdown({
  deadline,
  className,
  prefix = 'Closes in',
}: {
  deadline: string;
  className?: string;
  prefix?: string;
}) {
  const target = new Date(deadline).getTime();
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setRemaining(target - Date.now());

    tick();
    const timer = window.setInterval(tick, 1000);

    return () => window.clearInterval(timer);
  }, [target]);

  // Nothing is rendered until the first client tick, so the server and the
  // first client render agree on an empty slot.
  if (remaining === null) return null;

  if (remaining <= 0) {
    return <span className={className}>Voting has closed</span>;
  }

  return (
    <span className={className}>
      {prefix} <span className="font-semibold tabular-nums">{formatCountdown(remaining)}</span>
    </span>
  );
}

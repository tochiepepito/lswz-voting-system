import Link from 'next/link';

/**
 * Public shell.
 *
 * Deliberately minimal: no navigation menu, no account controls, no admin
 * links. The voter journey is three screens long and every extra affordance is
 * a way to fall out of it. The admin area is discoverable by URL only - hiding
 * the link is not a security measure (the routes are guarded), it just keeps
 * the voter interface uncluttered.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link href="/events" className="flex items-center gap-2 font-bold">
            <span aria-hidden="true">🗳️</span>
            <span>Last Shelter War z Voting System</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:py-10">{children}</main>

      <footer className="border-t border-line px-4 py-6">
        <p className="mx-auto max-w-3xl text-xs text-faint">
          Votes are identified by in-game name. This provides community-level verification, not
          proof of identity.
        </p>
      </footer>
    </div>
  );
}

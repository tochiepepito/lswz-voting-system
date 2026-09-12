import Link from 'next/link';
import { AdminNav, type NavItem } from '@/components/admin/nav';
import { buttonClass } from '@/components/ui';
import { logoutAction } from '@/server/actions/admin.actions';
import { requireAdminPage } from '@/server/auth/guard';
import { ADMIN_ROLE_LABELS, roleHasCapability } from '@/types/domain';

export const dynamic = 'force-dynamic';

/**
 * Authenticated admin shell.
 *
 * The `requireAdminPage()` call here covers every page in the `(dashboard)`
 * group, but it is NOT the only check - each page and every Server Action
 * re-authorises independently. A layout guard alone would be a single point of
 * failure, and Next.js layouts do not re-run on every client-side navigation.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { admin } = await requireAdminPage();

  const items: NavItem[] = [
    { href: '/admin', label: 'Overview', icon: '📊' },
    { href: '/admin/events', label: 'Events', icon: '🗳️' },
    { href: '/admin/security', label: 'Security', icon: '🛡️' },
    { href: '/admin/voters', label: 'Voters', icon: '👥' },
  ];

  if (roleHasCapability(admin.role, 'admin:manage')) {
    items.push({ href: '/admin/admins', label: 'Administrators', icon: '🔑' });
  }

  items.push({ href: '/admin/account', label: 'My account', icon: '⚙️' });

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="flex items-center gap-2 font-bold">
              <span aria-hidden="true">🗳️</span>
              <span>Voting admin</span>
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium leading-tight">{admin.displayName}</div>
              <div className="text-xs text-faint">{ADMIN_ROLE_LABELS[admin.role]}</div>
            </div>

            <form action={logoutAction}>
              <button type="submit" className={buttonClass('ghost', 'min-h-0 px-3 py-1.5 text-xs')}>
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row">
        <aside className="lg:w-56 lg:shrink-0">
          <div className="lg:sticky lg:top-6">
            <AdminNav items={items} />
          </div>
        </aside>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

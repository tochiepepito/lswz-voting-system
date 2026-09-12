'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '../ui';

/**
 * Admin navigation.
 *
 * `capabilities` decides what is rendered, but never what is permitted: each
 * destination re-checks the same capability server-side in its own
 * `requireAdminPage(...)` call. Hiding a link an auditor cannot use is a
 * usability choice; it is not the access control.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: string;
};

export function AdminNav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin sections">
      <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        {items.map((item) => {
          // `/admin` must not light up for `/admin/events`, so the dashboard
          // root matches exactly while sections match their subtree.
          const isActive =
            item.href === '/admin'
              ? pathname === '/admin'
              : pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cx(
                  'flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-muted hover:bg-surface-2 hover:text-ink',
                )}
              >
                <span aria-hidden="true">{item.icon}</span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

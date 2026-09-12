import type { Metadata } from 'next';
import { ChangePasswordForm } from '@/components/admin/admin-management';
import { LocalTime } from '@/components/local-time';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { ADMIN_ROLE_LABELS, ROLE_CAPABILITIES } from '@/types/domain';
import { requireAdminPage } from '@/server/auth/guard';
import * as AdminService from '@/server/services/admin.service';

export const metadata: Metadata = { title: 'My account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ first?: string }>;
}) {
  const { admin } = await requireAdminPage(undefined, '/admin/account');
  const params = await searchParams;
  const csrfToken = await AdminService.getAdminCsrfToken();

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="My account" />

      {params.first || admin.mustChangePassword ? (
        <Alert tone="warn" title="Choose your own password">
          You are signed in with a password someone else set for you. Please change it before doing
          anything else.
        </Alert>
      ) : null}

      <Card className="p-5">
        <dl className="space-y-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted">Name</dt>
            <dd className="font-medium">{admin.displayName}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted">E-mail</dt>
            <dd className="font-medium">{admin.email}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted">Role</dt>
            <dd>
              <Badge tone={admin.role === 'SUPER_ADMIN' ? 'accent' : 'neutral'}>
                {ADMIN_ROLE_LABELS[admin.role]}
              </Badge>
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted">Last signed in</dt>
            <dd className="text-right">
              {admin.lastLoginAt ? (
                <LocalTime value={admin.lastLoginAt.toISOString()} />
              ) : (
                'This is your first session'
              )}
            </dd>
          </div>
        </dl>

        <div className="mt-4 border-t border-line pt-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">
            What your role allows
          </h2>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {ROLE_CAPABILITIES[admin.role].map((capability) => (
              <li key={capability}>
                <Badge tone="neutral">{capability}</Badge>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 font-semibold">Change password</h2>
        <ChangePasswordForm csrfToken={csrfToken} />
      </Card>
    </div>
  );
}

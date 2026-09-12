import type { Metadata } from 'next';
import { CreateAdminForm, UpdateAdminForm } from '@/components/admin/admin-management';
import { LocalTime } from '@/components/local-time';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { ADMIN_ROLE_LABELS, ROLE_CAPABILITIES } from '@/types/domain';
import { requireAdminPage } from '@/server/auth/guard';
import * as AdminService from '@/server/services/admin.service';

export const metadata: Metadata = { title: 'Administrators' };
export const dynamic = 'force-dynamic';

export default async function AdminsPage() {
  const { admin: currentAdmin } = await requireAdminPage('admin:manage', '/admin/admins');

  const [admins, csrfToken] = await Promise.all([
    AdminService.list(),
    AdminService.getAdminCsrfToken(),
  ]);

  const now = new Date();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Administrators"
        description="Who can manage events, moderate votes and see audit information."
      />

      <Alert tone="info" title="Roles">
        <ul className="mt-1 space-y-1 text-xs">
          {Object.entries(ADMIN_ROLE_LABELS).map(([role, label]) => (
            <li key={role}>
              <span className="font-semibold">{label}:</span>{' '}
              {ROLE_CAPABILITIES[role as keyof typeof ROLE_CAPABILITIES].join(', ')}
            </li>
          ))}
        </ul>
      </Alert>

      <ul className="space-y-2">
        {admins.map((admin) => {
          const isLocked = admin.lockedUntil !== null && admin.lockedUntil > now;

          return (
            <Card as="li" key={admin.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{admin.displayName}</span>
                    <Badge tone={admin.role === 'SUPER_ADMIN' ? 'accent' : 'neutral'}>
                      {ADMIN_ROLE_LABELS[admin.role]}
                    </Badge>
                    {!admin.isActive ? <Badge tone="danger">Disabled</Badge> : null}
                    {isLocked ? <Badge tone="warn">Locked</Badge> : null}
                    {admin.mustChangePassword ? (
                      <Badge tone="info">Must change password</Badge>
                    ) : null}
                    {admin.id === currentAdmin.id ? <Badge tone="ok">You</Badge> : null}
                  </div>

                  <p className="mt-1 text-sm text-muted">{admin.email}</p>

                  <p className="mt-1 text-xs text-faint">
                    {admin.lastLoginAt ? (
                      <>
                        Last signed in <LocalTime value={admin.lastLoginAt.toISOString()} />
                      </>
                    ) : (
                      'Has never signed in'
                    )}
                  </p>

                  {isLocked && admin.lockedUntil ? (
                    <p className="mt-1 text-xs text-warn">
                      Locked until <LocalTime value={admin.lockedUntil.toISOString()} /> after
                      repeated failed sign-ins.
                    </p>
                  ) : null}
                </div>

                <UpdateAdminForm
                  adminId={admin.id}
                  displayName={admin.displayName}
                  role={admin.role}
                  isActive={admin.isActive}
                  isSelf={admin.id === currentAdmin.id}
                  csrfToken={csrfToken}
                />
              </div>
            </Card>
          );
        })}
      </ul>

      <CreateAdminForm csrfToken={csrfToken} />
    </div>
  );
}

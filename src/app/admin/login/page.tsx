import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/admin/login-form';
import { Alert, Card } from '@/components/ui';
import * as AdminService from '@/server/services/admin.service';

export const metadata: Metadata = { title: 'Administrator sign-in' };
export const dynamic = 'force-dynamic';

/**
 * Sign-in lives outside the `(dashboard)` route group, so it is not wrapped by
 * the layout that enforces authentication. Putting it inside would produce a
 * redirect loop: the guard would bounce an unauthenticated visitor to the very
 * page the guard protects.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; changed?: string }>;
}) {
  const params = await searchParams;

  // Already signed in? Skip the form.
  const current = await AdminService.getCurrentAdmin();
  if (current) redirect('/admin');

  // Only a local path is ever echoed back into the form, so `?next=` cannot
  // turn sign-in into an open redirect. The schema enforces this again server-side.
  const next =
    params.next && params.next.startsWith('/') && !params.next.startsWith('//')
      ? params.next
      : undefined;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 text-center">
        <div className="text-3xl" aria-hidden="true">
          🗳️
        </div>
        <h1 className="mt-3 text-2xl font-bold">Administrator sign-in</h1>
        <p className="mt-1 text-sm text-muted">Manage voting events and review results.</p>
      </div>

      {params.changed ? (
        <Alert tone="ok" className="mb-4">
          Your password was changed. Please sign in again.
        </Alert>
      ) : null}

      <Card className="p-6">
        <LoginForm redirectTo={next} />
      </Card>

      <p className="mt-6 text-center text-xs text-faint">
        Voters do not need an account.{' '}
        <Link href="/events" className="underline hover:text-muted">
          Go to voting
        </Link>
      </p>
    </main>
  );
}

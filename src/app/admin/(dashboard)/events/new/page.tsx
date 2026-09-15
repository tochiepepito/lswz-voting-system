import type { Metadata } from 'next';
import Link from 'next/link';
import { EventForm } from '@/components/admin/event-form';
import { PageHeader } from '@/components/ui';
import { requireAdminPage } from '@/server/auth/guard';
import * as AdminService from '@/server/services/admin.service';

export const metadata: Metadata = { title: 'New event' };
export const dynamic = 'force-dynamic';

export default async function NewEventPage() {
  await requireAdminPage('event:write', '/admin/events/new');
  const csrfToken = await AdminService.getAdminCsrfToken();

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/events" className="text-sm text-muted hover:text-ink">
          ← Events
        </Link>
      </div>

      <PageHeader
        title="New voting event"
        description="Events are created as drafts. Nothing is visible to voters until you publish."
      />

      <EventForm
        mode="create"
        csrfToken={csrfToken}
        defaults={{
          title: '',
          slug: '',
          description: '',
          instructions: '',
          votingType: 'SINGLE_CHOICE',
          minSelections: 1,
          maxSelections: 1,
          startsAt: null,
          endsAt: null,
          resultsVisibility: 'AFTER_CLOSE',
          maxVotesPerSession: 1,
          ipSoftLimit: 8,
          requireCaptcha: false,
          randomizeOptionOrder: false,
        }}
      />
    </div>
  );
}

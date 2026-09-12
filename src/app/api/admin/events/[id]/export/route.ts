import { jsonError, requestContextFrom } from '@/lib/http';
import { appError } from '@/lib/errors';
import { idSchema } from '@/schemas/common';
import { exportFormatSchema } from '@/schemas/event';
import { actorFrom, requireAdmin } from '@/server/auth/guard';
import * as AuditService from '@/server/services/audit.service';
import * as EventService from '@/server/services/event.service';
import * as ResultsService from '@/server/services/results.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/events/:id/export?format=summary|ballots|participants
 *
 * Results export. A Route Handler rather than a Server Action because the
 * response is a file download, which an action cannot produce.
 *
 * Guarded by `requireAdmin('results:export')` as its very first statement, and
 * every export is written to the audit log - downloading the full ballot list,
 * IGNs included, is exactly the kind of action an election needs a record of.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const current = await requireAdmin('results:export');

    const { id } = await context.params;
    const eventId = idSchema.safeParse(id);
    if (!eventId.success) throw appError('NOT_FOUND');

    const format = exportFormatSchema
      .catch('summary')
      .parse(new URL(request.url).searchParams.get('format') ?? 'summary');

    const event = await EventService.getEventForAdmin(eventId.data);
    if (!event) throw appError('EVENT_NOT_FOUND');

    const result = await ResultsService.exportResults(event, format);

    await AuditService.recordAdminAction({
      action: 'RESULTS_EXPORTED',
      summary: `Results for "${event.title}" were exported (${format}).`,
      ...actorFrom(current),
      eventId: event.id,
      context: requestContextFrom(request),
      metadata: { format, filename: result.filename },
    });

    return new Response(result.content, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        // The filename is derived from the slug and sanitised in lib/csv.ts, so
        // it cannot break out of this header.
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return jsonError(error, 'GET /api/admin/events/[id]/export');
  }
}

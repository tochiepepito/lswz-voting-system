import { jsonError, jsonOk } from '@/lib/http';
import { toPublicEventSummary } from '@/server/presenters/public';
import * as EventService from '@/server/services/event.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/events
 *
 * Every event a voter is allowed to see. Draft and unpublished events are
 * excluded by the repository query itself, not filtered here.
 */
export async function GET() {
  try {
    const events = await EventService.listPublicEvents();
    const now = new Date();

    return jsonOk({ events: events.map((event) => toPublicEventSummary(event, now)) });
  } catch (error) {
    return jsonError(error, 'GET /api/events');
  }
}

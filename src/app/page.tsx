import { redirect } from 'next/navigation';

/**
 * The root is the event list. A separate marketing landing page would be one
 * more tap between a player and their ballot, and the link shared in Discord is
 * usually the bare domain.
 */
export default function HomePage() {
  redirect('/events');
}

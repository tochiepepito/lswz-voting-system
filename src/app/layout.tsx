import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Community Voting',
    template: '%s · Community Voting',
  },
  description:
    'Login-free voting and elections for gaming communities. Enter your in-game name and cast your ballot.',
  // The public ballot is shareable, but nothing here should be indexed: event
  // pages are ephemeral and results are governed by per-event visibility rules.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Not `maximum-scale`: pinch-zoom must stay available. Voters read candidate
  // descriptions on small phones and blocking zoom is an accessibility failure.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0c12' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}

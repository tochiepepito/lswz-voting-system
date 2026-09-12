import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * `next dev` compiles every module wrapped in `eval()` (that is how webpack
 * provides fast rebuilds and readable stack traces), and the HMR client opens a
 * WebSocket back to the dev server.
 *
 * A CSP without `'unsafe-eval'` therefore blocks the entire client bundle in
 * development: pages still render, because the HTML is produced on the server
 * and `<Link>` navigation needs no JavaScript, but React never hydrates and
 * every button silently does nothing. It is a genuinely confusing failure,
 * because nothing looks broken.
 *
 * Production bundles contain no `eval`, so the strict policy is kept there.
 * `'unsafe-eval'` materially weakens a CSP and must never ship.
 */
const isDevelopment = process.env.NODE_ENV !== 'production';

const scriptSrc = [
  "script-src 'self'",
  // Next.js injects small inline bootstrap scripts on every page.
  "'unsafe-inline'",
  ...(isDevelopment ? ["'unsafe-eval'"] : []),
].join(' ');

// The HMR WebSocket is same-origin, which `'self'` covers in current browsers,
// but the explicit ws:/wss: entries avoid surprises across browser versions.
const connectSrc = ["connect-src 'self'", ...(isDevelopment ? ['ws:', 'wss:'] : [])].join(' ');

/**
 * Security headers are set here (and not only in middleware) so that they apply
 * to every response, including static assets and error pages.
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Styles come from Tailwind's compiled stylesheet plus React's inline
      // style attributes.
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      // Candidate avatars are admin-supplied URLs, so remote images are allowed.
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      connectSrc,
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the tracing root: a lockfile in a parent directory would otherwise make
  // Next infer the wrong workspace root and trace the wrong files for output.
  outputFileTracingRoot: path.join(__dirname),
  poweredByHeader: false,
  // Typed + linted builds are a deployment gate, not an optional extra.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;

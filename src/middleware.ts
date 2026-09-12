import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware.
 *
 * THIS IS NOT THE ACCESS CONTROL. Read that again before adding anything here.
 *
 * Middleware runs on the Edge runtime, where there is no database connection and
 * no Node crypto, so it cannot verify a session - it can only see whether a
 * cookie is *present*. Anyone can set a cookie with the right name. The real
 * checks are `requireAdminPage()` in every admin page and `requireAdmin()` in
 * every admin action and route handler, each of which resolves the token
 * against `admin_sessions` and re-checks the role.
 *
 * What this does buy:
 *   - a signed-out operator gets an instant redirect instead of rendering a
 *     dashboard shell and then bouncing;
 *   - `?next=` is preserved so they land where they were going;
 *   - admin responses are marked no-store at the edge.
 *
 * The cookie name mirrors `lib/cookies.ts`, which adds the browser-enforced
 * `__Host-` prefix in production.
 */

const ADMIN_COOKIES = ['__Host-gev_admin', 'gev_admin'];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const hasAdminCookie = ADMIN_COOKIES.some((name) => request.cookies.has(name));

  if (!hasAdminCookie) {
    const url = request.nextUrl.clone();
    url.pathname = '/admin/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;

    return NextResponse.redirect(url);
  }

  const response = NextResponse.next();

  // Authenticated admin pages must never sit in a shared or browser cache.
  response.headers.set('Cache-Control', 'no-store, must-revalidate');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');

  return response;
}

export const config = {
  /*
   * Everything under /admin except the login page itself and the auth API.
   * A negative lookahead rather than a runtime `if`, so the middleware does not
   * even execute for the excluded paths.
   */
  matcher: ['/admin/((?!login).*)', '/admin'],
};

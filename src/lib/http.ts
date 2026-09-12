import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { allowedOrigins, env, isProduction } from './env';
import { hashIp, hashUserAgent } from './crypto';
import { appError, type AppError, type PublicErrorBody, toAppError } from './errors';

/**
 * HTTP-layer concerns: who is making this request, and is it allowed to change
 * anything?
 */

export type RequestContext = {
  /**
   * Client IP, or null when it cannot be trusted. Never persisted raw.
   * Grouped to a /64 for IPv6, because a single household is routinely handed a
   * whole /64 and treating each address as a distinct actor would make IPv6
   * abuse limits meaningless.
   */
  ip: string | null;
  ipHash: string | null;
  userAgent: string | null;
  userAgentHash: string | null;
};

// --------------------------------------------------------------------------
// Client IP
// --------------------------------------------------------------------------

/**
 * `X-Forwarded-For` is client-controlled unless a proxy you own appended the
 * entry you read. TRUSTED_PROXY_HOPS says how many entries at the right-hand
 * end were written by infrastructure you control:
 *
 *   XFF: <spoofed>, <spoofed>, <real client>, <proxy 1>
 *                               ^ hops = 1 reads here
 *
 * With hops = 0 the header is ignored entirely and IP-based protection is
 * simply off, which is the honest outcome for a direct-to-Node deployment: it
 * is better than trusting a header any client can forge.
 */
function clientIpFromHeaders(headerList: Headers): string | null {
  const hops = env.TRUSTED_PROXY_HOPS;
  if (hops === 0) return null;

  const forwarded = headerList.get('x-forwarded-for');
  if (forwarded) {
    const entries = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    // Index of the entry written by the outermost proxy we control.
    const index = entries.length - hops;
    const candidate = entries[index >= 0 ? index : 0];
    if (candidate) return normalizeIp(candidate);
  }

  const realIp = headerList.get('x-real-ip');
  return realIp ? normalizeIp(realIp) : null;
}

/**
 * Canonicalise an address so the same client always produces the same key:
 * strip a port, unwrap IPv4-mapped IPv6, drop an IPv6 zone index, and reduce
 * IPv6 to its /64 network prefix.
 */
export function normalizeIp(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (!value) return null;

  // "[::1]:8080" or "1.2.3.4:8080"
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close > 0) value = value.slice(1, close);
  } else if ((value.match(/:/g)?.length ?? 0) === 1) {
    value = value.split(':')[0] ?? value;
  }

  // Zone index, e.g. "fe80::1%eth0"
  const zone = value.indexOf('%');
  if (zone > 0) value = value.slice(0, zone);

  // IPv4-mapped IPv6, e.g. "::ffff:192.0.2.1"
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped?.[1]) value = mapped[1];

  if (!value) return null;

  // IPv4: use the full address.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value;

  // IPv6: collapse to the /64 prefix.
  if (value.includes(':')) return ipv6NetworkPrefix(value);

  return value;
}

function ipv6NetworkPrefix(address: string): string {
  const [head = '', tail = ''] = address.split('::', 2);
  const headGroups = head ? head.split(':').filter(Boolean) : [];

  if (!address.includes('::')) {
    return headGroups.slice(0, 4).join(':') + '::/64';
  }

  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const expanded = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];

  return expanded.slice(0, 4).join(':') + '::/64';
}

function buildContext(headerList: Headers): RequestContext {
  const ip = clientIpFromHeaders(headerList);
  const userAgent = headerList.get('user-agent');

  return {
    ip,
    ipHash: ip ? hashIp(ip) : null,
    userAgent,
    userAgentHash: userAgent ? hashUserAgent(userAgent) : null,
  };
}

/** Request context inside a Server Component or Server Action. */
export async function getRequestContext(): Promise<RequestContext> {
  return buildContext(await headers());
}

/** Request context inside a Route Handler. */
export function requestContextFrom(request: Request): RequestContext {
  return buildContext(request.headers);
}

// --------------------------------------------------------------------------
// Origin enforcement
// --------------------------------------------------------------------------

/**
 * Reject cross-site state-changing requests.
 *
 * This is the first of two CSRF layers. It catches the common case cheaply and
 * without any per-session state; the synchroniser token in `lib/cookies.ts`
 * catches the rest. Both are applied to every mutating voter endpoint.
 */
export function assertTrustedOrigin(headerList: Headers): void {
  const origin = headerList.get('origin');

  if (origin) {
    if (!allowedOrigins.includes(origin)) {
      throw appError('CSRF_FAILED');
    }
    return;
  }

  // No Origin header: browsers omit it on same-origin GETs and on some
  // same-origin form posts. Fetch metadata resolves the ambiguity when present.
  const fetchSite = headerList.get('sec-fetch-site');
  if (fetchSite === 'same-origin' || fetchSite === 'none') return;
  if (fetchSite) throw appError('CSRF_FAILED');

  // Neither header: a non-browser client. Accepted only outside production,
  // where it is how the integration tests and curl exercise the API.
  if (!isProduction) return;

  throw appError('CSRF_FAILED');
}

export async function assertTrustedOriginFromContext(): Promise<void> {
  assertTrustedOrigin(await headers());
}

// --------------------------------------------------------------------------
// JSON responses
// --------------------------------------------------------------------------

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
} as const;

/**
 * Success response. Defaults to `no-store`: almost everything this API returns
 * is either per-voter or a live tally, and a cached ballot state is a bug.
 */
export function jsonOk<T>(data: T, init?: { status?: number; headers?: HeadersInit }): NextResponse {
  return NextResponse.json(data, {
    status: init?.status ?? 200,
    headers: { ...NO_STORE_HEADERS, ...init?.headers },
  });
}

/**
 * Error response built exclusively from the error taxonomy, so no internal
 * message, stack or database detail can reach the client.
 */
export function jsonError(error: unknown, context: string): NextResponse {
  const appErr: AppError = toAppError(error, context);

  const headers: Record<string, string> = { ...NO_STORE_HEADERS };
  if (appErr.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(appErr.retryAfterSeconds);
  }

  const body: PublicErrorBody = appErr.toPublicJSON();

  return NextResponse.json(body, { status: appErr.status, headers });
}

/**
 * Parse a JSON body defensively.
 *
 * Enforces the content type (a form-encoded POST to a JSON endpoint is a
 * classic CSRF vector, since forms can be submitted cross-site without CORS)
 * and caps the body size.
 */
const MAX_JSON_BODY_BYTES = 16 * 1024;

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw appError('VALIDATION_FAILED', { message: 'Expected a JSON request body.' });
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_JSON_BODY_BYTES) {
    throw appError('VALIDATION_FAILED', { message: 'Request body is too large.' });
  }

  const raw = await request.text();
  if (raw.length > MAX_JSON_BODY_BYTES) {
    throw appError('VALIDATION_FAILED', { message: 'Request body is too large.' });
  }

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw appError('VALIDATION_FAILED', { message: 'Request body is not valid JSON.' });
  }
}

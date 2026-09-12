import { env } from '@/lib/env';
import { appError } from '@/lib/errors';

/**
 * CaptchaService
 *
 * Optional human-verification layer, off by default.
 *
 * It is deliberately pluggable and per-event: a guild poll about raid night does
 * not need a challenge, while a contested officer election during a public
 * brigading campaign very much does. An administrator flips `requireCaptcha` on
 * the event; nothing else in the voting path changes.
 *
 * Cloudflare Turnstile is the one provider implemented, chosen because it needs
 * no account linkage and no personal data from the voter.
 */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5000;

export function isCaptchaConfigured(): boolean {
  return env.CAPTCHA_PROVIDER !== 'none';
}

/** Whether this event, on this deployment, actually needs a challenge. */
export function isCaptchaRequired(event: { requireCaptcha: boolean }): boolean {
  return event.requireCaptcha && isCaptchaConfigured();
}

export type CaptchaVerification =
  | { ok: true }
  | { ok: false; reason: 'MISSING_TOKEN' | 'REJECTED' | 'PROVIDER_UNAVAILABLE' };

/**
 * Verify a challenge response.
 *
 * A provider outage returns PROVIDER_UNAVAILABLE rather than throwing, so the
 * caller can decide the policy. This system chooses to FAIL OPEN on an outage:
 * refusing every ballot because Cloudflare is having a bad afternoon would
 * disenfranchise the whole community, and the duplicate-vote constraint plus
 * rate limiting remain in force regardless. The decision is audited.
 */
export async function verify(
  token: string | undefined | null,
  remoteIp: string | null,
): Promise<CaptchaVerification> {
  if (!isCaptchaConfigured()) return { ok: true };

  if (!token || token.trim() === '') return { ok: false, reason: 'MISSING_TOKEN' };

  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: false, reason: 'PROVIDER_UNAVAILABLE' };

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!response.ok) return { ok: false, reason: 'PROVIDER_UNAVAILABLE' };

    const result = (await response.json()) as { success?: boolean };

    return result.success === true ? { ok: true } : { ok: false, reason: 'REJECTED' };
  } catch {
    return { ok: false, reason: 'PROVIDER_UNAVAILABLE' };
  }
}

/**
 * Verify and throw on a genuine failure.
 * Returns a note when the provider was unreachable, so the caller can audit the
 * fail-open decision rather than letting it pass silently.
 */
export async function enforce(
  event: { requireCaptcha: boolean },
  token: string | undefined | null,
  remoteIp: string | null,
): Promise<{ failedOpen: boolean }> {
  if (!isCaptchaRequired(event)) return { failedOpen: false };

  const verification = await verify(token, remoteIp);
  if (verification.ok) return { failedOpen: false };

  if (verification.reason === 'PROVIDER_UNAVAILABLE') {
    console.warn('[CaptchaService] provider unavailable; allowing the request');
    return { failedOpen: true };
  }

  throw appError(verification.reason === 'MISSING_TOKEN' ? 'CAPTCHA_REQUIRED' : 'CAPTCHA_FAILED');
}

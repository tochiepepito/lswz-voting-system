import type { ReactNode } from 'react';
import Link from 'next/link';

/**
 * Shared presentational primitives.
 *
 * All server components (no `'use client'`), so they add nothing to the client
 * bundle. Anything needing state lives in its own client component file.
 */

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

// --------------------------------------------------------------------------
// Layout
// --------------------------------------------------------------------------

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag className={cx('rounded-card border border-line bg-surface shadow-card', className)}>
      {children}
    </Tag>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-accent">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-balance text-2xl font-bold leading-tight sm:text-3xl">{title}</h1>
        {description ? <div className="mt-2 max-w-2xl text-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
}) {
  const toneClass = {
    neutral: 'text-ink',
    ok: 'text-ok',
    warn: 'text-warn',
    danger: 'text-danger',
    accent: 'text-accent',
  }[tone];

  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-faint">{label}</div>
      <div className={cx('mt-1 text-2xl font-bold tabular-nums', toneClass)}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </Card>
  );
}

// --------------------------------------------------------------------------
// Badges
// --------------------------------------------------------------------------

type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  ok: 'bg-ok/10 text-ok border-ok/25',
  warn: 'bg-warn/10 text-warn border-warn/25',
  danger: 'bg-danger/10 text-danger border-danger/25',
  info: 'bg-info/10 text-info border-info/25',
  accent: 'bg-accent/10 text-accent border-accent/25',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Status pill for an event, with a tone that matches what the status means. */
export function StatusBadge({ status }: { status: string }) {
  const tone: BadgeTone =
    status === 'ACTIVE'
      ? 'ok'
      : status === 'SCHEDULED'
        ? 'info'
        : status === 'DRAFT'
          ? 'neutral'
          : status === 'CLOSED'
            ? 'warn'
            : 'neutral';

  const label =
    status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');

  return (
    <Badge tone={tone}>
      {status === 'ACTIVE' ? (
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
        </span>
      ) : null}
      {label}
    </Badge>
  );
}

// --------------------------------------------------------------------------
// Buttons & links
// --------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-55 ' +
  // 44px minimum height: the ballot is used on phones, one-handed.
  'min-h-[2.75rem] py-2';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent/90',
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-ink',
  danger: 'border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20',
};

export function buttonClass(variant: ButtonVariant = 'primary', className?: string): string {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className);
}

export function ButtonLink({
  href,
  children,
  variant = 'primary',
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  className?: string;
}) {
  return (
    <Link href={href} className={buttonClass(variant, className)}>
      {children}
    </Link>
  );
}

// --------------------------------------------------------------------------
// Feedback
// --------------------------------------------------------------------------

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: 'border-info/30 bg-info/10 text-info',
    ok: 'border-ok/30 bg-ok/10 text-ok',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    danger: 'border-danger/30 bg-danger/10 text-danger',
  };

  return (
    <div
      className={cx('rounded-card border px-4 py-3 text-sm', tones[tone], className)}
      // Errors and confirmations must reach a screen reader when they appear
      // mid-flow, not only when the page is re-read from the top.
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {title ? <div className="font-semibold">{title}</div> : null}
      {children ? (
        <div className={cx(title ? 'mt-1' : undefined, 'text-ink/90')}>{children}</div>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = '🗳️',
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <Card className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        {icon}
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="mt-2 max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </Card>
  );
}

/** Loading placeholder used by route-level `loading.tsx` files. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <Card className="space-y-3 p-5">
      <div className="skeleton h-5 w-1/3" />
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} className="skeleton h-3.5" style={{ width: `${90 - index * 12}%` }} />
      ))}
    </Card>
  );
}

// --------------------------------------------------------------------------
// Forms
// --------------------------------------------------------------------------

export function Field({
  label,
  htmlFor,
  hint,
  errors,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  errors?: string[];
  required?: boolean;
  children: ReactNode;
}) {
  const errorId = `${htmlFor}-error`;
  const hintId = `${htmlFor}-hint`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-semibold">
        {label}
        {required ? (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {children}
      {errors && errors.length > 0 ? (
        <p id={errorId} className="text-xs font-medium text-danger" role="alert">
          {errors.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-base text-ink ' +
  'placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export const selectClass = cx(inputClass, 'appearance-none pr-9');

/**
 * Hidden CSRF field.
 *
 * Rendered by every mutating form. The token is a keyed HMAC of the session
 * cookie, so it cannot be forged by a site that cannot read that cookie.
 */
export function CsrfField({ token }: { token: string | null }) {
  if (!token) return null;
  return <input type="hidden" name="csrfToken" value={token} />;
}

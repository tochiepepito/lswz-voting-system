'use client';

import { useFormStatus } from 'react-dom';
import { buttonClass, cx } from './ui';

/**
 * Submit button wired to the enclosing form's pending state.
 *
 * `useFormStatus` only reports for the form this button is rendered inside, so
 * it must be its own component rather than a hook call in the form body.
 *
 * Disabling while pending is a real correctness measure here, not just polish:
 * a double-click on "Submit vote" fires two requests, and although the database
 * constraint refuses the second one, the voter would see a confusing "you have
 * already voted" error for their own first click.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = 'primary',
  className,
  disabled,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending}
      className={buttonClass(variant, className)}
    >
      {pending ? (
        <>
          <Spinner />
          {pendingLabel ?? 'Working...'}
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('h-4 w-4 animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

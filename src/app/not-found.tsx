import { ButtonLink } from '@/components/ui';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center px-4 text-center">
      <div className="text-4xl" aria-hidden="true">
        🔍
      </div>
      <h1 className="mt-4 text-2xl font-bold">That page could not be found</h1>
      <p className="mt-2 text-muted">
        The event may have been removed, or the link may be mistyped.
      </p>
      <div className="mt-6">
        <ButtonLink href="/events">Browse voting events</ButtonLink>
      </div>
    </main>
  );
}

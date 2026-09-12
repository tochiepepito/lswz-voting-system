import { SkeletonCard } from '@/components/ui';

/**
 * Streaming placeholder for the voter routes.
 *
 * Every voter page is `force-dynamic` (a cached ballot would be a correctness
 * bug), so this is what fills the gap on a cold navigation instead of a blank
 * screen.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="skeleton h-8 w-2/3" />
        <div className="skeleton h-4 w-full max-w-lg" />
      </div>

      <div className="space-y-3">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </div>

      <span className="sr-only" role="status">
        Loading voting events
      </span>
    </div>
  );
}
